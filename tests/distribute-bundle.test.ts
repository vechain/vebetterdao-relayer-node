import { describe, it, expect, beforeEach, vi } from "vitest"
import { addr, captureLogs, makeConfig } from "./helpers/builders"
import { createMockThor, type MockThor } from "./helpers/mockThor"

vi.mock("../src/contracts", async () => {
  const actual = await vi.importActual<typeof import("../src/contracts")>("../src/contracts")
  return {
    ...actual,
    getCurrentRoundId: vi.fn(),
    getRoundDeadline: vi.fn(),
    isRoundActive: vi.fn(),
    getAutoVotingUsers: vi.fn(),
    getAlreadySkippedVotersForRound: vi.fn(),
    getEarlyAccessBlocks: vi.fn(),
    getPreferredRelayersForUsers: vi.fn(),
  }
})

vi.mock("../src/citizen-contracts", async () => {
  const actual = await vi.importActual<typeof import("../src/citizen-contracts")>("../src/citizen-contracts")
  return {
    ...actual,
    getDelegatedCitizens: vi.fn(),
    getNavigatorsForCitizens: vi.fn(),
    batchHasSetPreferences: vi.fn(),
  }
})

import * as contracts from "../src/contracts"
import * as citizen from "../src/citizen-contracts"
import { runDistributeBundleCycle } from "../src/distribute-bundle"

const RELAYER = addr("11111")
const FAKE_PK = "1".repeat(64)

const ROUND = 100
const NEW_ROUND = ROUND + 1
const DEADLINE = 1_000_000
const LATEST_PAST_DEADLINE = 1_000_500

const NAV_A = addr("aaaa")
const NAV_B = addr("bbbb")
const C1 = addr(1), C2 = addr(2)
const A1 = addr("a1"), A2 = addr("a2")

describe("runDistributeBundleCycle", () => {
  let thor: MockThor
  const config = makeConfig({ emissionsAddress: addr("e1117710") })

  beforeEach(() => {
    thor = createMockThor({ latestBlock: LATEST_PAST_DEADLINE })

    vi.mocked(contracts.getCurrentRoundId).mockResolvedValue(ROUND)
    vi.mocked(contracts.getRoundDeadline).mockResolvedValue(DEADLINE)
    vi.mocked(contracts.isRoundActive).mockResolvedValue(false)
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([])
    vi.mocked(contracts.getAlreadySkippedVotersForRound).mockResolvedValue(new Set())
    vi.mocked(contracts.getEarlyAccessBlocks).mockResolvedValue(5_000n)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(new Map())

    vi.mocked(citizen.getDelegatedCitizens).mockResolvedValue(new Map())
    vi.mocked(citizen.getNavigatorsForCitizens).mockResolvedValue(new Map())
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(new Map())
  })

  it("noop when emissionsAddress is unset", async () => {
    const { log } = captureLogs()
    const noEmissions = makeConfig() // emissionsAddress undefined

    const r = await runDistributeBundleCycle(thor as any, noEmissions, RELAYER, FAKE_PK, true, log)

    expect(r.successful).toBe(0)
    expect(r.txIds).toEqual([])
    expect(thor.gas.estimateGas).not.toHaveBeenCalled()
  })

  it("noop when round is still active", async () => {
    const { log } = captureLogs()
    vi.mocked(contracts.isRoundActive).mockResolvedValue(true)

    const r = await runDistributeBundleCycle(thor as any, config, RELAYER, FAKE_PK, true, log)

    expect(r.successful).toBe(0)
    expect(thor.gas.estimateGas).not.toHaveBeenCalled()
  })

  it("noop when latest block is still before deadline", async () => {
    const { log } = captureLogs()
    thor = createMockThor({ latestBlock: DEADLINE - 100 })

    const r = await runDistributeBundleCycle(thor as any, config, RELAYER, FAKE_PK, true, log)

    expect(r.successful).toBe(0)
    expect(thor.gas.estimateGas).not.toHaveBeenCalled()
  })

  it("exits silently when distribute() simulation reverts (not yet ready)", async () => {
    const { log, lines } = captureLogs()
    thor.scriptGasEstimate([
      { totalGas: 0, reverted: true, revertReasons: ["Emissions: Next cycle not started yet"], vmErrors: [] },
    ])

    const r = await runDistributeBundleCycle(thor as any, config, RELAYER, FAKE_PK, true, log)

    expect(r.successful).toBe(0)
    expect(r.txIds).toEqual([])
    // No "Distribute window open" log, no fallback log — silent exit.
    expect(lines.some((l) => /Distribute window open/.test(l))).toBe(false)
  })

  it("happy path: distribute + auto-voters + ready citizens, all in one bundle", async () => {
    const { log, lines } = captureLogs()
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([A1, A2])
    // Two citizens; only NAV_A pre-set preferences for newRound.
    vi.mocked(citizen.getDelegatedCitizens).mockResolvedValue(new Map([[C1, NAV_A], [C2, NAV_B]]))
    vi.mocked(citizen.getNavigatorsForCitizens).mockResolvedValue(new Map([[C1, NAV_A], [C2, NAV_B]]))
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(
      new Map([
        [NAV_A, true],  // NAV_A ready → C1 included
        [NAV_B, false], // NAV_B not ready → C2 excluded (would revert)
      ]),
    )

    thor.scriptGasEstimate([
      { totalGas: 1_000_000, reverted: false, revertReasons: [], vmErrors: [] }, // distribute alone
      { totalGas: 5_000_000, reverted: false, revertReasons: [], vmErrors: [] }, // full bundle
    ])

    const r = await runDistributeBundleCycle(thor as any, config, RELAYER, FAKE_PK, true, log)

    expect(r.roundId).toBe(NEW_ROUND)
    expect(r.totalUsers).toBe(3) // 2 auto-voters + 1 citizen
    expect(r.successful).toBe(3)
    expect(lines.some((l) => /Distribute window open/.test(l))).toBe(true)
    expect(lines.some((l) => /1 citizens/.test(l))).toBe(true)
  })

  it("excludes citizens whose nav has not pre-set preferences (avoid bundle revert)", async () => {
    const { log } = captureLogs()
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([])
    vi.mocked(citizen.getDelegatedCitizens).mockResolvedValue(new Map([[C1, NAV_A]]))
    vi.mocked(citizen.getNavigatorsForCitizens).mockResolvedValue(new Map([[C1, NAV_A]]))
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(new Map([[NAV_A, false]]))

    thor.scriptGasEstimate([
      { totalGas: 1_000_000, reverted: false, revertReasons: [], vmErrors: [] }, // distribute alone
      { totalGas: 1_000_000, reverted: false, revertReasons: [], vmErrors: [] }, // bundle (just distribute)
    ])

    const r = await runDistributeBundleCycle(thor as any, config, RELAYER, FAKE_PK, true, log)

    expect(r.totalUsers).toBe(0) // no participants — only distribute() in the bundle
    expect(r.successful).toBe(0)
    expect(vi.mocked(citizen.batchHasSetPreferences)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      NEW_ROUND, // critical: prefs check is for the upcoming round, not the current
    )
  })

  it("falls back to distribute()-only when full-bundle simulation reverts", async () => {
    const { log, lines } = captureLogs()
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([A1, A2])

    thor.scriptGasEstimate([
      { totalGas: 1_000_000, reverted: false, revertReasons: [], vmErrors: [] }, // distribute alone OK
      { totalGas: 0, reverted: true, revertReasons: ["XAV: not in early access"], vmErrors: [] }, // full bundle reverts
    ])

    const r = await runDistributeBundleCycle(thor as any, config, RELAYER, FAKE_PK, true, log)

    expect(r.totalUsers).toBe(2) // 2 auto-voters were intended
    expect(r.successful).toBe(0) // …but bundle reverted, so we fell back to distribute()-only
    expect(r.txIds).toEqual(["DRY_RUN_BUNDLE"])
    expect(lines.some((l) => /falling back to distribute/.test(l))).toBe(true)
  })

  it("respects preferred-relayer filter for auto-voters in the bundle", async () => {
    const { log } = captureLogs()
    const otherRelayer = addr("99999")
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([A1, A2])
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(
      new Map([
        [A1.toLowerCase(), otherRelayer.toLowerCase()], // prefers other → drop
        [A2.toLowerCase(), RELAYER.toLowerCase()], // prefers us → keep
      ]),
    )

    thor.scriptGasEstimate([
      { totalGas: 1_000_000, reverted: false, revertReasons: [], vmErrors: [] },
      { totalGas: 2_000_000, reverted: false, revertReasons: [], vmErrors: [] },
    ])

    const r = await runDistributeBundleCycle(thor as any, config, RELAYER, FAKE_PK, true, log)

    expect(r.totalUsers).toBe(1) // A2 only
    expect(r.successful).toBe(1)
  })

  it("skips already-skipped auto-voters from the bundle", async () => {
    const { log } = captureLogs()
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([A1, A2])
    vi.mocked(contracts.getAlreadySkippedVotersForRound).mockResolvedValue(new Set([A1.toLowerCase()]))

    thor.scriptGasEstimate([
      { totalGas: 1_000_000, reverted: false, revertReasons: [], vmErrors: [] },
      { totalGas: 2_000_000, reverted: false, revertReasons: [], vmErrors: [] },
    ])

    const r = await runDistributeBundleCycle(thor as any, config, RELAYER, FAKE_PK, true, log)

    expect(r.totalUsers).toBe(1)
    expect(r.successful).toBe(1)
  })
})
