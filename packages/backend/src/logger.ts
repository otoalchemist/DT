// Tiny leveled logger. Avoids a dependency; timestamps + level prefix.
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = (process.env.LOG_LEVEL as Level) ?? "info";

/** Remove credentials embedded in provider URLs before anything reaches durable logs. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(https?|wss?):\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}/[redacted]`;
      } catch {
        return "[redacted-url]";
      }
    })
    .replace(/\b(api[_ -]?key|private key|passphrase|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (value instanceof Error) {
    const safe = new Error(redactSensitiveText(value.message));
    safe.name = value.name;
    return safe;
  }
  return value;
}

function log(level: Level, ...args: unknown[]): void {
  if (order[level] < order[threshold]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase()}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : console.log)(line, ...args.map(sanitize));
}

export const logger = {
  debug: (...a: unknown[]) => log("debug", ...a),
  info: (...a: unknown[]) => log("info", ...a),
  warn: (...a: unknown[]) => log("warn", ...a),
  error: (...a: unknown[]) => log("error", ...a),
};
