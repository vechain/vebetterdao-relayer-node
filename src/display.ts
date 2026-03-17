import chalk from "chalk"
import { RelayerSummary, CycleResult } from "./types"

function formatB3TR(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n) / 10n ** 16n
  return `${whole}.${frac.toString().padStart(2, "0")} B3TR`
}

function formatVOT3(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n) / 10n ** 16n
  return `${whole}.${frac.toString().padStart(2, "0")} VOT3`
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4)
}

function pct(num: bigint, den: bigint): string {
  if (den === 0n) return "—"
  return ((Number(num) / Number(den)) * 100).toFixed(2) + "%"
}

function stripAnsi(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length
}

function pad(left: string, right: string, width: number = 62): string {
  const gap = width - stripAnsi(left) - stripAnsi(right)
  return left + " ".repeat(Math.max(1, gap)) + right
}

function heading(text: string): string {
  return chalk.bold.cyan(text)
}

function label(text: string): string {
  return chalk.dim(text)
}

export function renderSummary(s: RelayerSummary): string {
  const out: string[] = []

  out.push("")
  out.push(heading("  VeBetterDAO Relayer Node"))
  out.push(chalk.dim("  " + "─".repeat(60)))
  out.push("")

  // Node info
  const regStatus = s.isRegistered ? chalk.green("Registered") : chalk.red("Not registered")
  out.push("  " + pad(label("Network") + "  " + chalk.white.bold(s.network), label("Block") + " " + chalk.white(s.latestBlock.toLocaleString())))
  out.push("  " + pad(label("Node") + "     " + chalk.gray(new URL(s.nodeUrl).hostname), ""))
  out.push("  " + pad(label("Address") + "  " + chalk.yellow(shortAddr(s.relayerAddress)), regStatus))

  out.push("")
  out.push(chalk.dim("  " + "─".repeat(60)))
  out.push("")

  // Round info
  const roundStatus = s.isRoundActive ? chalk.green("Active") : chalk.dim("Ended")
  out.push("  " + heading(`Round #${s.currentRoundId}`) + "  " + roundStatus)
  out.push("  " + pad(label("Snapshot") + "  " + chalk.white(s.roundSnapshot.toString()), label("Deadline") + "  " + chalk.white(s.roundDeadline.toString())))
  out.push("  " + pad(label("Auto-voters") + " " + chalk.white.bold(s.autoVotingUsers.toString()), label("Relayers") + " " + chalk.white.bold(s.registeredRelayers.length.toString())))
  out.push("  " + pad(label("Voters") + "      " + chalk.white(s.totalVoters.toString()), label("Total") + " " + chalk.cyan(formatVOT3(s.totalVotes))))

  out.push("")
  out.push(chalk.dim("  " + "─".repeat(60)))
  out.push("")

  // Fee config
  const feeStr = s.feeDenominator > 0n ? pct(s.feePercentage, s.feeDenominator) : "—"
  out.push("  " + pad(label("Vote Weight") + "  " + chalk.white.bold(s.voteWeight.toString()), label("Claim Weight") + " " + chalk.white.bold(s.claimWeight.toString())))
  out.push("  " + pad(label("Fee") + "          " + chalk.yellow(feeStr), label("Cap") + " " + chalk.yellow(formatB3TR(s.feeCap))))
  out.push("  " + pad(label("Early Access") + " " + chalk.white(s.earlyAccessBlocks.toString()) + chalk.dim(" blocks"), ""))

  out.push("")
  out.push(chalk.dim("  " + "─".repeat(60)))
  out.push("")

  // This round stats
  out.push("  " + heading("This Round"))
  const completionPct = s.currentTotalWeighted > 0n
    ? pct(s.currentCompletedWeighted, s.currentTotalWeighted)
    : "—"
  const completionColor = s.currentTotalWeighted > 0n && s.currentCompletedWeighted >= s.currentTotalWeighted
    ? chalk.green : chalk.yellow
  out.push("  " + pad(
    label("Completion") + " " + completionColor(completionPct),
    label("Missed") + " " + (s.currentMissedUsers > 0n ? chalk.red(s.currentMissedUsers.toString()) : chalk.green(s.currentMissedUsers.toString())),
  ))
  out.push("  " + pad(
    label("Pool") + "       " + chalk.green(formatB3TR(s.currentTotalRewards)),
    label("Your share") + " " + chalk.greenBright.bold(formatB3TR(s.currentRelayerClaimable)),
  ))
  out.push("  " + pad(
    label("Actions") + "    " + chalk.white(s.currentRelayerActions.toString()) + chalk.dim(" (wt: ") + chalk.white(s.currentRelayerWeighted.toString()) + chalk.dim(")"),
    label("Total") + " " + chalk.white(s.currentTotalActions.toString()),
  ))

  // Previous round
  if (s.previousRoundId > 0) {
    out.push("")
    out.push(chalk.dim("  " + "─".repeat(60)))
    out.push("")
    const claimStatus = s.previousRewardClaimable ? chalk.green("Claimable") : chalk.dim("Not yet")
    out.push("  " + heading(`Previous Round #${s.previousRoundId}`))
    out.push("  " + pad(
      label("Pool") + "       " + chalk.green(formatB3TR(s.previousTotalRewards)),
      label("Your share") + " " + chalk.greenBright.bold(formatB3TR(s.previousRelayerClaimable)),
    ))
    out.push("  " + pad(
      label("Actions") + "    " + chalk.white(s.previousRelayerActions.toString()),
      claimStatus,
    ))
  }

  out.push("")
  return out.join("\n")
}

export function renderCycleResult(r: CycleResult): string[] {
  const lines: string[] = []
  const label = r.phase === "vote" ? "Cast-vote" : "Claim"
  const dryTag = r.dryRun ? chalk.yellow(" (DRY RUN)") : ""

  if (r.totalUsers === 0) {
    lines.push(`${label} round #${r.roundId}: ${chalk.dim("no users")}${dryTag}`)
    return lines
  }

  const ratio = r.successful === r.totalUsers
    ? chalk.green.bold(`${r.successful}/${r.totalUsers}`)
    : chalk.yellow(`${r.successful}/${r.totalUsers}`)
  lines.push(`${label} round #${r.roundId}: ${ratio} successful${dryTag}`)

  if (r.failed.length > 0)
    lines.push(chalk.red(`  ${r.failed.length} failed`) + chalk.gray(` (${r.failed.slice(0, 3).map((f) => shortAddr(f.user)).join(", ")}${r.failed.length > 3 ? "..." : ""})`))

  if (r.transient.length > 0)
    lines.push(chalk.yellow(`  ${r.transient.length} transient failures`))

  if (r.txIds.length > 0 && !r.dryRun)
    lines.push(chalk.gray(`  txs: ${r.txIds.map((t) => t.slice(0, 10) + "...").join(", ")}`))

  return lines
}

export function timestamp(): string {
  return chalk.gray(`[${new Date().toLocaleTimeString()}]`)
}
