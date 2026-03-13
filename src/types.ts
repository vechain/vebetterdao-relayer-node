export interface NetworkConfig {
  name: string
  nodeUrl: string
  xAllocationVotingAddress: string
  voterRewardsAddress: string
  relayerRewardsPoolAddress: string
  xAllocationPoolAddress: string
}

export interface RelayerSummary {
  network: string
  nodeUrl: string
  relayerAddress: string
  isRegistered: boolean
  registeredRelayers: string[]
  reportGeneratedAt: string | null

  currentRoundId: number
  roundSnapshot: number
  roundSnapshotTimestamp: number | null
  roundDeadline: number
  roundDeadlineTimestamp: number | null
  isRoundActive: boolean
  latestBlock: number
  currentEarlyAccessEndBlock: number
  currentEarlyAccessRemainingBlocks: number

  autoVotingUsers: number
  totalVoters: number
  totalVotes: bigint

  voteWeight: bigint
  claimWeight: bigint
  feePercentage: bigint
  feeDenominator: bigint
  feeCap: bigint
  earlyAccessBlocks: bigint

  // Current round progress
  currentEligibleVoters: number
  currentVotedCount: number

  // Current round relayer stats
  currentTotalRewards: bigint
  currentEstimatedPool: bigint
  currentEstimatedRewards: bigint
  currentRelayerClaimable: bigint
  currentTotalActions: bigint
  currentCompletedWeighted: bigint
  currentTotalWeighted: bigint
  currentRelayerActions: bigint
  currentRelayerWeighted: bigint
  currentVotesPerformed: number
  currentClaimsPerformed: number
  currentSpent: bigint
  relayerLifetimeEarned: bigint
  relayerLifetimeSpent: bigint
  relayerAvailableToClaim: bigint
  relayerLifetimeVotes: number
  relayerLifetimeClaims: number

  // Previous round
  previousRoundId: number
  previousRoundDeadline: number
  previousEligibleVoters: number
  previousVotedCount: number
  previousEligibleClaims: number
  previousClaimedCount: number
  previousTotalRewards: bigint
  previousRelayerClaimable: bigint
  previousRelayerClaimed: bigint
  previousRewardClaimable: boolean
  previousRelayerActions: bigint
  previousRelayerWeighted: bigint
  previousCompletedWeighted: bigint
  previousVotesPerformed: number
  previousClaimsPerformed: number
  previousSpent: bigint
}

export interface CycleResult {
  phase: "vote" | "claim"
  roundId: number
  totalUsers: number
  actionableUsers: number
  pendingUsers: number
  successful: number
  failed: { user: string; reason: string }[]
  transient: { user: string; reason: string }[]
  txIds: string[]
  dryRun: boolean
}

export type LogFn = (msg: string) => void
