import chalk from "chalk";
import { RelayerSummary, CycleResult } from "./types";

function formatB3TR(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 16n;
  return `${whole.toLocaleString("en-US")}.${frac
    .toString()
    .padStart(2, "0")} B3TR`;
}

function formatVOT3(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 16n;
  return `${whole.toLocaleString("en-US")}.${frac
    .toString()
    .padStart(2, "0")} VOT3`;
}

function formatVTHO(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n) / 10n ** 16n;
  return `${whole.toLocaleString("en-US")}.${frac
    .toString()
    .padStart(2, "0")} VTHO`;
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function pct(num: bigint, den: bigint): string {
  if (den === 0n) return "—";
  return ((Number(num) / Number(den)) * 100).toFixed(2) + "%";
}

function stripAnsi(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(left: string, right: string, width: number = 72): string {
  const gap = width - stripAnsi(left) - stripAnsi(right);
  return left + " ".repeat(Math.max(1, gap)) + right;
}

function heading(text: string): string {
  return chalk.bold.cyan(text);
}

function label(text: string): string {
  return chalk.dim(text);
}

function formatProgress(done: number, total: number): string {
  return `${done.toLocaleString("en-US")}/${total.toLocaleString("en-US")}`;
}

function formatPercent(done: number, total: number): string {
  if (total <= 0) return "100.00%";
  return `${((done / total) * 100).toFixed(2)}%`;
}

function phaseTag(phase: CycleResult["phase"]): string {
  return phase === "vote"
    ? chalk.bgCyan.black(" VOTE ")
    : chalk.bgMagenta.black(" CLAIM ");
}

function formatBlockTime(timestamp: number | null): string {
  if (timestamp == null) return "—";
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function renderSummary(s: RelayerSummary, version?: string): string {
  const out: string[] = [];
  const totalPlannedActions =
    s.currentEligibleVoters + s.previousEligibleClaims;
  const completedActions = s.currentVotedCount + s.previousClaimedCount;
  const completionPct = formatPercent(completedActions, totalPlannedActions);
  const completionDone =
    totalPlannedActions === 0 || completedActions >= totalPlannedActions;
  const completionColor = completionDone ? chalk.green : chalk.yellow;
  const currentWeightPct =
    s.currentCompletedWeighted > 0n
      ? pct(s.currentRelayerWeighted, s.currentCompletedWeighted)
      : "—";
  const previousWeightPct =
    s.previousCompletedWeighted > 0n
      ? pct(s.previousRelayerWeighted, s.previousCompletedWeighted)
      : "—";
  const currentPoolLabel = s.isRoundActive ? "Est. Reward Pool" : "Pool";
  const currentPoolValue = s.isRoundActive
    ? s.currentEstimatedPool
    : s.currentTotalRewards;
  const earlyAccessLabel =
    s.currentEarlyAccessRemainingBlocks > 0
      ? `${s.currentEarlyAccessRemainingBlocks.toLocaleString("en-US")} blocks`
      : "ended";
  const previousRewardsLine =
    s.previousRelayerClaimable > 0n
      ? `${formatB3TR(s.previousRelayerClaimable)} ${chalk.dim(
          "(need claiming)",
        )}`
      : s.previousRelayerClaimed > 0n
      ? `${formatB3TR(s.previousRelayerClaimed)} ${chalk.dim("(claimed)")}`
      : formatB3TR(0n);

  out.push("");
  out.push(
    heading(`  VeBetterDAO Relayer Node${version ? ` v${version}` : ""}`),
  );
  out.push(chalk.dim("  " + "─".repeat(80)));
  out.push("");

  out.push("  " + heading("Network"));
  out.push(
    "  " +
      pad(
        label("Network") + " " + chalk.white.bold(s.network),
        label("Current Block") +
          " " +
          chalk.white(s.latestBlock.toLocaleString()),
      ),
  );
  out.push(
    "  " +
      pad(
        label("Node") + " " + chalk.gray(new URL(s.nodeUrl).hostname),
        label("Total Relayers") +
          " " +
          chalk.white.bold(s.registeredRelayers.length.toString()),
      ),
  );

  out.push("");
  out.push(chalk.dim("  " + "─".repeat(80)));
  out.push("");

  out.push("  " + heading("Your Relayer"));
  out.push(
    "  " +
      pad(
        label("Address") + " " + chalk.yellow(shortAddr(s.relayerAddress)),
        s.isRegistered
          ? chalk.green("Registered")
          : chalk.red("Not registered"),
      ),
  );
  out.push(
    "  " +
      pad(
        label("Available to claim") +
          " " +
          chalk.greenBright.bold(formatB3TR(s.relayerAvailableToClaim)),
        "",
      ),
  );
  out.push(
    "  " +
      label("Total earned") +
      " " +
      chalk.green(formatB3TR(s.relayerLifetimeEarned)),
  );

  out.push(
    "  " +
      label("Total spent") +
      " " +
      chalk.yellow(formatVTHO(s.relayerLifetimeSpent)),
  );

  out.push(
    "  " +
      pad(
        label("Total actions") +
          " " +
          chalk.white(
            `${s.relayerLifetimeVotes.toLocaleString(
              "en-US",
            )} votes + ${s.relayerLifetimeClaims.toLocaleString(
              "en-US",
            )} claims`,
          ),
        "",
      ),
  );

  out.push("");
  out.push(chalk.dim("  " + "─".repeat(80)));
  out.push("");

  out.push(
    "  " +
      heading(`Current Round (#${s.currentRoundId})`) +
      "  " +
      (s.isRoundActive ? chalk.green("Active") : chalk.dim("Ended")),
  );
  out.push(
    "  " +
      pad(
        label("Snapshot") +
          " " +
          chalk.white(s.roundSnapshot.toLocaleString("en-US")) +
          chalk.dim(` (${formatBlockTime(s.roundSnapshotTimestamp)})`),
        label("Deadline") +
          " " +
          chalk.white(s.roundDeadline.toLocaleString("en-US")) +
          chalk.dim(` (${formatBlockTime(s.roundDeadlineTimestamp)})`),
      ),
  );
  out.push(
    "  " +
      pad(
        label("Users with autovoting") +
          " " +
          chalk.white.bold(s.autoVotingUsers.toString()),
        label("Total users") + " " + chalk.white(s.totalVoters.toString()),
      ),
  );
  out.push(
    "  " +
      pad(
        label("Votes") +
          "      " +
          chalk.white.bold(
            formatProgress(s.currentVotedCount, s.currentEligibleVoters),
          ),
        label("Claims (prev)") +
          " " +
          chalk.white.bold(
            formatProgress(s.previousClaimedCount, s.previousEligibleClaims),
          ),
      ),
  );
  out.push("  " + label("Completion") + " " + completionColor(completionPct));
  out.push(
    "  " + label("Early access ends in") + " " + chalk.white(earlyAccessLabel),
  );

  out.push("");
  out.push("  " + label("Your Activity"));
  out.push(
    "  " +
      label("Weight") +
      " " +
      chalk.greenBright.bold(currentWeightPct) +
      chalk.dim(" of completed"),
  );
  out.push(
    "  " +
      label("Actions performed") +
      " " +
      chalk.white(
        `${s.currentVotesPerformed} votes + ${s.currentClaimsPerformed} claims`,
      ) +
      chalk.dim(` (wt: ${s.currentRelayerWeighted.toString()})`),
  );

  out.push(
    label("  " + "Est. Rewards") +
      " " +
      chalk.greenBright.bold(formatB3TR(s.currentEstimatedRewards)),
  );

  out.push(
    "  " +
      label(currentPoolLabel) +
      " " +
      chalk.green(formatB3TR(currentPoolValue)),
  );

  out.push(
    "  " +
      label("Total spent") +
      " " +
      chalk.yellow(formatVTHO(s.currentSpent)),
  );

  if (s.previousRoundId > 0) {
    out.push("");
    out.push(chalk.dim("  " + "─".repeat(80)));
    out.push("");

    out.push("  " + heading(`Previous Round (#${s.previousRoundId})`));
    out.push(
      "  " +
        pad(
          label("Status") +
            " " +
            (s.previousRewardClaimable
              ? chalk.green("claimable")
              : chalk.dim("not claimable")),
          "",
        ),
    );
    out.push(
      "  " +
        pad(
          label("Votes") +
            " " +
            chalk.white.bold(
              formatProgress(s.previousVotedCount, s.previousEligibleVoters),
            ),
          label("Claims") +
            " " +
            chalk.white.bold(
              formatProgress(s.previousClaimedCount, s.previousEligibleClaims),
            ),
        ),
    );
    out.push(
      "  " +
        pad(
          label("Your weight") +
            " " +
            chalk.greenBright.bold(previousWeightPct) +
            chalk.dim(" of completed"),
          "",
        ),
    );
    out.push(
      "  " +
        pad(
          label("Actions performed") +
            " " +
            chalk.white(
              `${s.previousVotesPerformed} votes + ${s.previousClaimsPerformed} claims`,
            ) +
            chalk.dim(` (wt: ${s.previousRelayerWeighted.toString()})`),
          "",
        ),
    );
    out.push(
      "  " +
        label("Pool rewards") +
        " " +
        chalk.green(formatB3TR(s.previousTotalRewards)),
    );
    out.push(
      "  " +
        label("Your rewards") +
        " " +
        chalk.greenBright.bold(previousRewardsLine),
    );
    out.push(
      "  " +
        label("Total spent") +
        " " +
        chalk.yellow(formatVTHO(s.previousSpent)),
    );
  }

  out.push("");
  out.push(chalk.dim("  " + "─".repeat(80)));
  out.push("");

  const feeStr =
    s.feeDenominator > 0n ? pct(s.feePercentage, s.feeDenominator) : "—";
  out.push("  " + heading("Rules"));
  out.push(
    "  " +
      pad(
        label("Vote Weight") + " " + chalk.white.bold(s.voteWeight.toString()),
        label("Claim Weight") +
          " " +
          chalk.white.bold(s.claimWeight.toString()),
      ),
  );
  out.push(
    "  " +
      pad(
        label("Fee") + " " + chalk.yellow(feeStr),
        label("Cap") + " " + chalk.yellow(formatB3TR(s.feeCap)),
      ),
  );
  out.push(
    "  " +
      pad(
        label("Early Access") +
          " " +
          chalk.white(s.earlyAccessBlocks.toString()) +
          chalk.dim(" blocks"),
        "",
      ),
  );

  out.push("");
  return out.join("\n");
}

export function renderCycleResult(r: CycleResult): string[] {
  const lines: string[] = [];
  const dryTag = r.dryRun ? chalk.yellow(" DRY RUN") : "";
  const divider = chalk.dim("─".repeat(80));

  lines.push(divider);

  if (r.totalUsers === 0) {
    lines.push(
      `${phaseTag(r.phase)} ${chalk.white(`Round #${r.roundId}`)}  ${chalk.dim(
        "no users discovered",
      )}${dryTag}`,
    );
    return lines;
  }

  if (r.actionableUsers === 0) {
    lines.push(
      `${phaseTag(r.phase)} ${chalk.white(
        `Round #${r.roundId}`,
      )}  ${chalk.green("nothing pending")}${dryTag}${chalk.dim(
        ` (${r.totalUsers} snapshot users)`,
      )} `,
    );
    return lines;
  }

  const failedCount = r.failed.length;
  const retryableCount = r.pendingUsers;
  const doneCount = r.actionableUsers - retryableCount;
  const doneRatio =
    doneCount === r.actionableUsers && failedCount === 0
      ? chalk.green.bold(`${doneCount}/${r.actionableUsers}`)
      : chalk.yellow.bold(`${doneCount}/${r.actionableUsers}`);

  lines.push(
    `${phaseTag(r.phase)} ${chalk.white(
      `Round #${r.roundId}`,
    )}  ${doneRatio} ${chalk.dim("resolved")}  ${
      failedCount > 0
        ? chalk.red(`${failedCount} failed`)
        : chalk.green("0 failed")
    }  ${
      retryableCount > 0
        ? chalk.yellow(`${retryableCount} retryable`)
        : chalk.green("0 retryable")
    }${dryTag}`,
  );

  if (r.failed.length > 0)
    lines.push(
      chalk.red(
        `  failed: ${r.failed
          .slice(0, 3)
          .map((f) => shortAddr(f.user))
          .join(", ")}${r.failed.length > 3 ? "..." : ""}`,
      ),
    );

  if (r.transient.length > 0)
    lines.push(
      chalk.yellow(
        `  retry: ${r.transient
          .slice(0, 3)
          .map((f) => shortAddr(f.user))
          .join(", ")}${r.transient.length > 3 ? "..." : ""}`,
      ),
    );

  if (r.txIds.length > 0 && !r.dryRun)
    lines.push(
      chalk.gray(
        `  txs: ${r.txIds.map((t) => t.slice(0, 10) + "...").join(", ")}`,
      ),
    );

  return lines;
}

export function timestamp(): string {
  return chalk.gray(`[${new Date().toLocaleTimeString()}]`);
}
