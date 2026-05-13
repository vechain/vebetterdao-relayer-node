// Minimal Thor SDK shape used by the relayer. Only the surface required by
// processBatch and the runtime cycle code is provided — every other access
// throws so tests fail loudly if production code starts calling something new.

import { vi } from "vitest"

interface GasEstimateOutcome {
  totalGas: number
  reverted: boolean
  revertReasons: Array<string | bigint>
  vmErrors: string[]
}

interface SimulateOutcome {
  reverted: boolean
  data: string
}

export interface MockThor {
  // ── canonical Thor methods used by relayer ─────────────────
  blocks: { getBestBlockCompressed: () => Promise<{ number: number } | null> }
  gas: { estimateGas: ReturnType<typeof vi.fn> }
  transactions: {
    simulateTransaction: ReturnType<typeof vi.fn>
    buildTransactionBody: ReturnType<typeof vi.fn>
    sendTransaction: ReturnType<typeof vi.fn>
    waitForTransaction: ReturnType<typeof vi.fn>
  }
  contracts: { executeCall: ReturnType<typeof vi.fn> }
  logs: { filterEventLogs: ReturnType<typeof vi.fn> }

  // ── test-only helpers ──────────────────────────────────────
  /** Force the next N gas-estimate calls to revert with the given reason. */
  scriptGasEstimate: (results: GasEstimateOutcome[]) => void
  /** Force the next N simulateTransaction calls to return these per-clause results. */
  scriptSimulate: (results: SimulateOutcome[][]) => void
  /** Inspect what was sent. */
  sentTxs: Array<{ id: string }>
  builtBodies: any[]
}

const DEFAULT_GAS: GasEstimateOutcome = {
  totalGas: 21_000,
  reverted: false,
  revertReasons: [],
  vmErrors: [],
}

export function createMockThor(opts: { latestBlock?: number } = {}): MockThor {
  const latestBlock = opts.latestBlock ?? 1_000_000
  const sentTxs: Array<{ id: string }> = []
  const builtBodies: any[] = []
  let txIdCounter = 1

  const estimateGas = vi.fn(async () => ({ ...DEFAULT_GAS }))
  const simulateTransaction = vi.fn(async () => [] as SimulateOutcome[])

  const thor: MockThor = {
    blocks: {
      getBestBlockCompressed: vi.fn(async () => ({ number: latestBlock })),
    },
    gas: {
      estimateGas,
    },
    transactions: {
      simulateTransaction,
      buildTransactionBody: vi.fn(async (clauses: unknown, totalGas: number) => {
        const body = {
          chainTag: 0,
          blockRef: "0x0000000000000000",
          expiration: 32,
          clauses,
          gasPriceCoef: 0,
          gas: totalGas,
          dependsOn: null,
          nonce: txIdCounter,
        }
        builtBodies.push(body)
        return body
      }),
      sendTransaction: vi.fn(async () => {
        const id = "0x" + (txIdCounter++).toString(16).padStart(64, "0")
        const entry = { id }
        sentTxs.push(entry)
        return entry
      }),
      waitForTransaction: vi.fn(async () => ({ reverted: false })),
    },
    contracts: {
      executeCall: vi.fn(async () => {
        throw new Error("MockThor.contracts.executeCall called — script it explicitly")
      }),
    },
    logs: {
      filterEventLogs: vi.fn(async () => []),
    },
    scriptGasEstimate: (results) => {
      for (const r of results) estimateGas.mockImplementationOnce(async () => r)
    },
    scriptSimulate: (results) => {
      for (const r of results) simulateTransaction.mockImplementationOnce(async () => r)
    },
    sentTxs,
    builtBodies,
  }

  return thor
}

