/**
 * Audio for the bench: decode Q's WebM/Opus recordings with ffmpeg to 16-bit little-endian
 * mono PCM at whatever rate a provider wants, and stream it at real-time pace.
 *
 * Duration comes from the decoded sample count, not the container (Chrome's WebM metadata
 * under-reports it). Q released push-to-talk right after the last word, so the end of the
 * decoded audio is the end of speech.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BYTES_PER_SAMPLE = 2;
/** AssemblyAI rejects chunks under 20 ms; a shorter tail is merged into the previous chunk. */
const MIN_CHUNK_MS = 20;

const cache = new Map<string, Buffer>();

export async function decodePcm(file: string, sampleRate: number): Promise<Buffer> {
  const cacheKey = `${file}@${sampleRate}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-v", "error", "-nostdin", "-i", file,
      "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(sampleRate), "-",
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on("data", (b: Buffer) => out.push(b));
    ff.stderr.on("data", (b: Buffer) => err.push(b));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code} decoding ${file}: ${Buffer.concat(err).toString().trim()}`));
    });
  });
  if (pcm.length === 0) throw new Error(`ffmpeg decoded no audio from ${file}`);
  cache.set(cacheKey, pcm);
  return pcm;
}

export function durationSec(pcm: Buffer, sampleRate: number): number {
  return pcm.length / BYTES_PER_SAMPLE / sampleRate;
}

export interface PaceResult {
  /** performance.now() when streaming started (audio time 0). */
  startedAt: number;
  /** performance.now() just after the last chunk was handed to the socket. */
  lastChunkAt: number;
  chunks: number;
  /** How late the last chunk went out versus the audio clock (ms; should be ~0-2). */
  driftMs: number;
}

/**
 * Send pcm in chunkMs chunks, paced to the wall clock the way a live microphone would deliver
 * it: a chunk goes out when its last sample "has been spoken", i.e. at startedAt + the audio
 * time of the chunk's end. So the last chunk leaves at about startedAt + duration, which is
 * the moment push-to-talk is released.
 *
 * `abort()` is checked before each send; if it returns a message, streaming stops and that
 * message is thrown (e.g. the provider closed the socket mid-stream).
 */
export async function streamPaced(
  pcm: Buffer,
  sampleRate: number,
  chunkMs: number,
  send: (chunk: Buffer) => void,
  abort: () => string | null,
): Promise<PaceResult> {
  const bytesPerMs = (sampleRate * BYTES_PER_SAMPLE) / 1000;
  const align = (n: number) => n - (n % BYTES_PER_SAMPLE);
  const chunkBytes = align(Math.round(chunkMs * bytesPerMs));
  const minTailBytes = align(Math.round(MIN_CHUNK_MS * bytesPerMs));
  const startedAt = performance.now();
  let offset = 0;
  let chunks = 0;
  let lastChunkAt = startedAt;
  let dueAt = startedAt;
  while (offset < pcm.length) {
    let end = Math.min(offset + chunkBytes, pcm.length);
    if (pcm.length - end > 0 && pcm.length - end < minTailBytes) end = pcm.length;
    dueAt = startedAt + end / bytesPerMs;
    const wait = dueAt - performance.now();
    if (wait > 0) await sleep(wait);
    const problem = abort();
    if (problem) throw new Error(problem);
    send(pcm.subarray(offset, end));
    lastChunkAt = performance.now();
    chunks += 1;
    offset = end;
  }
  return { startedAt, lastChunkAt, chunks, driftMs: lastChunkAt - dueAt };
}
