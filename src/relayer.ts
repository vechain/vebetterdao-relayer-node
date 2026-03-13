import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Address, Clause, Transaction } from "@vechain/sdk-core"
import {
  XAllocationVoting__factory,
  VoterRewards__factory,
} from "@vechain/vebetterdao-contracts/typechain-types"
import { NetworkConfig, CycleResult, LogFn } from "./types"
import {
  getCurrentRoundId,
  getRoundSnapshot,
  getRoundDeadline,
  getAutoVotingUsers,
  getAlreadySkippedVotersForRound,
  getAlreadyClaimedForRound,
  getVotedUsersForRound,
} from "./contracts"

const xavAbi = ABIContract.ofAbi(XAllocationVoting__factory.abi)
const vrAbi = ABIContract.ofAbi(VoterRewards__factory.abi)

const MAX_GAS = 40_000_000

// ── Clause builders ─────────────────────────────────────────

function buildCastVoteClause(contractAddress: string, roundId: number, user: string): Clause {
  return Clause.callFunction(
    Address.of(contractAddress),
    xavAbi.getFunction("castVoteOnBehalfOf"),
    [user, roundId],
  )
}

function buildClaimRewardClause(contractAddress: string, roundId: number, user: string): Clause {
  return Clause.callFunction(
    Address.of(contractAddress),
    vrAbi.getFunction("claimReward"),
    [roundId, user],
  )
}

// ── Batch processing ────────────────────────────────────────

interface BatchOutcome {
  successful: number
  failed: { user: string; reason: string }[]
  transient: { user: string; reason: string }[]
  txIds: string[]
}

async function processBatch(
  thor: ThorClient,
  users: string[],
  clauseBuilder: (user: string) => Clause,
  walletAddress: string,
  privateKey: string,
  batchSize: number,
  dryRun: boolean,
  log: LogFn,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { successful: 0, failed: [], transient: [], txIds: [] }
  const queue = [...users]
  let batchNum = 0
  const totalBatches = Math.ceil(queue.length / batchSize)

  while (queue.length > 0) {
    batchNum++
    const batch = queue.splice(0, batchSize)
    const clauses = batch.map(clauseBuilder)

    log(`Batch ${batchNum}/${totalBatches} (${batch.length} users): simulating...`)

    try {
      const gasResult = await thor.gas.estimateGas(clauses, walletAddress, { gasPadding: 0.1 })

      if (gasResult.reverted) {
        log(`Batch ${batchNum}: gas estimation failed, isolating failures...`)
        await isolateAndRetry(thor, batch, clauseBuilder, walletAddress, privateKey, dryRun, outcome, log)
        continue
      }

      if (dryRun) {
        log(`Batch ${batchNum}: ✓ simulation OK (dry run)`)
        outcome.successful += batch.length
        outcome.txIds.push(`DRY_RUN_${batchNum}`)
        continue
      }

      const txBody = await thor.transactions.buildTransactionBody(clauses, gasResult.totalGas)
      const signed = Transaction.of(txBody).sign(Buffer.from(privateKey, "hex"))
      const sent = await thor.transactions.sendTransaction(signed)
      const receipt = await thor.transactions.waitForTransaction(sent.id)

      if (receipt && !receipt.reverted) {
        log(`Batch ${batchNum}: ✓ ${batch.length} OK (tx: ${sent.id.slice(0, 10)}...)`)
        outcome.successful += batch.length
        outcome.txIds.push(sent.id)
      } else {
        log(`Batch ${batchNum}: tx reverted, isolating failures...`)
        await isolateAndRetry(thor, batch, clauseBuilder, walletAddress, privateKey, dryRun, outcome, log)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`Batch ${batchNum}: error - ${msg.slice(0, 100)}`)
      await isolateAndRetry(thor, batch, clauseBuilder, walletAddress, privateKey, dryRun, outcome, log)
    }

    await delay(100)
  }

  return outcome
}

async function isolateAndRetry(
  thor: ThorClient,
  users: string[],
  clauseBuilder: (user: string) => Clause,
  walletAddress: string,
  privateKey: string,
  dryRun: boolean,
  outcome: BatchOutcome,
  log: LogFn,
): Promise<void> {
  const valid: string[] = []

  for (const user of users) {
    try {
      const gas = await thor.gas.estimateGas([clauseBuilder(user)], walletAddress, { gasPadding: 0.1 })
      if (gas.reverted) {
        const reason = gas.revertReasons?.[0] ? String(gas.revertReasons[0]) : "reverted"
        outcome.failed.push({ user, reason })
      } else {
        valid.push(user)
      }
    } catch (err) {
      outcome.failed.push({ user, reason: err instanceof Error ? err.message : String(err) })
    }
    await delay(20)
  }

  if (valid.length === 0) return

  if (dryRun) {
    outcome.successful += valid.length
    outcome.txIds.push("DRY_RUN_ISOLATED")
    log(`Isolated: ${valid.length} valid, ${users.length - valid.length} failed (dry run)`)
    return
  }

  const clauses = valid.map(clauseBuilder)
  try {
    const gas = await thor.gas.estimateGas(clauses, walletAddress, { gasPadding: 0.1 })
    if (gas.reverted) {
      valid.forEach((u) => outcome.transient.push({ user: u, reason: "retry reverted" }))
      return
    }
    const body = await thor.transactions.buildTransactionBody(clauses, gas.totalGas)
    const signed = Transaction.of(body).sign(Buffer.from(privateKey, "hex"))
    const sent = await thor.transactions.sendTransaction(signed)
    const receipt = await thor.transactions.waitForTransaction(sent.id)
    if (receipt && !receipt.reverted) {
      outcome.successful += valid.length
      outcome.txIds.push(sent.id)
      log(`Isolated: ✓ ${valid.length} OK (tx: ${sent.id.slice(0, 10)}...)`)
    } else {
      valid.forEach((u) => outcome.transient.push({ user: u, reason: "tx reverted on retry" }))
    }
  } catch {
    valid.forEach((u) => outcome.transient.push({ user: u, reason: "network error on retry" }))
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Public cycle runners ────────────────────────────────────

export async function runCastVoteCycle(
  thor: ThorClient,
  config: NetworkConfig,
  walletAddress: string,
  privateKey: string,
  batchSize: number,
  dryRun: boolean,
  log: LogFn,
): Promise<CycleResult> {
  const roundId = await getCurrentRoundId(thor, config.xAllocationVotingAddress)
  const snapshot = await getRoundSnapshot(thor, config.xAllocationVotingAddress, roundId)

  log(`Fetching auto-voting users (round #${roundId}, snapshot block ${snapshot})...`)
  const allUsers = await getAutoVotingUsers(thor, config.xAllocationVotingAddress, snapshot)
  log(`Found ${allUsers.length} auto-voting users`)

  if (allUsers.length === 0) {
    return {
      phase: "vote",
      roundId,
      totalUsers: 0,
      actionableUsers: 0,
      pendingUsers: 0,
      successful: 0,
      failed: [],
      transient: [],
      txIds: [],
      dryRun,
    }
  }

  // Fetch ineligible users (AutoVoteSkipped) for this round
  const best = await thor.blocks.getBestBlockCompressed()
  const latestBlock = best?.number ?? snapshot
  const skippedSet = await getAlreadySkippedVotersForRound(
    thor,
    config.xAllocationVotingAddress,
    roundId,
    snapshot,
    latestBlock,
  )

  // Check who already voted (batched to avoid overwhelming the node)
  log("Checking vote status...")
  const unprocessed: string[] = []
  const votedSet = await getVotedUsersForRound(thor, config.xAllocationVotingAddress, roundId, allUsers)
  let voted = 0
  let ineligible = 0

  for (const user of allUsers) {
    const normalizedUser = user.toLowerCase()
    if (votedSet.has(normalizedUser)) {
      voted++
    } else if (skippedSet.has(normalizedUser)) {
      ineligible++
    } else {
      unprocessed.push(user)
    }
  }
  log(`${allUsers.length} auto-voting users: ${voted} voted, ${ineligible} ineligible, ${unprocessed.length} pending`)

  if (unprocessed.length === 0) {
    return {
      phase: "vote",
      roundId,
      totalUsers: allUsers.length,
      actionableUsers: 0,
      pendingUsers: 0,
      successful: 0,
      failed: [],
      transient: [],
      txIds: [],
      dryRun,
    }
  }

  const clauseBuilder = (user: string) => buildCastVoteClause(config.xAllocationVotingAddress, roundId, user)
  const result = await processBatch(thor, unprocessed, clauseBuilder, walletAddress, privateKey, batchSize, dryRun, log)
  const pendingUsers = Math.max(0, unprocessed.length - result.successful - result.failed.length)

  return {
    phase: "vote",
    roundId,
    totalUsers: allUsers.length,
    actionableUsers: unprocessed.length,
    pendingUsers,
    successful: result.successful,
    failed: result.failed,
    transient: result.transient,
    txIds: result.txIds,
    dryRun,
  }
}

export async function runClaimRewardCycle(
  thor: ThorClient,
  config: NetworkConfig,
  walletAddress: string,
  privateKey: string,
  batchSize: number,
  dryRun: boolean,
  log: LogFn,
): Promise<CycleResult> {
  const currentRoundId = await getCurrentRoundId(thor, config.xAllocationVotingAddress)
  const previousRoundId = currentRoundId - 1
  if (previousRoundId <= 0) {
    log("No previous round to claim for")
    return {
      phase: "claim",
      roundId: 0,
      totalUsers: 0,
      actionableUsers: 0,
      pendingUsers: 0,
      successful: 0,
      failed: [],
      transient: [],
      txIds: [],
      dryRun,
    }
  }

  const snapshot = await getRoundSnapshot(thor, config.xAllocationVotingAddress, previousRoundId)
  const deadline = await getRoundDeadline(thor, config.xAllocationVotingAddress, previousRoundId)

  log(`Fetching auto-voting users for previous round #${previousRoundId}...`)
  const allUsers = await getAutoVotingUsers(thor, config.xAllocationVotingAddress, snapshot)

  if (allUsers.length === 0) {
    return {
      phase: "claim",
      roundId: previousRoundId,
      totalUsers: 0,
      actionableUsers: 0,
      pendingUsers: 0,
      successful: 0,
      failed: [],
      transient: [],
      txIds: [],
      dryRun,
    }
  }

  // Only claim for users who voted AND haven't been claimed yet
  const best = await thor.blocks.getBestBlockCompressed()
  const latestBlock = best?.number ?? deadline
  const claimedSet = await getAlreadyClaimedForRound(
    thor,
    config.voterRewardsAddress,
    previousRoundId,
    deadline,
    latestBlock,
  )

  log("Checking vote status for previous round...")
  const unclaimed: string[] = []
  const votedSet = await getVotedUsersForRound(thor, config.xAllocationVotingAddress, previousRoundId, allUsers)
  let didNotVote = 0
  let alreadyClaimed = 0

  for (const user of allUsers) {
    const normalizedUser = user.toLowerCase()
    if (!votedSet.has(normalizedUser)) {
      didNotVote++
    } else if (claimedSet.has(normalizedUser)) {
      alreadyClaimed++
    } else {
      unclaimed.push(user)
    }
  }
  log(`${allUsers.length} auto-voting users: ${alreadyClaimed} claimed, ${didNotVote} did not vote, ${unclaimed.length} pending`)

  if (unclaimed.length === 0) {
    return {
      phase: "claim",
      roundId: previousRoundId,
      totalUsers: allUsers.length,
      actionableUsers: 0,
      pendingUsers: 0,
      successful: 0,
      failed: [],
      transient: [],
      txIds: [],
      dryRun,
    }
  }

  const clauseBuilder = (user: string) => buildClaimRewardClause(config.voterRewardsAddress, previousRoundId, user)
  const result = await processBatch(thor, unclaimed, clauseBuilder, walletAddress, privateKey, batchSize, dryRun, log)
  const pendingUsers = Math.max(0, unclaimed.length - result.successful - result.failed.length)

  return {
    phase: "claim",
    roundId: previousRoundId,
    totalUsers: allUsers.length,
    actionableUsers: unclaimed.length,
    pendingUsers,
    successful: result.successful,
    failed: result.failed,
    transient: result.transient,
    txIds: result.txIds,
    dryRun,
  }
}
