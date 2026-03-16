#!/usr/bin/env node

/**
 * VeBetterDAO Relayer Node
 *
 * Env:
 *   MNEMONIC             BIP39 phrase (space-separated)
 *   RELAYER_PRIVATE_KEY   Hex private key (alternative to MNEMONIC)
 *   RELAYER_NETWORK       mainnet | testnet-staging (default: mainnet)
 *   NODE_URL              Override Thor node URL
 *   BATCH_SIZE            Votes/claims per batch (default: 50)
 *   DRY_RUN               1/true to simulate only
 *   POLL_INTERVAL_MS      Ms between cycles (default: 300000 = 5 min)
 *   RUN_ONCE              1/true to run one cycle and exit
 *
 * Docker secrets (mounted at /run/secrets/<name>) are used as fallbacks
 * when the corresponding env var is not set.
 */

import * as fs from "fs"
import { ThorClient } from "@vechain/sdk-network"
import { Address, HDKey } from "@vechain/sdk-core"
import chalk from "chalk"
import { getNetworkConfig } from "./config"
import { fetchSummary } from "./summary"
import type { ReportCache } from "./report"
import { runCastVoteCycle, runClaimRewardCycle } from "./relayer"
import { CycleResult, RelayerSummary } from "./types"
import { renderSummary, renderCycleResult, timestamp } from "./display"

const { version: APP_VERSION = "unknown" } = require("../package.json") as {
  version?: string
}
const reportCache: ReportCache = { fetchedAt: 0, source: null, data: null }

const BLOCK_TIME_MS = 10_000
const MIN_POLL_MS = 60_000
const MAX_IDLE_POLL_MS = 60 * 60 * 1000

const SECRETS_DIR = "/run/secrets"
const ALLOWED_SECRETS = new Set(["mnemonic", "relayer_private_key"])

/**
 * Read a Docker secret file. Only allows names from ALLOWED_SECRETS to
 * prevent path-traversal attacks. Returns the trimmed content, or undefined
 * if the file doesn't exist or isn't readable.
 */
function readSecret(name: string): string | undefined {
  if (!ALLOWED_SECRETS.has(name)) return undefined
  const secretPath = `${SECRETS_DIR}/${name}`
  try {
    return fs.readFileSync(secretPath, "utf-8").trim()
  } catch {
    return undefined
  }
}

/**
 * Resolve a config value: env var first, then Docker secret fallback.
 */
function envOrSecret(envKey: string, secretName: string): string | undefined {
  return process.env[envKey]?.trim() || readSecret(secretName)
}

function getWallet(): { walletAddress: string; privateKey: string } {
  const pk = envOrSecret("RELAYER_PRIVATE_KEY", "relayer_private_key")
  if (pk) {
    const clean = pk.startsWith("0x") ? pk.slice(2) : pk;
    return {
      walletAddress: Address.ofPrivateKey(Buffer.from(clean, "hex")).toString(),
      privateKey: clean,
    };
  }
  const mnemonic = envOrSecret("MNEMONIC", "mnemonic")
  const words = mnemonic?.split(/\s+/)
  if (!words?.length) {
    console.error(chalk.red("Set MNEMONIC or RELAYER_PRIVATE_KEY (env var or Docker secret)"))
    process.exit(1)
  }
  const child = HDKey.fromMnemonic(words).deriveChild(0);
  const raw = child.privateKey;
  if (!raw) {
    console.error(chalk.red("Failed to derive private key from mnemonic"));
    process.exit(1);
  }
  return {
    walletAddress: Address.ofPublicKey(
      child.publicKey as Uint8Array,
    ).toString(),
    privateKey: Buffer.from(raw).toString("hex"),
  };
}

function envBool(key: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[key] || "");
}

const activityLog: string[] = [];
const MAX_LOG = 200;

function log(msg: string) {
  if (msg === "") {
    activityLog.push("");
    if (activityLog.length > MAX_LOG) activityLog.shift();
    console.log("");
    return;
  }

  const entry = `${timestamp()} ${msg}`;
  activityLog.push(entry);
  if (activityLog.length > MAX_LOG) activityLog.shift();
  console.log(entry);
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function printSummary(summary: RelayerSummary) {
  console.log("");
  console.log(renderSummary(summary, APP_VERSION));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  if (ms >= 60 * 60 * 1000) return `${(ms / (60 * 60 * 1000)).toFixed(1)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function waitUntilBlock(currentBlock: number, targetBlock: number): number {
  const deltaBlocks = Math.max(0, targetBlock - currentBlock);
  const rawWaitMs = deltaBlocks * BLOCK_TIME_MS;
  return Math.max(MIN_POLL_MS, Math.min(MAX_IDLE_POLL_MS, rawWaitMs));
}

function getCycleResult(
  results: CycleResult[],
  phase: CycleResult["phase"],
): CycleResult | undefined {
  return results.find((result) => result.phase === phase);
}

function computeNextPollMs(
  summary: RelayerSummary,
  results: CycleResult[],
  fallbackMs: number,
): { waitMs: number; reason: string } {
  const voteResult = getCycleResult(results, "vote");
  const claimResult = getCycleResult(results, "claim");
  const pendingUsers = results.reduce(
    (count, result) => count + result.pendingUsers,
    0,
  );
  if (pendingUsers > 0) {
    return {
      waitMs: fallbackMs,
      reason: `${pendingUsers} action${
        pendingUsers === 1 ? "" : "s"
      } still pending`,
    };
  }

  const earlyAccessBlocks = Number(summary.earlyAccessBlocks);
  const voteEarlyAccessEnd = summary.roundSnapshot + earlyAccessBlocks;
  if (summary.latestBlock < voteEarlyAccessEnd) {
    return {
      waitMs: waitUntilBlock(summary.latestBlock, voteEarlyAccessEnd),
      reason: `votes ${voteResult?.pendingUsers ?? 0} pending, claims ${
        claimResult?.pendingUsers ?? 0
      } pending; waiting for vote early access to end`,
    };
  }

  if (summary.previousRoundId > 0) {
    const claimEarlyAccessEnd =
      summary.previousRoundDeadline + earlyAccessBlocks;
    if (summary.latestBlock < claimEarlyAccessEnd) {
      return {
        waitMs: waitUntilBlock(summary.latestBlock, claimEarlyAccessEnd),
        reason: `votes ${voteResult?.pendingUsers ?? 0} pending, claims ${
          claimResult?.pendingUsers ?? 0
        } pending; waiting for claim early access to end`,
      };
    }
  }

  if (summary.isRoundActive && summary.latestBlock < summary.roundDeadline) {
    return {
      waitMs: waitUntilBlock(summary.latestBlock, summary.roundDeadline),
      reason: `votes ${voteResult?.pendingUsers ?? 0} pending, claims ${
        claimResult?.pendingUsers ?? 0
      } pending; early access passed, waiting for round #${
        summary.currentRoundId
      } to end`,
    };
  }

  return {
    waitMs: Math.max(fallbackMs, MAX_IDLE_POLL_MS),
    reason: `votes ${voteResult?.pendingUsers ?? 0} pending, claims ${
      claimResult?.pendingUsers ?? 0
    } pending; waiting for the next round check`,
  };
}

async function main() {
  const network = process.env.RELAYER_NETWORK || "mainnet";
  const config = getNetworkConfig(network, process.env.NODE_URL?.trim());
  const { walletAddress, privateKey } = getWallet();
  const batchSize = Math.max(
    1,
    parseInt(process.env.BATCH_SIZE || "50", 10) || 50,
  );
  const dryRun = envBool("DRY_RUN");
  const pollMs = Math.max(
    MIN_POLL_MS,
    parseInt(process.env.POLL_INTERVAL_MS || "300000", 10) || 300_000,
  );
  const runOnce = envBool("RUN_ONCE");

  const thor = ThorClient.at(config.nodeUrl, { isPollingEnabled: false });

  let running = true;
  let forceExit = false;
  const shutdown = () => {
    if (forceExit) {
      log(chalk.red("Force exit."));
      process.exit(1);
    }
    forceExit = true;
    running = false;
    log(
      chalk.yellow(
        "Shutting down after current operation... (press Ctrl+C again to force quit)",
      ),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const CYCLE_RETRIES = 3;
  const CYCLE_RETRY_MS = 3000;

  log(chalk.cyan(`Starting VeBetterDAO Relayer Node v${APP_VERSION}`));
  log(`Network: ${config.name} (${config.nodeUrl})`);
  log(
    `Relayer: ${shortAddr(walletAddress)}${
      dryRun ? chalk.yellow(" [dry run]") : ""
    }`,
  );

  while (running) {
    let lastErr: unknown;
    let nextPoll = { waitMs: pollMs, reason: "default poll interval" };
    for (let attempt = 1; attempt <= CYCLE_RETRIES; attempt++) {
      try {
        log(
          `Fetching summary for round monitoring${
            attempt > 1 ? ` (attempt ${attempt}/${CYCLE_RETRIES})` : ""
          } (could take a while)...`,
        );

        // Fetch and display summary
        const summary = await fetchSummary(thor, config, walletAddress, reportCache);
        printSummary(summary);

        // Run cycles
        const cycleResults: CycleResult[] = [];
        if (summary.isRoundActive) {
          log("");
          log("Starting cast-vote cycle...");
          const voteResult = await runCastVoteCycle(
            thor,
            config,
            walletAddress,
            privateKey,
            batchSize,
            dryRun,
            log,
          );
          cycleResults.push(voteResult);
          renderCycleResult(voteResult).forEach(log);
        } else {
          log("Round not active, skipping cast-vote");
        }

        log("");
        log("Starting claim cycle...");
        const claimResult = await runClaimRewardCycle(
          thor,
          config,
          walletAddress,
          privateKey,
          batchSize,
          dryRun,
          log,
        );
        cycleResults.push(claimResult);
        renderCycleResult(claimResult).forEach(log);

        // Re-fetch and display updated summary
        const updated = await fetchSummary(thor, config, walletAddress, reportCache);
        printSummary(updated);
        nextPoll = computeNextPollMs(updated, cycleResults, pollMs);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < CYCLE_RETRIES) {
          log(
            chalk.yellow(
              `Cycle attempt ${attempt}/${CYCLE_RETRIES} failed, retrying in ${
                CYCLE_RETRY_MS / 1000
              }s...`,
            ),
          );
          await sleep(CYCLE_RETRY_MS);
        }
      }
    }
    if (lastErr !== undefined) {
      log(
        chalk.red(
          `Cycle error: ${
            lastErr instanceof Error ? lastErr.message : String(lastErr)
          }`,
        ),
      );
    }

    if (runOnce) {
      log("Run once complete. Exiting.");
      break;
    }

    log("");
    log(
      `Next cycle in ${formatDuration(nextPoll.waitMs)} (${
        nextPoll.reason
      })...`,
    );
    await sleep(nextPoll.waitMs);
  }
}

main();
