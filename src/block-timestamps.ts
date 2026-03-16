const blockTimestampCache = new Map<string, number | null>()

export async function getBlockTimestamp(
  nodeUrl: string,
  blockNumber: number,
): Promise<number | null> {
  if (blockNumber <= 0) return null

  const cacheKey = `${nodeUrl}:${blockNumber}`
  if (blockTimestampCache.has(cacheKey)) {
    return blockTimestampCache.get(cacheKey) ?? null
  }

  try {
    const res = await fetch(`${nodeUrl.replace(/\/$/, "")}/blocks/${blockNumber}`, {
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { timestamp?: number }
    const timestamp = typeof data.timestamp === "number" ? data.timestamp : null
    blockTimestampCache.set(cacheKey, timestamp)
    return timestamp
  } catch {
    blockTimestampCache.set(cacheKey, null)
    return null
  }
}
