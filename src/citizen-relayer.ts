import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Address, Clause } from "@vechain/sdk-core"
import { VoterRewards__factory } from "@vechain/vebetterdao-contracts/typechain-types"
import chalk from "chalk"
import { NetworkConfig, CycleResult, LogFn } from "./types"
import {
  getCurrentRoundId,
  getRoundSnapshot,
  getRoundDeadline,
  getAlreadyClaimedForRound,
  getPreferredRelayersForUsers,
  getEarlyAccessBlocks,
  hasVoted,
} from "./contracts"
import {
  xavNavAbi,
  govAbi,
  getDelegatedCitizens,
  getNavigatorsForCitizens,
  batchHasSetPreferences,
  batchHasSetDecision,
  getAlreadySkippedCitizensForRound,
  getAlreadySkippedCitizensForProposal,
  getActiveProposals,
  hasVotedOnProposal,
  getProposalDeadline,
} from "./citizen-contracts"
import { processBatch } from "./relayer"

const vrAbi = ABIContract.ofAbi(VoterRewards__factory.abi)

async function hasVotedOnAnyProposal(
  thor: ThorClient,
  governorAddr: string,
  citizen: string,
  proposalIds: number[],
): Promise<boolean> {
  for (const pid of proposalIds) {
    if (await hasVotedOnProposal(thor, governorAddr, pid, citizen)) return true
  }
  return false
}

const SKIP_WINDOW_BLOCKS = 720

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Clause builders ─────────────────────────────────────────

function buildCitizenAllocationVoteClause(xavAddr: string, roundId: number, citizen: string): Clause {
  return Clause.callFunction(
    Address.of(xavAddr),
    xavNavAbi.getFunction("castNavigatorVote"),
    [citizen, roundId],
  )
}

function buildCitizenGovernanceVoteClause(governorAddr: string, proposalId: number, citizen: string): Clause {
  return Clause.callFunction(
    Address.of(governorAddr),
    govAbi.getFunction("castNavigatorVote"),
    [proposalId, citizen],
  )
}

function buildClaimRewardClause(vrAddr: string, roundId: number, citizen: string): Clause {
  return Clause.callFunction(
    Address.of(vrAddr),
    vrAbi.getFunction("claimReward"),
    [roundId, citizen],
  )
}

// ── Citizen Allocation Vote Cycle ───────────────────────────

export async function runCitizenAllocationVoteCycle(
  thor: ThorClient,
  config: NetworkConfig,
  walletAddress: string,
  privateKey: string,
  batchSize: number,
  dryRun: boolean,
  log: LogFn,
): Promise<CycleResult> {
  const empty: CycleResult = { phase: "citizen-vote", roundId: 0, totalUsers: 0, successful: 0, failed: [], transient: [], txIds: [], dryRun }

  const roundId = await getCurrentRoundId(thor, config.xAllocationVotingAddress)
  const snapshot = await getRoundSnapshot(thor, config.xAllocationVotingAddress, roundId)
  const deadline = await getRoundDeadline(thor, config.xAllocationVotingAddress, roundId)

  log(`Fetching delegated citizens (snapshot block ${snapshot})...`)
  const delegationMap = await getDelegatedCitizens(thor, config.navigatorRegistryAddress, snapshot)
  if (delegationMap.size === 0) {
    log(chalk.dim("No delegated citizens found"))
    return { ...empty, roundId }
  }

  // Validate delegations at snapshot via batch simulate
  const allCitizens = [...delegationMap.keys()]
  log(`Found ${chalk.white.bold(allCitizens.length.toString())} cached citizens, validating at snapshot...`)
  const validatedMap = await getNavigatorsForCitizens(thor, config.navigatorRegistryAddress, allCitizens, snapshot, log)
  if (validatedMap.size === 0) {
    log(chalk.dim("No valid delegations at snapshot"))
    return { ...empty, roundId, totalUsers: allCitizens.length }
  }
  log(`${chalk.white.bold(validatedMap.size.toString())} valid delegations`)

  // Filter out already voted
  const best = await thor.blocks.getBestBlockCompressed()
  const latestBlock = best?.number ?? snapshot

  // Filter out already skipped (NavigatorVoteSkipped events)
  const skippedSet = await getAlreadySkippedCitizensForRound(
    thor, config.xAllocationVotingAddress, roundId, snapshot, latestBlock,
  )

  // Pre-check preferences: group citizens by navigator, batch-check hasSetPreferences
  const uniqueNavigators = [...new Set(validatedMap.values())]
  const prefsMap = await batchHasSetPreferences(thor, config.navigatorRegistryAddress, uniqueNavigators, roundId)
  const skipWindowReached = latestBlock + SKIP_WINDOW_BLOCKS >= deadline

  // Build preferred relayer map for early access filtering
  const citizenAddresses = [...validatedMap.keys()]
  const earlyAccessBlocks = await getEarlyAccessBlocks(thor, config.relayerRewardsPoolAddress)
  const voteEarlyAccessEnd = snapshot + Number(earlyAccessBlocks)
  const isEarlyAccess = latestBlock < voteEarlyAccessEnd
  const preferredMap = await getPreferredRelayersForUsers(thor, config.relayerRewardsPoolAddress, citizenAddresses, log)
  const myAddress = walletAddress.toLowerCase()

  // Check vote status and apply all filters
  log("Checking citizen vote status...")
  const unprocessed: string[] = []
  let voted = 0
  let skipped = 0
  let waitingForPrefs = 0
  let skippedPreferred = 0
  const CHECK_BATCH = 10

  for (let i = 0; i < citizenAddresses.length; i += CHECK_BATCH) {
    const chunk = citizenAddresses.slice(i, i + CHECK_BATCH)
    const checks = await Promise.all(
      chunk.map((c) => hasVoted(thor, config.xAllocationVotingAddress, roundId, c)),
    )
    for (let j = 0; j < chunk.length; j++) {
      const citizen = chunk[j]
      if (checks[j]) { voted++; continue }
      if (skippedSet.has(citizen)) { skipped++; continue }

      // Pre-check navigator preferences
      const nav = validatedMap.get(citizen)!
      const hasPrefs = prefsMap.get(nav) ?? false
      if (!hasPrefs && !skipWindowReached) { waitingForPrefs++; continue }

      // Early access: skip citizens who prefer a different relayer
      const pref = preferredMap.get(citizen)
      if (isEarlyAccess && pref && pref !== myAddress) { skippedPreferred++; continue }

      unprocessed.push(citizen)
    }
    if (i + CHECK_BATCH < citizenAddresses.length) await delay(150)
  }

  const parts = [
    `${chalk.green(voted.toString())} voted`,
    `${chalk.yellow(skipped.toString())} skipped`,
    `${chalk.cyan(unprocessed.length.toString())} pending`,
  ]
  if (waitingForPrefs > 0) parts.push(`${chalk.dim(waitingForPrefs.toString())} waiting for prefs`)
  if (skippedPreferred > 0) parts.push(`${chalk.magenta(skippedPreferred.toString())} reserved`)
  log(parts.join(" · "))

  if (unprocessed.length === 0) {
    return { ...empty, roundId, totalUsers: validatedMap.size }
  }

  const clauseBuilder = (citizen: string) => buildCitizenAllocationVoteClause(config.xAllocationVotingAddress, roundId, citizen)
  const result = await processBatch(thor, unprocessed, clauseBuilder, walletAddress, privateKey, batchSize, dryRun, log)

  return {
    phase: "citizen-vote",
    roundId,
    totalUsers: validatedMap.size,
    successful: result.successful,
    failed: result.failed,
    transient: result.transient,
    txIds: result.txIds,
    dryRun,
  }
}

// ── Citizen Governance Vote Cycle ───────────────────────────

export async function runCitizenGovernanceVoteCycle(
  thor: ThorClient,
  config: NetworkConfig,
  walletAddress: string,
  privateKey: string,
  batchSize: number,
  dryRun: boolean,
  log: LogFn,
): Promise<CycleResult[]> {
  const results: CycleResult[] = []

  let proposals: number[]
  try {
    proposals = await getActiveProposals(thor, config.b3trGovernorAddress)
  } catch {
    log(chalk.dim("No active governance proposals (or governor not deployed)"))
    return results
  }

  if (proposals.length === 0) {
    log(chalk.dim("No active governance proposals"))
    return results
  }

  log(`${chalk.white.bold(proposals.length.toString())} active governance proposal(s)`)

  const roundId = await getCurrentRoundId(thor, config.xAllocationVotingAddress)
  const snapshot = await getRoundSnapshot(thor, config.xAllocationVotingAddress, roundId)

  // Get validated citizen list
  const delegationMap = await getDelegatedCitizens(thor, config.navigatorRegistryAddress, snapshot)
  if (delegationMap.size === 0) {
    log(chalk.dim("No delegated citizens"))
    return results
  }
  const allCitizens = [...delegationMap.keys()]
  const validatedMap = await getNavigatorsForCitizens(thor, config.navigatorRegistryAddress, allCitizens, snapshot, log)
  if (validatedMap.size === 0) return results

  const best = await thor.blocks.getBestBlockCompressed()
  const latestBlock = best?.number ?? snapshot
  const citizenAddresses = [...validatedMap.keys()]

  // Early access setup
  const earlyAccessBlocks = await getEarlyAccessBlocks(thor, config.relayerRewardsPoolAddress)
  const voteEarlyAccessEnd = snapshot + Number(earlyAccessBlocks)
  const isEarlyAccess = latestBlock < voteEarlyAccessEnd
  const preferredMap = await getPreferredRelayersForUsers(thor, config.relayerRewardsPoolAddress, citizenAddresses, log)
  const myAddress = walletAddress.toLowerCase()

  for (const proposalId of proposals) {
    log(chalk.dim(`Proposal #${proposalId}:`))

    const proposalDeadline = await getProposalDeadline(thor, config.b3trGovernorAddress, proposalId)
    const govSkipWindowReached = latestBlock + SKIP_WINDOW_BLOCKS >= proposalDeadline

    // Check navigator decisions for this proposal
    const uniqueNavigators = [...new Set(validatedMap.values())]
    const decisionsMap = await batchHasSetDecision(thor, config.navigatorRegistryAddress, uniqueNavigators, proposalId)

    // Scan already skipped citizens for this proposal
    const govSkippedSet = await getAlreadySkippedCitizensForProposal(
      thor, config.b3trGovernorAddress, proposalId, snapshot, latestBlock,
    )

    const unprocessed: string[] = []
    let voted = 0
    let skipped = 0
    let waitingForDecision = 0
    let skippedPreferred = 0
    const CHECK_BATCH = 10

    for (let i = 0; i < citizenAddresses.length; i += CHECK_BATCH) {
      const chunk = citizenAddresses.slice(i, i + CHECK_BATCH)
      const checks = await Promise.all(
        chunk.map((c) => hasVotedOnProposal(thor, config.b3trGovernorAddress, proposalId, c)),
      )
      for (let j = 0; j < chunk.length; j++) {
        const citizen = chunk[j]
        if (checks[j]) { voted++; continue }
        if (govSkippedSet.has(citizen)) { skipped++; continue }

        const nav = validatedMap.get(citizen)!
        const hasDecision = decisionsMap.get(nav) ?? false
        if (!hasDecision && !govSkipWindowReached) { waitingForDecision++; continue }

        const pref = preferredMap.get(citizen)
        if (isEarlyAccess && pref && pref !== myAddress) { skippedPreferred++; continue }

        unprocessed.push(citizen)
      }
      if (i + CHECK_BATCH < citizenAddresses.length) await delay(150)
    }

    const parts = [
      `${chalk.green(voted.toString())} voted`,
      `${chalk.yellow(skipped.toString())} skipped`,
      `${chalk.cyan(unprocessed.length.toString())} pending`,
    ]
    if (waitingForDecision > 0) parts.push(`${chalk.dim(waitingForDecision.toString())} waiting for decision`)
    if (skippedPreferred > 0) parts.push(`${chalk.magenta(skippedPreferred.toString())} reserved`)
    log(`  ${parts.join(" · ")}`)

    if (unprocessed.length === 0) {
      results.push({
        phase: "citizen-governance", roundId: proposalId, totalUsers: validatedMap.size,
        successful: 0, failed: [], transient: [], txIds: [], dryRun,
      })
      continue
    }

    const clauseBuilder = (citizen: string) => buildCitizenGovernanceVoteClause(config.b3trGovernorAddress, proposalId, citizen)
    const result = await processBatch(thor, unprocessed, clauseBuilder, walletAddress, privateKey, batchSize, dryRun, log)

    results.push({
      phase: "citizen-governance",
      roundId: proposalId,
      totalUsers: validatedMap.size,
      successful: result.successful,
      failed: result.failed,
      transient: result.transient,
      txIds: result.txIds,
      dryRun,
    })
  }

  return results
}

// ── Citizen Claim Reward Cycle ──────────────────────────────

export async function runCitizenClaimRewardCycle(
  thor: ThorClient,
  config: NetworkConfig,
  walletAddress: string,
  privateKey: string,
  batchSize: number,
  dryRun: boolean,
  log: LogFn,
): Promise<CycleResult> {
  const empty: CycleResult = { phase: "citizen-claim", roundId: 0, totalUsers: 0, successful: 0, failed: [], transient: [], txIds: [], dryRun }

  const currentRoundId = await getCurrentRoundId(thor, config.xAllocationVotingAddress)
  const previousRoundId = currentRoundId - 1
  if (previousRoundId <= 0) {
    log("No previous round to claim for")
    return empty
  }

  const snapshot = await getRoundSnapshot(thor, config.xAllocationVotingAddress, previousRoundId)
  const deadline = await getRoundDeadline(thor, config.xAllocationVotingAddress, previousRoundId)

  log(`Fetching citizens for previous round (snapshot block ${snapshot})...`)
  const delegationMap = await getDelegatedCitizens(thor, config.navigatorRegistryAddress, snapshot)
  if (delegationMap.size === 0) {
    return { ...empty, roundId: previousRoundId }
  }

  // Validate at previous round's snapshot
  const allCitizens = [...delegationMap.keys()]
  const validatedMap = await getNavigatorsForCitizens(thor, config.navigatorRegistryAddress, allCitizens, snapshot, log)
  if (validatedMap.size === 0) {
    return { ...empty, roundId: previousRoundId, totalUsers: allCitizens.length }
  }

  const citizenAddresses = [...validatedMap.keys()]

  // Check already claimed
  const best = await thor.blocks.getBestBlockCompressed()
  const latestBlock = best?.number ?? deadline
  const claimedSet = await getAlreadyClaimedForRound(
    thor, config.voterRewardsAddress, previousRoundId, deadline, latestBlock,
  )

  // Early access for claims
  const earlyAccessBlocks = await getEarlyAccessBlocks(thor, config.relayerRewardsPoolAddress)
  const claimEarlyAccessEnd = deadline + Number(earlyAccessBlocks)
  const isEarlyAccess = latestBlock < claimEarlyAccessEnd
  const preferredMap = await getPreferredRelayersForUsers(thor, config.relayerRewardsPoolAddress, citizenAddresses, log)
  const myAddress = walletAddress.toLowerCase()

  // Check governance proposals for previous round (for hasVoted check)
  let previousProposals: number[] = []
  try {
    previousProposals = await getActiveProposals(thor, config.b3trGovernorAddress)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes("reverted")) console.error(`Warning: fetch proposals for claim check failed: ${msg}`)
  }

  log("Checking citizen claim status...")
  const unclaimed: string[] = []
  let didNotVote = 0
  let alreadyClaimed = 0
  let skippedPreferred = 0
  const CHECK_BATCH = 10

  for (let i = 0; i < citizenAddresses.length; i += CHECK_BATCH) {
    const chunk = citizenAddresses.slice(i, i + CHECK_BATCH)

    // Check allocation hasVoted
    const allocationChecks = await Promise.all(
      chunk.map((c) => hasVoted(thor, config.xAllocationVotingAddress, previousRoundId, c)),
    )

    const governanceChecks = await Promise.all(
      chunk.map((c) => hasVotedOnAnyProposal(thor, config.b3trGovernorAddress, c, previousProposals)),
    )

    for (let j = 0; j < chunk.length; j++) {
      const citizen = chunk[j]
      const votedAnywhere = allocationChecks[j] || governanceChecks[j]

      if (!votedAnywhere) { didNotVote++; continue }
      if (claimedSet.has(citizen)) { alreadyClaimed++; continue }

      const pref = preferredMap.get(citizen)
      if (isEarlyAccess && pref && pref !== myAddress) { skippedPreferred++; continue }

      unclaimed.push(citizen)
    }
    if (i + CHECK_BATCH < citizenAddresses.length) await delay(150)
  }

  const prefStr = skippedPreferred > 0 ? ` · ${chalk.magenta(skippedPreferred.toString())} reserved` : ""
  log(`${chalk.green(alreadyClaimed.toString())} claimed · ${chalk.red(didNotVote.toString())} did not vote · ${chalk.cyan(unclaimed.length.toString())} pending${prefStr}`)

  if (unclaimed.length === 0) {
    return { ...empty, roundId: previousRoundId, totalUsers: validatedMap.size }
  }

  const clauseBuilder = (citizen: string) => buildClaimRewardClause(config.voterRewardsAddress, previousRoundId, citizen)
  const result = await processBatch(thor, unclaimed, clauseBuilder, walletAddress, privateKey, batchSize, dryRun, log)

  return {
    phase: "citizen-claim",
    roundId: previousRoundId,
    totalUsers: validatedMap.size,
    successful: result.successful,
    failed: result.failed,
    transient: result.transient,
    txIds: result.txIds,
    dryRun,
  }
}
