<p align="center">

```
                                      #######
                                 ################
                               ####################
                             ###########   #########
                            #########      #########
          #######          #########       #########
          #########       #########      ##########
           ##########     ########     ####################
            ##########   #########  #########################
              ################### ############################
               #################  ##########          ########
                 ##############      ###              ########
                  ############                       #########
                    ##########                     ##########
                     ########                    ###########
                       ###                    ############
                                          ##############
                                    #################
                                   ##############
                                   #########
```

</p>

<h1 align="center">VeBetterDAO Relayer Node</h1>

<p align="center">
  <strong>Run a VeBetterDAO relayer from your terminal.<br>Cast auto-votes, claim rewards, earn fees.</strong>
</p>

<p align="center">
  <a href="https://docs.vebetterdao.org"><img src="https://img.shields.io/badge/docs-vebetterdao.org-blue?style=flat-square" alt="Docs"></a>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square" alt="License">
</p>

---

## Quick Start (Docker)

```bash
docker build -t vbd-relayer .

# Testnet (default)
docker run --env MNEMONIC="your twelve word mnemonic phrase here" vbd-relayer

# Mainnet
docker run --env MNEMONIC="..." --env RELAYER_NETWORK=mainnet vbd-relayer
```

## Quick Start (npm)

```bash
git clone https://github.com/vechain/vebetterdao-relayer-node.git
cd vebetterdao-relayer-node
npm install
npm run build

MNEMONIC="your twelve word mnemonic phrase here" npm start

# Mainnet
RELAYER_NETWORK=mainnet MNEMONIC="..." npm start

# Or with private key
RELAYER_PRIVATE_KEY=0xabc123... npm start
```

## Terminal Dashboard

The node renders a live dashboard that refreshes each cycle:

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
```

## How It Works

Each cycle the relayer node:

1. **Reads on-chain state** — current round, auto-voting users, relayer pool rewards, fee config
2. **Casts votes** — finds users with auto-voting enabled who haven't voted, batches `castVoteOnBehalfOf` calls with gas simulation and failure isolation
3. **Claims rewards** — claims previous round rewards for auto-voting users via `claimReward`
4. **Refreshes dashboard** — updates stats, sleeps until next cycle

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MNEMONIC` | One of these | — | BIP39 mnemonic phrase |
| `RELAYER_PRIVATE_KEY` | two required | — | Hex private key (with or without `0x`) |
| `RELAYER_NETWORK` | No | `testnet-staging` | `mainnet` or `testnet-staging` |
| `NODE_URL` | No | Per network | Override Thor node URL |
| `BATCH_SIZE` | No | `50` | Users per transaction batch |
| `DRY_RUN` | No | `0` | `1` to simulate without sending transactions |
| `POLL_INTERVAL_MS` | No | `300000` | Milliseconds between cycles (min 60000) |
| `RUN_ONCE` | No | `0` | `1` to run a single cycle and exit |

## Contracts

| Contract | Purpose | Key Functions |
|---|---|---|
| **XAllocationVoting** | Round info, auto-voting users | `castVoteOnBehalfOf`, `currentRoundId`, `hasVoted` |
| **VoterRewards** | Reward claiming | `claimReward` |
| **RelayerRewardsPool** | Registration, rewards, fees | `claimableRewards`, `getRegisteredRelayers`, weights |

Mainnet and testnet-staging addresses are in [`src/config.ts`](src/config.ts).

Full contract source: [vechain/vebetterdao-contracts](https://github.com/vechain/vebetterdao-contracts)

## Project Structure

```
src/
├── index.ts       # Entry point — env parsing, wallet derivation, main loop
├── config.ts      # Network configs with baked-in contract addresses
├── contracts.ts   # On-chain reads (26 view functions + event pagination)
├── relayer.ts     # Batch vote casting + reward claiming with isolation/retry
├── display.ts     # Terminal UI rendering (box drawing + chalk colors)
└── types.ts       # Shared interfaces
```

## Development

```bash
# Run with ts-node (no build step)
MNEMONIC="..." npm run dev

# Dry run — simulate only, no transactions sent
DRY_RUN=1 MNEMONIC="..." npm run dev

# Single cycle then exit
RUN_ONCE=1 MNEMONIC="..." npm run dev
```

## Becoming a Relayer

To earn fees you must be a registered relayer in the `RelayerRewardsPool` contract. Visit [governance.vebetterdao.org](https://governance.vebetterdao.org) for the registration flow. Once registered, run this node to cast votes and claim rewards automatically — earning a percentage of each user's reward as a fee.

## License

MIT
