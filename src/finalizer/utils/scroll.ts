/* eslint-disable @typescript-eslint/no-unused-vars */
import { utils as sdkUtils } from "@across-protocol/sdk";
import { TransactionRequest } from "@ethersproject/abstract-provider";
import axios from "axios";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../common";
import { Contract, Signer, getBlockForTimestamp, getCurrentTime, getRedisCache, winston, TransactionResponse, compareAddressesSimple, assert, bnOne, BigNumber } from "../../utils";
import { FinalizerPromise, CrossChainMessage } from "../types";
import { BytesLike, utils } from "ethers";
//import { utils.keccak256, utils.hexlify, utils.concat, utils.getBytes } from "ethers";
//import type { BytesLike } from "ethers";

type ScrollClaimInfo = {
  from: string;
  to: string;
  value: string;
  nonce: string;
  message: string;
  proof: string;
  batch_index: string;
};

type CommittedBatch = {
  index: BigNumber;
  batchHash: string;
  commitTxHash: string;
  blockRange: [number, number];
  withdrawals: Withdrawal[];
}

type Withdrawal = {
  block: number;
  queueIndex: number;
  messageHash: string;
  transactionHash: string;
}

const MaxHeight = 40;

// TODO: I think this requires us to have all claimable messages since we need to construct proofs. This is probably fixed by choosing a longer lookback window.
// TODO: Fix this
const COMMIT_BATCH_SIGNATURE = "0x2c32d4ae151744d0bf0b9464a3e897a1d17ed2f1af71f7c9a75f12ce0d28238f";
const FINALIZE_BATCH_SIGNATURE = "0x26ba82f907317eedc97d0cbef23de76a43dd6edb563bdb6e9407645b950a7a2d";
const MAX_CONCURRENT_CALL = 10000;
const APPEND_MESSAGE_SIGNATURE = "0xfaa617c2d8ce12c62637dbce76efcc18dae60574aa95709bdcedce7e76071693";
const BLOCK_SYNC_STEP = 1000;

type ScrollClaimInfoWithL1Token = ScrollClaimInfo & {
  l1Token: string;
};

export async function scrollFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const [l1ChainId, l2ChainId, targetAddress] = [
    hubPoolClient.chainId,
    spokePoolClient.chainId,
    spokePoolClient.spokePool.address,
  ];
  const relayContract = getScrollRelayContract(l1ChainId, signer);

  // TODO: Why are we not using the SpokePoolClient.getTokensBridged() method here to get a list
  // of all possible withdrawals and then narrowing the Scroll API search afterwards?
  // Why are we breaking with the existing pattern--is it faster?
  // Scroll takes up to 4 hours with finalize a withdrawal so lets search
  // up to 12 hours for withdrawals.
  const lookback = getCurrentTime() - 12 * 60 * 60 * 24;
  const redis = await getRedisCache(logger);
  const fromBlock = await getBlockForTimestamp(l1ChainId, lookback, undefined, redis);
  logger.debug({
    at: "Finalizer#ScrollFinalizer",
    message: "Scroll TokensBridged event filter",
    fromBlock,
  });

  const { address: scrollChainAddress, abi: scrollChainAbi } = CONTRACT_ADDRESSES[l1ChainId].scrollChain;
  const { address: messageQueueAddress, abi: messageQueueAbi } = CONTRACT_ADDRESSES[l2ChainId].scrollMessageQueue;
  const scrollChain = new Contract(scrollChainAddress, scrollChainAbi, signer);
  const messageQueue = new Contract(messageQueueAddress, messageQueueAbi, spokePoolClient.spokePool.provider);
  const outstandingClaims = await findOutstandingClaims(targetAddress, fromBlock, scrollChain, messageQueue);

  assert(false);
  logger.debug({
    at: "Finalizer#ScrollFinalizer",
    message: `Detected ${outstandingClaims.length} claims for ${targetAddress}`,
  });

  const [callData, crossChainMessages] = await Promise.all([
    sdkUtils.mapAsync(outstandingClaims, (claim) => populateClaimTransaction(claim, relayContract)),
    outstandingClaims.map((claim) => populateClaimWithdrawal(claim, l2ChainId, hubPoolClient)),
  ]);
  return {
    crossChainMessages,
    callData,
  };
}

/**
 * Resolves all outstanding claims from Scroll -> Mainnet. This is done by
 * querying the Scroll API for all outstanding claims.
 * @param targetAddress The address to query for outstanding claims
 * @param latestBlockToFinalize The first block to finalize
 * @returns A list of all outstanding claims
 */
async function findOutstandingClaims(targetAddress: string, latestBlockToFinalize: number, scrollChain: Contract, messageQueue: Contract) {
  // By default, the URL link is to the mainnet API. If we want to
  // test on a testnet, we can change the URL to the testnet API.
  // I.e. Switch to https://sepolia-api-bridge.scroll.io/api/claimable
  // const currentBlock = await scrollChain.provider.getBlockNumber();
  const currentBlock = 20414387;

  const committedBatches = [];
  const [commitLogs, finalizationLogs] = await Promise.all([
    scrollChain.provider.getLogs({
      fromBlock: currentBlock - 1000,
      toBlock: currentBlock + 1000,
      address: scrollChain.address,
      topics: [COMMIT_BATCH_SIGNATURE],
    }),
    scrollChain.provider.getLogs({
      fromBlock: currentBlock - 1000,
      toBlock: currentBlock + 2000,
      address: scrollChain.address,
      topics: [FINALIZE_BATCH_SIGNATURE],
    }),
  ]);

  /*
  const [commitLogs, finalizationLogs] = await Promise.all([
    scrollChain.provider.getLogs({
      fromBlock: latestBlockToFinalize,
      toBlock: latestBlockToFinalize + 10000,
      address: scrollChain.address,
      topics: [COMMIT_BATCH_SIGNATURE],
    }),
    scrollChain.provider.getLogs({
      fromBlock: latestBlockToFinalize,
      toBlock: latestBlockToFinalize + 10000,
      address: scrollChain.address,
      topics: [FINALIZE_BATCH_SIGNATURE],
    }),
  ]);
 */
  // First, we need to gather all the possible message hashes used to finalize a transaction. 
  const message = "0x46E2FF9A94D6F45D05A7EAC6706E20834BF6098DD7CD06885E26DEB0F10E66F5";
  // Then, with these message hashes in hand, we gather all withdrawals within a committed batch. If a withdrawal we are trying to finalize is within this committed batch, then we continue, otherwise, we return early (since there is nothing there for us to finalize). 
  const transactions = await getTransactionsByHash(commitLogs.map((log) => log.transactionHash), MAX_CONCURRENT_CALL, scrollChain);
  const blockRanges = await Promise.all(Object.values(transactions).map(({ data }) => decodeBlockRange(data, scrollChain)));
  const withdrawals = await Promise.all(blockRanges.map((range) => getWithdrawals(range[0], range[1], messageQueue)));
  // TODO:
  const waited = await Promise.all(withdrawals.map((withdrawal) => withdrawal));
  console.log(waited);

  assert(commitLogs.length === Object.values(transactions).length);
  assert(commitLogs.length === blockRanges.length);
  assert(commitLogs.length === waited.length);
  const scrollClaimInfo = waited.map((transactionBundle, idx) => {
    const transaction = transactionBundle.filter(({ messageHash }) => compareAddressesSimple(messageHash, message));
    if (transaction.length !== 0) {
      const includedCommitBatchEvent = scrollChain.interface.decodeEventLog("CommitBatch", commitLogs[idx].data, commitLogs[idx].topics);
      const batch =  {
        index: includedCommitBatchEvent.batchIndex,
        batchHash: includedCommitBatchEvent.batchHash,
        commitTxHash: commitLogs[idx].transactionHash,
        blockRange: blockRanges[idx],
        withdrawals: waited[idx],
      } as CommittedBatch;
      // Scroll uses patricia trees to encode finalization transactions, so we only need to fetch the last finalized withdrawal to construct current withdrawal proofs. 
      const previousFinalizationEvent = finalizationLogs.map((log) => {
          const t = scrollChain.interface.decodeEventLog("FinalizeBatch", log.data, log.topics);
          console.log(t.batchIndex);
          console.log(batch.index);
          console.log(t.batchIndex === batch.index);
          return t;
      }).filter(({ batchIndex }) => batchIndex === batch.index.sub(bnOne));
      if (previousFinalizationEvent.length === 0) {
        throw new Error(`There exists no previous finalization event corresponding to the committed batch with index ${batch.index}. You need to modify the finalizer's lookback configuration.`);
      }
      console.log(previousFinalizationEvent);
      console.log(batch);
      ///const proofs = appendMessages(waited[idx].map((w) => w.messageHash));
      //console.log(proofs);
    }
  });
  return [];
}

/**
 * Returns the Scroll Relay contract for the given chain ID and signer.
 * @param l1ChainId The chain ID to use - i.e. the hub chain ID
 * @param signer The signer that will be used to sign the transaction
 * @returns A Scroll Relay contract, instnatiated with the given signer
 */
function getScrollRelayContract(l1ChainId: number, signer: Signer) {
  const { abi: scrollRelayAbi, address: scrollRelayAddress } = CONTRACT_ADDRESSES[l1ChainId]?.scrollRelayMessenger;
  return new Contract(scrollRelayAddress, scrollRelayAbi, signer);
}

/**
 * Populates a claim transaction for the given claim and relay contract.
 * @param claim The claim to populate a transaction for
 * @param relayContract The relay contract to use for populating the transaction
 * @returns A populated transaction able to be passed into a Multicall2 call
 */
async function populateClaimTransaction(claim: ScrollClaimInfo, relayContract: Contract): Promise<Multicall2Call> {
  const { to, data } = (await relayContract.populateTransaction.relayMessageWithProof(
    claim.from,
    claim.to,
    claim.value,
    claim.nonce,
    claim.message,
    {
      batchIndex: claim.batch_index,
      merkleProof: claim.proof,
    }
  )) as TransactionRequest;
  return {
    callData: data,
    target: to,
  };
}

/**
 * Populates a withdrawal for the given claim.
 * @param claim The claim to populate a withdrawal for
 * @param l2ChainId The chain ID to use - i.e. the spoke chain ID - for this case it will either be Scroll or Sepolia Scroll
 * @param hubPoolClient The hub pool client to use for getting the L1 token symbol
 * @returns A populated withdrawal
 */
function populateClaimWithdrawal(
  claim: ScrollClaimInfoWithL1Token,
  l2ChainId: number,
  hubPoolClient: HubPoolClient
): CrossChainMessage {
  const l1Token = hubPoolClient.getTokenInfo(hubPoolClient.chainId, claim.l1Token);
  return {
    originationChainId: l2ChainId,
    l1TokenSymbol: l1Token.symbol,
    amount: claim.value,
    type: "withdrawal",
    destinationChainId: hubPoolClient.chainId, // Always on L1
  };
}

// The below functions are adapted from https://github.com/scroll-tech/scroll-bridge-sdk/blob/2b961be5bf3164947905ad4664ed69894698e903/src/indexer/batch-indexer.ts#L48
function decodeBlockRange(data: string, scrollChain: Contract): [number, number] {
  let chunks: Array<string>;
  let _version: number;
  if (data.startsWith("0x1325aca0")) {
    [_version, , chunks] = scrollChain.interface.decodeFunctionData("commitBatch", data);
  } else if (data.startsWith("0x86b053a9")) {
    [_version, , chunks] = scrollChain.interface.decodeFunctionData("commitBatchWithBlobProof", data);
  } else {
    throw Error("Invalid calldata: " + data);
  }
  let startBlock: number = -1;
  let endBlock: number = -1;
  for (const chunk of chunks) {
    // skip '0x', parse 1st byte as `numBlocks`
    const numBlocks = parseInt(chunk.slice(2, 4), 16);
    for (let i = 0; i < numBlocks; ++i) {
      // each `blockContext` is 60 bytes (120 chars) long and
      // contains `blockNumber` as its first 8-byte field.
      const blockNumber = parseInt(chunk.slice(4 + i * 120, 4 + i * 120 + 16), 16);
      if (startBlock === -1) {
        startBlock = blockNumber;
      }
      endBlock = blockNumber;
    }
  }
  return [startBlock, endBlock];
}

async function getTransactionsByHash(hashes: Array<string>, maxConcurrentCall: number, scrollChain: Contract): Promise<Record<string, TransactionResponse>> {
  const txCache: Record<string, TransactionResponse> = {};
  for (let i = 0; i < hashes.length; i += maxConcurrentCall) {
    const tasks = [];
    for (let j = i; j < hashes.length && j - i < maxConcurrentCall; ++j) {
      tasks.push(scrollChain.provider.getTransaction(hashes[j]));
    }
    const results = await Promise.all(tasks);
    for (const tx of results) {
      txCache[tx!.hash] = tx!;
    }
  }
  return txCache;
}

async function getWithdrawals(startBlock: number, endBlock: number, l2MessageQueue: Contract): Promise<Array<Withdrawal>> {
  const withdrawals: Array<Withdrawal> = [];
  while (startBlock <= endBlock) {
    const fromBlock = startBlock;
    const toBlock = Math.min(fromBlock + BLOCK_SYNC_STEP - 1, endBlock);
    startBlock = toBlock + 1;
    const logs = await l2MessageQueue.provider.getLogs({
      fromBlock,
      toBlock,
      address: l2MessageQueue.address,
      topics: [APPEND_MESSAGE_SIGNATURE],
    });
    for (let index = 0; index < logs.length; ++index) {
      const log = logs[index];
      if (log.topics[0] === APPEND_MESSAGE_SIGNATURE) {
        const event = l2MessageQueue.interface.decodeEventLog("AppendMessage", log.data, log.topics);
        withdrawals.push({
          block: log.blockNumber,
          queueIndex: Number(event.index),
          messageHash: event.messageHash,
          transactionHash: log.transactionHash,
        });
      }
    }
  }
  return withdrawals;
}

/*
function appendMessages(hashes: Array<string>, nextMessageNonce: number, height: number, branches: Array<string>, zeros: Array<string>): Array<string> {
  const length = hashes.length;
  if (length === 0) return [];

  const cache = new Array<Map<number, string>>(MaxHeight);
  for (let h = 0; h < MaxHeight; ++h) {
    cache[h] = new Map();
  }

  // cache all branches will be used later.
  if (nextMessageNonce !== 0) {
    let index = nextMessageNonce;
    for (let h = 0; h <= height; h++) {
      if (index % 2 === 1) {
        // right child, `w.branches[h]` is the corresponding left child
        // the index of left child should be `index ^ 1`.
        cache[h].set(index ^ 1, branches[h]);
      }
      index >>= 1;
    }
  }
  // cache all new leaves
  for (let i = 0; i < length; i++) {
    cache[0].set(nextMessageNonce + i, hashes[i]);
  }

  // build withdraw trie with new hashes
  let minIndex = nextMessageNonce;
  let maxIndex = nextMessageNonce + length - 1;
  for (let h = 0; maxIndex > 0; h++) {
    if (minIndex % 2 === 1) {
      minIndex--;
    }
    if (maxIndex % 2 === 0) {
      cache[h].set(maxIndex ^ 1, zeros[h]);
    }
    for (let i = minIndex; i <= maxIndex; i += 2) {
      cache[h + 1].set(i >> 1, utils.keccak256(utils.concat([cache[h].get(i)!, cache[h].get(i ^ 1)!])));
    }
    minIndex >>= 1;
    maxIndex >>= 1;
  }

  // update branches using hashes one by one
  for (let i = 0; i < length; i++) {
    const proof = updateBranchWithNewMessage(zeros, branches, nextMessageNonce, hashes[i]);
    nextMessageNonce += 1;
    height = proof.length;
  }

  const proofs: Array<string> = new Array(length);
  // retrieve merkle proof from cache
  for (let i = 0; i < length; i++) {
    let index = nextMessageNonce + i - length;
    const merkleProof: Array<string> = [];
    for (let h = 0; h < height; h++) {
      merkleProof.push(cache[h].get(index ^ 1)!);
      index >>= 1;
    }
    proofs[i] = utils.concat(merkleProof);
  }

  return proofs;
}

// decodeBytesToMerkleProof transfer byte array to bytes32 array. The caller should make sure the length is matched.
function decodeBytesToMerkleProof(proofBytes: BytesLike): Array<string> {
  const data = utils.getBytes(proofBytes);
  const proof: Array<string> = new Array(Math.floor(data.length / 32));
  for (let i = 0; i < data.length; i += 32) {
    proof[i / 32] = utils.hexlify(data.slice(i, i + 32));
  }
  return proof;
}

// updateBranchWithNewMessage update the branches to latest with new message and return the merkle proof for the message.
function updateBranchWithNewMessage(
  zeros: Array<string>,
  branches: Array<string>,
  index: number,
  msgHash: string,
): Array<string> {
  let root = msgHash;
  const merkleProof: Array<string> = [];
  let height = 0;
  for (height = 0; index > 0; height++) {
    if (index % 2 === 0) {
      // it may be used in next round.
      branches[height] = root;
      merkleProof.push(zeros[height]);
      // it's a left child, the right child must be null
      root = utils.keccak256(utils.concat([root, zeros[height]]));
    } else {
      // it's a right child, use previously computed hash
      root = utils.keccak256(utils.concat([branches[height], root]));
      merkleProof.push(branches[height]);
    }
    index >>= 1;
  }
  branches[height] = root;
  return merkleProof;
}
*/
