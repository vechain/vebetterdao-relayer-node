import chalk from "chalk"
import { version as PKG_VERSION } from "../package.json"
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

function dimLabel(text: string): string {
  return chalk.dim(text)
}

function divider(): string {
  return chalk.dim("  " + "─".repeat(60))
}

// ── Status computation ───────────────────────────────────────

interface RoundStatus {
  label: string
  render: string
  hint: string
}

/**
 * Current (active) round status.
 * During the active round only voting can happen.
 * Each eligible user = voteWeight(3) + claimWeight(1) = 4 weighted points.
 * Voting done when completedWeighted >= totalWeighted * 3/4.
 */
function getCurrentRoundStatus(s: RelayerSummary): RoundStatus {
  if (s.autoVotingUsers === 0) {
    return {
      label: "N/A",
      render: chalk.gray("N/A"),
      hint: "No auto-voting users registered for this round.",
    }
  }
  if (!s.isRoundActive) {
    return {
      label: "Voting complete",
      render: chalk.blue("Voting complete"),
      hint: "Round ended. Waiting for new round to start.",
    }
  }

  const votingPortion = s.currentTotalWeighted * 3n / 4n
  if (s.currentTotalWeighted > 0n && s.currentCompletedWeighted >= votingPortion) {
    return {
      label: "Voting complete",
      render: chalk.blue("Voting complete"),
      hint: "All votes cast. Waiting for round to end to start claiming rewards.",
    }
  }

  return {
    label: "Voting in progress",
    render: chalk.yellow("Voting in progress"),
    hint: "Cast votes for remaining users.",
  }
}

/**
 * Previous round status.
 * After a round ends, relayers claim rewards for users.
 * The pool unlocks only when ALL actions (votes + claims) are completed.
 */
function getPreviousRoundStatus(s: RelayerSummary): RoundStatus {
  if (s.previousRoundId === 0 || s.previousTotalWeighted === 0n) {
    return {
      label: "N/A",
      render: chalk.gray("N/A"),
      hint: "No auto-voting users were registered for this round.",
    }
  }

  if (s.previousRewardClaimable) {
    const hasShare = s.previousRelayerClaimable > 0n
    return {
      label: "Actions completed",
      render: chalk.green("Actions completed"),
      hint: hasShare
        ? "All actions done. Pool unlocked — claim your relayer rewards!"
        : "All actions done. Pool unlocked.",
    }
  }

  const votingPortion = s.previousTotalWeighted * 3n / 4n
  if (s.previousCompletedWeighted < votingPortion) {
    return {
      label: "Rewards Locked",
      render: chalk.red("Rewards Locked"),
      hint: "Some users were never voted for. Pool is locked — no relayer can claim rewards.",
    }
  }

  return {
    label: "Claiming in progress",
    render: chalk.magenta("Claiming in progress"),
    hint: "All votes done. Claim rewards for remaining users to unlock the pool.",
  }
}

// ── Rendering ────────────────────────────────────────────────

export function renderSummary(s: RelayerSummary): string {
  const out: string[] = []

  // Header
  out.push("")
  out.push(heading("  VeBetterDAO Relayer Node") + "  " + chalk.dim(`v${PKG_VERSION}`))
  out.push(divider())
  out.push("")

  const regStatus = s.isRegistered ? chalk.green("Registered") : chalk.red("Not registered")
  out.push("  " + pad(dimLabel("Network") + "  " + chalk.white.bold(s.network), dimLabel("Block") + " " + chalk.white(s.latestBlock.toLocaleString())))
  out.push("  " + pad(dimLabel("Node") + "     " + chalk.gray(new URL(s.nodeUrl).hostname), ""))
  out.push("  " + pad(dimLabel("Address") + "  " + chalk.yellow(shortAddr(s.relayerAddress)), regStatus))
  if (!s.isRegistered) {
    out.push("  " + chalk.red.italic("  Go to relayer.vebetterdao.org/new-relayer to register as a relayer"))
  }

  out.push("")
  out.push(divider())
  out.push("")

  // Config (compact)
  const feeStr = s.feeDenominator > 0n ? pct(s.feePercentage, s.feeDenominator) : "—"
  out.push("  " + pad(
    dimLabel("Weights") + "  " + chalk.white("vote=" + s.voteWeight.toString()) + chalk.dim(" / ") + chalk.white("claim=" + s.claimWeight.toString()),
    dimLabel("Fee") + " " + chalk.yellow(feeStr) + chalk.dim(" cap ") + chalk.yellow(formatB3TR(s.feeCap)),
  ))

  // ── Current Round ─────────────────────────────────────────

  out.push("")
  out.push(divider())
  out.push("")

  const currentStatus = getCurrentRoundStatus(s)
  out.push("  " + heading(`Round #${s.currentRoundId}`) + "  " + currentStatus.render)
  out.push("  " + chalk.italic.dim("  " + currentStatus.hint))
  out.push("")
  out.push("  " + pad(dimLabel("Auto-voters") + " " + chalk.white.bold(s.autoVotingUsers.toString()), dimLabel("Relayers") + " " + chalk.white.bold(s.registeredRelayers.length.toString())))
  out.push("  " + pad(dimLabel("Voters") + "      " + chalk.white(s.totalVoters.toString()), ""))
  out.push("  " + pad(dimLabel("Snapshot") + "    " + chalk.white(s.roundSnapshot.toString()), dimLabel("Deadline") + " " + chalk.white(s.roundDeadline.toString())))

  // Early access: voting window = snapshot + earlyAccessBlocks
  const voteEaEnd = s.roundSnapshot + Number(s.earlyAccessBlocks)
  const voteEaRemaining = voteEaEnd - s.latestBlock
  if (voteEaRemaining > 0) {
    out.push("  " + dimLabel("Early access") + " " + chalk.white("ends in " + voteEaRemaining.toLocaleString() + " blocks"))
  } else {
    out.push("  " + dimLabel("Early access") + " " + chalk.dim("ended"))
  }

  out.push("")

  // Voting progress
  const votingPortion = s.currentTotalWeighted > 0n ? s.currentTotalWeighted * 3n / 4n : 0n
  const cappedVoting = s.currentCompletedWeighted > votingPortion ? votingPortion : s.currentCompletedWeighted
  const votingPctStr = votingPortion > 0n ? pct(cappedVoting, votingPortion) : "—"
  const votingDone = votingPortion > 0n && s.currentCompletedWeighted >= votingPortion
  const votingColor = votingDone ? chalk.green : chalk.yellow
  out.push("  " + pad(
    dimLabel("Voting") + "      " + votingColor(votingPctStr),
    "",
  ))

  // Projected share % based on weighted actions so far
  const projectedShareStr = s.currentTotalWeighted > 0n && s.currentRelayerWeighted > 0n
    ? pct(s.currentRelayerWeighted, s.currentTotalWeighted)
    : "—"
  out.push("  " + pad(
    dimLabel("Your actions") + " " + chalk.white(s.currentRelayerActions.toString()) + chalk.dim(" (wt: ") + chalk.white(s.currentRelayerWeighted.toString()) + chalk.dim(")"),
    dimLabel("Est. share") + " " + chalk.cyan(projectedShareStr),
  ))

  // ── Previous Round ────────────────────────────────────────

  if (s.previousRoundId > 0) {
    out.push("")
    out.push(divider())
    out.push("")

    const prevStatus = getPreviousRoundStatus(s)
    out.push("  " + heading(`Round #${s.previousRoundId}`) + "  " + prevStatus.render)
    out.push("  " + chalk.italic.dim("  " + prevStatus.hint))

    // Claiming early access: deadline + earlyAccessBlocks
    if (prevStatus.label === "Claiming in progress") {
      const claimEaEnd = s.previousRoundDeadline + Number(s.earlyAccessBlocks)
      const claimEaRemaining = claimEaEnd - s.latestBlock
      if (claimEaRemaining > 0) {
        out.push("  " + dimLabel("  Early access") + " " + chalk.white("ends in " + claimEaRemaining.toLocaleString() + " blocks"))
      } else {
        out.push("  " + dimLabel("  Early access") + " " + chalk.dim("ended"))
      }
    }

    out.push("")

    // Progress
    if (s.previousTotalWeighted > 0n) {
      const overallPct = pct(s.previousCompletedWeighted, s.previousTotalWeighted)
      let progressColor: (s: string) => string
      if (prevStatus.label === "Actions completed") progressColor = chalk.green
      else if (prevStatus.label === "Rewards Locked") progressColor = chalk.red
      else progressColor = chalk.magenta
      out.push("  " + pad(
        dimLabel("Progress") + "    " + progressColor(overallPct),
        dimLabel("Missed") + " " + (s.previousMissedUsers > 0n ? chalk.red(s.previousMissedUsers.toString()) : chalk.green(s.previousMissedUsers.toString())),
      ))
    }

    out.push("  " + pad(
      dimLabel("Pool") + "        " + chalk.green(formatB3TR(s.previousTotalRewards)),
      "",
    ))

    // Compute earned amount from weighted share, regardless of whether already claimed
    const earnedWei = s.previousCompletedWeighted > 0n && s.previousRelayerWeighted > 0n
      ? s.previousTotalRewards * s.previousRelayerWeighted / s.previousCompletedWeighted
      : 0n
    const alreadyClaimed = earnedWei > 0n && s.previousRelayerClaimable === 0n

    if (alreadyClaimed) {
      out.push("  " + pad(
        dimLabel("You earned") + "  " + chalk.greenBright.bold(formatB3TR(earnedWei)),
        chalk.green("✓ Claimed"),
      ))
    } else if (s.previousRelayerClaimable > 0n) {
      out.push("  " + pad(
        dimLabel("Your share") + "  " + chalk.greenBright.bold(formatB3TR(s.previousRelayerClaimable)),
        chalk.yellow("Unclaimed"),
      ))
    } else {
      out.push("  " + pad(
        dimLabel("Your share") + "  " + chalk.dim("0.00 B3TR"),
        "",
      ))
    }

    out.push("  " + pad(
      dimLabel("Your actions") + " " + chalk.white(s.previousRelayerActions.toString()) + chalk.dim(" (wt: ") + chalk.white(s.previousRelayerWeighted.toString()) + chalk.dim(")"),
      "",
    ))
  }

  out.push("")
  return out.join("\n")
}

export function logSectionHeader(phase: "vote" | "claim", roundId: number): string {
  const icon = phase === "vote" ? "🗳" : "💰"
  const label = phase === "vote" ? "Cast Vote" : "Claim Rewards"
  const text = ` ${icon}  ${label} · Round #${roundId} `
  const lineLen = 60 - text.length
  const left = Math.floor(lineLen / 2)
  const right = lineLen - left
  return chalk.bold("─".repeat(Math.max(1, left)) + text + "─".repeat(Math.max(1, right)))
}

export function renderCycleResult(r: CycleResult): string[] {
  const lines: string[] = []
  const tag = r.phase === "vote" ? chalk.cyan("Vote") : chalk.magenta("Claim")
  const dryTag = r.dryRun ? chalk.yellow(" (DRY RUN)") : ""

  if (r.totalUsers === 0) {
    lines.push(`${tag} ${chalk.dim("no users to process")}${dryTag}`)
    return lines
  }

  const ratio = r.successful === r.totalUsers
    ? chalk.green.bold(`${r.successful}/${r.totalUsers}`)
    : chalk.yellow(`${r.successful}/${r.totalUsers}`)
  lines.push(`${tag} ${ratio} successful${dryTag}`)

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
