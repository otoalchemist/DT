// Tiny leveled logger. Avoids a dependency; timestamps + level prefix.
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = (process.env.LOG_LEVEL as Level) ?? "info";

function log(level: Level, ...args: unknown[]): void {
  if (order[level] < order[threshold]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${level.toUpperCase()}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : console.log)(line, ...args);
}

export const logger = {
  debug: (...a: unknown[]) => log("debug", ...a),
  info: (...a: unknown[]) => log("info", ...a),
  warn: (...a: unknown[]) => log("warn", ...a),
  error: (...a: unknown[]) => log("error", ...a),
};
