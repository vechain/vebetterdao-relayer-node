import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Hex } from "@vechain/sdk-core"
import {
  XAllocationVoting__factory,
  VoterRewards__factory,
  RelayerRewardsPool__factory,
} from "@vechain/vebetterdao-contracts/typechain-types"

const xavAbi = ABIContract.ofAbi(XAllocationVoting__factory.abi)
const rrpAbi = ABIContract.ofAbi(RelayerRewardsPool__factory.abi)
const vrAbi = ABIContract.ofAbi(VoterRewards__factory.abi)

const CALL_RETRIES = 3
const CALL_RETRY_MS = 500
const STATUS_CHECK_BATCH = 50
const STATUS_CHECK_DELAY_MS = 0

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

export async function estimateRewardPoolForRound(
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
