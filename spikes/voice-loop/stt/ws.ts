/**
 * Thin wrapper over `ws` for the provider clients: connect with auth headers, keep a
 * timestamped log of every JSON message, and wait for a message matching a predicate.
 * Waiting scans already-logged messages first, so a reply that arrives before the wait
 * starts isn't missed. Any wait rejects as soon as the socket closes or errors.
 */
import WebSocket from "ws";
import { USER_AGENT, redact } from "./env.ts";

export type Json = Record<string, unknown>;

export interface LoggedMessage {
  /** performance.now() on arrival. */
  at: number;
  msg: Json;
}

const MAX_ERROR_BODY = 2000;

export class WsSession {
  readonly log: LoggedMessage[] = [];
  readonly connectStartedAt: number;
  openedAt: number | null = null;
  closedAt: number | null = null;
  /** Set when the socket closes or errors; waits reject with it. */
  ended: string | null = null;
  private readonly ws: WebSocket;
  private readonly wakers = new Set<() => void>();

  private constructor(ws: WebSocket, connectStartedAt: number) {
    this.ws = ws;
    this.connectStartedAt = connectStartedAt;
  }

  static connect(url: string, headers: Record<string, string>, timeoutMs: number): Promise<WsSession> {
    const started = performance.now();
    const ws = new WebSocket(url, { headers: { "User-Agent": USER_AGENT, ...headers }, handshakeTimeout: timeoutMs });
    const session = new WsSession(ws, started);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err: Error | null) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(session);
      };
      ws.on("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (b: Buffer) => {
          if (size < MAX_ERROR_BODY) chunks.push(b);
          size += b.length;
        });
        res.on("end", () => {
          const dgError = res.headers["dg-error"];
          const body = Buffer.concat(chunks).toString("utf8").slice(0, MAX_ERROR_BODY);
          const detail = [typeof dgError === "string" ? dgError : "", body].filter(Boolean).join(" | ");
          session.end(`HTTP ${res.statusCode} on connect: ${detail}`);
          settle(new Error(redact(`HTTP ${res.statusCode} on connect: ${detail || res.statusMessage}`)));
          ws.terminate();
        });
      });
      ws.on("open", () => {
        session.openedAt = performance.now();
        settle(null);
      });
      ws.on("message", (data, isBinary) => {
        const at = performance.now();
        if (isBinary) {
          session.push({ at, msg: { type: "<binary>" } });
          return;
        }
        const text = data.toString();
        try {
          const parsed: unknown = JSON.parse(text);
          session.push({ at, msg: parsed && typeof parsed === "object" ? (parsed as Json) : { type: "<non-object>", text } });
        } catch {
          session.push({ at, msg: { type: "<unparsable>", text: text.slice(0, 200) } });
        }
      });
      ws.on("error", (err) => {
        session.end(`socket error: ${err.message}`);
        settle(new Error(redact(`socket error: ${err.message}`)));
      });
      ws.on("close", (code, reason) => {
        session.closedAt = performance.now();
        session.end(`socket closed (code ${code}${reason.length ? `, ${reason.toString()}` : ""})`);
        settle(new Error(redact(`socket closed before open (code ${code}, ${reason.toString()})`)));
      });
    });
  }

  private push(entry: LoggedMessage): void {
    this.log.push(entry);
    for (const wake of this.wakers) wake();
  }

  private end(reason: string): void {
    if (this.ended === null) this.ended = redact(reason);
    for (const wake of this.wakers) wake();
  }

  sendJson(obj: Json): void {
    this.ws.send(JSON.stringify(obj));
  }

  sendBinary(buf: Buffer): void {
    this.ws.send(buf);
  }

  /**
   * Resolve with the first logged message (index >= fromIndex) for which pick() returns a
   * value. Rejects on timeout or when the socket ends.
   */
  waitFor<T>(
    pick: (msg: Json) => T | undefined,
    timeoutMs: number,
    what: string,
    fromIndex = 0,
  ): Promise<{ value: T; at: number; index: number }> {
    return new Promise((resolve, reject) => {
      let next = fromIndex;
      const check = (): boolean => {
        for (; next < this.log.length; next++) {
          const entry = this.log[next]!;
          let value: T | undefined;
          try {
            value = pick(entry.msg);
          } catch (err) {
            done();
            reject(err instanceof Error ? err : new Error(String(err)));
            return true;
          }
          if (value !== undefined) {
            done();
            resolve({ value, at: entry.at, index: next });
            return true;
          }
        }
        if (this.ended !== null) {
          done();
          reject(new Error(`while waiting for ${what}: ${this.ended}`));
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      const waker = () => void check();
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(waker);
      };
      this.wakers.add(waker);
      check();
    });
  }

  /** Close politely, then force after a grace period. Resolves when closed. */
  async close(graceMs = 2000): Promise<void> {
    if (this.closedAt !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, graceMs);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(1000);
      else {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /** Wait (up to timeoutMs) for the server to close the socket itself. */
  waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.closedAt !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Wait windowMs, then join the non-empty text of every message after `afterIndex`
   * (text() extracts it per provider). Null if none arrived.
   */
  async lateText(afterIndex: number, windowMs: number, text: (msg: Json) => string | undefined): Promise<string | null> {
    await new Promise((r) => setTimeout(r, windowMs));
    const parts = this.log
      .slice(afterIndex + 1)
      .map(({ msg }) => text(msg)?.trim() ?? "")
      .filter((t) => t !== "");
    return parts.length ? parts.join(" | ") : null;
  }

  /** Message types with arrival time relative to `origin`, for the saved trace. */
  trace(origin: number): Array<{ t: number; type: string }> {
    return this.log.map(({ at, msg }) => {
      const type = typeof msg.type === "string" ? msg.type : "?";
      const event = typeof msg.event === "string" ? `:${msg.event}` : "";
      return { t: Math.round(at - origin), type: `${type}${event}` };
    });
  }
}
