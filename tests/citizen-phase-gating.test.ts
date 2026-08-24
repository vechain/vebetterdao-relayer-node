import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeConfig } from "./helpers/builders"
import type { RelayerSummary } from "../src/types"

const cycleResult = () => ({
  phase: "vote" as const,
  roundId: 110,
  totalUsers: 0,
  successful: 0,
  failed: [],
  transient: [],
  txIds: [],
  dryRun: true,
})

vi.mock("../src/relayer", () => ({
  runCastVoteCycle: vi.fn(async () => (cycleResult())),
  runClaimRewardCycle: vi.fn(async () => (cycleResult())),
}))

vi.mock("../src/citizen-relayer", () => ({
  runCitizenAllocationVoteCycle: vi.fn(async () => (cycleResult())),
  runCitizenGovernanceVoteCycle: vi.fn(async () => []),
  runCitizenClaimRewardCycle: vi.fn(async () => (cycleResult())),
}))

import * as citizenRelayer from "../src/citizen-relayer"
import { runActiveRoundVotingCycles } from "../src/index"

function summary(over: Partial<RelayerSummary> = {}): RelayerSummary {
  return {
    isRoundActive: true,
    currentRoundId: 110,
    citizenUsers: 0,
    citizenFetchFailed: false,
    ...over,
  } as RelayerSummary
}

const run = (s: RelayerSummary) =>
  runActiveRoundVotingCycles({} as any, makeConfig(), "0xrelayer", "0xkey", 50, true, s)

describe("citizen phase gating", () => {
  beforeEach(() => vi.clearAllMocks())

  it("skips citizen phases when there genuinely are no citizens", async () => {
    await run(summary({ citizenUsers: 0, citizenFetchFailed: false }))
    expect(citizenRelayer.runCitizenAllocationVoteCycle).not.toHaveBeenCalled()
    expect(citizenRelayer.runCitizenGovernanceVoteCycle).not.toHaveBeenCalled()
  })

  it("runs citizen phases when the count is unknown because the fetch failed", async () => {
    // The regression this guards: a failed fetch used to leave citizenUsers at 0, which is
    // indistinguishable from "no citizens", so both citizen phases were skipped for the
    // whole cycle. Citizens then went a full round with neither a vote nor a skip — which
    // is what permanently locks a round's relayer reward pool.
    await run(summary({ citizenUsers: 0, citizenFetchFailed: true }))
    expect(citizenRelayer.runCitizenAllocationVoteCycle).toHaveBeenCalledTimes(1)
    expect(citizenRelayer.runCitizenGovernanceVoteCycle).toHaveBeenCalledTimes(1)
  })

  it("runs citizen phases normally when citizens are present", async () => {
    await run(summary({ citizenUsers: 181 }))
    expect(citizenRelayer.runCitizenAllocationVoteCycle).toHaveBeenCalledTimes(1)
  })

  it("still runs governance when the allocation phase throws", async () => {
    // A throw here used to propagate out of runAllCycles and starve the claim phases that
    // run after it — every cycle, for as long as the failure lasted. Fail loud, stay local.
    vi.mocked(citizenRelayer.runCitizenAllocationVoteCycle).mockRejectedValueOnce(new Error("RPC down"))
    await expect(run(summary({ citizenUsers: 181 }))).resolves.not.toThrow()
    expect(citizenRelayer.runCitizenGovernanceVoteCycle).toHaveBeenCalledTimes(1)
  })

  it("skips every voting phase when the round is not active", async () => {
    await run(summary({ isRoundActive: false, citizenUsers: 181 }))
    expect(citizenRelayer.runCitizenAllocationVoteCycle).not.toHaveBeenCalled()
  })
})
