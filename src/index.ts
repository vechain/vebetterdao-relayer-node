#!/usr/bin/env node

/**
 * VeBetterDAO Relayer Node
 *
 * Env:
 *   MNEMONIC             BIP39 phrase (space-separated)
 *   RELAYER_PRIVATE_KEY   Hex private key (alternative to MNEMONIC)
 *   RELAYER_NETWORK       mainnet | testnet-staging (default: testnet-staging)
 *   NODE_URL              Override Thor node URL
 *   BATCH_SIZE            Votes/claims per batch (default: 50)
 *   DRY_RUN               1/true to simulate only
 *   POLL_INTERVAL_MS      Ms between cycles (default: 300000 = 5 min)
 *   RUN_ONCE              1/true to run one cycle and exit
 */

import { ThorClient } from "@vechain/sdk-network"
import { Address, HDKey } from "@vechain/sdk-core"
import chalk from "chalk"
import { getNetworkConfig } from "./config"
import { fetchSummary } from "./contracts"
import { runCastVoteCycle, runClaimRewardCycle } from "./relayer"
import { renderSummary, renderCycleResult, timestamp } from "./display"

function getWallet(): { walletAddress: string; privateKey: string } {
  const pk = process.env.RELAYER_PRIVATE_KEY?.trim()
  if (pk) {
    const clean = pk.startsWith("0x") ? pk.slice(2) : pk
    return {
      walletAddress: Address.ofPrivateKey(Buffer.from(clean, "hex")).toString(),
      privateKey: clean,
    }
  }
  const words = process.env.MNEMONIC?.trim()?.split(/\s+/)
  if (!words?.length) {
    console.error(chalk.red("Set MNEMONIC or RELAYER_PRIVATE_KEY env"))
    process.exit(1)
  }
  const child = HDKey.fromMnemonic(words).deriveChild(0)
  const raw = child.privateKey
  if (!raw) {
    console.error(chalk.red("Failed to derive private key from mnemonic"))
    process.exit(1)
  }
  return {
    walletAddress: Address.ofPublicKey(child.publicKey as Uint8Array).toString(),
    privateKey: Buffer.from(raw).toString("hex"),
  }
}

function envBool(key: string): boolean {
  return /^(1|true|yes)$/i.test(process.env[key] || "")
}

const activityLog: string[] = []
const MAX_LOG = 200

function log(msg: string) {
  const entry = `${timestamp()} ${msg}`
  activityLog.push(entry)
  if (activityLog.length > MAX_LOG) activityLog.shift()
  console.log(entry)
}

async function main() {
  const network = process.env.RELAYER_NETWORK || "testnet-staging"
  const config = getNetworkConfig(network, process.env.NODE_URL?.trim())
  const { walletAddress, privateKey } = getWallet()
  const batchSize = Math.max(1, parseInt(process.env.BATCH_SIZE || "50", 10) || 50)
  const dryRun = envBool("DRY_RUN")
  const pollMs = Math.max(60_000, parseInt(process.env.POLL_INTERVAL_MS || "300000", 10) || 300_000)
  const runOnce = envBool("RUN_ONCE")

  const thor = ThorClient.at(config.nodeUrl, { isPollingEnabled: false })

  let running = true
  process.on("SIGINT", () => { running = false })
  process.on("SIGTERM", () => { running = false })

  while (running) {
    try {
      // Fetch and display summary
      const summary = await fetchSummary(thor, config, walletAddress)
      console.clear()
      console.log(renderSummary(summary))
      console.log("")
      console.log(chalk.bold("─── Activity Log ") + "─".repeat(49))

      // Replay recent log entries after clear
      for (const entry of activityLog.slice(-30)) {
        console.log(entry)
      }

      // Run cycles
      if (summary.isRoundActive) {
        log("Starting cast-vote cycle...")
        const voteResult = await runCastVoteCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
        renderCycleResult(voteResult).forEach(log)
      } else {
        log("Round not active, skipping cast-vote")
      }

      log("Starting claim cycle...")
      const claimResult = await runClaimRewardCycle(thor, config, walletAddress, privateKey, batchSize, dryRun, log)
      renderCycleResult(claimResult).forEach(log)

      // Re-fetch and display updated summary
      const updated = await fetchSummary(thor, config, walletAddress)
      console.clear()
      console.log(renderSummary(updated))
      console.log("")
      console.log(chalk.bold("─── Activity Log ") + "─".repeat(49))
      for (const entry of activityLog.slice(-30)) {
        console.log(entry)
      }
    } catch (err) {
      log(chalk.red(`Cycle error: ${err instanceof Error ? err.message : String(err)}`))
    }

    if (runOnce) {
      log("Run once complete. Exiting.")
      break
    }

    log(`Next cycle in ${(pollMs / 60_000).toFixed(0)}m...`)
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

main()
