import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Address, Clause, Transaction } from "@vechain/sdk-core"
import {
  XAllocationVoting__factory,
  VoterRewards__factory,
} from "@vechain/vebetterdao-contracts/typechain-types"
import chalk from "chalk"
import { NetworkConfig, CycleResult, LogFn } from "./types"
import {
  getCurrentRoundId,
  getRoundSnapshot,
  getRoundDeadline,
  getAutoVotingUsers,
  getAlreadySkippedVotersForRound,
  getAlreadyClaimedForRound,
  getPreferredRelayersForUsers,
  getEarlyAccessBlocks,
  hasVoted,
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

    log(chalk.dim(`Batch ${batchNum}/${totalBatches} (${batch.length} users): simulating...`))

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

  log(`Fetching users (snapshot block ${snapshot})...`)
  const allUsers = await getAutoVotingUsers(thor, config.xAllocationVotingAddress, snapshot)
  log(`Found ${chalk.white.bold(allUsers.length.toString())} auto-voting users`)

  if (allUsers.length === 0) {
    return { phase: "vote", roundId, totalUsers: 0, successful: 0, failed: [], transient: [], txIds: [], dryRun }
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

  // During early access, skip users who have a different preferred relayer
  const earlyAccessBlocks = await getEarlyAccessBlocks(thor, config.relayerRewardsPoolAddress)
  const voteEarlyAccessEnd = snapshot + Number(earlyAccessBlocks)
  const isEarlyAccess = latestBlock < voteEarlyAccessEnd

  let preferredMap = new Map<string, string>()
  let skippedPreferred = 0
  if (isEarlyAccess) {
    log(chalk.dim("Early access active — respecting preferred relayer preferences"))
    preferredMap = await getPreferredRelayersForUsers(thor, config.relayerRewardsPoolAddress, allUsers)
  }

  log("Checking vote status...")
  const unprocessed: string[] = []
  let voted = 0
  let ineligible = 0
  const CHECK_BATCH = 10
  for (let i = 0; i < allUsers.length; i += CHECK_BATCH) {
    const chunk = allUsers.slice(i, i + CHECK_BATCH)
    const checks = await Promise.all(chunk.map((u) => hasVoted(thor, config.xAllocationVotingAddress, roundId, u)))
    for (let j = 0; j < chunk.length; j++) {
      if (checks[j]) {
        voted++
      } else if (skippedSet.has(chunk[j].toLowerCase())) {
        ineligible++
      } else if (isEarlyAccess) {
        const pref = preferredMap.get(chunk[j].toLowerCase())
        if (pref && pref !== walletAddress.toLowerCase()) {
          skippedPreferred++
        } else {
          unprocessed.push(chunk[j])
        }
      } else {
        unprocessed.push(chunk[j])
      }
    }
    if (i + CHECK_BATCH < allUsers.length) await delay(150)
  }
  const prefStr = skippedPreferred > 0 ? ` · ${chalk.dim(skippedPreferred.toString())} other relayer preferred` : ""
  log(`${chalk.green(voted.toString())} voted · ${chalk.yellow(ineligible.toString())} ineligible · ${chalk.cyan(unprocessed.length.toString())} pending${prefStr}`)

  if (unprocessed.length === 0) {
    return { phase: "vote", roundId, totalUsers: allUsers.length, successful: 0, failed: [], transient: [], txIds: [], dryRun }
  }

  const clauseBuilder = (user: string) => buildCastVoteClause(config.xAllocationVotingAddress, roundId, user)
  const result = await processBatch(thor, unprocessed, clauseBuilder, walletAddress, privateKey, batchSize, dryRun, log)

  return {
    phase: "vote",
    roundId,
    totalUsers: allUsers.length,
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
    return { phase: "claim", roundId: 0, totalUsers: 0, successful: 0, failed: [], transient: [], txIds: [], dryRun }
  }

  const snapshot = await getRoundSnapshot(thor, config.xAllocationVotingAddress, previousRoundId)
  const deadline = await getRoundDeadline(thor, config.xAllocationVotingAddress, previousRoundId)

  log(`Fetching users (snapshot block ${snapshot})...`)
  const allUsers = await getAutoVotingUsers(thor, config.xAllocationVotingAddress, snapshot)

  if (allUsers.length === 0) {
    return { phase: "claim", roundId: previousRoundId, totalUsers: 0, successful: 0, failed: [], transient: [], txIds: [], dryRun }
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

  // During early access, skip users who have a different preferred relayer
  const earlyAccessBlocks = await getEarlyAccessBlocks(thor, config.relayerRewardsPoolAddress)
  const claimEarlyAccessEnd = deadline + Number(earlyAccessBlocks)
  const isEarlyAccess = latestBlock < claimEarlyAccessEnd

  let preferredMap = new Map<string, string>()
  let skippedPreferred = 0
  if (isEarlyAccess) {
    log(chalk.dim("Early access active — respecting preferred relayer preferences"))
    preferredMap = await getPreferredRelayersForUsers(thor, config.relayerRewardsPoolAddress, allUsers)
  }

  log("Checking claim status...")
  const unclaimed: string[] = []
  let didNotVote = 0
  let alreadyClaimed = 0
  const CHECK_BATCH = 10
  for (let i = 0; i < allUsers.length; i += CHECK_BATCH) {
    const chunk = allUsers.slice(i, i + CHECK_BATCH)
    const checks = await Promise.all(chunk.map((u) => hasVoted(thor, config.xAllocationVotingAddress, previousRoundId, u)))
    for (let j = 0; j < chunk.length; j++) {
      if (!checks[j]) {
        didNotVote++
      } else if (claimedSet.has(chunk[j].toLowerCase())) {
        alreadyClaimed++
      } else if (isEarlyAccess) {
        const pref = preferredMap.get(chunk[j].toLowerCase())
        if (pref && pref !== walletAddress.toLowerCase()) {
          skippedPreferred++
        } else {
          unclaimed.push(chunk[j])
        }
      } else {
        unclaimed.push(chunk[j])
      }
    }
    if (i + CHECK_BATCH < allUsers.length) await delay(150)
  }
  const prefStr = skippedPreferred > 0 ? ` · ${chalk.dim(skippedPreferred.toString())} other relayer preferred` : ""
  log(`${chalk.green(alreadyClaimed.toString())} claimed · ${chalk.red(didNotVote.toString())} did not vote · ${chalk.cyan(unclaimed.length.toString())} pending${prefStr}`)

  if (unclaimed.length === 0) {
    return { phase: "claim", roundId: previousRoundId, totalUsers: allUsers.length, successful: 0, failed: [], transient: [], txIds: [], dryRun }
  }

  const clauseBuilder = (user: string) => buildClaimRewardClause(config.voterRewardsAddress, previousRoundId, user)
  const result = await processBatch(thor, unclaimed, clauseBuilder, walletAddress, privateKey, batchSize, dryRun, log)

  return {
    phase: "claim",
    roundId: previousRoundId,
    totalUsers: allUsers.length,
    successful: result.successful,
    failed: result.failed,
    transient: result.transient,
    txIds: result.txIds,
    dryRun,
  }
}
