import { timingSafeEqual } from "node:crypto";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** Normalize a hostname supplied either directly or inside a Host header. */
export function hostnameOf(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    return closing > 0 ? host.slice(1, closing) : "";
  }
  if ((host.match(/:/g) ?? []).length > 1) return host.replace(/\.$/, "");
  const colon = host.lastIndexOf(":");
  return (colon >= 0 ? host.slice(0, colon) : host).replace(/\.$/, "");
}

/** Deliberately narrow: the API has no TLS or remote-user authentication. */
export function isLoopbackHostname(value: string): boolean {
  return LOOPBACK_NAMES.has(hostnameOf(value));
}

/**
 * Accept dashboard origins only when the page itself was served from loopback.
 * The port is intentionally unrestricted so a built dashboard can be served by a
 * different local static server; an unrelated Internet origin remains excluded.
 */
export function isAllowedDashboardOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      isLoopbackHostname(parsed.hostname) &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function isMutationMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function isSafeFetchSite(value: string | undefined): boolean {
  return value === undefined || value === "same-origin" || value === "same-site" || value === "none";
}

/** Timing-safe token comparison without throwing when lengths differ. */
export function sessionTokenMatches(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AttemptDecision {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Serializes expensive password KDF work and applies an escalating global cooldown.
 * A loopback API has only one meaningful client address, so a per-IP limiter would let
 * every browser and CLI caller interfere in exactly the same way while adding no safety.
 */
export class PasswordAttemptLimiter {
  private busy = false;
  private failures = 0;
  private nextAllowedAt = 0;
  private activeSince = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly baseDelayMs = 1_000,
    private readonly maxDelayMs = 60_000,
    private readonly lockoutAfter = 5,
    private readonly lockoutMs = 5 * 60_000,
  ) {}

  begin(): AttemptDecision {
    // Defensively recover if an unexpected handler bug abandoned a lease. Normal paths
    // release in `finally`; this avoids a permanent unlock outage after an exception.
    if (this.busy && this.now() - this.activeSince > this.maxDelayMs) this.busy = false;
    const remaining = Math.max(0, this.nextAllowedAt - this.now());
    if (this.busy || remaining > 0) {
      return { allowed: false, retryAfterMs: this.busy ? this.baseDelayMs : remaining };
    }
    this.busy = true;
    this.activeSince = this.now();
    return { allowed: true, retryAfterMs: 0 };
  }

  finish(success: boolean): void {
    if (!this.busy) return;
    this.busy = false;
    this.activeSince = 0;
    if (success) {
      this.failures = 0;
      this.nextAllowedAt = 0;
      return;
    }

    this.failures += 1;
    // The delay is measured only after the KDF completes. An attacker therefore cannot
    // consume the cooldown concurrently with the expensive password calculation.
    const completedAt = this.now();
    const delay = this.failures >= this.lockoutAfter
      ? this.lockoutMs
      : Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.failures - 1));
    this.nextAllowedAt = completedAt + delay;
  }
}
