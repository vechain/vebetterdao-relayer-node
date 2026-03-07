# VeBetterDAO Relayer Node

Standalone CLI tool that runs a VeBetterDAO relayer. Casts auto-votes and claims rewards on behalf of users who opted in, earning relayer fees from the `RelayerRewardsPool`.

Shows a live terminal dashboard with round info, pool rewards, relayer stats, and an activity log.

## Quick Start

```bash
npm install
npm run build

# Run (testnet-staging by default)
MNEMONIC="your twelve word mnemonic phrase here" npm start

# Or with private key
RELAYER_PRIVATE_KEY=0xabc123... npm start
```

## Docker

```bash
docker build -t vbd-relayer .
docker run --env MNEMONIC="your twelve word mnemonic phrase here" vbd-relayer

# Mainnet
docker run --env MNEMONIC="..." --env RELAYER_NETWORK=mainnet vbd-relayer
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MNEMONIC` | One of these | — | BIP39 mnemonic phrase |
| `RELAYER_PRIVATE_KEY` | required | — | Hex private key (with or without 0x prefix) |
| `RELAYER_NETWORK` | No | `testnet-staging` | `mainnet` or `testnet-staging` |
| `NODE_URL` | No | Per network | Override Thor node URL |
| `BATCH_SIZE` | No | `50` | Users per transaction batch |
| `DRY_RUN` | No | `0` | `1` to simulate without sending transactions |
| `POLL_INTERVAL_MS` | No | `300000` | Milliseconds between cycles (min 60000) |
| `RUN_ONCE` | No | `0` | `1` to run a single cycle and exit |

## What It Does

Each cycle:

1. **Fetches summary** - current round, auto-voting user count, relayer pool, fee config, your claimable rewards
2. **Renders dashboard** - box-drawn terminal UI with all stats
3. **Cast votes** - finds users with auto-voting enabled who haven't voted yet, batches `castVoteOnBehalfOf` calls
4. **Claim rewards** - claims previous round rewards for auto-voting users via `claimReward`
5. **Refreshes** - updates dashboard with post-cycle stats, sleeps until next cycle

Batches include gas simulation, automatic failure isolation (individual clause testing when a batch reverts), and retry logic.

## Terminal Dashboard

```
╔════════════════════════════════════════════════════════════════╗
║                    VeBetterDAO Relayer Node                    ║
╠════════════════════════════════════════════════════════════════╣
║ Network    mainnet                           Block  24,237,183 ║
║ Node       mainnet.vechain.org                                 ║
║ Address    0xABCD...1234                      ✓ Registered     ║
╠════════════════════════════════════════════════════════════════╣
║ ROUND #88  ● Active                                            ║
║ Snapshot   24190328                        Deadline   24250807 ║
║ Auto-voters  1209                                 Relayers   1 ║
║ Voters     20949                  Total VOT3 206160737.01 B3TR ║
╠════════════════════════════════════════════════════════════════╣
║ Vote Wt    3                                      Claim Wt   1 ║
║ Fee        10.00%                       Cap        100.00 B3TR ║
║ Early Access  43200 blocks                                     ║
╠════════════════════════════════════════════════════════════════╣
║ THIS ROUND                                                     ║
║ Completion 75.00%                               Missed     295 ║
║ Pool       5000.00 B3TR                   Your share 1500 B3TR ║
║ Actions    120 (wt: 360)                       Total acts 2360 ║
║                                                                ║
║ PREVIOUS ROUND #87                                             ║
║ Pool       5746.01 B3TR                   Your share 1200 B3TR ║
║ Actions    150                                     ✓ Claimable ║
╚════════════════════════════════════════════════════════════════╝

─── Activity Log ─────────────────────────────────────────────────
[10:30:15] Starting cast-vote cycle...
[10:30:16] Found 1209 auto-voting users
[10:30:18] 295 users need voting (914 already voted)
[10:30:19] Batch 1/6 (50 users): ✓ 50 OK (tx: 0x1234abcd...)
...
```

## Contracts

Reads from and writes to these VeBetterDAO contracts:

| Contract | Read | Write |
|---|---|---|
| `XAllocationVoting` | Round info, auto-voting users, vote status | `castVoteOnBehalfOf` |
| `VoterRewards` | — | `claimReward` |
| `RelayerRewardsPool` | Relayer registration, rewards, weights, fees, actions | — |

Contract addresses for mainnet and testnet-staging are baked into `src/config.ts`.

## Project Structure

```
src/
├── index.ts       # Entry point, env parsing, main loop
├── config.ts      # Network configs with contract addresses
├── contracts.ts   # On-chain reads (view functions + event queries)
├── relayer.ts     # Vote casting + reward claiming (batch tx processing)
├── display.ts     # Terminal UI rendering
└── types.ts       # Shared interfaces
```

## Development

```bash
# Run with ts-node (no build step)
MNEMONIC="..." npm run dev

# Dry run (simulate only, no transactions sent)
DRY_RUN=1 MNEMONIC="..." npm run dev

# Single cycle then exit
RUN_ONCE=1 MNEMONIC="..." npm run dev
```

## Becoming a Relayer

To earn fees you must be a registered relayer in the `RelayerRewardsPool` contract. The dashboard at [governance.vebetterdao.org](https://governance.vebetterdao.org) shows the relayer registration flow. Once registered, run this node to automatically cast votes and claim rewards, earning a percentage of each user's reward as a fee.
