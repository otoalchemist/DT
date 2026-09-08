import { loadAllyTokens } from "./runtime.js";
import { resolveCitizensAddress, filterLiveTokenIds } from "./contract.js";

/**
 * Ally-roster gate — the unlocked wallet must hold at least one Citizen on the shared ally
 * list (data/ally-tokens.json) before the bot will open.
 *
 * WHAT THIS IS AND IS NOT
 *
 * Like the team access code it sits beside, this is a "members only" sign rather than a lock:
 * the repository is public and the check runs on the user's own machine, so anyone can delete
 * the call site and rebuild. See access-code.ts for the same caveat at length.
 *
 * What it adds over the code is that it cannot be *forwarded*. A code leaks the moment one
 * person pastes it into the wrong chat, and nothing about the leak is visible. Roster
 * membership cannot be pasted — it is a fact about the chain, it is checked live at every
 * unlock, and it is revoked simply by taking an id off the list on master. The two gates fail
 * differently on purpose, so a leak of either one alone still leaves a stranger outside.
 *
 * WHY IT READS THE CHAIN RATHER THAN THE NFT INDEX
 *
 * Ownership comes from `ownerOf` through the ordinary RPC, in one multicall, not from the
 * Alchemy NFT index that fetchOwnedTokenIds uses. Three reasons, in order of weight: the index
 * lags the chain by minutes, and a citizen bought or transferred just before a boundary would
 * read as unowned at exactly the moment it matters most; the index needs ALCHEMY_NFT_URL,
 * which a local or forked setup may not have, and a missing key must not read as "not on the
 * team"; and the roster is 51 ids, so a direct read costs one batched request.
 *
 * FAIL-OPEN IS DELIBERATE
 *
 * Every path that cannot reach a definitive answer — RPC down, roster missing, roster present
 * but unreadable on-chain — returns `indeterminate`, which ALLOWS the unlock and logs why.
 * The asymmetry is not close. A wrong deny locks an operator out of their own money-handling
 * bot, and a bot that cannot unlock cannot pay taxes, so an Alchemy outage during a boundary
 * would cost real citizens. A wrong allow costs nothing that the code gate does not already
 * cost, against a control that is advisory to begin with. Only a clean, positive reading of
 * the roster that finds no match denies.
 *
 * Set BOT_ALLY_GATE_OFF=1 to disable it entirely — for local development, for a fork, and as
 * the escape hatch if the roster is ever wrong about a real member.
 */

/** True unless a fork or a dev machine has switched the gate off. */
export function allyGateRequired(): boolean {
  return process.env.BOT_ALLY_GATE_OFF !== "1";
}

export type AllyGateVerdict =
  /** Gate disabled by env. */
  | { ok: true; reason: "off" }
  /** A rostered citizen is held by one of the unlocked wallets. */
  | { ok: true; reason: "held"; tokenId: string; address: string }
  /** No definitive answer was available; the unlock is allowed and `detail` says why. */
  | { ok: true; reason: "indeterminate"; detail: string }
  /** The roster read cleanly and none of `checked` live citizens is held here. */
  | { ok: false; reason: "not-held"; checked: number };

function indeterminate(detail: string): AllyGateVerdict {
  return { ok: true, reason: "indeterminate", detail };
}

/**
 * Does any of `addresses` hold a rostered Citizen?
 *
 * Total by construction: it never throws, because the only caller is the unlock route, whose
 * surrounding catch reports "Incorrect passphrase". An exception escaping this function would
 * therefore send a user hunting for a typo in a passphrase that was correct.
 */
export async function checkAllyHolding(
  addresses: readonly string[],
): Promise<AllyGateVerdict> {
  if (!allyGateRequired()) return { ok: true, reason: "off" };
  try {
    // Read at call time, not module load: main() syncs the roster from master before the
    // server accepts connections, so a member added today is on the list by first unlock.
    const roster = loadAllyTokens();
    if (roster.length === 0) {
      return indeterminate("the ally roster is empty");
    }
    const ids: bigint[] = [];
    for (const raw of roster) {
      // One malformed entry must not deny the whole team; skip it and judge on the rest.
      //
      // Matched against a decimal literal rather than handed straight to BigInt, because
      // BigInt("") is 0n and does NOT throw: a stray blank line in the roster would otherwise
      // become a live lookup of citizen #0, and whoever holds that token would pass the gate
      // for everyone. BigInt also accepts "0x..." and "  12  ", neither of which is a token id
      // as this roster writes them.
      const id = String(raw).trim();
      if (!/^[0-9]+$/.test(id)) continue;
      ids.push(BigInt(id));
    }
    if (ids.length === 0) return indeterminate("the ally roster holds no usable token ids");

    const citizens = await resolveCitizensAddress();
    // Burned ids drop out here rather than counting as evidence either way.
    const live = await filterLiveTokenIds(citizens, ids);
    if (live.length === 0) {
      return indeterminate(`none of the ${ids.length} rostered citizens could be read on-chain`);
    }

    const mine = new Set(addresses.map((a) => a.toLowerCase()));
    for (const { id, owner } of live) {
      if (mine.has(owner.toLowerCase())) {
        return { ok: true, reason: "held", tokenId: id.toString(), address: owner };
      }
    }
    return { ok: false, reason: "not-held", checked: live.length };
  } catch (err) {
    return indeterminate((err as Error).message);
  }
}
