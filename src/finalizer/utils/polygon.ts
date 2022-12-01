import { setProofApi, use, POSClient } from "@maticnetwork/maticjs";
import { Web3ClientPlugin } from "@maticnetwork/maticjs-ethers";
import {
  BigNumber,
  Contract,
  convertFromWei,
  ERC20,
  ethers,
  etherscanLink,
  getDeployedContract,
  getProvider,
  groupObjectCountsByProp,
  toBN,
  Wallet,
  winston,
} from "../../utils";
import { L1Token, TokensBridged } from "../../interfaces";
import { HubPoolClient } from "../../clients";
import { Multicall2Call } from "..";

// Note!!: This client will only work for PoS tokens. Matic also has Plasma tokens which have a different finalization
// process entirely.

const CHAIN_ID = 137;
enum POLYGON_MESSAGE_STATUS {
  NOT_CHECKPOINTED = "NOT_CHECKPOINTED",
  CAN_EXIT = "CAN_EXIT",
  EXIT_ALREADY_PROCESSED = "EXIT_ALREADY_PROCESSED",
  UNKNOWN_EXIT_FAILURE = "UNKNOWN_EXIT_FAILURE",
}
// Unique signature used to identify Polygon L2 transactions that were erc20 withdrawals from the Polygon
// canonical bridge. Do not change.
const BURN_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface PolygonTokensBridged extends TokensBridged {
  payload: string;
}

export async function getPosClient(mainnetSigner: Wallet) {
  // Following from https://maticnetwork.github.io/matic.js/docs/pos
  use(Web3ClientPlugin);
  setProofApi("https://apis.matic.network/");
  const posClient = new POSClient();
  return await posClient.init({
    network: "mainnet",
    version: "v1",
    parent: {
      provider: mainnetSigner,
      defaultConfig: {
        from: mainnetSigner.address,
      },
    },
    child: {
      provider: mainnetSigner.connect(getProvider(CHAIN_ID)),
      defaultConfig: {
        from: mainnetSigner.address,
      },
    },
  });
}

export async function getFinalizableTransactions(
  logger: winston.Logger,
  tokensBridged: TokensBridged[],
  posClient: POSClient
) {
  // First look up which L2 transactions were checkpointed to mainnet.
  const isCheckpointed = await Promise.all(
    tokensBridged.map((event) => posClient.exitUtil.isCheckPointed(event.transactionHash))
  );

  // For each token bridge event that was checkpointed, store a unique log index for the event
  // within the transaction hash. This is important for bridge transactions containing multiple events.
  const logIndexesForMessage = {};
  const checkpointedTokensBridged = tokensBridged
    .filter((_, i) => isCheckpointed[i])
    .map((_tokensBridged) => {
      if (logIndexesForMessage[_tokensBridged.transactionHash] === undefined)
        logIndexesForMessage[_tokensBridged.transactionHash] = 0;
      return {
        logIndex: logIndexesForMessage[_tokensBridged.transactionHash]++,
        event: _tokensBridged,
      };
    });

  // Construct the payload we'll need to finalize each L2 transaction that has been checkpointed to Mainnet and
  // can potentially be finalized.
  const payloads = await Promise.all(
    checkpointedTokensBridged.map((e) => {
      return posClient.exitUtil.buildPayloadForExit(e.event.transactionHash, e.logIndex, BURN_SIG, false);
    })
  );

  const finalizableMessages: PolygonTokensBridged[] = [];
  const exitStatus = await Promise.all(
    checkpointedTokensBridged.map(async (_, i) => {
      const payload = payloads[i];
      try {
        // If we can estimate gas for exit transaction call, then we can exit the burn tx, otherwise its likely
        // been processed. Note this will capture mislabel some exit txns that fail for other reasons as "exit
        // already processed", but in the future the maticjs SDK should improve to provide better error checking.
        // This is just a temporary workaround because there is no method in the sdk like isExitProcessed(txn, index).
        await (await posClient.rootChainManager.getContract()).method("exit", payload).estimateGas({});
        finalizableMessages.push({
          ...tokensBridged[i],
          payload,
        });
        return { status: POLYGON_MESSAGE_STATUS.CAN_EXIT };
      } catch (err) {
        if (err.reason.includes("EXIT_ALREADY_PROCESSED"))
          return { status: POLYGON_MESSAGE_STATUS.EXIT_ALREADY_PROCESSED };
        else {
          logger.debug({
            at: "PolygonFinalizer",
            message: "Exit will fail for unknown reason",
            err,
          });
          return { status: POLYGON_MESSAGE_STATUS.UNKNOWN_EXIT_FAILURE };
        }
      }
    })
  );

  logger.debug({
    at: "PolygonFinalizer",
    message: "Polygon message statuses",
    statusesGrouped: {
      ...groupObjectCountsByProp(exitStatus, (message: { status: string }) => message.status),
      NOT_CHECKPOINTED: tokensBridged.map((_, i) => !isCheckpointed[i]).filter((x) => x === true).length,
    },
  });

  return finalizableMessages;
}

export async function finalizePolygon(posClient: POSClient, event: PolygonTokensBridged): Promise<Multicall2Call> {
  const { payload } = event;
  const rootChainManager = await posClient.rootChainManager.getContract();
  const callData = rootChainManager.method("exit", payload).encodeABI();
  return {
    callData,
    target: rootChainManager.address,
  };
}

export async function multicallPolygonFinalizations(
  tokensBridged: TokensBridged[],
  posClient: POSClient,
  multicall: Contract,
  hubPoolClient: HubPoolClient,
  logger: winston.Logger
): Promise<void> {
  const finalizableMessages = await getFinalizableTransactions(logger, tokensBridged, posClient);
  if (finalizableMessages.length === 0) return;
  try {
    const callData = await Promise.all(finalizableMessages.map((event) => finalizePolygon(posClient, event)));
    const txn = await (await multicall.aggregate(callData)).wait();
    for (const message of finalizableMessages) {
      const l1TokenCounterpart = hubPoolClient.getL1TokenCounterpartAtBlock(
        137,
        message.l2TokenAddress,
        hubPoolClient.latestBlockNumber
      );
      const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
      const amountFromWei = convertFromWei(message.amountToReturn.toString(), l1TokenInfo.decimals);
      logger.debug({
        at: "PolygonFinalizer",
        message: `Finalized Polygon withdrawal for ${amountFromWei} of ${l1TokenInfo.symbol} 🪃`,
        transactionHash: txn.transactionHash,
      });
    }
  } catch (error) {
    logger.warn({
      at: "PolygonFinalizer",
      message: "Error creating aggregateTx for exit",
      error,
      notificationPath: "across-error",
    });
  }
}

export async function multicallPolygonRetrievals(
  events: TokensBridged[],
  hubSigner: Wallet,
  hubPoolClient: HubPoolClient,
  multicall: Contract,
  logger: winston.Logger
): Promise<void> {
  try {
    const tokensToRetrieve = (
      await Promise.all(
        getL2TokensToFinalize(events).map((l2Token) =>
          retrieveTokenFromMainnetTokenBridger(l2Token, hubSigner, hubPoolClient)
        )
      )
    ).filter((x) => x !== undefined);
    if (tokensToRetrieve.length === 0) return;
    const txn = await (await multicall.aggregate(tokensToRetrieve.map((x) => x.callData))).wait();
    for (const retrieval of tokensToRetrieve) {
      const balanceFromWei = ethers.utils.formatUnits(
        retrieval.balanceToRetrieve.toString(),
        retrieval.l1TokenInfo.decimals
      );
      logger.info({
        at: "PolygonFinalizer",
        message: `Retrieved ${balanceFromWei} of ${retrieval.l1TokenInfo.symbol} from PolygonTokenBridger 🪃`,
        transactionHash: etherscanLink(txn.transactionHash, 1),
      });
    }
  } catch (error) {
    logger.warn({
      at: "PolygonFinalizer",
      message: "Error creating aggregateTx for token retrieval",
      error,
      notificationPath: "across-error",
    });
  }
}

export function getMainnetTokenBridger(mainnetSigner: Wallet) {
  return getDeployedContract("PolygonTokenBridger", 1, mainnetSigner);
}

export async function retrieveTokenFromMainnetTokenBridger(
  l2Token: string,
  mainnetSigner: Wallet,
  hubPoolClient: HubPoolClient
): Promise<{ callData: Multicall2Call; balanceToRetrieve: BigNumber; l1TokenInfo: L1Token }> {
  const l1Token = hubPoolClient.getL1TokenCounterpartAtBlock(CHAIN_ID, l2Token, hubPoolClient.latestBlockNumber);
  const mainnetTokenBridger = getMainnetTokenBridger(mainnetSigner);
  const token = new Contract(l1Token, ERC20.abi, mainnetSigner);
  const l1TokenInfo = hubPoolClient.getTokenInfo(1, l1Token);
  const balance = await token.balanceOf(mainnetTokenBridger.address);

  // WETH is sent to token bridger contract as ETH.
  const ethBalance = await mainnetTokenBridger.provider.getBalance(mainnetTokenBridger.address);
  const balanceToRetrieve = l1TokenInfo.symbol === "WETH" ? ethBalance : balance;
  if (balanceToRetrieve.gt(toBN(0))) {
    const callData = await mainnetTokenBridger.populateTransaction.retrieve(l1Token);
    return {
      callData: {
        callData: callData.data,
        target: callData.to,
      },
      l1TokenInfo,
      balanceToRetrieve,
    };
  }
}

export function getL2TokensToFinalize(events: TokensBridged[]) {
  const l2TokenCountInBridgeEvents = events.reduce((l2TokenDictionary, event) => {
    l2TokenDictionary[event.l2TokenAddress] = true;
    return l2TokenDictionary;
  }, {});
  return Object.keys(l2TokenCountInBridgeEvents).filter((token) => l2TokenCountInBridgeEvents[token] === true);
}

export const minimumRootChainAbi = [
  {
    inputs: [{ internalType: "bytes", name: "inputData", type: "bytes" }],
    name: "exit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
