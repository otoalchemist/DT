import type { ActivityEntry } from "@dat-bot/shared";

const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const SERIALIZED_TRANSACTION = /0x[0-9a-f]{130,}/gi;
const ACTIVITY_KINDS = new Set([
  "pay-taxes", "use-bribe", "audit", "kill", "builder-incentive", "info", "error",
]);
const ACTIVITY_STATUSES = new Set([
  "planned", "prepared", "simulated", "submitted", "delivery-uncertain",
  "rejected", "included", "reverted", "skipped", "dry-run", "info",
]);
const OPTIONAL_ACTIVITY_STRING_FIELDS = [
  "tokenId", "targetTokenId", "txHash", "bundleHash", "targetBlock", "valueWei", "gasWei",
] as const;

/** Remove credentials and request material from text that may be persisted or
 * shared in support logs. Provider errors commonly include the complete RPC URL
 * (whose path carries an API key) and sometimes the serialized transaction. */
export function redactSensitiveText(value: string): string {
  let redacted = value.replace(URL_IN_TEXT, (candidate) => {
    // Values can cross more than one safety boundary (for example, route
    // handling followed by Fastify's onSend hook). Keep the public placeholder
    // stable when URL parsing rejects its deliberately bracketed hostname.
    if (candidate.includes("[REDACTED_RPC_ENDPOINT]")) return candidate;
    try {
      const parsed = new URL(candidate);
      // Redact the authority as well as the path. Although most hosted RPC
      // providers place credentials in the path, private gateways can encode a
      // tenant or token in userinfo or a generated subdomain.
      return `${parsed.protocol}//[REDACTED_RPC_ENDPOINT]`;
    } catch {
      return "[REDACTED_URL]";
    }
  });

  const configuredKeys = [process.env.ALCHEMY_API_KEY]
    .filter((key): key is string => typeof key === "string" && key.length >= 8);
  for (const key of configuredKeys) redacted = redacted.split(key).join("[REDACTED]");

  return redacted.replace(SERIALIZED_TRANSACTION, "[REDACTED_SERIALIZED_TRANSACTION]");
}

function redactLogValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value instanceof Error) {
    const safe = new Error(redactSensitiveText(value.message));
    safe.name = value.name;
    if (value.stack) safe.stack = redactSensitiveText(value.stack);
    return safe;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactLogValue(entry, seen)]),
  );
}

export function redactLogArgument(value: unknown): unknown {
  return redactLogValue(value, new WeakSet());
}

/** Parse legacy activity as a strict public DTO. Never spread untrusted fields:
 * older/corrupt files can otherwise smuggle provider diagnostics into HTTP/WS. */
export function sanitizeActivityEntry(value: unknown): ActivityEntry | null {
  const record = value as Record<string, unknown> | null;
  if (
    !record
    || typeof record !== "object"
    || typeof record.id !== "string"
    || typeof record.ts !== "number"
    || !Number.isFinite(record.ts)
    || typeof record.kind !== "string"
    || !ACTIVITY_KINDS.has(record.kind)
    || typeof record.status !== "string"
    || !ACTIVITY_STATUSES.has(record.status)
    || typeof record.message !== "string"
  ) return null;
  const optional = Object.fromEntries(OPTIONAL_ACTIVITY_STRING_FIELDS.flatMap((field) =>
    typeof record[field] === "string"
      ? [[field, redactSensitiveText(record[field])]]
      : []));
  return {
    id: record.id,
    ts: record.ts,
    kind: record.kind,
    status: record.status,
    ...optional,
    message: redactSensitiveText(record.message),
  } as ActivityEntry;
}
