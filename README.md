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
cp .env.example .env        # then edit .env and set ALCHEMY_API_KEY
npm run dev                 # starts backend (:8787) + dashboard (:5173)
```

**One-click launch:** double-click **`start.bat`** on Windows or **`start.command`**
on macOS. Either one installs dependencies on first run, starts the dev server, and
opens the dashboard.

**macOS: "`start.command` Not Opened — Apple could not verify…"**

This is Gatekeeper, and it is about where the file came from rather than what is in
it: a browser stamps `com.apple.quarantine` on the ZIP, and everything extracted
from it inherits the flag. On macOS 15 (Sequoia) the old right-click → **Open**
bypass no longer clears it. Pick whichever suits you:

```bash
# 1. Just run it from Terminal — nothing to bypass. Gatekeeper gates double-click
#    launching a quarantined file, not `bash` reading one.
cd ~/Downloads/DT-master && bash start.command

# 2. Or strip the flag once for the whole folder, and double-click works after.
xattr -cr ~/Downloads/DT-master
chmod +x ~/Downloads/DT-master/start.command
```

Or: **System Settings → Privacy & Security**, scroll to Security, and click
**Open Anyway** on the line naming `start.command` (it only appears after the
launch has been blocked once), then open it again.

**Cloning avoids this entirely** — git-created files are never quarantined, so
there is no dialog to clear:

```bash
git clone https://github.com/otoalchemist/DT.git
cd DT && bash start.command
```

Notarizing the launcher would not help: a bare `.command` cannot be notarized on
its own, so it would mean shipping a signed app bundle and an Apple Developer
account to wrap a script that runs `npm`.

**Endless `ECONNREFUSED 127.0.0.1:8787` / every action returns HTTP 500**

The dashboard is up but the backend is not, so Vite's proxy fails every `/api` call —
including saving your Alchemy key, which makes it look like the key was rejected. It
was not: nothing reached the backend.

The real error is in the SAME terminal, scrolled up above the repeated `[web]` lines,
prefixed `[backend]`. To see it on its own:

```bash
npm run dev:backend
```

The usual causes, in order:

- **Node older than 20.** `node -v` — Vite runs on 18, the backend does not. The
  launcher now refuses to start on anything older instead of half-working.
- **A `node_modules` copied from another machine.** esbuild and other packages ship
  platform-specific binaries, so a folder moved from Windows (or restored from a
  backup) breaks `tsx`. Copy `data/` across between machines, never `node_modules`.
  Fix: `rm -rf node_modules package-lock.json && npm install`
- **A half-finished `npm install`** (dropped network). Same fix as above.
- **Port 8787 already in use** by an earlier run: `lsof -ti tcp:8787 | xargs kill -9`.

**Team access code.** Released builds ask for a shared code at unlock, alongside your wallet
passphrase. It is a separate field and a separate thing: it does **not** unlock your key, it
only gates this build. Ask whoever gave you the bot for the code.

> This is a members-only sign, not a lock. The repository is public and the check runs on your
> own machine, so anyone determined can remove it and rebuild — do not mistake it for security.
> The shipped constant is a SHA-256 hash rather than the code itself, so the code is not
> published along with the source.

Running your own fork and don't want the gate: set `BOT_ACCESS_CODE_OFF=1`. Building for a
different group: set `BOT_ACCESS_CODE_SHA256` to the hash of your own code —

```bash
node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' YOURCODE
```

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
npm start          # backend only; serve packages/web/dist with any static host
```

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

#### Self-update — the bot updates its own code at launch

The launchers (`start.bat` / `start.command`) check `master` for a newer version
**before the app boots** and install it if there is one. Downloading a new ZIP and
hand-copying your `data/` folder across is no longer part of running the bot.

It runs *before* startup on purpose: a Node process can't safely replace the code it
is currently executing, so the app only ever starts on one coherent tree.

**What it never touches:** `data/` (your encrypted keystore, API key, `config.json`,
activity log) and `.env`. Those are yours; an update replaces only the shipped code.

Also, it:

- **Skips a git checkout entirely** — there `git pull` is the update path and
  overwriting the working tree would destroy uncommitted work. `BOT_AUTO_UPDATE=force`
  opts in if you're testing the updater itself.
- **Refuses a tree that isn't this project.** A truncated download or an HTML error
  page is rejected rather than written over a working install: the archive must
  contain the expected files and identify as `death-and-taxes-bot`.
- **Never installs an older version.** Only a strictly newer one is applied, so a
  local build ahead of `master` is left alone.
- **Backs up every file it replaces** to `.update-backup/`, so a bad update is
  recoverable by hand.
- **Reinstalls dependencies only when the lockfile actually changed**, so an ordinary
  code update stays a couple of seconds rather than minutes.
- **Never blocks startup.** Offline, GitHub down, a 20s timeout — it says so and
  starts the version you already have.
- **Won't rewrite the launcher underneath itself.** `cmd.exe` and `bash` both read a
  script incrementally as they run it, so overwriting `start.bat`/`start.command`
  mid-launch makes the shell resume at a stale byte offset and skip the rest silently
  (Windows also refuses the atomic rename that would avoid this). A launcher change is
  therefore *staged* and applied by the next `npm run update`, which the log tells you
  to run. Launcher edits are rare — they're a few lines of glue around these scripts.

Works the same on Windows and macOS: the archive keeps CRLF for `start.bat` and LF plus
the executable bit for `start.command`, both verified after a real update.

Check or run it by hand:

```bash
npm run update:check   # report only; exit code 10 means an update is available
npm run update         # apply it
```

Set `BOT_AUTO_UPDATE=off` in `.env` to disable it.

> One bootstrap caveat: a build from **before** this feature existed has no updater to
> run, so it can't self-update. Those installs need one final manual download — after
> which every future update is automatic.

#### Auto-updating default lists — no re-download needed

The four curated list files are the bot's shared game intelligence, and they change
as the game is played — far more often than the code does:

| File | What it is |
| --- | --- |
| `data/rival-targets.json` | The curated rival roster (the "reset to default" list). |
| `data/rival-skippers.json` | Rivals that pay on a ~2-epoch cadence, so they're auditable at every boundary. Seeds the offense targets. |
| `data/ally-tokens.json` | Teammates. **Never** audited or killed. |
| `data/big-boys.json` | The heavyweight operators, grouped by who runs them. **Full targets** — the tag is attribution, and they get their own dashboard section so they aren't listed twice. |

**At every startup the bot fetches these from `master` and refreshes its local
copies**, so a roster change reaches everyone on their next restart — no new
download, no hand-merging into a `data/` folder. Pressing **Refresh data** in the
dashboard does the same thing without a restart. It's best-effort and time-boxed
(8s): if the fetch fails you keep the copy you have, and the bot starts normally.

Three things it will not do, because each would destroy something:

- **It never touches a git checkout.** In a clone the lists are managed by git, so
  the sync is skipped entirely (`LIST_AUTO_UPDATE=force` opts in for testing it).
- **It never overwrites a list you edited.** The hash of each file it writes is
  recorded in `data/.list-sync.json`; if the file no longer matches, it's yours and
  the sync leaves it alone and says so. To go back to the shared copy, delete the
  file and restart.
- **It never adopts an empty list.** An empty `ally-tokens.json` would let the
  offense engine audit teammates, so a payload that arrives empty or malformed is
  treated as a failed fetch, not as an instruction.

Your **offense targets** follow the refreshed skippers list only if they were still
tracking the default. Once you've customised the target box it's yours; re-adopt any
time with the one-click *skippers* template in the Config panel.

Set `LIST_AUTO_UPDATE=off` in `.env` to disable the whole thing.

#### `DEFAULTS_VERSION` — pushing new defaults to existing users

`DEFAULTS_VERSION` (in `packages/backend/src/runtime.ts`) is **separate from
`VERSION`** and is what makes updated recommended *settings* reach people who
already run the bot. (The list files above no longer need it — they update
themselves.)

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
   needlessly resets their tuning. **Editing a list file no longer needs a bump or
   even a release** — commit it to `master` and every bot picks it up on its next
   start (see *Auto-updating default lists* above).
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
| `MODE` | `mainnet` (**default** — private bundles to `BUILDER_URLS`; payments also mirror to the mempool so they still land), `public` (mempool only), or `local` (anvil fork). Also switchable at runtime from the dashboard. |
| `BUILDER_URLS` | Comma-separated builders that receive your bundle in `mainnet` mode. Only the builder that **wins the slot** can include it, so the bot submits to **all** in parallel and succeeds if any accepts. Defaults to Flashbots, **BuilderNet**, beaverbuild and Titan (all verified live). Endpoints do change — verify against each builder's docs. |
| `PORT` / `HOST` | Local API bind (default `127.0.0.1:8787`). |
| `OWNED_TOKENS` / `TARGET_TOKENS` | Comma-separated tokenId overrides for local testing without the NFT API. |
| `LIST_AUTO_UPDATE` | `on` (**default**) refreshes the curated default lists from `master` at startup; `off` disables it; `force` syncs even in a git checkout. See [Auto-updating default lists](#auto-updating-default-lists--no-re-download-needed). |

Secrets live in `.env` and `data/` (the encrypted keystore + a Flashbots
reputation key). Both are git-ignored. **Never commit them.**

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
- **Simulate-before-send:** every transaction is checked first (`eth_call` in
  public/local mode, `eth_callBundle` for bundles), so reverting transactions aren't
  paid for and nonces aren't burned on them.
- **Payments always land, even in `mainnet` mode.** A bundle is only included if a
  builder you sent it to wins the slot, so a bundle-only payment can silently fail
  to land — which can cost a citizen. Tax payments are therefore **always** mirrored
  to the public mempool alongside the bundle (identical tx, so only one can land).
  There's nothing to protect by hiding a tax payment: rivals already see the
  delinquency on-chain.
- **One bad payment can't drop the others.** When a boundary bundle carries **two or
  more** payments, each is marked allowed-to-revert (`revertingTxHashes`). Without
  that, a single citizen reverting in-block — `AlreadyCurrent`, or audited earlier in
  the same block — invalidates the whole bundle, and every healthy payment falls to
  the mempool and *misses the boundary block*. That block is where the audits happen:
  measured across 12 boundaries, ~10 rival audits land per boundary block (~4.7 at
  index ≤ 20), against citizens that are exactly 2 epochs behind and therefore
  auditable. Roughly 28% of holders run 2+ citizens, so this is the common case, not a
  corner. Revert-tolerance is **not** applied to a lone payment: there are no siblings
  to protect, and it would only land a bundle containing a reverted tx — paying the
  coinbase bid on a boundary that otherwise costs nothing, since a dropped bundle takes
  the bundle-only bid with it. Payments keep their mempool mirror either way, which is
  what makes this safe rather than a trade for a worse failure.
- **Local-only by default.** The API binds to `127.0.0.1`; when bound to loopback
  it also rejects requests with an unexpected `Host` header, blocking DNS-rebinding
  from a malicious web page. Do not expose it to the internet.

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
  payer can't drop your payment. Just set `coinbaseBidEth` (0 = off) under
  *Just-in-time epoch payment → Coinbase bid*. A shared `coinbasePayerAddress` ships
  as the default (`0xb69D1Bb4613722bdAb1aA77BA8F4409071f0a815` — a deployed
  **`contracts/CoinbasePayer.sol`**, verified on-chain to forward 100% of what it
  receives to `block.coinbase`), so you only need the bid amount. Prefer your own?
  Deploy `CoinbasePayer.sol` once (e.g. in Remix) and paste that address instead.
  **Off by default.**
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

## Race timing telemetry — is position bought, or just timed?

Everything else about boundary position is measurable from public chain data: tips, bids,
gas, and the tx index you ended up at. **Submission timing is not** — only the sending bot
knows when it pressed send. That gap matters, because measurement across 21 boundary blocks
on Titan/BuilderNet found price explains position poorly:

| finding | figure |
| --- | --- |
| density (`(tip+bid)/gas`) → tx index correlation | **−0.22** (weak) |
| high tip alone vs. coinbase bid alone | median idx **11 vs 12** — Mann-Whitney `p=0.52`, no difference |
| doing *neither* | median idx **26** |
| bidding above ~0.02 ETH | **no measurable improvement** |

So the step from *nothing* → *something* is worth roughly 15 positions, and spending more
beyond that buys little. Which leaves arrival time as the main untested candidate.

**Every bundle flush now appends a row to `data/race-timing.jsonl`** recording how early it
was sent (`leadMs`, the gap to the epoch boundary), the bundle shape, which builders
accepted it, and — filled in once the receipt lands — the block and **tx index** it reached.
Analyse it with:

```bash
npm run race-timing
```

which reports the `leadMs` → index correlation, position by lead-time band, the same
correlation for tip and bid as controls, a per-builder split (ordering policy differs), and
**whether the builder that won the slot even had your bundle** — a high "did NOT" count
means the loss is *coverage*, not price or timing.

The file is gitignored (it's local data about your own submissions) and writes are async and
best-effort: telemetry must never delay a race or break a submission. Rows appear only in
`mainnet` mode, and only pre-boundary fires carry a `leadMs` — an ordinary tick has no
boundary to measure against. Expect one row per boundary, so give it several days before
reading much into the numbers; the script says so when the sample is under 10.

---

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

In `local` and `public` modes the submitter broadcasts the signed tx directly
(anvil has no Flashbots relay); on `mainnet` it submits via the relay.

---

## Disclaimer

This software is provided "as is", without warranty of any kind (see `LICENSE`).
It is an unofficial tool for interacting with a third-party game contract using
its public functions. It spends real ETH and offers **no guarantee** of keeping
any token alive or winning the game. Blockchain transactions are irreversible.
You are solely responsible for your keys, your funds, and your use of this tool.
Not financial advice.
