import { NetworkConfig } from "./types"

const REPORT_CACHE_MS = 5 * 60 * 1000
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

const reportCache: {
  fetchedAt: number
  source: string | null
  data: ReportData | null
} = {
  fetchedAt: 0,
  source: null,
  data: null,
}

function getReportSource(config: NetworkConfig): string | null {
  const explicitPath = process.env.RELAYER_REPORT_PATH?.trim()
  if (explicitPath) return explicitPath

  const explicitUrl = process.env.RELAYER_REPORT_URL?.trim()
  if (explicitUrl) return explicitUrl

  if (config.name === "mainnet") return DEFAULT_MAINNET_REPORT_URL
  return null
}

export async function fetchReport(config: NetworkConfig): Promise<ReportData | null> {
  const source = getReportSource(config)
  if (!source) return null

  if (
    reportCache.source === source &&
    reportCache.fetchedAt > 0 &&
    Date.now() - reportCache.fetchedAt < REPORT_CACHE_MS
  ) {
    return reportCache.data
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

    reportCache.source = source
    reportCache.data = data
    reportCache.fetchedAt = Date.now()
    return data
  } catch {
    reportCache.source = source
    reportCache.data = null
    reportCache.fetchedAt = Date.now()
    return null
  }
}
