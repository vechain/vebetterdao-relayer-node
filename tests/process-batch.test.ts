import { describe, it, expect, beforeEach } from "vitest"
import { Address, Clause } from "@vechain/sdk-core"
import { processBatch, packByGas, MAX_TX_GAS } from "../src/relayer"
import { createMockThor, type MockThor } from "./helpers/mockThor"
import { addr, captureLogs } from "./helpers/builders"

// Production code uses Clause.callFunction with real ABI fns. For processBatch
// the clause builder is a black box — only the bytes shape matters. We use a
// trivial encoded clause so tests don't depend on a particular contract.
function makeClauseBuilder() {
  return (user: string): Clause =>
    ({
      to: addr("c0117ac7"),
      value: "0x0",
      data: "0x" + user.slice(2).padStart(64, "0"),
    } as unknown as Clause)
}

const WALLET = addr("a")
// 32-byte private key (hex without 0x). Real signing only happens off the
// dry-run path, which we avoid in this file by passing dryRun=true.
const FAKE_PK = "1".repeat(64)

describe("processBatch", () => {
  let thor: MockThor

  beforeEach(() => {
    thor = createMockThor()
  })

  it("returns empty outcome when given no users", async () => {
    const { log } = captureLogs()
    const result = await processBatch(
      thor as any,
      [],
      makeClauseBuilder(),
      WALLET,
      FAKE_PK,
      50,
      true,
      log,
    )
    expect(result.successful).toBe(0)
    expect(result.failed).toEqual([])
    expect(result.txIds).toEqual([])
    expect(thor.gas.estimateGas).not.toHaveBeenCalled()
  })

  it("dry-run happy path: estimates gas, marks all successful, no tx sent", async () => {
    const { log, lines } = captureLogs()
    const users = [addr(1), addr(2), addr(3)]

    const result = await processBatch(
      thor as any,
      users,
      makeClauseBuilder(),
      WALLET,
      FAKE_PK,
      50,
      true,
      log,
    )

    expect(result.successful).toBe(3)
    expect(result.failed).toEqual([])
    expect(result.txIds).toEqual(["DRY_RUN_1"])
    expect(thor.gas.estimateGas).toHaveBeenCalledTimes(1)
    expect(thor.transactions.sendTransaction).not.toHaveBeenCalled()
    expect(lines.some((l) => /simulating/.test(l))).toBe(true)
  })

  it("splits into multiple batches of batchSize", async () => {
    const { log } = captureLogs()
    const users = Array.from({ length: 7 }, (_, i) => addr(i + 1))

    const result = await processBatch(
      thor as any,
      users,
      makeClauseBuilder(),
      WALLET,
      FAKE_PK,
      3, // batchSize
      true,
      log,
    )

    expect(result.successful).toBe(7)
    // 3 batches: 3 + 3 + 1
    expect(thor.gas.estimateGas).toHaveBeenCalledTimes(3)
    expect(result.txIds).toEqual(["DRY_RUN_1", "DRY_RUN_2", "DRY_RUN_3"])
  })

  it("isolation: when batch reverts, simulate per-user, separate failed and valid", async () => {
    const { log, lines } = captureLogs()
    const users = [addr(1), addr(2), addr(3)]

    // Batch-level estimate reverts → triggers isolation.
    // Per-user estimates: user1 reverts (custom error), user2 OK, user3 reverts (vmError fallback).
    // Then valid set ([user2]) re-estimated and OK.
    thor.scriptGasEstimate([
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: [] }, // batch
      { totalGas: 0, reverted: true, revertReasons: ["already voted"], vmErrors: [] }, // user1
      { totalGas: 50_000, reverted: false, revertReasons: [], vmErrors: [] }, // user2
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: ["execution reverted"] }, // user3
      { totalGas: 50_000, reverted: false, revertReasons: [], vmErrors: [] }, // valid retry
    ])

    const result = await processBatch(
      thor as any,
      users,
      makeClauseBuilder(),
      WALLET,
      FAKE_PK,
      50,
      true,
      log,
    )

    expect(result.successful).toBe(1) // user2
    expect(result.failed).toHaveLength(2)
    expect(result.failed).toContainEqual({ user: addr(1), reason: "already voted" })
    expect(result.failed).toContainEqual({ user: addr(3), reason: "execution reverted" })
    expect(result.txIds).toEqual(["DRY_RUN_ISOLATED"])
    expect(lines.some((l) => /isolating failures/.test(l))).toBe(true)
  })

  it("isolation: when every user is doomed, no successful, no tx", async () => {
    const { log } = captureLogs()
    const users = [addr(1), addr(2)]

    thor.scriptGasEstimate([
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: [] }, // batch
      { totalGas: 0, reverted: true, revertReasons: ["nope"], vmErrors: [] }, // user1
      { totalGas: 0, reverted: true, revertReasons: ["nope"], vmErrors: [] }, // user2
    ])

    const result = await processBatch(
      thor as any,
      users,
      makeClauseBuilder(),
      WALLET,
      FAKE_PK,
      50,
      true,
      log,
    )

    expect(result.successful).toBe(0)
    expect(result.failed).toHaveLength(2)
    expect(result.txIds).toEqual([])
  })

  it("falls back to vmErrors when revertReasons is empty", async () => {
    const { log } = captureLogs()
    const users = [addr(1)]

    thor.scriptGasEstimate([
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: [] }, // batch
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: ["custom error 0xdeadbeef"] }, // user1
    ])

    const result = await processBatch(
      thor as any,
      users,
      makeClauseBuilder(),
      WALLET,
      FAKE_PK,
      50,
      true,
      log,
    )

    expect(result.failed).toEqual([{ user: addr(1), reason: "custom error 0xdeadbeef" }])
  })

  it("uses generic 'reverted' when both reason fields are empty", async () => {
    const { log } = captureLogs()
    const users = [addr(1)]

    thor.scriptGasEstimate([
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: [] }, // batch
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: [] }, // user1
    ])

    const result = await processBatch(
      thor as any,
      users,
      makeClauseBuilder(),
      WALLET,
      FAKE_PK,
      50,
      true,
      log,
    )

    expect(result.failed).toEqual([{ user: addr(1), reason: "reverted" }])
  })

  it("isolation: thrown error in per-user estimate becomes a failed entry", async () => {
    const { log } = captureLogs()
    const users = [addr(1), addr(2)]

    thor.scriptGasEstimate([
      { totalGas: 0, reverted: true, revertReasons: [], vmErrors: [] }, // batch
    ])
    // user1 estimate throws (network error simulation)
    thor.gas.estimateGas
      .mockImplementationOnce(async () => {
        throw new Error("HTTP 503")
      })
      // user2 OK
      .mockImplementationOnce(async () => ({ totalGas: 50_000, reverted: false, revertReasons: [], vmErrors: [] }))
      // valid retry
      .mockImplementationOnce(async () => ({ totalGas: 50_000, reverted: false, revertReasons: [], vmErrors: [] }))

    const result = await processBatch(
      thor as any,
      users,
      makeClauseBuilder(),
      WALLET,
      FAKE_PK,
      50,
      true,
      log,
    )

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].user).toBe(addr(1))
    expect(result.failed[0].reason).toContain("HTTP 503")
    expect(result.successful).toBe(1) // user2
  })

  it("splits a batch whose estimated gas exceeds the tx cap", async () => {
    const { log, lines } = captureLogs()
    const users = [addr(1), addr(2), addr(3), addr(4)]

    thor.scriptGasEstimate([
      { totalGas: MAX_TX_GAS + 1, reverted: false, revertReasons: [], vmErrors: [] }, // 4 users
      { totalGas: 8_000_000, reverted: false, revertReasons: [], vmErrors: [] }, // first half
      { totalGas: 8_000_000, reverted: false, revertReasons: [], vmErrors: [] }, // second half
    ])

    const result = await processBatch(thor as any, users, makeClauseBuilder(), WALLET, FAKE_PK, 50, true, log)

    expect(result.successful).toBe(4)
    expect(result.transient).toEqual([])
    expect(result.txIds).toEqual(["DRY_RUN_2", "DRY_RUN_3"])
    expect(lines.some((l) => /exceeds tx cap/.test(l))).toBe(true)
  })

  it("marks a single user above the tx cap as failed, not transient", async () => {
    const { log } = captureLogs()
    thor.scriptGasEstimate([{ totalGas: MAX_TX_GAS + 1, reverted: false, revertReasons: [], vmErrors: [] }])

    const result = await processBatch(thor as any, [addr(1)], makeClauseBuilder(), WALLET, FAKE_PK, 50, true, log)

    expect(result.successful).toBe(0)
    expect(result.transient).toEqual([])
    expect(result.failed[0].reason).toMatch(/exceeds tx cap/)
  })

  it("splits when the node rejects the tx for exceeding the gas cap", async () => {
    const { log } = captureLogs()
    const users = [addr(1), addr(2)]
    thor.transactions.sendTransaction.mockImplementationOnce(async () => {
      throw new Error("HTTP 400 - bad tx: tx gas limit exceeds the maximum allowed")
    })

    const result = await processBatch(thor as any, users, makeClauseBuilder(), WALLET, FAKE_PK, 50, false, log)

    expect(result.successful).toBe(2)
    expect(result.transient).toEqual([])
    expect(thor.transactions.sendTransaction).toHaveBeenCalledTimes(3)
  })
})

describe("packByGas", () => {
  it("packs users into chunks that stay within the tx cap", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ user: addr(i + 1), gas: 917_000 }))
    const chunks = packByGas(entries)

    expect(chunks.flat()).toHaveLength(50)
    for (const chunk of chunks) expect(chunk.length * 917_000).toBeLessThanOrEqual(MAX_TX_GAS)
    expect(chunks[0]).toHaveLength(17)
  })

  it("keeps everything in one chunk when it fits", () => {
    expect(packByGas([{ user: addr(1), gas: 100 }, { user: addr(2), gas: 100 }])).toEqual([[addr(1), addr(2)]])
  })
})
