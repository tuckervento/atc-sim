/**
 * Timed streaming POST for the HTTP voice providers (ElevenLabs, Cartesia). The clock starts
 * just before fetch() and stops at the first non-empty body chunk, so time to first audio
 * includes the network round trip, as it would in the game.
 */
import diagnostics_channel from "node:diagnostics_channel";
import { describeError, errorMessage, ProviderError, REQUEST_TIMEOUT_MS, sanitize, USER_AGENT } from "./common.ts";

// Node's fetch (undici) reports each new socket here. Requests run one at a time, so a change in
// the count during a request means that request opened a new connection (TCP + TLS).
let connections = 0;
diagnostics_channel.subscribe("undici:client:connected", () => {
  connections++;
});

export interface TimedAudio {
  /** This request opened a new HTTPS connection instead of reusing a warm one. */
  newConnection: boolean;
  pcm: Buffer;
  /** Request sent → response headers. */
  headersMs: number;
  /** Request sent → first audio bytes. */
  ttfaMs: number;
  /** Request sent → last audio bytes. */
  totalMs: number;
}

export async function timedPcmPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  key: string,
): Promise<TimedAudio> {
  const connectionsBefore = connections;
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(sanitize(`network error: ${describeError(err)}`, key));
  }
  const headersMs = performance.now() - t0;
  if (!res.ok) {
    const text = await res.text();
    throw new ProviderError(sanitize(`HTTP ${res.status} ${errorMessage(text)}`, key), res.status);
  }
  if (!res.body) throw new ProviderError("HTTP 200 with no body");
  const chunks: Buffer[] = [];
  let ttfaMs = Number.NaN;
  try {
    for await (const chunk of res.body) {
      if (chunk.byteLength === 0) continue;
      if (Number.isNaN(ttfaMs)) ttfaMs = performance.now() - t0;
      chunks.push(Buffer.from(chunk));
    }
  } catch (err) {
    throw new ProviderError(sanitize(`stream error: ${describeError(err)}`, key));
  }
  const totalMs = performance.now() - t0;
  if (chunks.length === 0) throw new ProviderError("HTTP 200 but no audio bytes");
  return { newConnection: connections > connectionsBefore, pcm: Buffer.concat(chunks), headersMs, ttfaMs, totalMs };
}
