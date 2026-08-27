import { ThorClient } from "@vechain/sdk-network"
import { LogFn } from "./types"

export interface SimulateResult {
  reverted: boolean
  data: string
}

/**
 * Simulate a batch of clauses, returning exactly one result per clause.
 *
 * Thor's `/accounts/*` stops executing a batch at the first clause that reverts
 * and returns a SHORT array: the reverting clause is the last entry, and every
 * clause after it is simply absent. Callers that iterate `results.length` therefore
 * silently lose every key past the first revert — for a 100-clause chunk of
 * citizens, one bad clause at the head drops the other 99 with no error and no log.
 *
 * We resume from where the node stopped until every clause has a result, so a
 * revert only ever costs its own clause.
 */
export async function simulateAllClauses(
  thor: ThorClient,
  clauses: { to: string; value: string; data: string }[],
  log?: LogFn,
): Promise<SimulateResult[]> {
  const out: SimulateResult[] = []
  let resumes = 0

  while (out.length < clauses.length) {
    const remaining = clauses.slice(out.length)
    const res = (await thor.transactions.simulateTransaction(remaining)) as SimulateResult[]

    if (!res || res.length === 0) {
      // Node returned nothing for a non-empty batch. Treat the head clause as
      // reverted so we make progress instead of looping forever.
      out.push({ reverted: true, data: "0x" })
      resumes++
      continue
    }

    out.push(...res)
    if (out.length < clauses.length) resumes++
  }

  if (resumes > 0) {
    log?.(`Simulate: batch truncated ${resumes}x by reverting clauses, resumed to cover all ${clauses.length}`)
  }

  return out
}
