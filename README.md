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
  <strong>Cast auto-votes, claim rewards, earn fees.</strong>
</p>

<p align="center">
  <a href="https://docs.vebetterdao.org/vebetter/automation"><img src="https://img.shields.io/badge/docs-auto--voting-blue?style=flat-square" alt="Docs"></a>
  <a href="https://docs.vebetterdao.org"><img src="https://img.shields.io/badge/docs-vebetterdao.org-blue?style=flat-square" alt="Docs"></a>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square" alt="License">
</p>

---

## What Is This?

VeBetterDAO users can enable **auto-voting** to automate their weekly X Allocation votes. They pick up to 15 favorite apps, toggle it on, and a **relayer** handles the rest: casting votes, claiming rewards, all gasless. Tokens never leave the user's wallet.

This repo is a standalone relayer node. Run it, and it will:

1. Discover all users who have auto-voting enabled
2. Cast `castVoteOnBehalfOf` for each user during the active round
3. Claim rewards via `claimReward` for each user after the round ends
4. Loop every 5 minutes

**Economics:** Each user pays a 10% fee on rewards (capped at 100 B3TR per round). That fee flows into the `RelayerRewardsPool`. Your share is proportional to your weighted actions (vote = 3 pts, claim = 1 pt). Gas costs ~0.11 B3TR per user; average fee earned ~9-19 B3TR per user.

## Quick Start

**From npm** (requires the package to be [published](https://www.npmjs.com/package/@vechain/vebetterdao-relayer-node)):

```bash
MNEMONIC="your twelve word mnemonic phrase here" npx @vechain/vebetterdao-relayer-node

# Testnet
RELAYER_NETWORK=testnet-staging MNEMONIC="..." npx @vechain/vebetterdao-relayer-node
```

**From source** (clone and build):

```bash
git clone https://github.com/vechain/vebetterdao-relayer-node.git
cd vebetterdao-relayer-node
npm install && npm run build
MNEMONIC="your twelve word mnemonic phrase here" node dist/index.js
```

### Alternative: global install

```bash
npm install -g @vechain/vebetterdao-relayer-node
MNEMONIC="..." vbd-relayer
```

(Only works after the package is published to npm.)

### Alternative: Docker

**Pre-built image** (after the repo has been pushed to `main` on GitHub, image is built at GHCR; use tag `latest` or `main`):

```bash
docker run -it --env MNEMONIC="your twelve word mnemonic phrase here" ghcr.io/vechain/vebetterdao-relayer-node:latest
```

**Build locally** (works without publishing):

```bash
git clone https://github.com/vechain/vebetterdao-relayer-node.git
cd vebetterdao-relayer-node
docker build -t vbd-relayer .
docker run -it --env MNEMONIC="your twelve word mnemonic phrase here" vbd-relayer
```

### Alternative: Docker Compose with Secrets (recommended)

Using Docker Compose secrets keeps your mnemonic out of environment variables and shell history. The secret file is mounted read-only at `/run/secrets/mnemonic` inside the container.

**1. Create the secret file:**

```bash
mkdir -p secrets
chmod 700 secrets
nano secrets/mnemonic.txt   # paste your mnemonic, save, exit
chmod 600 secrets/mnemonic.txt
```

**2. Start the relayer:**

```bash
docker compose up -d
```

The included [`docker-compose.yml`](docker-compose.yml) builds the image locally with `build: .` and mounts `./secrets/mnemonic.txt`.

To use a private key instead of a mnemonic, create `secrets/relayer_private_key.txt` containing your hex private key and update `docker-compose.yml`:

```yaml
services:
  relayer:
    secrets:
      - relayer_private_key

secrets:
  relayer_private_key:
    file: ./secrets/relayer_private_key.txt
```

> **Note:** Environment variables always take precedence over Docker secrets. If both `MNEMONIC` and the `mnemonic` secret are present, the env var wins.

## Becoming a Relayer

Your wallet must be **registered on-chain** in the `RelayerRewardsPool` contract before you can earn fees. During the MVP phase, registration is managed by the pool admin. Check the [governance proposal](https://governance.vebetterdao.org/proposals/93450486232994296830196736391400835825360450263361422145364815974754963306849) and [community discussion](https://vechain.discourse.group/t/vebetterdao-proposal-auto-voting-for-x-allocation-with-gasless-voting-and-relayer-rewards/559) for the latest on the registration process.

You can run the node without registration to test, but votes cast during the **early access window** (first ~5 days after round start) require registration. After early access, anyone can cast votes.

## Terminal Dashboard

The node renders a live dashboard that refreshes each cycle:

```
+------------------------------------------------------------------+
|                    VeBetterDAO Relayer Node                       |
+------------------------------------------------------------------+
| Network    mainnet                           Block  24,237,183   |
| Node       mainnet.vechain.org                                   |
| Address    0xABCD...1234                      + Registered       |
+------------------------------------------------------------------+
| ROUND #88  * Active                                              |
| Snapshot   24190328                        Deadline   24250807   |
| Auto-voters  1209                                 Relayers   1   |
| Voters     20949                  Total VOT3 206160737.01 VOT3   |
+------------------------------------------------------------------+
| Vote Wt    3                                      Claim Wt   1   |
| Fee        10.00%                       Cap        100.00 B3TR   |
| Early Access  43200 blocks                                       |
+------------------------------------------------------------------+
| THIS ROUND                                                       |
| Completion 75.00%                               Missed     295   |
| Pool       5000.00 B3TR                   Your share 1500 B3TR   |
| Actions    120 (wt: 360)                       Total acts 2360   |
|                                                                  |
| PREVIOUS ROUND #87                                               |
| Pool       5746.01 B3TR                   Your share 1200 B3TR   |
| Actions    150                                     + Claimable   |
+------------------------------------------------------------------+

--- Activity Log --------------------------------------------------
[10:30:15] Starting cast-vote cycle...
[10:30:16] Found 1209 auto-voting users
[10:30:18] 295 users need voting (914 already voted)
[10:30:19] Batch 1/6 (50 users): + 50 OK (tx: 0x1234abcd...)
```

## How It Works

Each cycle:

1. **Fetch state** -- current round, auto-voting users, reward pool, fee config
2. **Cast votes** -- filter users who haven't voted, batch `castVoteOnBehalfOf` calls (multi-clause txs with gas simulation and failure isolation)
3. **Claim rewards** -- call `claimReward` for previous round users (fee is deducted inside the contract and deposited to the pool)
4. **Refresh dashboard** -- update stats, sleep until next cycle

### Reward Distribution

Relayer rewards follow an **all-or-nothing** model: the pool only unlocks when ALL auto-voting users have been served (`completedWeightedActions >= totalWeightedActions`). This incentivizes relayers to process every user. Your share is:

```
relayerShare = (yourWeightedActions / totalCompletedWeightedActions) * poolAmount
```

### Early Access

Registered relayers get a head start. For the first ~5 days (43,200 blocks) after a round starts, only registered relayers can cast votes. Similarly, only registered relayers can claim rewards for ~5 days after a round ends. After that, anyone can act.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MNEMONIC` | One of | -- | BIP39 mnemonic phrase |
| `RELAYER_PRIVATE_KEY` | these two | -- | Hex private key (with or without `0x`) |
| `RELAYER_NETWORK` | No | `mainnet` | `mainnet` or `testnet-staging` |
| `NODE_URL` | No | Per network | Override Thor node URL |
| `BATCH_SIZE` | No | `50` | Users per transaction batch |
| `DRY_RUN` | No | `0` | `1` to simulate without sending transactions |
| `POLL_INTERVAL_MS` | No | `300000` | Milliseconds between cycles (min 60,000) |
| `RUN_ONCE` | No | `0` | `1` to run a single cycle and exit |

### Docker Secrets

`MNEMONIC` and `RELAYER_PRIVATE_KEY` can also be provided as [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/). Place the value in a file and reference it in `docker-compose.yml`:

| Secret name | Equivalent env var |
|---|---|
| `mnemonic` | `MNEMONIC` |
| `relayer_private_key` | `RELAYER_PRIVATE_KEY` |

Secrets are read from `/run/secrets/<name>` at startup. Environment variables take precedence over secrets when both are set.

## Contracts

| Contract | Purpose | Key Functions |
|---|---|---|
| **XAllocationVoting** | Round info, auto-voting users, vote execution | `castVoteOnBehalfOf`, `currentRoundId`, `hasVoted`, `AutoVotingToggled` event |
| **VoterRewards** | Reward claiming with fee deduction | `claimReward` (deducts 10% fee, deposits to pool) |
| **RelayerRewardsPool** | Registration, action tracking, reward distribution | `claimableRewards`, `isRewardClaimable`, `getRegisteredRelayers`, weights |

Mainnet and testnet-staging addresses are in [`src/config.ts`](src/config.ts).

Full contract source: [vechain/vebetterdao-contracts](https://github.com/vechain/vebetterdao-contracts)

## Project Structure

```
src/
  index.ts       # Entry point -- env parsing, wallet derivation, main loop
  config.ts      # Network configs with contract addresses
  contracts.ts   # On-chain reads (view functions + event pagination)
  relayer.ts     # Batch vote casting + reward claiming with isolation/retry
  display.ts     # Terminal UI rendering (box drawing + chalk)
  types.ts       # Shared interfaces
```

## Development

```bash
# Run with ts-node (no build step)
MNEMONIC="..." npm run dev

# Dry run -- simulate only, no transactions sent
DRY_RUN=1 MNEMONIC="..." npm run dev

# Single cycle then exit
RUN_ONCE=1 MNEMONIC="..." npm run dev

# Build
npm run build && npm start
```

## Links

- [Auto-voting docs](https://docs.vebetterdao.org/vebetter/automation)
- [VeBetterDAO docs](https://docs.vebetterdao.org)
- [Governance proposal](https://governance.vebetterdao.org/proposals/93450486232994296830196736391400835825360450263361422145364815974754963306849)
- [Community discussion](https://vechain.discourse.group/t/vebetterdao-proposal-auto-voting-for-x-allocation-with-gasless-voting-and-relayer-rewards/559)
- [Contract source](https://github.com/vechain/vebetterdao-contracts)

## License

MIT
