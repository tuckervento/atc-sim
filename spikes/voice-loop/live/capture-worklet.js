// AudioWorklet for the live loop (task 0.6). Runs in a 16 kHz AudioContext, so Chrome resamples
// the microphone to 16 kHz before it gets here. While "on", it packs samples into PCM16 frames of
// 320 samples (20 ms) and posts each one to the page, which sends it to the server.
// On "stop" it pads the last partial frame with silence to a full 20 ms (AssemblyAI rejects
// chunks under 20 ms), posts it, then posts "stopped". It also posts the input peak every ~50 ms
// for the level meter.

const FRAME = 320; // 20 ms at 16 kHz
const LEVEL_EVERY = 800; // ~50 ms

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Int16Array(FRAME);
    this.n = 0;
    this.peak = 0;
    this.sinceLevel = 0;
    this.port.onmessage = (e) => {
      if (e.data === "start") {
        this.on = true;
        this.n = 0;
      } else if (e.data === "stop") {
        if (this.on && this.n > 0) {
          this.buf.fill(0, this.n);
          this.flush();
        }
        this.on = false;
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  flush() {
    const out = this.buf.slice(0);
    this.port.postMessage({ type: "chunk", pcm: out.buffer }, [out.buffer]);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        const a = Math.abs(s);
        if (a > this.peak) this.peak = a;
        if (this.on) {
          this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          if (this.n === FRAME) this.flush();
        }
      }
      this.sinceLevel += ch.length;
      if (this.sinceLevel >= LEVEL_EVERY) {
        this.port.postMessage({ type: "level", peak: this.peak });
        this.peak = 0;
        this.sinceLevel = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture", Capture);
