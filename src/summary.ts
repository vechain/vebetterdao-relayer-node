import { ThorClient } from "@vechain/sdk-network"
import { NetworkConfig, RelayerSummary } from "./types"
import { fetchReport, type ReportCache } from "./report"
import { getBlockTimestamp } from "./block-timestamps"
import {
  getCurrentRoundId,
  getRoundSnapshot,
  getRoundDeadline,
  isRoundActive,
  getTotalVoters,
  getTotalVotes,
  getRegisteredRelayers,
  isRegisteredRelayer,
  getVoteWeight,
  getClaimWeight,
  getRelayerFeePercentage,
  getRelayerFeeDenominator,
  getFeeCap,
  getEarlyAccessBlocks,
  getTotalRewards,
  getClaimableRewards,
  getTotalActions,
  getCompletedWeightedActions,
  getTotalWeightedActions,
  getRelayerActions,
  getRelayerWeightedActions,
  isRewardClaimable,
  getAutoVotingUsers,
  getAlreadySkippedVotersForRound,
  getVotedUsersForRound,
  getAlreadyClaimedForRound,
  estimateRewardPoolForRound,
} from "./contracts"

function splitActions(
  totalActions: bigint,
  weightedActions: bigint,
): { votes: number; claims: number } {
  if (totalActions <= 0n || weightedActions <= 0n) return { votes: 0, claims: 0 }
  const votes =
    weightedActions >= totalActions ? (weightedActions - totalActions) / 2n : 0n
  const claims = totalActions >= votes ? totalActions - votes : 0n
  return {
    votes: Number(votes),
    claims: Number(claims),
  }
}

export async function fetchSummary(
  thor: ThorClient,
  config: NetworkConfig,
  relayerAddress: string,
  reportCache?: ReportCache | null,
): Promise<RelayerSummary> {
  const xav = config.xAllocationVotingAddress
  const rrp = config.relayerRewardsPoolAddress

  const currentRoundId = await getCurrentRoundId(thor, xav)
  const previousRoundId = currentRoundId > 1 ? currentRoundId - 1 : 0

  const best = await thor.blocks.getBestBlockCompressed()
  const latestBlock = best?.number ?? 0

  const [
    roundSnapshot,
    roundDeadline,
    active,
    totalVoters,
    totalVotes,
    registeredRelayers,
    isReg,
    voteWeight,
    claimWeight,
    feePercentage,
    feeDenominator,
    feeCap,
    earlyAccessBlocks,
    currentTotalRewards,
    currentRelayerClaimable,
    currentTotalActions,
    currentCompletedWeighted,
    currentTotalWeighted,
    currentRelayerActions,
    currentRelayerWeighted,
    previousRoundSnapshot,
    previousRoundDeadline,
    previousCompletedWeighted,
    previousRelayerWeighted,
    previousTotalRewards,
    previousRelayerClaimable,
    previousRewardClaimable,
    previousRelayerActions,
  ] = await Promise.all([
    getRoundSnapshot(thor, xav, currentRoundId),
    getRoundDeadline(thor, xav, currentRoundId),
    isRoundActive(thor, xav, currentRoundId),
    getTotalVoters(thor, xav, currentRoundId),
    getTotalVotes(thor, xav, currentRoundId),
    getRegisteredRelayers(thor, rrp),
    isRegisteredRelayer(thor, rrp, relayerAddress),
    getVoteWeight(thor, rrp),
    getClaimWeight(thor, rrp),
    getRelayerFeePercentage(thor, rrp),
    getRelayerFeeDenominator(thor, rrp),
    getFeeCap(thor, rrp),
    getEarlyAccessBlocks(thor, rrp),
    getTotalRewards(thor, rrp, currentRoundId),
    getClaimableRewards(thor, rrp, relayerAddress, currentRoundId),
    getTotalActions(thor, rrp, currentRoundId),
    getCompletedWeightedActions(thor, rrp, currentRoundId),
    getTotalWeightedActions(thor, rrp, currentRoundId),
    getRelayerActions(thor, rrp, relayerAddress, currentRoundId),
    getRelayerWeightedActions(thor, rrp, relayerAddress, currentRoundId),
    previousRoundId > 0 ? getRoundSnapshot(thor, xav, previousRoundId) : Promise.resolve(0),
    previousRoundId > 0 ? getRoundDeadline(thor, xav, previousRoundId) : Promise.resolve(0),
    previousRoundId > 0
      ? getCompletedWeightedActions(thor, rrp, previousRoundId)
      : Promise.resolve(0n),
    previousRoundId > 0
      ? getRelayerWeightedActions(thor, rrp, relayerAddress, previousRoundId)
      : Promise.resolve(0n),
    previousRoundId > 0 ? getTotalRewards(thor, rrp, previousRoundId) : Promise.resolve(0n),
    previousRoundId > 0
      ? getClaimableRewards(thor, rrp, relayerAddress, previousRoundId)
      : Promise.resolve(0n),
    previousRoundId > 0 ? isRewardClaimable(thor, rrp, previousRoundId) : Promise.resolve(false),
    previousRoundId > 0
      ? getRelayerActions(thor, rrp, relayerAddress, previousRoundId)
      : Promise.resolve(0n),
  ])

  const [currentAutoVotingUsers, previousAutoVotingUsers] = await Promise.all([
    getAutoVotingUsers(thor, xav, roundSnapshot),
    previousRoundId > 0
      ? getAutoVotingUsers(thor, xav, previousRoundSnapshot)
      : Promise.resolve([]),
  ])

  const [
    currentSkippedUsers,
    currentVotedUsers,
    previousSkippedUsers,
    previousVotedUsers,
    previousClaimedUsers,
    roundSnapshotTimestamp,
    roundDeadlineTimestamp,
    report,
  ] = await Promise.all([
    getAlreadySkippedVotersForRound(thor, xav, currentRoundId, roundSnapshot, latestBlock),
    getVotedUsersForRound(thor, xav, currentRoundId, currentAutoVotingUsers),
    previousRoundId > 0
      ? getAlreadySkippedVotersForRound(
          thor,
          xav,
          previousRoundId,
          previousRoundSnapshot,
          previousRoundDeadline,
        )
      : Promise.resolve(new Set<string>()),
    previousRoundId > 0
      ? getVotedUsersForRound(thor, xav, previousRoundId, previousAutoVotingUsers)
      : Promise.resolve(new Set<string>()),
    previousRoundId > 0
      ? getAlreadyClaimedForRound(
          thor,
          config.voterRewardsAddress,
          previousRoundId,
          previousRoundDeadline,
          latestBlock,
        )
      : Promise.resolve(new Set<string>()),
    getBlockTimestamp(config.nodeUrl, roundSnapshot),
    getBlockTimestamp(config.nodeUrl, roundDeadline),
    fetchReport(config, reportCache ?? undefined),
  ])

  const currentSkippedCount = currentAutoVotingUsers.reduce((count, user) => {
    return count + (currentSkippedUsers.has(user.toLowerCase()) ? 1 : 0)
  }, 0)
  const previousSkippedCount = previousAutoVotingUsers.reduce((count, user) => {
    return count + (previousSkippedUsers.has(user.toLowerCase()) ? 1 : 0)
  }, 0)
  const previousClaimedCount = [...previousVotedUsers].reduce((count, user) => {
    return count + (previousClaimedUsers.has(user) ? 1 : 0)
  }, 0)
  const currentEstimatedPool = await estimateRewardPoolForRound(
    thor,
    config.voterRewardsAddress,
    currentRoundId,
    currentVotedUsers,
  )
  const currentEstimatedRewards =
    currentCompletedWeighted > 0n && currentRelayerWeighted > 0n
      ? (currentEstimatedPool * currentRelayerWeighted) / currentCompletedWeighted
      : 0n
  const currentActionSplit = splitActions(currentRelayerActions, currentRelayerWeighted)
  const previousActionSplit = splitActions(previousRelayerActions, previousRelayerWeighted)
  const currentEarlyAccessEndBlock = roundSnapshot + Number(earlyAccessBlocks)
  const currentEarlyAccessRemainingBlocks = Math.max(
    0,
    currentEarlyAccessEndBlock - latestBlock,
  )

  const reportRounds = report?.rounds ?? []
  const reportRelayers = report?.relayers ?? []
  const relayerReport =
    reportRelayers.find(
      (entry) => entry.address.toLowerCase() === relayerAddress.toLowerCase(),
    ) ?? null
  const previousRoundReport = reportRounds.find(
    (entry) => entry.roundId === previousRoundId,
  ) ?? null
  const currentRelayerRoundReport =
    relayerReport?.rounds.find((entry) => entry.roundId === currentRoundId) ?? null
  const previousRelayerRoundReport =
    relayerReport?.rounds.find((entry) => entry.roundId === previousRoundId) ?? null

  const totalWeightedByRound = new Map<number, number>()
  if (report) {
    for (const relayer of reportRelayers) {
      for (const round of relayer.rounds) {
        totalWeightedByRound.set(
          round.roundId,
          (totalWeightedByRound.get(round.roundId) ?? 0) + round.weightedActions,
        )
      }
    }
  }

  let relayerLifetimeEarned = 0n
  let relayerLifetimeSpent = 0n
  let relayerAvailableToClaim = 0n
  let relayerLifetimeVotes = 0
  let relayerLifetimeClaims = 0

  if (relayerReport) {
    const roundById = new Map(reportRounds.map((round) => [round.roundId, round]))
    for (const round of relayerReport.rounds) {
      const roundMeta = roundById.get(round.roundId)
      const totalWeighted = totalWeightedByRound.get(round.roundId) ?? 0
      const totalRewardsRaw = roundMeta ? BigInt(roundMeta.totalRelayerRewardsRaw) : 0n
      if (totalWeighted > 0 && round.weightedActions > 0) {
        relayerLifetimeEarned +=
          (totalRewardsRaw * BigInt(round.weightedActions)) / BigInt(totalWeighted)
      } else {
        relayerLifetimeEarned += BigInt(round.claimableRewardsRaw)
      }
      relayerLifetimeSpent +=
        BigInt(round.vthoSpentOnVotingRaw) + BigInt(round.vthoSpentOnClaimingRaw)
      relayerAvailableToClaim += BigInt(round.claimableRewardsRaw)
      relayerLifetimeVotes += round.votedForCount
      relayerLifetimeClaims += round.rewardsClaimedCount
    }
  }
  const currentSpent = currentRelayerRoundReport
    ? BigInt(currentRelayerRoundReport.vthoSpentOnVotingRaw) +
      BigInt(currentRelayerRoundReport.vthoSpentOnClaimingRaw)
    : 0n
  const previousSpent = previousRelayerRoundReport
    ? BigInt(previousRelayerRoundReport.vthoSpentOnVotingRaw) +
      BigInt(previousRelayerRoundReport.vthoSpentOnClaimingRaw)
    : 0n

  return {
    network: config.name,
    nodeUrl: config.nodeUrl,
    relayerAddress,
    isRegistered: isReg,
    registeredRelayers,
    reportGeneratedAt: report?.generatedAt ?? null,
    currentRoundId,
    roundSnapshot,
    roundSnapshotTimestamp,
    roundDeadline,
    roundDeadlineTimestamp,
    isRoundActive: active,
    latestBlock,
    currentEarlyAccessEndBlock,
    currentEarlyAccessRemainingBlocks,
    autoVotingUsers: currentAutoVotingUsers.length,
    totalVoters,
    totalVotes,
    voteWeight,
    claimWeight,
    feePercentage,
    feeDenominator,
    feeCap,
    earlyAccessBlocks,
    currentEligibleVoters: Math.max(0, currentAutoVotingUsers.length - currentSkippedCount),
    currentVotedCount: currentVotedUsers.size,
    currentTotalRewards,
    currentEstimatedPool,
    currentEstimatedRewards,
    currentRelayerClaimable,
    currentTotalActions,
    currentCompletedWeighted,
    currentTotalWeighted,
    currentRelayerActions,
    currentRelayerWeighted,
    currentVotesPerformed: currentActionSplit.votes,
    currentClaimsPerformed: currentActionSplit.claims,
    currentSpent,
    relayerLifetimeEarned,
    relayerLifetimeSpent,
    relayerAvailableToClaim,
    relayerLifetimeVotes,
    relayerLifetimeClaims,
    previousRoundId,
    previousRoundDeadline,
    previousEligibleVoters: Math.max(
      0,
      previousAutoVotingUsers.length - previousSkippedCount,
    ),
    previousVotedCount: previousVotedUsers.size,
    previousEligibleClaims: previousVotedUsers.size,
    previousClaimedCount,
    previousTotalRewards,
    previousRelayerClaimable,
    previousRelayerClaimed: previousRelayerRoundReport
      ? BigInt(previousRelayerRoundReport.relayerRewardsClaimedRaw)
      : 0n,
    previousRewardClaimable,
    previousRelayerActions,
    previousRelayerWeighted,
    previousCompletedWeighted,
    previousVotesPerformed: previousActionSplit.votes,
    previousClaimsPerformed: previousActionSplit.claims,
    previousSpent,
  }
}
