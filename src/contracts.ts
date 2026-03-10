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
    autoVotingUsers,
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
    currentMissedUsers,
    currentRelayerActions,
    currentRelayerWeighted,
    previousTotalRewards,
    previousRelayerClaimable,
    previousRewardClaimable,
    previousRelayerActions,
  ] = await Promise.all([
    getRoundSnapshot(thor, xav, currentRoundId),
    getRoundDeadline(thor, xav, currentRoundId),
    isRoundActive(thor, xav, currentRoundId),
    getTotalAutoVotingUsersAtRoundStart(thor, xav),
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
    getMissedAutoVotingUsersCount(thor, rrp, currentRoundId),
    getRelayerActions(thor, rrp, relayerAddress, currentRoundId),
    getRelayerWeightedActions(thor, rrp, relayerAddress, currentRoundId),
    previousRoundId > 0 ? getTotalRewards(thor, rrp, previousRoundId) : Promise.resolve(0n),
    previousRoundId > 0 ? getClaimableRewards(thor, rrp, relayerAddress, previousRoundId) : Promise.resolve(0n),
    previousRoundId > 0 ? isRewardClaimable(thor, rrp, previousRoundId) : Promise.resolve(false),
    previousRoundId > 0 ? getRelayerActions(thor, rrp, relayerAddress, previousRoundId) : Promise.resolve(0n),
  ])

  return {
    network: config.name,
    nodeUrl: config.nodeUrl,
    relayerAddress,
    isRegistered: isReg,
    registeredRelayers,
    currentRoundId,
    roundSnapshot,
    roundDeadline,
    isRoundActive: active,
    latestBlock,
    autoVotingUsers,
    totalVoters,
    totalVotes,
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
    currentMissedUsers,
    currentRelayerActions,
    currentRelayerWeighted,
    previousRoundId,
    previousTotalRewards,
    previousRelayerClaimable,
    previousRewardClaimable,
    previousRelayerActions,
  }
}
