# CLAUDE.md

Guidance for AI agents working on this codebase.

## Project Overview

Standalone CLI relayer node for VeBetterDAO. Casts auto-votes and claims rewards on behalf of users on the VeChain blockchain, earning relayer fees.

Not part of the b3tr monorepo. This is a self-contained Node.js project.

## Stack

- TypeScript compiled to CommonJS (`tsc`)
- `@vechain/sdk-core` + `@vechain/sdk-network` for blockchain interaction
- `@vechain/vebetterdao-contracts` for contract ABIs (typechain factories)
- `chalk` v4 (CJS) for terminal colors
- Node.js 20+

## Architecture

```
src/
├── index.ts       # Entry point. Parses env, derives wallet, runs main loop.
│                  # Each cycle: fetchSummary → render → castVotes → claimRewards → render → sleep.
├── config.ts      # Mainnet + testnet-staging contract addresses. No external config deps.
├── contracts.ts   # All on-chain reads. Wraps thor.contracts.executeCall for view functions.
│                  # Also has getAutoVotingUsers() which paginates AutoVotingToggled events.
├── relayer.ts     # Transaction execution. processBatch() handles multi-clause txs with
│                  # gas simulation, failure isolation, and retry. Exports runCastVoteCycle
│                  # and runClaimRewardCycle.
├── display.ts     # Terminal rendering. renderSummary() draws the box UI.
│                  # renderCycleResult() formats cycle outcomes for the activity log.
└── types.ts       # NetworkConfig, RelayerSummary, CycleResult, LogFn interfaces.
```

## Key Patterns

### Contract reads via `call()` helper
All view functions go through `contracts.ts:call()` which wraps `thor.contracts.executeCall()` and returns `res.result.array`. The ABIContract type is `any` in the signature to avoid generic type issues with the SDK.

### Event pagination
`getAutoVotingUsers()` fetches `AutoVotingToggled` events from block 0 to a snapshot block in pages of 1000 (Thor node limit). Builds a `Map<address, boolean>` and returns only addresses where the final state is `enabled=true`.

### Batch transaction processing
`processBatch()` in `relayer.ts` splits users into configurable-size batches. For each batch:
1. Build clauses via `Clause.callFunction()`
2. Estimate gas - if reverted, isolate failures individually
3. Sign with `Transaction.of(body).sign()` and send
4. Wait for receipt

`isolateAndRetry()` tests each clause individually to separate permanent failures (e.g. already voted) from transient ones (RPC errors), then retries the valid set.

### hasVoted checks are batched
Before voting, we check `hasVoted` for all users in chunks of 50 to avoid overwhelming the node with concurrent RPC calls.

## Commands

```bash
npm install           # Install deps
npm run build         # tsc → dist/
npm start             # Run compiled (node dist/index.js)
npm run dev           # Run with ts-node (no build)
```

## Environment Variables

- `MNEMONIC` or `RELAYER_PRIVATE_KEY` (required, one of)
- `RELAYER_NETWORK` — `mainnet` | `testnet-staging` (default: testnet-staging)
- `NODE_URL` — override Thor node URL
- `BATCH_SIZE` — users per tx batch (default: 50)
- `DRY_RUN` — `1` to simulate without sending txs
- `POLL_INTERVAL_MS` — ms between cycles (default: 300000, min: 60000)
- `RUN_ONCE` — `1` to exit after one cycle

### Docker Secrets

`MNEMONIC` and `RELAYER_PRIVATE_KEY` also support Docker Compose secrets as a fallback. The `envOrSecret()` helper in `index.ts` checks the env var first, then reads `/run/secrets/<name>`. Secret names: `mnemonic`, `relayer_private_key`.

## Contract Interactions

### Reads (view functions)
- `XAllocationVoting`: currentRoundId, roundSnapshot, roundDeadline, isActive, getTotalAutoVotingUsersAtRoundStart, totalVoters, totalVotes, hasVoted
- `RelayerRewardsPool`: getRegisteredRelayers, isRegisteredRelayer, getTotalRewards, claimableRewards, isRewardClaimable, totalActions, completedWeightedActions, totalWeightedActions, getMissedAutoVotingUsersCount, getVoteWeight, getClaimWeight, getRelayerFeePercentage, getRelayerFeeDenominator, getFeeCap, getEarlyAccessBlocks, totalRelayerActions, totalRelayerWeightedActions

### Writes (state-changing)
- `XAllocationVoting.castVoteOnBehalfOf(address voter, uint256 roundId)` — cast vote for auto-voting user
- `VoterRewards.claimReward(uint256 cycle, address voter)` — claim reward for user (fee goes to RelayerRewardsPool)

### Events
- `XAllocationVoting.AutoVotingToggled(address account, bool enabled)` — paginated from block 0 to snapshot

## Adding a New Network

Add a new `NetworkConfig` in `config.ts` with contract addresses, then add a case in `getNetworkConfig()`.

## Code Style

- TypeScript strict mode
- No class-based architecture — pure functions and interfaces
- Minimal dependencies
- `any` used sparingly for SDK type compatibility (ABIContract generics)
