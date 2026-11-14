/**
 * PCM helpers for the voice bench: WAV wrapping, the speech span inside a clip (so leading and
 * trailing silence don't distort words-per-minute), and decoding Q's WebM recordings with ffmpeg.
 * All PCM here is 16-bit signed little-endian mono.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Every provider is asked for 24 kHz 16-bit mono PCM, so durations compare directly. */
export const SAMPLE_RATE = 24_000;

export function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface Span {
  /** Whole clip, seconds. */
  totalS: number;
  /** First to last frame that counts as speech, seconds. */
  speechS: number;
  leadS: number;
  trailS: number;
}

const FRAME_S = 0.01;
/** A frame is speech if within this many dB of the loudest frame... */
const REL_DB = 35;
/** ...and above this absolute floor (dBFS). */
const FLOOR_DB = -50;

/** Onset and offset need this many consecutive speech frames (50 ms), so a key click or breath doesn't count. */
const SUSTAIN_FRAMES = 5;

/**
 * Finds the span from the first to the last sustained run (50 ms) of 10 ms frames whose RMS is
 * within 35 dB of the loudest frame and above -50 dBFS. Pauses inside the span count, as they
 * do on the radio.
 */
export function speechSpan(pcm: Buffer, sampleRate: number): Span {
  const samples = Math.floor(pcm.length / 2);
  const totalS = samples / sampleRate;
  const frame = Math.max(1, Math.round(sampleRate * FRAME_S));
  const dbs: number[] = [];
  for (let start = 0; start + frame <= samples; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) {
      const s = pcm.readInt16LE(i * 2) / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / frame);
    dbs.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  if (dbs.length === 0) return { totalS, speechS: 0, leadS: totalS, trailS: 0 };
  const threshold = Math.max(FLOOR_DB, Math.max(...dbs) - REL_DB);
  const loud = dbs.map((db) => db >= threshold);
  const sustainedFrom = (i: number, step: 1 | -1): boolean => {
    for (let k = 0; k < SUSTAIN_FRAMES; k++) if (!loud[i + k * step]) return false;
    return true;
  };
  let first = -1;
  for (let i = 0; i < loud.length && first < 0; i++) if (sustainedFrom(i, 1)) first = i;
  let last = -1;
  for (let i = loud.length - 1; i >= 0 && last < 0; i--) if (sustainedFrom(i, -1)) last = i;
  if (first < 0 || last < first) return { totalS, speechS: 0, leadS: totalS, trailS: 0 };
  const leadS = first * FRAME_S;
  const endS = (last + 1) * FRAME_S;
  return { totalS, speechS: endS - leadS, leadS, trailS: Math.max(0, totalS - endS) };
}

/** Decode any audio file ffmpeg understands to 16-bit mono PCM at `sampleRate`. Read-only. */
export async function decodeToPcm16(file: string, sampleRate: number): Promise<Buffer> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", file, "-f", "s16le", "-ac", "1", "-ar", String(sampleRate), "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}
