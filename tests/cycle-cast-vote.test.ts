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
    getAutoVotingUsers: vi.fn(),
    getAlreadySkippedVotersForRound: vi.fn(),
    getEarlyAccessBlocks: vi.fn(),
    getPreferredRelayersForUsers: vi.fn(),
    hasVoted: vi.fn(),
    getAlreadyClaimedForRound: vi.fn(),
  }
})

import * as contracts from "../src/contracts"
import { runCastVoteCycle, runClaimRewardCycle } from "../src/relayer"

const RELAYER = addr("11111")
const FAKE_PK = "1".repeat(64)

const ROUND = 100
const SNAPSHOT = 1_000_000
const LATEST = 1_010_000 // past early access (snapshot + 5000 default)

describe("runCastVoteCycle", () => {
  let thor: MockThor
  const config = makeConfig()

  beforeEach(() => {
    thor = createMockThor({ latestBlock: LATEST })
    vi.mocked(contracts.getCurrentRoundId).mockResolvedValue(ROUND)
    vi.mocked(contracts.getRoundSnapshot).mockResolvedValue(SNAPSHOT)
    vi.mocked(contracts.getAlreadySkippedVotersForRound).mockResolvedValue(new Set())
    vi.mocked(contracts.getEarlyAccessBlocks).mockResolvedValue(5_000n)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(new Map())
  })

  it("returns empty result when no auto-voting users", async () => {
    const { log } = captureLogs()
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([])

    const r = await runCastVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.totalUsers).toBe(0)
    expect(r.successful).toBe(0)
    expect(thor.gas.estimateGas).not.toHaveBeenCalled()
  })

  it("filters out users who already voted", async () => {
    const { log } = captureLogs()
    const u1 = addr(1), u2 = addr(2), u3 = addr(3)
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([u1, u2, u3])
    vi.mocked(contracts.hasVoted).mockImplementation(async (_t, _a, _r, user) => user === u1)

    const r = await runCastVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.totalUsers).toBe(3)
    expect(r.successful).toBe(2) // u2 and u3 batched
    expect(thor.gas.estimateGas).toHaveBeenCalledTimes(1)
  })

  it("filters out users in AutoVoteSkipped event set (case-insensitive)", async () => {
    const { log } = captureLogs()
    const u1 = addr(1), u2 = addr(2)
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([u1, u2])
    vi.mocked(contracts.hasVoted).mockResolvedValue(false)
    // events store lowercase addresses
    vi.mocked(contracts.getAlreadySkippedVotersForRound).mockResolvedValue(new Set([u1.toLowerCase()]))

    const r = await runCastVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // only u2
  })

  it("during early access, drops users whose preferred relayer is someone else", async () => {
    const { log } = captureLogs()
    const u1 = addr(1), u2 = addr(2), u3 = addr(3)
    const otherRelayer = addr("99999")
    const earlyAccessBlock = SNAPSHOT + 1000 // before snapshot+5000

    thor = createMockThor({ latestBlock: earlyAccessBlock })

    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([u1, u2, u3])
    vi.mocked(contracts.hasVoted).mockResolvedValue(false)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(
      new Map([
        [u1.toLowerCase(), RELAYER.toLowerCase()], // prefers us → keep
        [u2.toLowerCase(), otherRelayer.toLowerCase()], // prefers other → skip
        // u3 → no preference → keep
      ]),
    )

    const r = await runCastVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(2) // u1 + u3
  })

  it("after early access, processes everyone regardless of preferred relayer", async () => {
    const { log } = captureLogs()
    const u1 = addr(1), u2 = addr(2)
    const otherRelayer = addr("99999")

    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([u1, u2])
    vi.mocked(contracts.hasVoted).mockResolvedValue(false)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(
      new Map([
        [u1.toLowerCase(), otherRelayer.toLowerCase()],
        [u2.toLowerCase(), otherRelayer.toLowerCase()],
      ]),
    )
    // LATEST > SNAPSHOT + 5000 → early access ended

    const r = await runCastVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(2)
  })

  it("when whole batch reverts, isolates and surfaces per-user reasons", async () => {
    const { log } = captureLogs()
    const u1 = addr(1), u2 = addr(2)
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([u1, u2])
    vi.mocked(contracts.hasVoted).mockResolvedValue(false)

    thor.scriptGasEstimate([
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: [] }, // batch
      { totalGas: 0, reverted: true, revertReasons: ["XAV: vote already cast"], vmErrors: [] },
      { totalGas: 50_000, reverted: false, revertReasons: [], vmErrors: [] },
      { totalGas: 50_000, reverted: false, revertReasons: [], vmErrors: [] }, // valid retry
    ])

    const r = await runCastVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1)
    expect(r.failed).toEqual([{ user: u1, reason: "XAV: vote already cast" }])
  })
})

describe("runClaimRewardCycle", () => {
  let thor: MockThor
  const config = makeConfig()

  beforeEach(() => {
    thor = createMockThor({ latestBlock: LATEST + 1_000_000 }) // far past deadline
    vi.mocked(contracts.getCurrentRoundId).mockResolvedValue(ROUND + 1)
    vi.mocked(contracts.getRoundSnapshot).mockResolvedValue(SNAPSHOT)
    vi.mocked(contracts.getRoundDeadline).mockResolvedValue(SNAPSHOT + 60_480)
    vi.mocked(contracts.getAlreadyClaimedForRound).mockResolvedValue(new Set())
    vi.mocked(contracts.getEarlyAccessBlocks).mockResolvedValue(5_000n)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(new Map())
  })

  it("returns empty when no auto-voting users existed for the previous round", async () => {
    const { log } = captureLogs()
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([])

    const r = await runClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(0)
    expect(r.totalUsers).toBe(0)
  })

  it("excludes users who didn't vote in the previous round", async () => {
    const { log } = captureLogs()
    const u1 = addr(1), u2 = addr(2)
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([u1, u2])
    vi.mocked(contracts.hasVoted).mockImplementation(async (_t, _a, _r, user) => user === u1)

    const r = await runClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // only u1
  })

  it("excludes users already claimed (event scan)", async () => {
    const { log } = captureLogs()
    const u1 = addr(1), u2 = addr(2)
    vi.mocked(contracts.getAutoVotingUsers).mockResolvedValue([u1, u2])
    vi.mocked(contracts.hasVoted).mockResolvedValue(true)
    vi.mocked(contracts.getAlreadyClaimedForRound).mockResolvedValue(new Set([u1.toLowerCase()]))

    const r = await runClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.successful).toBe(1) // only u2
  })

  it("returns 0 when previousRoundId is 0", async () => {
    const { log } = captureLogs()
    vi.mocked(contracts.getCurrentRoundId).mockResolvedValue(1)

    const r = await runClaimRewardCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r.roundId).toBe(0)
    expect(r.successful).toBe(0)
  })
})
