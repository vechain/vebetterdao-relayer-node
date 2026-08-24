import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Hex } from "@vechain/sdk-core"
import { LogFn } from "./types"
import { simulateAllClauses } from "./simulate"

// ── Inline ABI fragments (contracts package not yet published with these) ──

const GOVERNOR_ABI = [
  { type: "function", name: "getActiveProposals", inputs: [], outputs: [{ type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "hasVoted", inputs: [{ name: "proposalId", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "proposalDeadline", inputs: [{ name: "proposalId", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "governanceSkipWindowBlocks", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "castNavigatorVote", inputs: [{ name: "proposalId", type: "uint256" }, { name: "citizen", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "nonpayable" },
] as const

const NAVIGATOR_REGISTRY_ABI = [
  { type: "function", name: "getNavigatorAtTimepoint", inputs: [{ name: "citizen", type: "address" }, { name: "timepoint", type: "uint256" }], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "hasSetPreferences", inputs: [{ name: "navigator", type: "address" }, { name: "roundId", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "hasSetDecision", inputs: [{ name: "navigator", type: "address" }, { name: "proposalId", type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isDeactivated", inputs: [{ name: "navigator", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "event", name: "DelegationCreated", inputs: [{ name: "citizen", type: "address", indexed: true }, { name: "navigator", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "DelegationRemoved", inputs: [{ name: "citizen", type: "address", indexed: true }, { name: "navigator", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "ExitAnnounced", inputs: [{ name: "navigator", type: "address", indexed: true }, { name: "announcedAtRound", type: "uint256", indexed: false }, { name: "effectiveDeadline", type: "uint256", indexed: false }] },
  { type: "event", name: "NavigatorDeactivatedEvent", inputs: [{ name: "navigator", type: "address", indexed: true }, { name: "slashPercentage", type: "uint256", indexed: false }] },
] as const

const XAV_NAVIGATOR_ABI = [
  { type: "function", name: "castNavigatorVote", inputs: [{ name: "citizen", type: "address" }, { name: "roundId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "citizenSkipWindowBlocks", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "event", name: "NavigatorVoteSkipped", inputs: [{ name: "citizen", type: "address", indexed: true }, { name: "navigator", type: "address", indexed: true }, { name: "roundId", type: "uint256", indexed: true }] },
] as const

const GOVERNOR_NAVIGATOR_ABI = [
  { type: "event", name: "NavigatorGovernanceVoteSkipped", inputs: [{ name: "citizen", type: "address", indexed: true }, { name: "navigator", type: "address", indexed: true }, { name: "proposalId", type: "uint256", indexed: true }] },
] as const

const govAbi = ABIContract.ofAbi(GOVERNOR_ABI as any)
const navAbi = ABIContract.ofAbi(NAVIGATOR_REGISTRY_ABI as any)
const xavNavAbi = ABIContract.ofAbi(XAV_NAVIGATOR_ABI as any)
const govNavAbi = ABIContract.ofAbi(GOVERNOR_NAVIGATOR_ABI as any)

export { govAbi, navAbi, xavNavAbi }

const CALL_RETRIES = 3
const CALL_RETRY_MS = 500
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
const MAX_EVENTS = 1000

/** Execute a read-only contract call with retry on transient failures (not on reverts). */
async function executeContractRead(thor: ThorClient, address: string, abi: any, method: string, args: any[] = []): Promise<any[]> {
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

// ── B3TRGovernor reads ──────────────────────────────────────

// Proposal IDs are uint256 hash-derived values; converting to JS Number loses
// precision. We carry them as 0x-prefixed 32-byte hex strings (bytes32 form),
// which the ABI encoder accepts directly for uint256 arguments via BigInt().
function toBytes32Hex(v: any): string {
  return "0x" + BigInt(v).toString(16).padStart(64, "0")
}

export function shortProposalId(id: string): string {
  return id.slice(0, 6) + "…" + id.slice(-4)
}

export async function getActiveProposals(thor: ThorClient, addr: string): Promise<string[]> {
  const r = await executeContractRead(thor, addr, govAbi, "getActiveProposals")
  const arr = r[0] as any[]
  return arr.map(toBytes32Hex)
}

export async function hasVotedOnProposal(thor: ThorClient, addr: string, proposalId: string, citizen: string): Promise<boolean> {
  const r = await executeContractRead(thor, addr, govAbi, "hasVoted", [proposalId, citizen])
  return Boolean(r[0])
}

export async function getProposalDeadline(thor: ThorClient, addr: string, proposalId: string): Promise<number> {
  const r = await executeContractRead(thor, addr, govAbi, "proposalDeadline", [proposalId])
  return Number(r[0])
}

export async function getGovernanceSkipWindowBlocks(thor: ThorClient, governorAddr: string): Promise<number> {
  const r = await executeContractRead(thor, governorAddr, govAbi, "governanceSkipWindowBlocks")
  return Number(r[0])
}

export async function getCitizenSkipWindowBlocks(thor: ThorClient, xavAddr: string): Promise<number> {
  const r = await executeContractRead(thor, xavAddr, xavNavAbi, "citizenSkipWindowBlocks")
  return Number(r[0])
}

// ── NavigatorRegistry reads ─────────────────────────────────

export async function getNavigatorAtTimepoint(
  thor: ThorClient,
  addr: string,
  citizen: string,
  timepoint: number,
): Promise<string | undefined> {
  const r = await executeContractRead(thor, addr, navAbi, "getNavigatorAtTimepoint", [citizen, timepoint])
  const nav = r[0] as string
  if (!nav || nav.toLowerCase() === ZERO_ADDRESS) return undefined
  return nav.toLowerCase()
}

export async function hasSetPreferences(
  thor: ThorClient,
  addr: string,
  navigator: string,
  roundId: number,
): Promise<boolean> {
  const r = await executeContractRead(thor, addr, navAbi, "hasSetPreferences", [navigator, roundId])
  return Boolean(r[0])
}

export async function hasSetDecision(
  thor: ThorClient,
  addr: string,
  navigator: string,
  proposalId: string,
): Promise<boolean> {
  const r = await executeContractRead(thor, addr, navAbi, "hasSetDecision", [navigator, proposalId])
  return Boolean(r[0])
}

export async function isNavigatorDeactivated(
  thor: ThorClient,
  addr: string,
  navigator: string,
): Promise<boolean> {
  const r = await executeContractRead(thor, addr, navAbi, "isDeactivated", [navigator])
  return Boolean(r[0])
}

/**
 * Generic batch-simulate: splits keys into chunks, builds clauses, simulates,
 * and decodes each result with the provided decoder.
 */
async function batchSimulate<T>(
  thor: ThorClient,
  contractAddr: string,
  fn: ReturnType<typeof navAbi.getFunction>,
  keys: string[],
  encodeArgs: (key: string) => any[],
  decode: (key: string, sim: { reverted: boolean; data: string }) => T | undefined,
): Promise<Map<string, T>> {
  const result = new Map<string, T>()
  if (keys.length === 0) return result

  const BATCH = 100
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH)
    const clauses = chunk.map((k) => ({
      to: contractAddr,
      value: "0x0",
      data: fn.encodeData(encodeArgs(k)).toString(),
    }))

    // Thor truncates a batch at the first reverting clause; simulateAllClauses
    // resumes past it so a single revert can't silently drop the rest of the chunk.
    const results = await simulateAllClauses(thor, clauses)
    for (let j = 0; j < chunk.length; j++) {
      const val = decode(chunk[j], results[j])
      if (val !== undefined) result.set(chunk[j].toLowerCase(), val)
    }
  }
  return result
}

function decodeBool(fnAbi: ReturnType<typeof navAbi.getFunction>, label: string) {
  return (key: string, sim: { reverted: boolean; data: string }): boolean => {
    if (!sim || sim.reverted || !sim.data || sim.data === "0x") return false
    try {
      return Boolean(fnAbi.decodeOutputAsArray(Hex.of(sim.data))[0])
    } catch (err) {
      console.error(`Warning: decode ${label} for ${key.slice(0, 10)}...: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
}

/**
 * Batch-validate which citizens are delegated to a navigator at a given snapshot.
 * Returns a Map of citizen -> navigator address (lowercase).
 */
export async function getNavigatorsForCitizens(
  thor: ThorClient,
  navAddr: string,
  citizens: string[],
  snapshot: number,
  log?: LogFn,
): Promise<Map<string, string>> {
  const fn = navAbi.getFunction("getNavigatorAtTimepoint")
  return batchSimulate(
    thor, navAddr, fn, citizens,
    (citizen) => [citizen, snapshot],
    (key, sim) => {
      if (!sim || sim.reverted || !sim.data || sim.data === "0x") return undefined
      try {
        const addr = (fn.decodeOutputAsArray(Hex.of(sim.data))[0] as string).toLowerCase()
        return addr !== ZERO_ADDRESS ? addr : undefined
      } catch (err) {
        log?.(`Warning: decode getNavigatorAtTimepoint for ${key.slice(0, 10)}...: ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
    },
  )
}

/**
 * Batch-check hasSetPreferences for multiple navigators in a single simulate call.
 */
export async function batchHasSetPreferences(
  thor: ThorClient,
  navAddr: string,
  navigators: string[],
  roundId: number,
): Promise<Map<string, boolean>> {
  const fn = navAbi.getFunction("hasSetPreferences")
  return batchSimulate(thor, navAddr, fn, navigators, (nav) => [nav, roundId], decodeBool(fn, "hasSetPreferences"))
}

/**
 * Batch-check hasSetDecision for multiple navigators for a given proposal.
 */
export async function batchHasSetDecision(
  thor: ThorClient,
  navAddr: string,
  navigators: string[],
  proposalId: string,
): Promise<Map<string, boolean>> {
  const fn = navAbi.getFunction("hasSetDecision")
  return batchSimulate(thor, navAddr, fn, navigators, (nav) => [nav, proposalId], decodeBool(fn, "hasSetDecision"))
}

// ── Skip event scanners ─────────────────────────────────────

/**
 * Returns citizens already skipped for allocation voting in a given round.
 * Scans NavigatorVoteSkipped(citizen, navigator, roundId) events on XAllocationVoting.
 */
export async function getAlreadySkippedCitizensForRound(
  thor: ThorClient,
  xavAddress: string,
  roundId: number,
  fromBlock: number,
  toBlock: number,
): Promise<Set<string>> {
  const event = xavNavAbi.getEvent("NavigatorVoteSkipped") as any
  const topics = event.encodeFilterTopicsNoNull({})
  const skipped = new Set<string>()
  let offset = 0

  while (true) {
    const logs = await thor.logs.filterEventLogs({
      range: { unit: "block" as const, from: fromBlock, to: toBlock },
      options: { offset, limit: MAX_EVENTS },
      order: "asc",
      criteriaSet: [{ criteria: { address: xavAddress, topic0: topics[0] }, eventAbi: event }],
    })
    for (const log of logs) {
      const decoded = event.decodeEventLog({
        topics: log.topics.map((t: string) => Hex.of(t)),
        data: Hex.of(log.data),
      })
      if (Number(decoded.args.roundId) === roundId) {
        skipped.add((decoded.args.citizen as string).toLowerCase())
      }
    }
    if (logs.length < MAX_EVENTS) break
    offset += MAX_EVENTS
  }

  return skipped
}

/**
 * Returns citizens already skipped for governance voting on a given proposal.
 * Scans NavigatorGovernanceVoteSkipped(citizen, navigator, proposalId) events on B3TRGovernor.
 */
export async function getAlreadySkippedCitizensForProposal(
  thor: ThorClient,
  governorAddress: string,
  proposalId: string,
  fromBlock: number,
  toBlock: number,
): Promise<Set<string>> {
  const event = govNavAbi.getEvent("NavigatorGovernanceVoteSkipped") as any
  const topics = event.encodeFilterTopicsNoNull({})
  const skipped = new Set<string>()
  let offset = 0

  while (true) {
    const logs = await thor.logs.filterEventLogs({
      range: { unit: "block" as const, from: fromBlock, to: toBlock },
      options: { offset, limit: MAX_EVENTS },
      order: "asc",
      criteriaSet: [{ criteria: { address: governorAddress, topic0: topics[0] }, eventAbi: event }],
    })
    for (const log of logs) {
      const decoded = event.decodeEventLog({
        topics: log.topics.map((t: string) => Hex.of(t)),
        data: Hex.of(log.data),
      })
      if (toBytes32Hex(decoded.args.proposalId) === proposalId) {
        skipped.add((decoded.args.citizen as string).toLowerCase())
      }
    }
    if (logs.length < MAX_EVENTS) break
    offset += MAX_EVENTS
  }

  return skipped
}

// ── Citizen delegation discovery ────────────────────────────

function getCitizenCachePath(): string {
  const p = require("path") as typeof import("path")
  return p.join(process.cwd(), ".citizen-delegation-cache.json")
}

interface CitizenCacheData {
  lastBlock: number
  delegations: Record<string, string>
}

// Intentional process-lifetime cache: this relayer is a single-instance CLI
// process, not a multi-tenant server. The cache accumulates delegation events
// across cycles so we only scan the delta since the last processed block.
// eslint-disable-next-line @typescript-eslint/no-namespace
const citizenCache = {
  delegations: new Map<string, string>(),
  lastBlock: -1,
  loaded: false,
}

function loadCitizenCacheFromDisk(): void {
  if (citizenCache.loaded) return
  citizenCache.loaded = true
  try {
    const fs = require("fs") as typeof import("fs")
    const raw = fs.readFileSync(getCitizenCachePath(), "utf-8")
    const data: CitizenCacheData = JSON.parse(raw)
    if (typeof data.lastBlock === "number" && data.delegations) {
      for (const [citizen, navigator] of Object.entries(data.delegations)) {
        citizenCache.delegations.set(citizen.toLowerCase(), navigator.toLowerCase())
      }
      citizenCache.lastBlock = data.lastBlock
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes("ENOENT")) console.error(`Warning: citizen cache load failed: ${msg}`)
  }
}

function saveCitizenCacheToDisk(): void {
  const data: CitizenCacheData = {
    lastBlock: citizenCache.lastBlock,
    delegations: Object.fromEntries(citizenCache.delegations),
  }
  try {
    const fs = require("fs") as typeof import("fs")
    fs.writeFileSync(getCitizenCachePath(), JSON.stringify(data), "utf-8")
  } catch (err) {
    console.error(`Warning: citizen cache save failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Build a citizen → navigator mapping from on-chain events.
 * Scans DelegationCreated, DelegationRemoved, ExitAnnounced, NavigatorDeactivatedEvent.
 * Uses disk cache for incremental scanning.
 */
interface TaggedEvent {
  type: 'created' | 'removed' | 'exit' | 'deactivated'
  blockNumber: number
  clauseIndex: number
  args: any
}

async function collectEventLogs(
  thor: ThorClient,
  address: string,
  eventAbi: any,
  fromBlock: number,
  toBlock: number,
  type: TaggedEvent['type'],
): Promise<TaggedEvent[]> {
  const topics = eventAbi.encodeFilterTopicsNoNull({})
  const events: TaggedEvent[] = []
  let offset = 0
  while (true) {
    const logs = await thor.logs.filterEventLogs({
      range: { unit: "block" as const, from: fromBlock, to: toBlock },
      options: { offset, limit: MAX_EVENTS },
      order: "asc",
      criteriaSet: [{ criteria: { address, topic0: topics[0] }, eventAbi }],
    })
    for (const log of logs) {
      const decoded = eventAbi.decodeEventLog({
        topics: log.topics.map((t: string) => Hex.of(t)),
        data: Hex.of(log.data),
      })
      events.push({
        type,
        blockNumber: (log as any).meta.blockNumber,
        clauseIndex: (log as any).meta.clauseIndex,
        args: decoded.args,
      })
    }
    if (logs.length < MAX_EVENTS) break
    offset += MAX_EVENTS
  }
  return events
}



export async function getDelegatedCitizens(
  thor: ThorClient,
  navigatorRegistryAddress: string,
  toBlock: number,
): Promise<Map<string, string>> {
  loadCitizenCacheFromDisk()

  if (toBlock < citizenCache.lastBlock) {
    citizenCache.delegations.clear()
    citizenCache.lastBlock = -1
  }

  const fromBlock = citizenCache.lastBlock >= 0 ? citizenCache.lastBlock + 1 : 0
  if (fromBlock > toBlock) return new Map(citizenCache.delegations)

  const addr = navigatorRegistryAddress
  const delegationCreated = navAbi.getEvent("DelegationCreated") as any
  const delegationRemoved = navAbi.getEvent("DelegationRemoved") as any
  const exitAnnounced = navAbi.getEvent("ExitAnnounced") as any
  const navigatorDeactivated = navAbi.getEvent("NavigatorDeactivatedEvent") as any

  // Fetch all event types then process in chronological order.
  // Previously events were processed by type (all Creates, then all Removes),
  // which broke when a citizen switched navigators: the Create set the new nav,
  // then the Remove deleted the citizen entirely.
  const [created, removed, exits, deactivated] = await Promise.all([
    collectEventLogs(thor, addr, delegationCreated, fromBlock, toBlock, 'created'),
    collectEventLogs(thor, addr, delegationRemoved, fromBlock, toBlock, 'removed'),
    collectEventLogs(thor, addr, exitAnnounced, fromBlock, toBlock, 'exit'),
    collectEventLogs(thor, addr, navigatorDeactivated, fromBlock, toBlock, 'deactivated'),
  ])

  const allEvents = [...created, ...removed, ...exits, ...deactivated]

  // Sort by block number, then clause index. For same block+clause (e.g. within
  // one transaction), process removals before creations to match EVM emit order.
  const TYPE_ORDER: Record<TaggedEvent['type'], number> = { deactivated: 0, exit: 1, removed: 2, created: 3 }
  allEvents.sort((a, b) =>
    a.blockNumber - b.blockNumber ||
    a.clauseIndex - b.clauseIndex ||
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type],
  )

  for (const event of allEvents) {
    switch (event.type) {
      case 'created':
        citizenCache.delegations.set(
          (event.args.citizen as string).toLowerCase(),
          (event.args.navigator as string).toLowerCase(),
        )
        break
      case 'removed':
        citizenCache.delegations.delete((event.args.citizen as string).toLowerCase())
        break
      case 'exit':
      case 'deactivated':
        // Deliberately a no-op for the delegation map.
        //
        // A navigator announcing exit is NOT dead: verified on mainnet round 110,
        // castNavigatorVote succeeded for citizens of a navigator with
        // isExiting=true / isDeactivated=false at every block of the round. Dropping
        // them here meant they were never voted for AND never skipped, so the round's
        // expected actions stayed unreachable and the whole pool locked.
        //
        // Even for a genuinely dead navigator the citizens must stay: castNavigatorVote
        // takes the skip path and calls reduceUserAllocationVote, which is what keeps
        // the round unlockable. Only a relayer calling the contract can do that.
        //
        // Citizens who really are no longer delegated are filtered out authoritatively
        // by getNavigatorsForCitizens(citizens, snapshot) before any clause is built,
        // so this map is a candidate superset, not the final work list.
        break
    }
  }

  citizenCache.lastBlock = toBlock
  saveCitizenCacheToDisk()
  return new Map(citizenCache.delegations)
}
