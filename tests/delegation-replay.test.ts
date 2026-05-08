// The chronological replay logic in getDelegatedCitizens must merge four event
// types and process them in (block, clauseIndex, type) order — otherwise a citizen
// who switched navigators in a single block ends up either deleted or pointed at
// the wrong navigator.
//
// We test by encoding synthetic event logs via the real navAbi, returning them
// from a mocked filterEventLogs, and asserting the resulting map. vi.resetModules
// gives us a fresh in-memory cache per test.

import { describe, it, expect, beforeEach } from "vitest"
import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import { addr } from "./helpers/builders"

const NAV_A = addr("aaaa")
const NAV_B = addr("bbbb")
const C1 = addr(1), C2 = addr(2), C3 = addr(3)

interface SyntheticLog {
  topics: string[]
  data: string
  meta: { blockNumber: number; clauseIndex: number }
}

function encodeLog(navAbi: any, eventName: string, args: any[], blockNumber: number, clauseIndex: number): SyntheticLog {
  const event = navAbi.getEvent(eventName)
  const encoded = event.encodeEventLog(args)
  // production code does `log.topics.map((t: string) => Hex.of(t))` — so we
  // need plain hex strings here, not Hex objects.
  return {
    topics: encoded.topics.map((t: any) => (t == null ? null : t.toString())).filter((t: any) => t != null),
    data: encoded.data.toString(),
    meta: { blockNumber, clauseIndex },
  }
}

async function freshlyLoad() {
  const { vi } = await import("vitest")
  vi.resetModules()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbd-relayer-test-"))
  process.chdir(tmp)
  const citizen = await import("../src/citizen-contracts")
  return { citizen, tmp }
}

function mockThorWithEvents(allEvents: { eventName: string; logs: SyntheticLog[] }[]) {
  return {
    logs: {
      filterEventLogs: async ({ criteriaSet }: any) => {
        // criteriaSet is [{ criteria: { address, topic0 }, eventAbi: event }]
        const eventAbi = criteriaSet[0].eventAbi
        const eventName = eventAbi.signature?.name ?? eventAbi.name
        const match = allEvents.find((e) => e.eventName === eventName)
        return match ? match.logs : []
      },
    },
  } as any
}

describe("getDelegatedCitizens — chronological replay", () => {
  beforeEach(() => {
    // each test starts in a fresh tmpdir so the disk cache is empty
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbd-relayer-test-"))
    process.chdir(tmp)
  })

  it("simple Create → citizen ends up delegated", async () => {
    const { citizen } = await freshlyLoad()
    const thor = mockThorWithEvents([
      {
        eventName: "DelegationCreated",
        logs: [encodeLog(citizen.navAbi, "DelegationCreated", [C1, NAV_A, 1000n], 100, 0)],
      },
      { eventName: "DelegationRemoved", logs: [] },
      { eventName: "ExitAnnounced", logs: [] },
      { eventName: "NavigatorDeactivatedEvent", logs: [] },
    ])

    const map = await citizen.getDelegatedCitizens(thor, addr("9a71"), 1000)
    expect(map.get(C1.toLowerCase())).toBe(NAV_A.toLowerCase())
  })

  it("Create then Remove in later block → citizen no longer delegated", async () => {
    const { citizen } = await freshlyLoad()
    const thor = mockThorWithEvents([
      {
        eventName: "DelegationCreated",
        logs: [encodeLog(citizen.navAbi, "DelegationCreated", [C1, NAV_A, 1000n], 100, 0)],
      },
      {
        eventName: "DelegationRemoved",
        logs: [encodeLog(citizen.navAbi, "DelegationRemoved", [C1, NAV_A, 1000n], 200, 0)],
      },
      { eventName: "ExitAnnounced", logs: [] },
      { eventName: "NavigatorDeactivatedEvent", logs: [] },
    ])

    const map = await citizen.getDelegatedCitizens(thor, addr("9a71"), 1000)
    expect(map.has(C1.toLowerCase())).toBe(false)
  })

  it("citizen switches navigators in same block: Remove(A) then Create(B) → delegated to B", async () => {
    // The function sorts events: same block + same clause → deactivated < exit < removed < created.
    // So a Remove and a Create in the same tx end up Remove-first, Create-after — citizen ends with B.
    const { citizen } = await freshlyLoad()
    const thor = mockThorWithEvents([
      {
        eventName: "DelegationCreated",
        logs: [
          encodeLog(citizen.navAbi, "DelegationCreated", [C1, NAV_A, 1000n], 100, 0),
          // same block as the Remove above: type ordering puts created last
          encodeLog(citizen.navAbi, "DelegationCreated", [C1, NAV_B, 500n], 200, 0),
        ],
      },
      {
        eventName: "DelegationRemoved",
        logs: [encodeLog(citizen.navAbi, "DelegationRemoved", [C1, NAV_A, 1000n], 200, 0)],
      },
      { eventName: "ExitAnnounced", logs: [] },
      { eventName: "NavigatorDeactivatedEvent", logs: [] },
    ])

    const map = await citizen.getDelegatedCitizens(thor, addr("9a71"), 1000)
    expect(map.get(C1.toLowerCase())).toBe(NAV_B.toLowerCase())
  })

  it("ExitAnnounced removes ALL citizens of that navigator (lazy invalidation)", async () => {
    const { citizen } = await freshlyLoad()
    const thor = mockThorWithEvents([
      {
        eventName: "DelegationCreated",
        logs: [
          encodeLog(citizen.navAbi, "DelegationCreated", [C1, NAV_A, 1000n], 100, 0),
          encodeLog(citizen.navAbi, "DelegationCreated", [C2, NAV_A, 2000n], 100, 1),
          encodeLog(citizen.navAbi, "DelegationCreated", [C3, NAV_B, 3000n], 100, 2),
        ],
      },
      { eventName: "DelegationRemoved", logs: [] },
      {
        eventName: "ExitAnnounced",
        logs: [encodeLog(citizen.navAbi, "ExitAnnounced", [NAV_A, 5n, 1500n], 200, 0)],
      },
      { eventName: "NavigatorDeactivatedEvent", logs: [] },
    ])

    const map = await citizen.getDelegatedCitizens(thor, addr("9a71"), 1000)
    expect(map.has(C1.toLowerCase())).toBe(false)
    expect(map.has(C2.toLowerCase())).toBe(false)
    expect(map.get(C3.toLowerCase())).toBe(NAV_B.toLowerCase()) // C3 unaffected
  })

  it("NavigatorDeactivatedEvent removes ALL citizens of that navigator", async () => {
    const { citizen } = await freshlyLoad()
    const thor = mockThorWithEvents([
      {
        eventName: "DelegationCreated",
        logs: [
          encodeLog(citizen.navAbi, "DelegationCreated", [C1, NAV_A, 1000n], 100, 0),
          encodeLog(citizen.navAbi, "DelegationCreated", [C2, NAV_B, 2000n], 100, 1),
        ],
      },
      { eventName: "DelegationRemoved", logs: [] },
      { eventName: "ExitAnnounced", logs: [] },
      {
        eventName: "NavigatorDeactivatedEvent",
        logs: [encodeLog(citizen.navAbi, "NavigatorDeactivatedEvent", [NAV_A, 1000n], 200, 0)],
      },
    ])

    const map = await citizen.getDelegatedCitizens(thor, addr("9a71"), 1000)
    expect(map.has(C1.toLowerCase())).toBe(false)
    expect(map.get(C2.toLowerCase())).toBe(NAV_B.toLowerCase())
  })
})
