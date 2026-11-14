/**
 * Keeps the HTTPS connections to the HTTP providers warm between transmissions.
 *
 * Why: Node's fetch (undici) closes an idle keep-alive socket after about 4 s when the server
 * sends no Keep-Alive hint, and none of these do. Measured 2026-11-14 (scratch test): after a
 * 1 s gap the connection was reused; after 6 s and 20 s gaps a new one was opened. 0.4 measured
 * a cold OpenAI request at about +0.44 s. Live transmissions are 10-30 s apart.
 *
 * How: every 2.5 s, one unauthenticated GET per host (no key is sent; the edge answers 401/404
 * in about 50-200 ms on a warm connection, measured). A host is skipped while a real request to
 * it is in flight, so a ping never makes a real request open a second connection by holding the
 * first. Real requests still record whether they opened a new connection (interp/net.ts), so
 * any cold request shows up in the logs.
 */
import { USER_AGENT } from "../stt/env.ts";

const PING_MS = 2500;
const PING_PATHS: Record<string, string> = {
  "api.openai.com": "/v1/models",
  "api.elevenlabs.io": "/v1/models",
  "api.cartesia.ai": "/voices",
};

const busy = new Map<string, number>();

/** Wrap every real request to a pinged host. */
export async function onHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
  busy.set(host, (busy.get(host) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    busy.set(host, (busy.get(host) ?? 1) - 1);
  }
}

export class Warmer {
  private timer: NodeJS.Timeout | null = null;
  private readonly pinging = new Set<string>();
  pings = 0;
  pingErrors = 0;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [host, path] of Object.entries(PING_PATHS)) {
        if ((busy.get(host) ?? 0) > 0 || this.pinging.has(host)) continue;
        this.pinging.add(host);
        fetch(`https://${host}${path}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(5000) })
          .then((r) => r.arrayBuffer())
          .then(() => { this.pings++; })
          .catch(() => { this.pingErrors++; })
          .finally(() => this.pinging.delete(host));
      }
    }, PING_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
