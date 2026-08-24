import { describe, it, expect, vi } from "vitest"
import { getNavigatorsForCitizens } from "../src/citizen-contracts"
import { addr } from "./helpers/builders"

const NAV = addr("9a71")
const REGISTRY = addr("4e9157")

/** ABI-encode an address as a single 32-byte return word. */
function encodeAddress(a: string): string {
  return "0x" + a.slice(2).toLowerCase().padStart(64, "0")
}

/**
 * Mock thor that mimics the real node: execution halts at the first reverting clause and
 * the response is truncated there. Clause N's calldata ends with the citizen address, so
 * we can map each clause back to its citizen.
 */
function thorRevertingFor(citizens: string[], revertFor: Set<string>) {
  const simulateTransaction = vi.fn(async (sent: any[]) => {
    const out: any[] = []
    for (const clause of sent) {
      const who = citizens.find((c) => clause.data.toLowerCase().includes(c.slice(2).toLowerCase()))!
      if (revertFor.has(who)) {
        out.push({ reverted: true, data: "0x" })
        return out // node stops executing the rest of the batch
      }
      out.push({ reverted: false, data: encodeAddress(NAV) })
    }
    return out
  })
  return { transactions: { simulateTransaction } } as any
}

describe("getNavigatorsForCitizens — one reverting clause must not drop the chunk", () => {
  it("keeps every other citizen when the FIRST clause reverts", async () => {
    // Round 110's failure shape: 181 citizens, and only the 81-citizen remainder chunk
    // came back. Before the fix, a revert at clause 0 lost all 100 of the first chunk.
    const citizens = Array.from({ length: 120 }, (_, i) => addr(`c17e${i.toString(16)}`))
    const thor = thorRevertingFor(citizens, new Set([citizens[0]]))

    const result = await getNavigatorsForCitizens(thor, REGISTRY, citizens, 25520917)

    expect(result.size).toBe(119)
    expect(result.has(citizens[0].toLowerCase())).toBe(false)
    for (const c of citizens.slice(1)) {
      expect(result.get(c.toLowerCase())).toBe(NAV.toLowerCase())
    }
  })

  it("drops only the reverting citizens, wherever they sit in the batch", async () => {
    const citizens = Array.from({ length: 10 }, (_, i) => addr(`c17e${i.toString(16)}`))
    const bad = new Set([citizens[3], citizens[4], citizens[9]])
    const thor = thorRevertingFor(citizens, bad)

    const result = await getNavigatorsForCitizens(thor, REGISTRY, citizens, 1000)

    expect(result.size).toBe(7)
    for (const c of citizens) {
      expect(result.has(c.toLowerCase())).toBe(!bad.has(c))
    }
  })

  it("returns everyone when nothing reverts", async () => {
    const citizens = Array.from({ length: 250 }, (_, i) => addr(`c17e${i.toString(16)}`))
    const thor = thorRevertingFor(citizens, new Set())

    const result = await getNavigatorsForCitizens(thor, REGISTRY, citizens, 1000)

    expect(result.size).toBe(250)
  })
})
