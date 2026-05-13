import { describe, it, expect, beforeEach, vi } from "vitest"
import { addr, bytes32, captureLogs, makeConfig } from "./helpers/builders"
import { createMockThor, type MockThor } from "./helpers/mockThor"

vi.mock("../src/contracts", async () => {
  const actual = await vi.importActual<typeof import("../src/contracts")>("../src/contracts")
  return {
    ...actual,
    getCurrentRoundId: vi.fn(),
    getRoundSnapshot: vi.fn(),
    getRoundDeadline: vi.fn(),
    getAlreadyClaimedForRound: vi.fn(),
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
    getActiveProposals: vi.fn(),
    hasVotedOnProposal: vi.fn(),
  }
})

import * as contracts from "../src/contracts"
import * as citizen from "../src/citizen-contracts"
import { runCitizenClaimRewardCycle } from "../src/citizen-relayer"

const RELAYER = addr("11111")
const FAKE_PK = "1".repeat(64)

const PREV_ROUND_ID = 99
const PREV_SNAPSHOT = 900_000
const PREV_DEADLINE = 960_000
// Far past deadline + early-access window — claim phase, not early access.
const LATEST = 1_000_000

const NAV_A = addr("aaaa")
const C1 = addr(1), C2 = addr(2), C3 = addr(3)
const PROPOSAL_ID = bytes32("dead")

describe("runCitizenClaimRewardCycle", () => {
  let thor: MockThor
  const config = makeConfig()

  beforeEach(() => {
    thor = createMockThor({ latestBlock: LATEST })
    vi.mocked(contracts.getCurrentRoundId).mockResolvedValue(PREV_ROUND_ID + 1)
    vi.mocked(contracts.getRoundSnapshot).mockResolvedValue(PREV_SNAPSHOT)
    vi.mocked(contracts.getRoundDeadline).mockResolvedValue(PREV_DEADLINE)
    vi.mocked(contracts.getAlreadyClaimedForRound).mockResolvedValue(new Set())
    vi.mocked(contracts.getEarlyAccessBlocks).mockResolvedValue(5_000n)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(new Map())
    vi.mocked(contracts.hasVoted).mockResolvedValue(false)

    vi.mocked(citizen.getActiveProposals).mockResolvedValue([])
    vi.mocked(citizen.hasVotedOnProposal).mockResolvedValue(false)
  })

  function setDelegations(map: Record<string, string>) {
    vi.mocked(citizen.getDelegatedCitizens).mockResolvedValue(new Map(Object.entries(map)))
    vi.mocked(citizen.getNavigatorsForCitizens).mockResolvedValue(new Map(Object.entries(map)))
  }

  it("returns empty when there's no previous round (round 1)", async () => {
    const { log } = captureLogs()
    vi.mocked(contracts.getCurrentRoundId).mockResolvedValue(1)

    const r = await runCitizenClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.roundId).toBe(0)
    expect(r.successful).toBe(0)
  })

  it("excludes citizens who never voted (no allocation, no governance)", async () => {
    const { log, lines } = captureLogs()
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(contracts.hasVoted).mockResolvedValue(false)

    const r = await runCitizenClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(0)
    expect(lines.some((l) => /did not vote/.test(l))).toBe(true)
  })

  it("includes citizens who voted on allocation only", async () => {
    const { log } = captureLogs()
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(contracts.hasVoted).mockImplementation(async (_t, _a, _r, user) => user === C1)

    const r = await runCitizenClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // C1 only
  })

  it("includes citizens who voted only on governance (allocation skipped)", async () => {
    const { log } = captureLogs()
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(contracts.hasVoted).mockResolvedValue(false) // no allocation
    vi.mocked(citizen.getActiveProposals).mockResolvedValue([PROPOSAL_ID])
    vi.mocked(citizen.hasVotedOnProposal).mockImplementation(
      async (_t, _a, _p, user) => user === C2,
    )

    const r = await runCitizenClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // C2 only
  })

  it("excludes citizens already claimed (event scan)", async () => {
    const { log } = captureLogs()
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(contracts.hasVoted).mockResolvedValue(true)
    vi.mocked(contracts.getAlreadyClaimedForRound).mockResolvedValue(new Set([C1.toLowerCase()]))

    const r = await runCitizenClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // C2 only (C1 already claimed)
  })

  it("respects preferred relayer during early access", async () => {
    const { log } = captureLogs()
    // Right at the start of early access window — deadline + 1000 blocks
    thor = createMockThor({ latestBlock: PREV_DEADLINE + 1000 })

    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(contracts.hasVoted).mockResolvedValue(true)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(
      new Map([
        [C1.toLowerCase(), addr("99999")], // prefers other → drop
        [C2.toLowerCase(), RELAYER.toLowerCase()], // prefers us → keep
      ]),
    )

    const r = await runCitizenClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // C2 only
  })

  it("handles getActiveProposals revert gracefully (governor not yet deployed)", async () => {
    const { log } = captureLogs()
    setDelegations({ [C1]: NAV_A })
    vi.mocked(contracts.hasVoted).mockResolvedValue(true)
    vi.mocked(citizen.getActiveProposals).mockRejectedValue(new Error("Call reverted"))

    const r = await runCitizenClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    // No governance proposals to check, but C1 voted on allocation → claim.
    expect(r.successful).toBe(1)
  })

  it("returns empty when there are no delegated citizens", async () => {
    const { log } = captureLogs()
    setDelegations({})

    const r = await runCitizenClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(0)
    expect(r.totalUsers).toBe(0)
  })
})
