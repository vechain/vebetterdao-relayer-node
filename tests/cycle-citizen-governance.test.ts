import { describe, it, expect, beforeEach, vi } from "vitest"
import { addr, bytes32, captureLogs, makeConfig } from "./helpers/builders"
import { createMockThor, type MockThor } from "./helpers/mockThor"

vi.mock("../src/contracts", async () => {
  const actual = await vi.importActual<typeof import("../src/contracts")>("../src/contracts")
  return {
    ...actual,
    getCurrentRoundId: vi.fn(),
    getRoundSnapshot: vi.fn(),
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
    batchHasSetDecision: vi.fn(),
    getAlreadySkippedCitizensForProposal: vi.fn(),
    getActiveProposals: vi.fn(),
    hasVotedOnProposal: vi.fn(),
    getProposalDeadline: vi.fn(),
    getGovernanceSkipWindowBlocks: vi.fn(),
  }
})

import * as contracts from "../src/contracts"
import * as citizen from "../src/citizen-contracts"
import { runCitizenGovernanceVoteCycle } from "../src/citizen-relayer"

const RELAYER = addr("11111")
const FAKE_PK = "1".repeat(64)

const ROUND = 100
const SNAPSHOT = 1_000_000
const SKIP_WINDOW = 720
const LATEST_BEFORE_SKIP = 1_058_000
const LATEST_IN_SKIP = 1_059_500
const PROPOSAL_DEADLINE = 1_060_000

// Realistic OpenZeppelin-style proposalId — keccak-derived uint256 well above 2^53.
const HASH_PROPOSAL_ID = "0x" + "ab".repeat(32)
const HASH_PROPOSAL_ID_2 = "0x" + "cd".repeat(32)

const NAV_A = addr("aaaa")
const C1 = addr(1), C2 = addr(2)

describe("runCitizenGovernanceVoteCycle", () => {
  let thor: MockThor
  const config = makeConfig()

  beforeEach(() => {
    thor = createMockThor({ latestBlock: LATEST_BEFORE_SKIP })
    vi.mocked(contracts.getCurrentRoundId).mockResolvedValue(ROUND)
    vi.mocked(contracts.getRoundSnapshot).mockResolvedValue(SNAPSHOT)
    vi.mocked(contracts.getEarlyAccessBlocks).mockResolvedValue(5_000n)
    vi.mocked(contracts.getPreferredRelayersForUsers).mockResolvedValue(new Map())

    vi.mocked(citizen.hasVotedOnProposal).mockResolvedValue(false)
    vi.mocked(citizen.getAlreadySkippedCitizensForProposal).mockResolvedValue(new Set())
    vi.mocked(citizen.getProposalDeadline).mockResolvedValue(PROPOSAL_DEADLINE)
    vi.mocked(citizen.getGovernanceSkipWindowBlocks).mockResolvedValue(SKIP_WINDOW)
  })

  function setDelegations(map: Record<string, string>) {
    vi.mocked(citizen.getDelegatedCitizens).mockResolvedValue(new Map(Object.entries(map)))
    vi.mocked(citizen.getNavigatorsForCitizens).mockResolvedValue(new Map(Object.entries(map)))
  }

  it("returns empty array when there are no active proposals", async () => {
    const { log } = captureLogs()
    vi.mocked(citizen.getActiveProposals).mockResolvedValue([])

    const r = await runCitizenGovernanceVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r).toEqual([])
  })

  it("treats getActiveProposals revert as 'no proposals' (graceful when governor not deployed)", async () => {
    const { log, lines } = captureLogs()
    vi.mocked(citizen.getActiveProposals).mockRejectedValue(new Error("Call reverted: bad address"))

    const r = await runCitizenGovernanceVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r).toEqual([])
    expect(lines.some((l) => /No active governance proposals/.test(l))).toBe(true)
  })

  it("processes each active proposal independently", async () => {
    const { log } = captureLogs()
    vi.mocked(citizen.getActiveProposals).mockResolvedValue([HASH_PROPOSAL_ID, HASH_PROPOSAL_ID_2])
    setDelegations({ [C1]: NAV_A })
    vi.mocked(citizen.batchHasSetDecision).mockResolvedValue(new Map([[NAV_A, true]]))

    const r = await runCitizenGovernanceVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r).toHaveLength(2)
    expect(r[0].successful).toBe(1)
    expect(r[1].successful).toBe(1)
  })

  it("waits for navigators before skip window, includes them after", async () => {
    const { log } = captureLogs()
    vi.mocked(citizen.getActiveProposals).mockResolvedValue([HASH_PROPOSAL_ID])
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(citizen.batchHasSetDecision).mockResolvedValue(new Map([[NAV_A, false]]))

    // Before skip window → wait
    const r1 = await runCitizenGovernanceVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)
    expect(r1[0].successful).toBe(0)

    // After skip window → include both for on-chain skip
    thor = createMockThor({ latestBlock: LATEST_IN_SKIP })
    const r2 = await runCitizenGovernanceVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)
    expect(r2[0].successful).toBe(2)
  })

  it("excludes citizens who already voted on a given proposal", async () => {
    const { log } = captureLogs()
    vi.mocked(citizen.getActiveProposals).mockResolvedValue([HASH_PROPOSAL_ID])
    setDelegations({ [C1]: NAV_A, [C2]: NAV_A })
    vi.mocked(citizen.batchHasSetDecision).mockResolvedValue(new Map([[NAV_A, true]]))
    vi.mocked(citizen.hasVotedOnProposal).mockImplementation(
      async (_t, _a, _p, citizen) => citizen === C1,
    )

    const r = await runCitizenGovernanceVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r[0].successful).toBe(1) // C2 only
  })

  it("regression: bytes32 proposalId is preserved end-to-end (no Number() truncation)", async () => {
    const { log } = captureLogs()
    // Big keccak-derived hash that loses precision when cast to Number.
    const realisticId = bytes32("e2a5c1b2bf3d4e5e6789abcdef0123456789abcdef0123456789abcdef012345")
    expect(Number(BigInt(realisticId)).toString()).not.toEqual(BigInt(realisticId).toString())

    vi.mocked(citizen.getActiveProposals).mockResolvedValue([realisticId])
    setDelegations({ [C1]: NAV_A })
    vi.mocked(citizen.batchHasSetDecision).mockResolvedValue(new Map([[NAV_A, true]]))

    const r = await runCitizenGovernanceVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    // The relevant hasVotedOnProposal / batchHasSetDecision / getProposalDeadline / getAlreadySkippedCitizensForProposal
    // are all called with the exact bytes32 string — never truncated.
    expect(vi.mocked(citizen.hasVotedOnProposal)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      realisticId,
      expect.anything(),
    )
    expect(vi.mocked(citizen.batchHasSetDecision)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      realisticId,
    )
    expect(vi.mocked(citizen.getProposalDeadline)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      realisticId,
    )
    expect(vi.mocked(citizen.getAlreadySkippedCitizensForProposal)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      realisticId,
      expect.anything(),
      expect.anything(),
    )
    expect(r[0].successful).toBe(1)
  })

  it("each per-proposal result reports the round (not the proposal) as roundId", async () => {
    const { log } = captureLogs()
    vi.mocked(citizen.getActiveProposals).mockResolvedValue([HASH_PROPOSAL_ID])
    setDelegations({ [C1]: NAV_A })
    vi.mocked(citizen.batchHasSetDecision).mockResolvedValue(new Map([[NAV_A, true]]))

    const r = await runCitizenGovernanceVoteCycle(thor as any, config, RELAYER, FAKE_PK, 50, true, log)

    expect(r[0].roundId).toBe(ROUND)
  })
})
