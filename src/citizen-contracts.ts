import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Hex } from "@vechain/sdk-core"
import { LogFn } from "./types"

// ── Inline ABI fragments (contracts package not yet published with these) ──

const GOVERNOR_ABI = [
  { type: "function", name: "getActiveProposals", inputs: [], outputs: [{ type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "hasVoted", inputs: [{ name: "proposalId", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "proposalDeadline", inputs: [{ name: "proposalId", type: "uint256" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
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

// ── B3TRGovernor reads ──────────────────────────────────────

export async function getActiveProposals(thor: ThorClient, addr: string): Promise<number[]> {
  const r = await call(thor, addr, govAbi, "getActiveProposals")
  const arr = r[0] as any[]
  return arr.map((id: any) => Number(id))
}

export async function hasVotedOnProposal(thor: ThorClient, addr: string, proposalId: number, citizen: string): Promise<boolean> {
  const r = await call(thor, addr, govAbi, "hasVoted", [proposalId, citizen])
  return Boolean(r[0])
}

export async function getProposalDeadline(thor: ThorClient, addr: string, proposalId: number): Promise<number> {
  const r = await call(thor, addr, govAbi, "proposalDeadline", [proposalId])
  return Number(r[0])
}

// ── NavigatorRegistry reads ─────────────────────────────────

export async function getNavigatorAtTimepoint(
  thor: ThorClient,
  addr: string,
  citizen: string,
  timepoint: number,
): Promise<string | undefined> {
  const r = await call(thor, addr, navAbi, "getNavigatorAtTimepoint", [citizen, timepoint])
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
  const r = await call(thor, addr, navAbi, "hasSetPreferences", [navigator, roundId])
  return Boolean(r[0])
}

export async function hasSetDecision(
  thor: ThorClient,
  addr: string,
  navigator: string,
  proposalId: number,
): Promise<boolean> {
  const r = await call(thor, addr, navAbi, "hasSetDecision", [navigator, proposalId])
  return Boolean(r[0])
}

export async function isNavigatorDeactivated(
  thor: ThorClient,
  addr: string,
  navigator: string,
): Promise<boolean> {
  const r = await call(thor, addr, navAbi, "isDeactivated", [navigator])
  return Boolean(r[0])
}

/**
 * Batch-validate which citizens are delegated to a navigator at a given snapshot.
 * Returns a Map of citizen → navigator address (lowercase).
 */
export async function getNavigatorsForCitizens(
  thor: ThorClient,
  navAddr: string,
  citizens: string[],
  snapshot: number,
  log?: LogFn,
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (citizens.length === 0) return result

  const fn = navAbi.getFunction("getNavigatorAtTimepoint")
  const BATCH = 100
  for (let i = 0; i < citizens.length; i += BATCH) {
    const chunk = citizens.slice(i, i + BATCH)
    const clauses = chunk.map((citizen) => ({
      to: navAddr,
      value: "0x0",
      data: fn.encodeData([citizen, snapshot]).toString(),
    }))

    const results = await thor.transactions.simulateTransaction(clauses)
    for (let j = 0; j < results.length; j++) {
      const sim = results[j]
      if (!sim || sim.reverted || !sim.data || sim.data === "0x") continue
      try {
        const decoded = fn.decodeOutputAsArray(Hex.of(sim.data))
        const addr = (decoded[0] as string).toLowerCase()
        if (addr !== ZERO_ADDRESS) {
          result.set(chunk[j].toLowerCase(), addr)
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log?.(`Warning: decode getNavigatorAtTimepoint for ${chunk[j].slice(0, 10)}...: ${reason}`)
      }
    }
  }

  return result
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
  const result = new Map<string, boolean>()
  if (navigators.length === 0) return result

  const fn = navAbi.getFunction("hasSetPreferences")
  const BATCH = 100
  for (let i = 0; i < navigators.length; i += BATCH) {
    const chunk = navigators.slice(i, i + BATCH)
    const clauses = chunk.map((nav) => ({
      to: navAddr,
      value: "0x0",
      data: fn.encodeData([nav, roundId]).toString(),
    }))

    const results = await thor.transactions.simulateTransaction(clauses)
    for (let j = 0; j < results.length; j++) {
      const sim = results[j]
      if (!sim || sim.reverted || !sim.data || sim.data === "0x") {
        result.set(chunk[j].toLowerCase(), false)
        continue
      }
      try {
        const decoded = fn.decodeOutputAsArray(Hex.of(sim.data))
        result.set(chunk[j].toLowerCase(), Boolean(decoded[0]))
      } catch {
        result.set(chunk[j].toLowerCase(), false)
      }
    }
  }
  return result
}

/**
 * Batch-check hasSetDecision for multiple navigators for a given proposal.
 */
export async function batchHasSetDecision(
  thor: ThorClient,
  navAddr: string,
  navigators: string[],
  proposalId: number,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>()
  if (navigators.length === 0) return result

  const fn = navAbi.getFunction("hasSetDecision")
  const BATCH = 100
  for (let i = 0; i < navigators.length; i += BATCH) {
    const chunk = navigators.slice(i, i + BATCH)
    const clauses = chunk.map((nav) => ({
      to: navAddr,
      value: "0x0",
      data: fn.encodeData([nav, proposalId]).toString(),
    }))

    const results = await thor.transactions.simulateTransaction(clauses)
    for (let j = 0; j < results.length; j++) {
      const sim = results[j]
      if (!sim || sim.reverted || !sim.data || sim.data === "0x") {
        result.set(chunk[j].toLowerCase(), false)
        continue
      }
      try {
        const decoded = fn.decodeOutputAsArray(Hex.of(sim.data))
        result.set(chunk[j].toLowerCase(), Boolean(decoded[0]))
      } catch {
        result.set(chunk[j].toLowerCase(), false)
      }
    }
  }
  return result
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
  proposalId: number,
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
      if (Number(decoded.args.proposalId) === proposalId) {
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
  } catch {
    // No cache file — start fresh
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
  } catch {
    // Non-critical
  }
}

/**
 * Build a citizen → navigator mapping from on-chain events.
 * Scans DelegationCreated, DelegationRemoved, ExitAnnounced, NavigatorDeactivatedEvent.
 * Uses disk cache for incremental scanning.
 */
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

  if (fromBlock <= toBlock) {
    // Scan delegation events
    const delegationCreated = navAbi.getEvent("DelegationCreated") as any
    const delegationRemoved = navAbi.getEvent("DelegationRemoved") as any
    const exitAnnounced = navAbi.getEvent("ExitAnnounced") as any
    const navigatorDeactivated = navAbi.getEvent("NavigatorDeactivatedEvent") as any

    const createdTopics = delegationCreated.encodeFilterTopicsNoNull({})
    const removedTopics = delegationRemoved.encodeFilterTopicsNoNull({})
    const exitTopics = exitAnnounced.encodeFilterTopicsNoNull({})
    const deactivatedTopics = navigatorDeactivated.encodeFilterTopicsNoNull({})

    // Scan DelegationCreated
    let offset = 0
    while (true) {
      const logs = await thor.logs.filterEventLogs({
        range: { unit: "block" as const, from: fromBlock, to: toBlock },
        options: { offset, limit: MAX_EVENTS },
        order: "asc",
        criteriaSet: [{ criteria: { address: navigatorRegistryAddress, topic0: createdTopics[0] }, eventAbi: delegationCreated }],
      })
      for (const log of logs) {
        const decoded = delegationCreated.decodeEventLog({
          topics: log.topics.map((t: string) => Hex.of(t)),
          data: Hex.of(log.data),
        })
        citizenCache.delegations.set(
          (decoded.args.citizen as string).toLowerCase(),
          (decoded.args.navigator as string).toLowerCase(),
        )
      }
      if (logs.length < MAX_EVENTS) break
      offset += MAX_EVENTS
    }

    // Scan DelegationRemoved
    offset = 0
    while (true) {
      const logs = await thor.logs.filterEventLogs({
        range: { unit: "block" as const, from: fromBlock, to: toBlock },
        options: { offset, limit: MAX_EVENTS },
        order: "asc",
        criteriaSet: [{ criteria: { address: navigatorRegistryAddress, topic0: removedTopics[0] }, eventAbi: delegationRemoved }],
      })
      for (const log of logs) {
        const decoded = delegationRemoved.decodeEventLog({
          topics: log.topics.map((t: string) => Hex.of(t)),
          data: Hex.of(log.data),
        })
        citizenCache.delegations.delete((decoded.args.citizen as string).toLowerCase())
      }
      if (logs.length < MAX_EVENTS) break
      offset += MAX_EVENTS
    }

    // Scan ExitAnnounced — bulk-remove all citizens under this navigator
    offset = 0
    while (true) {
      const logs = await thor.logs.filterEventLogs({
        range: { unit: "block" as const, from: fromBlock, to: toBlock },
        options: { offset, limit: MAX_EVENTS },
        order: "asc",
        criteriaSet: [{ criteria: { address: navigatorRegistryAddress, topic0: exitTopics[0] }, eventAbi: exitAnnounced }],
      })
      for (const log of logs) {
        const decoded = exitAnnounced.decodeEventLog({
          topics: log.topics.map((t: string) => Hex.of(t)),
          data: Hex.of(log.data),
        })
        const nav = (decoded.args.navigator as string).toLowerCase()
        for (const [citizen, citizenNav] of citizenCache.delegations) {
          if (citizenNav === nav) citizenCache.delegations.delete(citizen)
        }
      }
      if (logs.length < MAX_EVENTS) break
      offset += MAX_EVENTS
    }

    // Scan NavigatorDeactivatedEvent — bulk-remove all citizens under this navigator
    offset = 0
    while (true) {
      const logs = await thor.logs.filterEventLogs({
        range: { unit: "block" as const, from: fromBlock, to: toBlock },
        options: { offset, limit: MAX_EVENTS },
        order: "asc",
        criteriaSet: [{ criteria: { address: navigatorRegistryAddress, topic0: deactivatedTopics[0] }, eventAbi: navigatorDeactivated }],
      })
      for (const log of logs) {
        const decoded = navigatorDeactivated.decodeEventLog({
          topics: log.topics.map((t: string) => Hex.of(t)),
          data: Hex.of(log.data),
        })
        const nav = (decoded.args.navigator as string).toLowerCase()
        for (const [citizen, citizenNav] of citizenCache.delegations) {
          if (citizenNav === nav) citizenCache.delegations.delete(citizen)
        }
      }
      if (logs.length < MAX_EVENTS) break
      offset += MAX_EVENTS
    }

    citizenCache.lastBlock = toBlock
    saveCitizenCacheToDisk()
  }

  return new Map(citizenCache.delegations)
}
