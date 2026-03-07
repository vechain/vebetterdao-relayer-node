import chalk from "chalk"
import { RelayerSummary, CycleResult } from "./types"

const W = 66

function formatB3TR(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n) / 10n ** 16n
  return `${whole}.${frac.toString().padStart(2, "0")} B3TR`
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4)
}

function pct(num: bigint, den: bigint): string {
  if (den === 0n) return "—"
  return ((Number(num) / Number(den)) * 100).toFixed(2) + "%"
}

function pad(left: string, right: string, width: number = W - 4): string {
  const gap = width - left.length - right.length
  return left + " ".repeat(Math.max(1, gap)) + right
}

function line(content: string): string {
  const inner = content.padEnd(W - 4)
  return `║ ${inner} ║`
}

function sep(): string {
  return "╠" + "═".repeat(W - 2) + "╣"
}

export function renderSummary(s: RelayerSummary): string {
  const out: string[] = []
  const top = "╔" + "═".repeat(W - 2) + "╗"
  const bot = "╚" + "═".repeat(W - 2) + "╝"

  const title = "VeBetterDAO Relayer Node"
  const titlePad = Math.floor((W - 4 - title.length) / 2)

  out.push(top)
  out.push(line(" ".repeat(titlePad) + chalk.bold.cyan(title)))
  out.push(sep())

  const status = s.isRegistered ? chalk.green("✓ Registered") : chalk.red("✗ Not registered")
  out.push(line(pad("Network    " + chalk.white(s.network), "Block  " + chalk.white(s.latestBlock.toLocaleString()))))
  out.push(line(pad("Node       " + chalk.gray(new URL(s.nodeUrl).hostname), "")))
  out.push(line(pad("Address    " + chalk.yellow(shortAddr(s.relayerAddress)), status)))

  out.push(sep())

  const roundStatus = s.isRoundActive ? chalk.green("● Active") : chalk.gray("○ Ended")
  out.push(line(chalk.bold(`ROUND #${s.currentRoundId}`) + "  " + roundStatus))
  out.push(line(pad(`Snapshot   ${s.roundSnapshot}`, `Deadline   ${s.roundDeadline}`)))
  out.push(line(pad(`Auto-voters  ${chalk.white(s.autoVotingUsers.toString())}`, `Relayers   ${chalk.white(s.registeredRelayers.length.toString())}`)))
  out.push(line(pad(`Voters     ${chalk.white(s.totalVoters.toString())}`, `Total VOT3 ${chalk.white(formatB3TR(s.totalVotes))}`)))

  out.push(sep())

  const feeStr = s.feeDenominator > 0n ? pct(s.feePercentage, s.feeDenominator) : "—"
  out.push(line(pad(`Vote Wt    ${s.voteWeight}`, `Claim Wt   ${s.claimWeight}`)))
  out.push(line(pad(`Fee        ${feeStr}`, `Cap        ${formatB3TR(s.feeCap)}`)))
  out.push(line(pad(`Early Access  ${s.earlyAccessBlocks} blocks`, "")))

  out.push(sep())
  out.push(line(chalk.bold("THIS ROUND")))

  const completionPct = s.currentTotalWeighted > 0n
    ? pct(s.currentCompletedWeighted, s.currentTotalWeighted)
    : "—"
  out.push(line(pad(
    `Completion ${completionPct}`,
    `Missed     ${s.currentMissedUsers}`,
  )))
  out.push(line(pad(
    `Pool       ${chalk.green(formatB3TR(s.currentTotalRewards))}`,
    `Your share ${chalk.green(formatB3TR(s.currentRelayerClaimable))}`,
  )))
  out.push(line(pad(
    `Actions    ${s.currentRelayerActions} (wt: ${s.currentRelayerWeighted})`,
    `Total acts ${s.currentTotalActions}`,
  )))

  if (s.previousRoundId > 0) {
    out.push(line(""))
    out.push(line(chalk.bold(`PREVIOUS ROUND #${s.previousRoundId}`)))
    const claimStatus = s.previousRewardClaimable ? chalk.green("✓ Claimable") : chalk.gray("✗ Not yet")
    out.push(line(pad(
      `Pool       ${chalk.green(formatB3TR(s.previousTotalRewards))}`,
      `Your share ${chalk.green(formatB3TR(s.previousRelayerClaimable))}`,
    )))
    out.push(line(pad(
      `Actions    ${s.previousRelayerActions}`,
      claimStatus,
    )))
  }

  out.push(bot)
  return out.join("\n")
}

export function renderCycleResult(r: CycleResult): string[] {
  const lines: string[] = []
  const label = r.phase === "vote" ? "Cast-vote" : "Claim"
  const dryTag = r.dryRun ? chalk.yellow(" (DRY RUN)") : ""

  if (r.totalUsers === 0) {
    lines.push(`${label} round #${r.roundId}: no users${dryTag}`)
    return lines
  }

  lines.push(`${label} round #${r.roundId}: ${chalk.green(r.successful.toString())}/${r.totalUsers} successful${dryTag}`)

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
