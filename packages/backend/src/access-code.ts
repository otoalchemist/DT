import crypto from "node:crypto";
import { safeEqual } from "./keystore.js";

/**
 * Team access code — a shared secret every user must enter to unlock the bot.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is a gate on who bothers to run the bot, not a security control. The repository is
 * public and the check runs on the user's own machine, so anyone can read this file, delete
 * the call site and rebuild. Treat it as a "members only" sign, not a lock: it keeps a
 * casual finder out and it does not keep a determined one out.
 *
 * Stored as a SHA-256 hash rather than the literal string for one concrete reason: the
 * plaintext would otherwise be published to a public repository the moment it was pushed,
 * which defeats the entire purpose of having a code. The hash means the code lives only with
 * the people who were told it. That is obfuscation, not encryption — the input is short and
 * guessable by brute force to anyone who cares — but it is strictly better than shipping the
 * string, and it costs nothing.
 *
 * To rotate it:
 *   node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' NEWCODE
 * and replace the constant below. Existing users then need the new code at their next unlock.
 *
 * Override with BOT_ACCESS_CODE_SHA256 for a private build with a different code, or set
 * BOT_ACCESS_CODE_OFF=1 to disable the gate entirely (useful for local development and for
 * anyone running their own fork who does not want it).
 */
/** The shipped hash, or a private build's override. Read per call rather than captured at
 *  module load: an env change then takes effect without a restart, and it keeps the module
 *  testable without dynamic re-imports. */
function expectedHash(): string {
  return (
    process.env.BOT_ACCESS_CODE_SHA256 ??
    "197ee97bf6a38d91abc1b4f7773b21f7f42fbcd2aebfcd75599183028d3ee453"
  );
}

/** True when the gate is switched off, so a fork or a dev machine is not held up by it. */
export function accessCodeRequired(): boolean {
  return process.env.BOT_ACCESS_CODE_OFF !== "1";
}

/**
 * Does `input` match the shipped access code?
 *
 * Trimmed because the code gets copied out of chat messages, which drags in whitespace, and a
 * silent mismatch on an invisible character is the kind of support question that costs an hour.
 * Compared through the keystore's constant-time helper for consistency; timing is not a real
 * threat for a code that ships in the binary, but there is no reason to be sloppy about it.
 */
export function accessCodeMatches(input: string): boolean {
  if (!accessCodeRequired()) return true;
  const hash = crypto.createHash("sha256").update(input.trim(), "utf8").digest("hex");
  return safeEqual(hash, expectedHash());
}
