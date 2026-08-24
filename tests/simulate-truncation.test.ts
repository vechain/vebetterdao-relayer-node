import { describe, it, expect, vi } from "vitest"
import { simulateAllClauses } from "../src/simulate"
import { captureLogs } from "./helpers/builders"

const ok = (data: string) => ({ reverted: false, data })
const rev = () => ({ reverted: true, data: "0x" })

function clauses(n: number) {
  return Array.from({ length: n }, (_, i) => ({ to: "0x1", value: "0x0", data: "0x" + i.toString(16) }))
}

/**
 * Thor's /accounts/* stops executing a batch at the first reverting clause and returns a
 * SHORT array — the reverting clause is the last entry, everything after it is absent.
 * Verified against mainnet: [ok, revert, ok] comes back with 2 entries, [revert, ok, ok]
 * with 1. Callers that trusted results.length silently dropped every key past the revert.
 */
function thorTruncatingAt(revertIndexes: number[]) {
  const simulateTransaction = vi.fn(async (sent: any[]) => {
    // `sent` is the remaining slice; work out where we are in the original batch.
    const offset = Number.parseInt(sent[0].data.slice(2), 16)
    const out: any[] = []
    for (let i = 0; i < sent.length; i++) {
      const absolute = offset + i
      if (revertIndexes.includes(absolute)) {
        out.push(rev())
        return out // thor halts here
      }
      out.push(ok("0x" + absolute.toString(16).padStart(64, "0")))
    }
    return out
  })
  return { transactions: { simulateTransaction } } as any
}

describe("simulateAllClauses — thor batch truncation", () => {
  it("returns one result per clause when nothing reverts", async () => {
    const thor = thorTruncatingAt([])
    const res = await simulateAllClauses(thor, clauses(5))
    expect(res).toHaveLength(5)
    expect(res.every((r) => !r.reverted)).toBe(true)
    expect(thor.transactions.simulateTransaction).toHaveBeenCalledTimes(1)
  })

  it("resumes past a revert instead of losing the rest of the batch", async () => {
    const thor = thorTruncatingAt([1])
    const res = await simulateAllClauses(thor, clauses(3))
    expect(res).toHaveLength(3)
    expect(res.map((r) => r.reverted)).toEqual([false, true, false])
  })

  it("resumes when the very first clause reverts", async () => {
    const thor = thorTruncatingAt([0])
    const res = await simulateAllClauses(thor, clauses(3))
    expect(res).toHaveLength(3)
    expect(res.map((r) => r.reverted)).toEqual([true, false, false])
  })

  it("keeps the other 99 alive when one clause in a 100-clause chunk reverts", async () => {
    // This is round 110's shape: a chunk of 100 citizens where a single bad clause
    // used to take the whole chunk down with it.
    const thor = thorTruncatingAt([0])
    const res = await simulateAllClauses(thor, clauses(100))
    expect(res).toHaveLength(100)
    expect(res.filter((r) => r.reverted)).toHaveLength(1)
    expect(res.filter((r) => !r.reverted)).toHaveLength(99)
  })

  it("handles several reverts in one batch", async () => {
    const thor = thorTruncatingAt([2, 3, 7])
    const res = await simulateAllClauses(thor, clauses(10))
    expect(res).toHaveLength(10)
    expect(res.map((r, i) => (r.reverted ? i : -1)).filter((i) => i >= 0)).toEqual([2, 3, 7])
  })

  it("makes progress and terminates when the node returns an empty array", async () => {
    const simulateTransaction = vi.fn(async () => [])
    const thor = { transactions: { simulateTransaction } } as any
    const res = await simulateAllClauses(thor, clauses(3))
    expect(res).toHaveLength(3)
    expect(res.every((r) => r.reverted)).toBe(true)
  })

  it("logs when it had to resume", async () => {
    const { log, lines } = captureLogs()
    await simulateAllClauses(thorTruncatingAt([1]), clauses(3), log)
    expect(lines.join("\n")).toMatch(/truncated/i)
  })

  it("stays silent when no resume was needed", async () => {
    const { log, lines } = captureLogs()
    await simulateAllClauses(thorTruncatingAt([]), clauses(3), log)
    expect(lines).toHaveLength(0)
  })
})
