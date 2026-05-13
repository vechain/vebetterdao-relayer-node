import { ThorClient } from "@vechain/sdk-network"
import { ABIContract, Address, Clause, Transaction } from "@vechain/sdk-core"
import { XAllocationVoting__factory } from "@vechain/vebetterdao-contracts/typechain-types"
import chalk from "chalk"
import { NetworkConfig, CycleResult, LogFn } from "./types"
import {
  getCurrentRoundId,
  getRoundDeadline,
  isRoundActive,
  getAutoVotingUsers,
  getAlreadySkippedVotersForRound,
  getEarlyAccessBlocks,
  getPreferredRelayersForUsers,
} from "./contracts"
import {
  xavNavAbi,
  getDelegatedCitizens,
  getNavigatorsForCitizens,
  batchHasSetPreferences,
} from "./citizen-contracts"

const xAllocationVotingAbi = ABIContract.ofAbi(XAllocationVoting__factory.abi)

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// Inline ABI fragment — Emissions.distribute() has no args.
const EMISSIONS_ABI = [
  { type: "function", name: "distribute", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "isNextCycleDistributable", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const
const emissionsAbi = ABIContract.ofAbi(EMISSIONS_ABI as any)

// Cap how many votes we squeeze into the bundle. Stays well under the 40M
// per-tx gas ceiling (≈500k gas/clause × 30 ≈ 15M, plus distribute()'s ~1M).
const MAX_BUNDLE_VOTES = 30

function buildDistributeClause(emissionsAddr: string): Clause {
  return Clause.callFunction(Address.of(emissionsAddr), emissionsAbi.getFunction("distribute"), [])
}

function buildAutoVoteClause(xavAddr: string, roundId: number, user: string): Clause {
  return Clause.callFunction(Address.of(xavAddr), xAllocationVotingAbi.getFunction("castVoteOnBehalfOf"), [user, roundId])
}

function buildNavigatorVoteClause(xavAddr: string, roundId: number, citizen: string): Clause {
  return Clause.callFunction(Address.of(xavAddr), xavNavAbi.getFunction("castNavigatorVote"), [citizen, roundId])
}

interface BundleSelection {
  autoVoters: string[]
  citizens: string[]
}

async function selectAutoVoters(
  thor: ThorClient,
  config: NetworkConfig,
  newRoundId: number,
  myAddress: string,
  latestBlock: number,
  isEarlyAccess: boolean,
  log: LogFn,
): Promise<string[]> {
  // Auto-voters at latest block — the new round's snapshot will be set when
  // distribute() runs inside the bundle, so we use latest as proxy.
  const allAutoVoters = await getAutoVotingUsers(thor, config.xAllocationVotingAddress, latestBlock)
  const skippedSet = await getAlreadySkippedVotersForRound(
    thor, config.xAllocationVotingAddress, newRoundId, latestBlock, latestBlock,
  )
  const preferredMap = await getPreferredRelayersForUsers(
    thor, config.relayerRewardsPoolAddress, allAutoVoters, log,
  )

  const autoVoters: string[] = []
  for (const user of allAutoVoters) {
    if (skippedSet.has(user.toLowerCase())) continue
    const pref = preferredMap.get(user.toLowerCase())
    if (isEarlyAccess && pref && pref !== myAddress) continue
    autoVoters.push(user)
    if (autoVoters.length >= MAX_BUNDLE_VOTES) break
  }
  return autoVoters
}

async function selectCitizenVoters(
  thor: ThorClient,
  config: NetworkConfig,
  newRoundId: number,
  myAddress: string,
  latestBlock: number,
  isEarlyAccess: boolean,
  log: LogFn,
): Promise<string[]> {
  if (!config.navigatorRegistryAddress || config.navigatorRegistryAddress === ZERO_ADDRESS) {
    return []
  }

  try {
    const delegationMap = await getDelegatedCitizens(thor, config.navigatorRegistryAddress, latestBlock)
    if (delegationMap.size === 0) return []

    // Validate at the latest block (closest proxy for the new snapshot, which is set inside distribute())
    const validatedMap = await getNavigatorsForCitizens(
      thor, config.navigatorRegistryAddress, [...delegationMap.keys()], latestBlock, log,
    )
    const uniqueNavigators = [...new Set(validatedMap.values())]
    const prefsMap = await batchHasSetPreferences(
      thor, config.navigatorRegistryAddress, uniqueNavigators, newRoundId,
    )
    const citizenPreferred = await getPreferredRelayersForUsers(
      thor, config.relayerRewardsPoolAddress, [...validatedMap.keys()], log,
    )

    const citizens: string[] = []
    for (const [citizen, nav] of validatedMap) {
      if (!(prefsMap.get(nav) ?? false)) continue // navigator hasn't pre-set → revert risk
      const pref = citizenPreferred.get(citizen)
      if (isEarlyAccess && pref && pref !== myAddress) continue
      citizens.push(citizen)
      if (citizens.length >= MAX_BUNDLE_VOTES) break
    }
    return citizens
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes("reverted")) log(chalk.dim(`Bundle: citizen lookup failed: ${msg.slice(0, 80)}`))
    return []
  }
}

/**
 * Pick the auto-voters and citizens we can safely include in the bundle for
 * `newRoundId`. Citizens are filtered to those whose navigator has already
 * pre-set preferences for the upcoming round — including others would revert
 * (no preferences + skip window not reached, since the round just started).
 */
async function selectBundleParticipants(
  thor: ThorClient,
  config: NetworkConfig,
  newRoundId: number,
  walletAddress: string,
  latestBlock: number,
  log: LogFn,
): Promise<BundleSelection> {
  const myAddress = walletAddress.toLowerCase()
  // brand-new round → always in early access, but preferred-relayer filter still applies
  const earlyAccessBlocks = await getEarlyAccessBlocks(thor, config.relayerRewardsPoolAddress)
  const isEarlyAccess = Number(earlyAccessBlocks) > 0

  const autoVoters = await selectAutoVoters(thor, config, newRoundId, myAddress, latestBlock, isEarlyAccess, log)
  const citizens = await selectCitizenVoters(thor, config, newRoundId, myAddress, latestBlock, isEarlyAccess, log)
  return { autoVoters, citizens }
}

export async function runDistributeBundleCycle(
  thor: ThorClient,
  config: NetworkConfig,
  walletAddress: string,
  privateKey: string,
  dryRun: boolean,
  log: LogFn,
): Promise<CycleResult> {
  const empty: CycleResult = {
    phase: "vote", roundId: 0, totalUsers: 0, successful: 0,
    failed: [], transient: [], txIds: [], dryRun,
  }

  if (!config.emissionsAddress) {
    return { ...empty, totalUsers: 0 }
  }

  const currentRoundId = await getCurrentRoundId(thor, config.xAllocationVotingAddress)
  const active = await isRoundActive(thor, config.xAllocationVotingAddress, currentRoundId)
  if (active) return empty

  const deadline = await getRoundDeadline(thor, config.xAllocationVotingAddress, currentRoundId)
  const best = await thor.blocks.getBestBlockCompressed()
  const latestBlock = best?.number ?? 0
  if (latestBlock < deadline) return empty // still mid-round

  // 1. Simulate distribute() alone — if it reverts, the next cycle isn't ready
  //    (e.g. emissions not yet started, or already distributed by someone else).
  const distributeOnly = [buildDistributeClause(config.emissionsAddress)]
  const distSim = await thor.gas.estimateGas(distributeOnly, walletAddress, { gasPadding: 0.1 })
  if (distSim.reverted) {
    return empty
  }

  log(chalk.cyan(`✦ Distribute window open — building bundle for round #${currentRoundId + 1}`))

  // 2. Select participants for the bundle.
  const newRoundId = currentRoundId + 1
  const { autoVoters, citizens } = await selectBundleParticipants(
    thor, config, newRoundId, walletAddress, latestBlock, log,
  )

  log(
    `Bundle: ${chalk.white.bold(autoVoters.length.toString())} auto-voters · ` +
    `${chalk.white.bold(citizens.length.toString())} citizens (navs ready)`,
  )

  // 3. Build full bundle and try it.
  const bundleClauses = [
    buildDistributeClause(config.emissionsAddress),
    ...autoVoters.map((u) => buildAutoVoteClause(config.xAllocationVotingAddress, newRoundId, u)),
    ...citizens.map((c) => buildNavigatorVoteClause(config.xAllocationVotingAddress, newRoundId, c)),
  ]

  const bundleSim = await thor.gas.estimateGas(bundleClauses, walletAddress, { gasPadding: 0.1 })
  let clausesToSend = bundleClauses
  let bundleSuccessful = autoVoters.length + citizens.length

  if (bundleSim.reverted) {
    log(chalk.yellow("Bundle simulation reverted — falling back to distribute() alone"))
    clausesToSend = distributeOnly
    bundleSuccessful = 0
  }

  if (dryRun) {
    log(chalk.dim(`Bundle: ✓ simulation OK (dry run, ${clausesToSend.length} clauses)`))
    return {
      ...empty,
      roundId: newRoundId,
      totalUsers: autoVoters.length + citizens.length,
      successful: bundleSuccessful,
      txIds: ["DRY_RUN_BUNDLE"],
    }
  }

  // 4. Send.
  const finalSim = bundleSim.reverted ? distSim : bundleSim
  try {
    const body = await thor.transactions.buildTransactionBody(clausesToSend, finalSim.totalGas)
    const signed = Transaction.of(body).sign(Buffer.from(privateKey, "hex"))
    const sent = await thor.transactions.sendTransaction(signed)
    const receipt = await thor.transactions.waitForTransaction(sent.id)
    if (receipt && !receipt.reverted) {
      log(chalk.green(`Bundle: ✓ tx ${sent.id.slice(0, 10)}... (${clausesToSend.length} clauses)`))
      return {
        ...empty,
        roundId: newRoundId,
        totalUsers: autoVoters.length + citizens.length,
        successful: bundleSuccessful,
        txIds: [sent.id],
      }
    }
    log(chalk.red(`Bundle: tx reverted on chain — race lost or state changed`))
    return { ...empty, roundId: newRoundId, totalUsers: autoVoters.length + citizens.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(chalk.red(`Bundle: send failed — ${msg.slice(0, 80)}`))
    return { ...empty, roundId: newRoundId, totalUsers: autoVoters.length + citizens.length }
  }
}
