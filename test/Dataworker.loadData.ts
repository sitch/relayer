import {
  BalanceAllocator,
  BundleDataClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
} from "../src/clients";
import {
  CHAIN_ID_TEST_LIST,
  IMPOSSIBLE_BLOCK_RANGE,
  amountToDeposit,
  destinationChainId,
  originChainId,
  repaymentChainId,
} from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  SignerWithAddress,
  V3FillFromDeposit,
  assertPromiseError,
  buildDeposit,
  buildFill,
  buildFillForRepaymentChain,
  buildModifiedFill,
  buildSlowFill,
  buildSlowRelayLeaves,
  buildSlowRelayTree,
  ethers,
  expect,
  getDefaultBlockRange,
  getLastBlockNumber,
  randomAddress,
  sinon,
  spyLogIncludes,
} from "./utils";

import { spokePoolClientsToProviders } from "../src/common";
import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { Deposit, DepositWithBlock, Fill } from "../src/interfaces";
import {
  MAX_UINT_VAL,
  getCurrentTime,
  getRealizedLpFeeForFills,
  getRefundForFills,
  toBN,
  Event,
  bnZero,
  toBNWei,
  fixedPointAdjustment,
  assert,
  ZERO_ADDRESS,
} from "../src/utils";
import { MockSpokePoolClient } from "./mocks";
import { interfaces, utils as sdkUtils } from "@across-protocol/sdk-v2";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, l1Token_2: Contract, hubPool: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient, bundleDataClient: BundleDataClient;
let hubPoolClient: HubPoolClient, configStoreClient: ConfigStoreClient;
let multiCallerClient: MultiCallerClient;
let dataworkerInstance: Dataworker;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let spy: sinon.SinonSpy;

let updateAllClients: () => Promise<void>;

const ignoredDepositParams = ["logIndex", "transactionHash", "transactionIndex", "blockTimestamp"];

// TODO: Rename this file to BundleDataClient
describe("Dataworker: Load data used in all functions", async function () {
  beforeEach(async function () {
    ({
      hubPool,
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      configStoreClient,
      hubPoolClient,
      l1Token_1,
      l1Token_2,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
      spokePoolClients,
      updateAllClients,
      spy,
    } = await setupDataworker(ethers, 25, 25, 0));
    bundleDataClient = dataworkerInstance.clients.bundleDataClient;
    multiCallerClient = dataworkerInstance.clients.multiCallerClient;
  });

  it("Default conditions", async function () {
    await configStoreClient.update();

    // Throws error if hub pool client is not updated.
    await hubPoolClient.update();

    // Throws error if spoke pool clients not updated
    await assertPromiseError(bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients), "SpokePoolClient");
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();

    // Before any deposits, returns empty dictionaries.
    await updateAllClients();
    expect(await bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients)).to.deep.equal({
      unfilledDeposits: [],
      deposits: [],
      fillsToRefund: {},
      allValidFills: [],
      bundleDepositsV3: {},
      expiredDepositsToRefundV3: {},
      earlyDeposits: [],
      bundleFillsV3: {},
      unexecutableSlowFills: {},
      bundleSlowFillsV3: {},
    });
  });
  describe("Computing refunds for bundles", function () {
    let fill1: Fill;
    let deposit1: Deposit;

    beforeEach(async function () {
      await updateAllClients();

      deposit1 = await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      );

      await updateAllClients();

      // Submit a valid fill.
      fill1 = await buildFillForRepaymentChain(
        spokePool_2,
        relayer,
        deposit1,
        0.5,
        destinationChainId,
        erc20_2.address
      );
      await updateAllClients();
    });
    it("No validated bundle refunds", async function () {
      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      // No bundle is validated so no refunds.
      const refunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        toBN(0)
      );
    });
    it("1 validated bundle with refunds", async function () {
      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      const latestBlock = await hubPool.provider.getBlockNumber();
      const blockRange = CHAIN_ID_TEST_LIST.map(() => [0, latestBlock]);
      const expectedPoolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      for (const leaf of expectedPoolRebalanceRoot.leaves) {
        await hubPool.executeRootBundle(
          leaf.chainId,
          leaf.groupIndex,
          leaf.bundleLpFees,
          leaf.netSendAmounts,
          leaf.runningBalances,
          leaf.leafId,
          leaf.l1Tokens,
          expectedPoolRebalanceRoot.tree.getHexProof(leaf)
        );
      }

      // Before relayer refund leaves are executed, should have pending refunds:
      await updateAllClients();
      const refunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        getRefundForFills([fill1])
      );

      // Test edge cases of `getTotalRefund` that should return BN(0)
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, repaymentChainId, erc20_2.address)).to.equal(
        toBN(0)
      );
      expect(bundleDataClient.getTotalRefund(refunds, relayer.address, destinationChainId, erc20_1.address)).to.equal(
        toBN(0)
      );
      expect(bundleDataClient.getTotalRefund(refunds, hubPool.address, destinationChainId, erc20_2.address)).to.equal(
        toBN(0)
      );

      // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
      const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
      for (const rootBundle of validatedRootBundles) {
        await spokePool_1.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
        await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
      }
      await updateAllClients();

      // Execute relayer refund leaves. Send funds to spoke pools to execute the leaves.
      await erc20_2.mint(spokePool_2.address, getRefundForFills([fill1]));
      const providers = {
        ...spokePoolClientsToProviders(spokePoolClients),
        [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
      };
      await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, new BalanceAllocator(providers));
      await multiCallerClient.executeTransactionQueue();

      // Should now have zero pending refunds
      await updateAllClients();
      // If we call `getPendingRefundsFromLatestBundle` multiple times, there should be no error. If there is an error,
      // then it means that `getPendingRefundsFromLatestBundle` is mutating the return value of `.loadData` which is
      // stored in the bundle data client's cache. `getPendingRefundsFromLatestBundle` should instead be using a
      // deep cloned copy of `.loadData`'s output.
      await bundleDataClient.getPendingRefundsFromValidBundles(2);
      const postExecutionRefunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(
        bundleDataClient.getTotalRefund(postExecutionRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(toBN(0));
    });
    it("2 validated bundles with refunds", async function () {
      // Propose and execute bundle containing fill1:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      const latestBlock = await hubPool.provider.getBlockNumber();
      const blockRange = CHAIN_ID_TEST_LIST.map(() => [0, latestBlock]);
      const expectedPoolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      for (const leaf of expectedPoolRebalanceRoot.leaves) {
        await hubPool.executeRootBundle(
          leaf.chainId,
          leaf.groupIndex,
          leaf.bundleLpFees,
          leaf.netSendAmounts,
          leaf.runningBalances,
          leaf.leafId,
          leaf.l1Tokens,
          expectedPoolRebalanceRoot.tree.getHexProof(leaf)
        );
      }

      // Submit fill2 and propose another bundle:
      const fill2 = await buildFillForRepaymentChain(
        spokePool_2,
        relayer,
        deposit1,
        0.2,
        destinationChainId,
        erc20_2.address
      );
      await updateAllClients();

      // Propose another bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      // Check that pending refunds include both fills after pool leaves are executed
      await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(
        bundleDataClient.getTotalRefund(
          await bundleDataClient.getPendingRefundsFromValidBundles(2),
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.equal(getRefundForFills([fill1]));
      const latestBlock2 = await hubPool.provider.getBlockNumber();
      const blockRange2 = CHAIN_ID_TEST_LIST.map(() => [latestBlock + 1, latestBlock2]);
      const expectedPoolRebalanceRoot2 = await dataworkerInstance.buildPoolRebalanceRoot(blockRange2, spokePoolClients);
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      for (const leaf of expectedPoolRebalanceRoot2.leaves) {
        await hubPool.executeRootBundle(
          leaf.chainId,
          leaf.groupIndex,
          leaf.bundleLpFees,
          leaf.netSendAmounts,
          leaf.runningBalances,
          leaf.leafId,
          leaf.l1Tokens,
          expectedPoolRebalanceRoot2.tree.getHexProof(leaf)
        );
      }
      await updateAllClients();
      const postSecondProposalRefunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(
        bundleDataClient.getTotalRefund(postSecondProposalRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(getRefundForFills([fill1, fill2]));

      // Manually relay the roots to spoke pools since adapter is a dummy and won't actually relay messages.
      const validatedRootBundles = hubPoolClient.getValidatedRootBundles();
      for (const rootBundle of validatedRootBundles) {
        await spokePool_1.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
        await spokePool_2.relayRootBundle(rootBundle.relayerRefundRoot, rootBundle.slowRelayRoot);
      }
      await updateAllClients();

      // Execute refunds and test that pending refund amounts are decreasing.
      await erc20_2.mint(spokePool_2.address, getRefundForFills([fill1, fill2]));
      const providers = {
        ...spokePoolClientsToProviders(spokePoolClients),
        [(await hubPool.provider.getNetwork()).chainId]: hubPool.provider,
      };
      await dataworkerInstance.executeRelayerRefundLeaves(spokePoolClients, new BalanceAllocator(providers));
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();
      const postExecutedRefunds = await bundleDataClient.getPendingRefundsFromValidBundles(2);
      expect(
        bundleDataClient.getTotalRefund(postExecutedRefunds, relayer.address, destinationChainId, erc20_2.address)
      ).to.equal(toBN(0));
    });
    it("Refunds in next bundle", async function () {
      // When there is no history of proposed root bundles:
      const refunds = await bundleDataClient.getNextBundleRefunds();
      expect(bundleDataClient.getRefundsFor(refunds, relayer.address, destinationChainId, erc20_2.address)).to.equal(
        getRefundForFills([fill1])
      );

      // Propose a bundle:
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();

      // Execute the bundle:
      const latestBlock = await hubPool.provider.getBlockNumber();
      const blockRange = CHAIN_ID_TEST_LIST.map(() => [0, latestBlock]);
      const expectedPoolRebalanceRoot = await dataworkerInstance.buildPoolRebalanceRoot(blockRange, spokePoolClients);
      await hubPool.setCurrentTime(Number(await hubPool.getCurrentTime()) + Number(await hubPool.liveness()) + 1);
      for (const leaf of expectedPoolRebalanceRoot.leaves) {
        await hubPool.executeRootBundle(
          leaf.chainId,
          leaf.groupIndex,
          leaf.bundleLpFees,
          leaf.netSendAmounts,
          leaf.runningBalances,
          leaf.leafId,
          leaf.l1Tokens,
          expectedPoolRebalanceRoot.tree.getHexProof(leaf)
        );
      }

      // Next bundle should include fill2.
      const fill2 = await buildFillForRepaymentChain(
        spokePool_2,
        relayer,
        deposit1,
        0.4,
        destinationChainId,
        erc20_2.address
      );
      await updateAllClients();
      expect(
        bundleDataClient.getRefundsFor(
          await bundleDataClient.getNextBundleRefunds(),
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.equal(getRefundForFills([fill2]));

      // If we now propose a bundle including fill2, then next bundle will still fill2
      // because the bundle hasn't been fully executed yet. So its conceivable that this latest bundle is disputed,
      // so we still want to capture fill2 in the potential "next bundle" category.
      await updateAllClients();
      await dataworkerInstance.proposeRootBundle(spokePoolClients);
      await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
      await multiCallerClient.executeTransactionQueue();
      await updateAllClients();
      expect(
        bundleDataClient.getRefundsFor(
          await bundleDataClient.getNextBundleRefunds(),
          relayer.address,
          destinationChainId,
          erc20_2.address
        )
      ).to.equal(getRefundForFills([fill2]));
    });
  });
  it("Returns unfilled deposits", async function () {
    await updateAllClients();

    const deposit1 = {
      ...(await buildDeposit(
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token_1,
        depositor,
        destinationChainId,
        amountToDeposit
      )),
      blockNumber: await getLastBlockNumber(),
    } as DepositWithBlock;
    deposit1.quoteBlockNumber = (await hubPoolClient.computeRealizedLpFeePct(deposit1, l1Token_1.address)).quoteBlock;

    const deposit2 = {
      ...(await buildDeposit(
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_2,
        depositor,
        originChainId,
        amountToDeposit
      )),
      blockNumber: await getLastBlockNumber(),
    } as DepositWithBlock;
    deposit2.quoteBlockNumber = (await hubPoolClient.computeRealizedLpFeePct(deposit2, l1Token_2.address)).quoteBlock;

    // Unfilled deposits are ignored.
    await updateAllClients();
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients);
    expect(data1.unfilledDeposits).to.deep.equal([]);

    // Two deposits with no fills per destination chain ID.
    await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit.mul(toBN(2))
    );
    await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit.mul(toBN(2))
    );
    await updateAllClients();
    const data2 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients);
    expect(data2.unfilledDeposits).to.deep.equal([]);

    // Fills that don't match deposits do not affect unfilledAmount counter.
    // Note: We switch the spoke pool address in the following fills from the fills that eventually do match with
    //       the deposits.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, { ...deposit1, depositId: 99 }, 0.5);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, { ...deposit2, depositId: 99 }, 0.25);

    // One partially filled deposit per destination chain ID.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data3 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(3), spokePoolClients);
    expect(data3.unfilledDeposits)
      .excludingEvery(ignoredDepositParams)
      .to.deep.equal([
        {
          unfilledAmount: amountToDeposit.sub(fill1.fillAmount),
          deposit: deposit1,
        },
        {
          unfilledAmount: amountToDeposit.sub(fill2.fillAmount),
          deposit: deposit2,
        },
      ]);

    // If block range does not cover fills, then unfilled deposits are not included.
    expect(
      (await dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients))
        .unfilledDeposits
    ).to.deep.equal([]);

    // All deposits are fulfilled; unfilled deposits that are fully filled should be ignored.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await updateAllClients();
    const data5 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(4), spokePoolClients);
    expect(data5.unfilledDeposits).to.deep.equal([]);

    // TODO: Add test where deposit has matched fills but none were the first ever fill for that deposit (i.e. where
    // fill.amount != fill.totalAmountFilled). This can only be done after adding in block range constraints on Fill
    // events queried.

    // Fill events emitted by slow relays are included in unfilled amount calculations.
    const deposit5 = {
      ...(await buildDeposit(
        hubPoolClient,
        spokePool_2,
        erc20_2,
        l1Token_1,
        depositor,
        originChainId,
        amountToDeposit
      )),
      blockNumber: await getLastBlockNumber(),
      blockTimestamp: (await spokePool_2.provider.getBlock(await getLastBlockNumber())).timestamp,
    } as DepositWithBlock;
    deposit5.quoteBlockNumber = (await hubPoolClient.computeRealizedLpFeePct(deposit5, l1Token_1.address)).quoteBlock;
    const fill3 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit5, 0.25);

    // One unfilled deposit that we're going to slow fill:
    await updateAllClients();
    const data6 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
    expect(data6.unfilledDeposits)
      .excludingEvery(ignoredDepositParams)
      .to.deep.equal([{ unfilledAmount: amountToDeposit.sub(fill3.fillAmount), deposit: deposit5 }]);

    const slowRelays = buildSlowRelayLeaves([deposit5]);
    const tree = await buildSlowRelayTree(slowRelays);
    await spokePool_1.relayRootBundle(tree.getHexRoot(), tree.getHexRoot());
    await buildSlowFill(spokePool_1, fill3, depositor, []);

    // The unfilled deposit has now been fully filled.
    await updateAllClients();
    const data7 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(6), spokePoolClients);
    expect(data7.unfilledDeposits).to.deep.equal([]);
  });
  it("Returns fills to refund", async function () {
    await updateAllClients();

    const deposit1 = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Submit a valid fill.
    const fill1 = {
      ...(await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5)),
      blockTimestamp: (await spokePool_2.provider.getBlock(await getLastBlockNumber())).timestamp,
    };
    await updateAllClients();
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients);
    expect(data1.fillsToRefund)
      .excludingEvery(ignoredDepositParams)
      .to.deep.equal({
        [destinationChainId]: {
          [erc20_2.address]: {
            fills: [fill1],
            refunds: { [relayer.address]: getRefundForFills([fill1]) },
            totalRefundAmount: getRefundForFills([fill1]),
            realizedLpFees: getRealizedLpFeeForFills([fill1]),
          },
        },
      });

    // If block range does not cover fills, then they are not included
    expect(
      (await dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients))
        .fillsToRefund
    ).to.deep.equal({});

    // Submit fills without matching deposits. These should be ignored by the client.
    // Note: Switch just the relayer fee % to make fills invalid. This also ensures that client is correctly
    // distinguishing between valid speed up fills with modified relayer fee %'s and invalid fill relay calls
    // with all correct fill params except for the relayer fee %.
    await buildFill(spokePool_1, erc20_1, depositor, relayer, { ...deposit2, relayerFeePct: toBN(0) }, 0.5);
    await updateAllClients();
    const data3 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(1), spokePoolClients);
    expect(data3.fillsToRefund).to.deep.equal(data1.fillsToRefund);

    // Submit fills that match deposit in all properties except for realized lp fee % or l1 token. These should be
    // ignored because the rate model client deems them invalid. These are the two properties added to the deposit
    // object by the spoke pool client.
    // Note: This fill has identical deposit data to fill2 except for the realized lp fee %.
    await buildFill(
      spokePool_1,
      erc20_1,
      depositor,
      relayer,
      { ...deposit2, realizedLpFeePct: deposit2.realizedLpFeePct?.div(toBN(2)) },
      0.25
    );
    // Note: This fill has identical deposit data to fill2 except for the destination token being different
    await buildFill(spokePool_1, erc20_2, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data4 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(2), spokePoolClients);
    expect(data4.fillsToRefund).to.deep.equal(data1.fillsToRefund);

    // Slow relay fills are added.
    const deposit3 = await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );
    const fill3 = {
      ...(await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit3, 0.25)),
      blockTimestamp: (await spokePool_1.provider.getBlock(await getLastBlockNumber())).timestamp,
    };

    const slowRelays = buildSlowRelayLeaves([deposit3]);
    const tree = await buildSlowRelayTree(slowRelays);
    await spokePool_1.relayRootBundle(tree.getHexRoot(), tree.getHexRoot());
    const slowFill3 = {
      ...(await buildSlowFill(spokePool_1, fill3, depositor, [])),
      blockTimestamp: (await spokePool_1.provider.getBlock(await getLastBlockNumber())).timestamp,
    };

    await updateAllClients();
    const data5 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(3), spokePoolClients);
    const expectedData5 = {
      ...data4.fillsToRefund,
      [slowFill3.destinationChainId]: {
        [erc20_1.address]: {
          fills: [fill3, slowFill3], // Slow fill gets added to fills list
          realizedLpFees: getRealizedLpFeeForFills([fill3, slowFill3]), // Slow fill does affect realized LP fee
          totalRefundAmount: getRefundForFills([fill3]),
          refunds: { [relayer.address]: getRefundForFills([fill3]) },
        },
      },
    };
    expect(data5.fillsToRefund).excludingEvery(ignoredDepositParams).to.deep.equal(expectedData5);

    // Speed up relays are included. Re-use the same fill information
    const fill4 = await buildModifiedFill(spokePool_2, depositor, relayer, fill1, 2, 0.1);
    expect(fill4.totalFilledAmount.gt(fill4.fillAmount), "speed up fill didn't match original deposit").to.be.true;
    await updateAllClients();
    const data6 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(4), spokePoolClients);
    expect(data6.fillsToRefund[destinationChainId][erc20_2.address].totalRefundAmount).to.equal(
      getRefundForFills([fill1, fill4])
    );
    expect(data6.fillsToRefund[destinationChainId][erc20_2.address].realizedLpFees).to.equal(
      getRealizedLpFeeForFills([fill1, fill4])
    );
  });
  it("Returns deposits", async function () {
    await updateAllClients();

    const deposit1 = await buildDeposit(
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const blockNumber = await spokePool_2.provider.getBlockNumber();
    const realizedLpFeePctData = await hubPoolClient.computeRealizedLpFeePct(
      { ...deposit1, blockNumber },
      l1Token_1.address
    );

    // Should include all deposits, even those not matched by a relay
    await updateAllClients();
    const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(getDefaultBlockRange(5), spokePoolClients);
    expect(data1.deposits)
      .excludingEvery(["blockTimestamp", "logIndex", "transactionHash", "transactionIndex"])
      .to.deep.equal([{ ...deposit1, quoteBlockNumber: realizedLpFeePctData.quoteBlock, blockNumber }]);

    // If block range does not cover deposits, then they are not included
    expect(
      (await dataworkerInstance.clients.bundleDataClient.loadData(IMPOSSIBLE_BLOCK_RANGE, spokePoolClients)).deposits
    ).to.deep.equal([]);
  });

  describe("V3 Events", function () {
    let mockOriginSpokePoolClient: MockSpokePoolClient, mockDestinationSpokePoolClient: MockSpokePoolClient;
    const lpFeePct = toBNWei("0.01");
    beforeEach(async function () {
      await updateAllClients();
      mockOriginSpokePoolClient = new MockSpokePoolClient(
        spokePoolClient_1.logger,
        new Contract(
          spokePoolClient_1.spokePool.address,
          await sdkUtils.getABI("SpokePoolV3"),
          spokePoolClient_1.spokePool.provider
        ),
        spokePoolClient_1.chainId,
        spokePoolClient_1.deploymentBlock
      );
      mockDestinationSpokePoolClient = new MockSpokePoolClient(
        spokePoolClient_2.logger,
        new Contract(
          spokePoolClient_2.spokePool.address,
          await sdkUtils.getABI("SpokePoolV3"),
          spokePoolClient_2.spokePool.provider
        ),
        spokePoolClient_2.chainId,
        spokePoolClient_2.deploymentBlock
      );
      spokePoolClients = {
        ...spokePoolClients,
        [originChainId]: mockOriginSpokePoolClient,
        [destinationChainId]: mockDestinationSpokePoolClient,
      };
      // Mock a realized lp fee pct for each deposit so we can check refund amounts and bundle lp fees.
      mockOriginSpokePoolClient.setDefaultRealizedLpFeePct(lpFeePct);
      await mockOriginSpokePoolClient.update();
      await mockDestinationSpokePoolClient.update();
    });
    function generateV2Deposit(): Event {
      return mockOriginSpokePoolClient.deposit({
        originToken: erc20_1.address,
        message: "0x",
        quoteTimestamp: getCurrentTime() - 10,
        destinationChainId,
        blockNumber: spokePoolClient_1.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.V2DepositWithBlock);
    }
    function generateV3Deposit(eventOverride?: any): Event {
      return mockOriginSpokePoolClient.depositV3({
        inputToken: erc20_1.address,
        outputToken: eventOverride?.outputToken ?? erc20_2.address,
        realizedLpFeePct: eventOverride?.realizedLpFeePct ?? bnZero,
        message: "0x",
        quoteTimestamp: getCurrentTime() - 10,
        fillDeadline: eventOverride?.fillDeadline ?? getCurrentTime() + 7200,
        destinationChainId,
        blockNumber: eventOverride?.blockNumber ?? spokePoolClient_1.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.V3DepositWithBlock);
    }
    function generateV3FillFromDeposit(
      deposit: interfaces.V3DepositWithBlock,
      fillEventOverride?: any,
      _relayer = relayer.address,
      _repaymentChainId = repaymentChainId,
      fillType = interfaces.FillType.FastFill
    ): Event {
      const fillObject = V3FillFromDeposit(deposit, _relayer, _repaymentChainId);
      return mockDestinationSpokePoolClient.fillV3Relay({
        ...fillObject,
        updatableRelayData: {
          recipient: fillObject.recipient,
          message: fillObject.message,
          outputAmount: fillObject.outputAmount,
          fillType,
        },
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.V3FillWithBlock);
    }
    function generateV3FillFromDepositEvent(
      depositEvent: Event,
      fillEventOverride?: any,
      _relayer = relayer.address,
      _repaymentChainId = repaymentChainId
    ): Event {
      const { args } = depositEvent;
      return mockDestinationSpokePoolClient.fillV3Relay({
        ...args,
        relayer: _relayer,
        realizedLpFeePct: fillEventOverride?.realizedLpFeePct ?? bnZero,
        repaymentChainId: _repaymentChainId,
        updatableRelayData: {
          recipient: depositEvent.recipient,
          message: depositEvent.message,
          outputAmount: depositEvent.outputAmount,
          fillType: interfaces.FillType.FastFill,
        },
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.V3FillWithBlock);
    }
    function generateSlowFillRequestFromDeposit(
      deposit: interfaces.V3DepositWithBlock,
      fillEventOverride?: any
    ): Event {
      const fillObject = V3FillFromDeposit(deposit, ZERO_ADDRESS);
      const { relayer, repaymentChainId, updatableRelayData, ...relayData } = fillObject;
      return mockDestinationSpokePoolClient.requestV3SlowFill({
        ...relayData,
        blockNumber: fillEventOverride?.blockNumber ?? spokePoolClient_2.latestBlockSearched, // @dev use latest block searched from non-mocked client
        // so that mocked client's latestBlockSearched gets set to the same value.
      } as interfaces.SlowFillRequest);
    }

    it("Separates V3 and V2 deposits", async function () {
      // Inject a series of v2DepositWithBlock and v3DepositWithBlock events.
      const depositV3Events: Event[] = [];
      const depositV2Events: Event[] = [];

      for (let idx = 0; idx < 10; ++idx) {
        const random = Math.random();
        if (random < 0.5) {
          depositV3Events.push(generateV3Deposit());
        } else {
          depositV2Events.push(generateV2Deposit());
        }
      }
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      // client correctly sorts V2/V3 events into expected dictionaries.
      expect(data1.deposits.map((deposit) => deposit.depositId)).to.deep.equal(
        depositV2Events.map((event) => event.args.depositId)
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].map((deposit) => deposit.depositId)).to.deep.equal(
        depositV3Events.map((event) => event.args.depositId)
      );
    });
    it("Filters expired deposits", async function () {
      const bundleBlockTimestamps = await dataworkerInstance.clients.bundleDataClient.getBundleBlockTimestamps(
        [originChainId, destinationChainId],
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Send unexpired deposit
      const unexpiredDeposits = [generateV3Deposit()];
      // Send expired deposit
      const expiredDeposits = [generateV3Deposit({ fillDeadline: bundleBlockTimestamps[destinationChainId][1] - 1 })];
      const depositEvents = [...unexpiredDeposits, ...expiredDeposits];
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].map((deposit) => deposit.depositId)).to.deep.equal(
        depositEvents.map((event) => event.args.depositId)
      );
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(2);
      expect(
        data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].map((deposit) => deposit.depositId)
      ).to.deep.equal(expiredDeposits.map((event) => event.args.depositId));
      expect(data1.expiredDepositsToRefundV3[originChainId][erc20_1.address].length).to.equal(1);
    });
    it("Filters unexpired deposit out of block range", async function () {
      // Send deposit behind and after origin chain block range. Should not be included in bundleDeposits.
      // First generate mock deposit events with some block time between events.
      const deposits = [
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 1 }),
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 11 }),
        generateV3Deposit({ blockNumber: mockOriginSpokePoolClient.eventManager.blockNumber + 21 }),
      ];
      // Create a block range that contains only the middle deposit.
      const originChainBlockRange = [deposits[1].blockNumber - 1, deposits[1].blockNumber + 1];
      // Substitute origin chain bundle block range.
      const bundleBlockRanges = [originChainBlockRange].concat(getDefaultBlockRange(5).slice(1));
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      expect(mockOriginSpokePoolClient.getDeposits().length).to.equal(deposits.length);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(1);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address][0].depositId).to.equal(deposits[1].args.depositId);
    });
    it("Saves V3 fast fill under correct repayment chain and repayment token", async function () {
      const depositV3Events: Event[] = [];
      const fillV3Events: Event[] = [];

      // Create three valid deposits
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      depositV3Events.push(generateV3Deposit({ outputToken: randomAddress() }));
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Fill deposits from different relayers
      const relayer2 = randomAddress();
      fillV3Events.push(generateV3FillFromDeposit(deposits[0]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[1]));
      fillV3Events.push(generateV3FillFromDeposit(deposits[2], {}, relayer2));
      await mockDestinationSpokePoolClient.update(["FilledV3Relay", "FilledRelay"]);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(depositV3Events.length);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.map((e) => e.depositId)).to.deep.equal(
        fillV3Events.map((event) => event.args.depositId)
      );
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.map((e) => e.lpFeePct)).to.deep.equal(
        fillV3Events.map(() => lpFeePct)
      );
      const totalGrossRefundAmount = fillV3Events.reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0));
      const totalV3LpFees = totalGrossRefundAmount.mul(lpFeePct).div(fixedPointAdjustment);
      expect(totalV3LpFees).to.equal(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].realizedLpFees);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].totalRefundAmount).to.equal(
        totalGrossRefundAmount.sub(totalV3LpFees)
      );
      const refundAmountPct = fixedPointAdjustment.sub(lpFeePct);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].refunds).to.deep.equal({
        [relayer.address]: fillV3Events
          .slice(0, fillV3Events.length - 1)
          .reduce((agg, e) => agg.add(e.args.inputAmount), toBN(0))
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
        [relayer2]: fillV3Events[fillV3Events.length - 1].args.inputAmount
          .mul(refundAmountPct)
          .div(fixedPointAdjustment),
      });
    });
    it.skip("Validates fill against old deposit", async function () {
      // Send a deposit.
      const oldDepositEvent = generateV3Deposit({ outputToken: randomAddress() });

      // Update so binary search uses reasonable initLow and initHigh.
      await mockOriginSpokePoolClient.update();

      // Mock spoke pool client needs to believe that the depositId incremented on the spoke pool.
      const depositIds: number = [];
      for (let i = 0; i < oldDepositEvent.blockNumber; i++) {
        depositIds.push(0);
      }
      for (let i = oldDepositEvent.blockNumber; i < oldDepositEvent.blockNumber + 10; i++) {
        depositIds.push(1);
      }
      mockOriginSpokePoolClient.setDepositIds(depositIds);

      const fillEvent = generateV3FillFromDepositEvent(oldDepositEvent);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay", "FilledRelay"]);

      expect(mockOriginSpokePoolClient.getDeposits().length).to.equal(0);

      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );

      // TODO: Will fail for now because event isn't being emitted from the spoke pool and queryFilter fails
    });
    it("Handles V3 Slow Fill executions", async function () {
      generateV3Deposit({ outputToken: randomAddress() });
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      // Generate a slow fill execution
      generateV3FillFromDeposit(deposits[0], {}, relayer.address, destinationChainId, interfaces.FillType.SlowFill);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay", "FilledRelay"]);
      const fills = mockDestinationSpokePoolClient.getFills();
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills[0].depositId).to.equal(fills[0].depositId);
      expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].fills[0].lpFeePct).to.equal(lpFeePct);
      const totalGrossRefundAmount = fills[0].inputAmount;
      const totalV3LpFees = totalGrossRefundAmount.mul(lpFeePct).div(fixedPointAdjustment);
      expect(totalV3LpFees).to.equal(data1.bundleFillsV3[destinationChainId][erc20_2.address].realizedLpFees);

      // Refund should be 0 for slow fills
      expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].totalRefundAmount).to.equal(0);
      expect(data1.bundleFillsV3[destinationChainId][erc20_2.address].refunds).to.deep.equal({});
    });
    it("Filters fills out of block range", async function () {
      generateV3Deposit({ outputToken: randomAddress() });
      generateV3Deposit({ outputToken: randomAddress() });
      generateV3Deposit({ outputToken: randomAddress() });
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      const fills = [
        generateV3FillFromDeposit(deposits[0], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 1,
        }),
        generateV3FillFromDeposit(deposits[1], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11,
        }),
        generateV3FillFromDeposit(deposits[2], {
          blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 21,
        }),
      ];
      // Create a block range that contains only the middle event.
      const destinationChainBlockRange = [fills[1].blockNumber - 1, fills[1].blockNumber + 1];
      // Substitute destination chain bundle block range.
      const bundleBlockRanges = getDefaultBlockRange(5);
      const destinationChainIndex =
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
      bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
      await mockDestinationSpokePoolClient.update(["FilledV3Relay", "FilledRelay"]);
      expect(mockDestinationSpokePoolClient.getFills().length).to.equal(fills.length);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(bundleBlockRanges, spokePoolClients);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills[0].depositId).to.equal(
        fills[1].args.depositId
      );
    });
    it("Handles invalid V3 fills", async function () {
      // Generate fill and deposit with random params but the same deposit ID.
      generateV3Deposit();
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      generateV3FillFromDepositEvent(generateV3Deposit());
      await mockDestinationSpokePoolClient.update(["FilledV3Relay", "FilledRelay"]);
      const fills = mockDestinationSpokePoolClient.getFills();
      assert(fills.length === 1, "Fill was not emitted");
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleFillsV3).to.deep.equal({});
      expect(spyLogIncludes(spy, -1, "invalid V3 fills in range")).to.be.true;
    });
    it("Filters for fast fills replacing slow fills from older bundles", async function () {
      // Generate deposit that can be slow filled, meaning that its input and output tokens are equivalent.
      // Generate a second deposit that cannot be, to test that its ignored as a slow fill excess.
      // Generate a third deposit that can be slow filled but was slow filled in an older bundle
      generateV3Deposit({ outputToken: erc20_2.address });
      generateV3Deposit({ outputToken: randomAddress() });
      generateV3Deposit({ outputToken: erc20_2.address });
      await mockOriginSpokePoolClient.update(["V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();
      expect(deposits.length).to.equal(3)
      const eligibleSlowFills = deposits.filter((x) => erc20_2.address === x.outputToken)

      // Generate a slow fill request for one of the slow fill-eligible deposits
      generateSlowFillRequestFromDeposit(deposits.find((x) => x.outputToken === erc20_2.address), {
        blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 1
      });

      // Now, generate fast fills replacing slow fills for all deposits, but at higher block numbers than the 
      // slow fill request so we can mock the slow fill request happening in an older bundle.
      generateV3FillFromDeposit(deposits[0], {
        blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 1
      }, relayer.address, repaymentChainId, interfaces.FillType.ReplacedSlowFill);
      generateV3FillFromDeposit(deposits[1], {}, relayer.address, repaymentChainId, interfaces.FillType.ReplacedSlowFill);
      generateV3FillFromDeposit(deposits[2], {}, relayer.address, repaymentChainId, interfaces.FillType.ReplacedSlowFill);
      await mockDestinationSpokePoolClient.update(["FilledV3Relay", "RequestedV3SlowFill"]);
      expect(mockDestinationSpokePoolClient.getFillsForOriginChain(originChainId).length).to.equal(3);

      // Create a block range that contains only the fills on the destination chain
      const fills = mockDestinationSpokePoolClient.getFills();
      const destinationChainBlockRange = [fills[0].blockNumber, fills[2].blockNumber];
      // Substitute destination chain bundle block range.
      const bundleBlockRanges = getDefaultBlockRange(5);
      const destinationChainIndex =
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
      bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        bundleBlockRanges,
        spokePoolClients
      );

      // If fast fill doesn't  match a slow fill in the bundle,then its deposit will be included as an excess slow fill.
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(3);
      expect(data1.bundleDepositsV3[originChainId][erc20_1.address].length).to.equal(3);
      // One deposit has no slow fill request
      // One deposit has a slow fill request but from an older bundle
      expect(data1.unexecutableSlowFills[destinationChainId][erc20_2.address].length).to.equal(2);
      expect(data1.unexecutableSlowFills[destinationChainId][erc20_2.address].map(x => x.depositId)).to.deep.equal(eligibleSlowFills.map(x => x.depositId));
    });
    it("Saves valid slow fill requests under destination chain and token", async function () {
      // Only one deposit is eligible to be slow filled because its input and output tokens are equivalent.
      generateV3Deposit({ outputToken: randomAddress() });
      const eligibleToSlowFill = generateV3Deposit({ outputToken: erc20_2.address });
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      generateSlowFillRequestFromDeposit(deposits[0]);
      generateSlowFillRequestFromDeposit(deposits[1]);
      await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
      expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(2);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
      expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(eligibleToSlowFill.args.depositId);
    })
    it("Slow fill requests cannot coincide with fill in same bundle", async function() {
      generateV3Deposit({ outputToken: erc20_2.address })      
      generateV3Deposit({ outputToken: erc20_2.address })      
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();

      generateSlowFillRequestFromDeposit(deposits[0]);
      generateSlowFillRequestFromDeposit(deposits[1]);
      generateV3FillFromDeposit(deposits[0]);
      await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill", "FilledV3Relay"]);
      expect(mockDestinationSpokePoolClient.getFills().length).to.equal(1);
      expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(2);
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        getDefaultBlockRange(5),
        spokePoolClients
      );
      // Only the deposit that wasn't fast filled should be included in the slow fill requests.
      expect(data1.bundleFillsV3[repaymentChainId][l1Token_1.address].fills.length).to.equal(1);
      expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
      expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(deposits[1].depositId);
    })
    it("Handles slow fill requests out of block range", async function() {
      generateV3Deposit({ outputToken: erc20_2.address });
      generateV3Deposit({ outputToken: erc20_2.address });
      generateV3Deposit({ outputToken: erc20_2.address });
      await mockOriginSpokePoolClient.update(["FundsDeposited", "V3FundsDeposited"]);
      const deposits = mockOriginSpokePoolClient.getDeposits();
      
      const events = [
      generateSlowFillRequestFromDeposit(deposits[0], {
        blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 1,
      }),
      generateSlowFillRequestFromDeposit(deposits[1], {
        blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 11,
      }),
      generateSlowFillRequestFromDeposit(deposits[2], {
        blockNumber: mockDestinationSpokePoolClient.eventManager.blockNumber + 21,
      }),
    ]
      // Create a block range that contains only the middle event.
      const destinationChainBlockRange = [events[1].blockNumber - 1, events[1].blockNumber + 1];
      // Substitute destination chain bundle block range.
      const bundleBlockRanges = getDefaultBlockRange(5);
      const destinationChainIndex =
        dataworkerInstance.chainIdListForBundleEvaluationBlockNumbers.indexOf(destinationChainId);
      bundleBlockRanges[destinationChainIndex] = destinationChainBlockRange;
      await mockDestinationSpokePoolClient.update(["RequestedV3SlowFill"]);
      expect(mockDestinationSpokePoolClient.getSlowFillRequestsForOriginChain(originChainId).length).to.equal(3);  
      const data1 = await dataworkerInstance.clients.bundleDataClient.loadData(
        bundleBlockRanges,
        spokePoolClients
      );
      expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address].length).to.equal(1);
      expect(data1.bundleSlowFillsV3[destinationChainId][erc20_2.address][0].depositId).to.equal(events[1].args.depositId);
      
    })
    //   it("Returns prior bundle expired deposits", async function () {});
    //   it("Returns unexecutable slow fills originating from prior bundle expired deposits", async function () {});
    // it("Validates slow fill requests from old deposits", async function () {})
  });

  it("Can fetch historical deposits not found in spoke pool client's memory", async function () {
    // Send a deposit.
    await updateAllClients();
    const deposit1 = await buildDeposit(
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit1Block = await spokePool_1.provider.getBlockNumber();

    // Construct a spoke pool client with a small search range that would not include the deposit.
    spokePoolClient_1.firstBlockToSearch = deposit1Block + 1;
    spokePoolClient_1.eventSearchConfig.fromBlock = spokePoolClient_1.firstBlockToSearch;
    await updateAllClients();
    expect(spokePoolClient_1.getDeposits().length).to.equal(0);

    // Send a fill now and force the bundle data client to query for the historical deposit.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    await updateAllClients();
    expect(spokePoolClient_2.getFills().length).to.equal(1);
    expect(spokePoolClient_1.getDeposits().length).to.equal(0);

    // For queryHistoricalDepositForFill to work we need to have a deployment block set for the spoke pool client.
    const bundleData = await bundleDataClient.loadData(getDefaultBlockRange(0), spokePoolClients);
    expect(spyLogIncludes(spy, -2, "Located deposit outside of SpokePoolClient's search range")).is.true;
    expect(bundleData.fillsToRefund)
      .excludingEvery(["blockTimestamp"])
      .to.deep.equal({
        [destinationChainId]: {
          [erc20_2.address]: {
            fills: [fill1],
            refunds: { [relayer.address]: getRefundForFills([fill1]) },
            totalRefundAmount: getRefundForFills([fill1]),
            realizedLpFees: getRealizedLpFeeForFills([fill1]),
          },
        },
      });
    expect(bundleData.deposits).to.deep.equal([]);
    expect(bundleData.allValidFills.length).to.equal(1);
    expect(bundleData.unfilledDeposits)
      .excludingEvery(["logIndex", "transactionHash", "transactionIndex", "blockNumber", "quoteBlockNumber"])
      .to.deep.equal([
        {
          unfilledAmount: amountToDeposit.sub(fill1.fillAmount),
          deposit: { ...deposit1 },
        },
      ]);
  });
});
