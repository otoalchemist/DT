# Death & Taxes Bot

A self-hosted automation bot for the on-chain game **[Death & Taxes](https://etherscan.io/address/0xa448c7f618087dDa1a3B128cAd8A424fBae4B71F)** by Transient Labs. It watches the game for you and acts automatically:

- **Defense (primary):** never let one of your Citizen tokens get killed. If a token is audited, the bot clears the audit — by spending a **bribe** (free) or **paying taxes** — before the 24-hour deadline. It can also pay proactively so your tokens are never even auditable, and prepay up to 7 epochs to lock the current (lower) tax rate.
- **Just-in-time epoch payment (one-shot):** arm the bot for a single upcoming epoch and it pays exactly one epoch for each of your citizens *the moment that epoch begins on-chain* — before they can be audited — then auto-disarms. E.g. arm for epoch 133 and it pays `133 × 0.00069 = 0.09177 ETH` per citizen the instant epoch 133 starts. The exact amount is read on-chain at pay time, so it's always correct even for multiple citizens.
- **Offense (optional):** audit delinquent rivals and `kill` expired-audit tokens to thin the field toward the winning 69. It audits **multiple rivals per epoch** — one per eligible citizen you hold (each token may audit once per epoch) — instead of just one. This is a game strategy, not a profit engine — see below.
- **Reliable inclusion:** choose your submission path — **`public`** (broadcast straight to the mempool; fastest, the default) or **`mainnet`** (private, front-run-resistant **Flashbots bundles**). Optional latency edges let offense compete in the *first eligible block* instead of the block after (see [Latency edges](#latency-edges)).
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
| Winning | The game ends when the Citizen supply drops to **69**; the survivors win. |

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
4. Leave **Dry-run ON** first to watch what the bot *would* do — toggle it from the **DRY-RUN / LIVE FIRE** badge in the top bar (going live asks for confirmation). Turn it off to go live.
5. Click **Start bot**.

Fund the wallet with a little ETH for taxes/audits/gas. Keep the dashboard's
**spend cap** and **min-balance floor** set to values you're comfortable with.

### Production run

```bash
npm run build
npm start          # backend only; serve packages/web/dist with any static host
```

---

## Configuration (`.env`)

| Var | Purpose |
| --- | --- |
| `ALCHEMY_API_KEY` | Derives the mainnet HTTPS/WSS RPC and NFT API endpoints. |
| `RPC_HTTP_URL` / `RPC_WS_URL` / `ALCHEMY_NFT_URL` | Explicit overrides (any RPC). |
| `MODE` | `public` (broadcast to the mempool — **default**, fastest), `mainnet` (Flashbots bundles, private/front-run-resistant), or `local` (anvil fork). Also switchable at runtime from the dashboard. |
| `PORT` / `HOST` | Local API bind (default `127.0.0.1:8787`). |
| `OWNED_TOKENS` / `TARGET_TOKENS` | Comma-separated tokenId overrides for local testing without the NFT API. |

Secrets live in `.env` and `data/` (the encrypted keystore + a Flashbots
reputation key). Both are git-ignored. **Never commit them.**

Strategy settings are edited from the dashboard and saved to `data/config.json`
(also git-ignored, since it holds your live strategy). With no such file the bot
starts from safe defaults — dry-run on, offense/defense off. To seed a starting
point, copy the template:

```bash
cp data/config.example.json data/config.json
```

---

## Safety model

- **You are the sole custodian.** The key never leaves your machine and is only
  decrypted in memory after you enter your passphrase. An existing keystore is
  never silently overwritten — re-creating a wallet requires an explicit confirm,
  so you can't accidentally discard the old key.
- **Guardrails:** min-balance floor, max base-fee, an optional **max single-payment
  cap** (skips any tax payment above a set ETH value — a backstop against a bad
  estimate or a badly-delinquent token draining the wallet in one shot; `0` = off),
  a global **pause/kill switch**, and a **dry-run** mode that simulates without sending.
  The min-balance floor is enforced **cumulatively** — several payments in one
  cycle can't sneak the wallet below it.
- **Separate offense gas (audit/kill):** by default one set of gas settings
  (max base-fee, priority tip, dynamic tip) applies to everything. Turn on
  **Separate gas for audit / kill** to bid gas independently for offense — it's a
  race against rivals, whereas tax payments aren't — without overpaying on
  routine payments. Off by default, so behavior is unchanged until you opt in.
  Payment gas is edited under **Just-in-time epoch payment → Payment gas**.
- **Simulate-before-send:** every transaction is checked first (`eth_call` in
  public/local mode, `eth_callBundle` for Flashbots bundles), so reverting
  transactions aren't paid for and nonces aren't burned on them.
- **Local-only by default.** The API binds to `127.0.0.1`; when bound to loopback
  it also rejects requests with an unexpected `Host` header, blocking DNS-rebinding
  from a malicious web page. Do not expose it to the internet.

---

## Latency edges

Rivals often win by landing in an *earlier block*, not by paying more. These
optional, off-by-default edges close that gap (configure them in the dashboard):

- **Pre-schedule offense at deadlines** — fires an extra tick just before each
  offense deadline (the nearest audit expiry, or the next epoch boundary) so kills
  and audits compete in the **first eligible block** instead of the block after. A
  boundary tick is never dropped just because a routine tick is mid-flight — it
  retries as soon as the engine is free, so the race isn't lost to bad luck.
- **Race the public mempool** (`mainnet` mode only) — also broadcasts a
  time-critical offense tx to the public mempool alongside the Flashbots bundle, so
  *any* builder can include it next block. The tx is identical (same nonce), so only
  one can ever land. Trades bundle privacy for lower inclusion latency.
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

# 3. In the dashboard, turn Dry-run OFF and Start. Use `cast rpc evm_increaseTime`
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
