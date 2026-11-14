/**
 * Counts new TCP/TLS connections per host, from Node's built-in fetch (undici) diagnostics
 * channel. Both providers go through it: the Anthropic SDK uses the global fetch, and the
 * OpenAI calls use fetch directly. Requests run one at a time, so a request that saw the
 * count go up opened a new connection; the others reused a warm keep-alive connection.
 */
import diagnostics from "node:diagnostics_channel";

const counts = new Map<string, number>();
let subscribed = false;

export function trackConnections(): void {
  if (subscribed) return;
  subscribed = true;
  diagnostics.subscribe("undici:client:connected", (message) => {
    const host = (message as { connectParams?: { host?: string; hostname?: string } }).connectParams;
    const key = host?.hostname ?? host?.host ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
}

export function connectionCount(host: string): number {
  if (!subscribed) throw new Error("net.ts: call trackConnections() first");
  return counts.get(host) ?? 0;
}
