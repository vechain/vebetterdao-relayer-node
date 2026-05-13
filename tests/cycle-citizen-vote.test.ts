import { describe, it, expect, beforeEach, vi } from "vitest"
import { addr, captureLogs, makeConfig } from "./helpers/builders"
import { createMockThor, type MockThor } from "./helpers/mockThor"

vi.mock("../src/contracts", async () => {
  const actual = await vi.importActual<typeof import("../src/contracts")>("../src/contracts")
  return {
    ...actual,
    getCurrentRoundId: vi.fn(),
    getRoundSnapshot: vi.fn(),
    getRoundDeadline: vi.fn(),
    getEarlyAccessBlocks: vi.fn(),
    getPreferredRelayersForUsers: vi.fn(),
    hasVoted: vi.fn(),
  }
})

vi.mock("../src/citizen-contracts", async () => {
  const actual = await vi.importActual<typeof import("../src/citizen-contracts")>("../src/citizen-contracts")
  return {
    ...actual,
    getDelegatedCitizens: vi.fn(),
    getNavigatorsForCitizens: vi.fn(),
    batchHasSetPreferences: vi.fn(),
    getAlreadySkippedCitizensForRound: vi.fn(),
    getCitizenSkipWindowBlocks: vi.fn(),
  }
})

import * as contracts from "../src/contracts"
import * as citizen from "../src/citizen-contracts"
import { runCitizenAllocationVoteCycle } from "../src/citizen-relayer"

const RELAYER = addr("11111")
const FAKE_PK = "1".repeat(64)

const ROUND = 100
const SNAPSHOT = 1_000_000
const DEADLINE = 1_060_000 // ~60k blocks later
const SKIP_WINDOW = 720
const LATEST_BEFORE_SKIP = 1_058_000 // before skip window
const LATEST_IN_SKIP_WINDOW = 1_059_500 // skip window reached

const NAV_A = addr("aaaa")
const NAV_B = addr("bbbb")
const C1 = addr(1), C2 = addr(2), C3 = addr(3)

describe("runCitizenAllocationVoteCycle", () => {
  let thor: MockThor
  const config = makeConfig()

  beforeEach(() => {
    thor = createMockThor({ latestBlock: LATEST_BEFORE_SKIP })

    vi.mocked(contracts.getCurrentRoundId).mockResolvedValue(ROUND)
    vi.mocked(contracts.getRoundSnapshot).mockResolvedValue(SNAPSHOT)
    vi.mocked(contracts.getRoundDeadline).mockResolvedValue(DEADLINE)
    vi.mocked(contracts.getEarlyAccessBlocks).mockResolvedValue(5_000n)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(new Map())
    vi.mocked(contracts.hasVoted).mockResolvedValue(false)

    vi.mocked(citizen.getAlreadySkippedCitizensForRound).mockResolvedValue(new Set())
    vi.mocked(citizen.getCitizenSkipWindowBlocks).mockResolvedValue(SKIP_WINDOW)
  })

  function setDelegations(map: Record<string, string>) {
    vi.mocked(citizen.getDelegatedCitizens).mockResolvedValue(new Map(Object.entries(map)))
    vi.mocked(citizen.getNavigatorsForCitizens).mockResolvedValue(new Map(Object.entries(map)))
  }

  it("returns empty when no delegated citizens", async () => {
    const { log } = captureLogs()
    setDelegations({})
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(new Map())

    const r = await runCitizenAllocationVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(0)
    expect(r.totalUsers).toBe(0)
  })

  it("waits for citizens whose navigator hasn't set preferences (before skip window)", async () => {
    const { log, lines } = captureLogs()
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A, [C3]: NAV_B })
    // NAV_A decided, NAV_B did not
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(
      new Map([
        [NAV_A, true],
        [NAV_B, false],
      ]),
    )

    const r = await runCitizenAllocationVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    // Only C1 + C2 (NAV_A's citizens) batched. C3 waiting for prefs.
    expect(r.successful).toBe(2)
    expect(lines.some((l) => /waiting for prefs/.test(l))).toBe(true)
  })

  it("includes nav-without-prefs citizens once skip window is reached", async () => {
    const { log } = captureLogs()
    thor = createMockThor({ latestBlock: LATEST_IN_SKIP_WINDOW })
    setDelegations({ [C1]: NAV_A, [C2]: NAV_B })
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(
      new Map([
        [NAV_A, true],
        [NAV_B, false],
      ]),
    )

    const r = await runCitizenAllocationVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    // Both batched: NAV_A votes; NAV_B's citizen will be skipped on chain.
    expect(r.successful).toBe(2)
  })

  it("excludes citizens already skipped (event scan)", async () => {
    const { log } = captureLogs()
    thor = createMockThor({ latestBlock: LATEST_IN_SKIP_WINDOW })
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(new Map([[NAV_A, true]]))
    vi.mocked(citizen.getAlreadySkippedCitizensForRound).mockResolvedValue(
      new Set([C1.toLowerCase()]),
    )

    const r = await runCitizenAllocationVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // C2 only
  })

  it("excludes citizens who already voted", async () => {
    const { log } = captureLogs()
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(new Map([[NAV_A, true]]))
    vi.mocked(contracts.hasVoted).mockImplementation(async (_t, _a, _r, user) => user === C1)

    const r = await runCitizenAllocationVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // C2 only
  })

  it("respects preferred relayer during early access", async () => {
    const { log } = captureLogs()
    const earlyBlock = SNAPSHOT + 1000 // before snapshot+5000
    thor = createMockThor({ latestBlock: earlyBlock })
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(new Map([[NAV_A, true]]))
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(
      new Map([
        [C1.toLowerCase(), addr("99999")], // prefers other → drop
        [C2.toLowerCase(), RELAYER.toLowerCase()], // prefers us → keep
      ]),
    )

    const r = await runCitizenAllocationVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // C2 only
  })

  it("treats citizens whose navigator failed snapshot validation as having no delegation", async () => {
    const { log } = captureLogs()
    // event cache says C1, C2, C3 are delegated…
    vi.mocked(citizen.getDelegatedCitizens).mockResolvedValue(
      new Map([[C1, NAV_A], [C2, NAV_A], [C3, NAV_B]]),
    )
    // …but at snapshot, only C1 still has a valid delegation (e.g. NAV_B exited)
    vi.mocked(citizen.getNavigatorsForCitizens).mockResolvedValue(new Map([[C1, NAV_A]]))
    vi.mocked(citizen.batchHasSetPreferences).mockResolvedValue(new Map([[NAV_A, true]]))

    const r = await runCitizenAllocationVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.totalUsers).toBe(1) // only C1 validated at snapshot
    expect(r.successful).toBe(1)
  })
})
