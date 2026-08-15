# Death & Taxes Bot

A self-hosted **defensive** automation bot for the on-chain game **[Death & Taxes](https://etherscan.io/address/0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F)** by Transient Labs. It pays taxes on **your** Citizens so they stay current — it does not audit or kill anyone else's tokens.

- **Just-in-time epoch payment (one-shot):** arm the bot for a single upcoming epoch and it pays exactly one epoch for each selected owned Citizen *the moment that epoch begins on-chain* — before they can be audited — then auto-disarms. E.g. arm for epoch 133 and it pays `133 × 0.00069 = 0.09177 ETH` per citizen the instant epoch 133 starts. The exact amount is read on-chain at pay time. Each JIT payment is exactly one epoch (one day) and never balloons into a multi-day charge — see the **per-payment epoch cap** below.
- **Defense (pre-audit by default):** keeping citizens current *before* they can be audited (proactive pay, prepay up to 7 epochs to lock the current rate, and the JIT boundary payment). Those skip any citizen already under audit. Any citizen you **uncheck** in the JIT panel is excluded from *every* automatic payment. Recovering an audited citizen is your call via **Pay to current** / **Clear audit (bribe)** on the token row, unless you opt into **Benji (Defense) Mode** (`autoDefendAudit`) to auto-pay *your* audited citizen.
- **Reliable inclusion:** choose your submission path — **`mainnet`** (the default: private **bundles** fanned out to several block builders; bundles sit in the block's top region *regardless of tip*, which is what wins a boundary race — and payments still mirror to the public mempool so they can't fail to land) or **`public`** (mempool only, seated after every bundle). Optional latency edges let payments compete in the *first eligible block* instead of the block after (see [Latency edges](#latency-edges)).
- **Live activity log:** every action is timestamped with its status; submitted transactions link to Etherscan and auto-update from **submitted → included / reverted** once the receipt lands.

You run it on your own machine with your own key. It ships with a local web dashboard.

> ⚠️ **This is not a money-printer.** In Death & Taxes, `audit` and `kill` pay the
> caller **nothing**. This bot does not call them. Its value is *keeping your tokens
> alive*. It spends ETH (taxes, gas, optional coinbase bids); it does not earn any.

---

## How the game works (what the bot automates)

| Concept | Detail |
| --- | --- |
| Epoch | 24 hours. Tax rate for an epoch = `epoch × 0.00069 ETH`, so daily cost **rises over time**. |
| Delinquent | A token that is ≥ 2 epochs behind on taxes. Delinquent tokens can be audited by anyone. |
| Audit | Costs `0.00069 ETH`. Starts a **24h countdown** on a delinquent target. |
| Kill | Free, callable by **anyone** once a token's audit countdown expires. Turns the Citizen into a dead "Evader". |
| Clear an audit | The target `payTaxes` (pays back-taxes) or `useBribe` (free, if it holds a bribe) before expiry. |
| Life insurance | **Cosmetic only** — it changes the dead-Evader artwork. It does **not** prevent death. |
| Winning | The game ends when the Citizen supply drops to **69**; the survivors win. |

The bot only acts on **Citizens your unlocked wallets own**: pay taxes, spend a bribe, and (if you opt in) auto-clear an audit on your own token. It does not scan, audit, or kill rivals.

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
   tokens you want defended** — the bot only pays taxes for Citizens owned by the
   wallet it unlocks. A freshly generated burner owns none until you transfer
   Citizens into it, so to protect Citizens you already hold, import that wallet's
   key.
2. **Unlock** it with your passphrase.
3. Configure **JIT**, spend caps, and (optionally) Benji mode.
4. Click **Start bot**. The bot is live-fire: once unlocked, started, and `enabled`, it submits real transactions.

Fund the wallet with a little ETH for taxes and gas. Keep the dashboard's
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
`data/flashbots-signer.key`, and `data/*.keystore.json`). Keep a secure backup of the
local files: they contain the encrypted keystore, runtime configuration, and other
state. Using a fresh directory also avoids retaining code files removed by a later
release.

#### `DEFAULTS_VERSION` — pushing new defaults to existing users

`DEFAULTS_VERSION` (in `packages/backend/src/runtime.ts`) is **separate from
`VERSION`** and is what applies updated recommended *settings* after an operator
manually installs a new release.

Users keep their `data/` folder across updates (it holds the wallet keystore and
API key), so their `data/config.json` survives — and saved values win per-field,
meaning a changed default would otherwise *never* reach them. On load, a config
stamped with an older `DEFAULTS_VERSION` has its recommended fields re-applied
(gas tuning and behaviour flags), while their own choices are preserved: run mode,
coinbase bid + payer, spend guardrails, and JIT selection. Offense keys from older
configs (`offenseEnabled`, rival pin lists, combined pay+audit bundle, etc.) are
dropped. The change is reported to the log and the activity feed. It's deliberately
*not* tied to `VERSION` so a routine release doesn't reset anyone's tuning.

#### Release checklist

1. Bump **`VERSION`** in `packages/shared/src/constants.ts` **and** the `version`
   field in the root + all three `packages/*/package.json` (`npm run package`
   refuses to run if they disagree), then `npm install --package-lock-only`.
2. **Bump `DEFAULTS_VERSION`** in `packages/backend/src/runtime.ts` **if — and only
   if — you changed a recommended default** (gas tuning or a behaviour flag).
   Skipping this means existing users silently stay on the old settings; bumping it
   needlessly resets their tuning.
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
| `OWNED_TOKENS` | Comma-separated tokenId override for local testing without the NFT API. |

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

Every automatic action the bot takes fires **at an epoch boundary** (proactive pay,
JIT). But a running engine reacts to *every block*, which costs roughly **22
provider requests per minute** around the clock — for work that happens once a day.

**Away mode keeps the engine stopped and wakes it just before each boundary**, then
stops it again once the boundary work has settled (5 minutes of grace). Toggle it in
the dashboard's top bar; it applies instantly, like **Start bot**.

Idling costs **zero requests**. Boundaries are `startTime + N × EPOCH_DURATION`, so the
next one is arithmetic on the wall clock — there is nothing to poll. The dashboard also
stops its own 20s poll while away mode is on, so an open tab costs nothing either.

`awayLeadMinutes` (default **15**) sets how early to wake. The engine needs to be up
before the pre-boundary race arms, so leave headroom rather than trimming this to
seconds.

It only wakes when there is something to wake **for** — proactive pay on, or a JIT
arm. With everything off, no wake is scheduled and the dashboard says so rather than
counting down to a no-op.

**The trade-off:** while the engine is stopped the bot is not watching. Nothing reacts
to a mid-epoch event — an audit landing on your citizen — until the next wake. Away
mode suits defending your own citizens on a schedule; leave it off if you want the
bot watching continuously (and enable Benji mode if you want it to auto-clear an
audit without waiting for a boundary).

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
optional, off-by-default edges close that gap for **your payments** (configure them
in the dashboard):

- **Dynamic priority tip** — scales the tip up as the latest block fills past 50%,
  up to a configurable ceiling, to stay competitive in contested blocks. When off,
  the static priority fee is always used. Set under *Just-in-time epoch payment →
  Payment gas* — useful when a boundary-timed payment has to out-order a rival's
  batch-audit in the first block of an epoch.
- **Race into the boundary block** (advanced, `payTaxes` only) — the ordinary JIT
  pay fires *just after* the boundary, so it lands one block late. This mode instead
  *pre-submits* the armed JIT payment shortly **before** the boundary with a value
  computed off-chain for the upcoming epoch, so it can land in the **first block of
  the epoch** ahead of a batch-auditor. The value is validated by **simulating at
  the boundary timestamp** (`eth_call` block overrides, or `eth_callBundle`'s
  `timestamp` on mainnet), so a wrong value is caught before spending gas; the
  normal post-boundary JIT pay still runs as a fallback. On by default; still
  editable in `data/config.json`.
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
- **Atomic multi-tx bundles (`mainnet` mode, automatic)** — paying several Citizens
  in one cycle produces multiple txs on a single nonce sequence. Sent as independent
  one-tx bundles, only the first (nonce == chain nonce) is a self-valid bundle; the
  rest carry a nonce gap and won't be placed top-of-block by builders. The bot instead
  collects a cycle's txs and submits them as **one atomic bundle** (txs in nonce
  order), so **all** of them win top-of-block together — what you need when a
  batch-auditor hits several of your citizens at once. Each tx still mirrors to the
  public mempool individually as a fallback. No configuration; always on in
  `mainnet` mode.

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

**Mainnet-fork end-to-end** (exercises real `payTaxes` signing and broadcast) —
requires [Foundry](https://book.getfoundry.sh/):

```bash
# 1. Fork mainnet locally
anvil --fork-url <your-mainnet-rpc>

# 2. Point the bot at the fork; hardcode a token you'll test against
#    (impersonate/fund it with cast). No NFT API needed in local mode.
MODE=local RPC_HTTP_URL=http://127.0.0.1:8545 \
  OWNED_TOKENS=<tokenId> \
  npm run dev

# 3. In the dashboard, click Start. Use `cast rpc evm_increaseTime`
#    to warp the clock and watch the JIT / proactive-pay path fire.
```

In `local` and `public` modes the submitter broadcasts the signed transaction directly
(Anvil has no Flashbots relay). In `mainnet` mode it submits private bundles to the
configured builders; tax payments also use an identical public-mempool mirror so
either copy can land but only one can execute.

---

## Disclaimer

This software is provided "as is", without warranty of any kind (see `LICENSE`).
It is an unofficial tool for interacting with a third-party game contract using
its public functions. It spends real ETH and offers **no guarantee** of keeping
any token alive or winning the game. Blockchain transactions are irreversible.
You are solely responsible for your keys, your funds, and your use of this tool.
Not financial advice.
