import { NetworkConfig } from "./types"

const DEFAULT_MAINNET_REPORT_URL = "https://relayers.vebetterdao.org/data/report.json"

export interface ReportRoundAnalytics {
  roundId: number
  autoVotingUsersCount: number
  votedForCount: number
  rewardsClaimedCount: number
  totalRelayerRewardsRaw: string
  estimatedRelayerRewardsRaw: string
  reducedUsersCount: number
}

export interface ReportRelayerRoundBreakdown {
  roundId: number
  votedForCount: number
  rewardsClaimedCount: number
  weightedActions: number
  actions: number
  claimableRewardsRaw: string
  relayerRewardsClaimedRaw: string
  vthoSpentOnVotingRaw: string
  vthoSpentOnClaimingRaw: string
}

export interface ReportRelayerAnalytics {
  address: string
  rounds: ReportRelayerRoundBreakdown[]
}

export interface ReportData {
  generatedAt: string
  network: string
  currentRound: number
  rounds: ReportRoundAnalytics[]
  relayers: ReportRelayerAnalytics[]
}

/** Caller-owned cache for fetchReport. Pass from the process that owns the lifecycle to avoid module-level state. */
export interface ReportCache {
  fetchedAt: number
  source: string | null
  data: ReportData | null
}

export const REPORT_CACHE_MS = 5 * 60 * 1000

function getReportSource(config: NetworkConfig): string | null {
  const explicitPath = process.env.RELAYER_REPORT_PATH?.trim()
  if (explicitPath) return explicitPath

  const explicitUrl = process.env.RELAYER_REPORT_URL?.trim()
  if (explicitUrl) return explicitUrl

  if (config.name === "mainnet") return DEFAULT_MAINNET_REPORT_URL
  return null
}

export async function fetchReport(
  config: NetworkConfig,
  cache?: ReportCache | null,
): Promise<ReportData | null> {
  const source = getReportSource(config)
  if (!source) return null

  if (
    cache &&
    cache.source === source &&
    cache.fetchedAt > 0 &&
    Date.now() - cache.fetchedAt < REPORT_CACHE_MS
  ) {
    return cache.data
  }

  try {
    let data: ReportData

    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source, { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      data = (await res.json()) as ReportData
    } else {
      const fs = require("fs") as typeof import("fs")
      data = JSON.parse(fs.readFileSync(source, "utf-8")) as ReportData
    }

    if (cache) {
      cache.source = source
      cache.data = data
      cache.fetchedAt = Date.now()
    }
    return data
  } catch {
    if (cache) {
      cache.source = source
      cache.data = null
      cache.fetchedAt = Date.now()
    }
    return null
  }
}
