# Death & Taxes Bot

A self-hosted automation bot for the on-chain game **[Death & Taxes](https://etherscan.io/address/0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F)** by Transient Labs. It watches the game for you and acts automatically:

- **Defense (pre-audit only):** the bot takes **zero automatic action once a citizen is audited** — it will not pay to clear the audit and will not spend a held bribe. Recovering an audited citizen is entirely your call, via the **Pay to current** / **Clear audit (bribe)** buttons on the token row. What stays automatic is keeping citizens current *before* they can be audited (proactive pay, prepay up to 7 epochs to lock the current rate, and the JIT boundary payment) — and those skip any citizen already under audit. Any citizen you **uncheck** in the JIT panel is excluded from *every* automatic payment. Consequence: an audited citizen you do not pay yourself becomes killable when its 24h audit expires.
- **Just-in-time epoch payment (one-shot):** arm the bot for a single upcoming epoch and it pays exactly one epoch for each of your citizens *the moment that epoch begins on-chain* — before they can be audited — then auto-disarms. E.g. arm for epoch 133 and it pays `133 × 0.00069 = 0.09177 ETH` per citizen the instant epoch 133 starts. The exact amount is read on-chain at pay time, so it's always correct even for multiple citizens. Each JIT payment is exactly one epoch (one day) and advances the citizen a single epoch, so it fires even when a citizen is momentarily 2 epochs behind at the boundary, and never balloons into a multi-day charge — see the **per-payment epoch cap** below.
- **Offense (optional):** audit delinquent rivals and `kill` expired-audit tokens to thin the field toward the winning 69. It audits **multiple rivals per epoch** — up to each eligible citizen's **`auditLimit`** (auditor-role tokens can audit several times per epoch; the bot reads each token's remaining capacity and uses all of it), instead of just one. This is a game strategy, not a profit engine — see below.
- **Reliable inclusion:** choose your submission path — **`mainnet`** (the default: private **bundles** fanned out to several block builders; bundles sit in the block's top region *regardless of tip*, which is what wins a boundary race — and payments still mirror to the public mempool so they can't fail to land) or **`public`** (mempool only, seated after every bundle). Optional latency edges let payments/offense compete in the *first eligible block* instead of the block after (see [Latency edges](#latency-edges)).
- **Live activity log:** every action is timestamped with its status; submitted transactions link to Etherscan and auto-update from **submitted → included / reverted** once the receipt lands.
- **Race post-mortem:** after the fact, paste your tx hash and a rival's to see whether you lost on **timing** (later block) or **fee** (same block, out-priced) — in the dashboard or from the CLI.

You run it on your own machine with your own key. It ships with a local web dashboard.

> ⚠️ **This is not a money-printer.** In Death & Taxes, `audit` and `kill` pay the
> caller **nothing** — there is no arbitrage/MEV profit per transaction. The bot's
> value is *keeping your tokens alive* and *helping you play toward being one of the
> 69 survivors*. It spends ETH (taxes, audit fees, gas); it does not earn any.

---

## How the game works (what the bot automates)

| Concept | Detail |
| --- | --- |
| Epoch | 24 hours. Tax rate for an epoch = `epoch × 0.00069 ETH`, so daily cost **rises over time**. |
| Delinquent | A token that is ≥ 2 epochs behind on taxes. Delinquent tokens can be audited by anyone. |
| Audit | Costs `0.00069 ETH`. Starts a **24h countdown** on a delinquent target. 1 audit per token per epoch. |
| Kill | Free, callable by **anyone** once a token's audit countdown expires. Turns the Citizen into a dead "Evader". |
| Clear an audit | The target `payTaxes` (pays back-taxes) or `useBribe` (free, if it holds a bribe) before expiry. |
| Life insurance | **Cosmetic only** — it changes the dead-Evader artwork. It does **not** prevent death. |
| Emigration | `safeTransferFrom` a Citizen to an emigration contract and it mints you a membership NFT. Two routes exist: [Governor](https://etherscan.io/address/0xE56d011262d4738dC8307fb8a4Ae48B2bFc20E7C) (36 available, first come) and [ABBC](https://etherscan.io/address/0xbFFFc99Fa75A0FEA45b765d11d8e52F8E1114F8c) — "anti bot bot club". One-way either way: the contract holds the Citizen forever and has no way to pay taxes or spend a bribe. |
| Winning | The game ends when the Citizen supply drops to **69**; the survivors win. |

**Emigrated citizens are out of the main game.** The bot treats them that way: they're
excluded from every offense sweep (no audits, no kills) and from the **Rival targets**
panel, and listed on their own under **Emigrated citizens** in the dashboard. Defense
needs no special handling — an emigrated token is no longer owned by your wallet, so it
drops out of the owned set by itself. They still count toward the supply that ends the
game (they leave it only when somebody else kills them), so the endgame gate
(`endgameOnlyWithin`) still reads the raw on-chain Citizen supply.

**Both routes count as emigrated.** Every "has this citizen left the game" check consults
the full destination set (`EMIGRATION_DESTINATIONS` in `packages/shared/src/constants.ts`),
so adding a future route is one entry there rather than a hunt for hard-coded addresses.
ABBC emits the identical `Emigrated(address, uint256)` event as the Governor contract, so
one scanner covers both — each with its own cursor, since they were deployed ~86k blocks
apart.

> ⚠️ For ABBC the address that matters is the **vault** that receives the citizens
> (`0xbFFFc99F…14F8c`), *not* the ABBC token contract (`0xFEc1DD88…58453`). The token
> contract is a 45-byte proxy that only mints the membership NFT and never holds a
> citizen — watching it finds zero emigrations.

The **Emigrated citizens** panel is the full history, read from each contract's `Emigrated`
event log rather than from who currently holds what. An emigrant that has already been
killed is burned and disappears from every ownership index, so an ownership-based list
would keep shrinking as they die — it read 5 when 13 had emigrated. Killed emigrants stay
on the list, dimmed and marked `killed`. Rows are grouped by route with a per-route
held/killed count; the header's "slots left" counts the **Governor** route only, since that
is the contract with a fixed supply of 36.

---

## Architecture

npm workspaces monorepo:

```text
packages/
  shared/    # Contract ABI, game constants, shared TypeScript types
  backend/   # The bot: chain reads, encrypted keystore, Flashbots submitter,
             # strategy engine, and a local REST + WebSocket API
  web/       # React + Vite dashboard (talks to the backend API)
```

The backend holds an **encrypted hot-wallet key** (scrypt + AES-256-GCM) and signs
transactions locally with [viem](https://viem.sh). Ownership is indexed via the
**Alchemy NFT API**; chain state via your Alchemy RPC (WSS + HTTPS).

---

## Setup

**Requirements:** Node.js ≥ 20, and an [Alchemy](https://alchemy.com) API key
(free tier is fine) for the Ethereum mainnet RPC + NFT API.

```bash
git clone <this-repo> && cd death-and-taxes-bot
npm install
install -m 600 .env.example .env  # then edit .env and set ALCHEMY_API_KEY
npm run dev                 # starts backend (:8787) + dashboard (:5173)
```

**One-click launch:** double-click **`start.bat`** on Windows or **`start.command`**
on macOS. Either one installs dependencies on first run, starts the dev server, and
opens the dashboard. On macOS the first launch may need a right-click → **Open** to
clear Gatekeeper, and if double-click doesn't run it, mark it executable once with
`chmod +x start.command`.

Open the dashboard at **`http://localhost:5173`** and:

1. **Create a hot wallet** — generate a fresh burner or import a private key. It's
   encrypted at rest with a passphrase you choose. **Use a dedicated burner funded
   only with what you're willing to spend.** **This wallet must hold the Citizen
   tokens you want defended** — the bot only pays taxes for and defends Citizens
   owned by the wallet it unlocks. A freshly generated burner owns none until you
   transfer Citizens into it, so to protect Citizens you already hold, import that
   wallet's key.
2. **Unlock** it with your passphrase.
3. Configure your **strategy** (defense buffers, offense toggles, spend caps).
4. Click **Start bot**. The bot is live-fire: once unlocked, started, and `enabled`, it submits real transactions.

Fund the wallet with a little ETH for taxes/audits/gas. Keep the dashboard's
**spend cap** and **min-balance floor** set to values you're comfortable with.

### Production run

```bash
npm run build
npm start          # API + built dashboard at http://localhost:8787/
```

After a build, the backend serves `packages/web/dist` from the same loopback
port as the API. Open **`http://localhost:8787/`**. You can still host that
`dist` folder yourself if you want; if you do, preserve at least
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
(the backend already sets both). Otherwise another site could iframe the local
dashboard and attempt clickjacking. The bundled Vite development and preview
servers deny framing too.

### Versioning & releases

The bot has a single version string (`VERSION` in
`packages/shared/src/constants.ts`). It's shown **in the dashboard header** (next to
the title) and **logged at startup**, so you can always confirm which build you're
running — and the dashboard flags a warning if the running backend's version
doesn't match the dashboard's (e.g. a half-updated copy).

To cut a release zip:

```bash
npm run package    # writes release/death-and-taxes-bot-v<VERSION>.zip
```

The zip is named after the version, so recipients can tell an old build from a new
one at a glance. It's built with `git archive`, so it contains only committed,
tracked files — no `node_modules`, no `.env`, and none of your local
`data/settings.json` or keystore. When you ship a new build, bump `VERSION` (and the
matching `package.json` `version` fields — `npm run package` refuses to run if they
disagree) and commit before packaging.

**Tag it so GitHub serves a versioned download.** GitHub's green *Code → Download
ZIP* button always gives `DT-<branch>.zip` (a branch has no version). To get a
version in the filename, push a tag:

```bash
git tag -a v0.5.0 -m "v0.5.0"
git push origin v0.5.0
```

GitHub then serves the tagged source archive as **`DT-0.5.0.zip`** (leading `v`
stripped) from the repo's **Tags**/**Releases** page and at
`https://github.com/<owner>/DT/archive/refs/tags/v0.5.0.zip`. For a published
**Release** with the nicer `death-and-taxes-bot-v<VERSION>.zip` name, draft a
release on that tag and upload the `npm run package` artifact as an asset (via the
web UI or `gh release create`).

Any archive also carries a stamped top-level **`VERSION`** file (filled in at
download time via `git archive` `export-subst`), so even the unversioned
`DT-master.zip` from the green button is identifiable — it reads e.g.
`v0.5.0-3-g<sha>`.

#### Updating manually

The bot does not check for, download, or install code or data-file updates. The
launchers start the version already on disk, and the dashboard makes no outbound
version check. This keeps changes to executable code and strategy inputs under the
operator's control.

For a git checkout, stop the bot, review the upstream changes, and update explicitly:

```bash
git pull --ff-only
npm install
npm run build
```

For a ZIP install, download a trusted versioned release, extract it into a new
directory, and review it before starting it. Copy `.env` and only the local state you
intend to preserve (`data/settings.json`, `data/activity.json`, `data/config.json`,
`data/flashbots-signer.key`, and `data/*.keystore.json`). Reconcile any locally
edited curated-list files deliberately instead of copying the whole old `data/`
directory over the new release. Keep a secure backup of the local files: they contain
the encrypted keystore, runtime configuration, and other state. Using a fresh
directory also avoids retaining code files removed by a later release.

The four curated list files are part of each release and change only through a
manual update. They are the bot's shared game intelligence and may change as the
game is played:

| File | What it is |
| --- | --- |
| `data/rival-targets.json` | The curated rival roster (the "reset to default" list). |
| `data/rival-skippers.json` | Rivals that pay on a ~2-epoch cadence, so they're auditable at every boundary. Seeds the offense targets. |
| `data/ally-tokens.json` | Teammates. **Never** audited or killed. |
| `data/do-not-target.json` | Big-boy operators that cure at the top of the boundary block, so an audit slot spent there is wasted. |

Review list changes carefully, especially `ally-tokens.json` and
`do-not-target.json`, because they affect whom the offense engine may target. In a
git checkout, local edits to tracked list files may need to be reconciled during a
pull. In a ZIP install, choose deliberately whether to keep your locally edited
copies or adopt those from the new release. Once you've customised the offense
target box, you can re-adopt the shipped `rival-skippers.json` list with the
one-click *skippers* template in the Config panel.

#### `DEFAULTS_VERSION` — pushing new defaults to existing users

`DEFAULTS_VERSION` (in `packages/backend/src/runtime.ts`) is **separate from
`VERSION`** and is what applies updated recommended *settings* after an operator
manually installs a new release.

Users keep their `data/` folder across updates (it holds the wallet keystore and
API key), so their `data/config.json` survives — and saved values win per-field,
meaning a changed default would otherwise *never* reach them. On load, a config
stamped with an older `DEFAULTS_VERSION` has its recommended fields re-applied
(gas tuning, behaviour flags, and the curated `data/rival-targets.json` list),
while their own choices are preserved: run mode, coinbase bid + payer, spend
guardrails, and JIT selection. The change is reported to the log and the activity
feed. It's deliberately *not* tied to `VERSION` so a routine release doesn't reset
anyone's tuning.

#### Release checklist

1. Bump **`VERSION`** in `packages/shared/src/constants.ts` **and** the `version`
   field in the root + all three `packages/*/package.json` (`npm run package`
   refuses to run if they disagree), then `npm install --package-lock-only`.
2. **Bump `DEFAULTS_VERSION`** in `packages/backend/src/runtime.ts` **if — and only
   if — you changed a recommended default** (gas tuning or a behaviour flag).
   Skipping this means existing users silently stay on the old settings; bumping it
   needlessly resets their tuning. Curated list changes ship with a release and do
   not require a defaults-version bump.
3. Mirror any default changes into `data/config.example.json` (docs only, but keep
   it honest).
4. `npm run build && npm test`, then commit.
5. `npm run package` to write `release/death-and-taxes-bot-v<VERSION>.zip`.
6. `git tag -a v<VERSION> -m "v<VERSION>" && git push origin v<VERSION>`.

---

## Configuration (`.env`)

| Var | Purpose |
| --- | --- |
| `ALCHEMY_API_KEY` | Derives the mainnet HTTPS/WSS RPC and NFT API endpoints. |
| `RPC_HTTP_URL` / `RPC_WS_URL` / `ALCHEMY_NFT_URL` | Explicit overrides (any RPC). |
| `MODE` | `mainnet` (**default** — private bundles to `BUILDER_URLS`; payments also mirror to the mempool so they still land), `public` (mempool only), or `local` (Anvil chain ID 31337, with an explicit local `RPC_HTTP_URL`). Also switchable between live modes at runtime from the dashboard. |
| `BUILDER_URLS` | Comma-separated builders that receive your bundle in `mainnet` mode. Only the builder that **wins the slot** can include it, so the bot submits to **all** in parallel and succeeds if any accepts. Defaults to Flashbots, **BuilderNet**, beaverbuild and Titan (all verified live). Endpoints do change — verify against each builder's docs. |
| `PORT` / `HOST` | Local API bind (default `127.0.0.1:8787`). Non-loopback hosts are refused because this API has no remote-user authentication or TLS. |
| `COINBASE_PAYER_CODE_HASHES` | Comma-separated approved Coinbase payer runtime-code hashes. Coinbase bidding fails closed when this is empty or the configured payer does not match. |
| `OWNED_TOKENS` / `TARGET_TOKENS` | Comma-separated tokenId overrides for local testing without the NFT API. |

Secrets live in `.env` and `data/` (the encrypted keystore + a Flashbots
reputation key). Both are git-ignored. **Never commit them.** The backend tightens
`.env`, settings, keystore, and backup files to owner-only permissions; keep the
repository and `data/` directory out of shared or cloud-synchronized locations.

Strategy settings are edited from the dashboard and saved to `data/config.json`
(also git-ignored, since it holds your live strategy). With no such file the bot
starts from the recommended defaults — the master switch (`enabled`) off, so
nothing is submitted until you Start it. To seed a starting point, copy the
template:

```bash
cp data/config.example.json data/config.json
```

---

## Away mode — cut provider usage to near zero

Every automatic action the bot takes fires **at an epoch boundary** (proactive pay, JIT,
pre-boundary audit/kill). But a running engine reacts to *every block*, which costs
roughly **22 provider requests per minute** around the clock — for work that happens
once a day.

**Away mode keeps the engine stopped and wakes it just before each boundary**, then
stops it again once the boundary work has settled (5 minutes of grace). Toggle it in the
dashboard's top bar; it applies instantly, like **Start bot**.

Idling costs **zero requests**. Boundaries are `startTime + N × EPOCH_DURATION`, so the
next one is arithmetic on the wall clock — there is nothing to poll. The dashboard also
stops its own 20s poll while away mode is on, so an open tab costs nothing either.

`awayLeadMinutes` (default **15**) sets how early to wake. The engine needs to be up
before the pre-boundary race arms, so leave headroom rather than trimming this to
seconds.

It only wakes when there is something to wake **for** — proactive pay on, a JIT arm, or
offense enabled. With everything off, no wake is scheduled and the dashboard says so
rather than counting down to a no-op.

**The trade-off:** while the engine is stopped the bot is not watching. Nothing reacts to
a mid-epoch event — an ally in trouble, a rival suddenly becoming killable — until the
next wake. Away mode suits defending your own citizens on a schedule; leave it off if you
want the bot opportunistically hunting between boundaries.

---

## Safety model

- **You are the sole custodian.** The key never leaves your machine and is only
  decrypted in memory after you enter your passphrase. An existing keystore is
  never silently overwritten — re-creating a wallet requires an explicit confirm,
  so you can't accidentally discard the old key.
- **Guardrails:** min-balance floor, max base-fee, an optional **max single-payment
  cap** (skips any tax payment above a set ETH value — a backstop against a bad
  estimate or a badly-delinquent token draining the wallet in one shot; `0` = off),
  and a global **pause/kill switch**.
  The min-balance floor is enforced **cumulatively** — several payments in one
  cycle can't sneak the wallet below it.
- **Per-payment epoch cap (`maxAutoPayEpochs`, default `1`):** the most epochs a
  single **automatic** payment may cover. On-chain, `payTaxes(tokenId, n)` costs
  `n × currentEpoch × base` and advances the token `n` epochs, so this caps the ETH
  spent per auto payment. At the default of `1`, auto-payments never spend more than
  one day's taxes at once — a lost/failed payment never balloons into a multi-day
  charge. **JIT and the pre-boundary race always pay exactly one epoch and are never
  blocked by this**, so the single-epoch payment for the upcoming epoch still fires
  even when a citizen is momentarily 2 epochs behind at the boundary (the tax-skip
  case). The cap only limits the multi-epoch paths — proactive-pay and defense —
  which otherwise pay `prepayEpochs`; raise it to let those auto-catch-up several
  epochs in one payment. Edited in the **Just-in-time epoch payment** panel.
- **Separate offense gas (audit/kill):** audit/kill bid their own gas,
  independent of payments — it's a race against rivals where a payment isn't, so
  it carries a different tip and base-fee cap. **On by default**; turn off
  **Separate gas for audit / kill** to make one set of gas settings apply to
  everything. The shipped payment defaults are tuned to win the boundary bundle
  race (a ~15 gwei tip clears the observed batch-audit bundles at ~3 gwei, with
  dynamic tip scaling it up in contested blocks); offense carries its own tip and
  a tighter base-fee cap. Payment gas is edited under **Just-in-time epoch
  payment → Payment gas**; offense gas under **Offense**.
- **Simulate-before-send:** every transaction is checked before final authorization and
  signing (normally with `eth_call` against the identity-checked HTTP RPC), so reverting
  transactions aren't paid for and nonces aren't burned on them. No usable signature is
  sent to a relay before the exact spend guard and durable nonce reservation pass.
- **Payments always land, even in `mainnet` mode.** A bundle is only included if a
  builder you sent it to wins the slot, so a bundle-only payment can silently fail
  to land — which can cost a citizen. Tax payments are therefore **always** mirrored
  to the public mempool alongside the bundle (identical tx, so only one can land).
  There's nothing to protect by hiding a tax payment: rivals already see the
  delinquency on-chain.
- **Local-only by design.** The API refuses non-loopback binding, rejects unexpected
  `Host` values, and requires a random per-process session token on reads, writes, and
  WebSockets. Mutations also enforce browser Origin/Fetch Metadata checks, while the
  dashboard denies framing. The token is a browser barrier, not local-user authentication:
  do not run on a shared-login host, or proxy, tunnel, or expose the API to the internet.

---

## Latency edges

Rivals often win by landing in an *earlier block*, not by paying more. These
optional, off-by-default edges close that gap (configure them in the dashboard):

- **Race the public mempool** (`mainnet` mode only) — also broadcasts a
  time-critical **offense** tx to the public mempool alongside the bundle, so *any*
  builder can include it next block. The tx is identical (same nonce), so only one
  can ever land. Trades bundle privacy for lower inclusion latency. It's opt-in for
  offense because a *visible pending audit* lets the target escape by paying first.
  **Payments don't need this toggle** — in `mainnet` mode they always mirror to the
  mempool (see below), and both paths fire concurrently so neither waits on the other.
- **Dynamic priority tip** — scales the tip up as the latest block fills past 50%,
  up to a configurable ceiling, to stay competitive in contested blocks. When off,
  the static priority fee is always used. It applies to **tax payments** too (set
  under *Just-in-time epoch payment → Payment gas*) — useful when a boundary-timed
  payment has to out-order a rival's batch-audit in the first block of an epoch.
- **Race into the boundary block** (advanced, opt-in, `payTaxes` only) — the
  ordinary JIT pay fires *just after* the boundary, so it lands one block late. This
  mode instead *pre-submits* the armed JIT payment shortly **before** the boundary
  with a value computed off-chain for the upcoming epoch, so it can land in the
  **first block of the epoch** ahead of a batch-auditor (matching the fastest
  rivals). The value is validated by **simulating at the boundary timestamp**
  (`eth_call` block overrides, or `eth_callBundle`'s `timestamp` on mainnet), so a
  wrong value is caught before spending gas; the normal post-boundary JIT pay still
  runs as a fallback. Off by default; enable it under *Just-in-time epoch payment →
  Payment gas*.
- **Coinbase bid (advanced, opt-in, `mainnet` only)** — a **flat ETH payment straight
  to the block builder** added to the pre-boundary payment bundle, to bid it to the
  **top of the boundary block regardless of tip**. This is the lever the strongest
  batch-auditors use: at the boundary the required `payTaxes` amount is only valid in
  the first slots of the block, so *position is correctness* — a payment that lands
  deep reverts. A coinbase transfer is a fixed cost independent of gas (unlike a
  priority tip, which scales with it), so it's the capital-efficient way to buy the
  top slot. It rides the bundle **allowed-to-revert** and is **never mirrored** to the
  mempool, so it only ever spends when the bundle wins the slot, and a misconfigured
  payer can't drop your payment. Coinbase bidding is fail-closed: deploy the current
  **`contracts/CoinbasePayer.sol`**, put its address in `data/config.json`, and add its
  deployed runtime code hash to `COINBASE_PAYER_CODE_HASHES`. The bot checks both code
  presence and the allowlisted hash before signing a bid. No shared payer is trusted by
  default. **Off by default.**
- **Combine payment + audit into one atomic bundle (`mainnet` only)** — when a
  pre-boundary payment and an audit are both due at the same epoch boundary, fuse
  them into a **single** bundle (sequential nonces) instead of two, so they land
  consecutively top-of-block, share **one** coinbase bid instead of two, and can't
  demote each other. **Self-guarding and on by default:** it only actually fuses when
  a coinbase bid is set (`coinbaseBidEth > 0`); without a bid it's a no-op and the bot
  sends separate bundles so the audit keeps its public-mempool fallback. Payment is
  always mempool-mirrored either way and is never dropped. So a later coinbase bid
  "just works" without a second toggle — but nothing changes until you set one.
- **Atomic multi-tx bundles (`mainnet` mode, automatic)** — every Citizen you hold
  is owned by the same wallet, so paying/auditing several in one cycle produces
  multiple txs on a single nonce sequence. Sent as independent one-tx bundles, only
  the first (nonce == chain nonce) is a self-valid bundle; the rest carry a nonce
  gap and won't be placed top-of-block by builders. The bot instead collects a
  cycle's txs and submits them as **one atomic bundle** (txs in nonce order), so
  **all** of them win top-of-block together — what you need to out-order a
  batch-auditor hitting several of your citizens at once. Each tx still mirrors to
  the public mempool individually as a fallback. No configuration; always on in
  `mainnet` mode.
- **Race audits/kills into the first block** (advanced, opt-in) — the offense
  equivalents. *Race audits* pre-submits audits just before the epoch boundary so
  they land the instant rivals become delinquent (like a batch-auditor); *race
  kills* pre-submits a `kill` just before a target's audit-expiry so it lands in
  the first eligible block. Both are validated by simulating at the boundary/expiry
  instant, reuse the shared pre-submit lead, and fall back to the normal
  post-deadline offense. Off by default; enable under *Offense*. Note: boundary
  block position is driven by **builder orderflow**, not tip — a defender who
  pre-pays will beat your audit regardless of gas, so this is lower-value than the
  payment race.
- **Salted rival sweep order** — every bot sees the same candidate list in the
  same order (same indexer, same on-chain enumeration), so without this every
  instance would sweep the same tokens first, piling onto identical targets while
  starving whichever ones are late in the list once the auditor-token pool runs
  out. Each engine start picks a random salt and uses it to reorder the sweep
  (offense, pre-boundary audit, pre-boundary kill) for that run — stable for the
  run's lifetime, but different across restarts and across users. Always on, not
  configurable.

## Race post-mortem

Compare your transaction against a rival's to diagnose *why* you lost a race —
**timing** (you landed in a later block; more gas wouldn't have helped) vs **fee**
(same block, out-priced). Available in the dashboard, or from the CLI:

```bash
# your tx first, then one or more rival txs
npx tsx packages/backend/src/postmortem.ts <yourTx> <rivalTx> [<rivalTx> ...]
```

It reports each tx's block, index, and effective priority tip, then a per-pair
verdict and a summary. Needs an RPC (`ALCHEMY_API_KEY` or `RPC_HTTP_URL`).

---

## Verification

```bash
npm test                    # unit tests: keystore round-trip, epoch/delinquency
                            # math, audit-expiry classification, spend guardrails
```

**Live read check** (no key, no spend) — confirms the read layer against mainnet:

```bash
RPC_HTTP_URL=<your-rpc> npx tsx packages/backend/src/probe.ts
```

**Mainnet-fork end-to-end** (exercises real `payTaxes` / `audit` / `kill` signing
and broadcast) — requires [Foundry](https://book.getfoundry.sh/):

```bash
# 1. Fork mainnet locally
anvil --fork-url <your-mainnet-rpc>

# 2. Point the bot at the fork; hardcode a token you'll test against
#    (impersonate/fund it with cast). No NFT API needed in local mode.
MODE=local RPC_HTTP_URL=http://127.0.0.1:8545 \
  OWNED_TOKENS=<tokenId> TARGET_TOKENS=<delinquentTokenId> \
  npm run dev

# 3. In the dashboard, click Start. Use `cast rpc evm_increaseTime`
#    to warp past an audit deadline and watch the kill path fire.
```

In `local` and `public` modes the submitter broadcasts the signed transaction directly
(Anvil has no Flashbots relay). In `mainnet` mode it submits private bundles to the
configured builders; tax payments, and explicitly opted-in offense races, also use an
identical public-mempool mirror so either copy can land but only one can execute.

---

## Disclaimer

This software is provided "as is", without warranty of any kind (see `LICENSE`).
It is an unofficial tool for interacting with a third-party game contract using
its public functions. It spends real ETH and offers **no guarantee** of keeping
any token alive or winning the game. Blockchain transactions are irreversible.
You are solely responsible for your keys, your funds, and your use of this tool.
Not financial advice.
