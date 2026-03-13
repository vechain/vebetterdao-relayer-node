import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Hex } from "@vechain/sdk-core"
import {
  XAllocationVoting__factory,
  VoterRewards__factory,
  RelayerRewardsPool__factory,
} from "@vechain/vebetterdao-contracts/typechain-types"
import { NetworkConfig, RelayerSummary } from "./types"

const xavAbi = ABIContract.ofAbi(XAllocationVoting__factory.abi)
const rrpAbi = ABIContract.ofAbi(RelayerRewardsPool__factory.abi)
const vrAbi = ABIContract.ofAbi(VoterRewards__factory.abi)

const CALL_RETRIES = 3
const CALL_RETRY_MS = 500
const STATUS_CHECK_BATCH = 50
const STATUS_CHECK_DELAY_MS = 0
const REPORT_CACHE_MS = 5 * 60 * 1000
const DEFAULT_MAINNET_REPORT_URL = "https://relayers.vebetterdao.org/data/report.json"

interface ReportRoundAnalytics {
  roundId: number
  autoVotingUsersCount: number
  votedForCount: number
  rewardsClaimedCount: number
  totalRelayerRewardsRaw: string
  estimatedRelayerRewardsRaw: string
  reducedUsersCount: number
}

interface ReportRelayerRoundBreakdown {
  roundId: number
  votedForCount: number
  rewardsClaimedCount: number
  weightedActions: number
  actions: number
  claimableRewardsRaw: string
  relayerRewardsClaimedRaw: string
  vthoSpentOnVotingRaw: string
  vthoSpentOnClaimingRaw: string
}

interface ReportRelayerAnalytics {
  address: string
  rounds: ReportRelayerRoundBreakdown[]
}

interface ReportData {
  generatedAt: string
  network: string
  currentRound: number
  rounds: ReportRoundAnalytics[]
  relayers: ReportRelayerAnalytics[]
}

const reportCache: {
  fetchedAt: number
  source: string | null
  data: ReportData | null
} = {
  fetchedAt: 0,
  source: null,
  data: null,
}

const blockTimestampCache = new Map<string, number | null>()

async function call(thor: ThorClient, address: string, abi: any, method: string, args: any[] = []): Promise<any[]> {
  for (let attempt = 1; attempt <= CALL_RETRIES; attempt++) {
    try {
      const res = await thor.contracts.executeCall(address, abi.getFunction(method), args)
      if (!res.success) {
        throw new Error(`Call ${method} reverted: ${res.result?.errorMessage || "unknown"}`)
      }
      return res.result?.array ?? []
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isRevert = msg.includes("reverted")
      if (isRevert || attempt === CALL_RETRIES) throw err
      await new Promise((r) => setTimeout(r, CALL_RETRY_MS * attempt))
    }
  }
  throw new Error("Unreachable")
}

// ── XAllocationVoting reads ─────────────────────────────────

export async function getCurrentRoundId(thor: ThorClient, addr: string): Promise<number> {
  const r = await call(thor, addr, xavAbi, "currentRoundId")
  return Number(r[0])
}

export async function getRoundSnapshot(thor: ThorClient, addr: string, roundId: number): Promise<number> {
  const r = await call(thor, addr, xavAbi, "roundSnapshot", [roundId])
  return Number(r[0])
}

export async function getRoundDeadline(thor: ThorClient, addr: string, roundId: number): Promise<number> {
  const r = await call(thor, addr, xavAbi, "roundDeadline", [roundId])
  return Number(r[0])
}

export async function isRoundActive(thor: ThorClient, addr: string, roundId: number): Promise<boolean> {
  const r = await call(thor, addr, xavAbi, "isActive", [roundId])
  return Boolean(r[0])
}

export async function getTotalAutoVotingUsersAtRoundStart(thor: ThorClient, addr: string): Promise<number> {
  const r = await call(thor, addr, xavAbi, "getTotalAutoVotingUsersAtRoundStart")
  return Number(r[0])
}

export async function getTotalVoters(thor: ThorClient, addr: string, roundId: number): Promise<number> {
  const r = await call(thor, addr, xavAbi, "totalVoters", [roundId])
  return Number(r[0])
}

export async function getTotalVotes(thor: ThorClient, addr: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, xavAbi, "totalVotes", [roundId])
  return BigInt(r[0])
}

export async function hasVoted(thor: ThorClient, addr: string, roundId: number, user: string): Promise<boolean> {
  const r = await call(thor, addr, xavAbi, "hasVoted", [roundId, user])
  return Boolean(r[0])
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function splitActions(totalActions: bigint, weightedActions: bigint): { votes: number; claims: number } {
  if (totalActions <= 0n || weightedActions <= 0n) return { votes: 0, claims: 0 }
  const votes = weightedActions >= totalActions ? (weightedActions - totalActions) / 2n : 0n
  const claims = totalActions >= votes ? totalActions - votes : 0n
  return {
    votes: Number(votes),
    claims: Number(claims),
  }
}

function getReportSource(config: NetworkConfig): string | null {
  const explicitPath = process.env.RELAYER_REPORT_PATH?.trim()
  if (explicitPath) return explicitPath

  const explicitUrl = process.env.RELAYER_REPORT_URL?.trim()
  if (explicitUrl) return explicitUrl

  if (config.name === "mainnet") return DEFAULT_MAINNET_REPORT_URL
  return null
}

async function fetchReport(config: NetworkConfig): Promise<ReportData | null> {
  const source = getReportSource(config)
  if (!source) return null

  if (
    reportCache.source === source
    && reportCache.fetchedAt > 0
    && Date.now() - reportCache.fetchedAt < REPORT_CACHE_MS
  ) {
    return reportCache.data
  }

  try {
    let data: ReportData

    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source, { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = await res.json() as ReportData
    } else {
      const fs = require("fs") as typeof import("fs")
      data = JSON.parse(fs.readFileSync(source, "utf-8")) as ReportData
    }

    reportCache.source = source
    reportCache.data = data
    reportCache.fetchedAt = Date.now()
    return data
  } catch {
    reportCache.source = source
    reportCache.data = null
    reportCache.fetchedAt = Date.now()
    return null
  }
}

async function getBlockTimestamp(nodeUrl: string, blockNumber: number): Promise<number | null> {
  if (blockNumber <= 0) return null

  const cacheKey = `${nodeUrl}:${blockNumber}`
  if (blockTimestampCache.has(cacheKey)) {
    return blockTimestampCache.get(cacheKey) ?? null
  }

  try {
    const res = await fetch(`${nodeUrl.replace(/\/$/, "")}/blocks/${blockNumber}`, { cache: "no-store" })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { timestamp?: number }
    const timestamp = typeof data.timestamp === "number" ? data.timestamp : null
    blockTimestampCache.set(cacheKey, timestamp)
    return timestamp
  } catch {
    blockTimestampCache.set(cacheKey, null)
    return null
  }
}

export async function getVotedUsersForRound(
  thor: ThorClient,
  contractAddress: string,
  roundId: number,
  users: string[],
): Promise<Set<string>> {
  const voted = new Set<string>()

  for (let i = 0; i < users.length; i += STATUS_CHECK_BATCH) {
    const chunk = users.slice(i, i + STATUS_CHECK_BATCH)
    const checks = await Promise.all(chunk.map((user) => hasVoted(thor, contractAddress, roundId, user)))

    for (let j = 0; j < chunk.length; j++) {
      if (checks[j]) {
        voted.add(chunk[j].toLowerCase())
      }
    }

    if (STATUS_CHECK_DELAY_MS > 0 && i + STATUS_CHECK_BATCH < users.length) {
      await delay(STATUS_CHECK_DELAY_MS)
    }
  }

  return voted
}

// ── RelayerRewardsPool reads ────────────────────────────────

export async function getRegisteredRelayers(thor: ThorClient, addr: string): Promise<string[]> {
  const r = await call(thor, addr, rrpAbi, "getRegisteredRelayers")
  return r[0] as string[]
}

export async function isRegisteredRelayer(thor: ThorClient, addr: string, relayer: string): Promise<boolean> {
  const r = await call(thor, addr, rrpAbi, "isRegisteredRelayer", [relayer])
  return Boolean(r[0])
}

export async function getTotalRewards(thor: ThorClient, addr: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getTotalRewards", [roundId])
  return BigInt(r[0])
}

export async function getClaimableRewards(thor: ThorClient, addr: string, relayer: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "claimableRewards", [relayer, roundId])
  return BigInt(r[0])
}

export async function getRelayerFee(thor: ThorClient, addr: string, roundId: number, user: string): Promise<bigint> {
  const r = await call(thor, addr, vrAbi, "getRelayerFee", [roundId, user])
  return BigInt(r[0] ?? 0)
}

export async function isRewardClaimable(thor: ThorClient, addr: string, roundId: number): Promise<boolean> {
  const r = await call(thor, addr, rrpAbi, "isRewardClaimable", [roundId])
  return Boolean(r[0])
}

export async function getTotalActions(thor: ThorClient, addr: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "totalActions", [roundId])
  return BigInt(r[0])
}

export async function getCompletedWeightedActions(thor: ThorClient, addr: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "completedWeightedActions", [roundId])
  return BigInt(r[0])
}

export async function getTotalWeightedActions(thor: ThorClient, addr: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "totalWeightedActions", [roundId])
  return BigInt(r[0])
}

export async function getMissedAutoVotingUsersCount(thor: ThorClient, addr: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getMissedAutoVotingUsersCount", [roundId])
  return BigInt(r[0])
}

export async function getVoteWeight(thor: ThorClient, addr: string): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getVoteWeight")
  return BigInt(r[0])
}

export async function getClaimWeight(thor: ThorClient, addr: string): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getClaimWeight")
  return BigInt(r[0])
}

export async function getRelayerFeePercentage(thor: ThorClient, addr: string): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getRelayerFeePercentage")
  return BigInt(r[0])
}

export async function getRelayerFeeDenominator(thor: ThorClient, addr: string): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getRelayerFeeDenominator")
  return BigInt(r[0])
}

export async function getFeeCap(thor: ThorClient, addr: string): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getFeeCap")
  return BigInt(r[0])
}

export async function getEarlyAccessBlocks(thor: ThorClient, addr: string): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "getEarlyAccessBlocks")
  return BigInt(r[0])
}

export async function getRelayerActions(thor: ThorClient, addr: string, relayer: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "totalRelayerActions", [relayer, roundId])
  return BigInt(r[0])
}

export async function getRelayerWeightedActions(thor: ThorClient, addr: string, relayer: string, roundId: number): Promise<bigint> {
  const r = await call(thor, addr, rrpAbi, "totalRelayerWeightedActions", [relayer, roundId])
  return BigInt(r[0])
}

async function estimateRewardPoolForRound(
  thor: ThorClient,
  voterRewardsAddress: string,
  roundId: number,
  votedUsers: Set<string>,
): Promise<bigint> {
  if (votedUsers.size === 0) return 0n

  let totalEstimatedFees = 0n
  const users = [...votedUsers]

  for (let i = 0; i < users.length; i += STATUS_CHECK_BATCH) {
    const chunk = users.slice(i, i + STATUS_CHECK_BATCH)
    const fees = await Promise.all(chunk.map((user) => getRelayerFee(thor, voterRewardsAddress, roundId, user)))
    for (const fee of fees) {
      totalEstimatedFees += fee
    }
  }

  return totalEstimatedFees
}

// ── Event fetching: auto-voting users ───────────────────────

const MAX_EVENTS = 1000

function getCachePath(): string {
  // Lazy require to keep this module browser-bundleable
  const p = require("path") as typeof import("path")
  return p.join(process.cwd(), ".auto-voting-cache.json")
}

interface AutoVotingCacheData {
  lastBlock: number
  users: Record<string, boolean>
}

const autoVotingCache = {
  userState: new Map<string, boolean>(),
  lastBlock: -1,
  loaded: false,
}

function loadCacheFromDisk(): void {
  if (autoVotingCache.loaded) return
  autoVotingCache.loaded = true
  try {
    const fs = require("fs") as typeof import("fs")
    const raw = fs.readFileSync(getCachePath(), "utf-8")
    const data: AutoVotingCacheData = JSON.parse(raw)
    if (typeof data.lastBlock === "number" && data.users) {
      for (const [addr, enabled] of Object.entries(data.users)) {
        autoVotingCache.userState.set(addr, enabled)
      }
      autoVotingCache.lastBlock = data.lastBlock
    }
  } catch {
    // No cache file or corrupted — start fresh
  }
}

function saveCacheToDisk(): void {
  const data: AutoVotingCacheData = {
    lastBlock: autoVotingCache.lastBlock,
    users: Object.fromEntries(autoVotingCache.userState),
  }
  try {
    const fs = require("fs") as typeof import("fs")
    fs.writeFileSync(getCachePath(), JSON.stringify(data), "utf-8")
  } catch {
    // Non-critical — next run will just re-fetch the delta
  }
}

export async function getAutoVotingUsers(
  thor: ThorClient,
  contractAddress: string,
  toBlock: number,
): Promise<string[]> {
  loadCacheFromDisk()

  const event = xavAbi.getEvent("AutoVotingToggled") as any
  const topics = event.encodeFilterTopicsNoNull({})

  if (toBlock < autoVotingCache.lastBlock) {
    autoVotingCache.userState.clear()
    autoVotingCache.lastBlock = -1
  }

  const fromBlock = autoVotingCache.lastBlock >= 0 ? autoVotingCache.lastBlock + 1 : 0

  if (fromBlock <= toBlock) {
    let offset = 0
    while (true) {
      const logs = await thor.logs.filterEventLogs({
        range: { unit: "block" as const, from: fromBlock, to: toBlock },
        options: { offset, limit: MAX_EVENTS },
        order: "asc",
        criteriaSet: [{ criteria: { address: contractAddress, topic0: topics[0] }, eventAbi: event }],
      })
      for (const log of logs) {
        const decoded = event.decodeEventLog({
          topics: log.topics.map((t: string) => Hex.of(t)),
          data: Hex.of(log.data),
        })
        autoVotingCache.userState.set(decoded.args.account as string, decoded.args.enabled as boolean)
      }
      if (logs.length < MAX_EVENTS) break
      offset += MAX_EVENTS
    }
    autoVotingCache.lastBlock = toBlock
    saveCacheToDisk()
  }

  return [...autoVotingCache.userState.entries()].filter(([, on]) => on).map(([a]) => a)
}

/**
 * Returns the set of voter addresses that already emitted AutoVoteSkipped for the given round.
 * Used so the relayer does not retry castVoteOnBehalfOf for ineligible users (e.g. balance < 1 VOT3).
 */
export async function getAlreadySkippedVotersForRound(
  thor: ThorClient,
  contractAddress: string,
  roundId: number,
  fromBlock: number,
  toBlock: number,
): Promise<Set<string>> {
  const event = xavAbi.getEvent("AutoVoteSkipped") as any
  const topics = event.encodeFilterTopicsNoNull({})
  const skipped = new Set<string>()
  let offset = 0

  while (true) {
    const logs = await thor.logs.filterEventLogs({
      range: { unit: "block" as const, from: fromBlock, to: toBlock },
      options: { offset, limit: MAX_EVENTS },
      order: "asc",
      criteriaSet: [{ criteria: { address: contractAddress, topic0: topics[0] }, eventAbi: event }],
    })
    for (const log of logs) {
      const decoded = event.decodeEventLog({
        topics: log.topics.map((t: string) => Hex.of(t)),
        data: Hex.of(log.data),
      })
      if (Number(decoded.args.roundId) === roundId) {
        skipped.add((decoded.args.voter as string).toLowerCase())
      }
    }
    if (logs.length < MAX_EVENTS) break
    offset += MAX_EVENTS
  }

  return skipped
}

/**
 * Returns the set of voter addresses that already had RewardClaimedV2 emitted for the given round.
 * Used so the relayer does not retry claimReward for already-claimed users.
 */
export async function getAlreadyClaimedForRound(
  thor: ThorClient,
  contractAddress: string,
  roundId: number,
  fromBlock: number,
  toBlock: number,
): Promise<Set<string>> {
  const event = vrAbi.getEvent("RewardClaimedV2") as any
  const topics = event.encodeFilterTopicsNoNull({})
  const claimed = new Set<string>()
  let offset = 0

  while (true) {
    const logs = await thor.logs.filterEventLogs({
      range: { unit: "block" as const, from: fromBlock, to: toBlock },
      options: { offset, limit: MAX_EVENTS },
      order: "asc",
      criteriaSet: [{ criteria: { address: contractAddress, topic0: topics[0] }, eventAbi: event }],
    })
    for (const log of logs) {
      const decoded = event.decodeEventLog({
        topics: log.topics.map((t: string) => Hex.of(t)),
        data: Hex.of(log.data),
      })
      if (Number(decoded.args.cycle) === roundId) {
        claimed.add((decoded.args.voter as string).toLowerCase())
      }
    }
    if (logs.length < MAX_EVENTS) break
    offset += MAX_EVENTS
  }

  return claimed
}

// ── Full summary fetch ──────────────────────────────────────

export async function fetchSummary(
  thor: ThorClient,
  config: NetworkConfig,
  relayerAddress: string,
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
    previousRoundId > 0 ? getCompletedWeightedActions(thor, rrp, previousRoundId) : Promise.resolve(0n),
    previousRoundId > 0 ? getRelayerWeightedActions(thor, rrp, relayerAddress, previousRoundId) : Promise.resolve(0n),
    previousRoundId > 0 ? getTotalRewards(thor, rrp, previousRoundId) : Promise.resolve(0n),
    previousRoundId > 0 ? getClaimableRewards(thor, rrp, relayerAddress, previousRoundId) : Promise.resolve(0n),
    previousRoundId > 0 ? isRewardClaimable(thor, rrp, previousRoundId) : Promise.resolve(false),
    previousRoundId > 0 ? getRelayerActions(thor, rrp, relayerAddress, previousRoundId) : Promise.resolve(0n),
  ])

  const [currentAutoVotingUsers, previousAutoVotingUsers] = await Promise.all([
    getAutoVotingUsers(thor, xav, roundSnapshot),
    previousRoundId > 0 ? getAutoVotingUsers(thor, xav, previousRoundSnapshot) : Promise.resolve([]),
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
      ? getAlreadySkippedVotersForRound(thor, xav, previousRoundId, previousRoundSnapshot, previousRoundDeadline)
      : Promise.resolve(new Set<string>()),
    previousRoundId > 0
      ? getVotedUsersForRound(thor, xav, previousRoundId, previousAutoVotingUsers)
      : Promise.resolve(new Set<string>()),
    previousRoundId > 0
      ? getAlreadyClaimedForRound(thor, config.voterRewardsAddress, previousRoundId, previousRoundDeadline, latestBlock)
      : Promise.resolve(new Set<string>()),
    getBlockTimestamp(config.nodeUrl, roundSnapshot),
    getBlockTimestamp(config.nodeUrl, roundDeadline),
    fetchReport(config),
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
  const currentEstimatedRewards = currentCompletedWeighted > 0n && currentRelayerWeighted > 0n
    ? (currentEstimatedPool * currentRelayerWeighted) / currentCompletedWeighted
    : 0n
  const currentActionSplit = splitActions(currentRelayerActions, currentRelayerWeighted)
  const previousActionSplit = splitActions(previousRelayerActions, previousRelayerWeighted)
  const currentEarlyAccessEndBlock = roundSnapshot + Number(earlyAccessBlocks)
  const currentEarlyAccessRemainingBlocks = Math.max(0, currentEarlyAccessEndBlock - latestBlock)

  const reportRounds = report?.rounds ?? []
  const reportRelayers = report?.relayers ?? []
  const relayerReport = reportRelayers.find((entry) => entry.address.toLowerCase() === relayerAddress.toLowerCase()) ?? null
  const previousRoundReport = reportRounds.find((entry) => entry.roundId === previousRoundId) ?? null
  const currentRelayerRoundReport = relayerReport?.rounds.find((entry) => entry.roundId === currentRoundId) ?? null
  const previousRelayerRoundReport = relayerReport?.rounds.find((entry) => entry.roundId === previousRoundId) ?? null

  const totalWeightedByRound = new Map<number, number>()
  if (report) {
    for (const relayer of reportRelayers) {
      for (const round of relayer.rounds) {
        totalWeightedByRound.set(round.roundId, (totalWeightedByRound.get(round.roundId) ?? 0) + round.weightedActions)
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
        relayerLifetimeEarned += (totalRewardsRaw * BigInt(round.weightedActions)) / BigInt(totalWeighted)
      } else {
        relayerLifetimeEarned += BigInt(round.claimableRewardsRaw)
      }
      relayerLifetimeSpent += BigInt(round.vthoSpentOnVotingRaw) + BigInt(round.vthoSpentOnClaimingRaw)
      relayerAvailableToClaim += BigInt(round.claimableRewardsRaw)
      relayerLifetimeVotes += round.votedForCount
      relayerLifetimeClaims += round.rewardsClaimedCount
    }
  }
  const currentSpent = currentRelayerRoundReport
    ? BigInt(currentRelayerRoundReport.vthoSpentOnVotingRaw) + BigInt(currentRelayerRoundReport.vthoSpentOnClaimingRaw)
    : 0n
  const previousSpent = previousRelayerRoundReport
    ? BigInt(previousRelayerRoundReport.vthoSpentOnVotingRaw) + BigInt(previousRelayerRoundReport.vthoSpentOnClaimingRaw)
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
    previousEligibleVoters: Math.max(0, previousAutoVotingUsers.length - previousSkippedCount),
    previousVotedCount: previousVotedUsers.size,
    previousEligibleClaims: previousVotedUsers.size,
    previousClaimedCount,
    previousTotalRewards,
    previousRelayerClaimable,
    previousRelayerClaimed: previousRelayerRoundReport ? BigInt(previousRelayerRoundReport.relayerRewardsClaimedRaw) : 0n,
    previousRewardClaimable,
    previousRelayerActions,
    previousRelayerWeighted,
    previousCompletedWeighted,
    previousVotesPerformed: previousActionSplit.votes,
    previousClaimsPerformed: previousActionSplit.claims,
    previousSpent,
  }
}
