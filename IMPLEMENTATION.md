# Relayer Implementation Guide

How this relayer decides what to do, contract by contract, event by event. Intended for operators of **custom relayer nodes** who need to update their code to support navigators (citizen delegation) alongside existing auto-voting.

If you only want to *run* the published node, see [README.md](./README.md).

---

## TL;DR — what the relayer does each cycle

```
fetch summary
  ├─ if round is active:
  │    ├─ Auto-voters    → castVoteOnBehalfOf
  │    ├─ Citizens (alloc) → castNavigatorVote(citizen, roundId)
  │    └─ Citizens (gov)   → castNavigatorVote(proposalId, citizen)  for each active proposal
  └─ always:
       ├─ Auto-voters    → claimReward(prevRound, user)
       └─ Citizens       → claimReward(prevRound, citizen)
sleep
```

There are three contracts the relayer writes to:

| Contract | Function | Who it processes |
|---|---|---|
| `XAllocationVoting.castVoteOnBehalfOf(voter, roundId)` | allocation vote | auto-voters |
| `XAllocationVoting.castNavigatorVote(citizen, roundId)` | allocation vote | navigator-delegated citizens |
| `B3TRGovernor.castNavigatorVote(proposalId, citizen)` | governance vote | navigator-delegated citizens |
| `VoterRewards.claimReward(cycle, voter)` | claim | both auto-voters and citizens |

Everything else is just *deciding* who to pass to those four calls.

---

## 1. Cycle structure

`src/index.ts:runAllCycles` runs five sub-cycles in order:

1. `runCastVoteCycle` — auto-voter allocation votes (active round only)
2. `runCitizenAllocationVoteCycle` — citizen allocation votes (active round only, only when citizens > 0)
3. `runCitizenGovernanceVoteCycle` — citizen governance votes (active round only, only when citizens > 0)
4. `runClaimRewardCycle` — auto-voter claims (always, for previous round)
5. `runCitizenClaimRewardCycle` — citizen claims (always, for previous round)

Between cycles the dashboard re-renders. The default poll interval is 5 minutes (clamped to a 60-second minimum).

### Failure handling

The outer loop in `main()` retries the whole batch up to `nodePool.length` times, **rotating to the next public node on each failure** (`rotateNode`). This is for transient RPC failures — request timeouts, rate limiting, single-node outages. After that, the cycle is logged as failed and we sleep until the next tick.

---

## 2. Discovering users

### Auto-voters: `AutoVotingToggled` event

```solidity
event AutoVotingToggled(address indexed account, bool enabled);
```

`src/contracts.ts:getAutoVotingUsers` paginates this event from block 0 (or last cached block) to a snapshot block. It builds a `Map<address, bool>` where the **last write wins** — only addresses where `enabled == true` after replaying all events are returned.

**Caching:** the map is persisted to `.auto-voting-cache.json` so subsequent runs only scan the delta since the last block. If the snapshot block goes backwards (e.g. testnet reset), the cache is invalidated.

**Pagination:** Thor enforces a 1000-event page limit, so we offset/loop until a partial page returns.

### Citizens: navigator delegation events

`NavigatorRegistry` emits six delegation-lifecycle events:

```solidity
event DelegationCreated(address indexed citizen, address indexed navigator, uint256 amount);
event DelegationIncreased(address indexed citizen, address indexed navigator, uint256 addedAmount, uint256 newTotal);
event DelegationDecreased(address indexed citizen, address indexed navigator, uint256 removedAmount, uint256 newTotal);
event DelegationRemoved(address indexed citizen, address indexed navigator, uint256 amount);
event ExitAnnounced(address indexed navigator, uint256 announcedAtRound, uint256 effectiveDeadline);
event NavigatorDeactivatedEvent(address indexed navigator, uint256 slashPercentage);
```

`src/citizen-contracts.ts:getDelegatedCitizens` only replays four of them — `Created`, `Removed`, `ExitAnnounced`, `NavigatorDeactivatedEvent` — because the relayer **only needs the citizen → navigator mapping**, not the delegation amount. `DelegationIncreased` / `DelegationDecreased` change the staked amount but not the mapping (the citizen stays delegated to the same navigator), so they're noise for vote-routing purposes.

**You must scan Increased / Decreased if you display projected rewards or track per-citizen voting power.** The voting weight at a vote/claim is whatever `getDelegatedAmountAtTimepoint(citizen, snapshot)` returns — derived from the checkpointed amount, not the latest event. So even if you ignore Increased/Decreased for routing, if you want a "this citizen will receive ~X B3TR" estimate you need them.

The relayer fetches all four routing events in parallel, **merges them, and replays in chronological order** (block, then clauseIndex, with a tie-breaker for events emitted in the same tx — `deactivated < exit < removed < created`). In-order replay is mandatory: if you process all `Create` events before all `Remove` events you can mis-handle a citizen who switched navigators mid-history.

For each event:
- `created` → set `citizen → navigator`
- `removed` → delete the citizen entry
- `exit` / `deactivated` → remove **every citizen** whose navigator is the one in the event (lazy invalidation matches the contract's `_isNavigatorDead()` semantics)

**Caching:** persisted to `.citizen-delegation-cache.json`, same delta-scan pattern as auto-voters.

### Validating delegations at the round snapshot

The cached map is **best-effort** — events tell you "who currently has a delegation" but not "who has a delegation that's checkpointed at the round's snapshot block". For the actual voting decision you need the snapshot view.

`getNavigatorsForCitizens` re-validates by **batch-simulating** `NavigatorRegistry.getNavigatorAtTimepoint(citizen, snapshot)` (100 calls per simulate, decode each result). Anyone whose result is the zero address or who reverts is dropped from the map. The result is the list of citizens who actually have a navigator at the snapshot — these are the ones the relayer can vote for.

This is the pattern to follow whenever you have a "list of candidates from events, but the contract uses a snapshot": confirm via simulate. Don't trust the event log alone.

---

## 3. Filtering: who do we actually call the contract for?

For every user (auto-voter or citizen) the relayer applies the same shape of filter pipeline:

```
already-acted-this-round?  → drop (state read)
already-skipped-this-round? → drop (event scan)
preferred-relayer-not-us-during-early-access? → drop
[citizen-only] navigator-not-ready + skip-window-not-reached? → drop (wait)
otherwise → batch
```

### Already-voted check (`hasVoted`)

```solidity
function hasVoted(uint256 roundId, address voter) external view returns (bool);
function hasVoted(uint256 proposalId, address account) external view returns (bool);  // governor
```

Called for every candidate before each cycle. To avoid hammering the node we chunk in batches of 10 with `Promise.all`, then sleep 150ms between chunks (`CHECK_BATCH = 10`).

### Already-skipped event scans

For each phase, the contract emits a "skip" event when the user/citizen was processed but couldn't actually vote (no balance, missing prefs after window, dead navigator, etc.). The relayer scans these so it doesn't re-attempt and waste gas:

| Phase | Event | Source contract |
|---|---|---|
| Auto-voter allocation | `AutoVoteSkipped(voter, roundId, isPerson, appsCount, votingPower)` | XAllocationVoting |
| Citizen allocation | `NavigatorVoteSkipped(citizen, navigator, roundId)` | XAllocationVoting |
| Citizen governance | `NavigatorGovernanceVoteSkipped(citizen, navigator, proposalId)` | B3TRGovernor |

Scanned from the round snapshot block to the latest block, paginated 1000 events at a time. The decoded `roundId` / `proposalId` is filtered to the current value (the `topic0` filter alone isn't enough — same event type covers all rounds).

### Already-claimed event scan

```solidity
event RewardClaimedV2(uint256 indexed cycle, address indexed voter, uint256 reward, uint256 gmReward);
```

Same pattern, scanned from the previous round's deadline to the latest block. Drops anyone who already had a successful `claimReward` call.

---

## 4. Early access and preferred relayer

`RelayerRewardsPool.getEarlyAccessBlocks()` returns a window length in blocks (~5 days on mainnet). During early access:

- **Voting window:** `snapshot + earlyAccessBlocks` — only registered relayers can call `castVoteOnBehalfOf` / `castNavigatorVote` before this point. The contract enforces this; the relayer also self-checks to avoid wasted gas.
- **Claiming window:** `deadline + earlyAccessBlocks` — same idea for `claimReward`.

### Preferred relayer

Each user can mark a single preferred relayer via `RelayerRewardsPool.setPreferredRelayer`. During early access the relayer **only processes users who picked it** (and users who haven't picked anyone). This is just a courtesy filter — outside early access, anyone can act.

`getPreferredRelayersForUsers` batch-simulates `userPreferredRelayer(user)` for every candidate, builds a `Map<user, relayer>`, and the per-user filter does:

```ts
const pref = preferredMap.get(user)
if (isEarlyAccess && pref && pref !== myAddress) { skippedPreferred++; continue }
```

If the user has no preference, they're processed by anyone. A preference of `address(0)` is treated as "no preference".

The relayer also fetches its own `preferredUsersCount` for the dashboard — this is just a count of users where `userPreferredRelayer(user) == myAddress` derived from `PreferredRelayerSet` events.

---

## 5. Citizens — the navigator-ready gate

Citizens add one extra filter on top of the auto-voter pipeline: their navigator must have set the relevant **preferences (allocation) or decision (governance)** before `castNavigatorVote` will succeed.

### `hasSetPreferences(navigator, roundId)` and `hasSetDecision(navigator, proposalId)`

Read from `NavigatorRegistry`. To minimise calls, `batchHasSetPreferences` / `batchHasSetDecision` simulate 100 navigators per call (we have far fewer navigators than citizens).

For each citizen, look up their navigator and check the cached map:

- **`hasPrefs`/`hasDecision == true`** → process the citizen
- **otherwise** → see "skip window" below

### The skip window

The contract has a separate **skip window** — the last N blocks before deadline. Inside the skip window, calling `castNavigatorVote` for a citizen whose navigator hasn't decided **does not revert**: the contract emits `NavigatorVoteSkipped` / `NavigatorGovernanceVoteSkipped` and reduces the expected-action count for that citizen.

```
Citizen failed personhood check at snapshot     → contract emits skip, reduces expected
Navigator dead (deactivated/exited)             → contract emits skip, reduces expected
Navigator alive + decision/prefs set            → vote normally
Navigator alive + no decision + window reached  → contract emits skip, reduces expected
Navigator alive + no decision + window NOT reached → REVERT (relayer must wait)
```

The **personhood check** is worth highlighting: even if the citizen's navigator decided and you call `castNavigatorVote` early in the round, the contract still re-checks `VeBetterPassport.isPersonAtTimepoint(citizen, snapshot)` and emits the skip event if the citizen lacks a valid passport at the round/proposal snapshot. This is implicit — you don't need to pre-filter on personhood; the contract handles it gracefully. But it explains why a citizen with a "decided" navigator can still end up in the skipped set.

The relayer reads the configurable thresholds:

- `XAllocationVoting.citizenSkipWindowBlocks()` — for allocation
- `B3TRGovernor.governanceSkipWindowBlocks()` — for governance

And computes `skipWindowReached = latestBlock + skipWindowBlocks >= deadline`.

The per-citizen filter:

```ts
if (!hasPrefs && !skipWindowReached) { waitingForPrefs++; continue }   // wait for navigator
// otherwise include — either the navigator is ready, or the contract will skip on-chain
```

**Why this matters for pool unlock:** citizens **are** counted in `RelayerRewardsPool.totalActions[roundId]`. If you never call `castNavigatorVote` for them — neither vote nor skip — their expected actions stay outstanding and the pool can't unlock. Once the round/proposal is no longer Active, `castNavigatorVote` reverts on `validateStateBitmap` and there is no way for a relayer to reduce the expected count anymore. **Don't skip the skip path.**

---

## 6. Waiting for navigators: the polling lifecycle

The relayer **does not subscribe to navigator-readiness events** (`AllocationPreferencesSet`, `DecisionSet`, etc.). Instead it polls `hasSetPreferences` / `hasSetDecision` on `NavigatorRegistry` at the start of every cycle and re-derives the citizen filter each time. This is intentional:

- Navigators are few (10s to low 100s) — `batchHasSetPreferences` reads them all in one or two simulate calls.
- A polling-only design has no event-listener state to lose if the relayer restarts, no race conditions between event-handler and main-loop reads, and no "I missed the event during a node outage" failure mode.
- The cycle interval (5 minutes default) is fine-grained enough that citizens don't lose meaningful early-access time waiting.

### What the relayer does each cycle for citizens

For every cycle while the round is active:

```
1. Refresh delegation map (event scan, delta from last cached block)
2. Validate delegations at this round's snapshot (batch simulate)
3. Read hasSetPreferences(navigator, roundId) for every unique navigator
4. For each citizen:
     navigator decided      → include in batch (will vote on-chain)
     navigator NOT decided
       skip window reached  → include in batch (contract will skip on-chain)
       skip window not yet  → "waiting for prefs" → re-check next cycle
5. Run the batch
```

Same shape for governance, with `hasSetDecision(navigator, proposalId)` per proposal.

### Lifecycle of a single citizen across a round

```
T0  round starts, navigator hasn't set prefs
       relayer cycle: hasPrefs=false, skipWindow not reached → wait
       (citizen counted as "waiting for prefs")
T1  navigator calls setAllocationPreferences (off-cycle, on chain)
       relayer cycle (next tick): hasPrefs=true → cast vote
       (citizen counted as "voted")
T2  round deadline approaches, navigator forgot — skip window opens
       relayer cycle: hasPrefs=false, skipWindow reached → call castNavigatorVote anyway
       (contract emits NavigatorVoteSkipped, reduces expected actions)
T3  round ends
       relayer claim cycle: hasVoted(citizen)=true → claim
                            hasVoted(citizen)=false → skip ("did not vote")
```

There is no acknowledgement step. The relayer doesn't notice the navigator's preference event the same block it lands — it just notices on the next cycle that `hasSetPreferences` flipped.

### Why we don't subscribe to `AllocationPreferencesSet`

It would be tempting to listen for `AllocationPreferencesSet(navigator, roundId, …)` and cast votes immediately when a navigator decides. Two reasons we don't:

1. **Nothing is faster than the simulation gate anyway.** `processBatch` already simulates before sending; if you trigger a tx microseconds after the prefs-set event, you still wait for simulation. The 5-minute cycle interval doesn't meaningfully delay a citizen's vote relative to the round deadline.
2. **Same code path serves first-time and waited cases.** A polling design means there's exactly one decision flow ("what do I do with citizen X right now?") regardless of when the navigator decided. Event-driven adds branching: "did I already process this navigator? did I miss the event?" — and the bookkeeping for that across restarts is non-trivial.

If you want lower-latency voting for citizens, **shorten the poll interval** (`POLL_INTERVAL_MS`) rather than introducing an event listener.

---

## 7. Active proposals: discovery and per-round handling

Governance proposals are independent of allocation rounds — a proposal can:

- be created at any time during a round
- have its own `votingPeriod` (so its deadline doesn't necessarily match any round deadline)
- span multiple rounds if the period is long enough
- end mid-round, between rounds, or at exactly a round boundary

The relayer treats each active proposal as its own cycle. **It does not pre-pair proposals with rounds** — it just asks "what's active right now?" each tick.

### `getActiveProposals(): uint256[]`

`B3TRGovernor.getActiveProposals()` returns the IDs of every proposal currently in `ProposalState.Active`. The relayer calls this once per `runCitizenGovernanceVoteCycle` invocation and once per `runCitizenClaimRewardCycle` invocation.

Implementation note: proposal IDs are `uint256` derived from `keccak256(targets, values, calldata, descriptionHash)`. They are **not** sequential. They lose precision if cast to JS `Number` — see §11 for the bytes32-hex carry pattern.

### Per-proposal pipeline (governance vote cycle)

For every proposal returned by `getActiveProposals`:

```
1. Read proposalDeadline(proposalId)
2. Compute govSkipWindowReached = latestBlock + governanceSkipWindowBlocks >= deadline
3. batchHasSetDecision(navigators, proposalId)   — per-proposal map
4. getAlreadySkippedCitizensForProposal(governor, proposalId, snapshot, latest)
5. For each citizen:
     hasVoted(proposalId, citizen)? → skip
     in skipped set?               → skip
     navigator decided?
       yes → include
       no, window reached → include (contract emits skip)
       no, window not reached → wait
6. processBatch with [proposalId, citizen] clauses
```

Each proposal produces its own `CycleResult`, so `runCitizenGovernanceVoteCycle` returns `CycleResult[]` (one entry per proposal) rather than a single result.

### How it interacts with the round

A proposal's `roundIdVoteStart` is the round it counts toward for relayer expected-action accounting (`RelayerRewardsPool.setTotalActionsForRoundWithGovernance(roundId, allocationUsers, governanceUsers, activeProposalIds)` is called at round start with the proposals active *at that moment*).

Implications:

- A proposal that becomes Active mid-round is **not** added to that round's expected-action count. The relayer will still vote for it (because `getActiveProposals` returns it), and the relayer will earn `RelayerAction.VOTE` credit, but `totalWeightedActions[roundId]` doesn't increase.
- A proposal cached in `activeProposalsForRound[roundId]` but no longer active by the time you'd call `castNavigatorVote` — that proposal's expected actions can't be reduced anymore (state validation reverts). This is the same trap as the citizen-skip case: don't sleep through the skip window.

### Active proposals at claim time

`runCitizenClaimRewardCycle` calls `getActiveProposals` again *during the claim phase* to detect "did this citizen vote on any governance proposal in the previous round?". This works in practice because long proposals overlap the previous round's claim window, but if no proposals are currently Active the list will be empty and only allocation `hasVoted` is checked — which is still correct (a citizen who never voted has no rewards to claim regardless of the proposal-list contents).

Wrap the call in a try/catch — if `B3TRGovernor` isn't yet deployed on a network (or the address is the zero placeholder), `getActiveProposals` will revert and the relayer should treat the result as an empty list.

### Allocation preferences vs. governance decisions — what differs

| Aspect | Allocation (XAllocationVoting) | Governance (B3TRGovernor) |
|---|---|---|
| Per-citizen unit | `roundId` (sequential) | `proposalId` (uint256 hash) |
| What navigator sets | App weights for the round | Decision: 1=Against, 2=For, 3=Abstain |
| Readiness getter | `hasSetPreferences(nav, roundId)` | `hasSetDecision(nav, proposalId)` |
| Cast clause args | `(citizen, roundId)` | `(proposalId, citizen)` |
| Skip event | `NavigatorVoteSkipped` | `NavigatorGovernanceVoteSkipped` |
| Skip-window getter | `XAllocationVoting.citizenSkipWindowBlocks()` | `B3TRGovernor.governanceSkipWindowBlocks()` |
| Reduces expected action via | `RelayerRewardsPool.reduceUserAllocationVote` | `RelayerRewardsPool.reduceUserGovernanceVote` |
| Cardinality per round | 1 round = 1 alloc cycle | 1 round = 0..N gov cycles (one per active proposal) |
| ID encoding gotcha | `roundId` fits in `Number` safely | `proposalId` does NOT — use bigint or bytes32 hex |

The two flows are structurally identical, but they're separate code paths. Don't try to unify them prematurely — the differences in argument order, ID encoding, and per-proposal looping make a single abstraction more confusing than two parallel implementations.

---

## 8. Batch transaction processing

`src/relayer.ts:processBatch` takes an array of users + a `clauseBuilder(user) => Clause` and produces multi-clause transactions. It's used by every write phase.

```
for each batch of size BATCH_SIZE (default 50):
  estimate gas
    reverted    → isolateAndRetry
    ok          → sign + send
                  receipt reverted → isolateAndRetry
```

### Why batch at all?

Multi-clause txs amortise the base 21k gas across many users. On VeChainThor, all clauses share the same gas pool — if any one clause reverts, **the entire transaction reverts** and gas is wasted. Hence the simulation step.

### `isolateAndRetry` — failure containment

When a batch's gas estimation reverts, `isolateAndRetry` simulates each user individually:

```
for each user in failed batch:
  simulate one-clause tx
    reverted → record { user, reason } in outcome.failed
    ok       → add to `valid` list
re-batch the valid users → submit
```

This handles the realistic case where most users in a batch are fine but one or two have hit some on-chain edge case (e.g. just claimed in another tx, navigator deactivated mid-cycle). `outcome.failed` carries a reason string per user; if `gasResult.revertReasons[0]` decoded a Solidity revert message we use that, otherwise `vmErrors[0]`, otherwise the string `"reverted"`.

### Failure surfaces in the dashboard

`renderCycleResult` aggregates failures by reason and prints them under the cycle line:

```
Citizen Gov 3/5 successful
  2 failed (0x123...abc, 0x456...def)
    ↳ 2× governor: vote already cast
```

When debugging on-chain reverts, this output is the first thing to look at.

---

## 9. Auto-voter cycle (`runCastVoteCycle`)

Reads:

- `currentRoundId`, `roundSnapshot(roundId)`, `roundDeadline(roundId)`
- `getAutoVotingUsers(snapshot)` — event-driven
- `getAlreadySkippedVotersForRound(roundId, snapshot, latestBlock)` — `AutoVoteSkipped` event scan
- `getEarlyAccessBlocks()`, `getPreferredRelayersForUsers(users)` — for early-access filter
- `hasVoted(roundId, user)` for each candidate

Filter:

```
hasVoted        → skip (counted as "voted")
in skippedSet   → skip (counted as "ineligible")
isEarlyAccess && pref && pref != us → skip (counted as "reserved")
otherwise → unprocessed → processBatch
```

Clause:

```ts
Clause.callFunction(
  Address.of(xAllocationVotingAddress),
  xavAbi.getFunction("castVoteOnBehalfOf"),
  [user, roundId],
)
```

---

## 10. Citizen allocation cycle (`runCitizenAllocationVoteCycle`)

Reads:

- All of the auto-voter reads above (round snapshot, deadline, latest block)
- `getDelegatedCitizens(snapshot)` — event-driven (4 events, replayed in order)
- `getNavigatorsForCitizens(citizens, snapshot)` — batch simulate to confirm at snapshot
- `getAlreadySkippedCitizensForRound(xavAddress, roundId, snapshot, latestBlock)` — `NavigatorVoteSkipped` scan
- `batchHasSetPreferences(navigators, roundId)` — batch simulate
- `getCitizenSkipWindowBlocks()`
- Early access + preferred relayer (same as auto-voter)

Filter (per-citizen, after `hasVoted` check):

```
in skippedSet                          → skip (counted as "skipped")
!hasPrefs(nav) && !skipWindowReached  → skip (counted as "waiting for prefs")
isEarlyAccess && pref && pref != us   → skip (counted as "reserved")
otherwise → unprocessed
```

Clause:

```ts
Clause.callFunction(
  Address.of(xAllocationVotingAddress),
  xavNavAbi.getFunction("castNavigatorVote"),
  [citizen, roundId],
)
```

Note the **argument order**: allocation is `(citizen, roundId)`, governance is `(proposalId, citizen)`. They differ.

---

## 11. Citizen governance cycle (`runCitizenGovernanceVoteCycle`)

Returns an **array** of `CycleResult` — one per active proposal.

Reads (once):

- `getActiveProposals(governorAddress)` — returns `uint256[]`
- `getDelegatedCitizens(snapshot)`, `getNavigatorsForCitizens(citizens, snapshot)`
- `getGovernanceSkipWindowBlocks()`
- Early access + preferred relayer

Reads (per proposal):

- `proposalDeadline(proposalId)` — scalar (drives `govSkipWindowReached`)
- `batchHasSetDecision(navigators, proposalId)`
- `getAlreadySkippedCitizensForProposal(governorAddress, proposalId, snapshot, latestBlock)`
- `hasVoted(proposalId, citizen)` per citizen

Filter is the citizen-allocation filter with `hasDecision` instead of `hasPrefs`.

Clause:

```ts
Clause.callFunction(
  Address.of(b3trGovernorAddress),
  govAbi.getFunction("castNavigatorVote"),
  [proposalId, citizen],
)
```

### ⚠ proposalId precision — critical gotcha

OpenZeppelin-style proposal IDs are `keccak256(...)` packed into a `uint256`. The decoded value is well above `2^53`, so **`Number(decodedBigInt)` silently loses precision**. If you pass that truncated value back into `castNavigatorVote`, the contract sees a different proposalId, `validateStateBitmap` fails because that ID isn't an Active proposal, and every call reverts.

This relayer carries proposal IDs as **0x-prefixed bytes32 hex strings** end-to-end:

```ts
function toBytes32Hex(v: any): string {
  return "0x" + BigInt(v).toString(16).padStart(64, "0")
}
```

Viem (the SDK's ABI encoder) accepts hex strings as `uint256` arguments via `BigInt()`, so this round-trips correctly. If you write your own ABI layer, use `bigint` or hex strings — never `Number`.

The same applies to comparing event-log proposal IDs (`getAlreadySkippedCitizensForProposal` decodes `decoded.args.proposalId` and converts to bytes32 hex before comparing).

---

## 12. Claim cycle — auto-voters (`runClaimRewardCycle`)

Reads:

- `currentRoundId`, `previousRoundId = currentRoundId - 1`
- `roundSnapshot(prev)`, `roundDeadline(prev)`
- `getAutoVotingUsers(snapshot)` — same set the cycle voted for
- `getAlreadyClaimedForRound(voterRewardsAddress, prev, deadline, latestBlock)` — `RewardClaimedV2` event scan
- `getEarlyAccessBlocks()`, preferred relayer map

Filter:

```
!hasVoted(prev, user)  → skip ("did not vote" — nothing to claim)
in claimedSet          → skip ("already claimed")
isEarlyAccess && pref && pref != us → skip ("reserved")
otherwise → unclaimed → processBatch
```

Clause:

```ts
Clause.callFunction(
  Address.of(voterRewardsAddress),
  vrAbi.getFunction("claimReward"),
  [previousRoundId, user],
)
```

`VoterRewards.claimReward` reverts with `"VoterRewards: reward must be greater than 0"` if the user has no reward — this is why we filter out non-voters. The same `claimReward` is also used for citizens; the contract internally figures out which fees to deduct.

---

## 13. Claim cycle — citizens (`runCitizenClaimRewardCycle`)

Same shape as auto-voter claims, with the citizen-discovery preamble. The "did vote" check is broader — a citizen counts as having voted if **any** of these is true:

- `XAllocationVoting.hasVoted(prev, citizen) == true` (allocation vote)
- For some proposal `p` in the previous round, `B3TRGovernor.hasVoted(p, citizen) == true`

```ts
const votedAnywhere = allocationChecks[j] || governanceChecks[j]
if (!votedAnywhere) { didNotVote++; continue }
```

Note: `previousProposals` is read from `getActiveProposals(governorAddress)` at claim-cycle time. Proposals from the previous round may have already exited the `Active` state by the time we run, so this list might be empty. That's fine — if no governance vote happened, the allocation vote alone suffices.

---

## 14. Reward economics — and why the pool can lock

`RelayerRewardsPool` tracks two scalars per round:

- `totalWeightedActions[roundId]` — expected work (set when round starts via `setTotalActionsForRoundWithGovernance`)
- `completedWeightedActions[roundId]` — work actually performed

Pool unlock condition:

```solidity
function isRewardClaimable(uint256 roundId) external view returns (bool) {
  if (!cycle.isEnded(roundId)) return false;
  return completedWeightedActions[roundId] >= totalWeightedActions[roundId];
}
```

Action weights (read from `voteWeight()` and `claimWeight()` on the pool):

```
auto-voter expected: voteWeight + claimWeight             (per user)
citizen expected:    voteWeight + claimWeight             (allocation)
                   + voteWeight × activeProposals.length  (governance, citizens only)
```

`completedWeightedActions` increments when the relayer registers an action (`registerRelayerAction` is called from inside `castVoteOnBehalfOf`, `castNavigatorVote`, and `claimReward`).

`totalWeightedActions` decrements when the contract emits a skip event (`reduceUserAllocationVote`, `reduceUserGovernanceVote`) or when a relayer reduces a non-eligible auto-voter (`reduceExpectedActionsForRound`).

**Claim auto-reduction:** when a user's allocation vote AND every cached governance proposal have all been reduced for that round, the contract additionally calls `_checkAndReduceClaim` which removes the user's `claimWeight` from `totalWeightedActions`. This means a citizen who is fully skipped (no allocation vote, no governance vote) **also** has their claim slot auto-removed — you don't need to call `claimReward` for them. If only some of the votes are skipped (e.g. allocation skipped but governance voted), the claim slot stays and you still need to either call `claimReward` (if they have rewards) or accept that the pool's `total` won't match `completed` for that one missing claim.

### What happens if you never process some users

**They permanently inflate `totalWeightedActions` for that round.** Once the round/proposal exits the Active state, neither `castVoteOnBehalfOf` nor `castNavigatorVote` will accept the call (the contract reverts on state validation). The expected count is frozen and `completed >= total` will never hold. The pool stays locked for everyone.

This is the central reason to **always run the skip path past the skip window**. Even if a citizen will never get rewards (their navigator was AWOL), calling `castNavigatorVote` past the skip window emits the skip event, reduces expected, and unblocks the pool.

### Your share of the pool

```
yourShare = (yourWeightedActions / completedWeightedActions) × poolAmount
```

Read via `claimableRewards(relayer, roundId)` once the pool is unlocked. The relayer in this repo doesn't auto-claim its own pool share — it just exposes the value in the dashboard.

---

## 15. Fee model

| Fee | Levied on | Where deducted | Beneficiary |
|---|---|---|---|
| Navigator fee (20% in v1, fixed) | citizens only | `VoterRewards.claimReward` | `NavigatorRegistry` fee escrow, 4-round lock |
| Relayer fee (configurable, capped per round) | auto-voters AND citizens | `VoterRewards.claimReward` | `RelayerRewardsPool` (deposit) |

Order at claim time: navigator fee deducted first from gross reward → relayer fee deducted from the remainder → user receives the rest. The relayer fee is what flows into the pool relayers split.

`RelayerRewardsPool` getters used by the dashboard:

- `getRelayerFeePercentage()` / `getRelayerFeeDenominator()` → fee percent
- `getFeeCap()` → maximum fee per user per round (in B3TR wei)
- `getVoteWeight()`, `getClaimWeight()` → action weights

---

## 16. Read-call patterns

A few patterns are reused throughout the codebase:

### `executeContractRead` with retry

```ts
async function executeContractRead(thor, addr, abi, method, args = []) {
  for (let attempt = 1; attempt <= CALL_RETRIES; attempt++) {
    try {
      const res = await thor.contracts.executeCall(addr, abi.getFunction(method), args)
      if (!res.success) throw new Error(`Call ${method} reverted: ${res.result?.errorMessage}`)
      return res.result?.array ?? []
    } catch (err) {
      const isRevert = String(err).includes("reverted")
      if (isRevert || attempt === CALL_RETRIES) throw err
      await sleep(CALL_RETRY_MS * attempt)  // backoff
    }
  }
}
```

Reverts propagate immediately (genuine on-chain error). Network errors retry with backoff up to 3 attempts.

### Batch simulate

For "I have N users, I want to read the same view function for each":

```ts
async function batchSimulate(thor, contract, fn, keys, encodeArgs, decode) {
  const result = new Map()
  for (let i = 0; i < keys.length; i += BATCH /* 100 */) {
    const chunk = keys.slice(i, i + BATCH)
    const clauses = chunk.map(k => ({ to: contract, value: "0x0", data: fn.encodeData(encodeArgs(k)).toString() }))
    const results = await thor.transactions.simulateTransaction(clauses)
    for (let j = 0; j < results.length; j++) {
      const val = decode(chunk[j], results[j])
      if (val !== undefined) result.set(chunk[j].toLowerCase(), val)
    }
  }
  return result
}
```

100x fewer round-trips than per-user `executeCall`. Used for `userPreferredRelayer`, `getNavigatorAtTimepoint`, `hasSetPreferences`, `hasSetDecision`.

### Event pagination

Always 1000 per page, always offset+loop until a partial page returns:

```ts
let offset = 0
while (true) {
  const logs = await thor.logs.filterEventLogs({
    range: { unit: "block", from, to },
    options: { offset, limit: MAX_EVENTS },
    order: "asc",
    criteriaSet: [{ criteria: { address, topic0 }, eventAbi: event }],
  })
  for (const log of logs) { /* decode + accumulate */ }
  if (logs.length < MAX_EVENTS) break
  offset += MAX_EVENTS
}
```

---

## 17. Events to scan

Compact reference for what to scan when:

| Event | Source | Why the relayer cares |
|---|---|---|
| `AutoVotingToggled(account, enabled)` | XAllocationVoting | Auto-voter discovery |
| `AutoVoteSkipped(voter, roundId, isPerson, appsCount, votingPower)` | XAllocationVoting | Don't retry ineligible auto-voters |
| `NavigatorVoteSkipped(citizen, navigator, roundId)` | XAllocationVoting | Don't retry skipped citizens (allocation) |
| `NavigatorGovernanceVoteSkipped(citizen, navigator, proposalId)` | B3TRGovernor | Don't retry skipped citizens (governance) |
| `RewardClaimedV2(cycle, voter, reward, gmReward)` | VoterRewards | Don't retry claims |
| `DelegationCreated(citizen, navigator, amount)` | NavigatorRegistry | Citizen discovery |
| `DelegationIncreased(citizen, navigator, addedAmount, newTotal)` | NavigatorRegistry | **Optional** — only if you track per-citizen amounts (rewards estimates). Citizen→navigator mapping unchanged. |
| `DelegationDecreased(citizen, navigator, removedAmount, newTotal)` | NavigatorRegistry | **Optional** — same as above. |
| `DelegationRemoved(citizen, navigator, amount)` | NavigatorRegistry | Citizen removal |
| `ExitAnnounced(navigator, …)` | NavigatorRegistry | Lazy invalidate all citizens of that nav |
| `NavigatorDeactivatedEvent(navigator, slashPercentage)` | NavigatorRegistry | Same as above |
| `PreferredRelayerSet(user, relayer)` | RelayerRewardsPool | Build user→relayer preference for early access |

Any caching layer must replay the routing events (`Created`, `Removed`, `ExitAnnounced`, `NavigatorDeactivatedEvent`) **in chronological order across types**, otherwise a citizen who switched navigators in a single tx ends up either deleted or pointing at the wrong navigator.

---

## 18. Configuration the relayer reads from chain (don't hardcode)

| Value | Source | Why |
|---|---|---|
| `voteWeight`, `claimWeight` | `RelayerRewardsPool` | weights are governance-configurable |
| `relayerFeePercentage`, `relayerFeeDenominator`, `feeCap` | `RelayerRewardsPool` | fee schedule is governance-configurable |
| `earlyAccessBlocks` | `RelayerRewardsPool` | window length is governance-configurable |
| `citizenSkipWindowBlocks` | `XAllocationVoting` | window length is governance-configurable, **per-environment** |
| `governanceSkipWindowBlocks` | `B3TRGovernor` | window length is governance-configurable, **per-environment** |
| `proposalDeadline(proposalId)` | `B3TRGovernor` | governance proposals can have arbitrary lengths |
| `roundDeadline(roundId)` | `XAllocationVoting` | per-round deadline |

Hardcoding `SKIP_WINDOW_BLOCKS = 720` (the old default) will work right up until governance updates it on one network and not the other — at which point your relayer either tries to skip too early (reverts) or waits past the deadline (locks the pool).

---

## 19. Inline ABI fragments

The relayer's installed `@vechain/vebetterdao-contracts` package may not yet contain the navigator-related artifacts. Where typechain factories don't exist, the relayer carries inline ABI fragments in `src/citizen-contracts.ts`:

- `GOVERNOR_ABI` — `getActiveProposals`, `hasVoted`, `proposalDeadline`, `governanceSkipWindowBlocks`, `castNavigatorVote`
- `NAVIGATOR_REGISTRY_ABI` — `getNavigatorAtTimepoint`, `hasSetPreferences`, `hasSetDecision`, `isDeactivated`, plus the four delegation events
- `XAV_NAVIGATOR_ABI` — `castNavigatorVote(citizen, roundId)`, `citizenSkipWindowBlocks`, `NavigatorVoteSkipped`
- `GOVERNOR_NAVIGATOR_ABI` — `NavigatorGovernanceVoteSkipped`

When the contracts package ships these, swap the fragments for typechain factories — but until then, inline ABI is the cleanest way to keep moving without forking the contracts repo.

---

## 20. Gotchas and lessons learned

- **`Number(uint256)` for proposal IDs is silently broken.** Use bigint or hex strings. The same applies to large round IDs if your protocol uses hash-derived round IDs anywhere.
- **`hasSetDecision(navigator, proposalId)` only returns true for the exact proposalId.** A truncated or otherwise wrong proposalId returns false even if the navigator decided — and your relayer waits forever, the skip window passes, and the pool locks.
- **Don't pre-filter citizens out completely just because their nav hasn't decided.** Pre-skip-window: yes, drop them. Past-skip-window: include them so the on-chain skip path runs and reduces the expected count.
- **Batch simulation poisoning:** if any clause in a multi-clause tx is doomed to revert, every clause in the tx wastes gas. The simulate-then-isolate pattern is mandatory; don't ship without it.
- **Event filtering by `topic0` alone matches all rounds.** Always re-check the round/proposal ID inside the decoded event.
- **Cache snapshots forwards-only.** If `toBlock < cache.lastBlock` (testnet reset, chain rewind), invalidate the whole cache rather than partial-merge — partial-merge is hard to get right with conflicting events.
- **Order events across types when replaying.** Same-block delegation Create/Remove pairs are common when a citizen switches navigators atomically.
- **The skip window is configurable per network.** Read it from the contract every cycle (it's cheap and you'll catch governance changes immediately).

---

## 21. File map

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point, env parsing, wallet derivation, main loop, node rotation |
| `src/config.ts` | Network configs (mainnet / testnet-staging / solo) |
| `src/contracts.ts` | Auto-voter & general reads — `XAllocationVoting`, `RelayerRewardsPool`, `VoterRewards` |
| `src/citizen-contracts.ts` | Navigator / citizen / governance reads + inline ABI fragments |
| `src/relayer.ts` | Auto-voter cycles + shared `processBatch` / `isolateAndRetry` |
| `src/citizen-relayer.ts` | Citizen allocation / governance / claim cycles |
| `src/display.ts` | Terminal dashboard rendering |
| `src/types.ts` | `NetworkConfig`, `RelayerSummary`, `CycleResult`, `LogFn` |

If you're porting to another stack, the order of files to translate is roughly:

1. `types.ts` — interface definitions
2. `contracts.ts` + `citizen-contracts.ts` — read patterns
3. `relayer.ts` (`processBatch` + `isolateAndRetry`) — batching primitive
4. `relayer.ts` cycles + `citizen-relayer.ts` cycles — business logic
5. UI/logging is yours to design

---

## 22. Verifying your port

A custom relayer is correct iff, for any given round, all of the following hold:

1. Every auto-voter who hasn't voted and isn't ineligible gets exactly one `castVoteOnBehalfOf` call (or one `AutoVoteSkipped` from another relayer).
2. Every navigator-delegated citizen whose navigator decided gets exactly one `castNavigatorVote` per phase (allocation + each active governance proposal).
3. Every navigator-delegated citizen whose navigator did NOT decide gets one skip call past the skip window — for both allocation and each governance proposal.
4. Every voter / citizen who has rewards to claim gets exactly one `claimReward(prev, voter)` call, after the round ends, after early access expires (or by their preferred relayer during early access).
5. `isRewardClaimable(roundId)` returns true within a few blocks of the round ending.

If (3) doesn't hold, the round will eventually have `completedWeighted < totalWeighted`, the pool locks, and **no relayer** earns from that round. This is by design — the protocol incentivises completeness over speed.

If you're testing on a fresh network, watch the dashboard's `Round #N — Actions completed` status. That's the protocol-level confirmation that your relayer is doing its job.
