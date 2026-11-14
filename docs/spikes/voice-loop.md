# Voice-loop spike (Phase 0)

Phase 0 is a throwaway test of the voice chain before the game depends on it: push-to-talk
audio → streaming speech-to-text → language-model interpreter → templated pilot readback →
streaming voice. It measures latency, accuracy and cost for each candidate service and picks
one per stage. Targets come from the [PRD](../prd/ground-control-v1.md):
- **Latency (§6.3):** median ≤ 1.0 s from push-to-talk release to the first pilot audio. The
  budget splits into final transcript ≤ 0.3 s, interpretation ≤ 0.4 s, first voice audio
  ≤ 0.2 s and scheduling ≤ 0.1 s.
- **Cost (§11):** $5/hr soft cap and $10/hr hard cap at peak traffic.
- **Accents (§6.2):** the chosen voice service must be able to do accented English later.

Tasks 0.1–0.6 in [PLAN.md](../../PLAN.md) fill in this doc. The spike code lives in
`spikes/voice-loop/`, a standalone npm package.

## Shortlist

_Task 0.1. Researched 2026-11-14. Every price and feature below was read on 2026-11-14 from the
provider's own pages (links under [Sources](#sources)). USD, standard pay-as-you-go tier.
$/hr is at the peak assumption under [Cost at peak](#cost-at-peak)._

### What changed from the plan's assumptions

- **OpenAI is retiring its plain text-to-speech endpoint.** `tts-1`, `tts-1-hd` and
  `gpt-4o-mini-tts` shut down on **2027-01-06** (announced 2026-10-01). OpenAI's named
  replacement is `gpt-realtime-2.1-mini` on the Realtime API, so that model is on the
  shortlist. It's a speech-to-speech reasoning model with no verbatim "say exactly this" mode.
- **OpenAI's older speech-to-text models are also retiring.** `whisper-1`, `gpt-4o-transcribe`
  and `gpt-4o-mini-transcribe` shut down on 2027-02-26. The shortlist uses
  `gpt-live-transcribe`.
- **OpenAI's previous small models are retiring.** `gpt-5-nano` and `gpt-5-mini` shut down on
  2026-12-11. The OpenAI small model is `gpt-6-luna`, which costs the same as Claude Haiku 5.5.
- **ElevenLabs' newest models have no speaking-rate control.** ElevenLabs' Agents docs say
  speed isn't available on v3, v4 or v4 Turbo, and point to Flash v2 / v2.5. The shortlisted
  ElevenLabs model is therefore `eleven_flash_v2_5`.
- **AssemblyAI bills streaming by how long the WebSocket is open**, not by the audio sent.
  Keeping one session open all hour costs the full hourly rate.
- **Every combination is under the $5/hr soft cap** at the peak assumption. The worst case is
  $2.77/hr. Voices are the largest cost.

### Speech-to-text

| Candidate | Streaming | Vocabulary hints | End of turn for push-to-talk | Published price | Est. $/hr at peak | Notes |
|---|---|---|---|---|---|---|
| OpenAI `gpt-live-transcribe` | Yes. Realtime API over WebSocket (`/v1/realtime?intent=transcription`) or WebRTC. Sends text deltas as speech arrives. | `prompt` and `keywords` | Client commits the turn (`input_audio_buffer.commit`, `turn_detection: null`). A `delay` setting (`minimal`…`xhigh`) trades latency for accuracy. | $0.017/min | **$0.51** | OpenAI's recommended realtime model. Cheaper variant on the same key: `gpt-transcribe` ($0.0045/min, $0.14/hr), which starts transcribing only after the commit. 0.3 can test both. |
| Deepgram Nova-3 (monolingual) | Yes. WebSocket `/v1/listen`. | Keyterm prompting: up to 500 tokens, can change mid-stream | Finalize message (verified in 0.3: every line's final arrived as a `from_finalize` Results message) | $0.0048/min promo (list $0.0077) + keyterms $0.0013/min | **$0.18** promo / $0.27 list | The pricing page marks the STT rates as promo pricing. |
| Deepgram Flux (`flux-general-en`) | Yes. WebSocket `/v2/listen`. | Keyterm prompting (via a `Configure` message) | End-of-turn detection built into the model (~260 ms). `ForceEndTurn` with `eot_threshold: 1.0` lets the app drive turns. | $0.0065/min promo (list $0.0077) + keyterms $0.0013/min (assumed to apply) | **$0.23** promo / $0.27 list | Same key as Nova-3. Built for turn-based voice agents. |
| AssemblyAI Universal-Streaming English (`universal-streaming-english`) | Yes. WebSocket `wss://streaming.assemblyai.com/v3/ws`. | `keyterms_prompt`: up to 100 terms, set only at connect time | `ForceEndpoint` message | $0.15/hr + $0.04/hr keyterms, billed on session time | **$0.10** (session per transmission) to $0.19 (session always open) | AssemblyAI quotes ~300 ms word-by-word transcripts. |
| AssemblyAI Universal-3.6 Pro Realtime (`universal-3-6-pro`) | Yes, same endpoint | `keyterms_prompt`: up to 100 terms, included, can change mid-stream | `ForceEndpoint` message | $0.45/hr including keyterms, billed on session time | **$0.23** to $0.45 | AssemblyAI recommends it for new voice-agent work. Its own models reference says latency is slightly higher than Universal-Streaming English. |

### Interpreter (language model)

| Candidate | Streaming | Structured output | Thinking / reasoning control | Published price (per 1M tokens) | Est. $/hr at peak | Notes |
|---|---|---|---|---|---|---|
| Anthropic `claude-haiku-5-5` | Yes | Structured outputs (`output_config.format`) and strict tool use | Adaptive thinking is on by default; default effort `medium`. `thinking: {type: "disabled"}` is accepted at effort `high` or below (per the claude-api skill reference; the Models API reports it under `capabilities.thinking.types.disabled`). | $0.10 input, $0.01 cache hit, $0.125 cache write (5 min), $0.50 output, for prompts up to 100K tokens ($0.50 / $2.50 above) | **$0.09** cached / $0.22 uncached | Anthropic labels it "Fastest". 1M context. The minimum cacheable prefix is 512 tokens per the claude-api skill reference; 0.4 should confirm it with `cache_read_input_tokens`. |
| OpenAI `gpt-6-luna` | Yes | Structured outputs and function calling (on Chat Completions, function calling requires `reasoning_effort: "none"`) | `reasoning_effort` from `none` to `max`; default `medium` | $0.10 input, $0.01 cached input, $0.125 cache write, $0.50 output | **$0.09** cached / $0.22 uncached | Available on the Responses API and Chat Completions. |

### Voices (text-to-speech)

| Candidate | Streaming | Speaking-rate control | Accented English | Voices | Published price | Est. $/hr at peak | Notes |
|---|---|---|---|---|---|---|---|
| OpenAI `gpt-realtime-2.1-mini` | Yes. Realtime API (WebSocket / WebRTC), PCM at 24 kHz. | `speed` from 0.25 to 1.5. It's a playback-rate change applied after generation, so pacing has to be asked for in the instructions too. | **Not documented** for realtime voices. (`gpt-4o-mini-tts` documented accent control, but it retires 2027-01-06.) | 10 built-in (alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar). Custom voices need a consent recording. | $20 audio out, $0.60 text in, $2.40 text out per 1M tokens. 1 audio token per 50 ms, so about $0.024 per minute of speech. | **$0.78** | No verbatim mode: the model speaks the line from instructions, so it may paraphrase. A session can't change voice once it has spoken, so each flight voice needs its own session. Reasoning tokens aren't costed. Weakest on the PRD's accent requirement. |
| ElevenLabs `eleven_flash_v2_5` | Yes. HTTP streaming (`/v1/text-to-speech/{voice_id}/stream`) in PCM, μ-law, Opus or MP3. | `voice_settings.speed` from 0.7 to 1.2 | **Yes.** Voices carry an `accent` label. The shared Voice Library can be filtered by `accent`, and `GET /v1/voices/accents` lists the accent values. | Large shared Voice Library. Library voices can't be used through the API on the free tier. | $0.04 per 1K characters (API pay-as-you-go). The Creator plan ($22/mo) includes 550K Flash characters. | **$1.26** | ~100 ms median model latency, excluding network. 32 languages. `eleven_v4_turbo` is also ~100 ms and the same price, but has no rate control per the Agents docs. 0.5 can check whether the TTS API's `speed` works on it. |
| Cartesia `sonic-3.6` | Yes. `POST /tts/bytes` streams audio from a complete line. | `generation_config.speed` from 0.6 to 1.5 | **Yes.** An explicit `accent` request field, chosen from each voice's `accents[]` list (BCP-47 locales). Voices can be filtered by locale, e.g. `en-GB`. | Voice library, filterable by gender and locale | 1 credit per character. Pro: $5/mo for 100K credits, then $65 per 1M. Startup: $49/mo for 1.25M, then $45 per 1M. Scale: $299/mo for 8M, then $38 per 1M. | **$1.20–$2.05** by plan | Concurrent TTS requests: 2 on Free, 3 on Pro, 5 on Startup. Strongest on the accent requirement. |

**Considered, not shortlisted:**
- **OpenAI:** `gpt-4o-mini-tts`, `tts-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`, `gpt-5-nano` and `gpt-5-mini` all retire within 4 months (dates above).
- **ElevenLabs:** `eleven_turbo_v2_5` is deprecated in favour of Flash v2.5. `eleven_v4_turbo` lacks rate control, per the Agents docs.
- **Fallbacks if voice costs need cutting:** both use keys we're creating anyway, but neither is evaluated here.
  - Deepgram Aura-2 TTS ($0.030 per 1K characters) works on the Deepgram key.
  - ElevenLabs Scribe v3 Live STT ($0.22/hr + $0.08/hr keyterms) works on the ElevenLabs key.
- **Anthropic:** Claude Haiku 4.5 costs 10× Haiku 5.5.

### Cost at peak

**Assumptions**

1. **Player transmissions:** 450/hr × 4 s = 30 minutes of player audio per hour (PLAN Context).
2. **Pilot and tower lines:** 450/hr × 4 s = 30 minutes of generated speech per hour (PLAN Context).
3. **Characters per voiced line: 70**, so 31,500 characters per hour.
   - A short readback, "Kilo Alpha, hold short three one left, Delta four", is 49 characters.
   - 70 leaves room for longer routes and spelled-out numbers.
   - Cartesia's figure of ~750–800 characters per minute of audio implies ~53 characters per 4 s.
4. **Interpreter: one call per transmission** (450/hr), with the context in the prompt.
   - 3,000-token static prefix (instructions, command schema, JFK taxiway and runway names), cached.
   - 1,000 tokens of live flight context plus a 30-token transcript, not cached.
   - 150 output tokens.
   - The tool-call approach isn't costed here; 0.4 measures it.
5. **Speech-to-text billing:** OpenAI and Deepgram bill on audio sent. AssemblyAI bills on
   session time: the low figure opens a session per transmission (30 min/hr), and the high
   figure keeps one session open all hour.
6. **OpenAI realtime voice:**
   - 1,200 audio tokens per minute of speech.
   - About 150 text-input and 20 text-output tokens per line.
   - Reasoning tokens aren't included (amount unknown).
7. **Pricing basis:** standard tier. Excluded:
   - batch discounts
   - Anthropic's US-only `inference_geo` (×1.1)
   - fixed monthly subscriptions (ElevenLabs, Cartesia)

   Deepgram's promo price is shown, with its list price alongside.

**Combinations** (speech-to-text + interpreter + voice). The ×2 column doubles every volume
above, as a margin for the assumption being low.

| Combination | $/hr | ×2 volume | Against caps ($5 soft / $10 hard) |
|---|---|---|---|
| Deepgram Nova-3 (promo) + Haiku 5.5 cached + OpenAI realtime | $1.06 | $2.12 | Under both |
| OpenAI `gpt-live-transcribe` + `gpt-6-luna` cached + OpenAI realtime (all OpenAI) | $1.39 | $2.77 | Under both |
| Deepgram Nova-3 (list) + Haiku 5.5 cached + ElevenLabs Flash v2.5 | $1.62 | $3.25 | Under both |
| Deepgram Flux (list) + Haiku 5.5 cached + Cartesia (Startup rate) | $1.78 | $3.56 | Under both |
| OpenAI `gpt-live-transcribe` + Haiku 5.5 cached + ElevenLabs Flash v2.5 | $1.86 | $3.73 | Under both |
| AssemblyAI Universal-3.6 Pro, always open + Haiku 5.5 uncached + Cartesia (Pro overage) | $2.71 | $5.43 | Under both; ×2 crosses the soft cap |
| **Worst case:** `gpt-live-transcribe` + interpreter uncached + Cartesia (Pro overage) | **$2.77** | $5.55 | Under both; ×2 crosses the soft cap |

What this means:
- Voices are 50–75% of the bill, and the interpreter is under 10%.
- At the stated assumption cost doesn't rule anything out, so latency and accuracy will decide.
- 0.6 revises the volumes from live counts.

### Access

Keys go in `spikes/voice-loop/.env.local` (gitignored). `spikes/voice-loop/.env.example` lists
every variable and where to create each key.

`npm --prefix spikes/voice-loop run check-keys` makes one free, authenticated request per
provider. Each request also confirms the key can see the shortlisted model where the API allows
it. The script prints `OK`, `MISSING` or `FAIL` per provider.

| Provider | Variable | Check request |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `models.retrieve("claude-haiku-5-5")` via `@anthropic-ai/sdk` |
| OpenAI | `OPENAI_API_KEY` | `GET /v1/models`, then confirms `gpt-live-transcribe`, `gpt-6-luna` and `gpt-realtime-2.1-mini` are listed |
| Deepgram | `DEEPGRAM_API_KEY` | `GET /v1/projects` |
| AssemblyAI | `ASSEMBLYAI_API_KEY` | `GET /v2/transcript?limit=1` |
| ElevenLabs | `ELEVENLABS_API_KEY` | `GET /v2/voices?page_size=1` (needs the Voices: Read permission) |
| Cartesia | `CARTESIA_API_KEY` | `GET /voices?limit=1` with `Cartesia-Version: 2026-08-14` |

### Notes for later tasks

- **0.3:**
  - AssemblyAI Universal-Streaming English takes keyterms only at connect time. It's worth
    timing connect cost against the price of keeping a session open.
  - OpenAI's realtime transcription doesn't support server VAD on `gpt-live-transcribe`; the
    client commits turns, which fits push-to-talk.
- **0.4:**
  - Try Haiku 5.5 with thinking disabled or at low effort, and `gpt-6-luna` at
    `reasoning_effort: "none"`, for latency.
  - Confirm prompt caching takes effect on the static airport prefix.
- **0.5:**
  - For OpenAI, each flight voice needs its own Realtime session. Check whether lines come back
    word-for-word.
  - For ElevenLabs, check whether `speed` has any effect on `eleven_v4_turbo` through the TTS API.

### Sources

All read 2026-11-14.

- **Anthropic:** [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) ·
  [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- **OpenAI:**
  - Pricing and models: [Pricing](https://developers.openai.com/api/docs/pricing) ·
    [Models](https://developers.openai.com/api/docs/models) ·
    [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna) ·
    [gpt-realtime-2.1-mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini) ·
    [Deprecations](https://developers.openai.com/api/docs/deprecations)
  - Speech-to-text: [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text) ·
    [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
  - Voices and realtime: [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech) ·
    [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) ·
    [Realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs) ·
    [Realtime session `speed`](https://developers.openai.com/api/reference/resources/realtime/subresources/sessions/methods/create)
- **Deepgram:** [Pricing](https://deepgram.com/pricing) ·
  [Keyterm prompting](https://developers.deepgram.com/docs/keyterm) ·
  [Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart) ·
  [List projects](https://developers.deepgram.com/reference/get-projects)
- **AssemblyAI:**
  - [Pricing](https://www.assemblyai.com/pricing) (page says pricing last updated 2026-11-10)
  - [Streaming](https://www.assemblyai.com/docs/speech-to-text/universal-streaming) ·
    [Universal-Streaming → Universal-3.6 Pro migration guide](https://www.assemblyai.com/docs/streaming/migration-guides/universal-to-u3-pro-streaming)
    (keyterm limits, `ForceEndpoint`) · [Models](https://www.assemblyai.com/docs/getting-started/models) ·
    [List transcripts](https://www.assemblyai.com/docs/api-reference/transcripts/list)
- **ElevenLabs:**
  - Pricing and models: [API pricing](https://elevenlabs.io/pricing/api) ·
    [Models](https://elevenlabs.io/docs/overview/models)
  - Endpoints and settings: [Stream speech](https://elevenlabs.io/docs/api-reference/text-to-speech/stream) ·
    [Speed control](https://elevenlabs.io/docs/eleven-agents/customization/voice/speed-control) ·
    [List voices](https://elevenlabs.io/docs/api-reference/voices/search)
  - Voice Library: [Shared voices](https://elevenlabs.io/docs/api-reference/voices/voice-library/get-shared) ·
    [Voice Library](https://elevenlabs.io/docs/eleven-creative/voices/voice-library)
    (no API use of library voices on the free tier; seen in search results, page not opened) ·
    [Changelog 2026-07-27](https://elevenlabs.io/docs/changelog/2026/7/27)
    (`GET /v1/voices/accents`; seen in search results, page not opened)
- **Cartesia:** [Pricing](https://cartesia.ai/pricing) ·
  [TTS bytes](https://docs.cartesia.ai/api-reference/tts/bytes) ·
  [List voices](https://docs.cartesia.ai/api-reference/voices/list)

## Speech-to-text

_Task 0.3. Run 2026-11-14 on Q's 34 recordings. WER re-scored the same day, after five reference lines were corrected to what Q said (see [error patterns](#notable-error-patterns)); latency and critical tokens didn't change. Raw results: `spikes/voice-loop/results/stt/`._

### Results

Each candidate streamed all 34 lines at real-time pace, using the shared vocabulary hints, and ended each turn the push-to-talk way. Every candidate returned a final transcript for 34/34 lines, with no errors. "≤ 300 ms" counts lines within PRD §6.3's final-transcript budget.

| Candidate | Latency median | Latency p95 | ≤ 300 ms | WER | Critical tokens | Lines with every critical token right | $/hr at peak |
|---|---|---|---|---|---|---|---|
| OpenAI `gpt-live-transcribe` | 565 ms | 836 ms | 0/34 | 1.4% | 98.9% | 33/34 | $0.51 |
| OpenAI `gpt-transcribe` | 634 ms | 812 ms | 0/34 | 0.7% | 98.9% | 33/34 | $0.13 |
| **Deepgram Nova-3** | **124 ms** | 357 ms | 32/34 | 2.3% | **100%** | **34/34** | $0.18 promo / $0.27 list |
| Deepgram Flux, 500 ms silence pad | 374 ms | 540 ms | 0/34 | 8.2% | 88.4% | 26/34 | $0.23 promo / $0.27 list |
| _Flux, no pad (first pass; transcripts cut short)_ | _130 ms_ | _211 ms_ | _34/34_ | _11.7% (original reference; not re-scored)_ | _83.2%_ | _22/34_ | _same_ |
| AssemblyAI Universal-Streaming English | 616 ms | 749 ms | 0/34 | 4.1% | 95.8% | 31/34 | $0.10–$0.19 (measured sessions: $0.11) |
| **AssemblyAI Universal-3.6 Pro** | **120 ms** | **213 ms** | **34/34** | **0.2%** | **100%** | **34/34** | $0.23–$0.45 (measured sessions: $0.28) |

Critical tokens by category, found / annotated:

| Candidate | Callsign | Runway | Taxiway | Hold-short target | First partial text (median, from audio start) |
|---|---|---|---|---|---|
| OpenAI `gpt-live-transcribe` | 97.0% (32/33) | 100% (11/11) | 100% (35/35) | 100% (16/16) | 1438 ms |
| OpenAI `gpt-transcribe` | 97.0% (32/33) | 100% (11/11) | 100% (35/35) | 100% (16/16) | 6195 ms (text only starts after the commit) |
| Deepgram Nova-3 | 100% (33/33) | 100% (11/11) | 100% (35/35) | 100% (16/16) | 1146 ms |
| Deepgram Flux, 500 ms pad | 78.8% (26/33) | 100% (11/11) | 97.1% (34/35) | 81.3% (13/16) | 589 ms |
| AssemblyAI Universal-Streaming English | 100% (33/33) | 81.8% (9/11) | 100% (35/35) | 87.5% (14/16) | 1874 ms |
| AssemblyAI Universal-3.6 Pro | 100% (33/33) | 100% (11/11) | 100% (35/35) | 100% (16/16) | 984 ms |

**Recommendation for 0.6: take Deepgram Nova-3 and AssemblyAI Universal-3.6 Pro into the live loop.** They're the only two that meet the 0.3 s budget at the median, and both got every critical token right on all 34 lines.
- **Universal-3.6 Pro** is the slightly stronger result:
  - every line within budget, with the tightest tail (p95 213 ms, worst 222 ms)
  - the lowest WER (0.2%)
- **Nova-3** is cheaper, bills plainly on audio sent, and has no session-rate limit in the way:
  - median 124 ms
  - 2 lines over budget: 357 ms, and a lone 761 ms
- Both cost a fraction of the $5/hr soft cap, so cost doesn't separate them.

This test set can't separate the two on accuracy. 0.6's live transmissions should run both, or A/B them, before Q picks.

Not recommended:
- **OpenAI (both models):** as accurate as the leaders on critical tokens, but no line came in under 451 ms.
- **Flux:** cuts off the last word unless padded. Padded, it's over budget and mishears callsigns.
- **Universal-Streaming English:** its push-to-talk end-of-turn costs ~600 ms, and it mangles numbers.

### What didn't work as documented

These changed how the bench ends a turn for three candidates. They matter for 0.6.

1. **AssemblyAI Universal-Streaming English: `ForceEndpoint` drops the last word.**
   - On probe line 01, the end-of-turn `Turn` arrived 37 ms after release reading "…hold short of". "Bravo" went into a new turn, which didn't end until `Terminate` was sent 2 s later.
   - `ForceEndpoint` ends the turn at whatever audio the server has processed so far.
   - `{"type":"Terminate"}` flushes all received audio into one complete end-of-turn, so the bench uses it. Measured on line 01: 593 ms, complete.
   - Consequence: push-to-talk with this model means one session per transmission, at ~600 ms.
   - Universal-3.6 Pro doesn't have this problem. Its `ForceEndpoint` returned complete transcripts in ~110 ms on both probe lines (01, 11), and on all 34 lines in the full pass.
2. **Deepgram Flux: `ForceEndTurn` drops the tail.**
   - Deepgram's docs say the EndOfTurn transcript "reflects audio transcribed before the message arrived". Sent right at release, the first full pass lost the last word(s) on 9 of 34 lines ("…hold short" with no "Bravo", "…left on" with no "Alpha", "runway four" with no "right") and garbled the end of 2 more.
   - That run looked fast (median 130 ms) because it was answering early. It's kept in `results/stt/deepgram-flux-general-en.no-padding.json` and shown in italics above.
   - Fixes tried on 4 of the truncated lines:
     - `CloseStream` instead of `ForceEndTurn`: the socket closed with no EndOfTurn at all.
     - 250 ms of silence sent in one burst, then `ForceEndTurn`: complete, 271–1031 ms.
     - 500 ms of silence, then `ForceEndTurn`: complete, 330–435 ms.
   - The re-run used 500 ms (`stt/deepgram.ts`, `FLUX_DEFAULT_PAD_MS`). With it the tail is fixed: the last word differs on 4/34 lines, all ordinary mishearings. But latency goes to median 374 ms.
3. **OpenAI's `delay` setting isn't available on either model**, although the realtime-transcription guide shows it for `gpt-live-transcribe`.
   - `gpt-live-transcribe` accepts it silently but drops it: it's absent from the `session.updated` echo, and latency was unchanged (596 vs 637 ms on line 01).
   - `gpt-transcribe` rejects it: "The 'delay' parameter is not supported for this model".
   - So there's no knob to trade OpenAI accuracy for latency.
   - Also, OpenAI's `completed` event trails the last text delta by a median 233 ms (`gpt-live-transcribe`) and 209 ms (`gpt-transcribe`). The text is in hand ~0.2 s before OpenAI says it's final.
4. **Deepgram Nova-3's `Finalize` did return `from_finalize: true` on 34/34 lines.** The § Shortlist had marked this unchecked.
5. **AssemblyAI free-tier limit:** 5 new streaming sessions per minute. The bench throttled itself to that (57 waits) and was never refused.

**The late-text check didn't catch Flux.** The bench listens 1 s past every final for more transcript text (`lateText` in the JSON). That's what exposed the Universal-Streaming problem while probing. In the full pass, no candidate sent any text after its final, on any line.

Flux doesn't send the dropped audio later; it just discards it. So its truncation was caught afterwards by comparing each transcript's last word with the script's:

| Candidate | Lines where the last word differs from the script |
|---|---|
| Flux, no pad | 15 (9 truncated, 2 garbled, 4 mishearings) |
| Flux, padded | 4 |
| Universal-Streaming English | 2 |
| Nova-3 | 2 |
| `gpt-live-transcribe` | 2 |
| Universal-3.6 Pro | 0 |
| `gpt-transcribe` | 0 |

Outside the two Flux rows, every one of these is a mishearing ("sit tight" → "zip type"), not a cut-off.

### Notable error patterns

- **Where Q's reading differs from the script.** On five lines, every candidate agrees on wording that differs from the script:
  - 05 and 27: "right **on** Kilo Echo"
  - 10: "into/to Terminal Eight"
  - 30: "say **it** again"
  - 32: "expect twenty thirty minutes" for "expect about twenty minutes"

  Before the edit, taking the best of the six transcripts on every line gave a WER floor of 1.3% (7 of 556 tokens), which every candidate's WER included. Critical tokens weren't affected.
  **The reference was edited on 2026-11-14 to match Q's wording** (Q agreed), and every candidate was re-scored from its saved transcripts. The pre-edit WERs were 1.4–2.4 points higher; they're in commit 213117a.
  - Line 10: the candidates split between "to" (4 of 6, including the two most accurate) and "into" (Universal-Streaming English), so the reference now says "to". Q can confirm by playing `test-set/audio/10.webm`.
  - Line 32: Q said a range, so its readback became "twenty to thirty minutes". 1.2's `delay N` takes one number, so 0.4 must decide how to express it: score the lower bound, or add a range form to 1.2.
- **Callsigns.** Nova-3 and both AssemblyAI models got 33/33.
  - OpenAI missed one each:
    - `gpt-live-transcribe`: "Qatary seven zero one"
    - `gpt-transcribe`: "Delta thirty twenty-three forty"
  - Flux missed 7, all mishearings of the airline or the number:
    - "Alaska men are three" (niner)
    - "Guitar is seven zero one" (Qatari)
    - "The tons are four zero five" (Lufthansa)
    - "Delta Twelver for" (twelve oh four)
    - "Delta Earth twenty three forty"
    - "Swiss won seven hui"
    - "Iberia has six twenty six"

  These are the "Delta for" → DAL4 mishearings the interpreter's game context is meant to fix (PRD §6.1). The leaders gave it nothing to fix.
- **"Niner":** fine everywhere except two candidates:
  - Flux: "men are", line 11.
  - Universal-Streaming English, on the altimeter: "290 niner two" and "2-9 or 902".
- **Runway numbers:** 11/11 for everyone except Universal-Streaming English, which merges adjacent numbers:
  - "JetBlue eleven twenty-three, three one left" → "jetblue 11231 left" (a digit lost)
  - "runway three one left" → "runway through one left"

  Universal-3.6 Pro also writes digits, but keeps them apart with punctuation ("JetBlue 1123, 31 left").
- **"Cross runway" → "cross one way"** (line 17): Nova-3, Flux and Universal-Streaming English. The runway designator itself was right; the interpreter should tolerate this.
- **Hold-short phrase:**
  - Universal-Streaming English: "holds short"
  - Flux: "old short", "whole short"

  Each loses the hold-short target under this scoring, and would be risky in the game.
- **Meaning-changing errors on unscored words:**
  - `gpt-live-transcribe` turned line 16's "stop, stop, hold your position" into "stop, stop hold short." That's a hold-short (C3) with no target instead of hold position (C4).
  - Universal-Streaming English made the turn directions "red on Bravo" and "the next ride".
  - Flux made "ridicule of Charlie" (right at Kilo Charlie) and "monitor it when you get there".
  - Universal-Streaming English wrote "monitor right" for "monitor ramp" (C7 handoff).
- **Common non-critical slips:** "sit tight" → "zip type / zip tie / SIP type" (Nova-3, Universal-Streaming English, Flux); "the pad" → "the pond / the pod"; "callsign" → "comm sign".

### Method

**Run:** `npm --prefix spikes/voice-loop run stt-bench` (all candidates, all 34 lines). Filters for cheap re-runs:
- `--provider openai|deepgram|assemblyai`, `--model <id>`, `--lines 01,02`, `--limit N`
- `--rescore` re-scores saved transcripts with no API calls
- `--opt key=value` sets provider overrides (needs `--out DIR`): `delay`, `prompt` and `keywords` for OpenAI; `pad_ms` for Flux; `sessions_per_min` for AssemblyAI

Code: `spikes/voice-loop/stt-bench.ts` and `spikes/voice-loop/stt/`. Per-line results are in `spikes/voice-loop/results/stt/<candidate>.json`, 34 entries each, for 0.4: transcript, latency, timings, partial count, message trace, late text, errors and score. `results/stt/spend-log.jsonl` is the running cost estimate.

**Audio**
- Q's 34 recordings (`test-set/audio/NN.webm`, Chrome WebM/Opus, 48 kHz) are decoded with ffmpeg to 16-bit mono PCM at each provider's rate: 24 kHz for OpenAI, 16 kHz for Deepgram and AssemblyAI.
- Durations come from the decoded samples: 3.06–11.34 s, 206.2 s in total, mean 6.07 s.
- Q released push-to-talk right after the last word, so the end of the decoded audio is the end of speech. There's no trailing silence for a provider's voice detection to use.

**Streaming**
- Each clip gets a fresh WebSocket session, opened and configured before audio starts. Connect time isn't counted in latency. Measured median connect times:

  | Candidate | Median connect |
  |---|---|
  | Flux | 265 ms |
  | Nova-3 | 290 ms |
  | `gpt-transcribe` | 318 ms |
  | `gpt-live-transcribe` | 350 ms |
  | Universal-3.6 Pro | 407 ms |
  | Universal-Streaming English | 411 ms |

- Audio goes out in 80 ms chunks, inside every provider's recommended range (Flux "strongly recommends" 80 ms; AssemblyAI takes 20–1000 ms and recommends 50–100).
- Each chunk is sent when its last sample would have been spoken: stream start plus the audio time of the chunk's end. So the last chunk leaves at the moment of release. A tail under 20 ms is merged into the previous chunk, because AssemblyAI rejects chunks under 20 ms.
- Measured pacing: on every line, the stream lasted the audio's duration to within 6 ms (worst 5.9 ms; `timings.streamMs`, `timings.driftMs`).
- The three providers ran in parallel processes, one per provider. Within a provider, candidates and lines ran one after another. The Flux re-run overlapped the AssemblyAI pass. Upload is about 32–48 KB/s per stream.

**End of turn** is sent immediately after the last chunk, the push-to-talk way:

| Candidate | Endpoint and settings | End-of-turn message | Final transcript is |
|---|---|---|---|
| OpenAI `gpt-live-transcribe`, `gpt-transcribe` | `wss://api.openai.com/v1/realtime?intent=transcription`, `turn_detection: null` | `input_audio_buffer.commit` | `conversation.item.input_audio_transcription.completed` for the committed item |
| Deepgram Nova-3 | `/v1/listen`, `language=en`, `interim_results=true` | `{"type":"Finalize"}` | the `Results` message with `from_finalize: true`. The transcript is every `is_final` segment joined. |
| Deepgram Flux | `/v2/listen`, `eot_threshold=1.0` (the model never ends a turn on its own) | 500 ms of silence in one burst, then `{"type":"ForceEndTurn"}` | `TurnInfo` `EndOfTurn` (trigger `manual`) |
| AssemblyAI Universal-Streaming English | `/v3/ws`, `format_turns=false`, min/max turn silence 5 s | `{"type":"Terminate"}` | the end-of-turn `Turn` |
| AssemblyAI Universal-3.6 Pro | `/v3/ws`, min/max turn silence 5 s | `{"type":"ForceEndpoint"}` | the end-of-turn `Turn` (always formatted) |

**Latency** = arrival of the final-transcript message minus the moment the last audio chunk was handed to the socket. Both are `performance.now()` in the same process.
- It includes the network round trip from Q's Mac to each provider.
- p95 is nearest-rank: the ceil(0.95 × n)-th smallest value, i.e. the 33rd of 34.

**Vocabulary hints:** one shared list, `spikes/voice-loop/stt/vocab.ts`, 87 terms, given unchanged to every candidate. 100 terms is the tightest provider limit (AssemblyAI, Flux).
- ICAO phonetic alphabet (26)
- JFK K-connector taxiways as spoken pairs (Kilo Charlie … Kilo Kilo; 6)
- runway designators spoken digit by digit ("three one left"; 8)
- airline radio names (24): every airline in the script plus 8 other real JFK operators, so the list isn't only the answer key
- ground-control phrases (23): "hold short", "Kennedy Ground", "niner", "penalty box", terminal names, …

No flight numbers or whole callsigns are hinted. How each provider takes the list:

| Candidate | How the list is sent |
|---|---|
| OpenAI (both models) | `keywords`, plus a short generic `prompt` describing JFK ground ATC (no script lines). Both models echo both back in `session.updated`. |
| Deepgram (both models) | one `keyterm` query parameter per term |
| AssemblyAI (both models) | `keyterms_prompt`, a JSON array |

### Scoring

**Normalization** (`stt/normalize.ts`) is applied identically to the reference (the script's `say` text) and to every transcript:
1. Lowercase everything. Curly apostrophes become straight.
2. Remove digit formatting:
   - `11:23` → `1123`, `119.1` → `1191`, `29.92` → `2992`. A spoken "point" between number words is dropped the same way, so a frequency or altimeter scores the same in words or digits.
   - A runway written `31L` / `4R` becomes `31 left` / `4 right`.
   - Other letters glued to digits are split: `klm644` → `klm 644`.
3. Punctuation and hyphens become spaces. Apostrophes inside words stay ("you'll" is one token).
4. Drop fillers: uh, um, uhm, er, erm, ah, hmm, mm.
5. Treat these spelling variants as the same, since they're formatting rather than hearing:
   - jet blue = jetblue, speed bird = speedbird, aero mexico = aeromexico, k l m = klm, x ray = xray, call sign = callsign
   - all right = alright, ok = okay, going to = gonna
6. Convert every run of number words or digits to its digits, one token per digit. "eleven twenty-three", "one one two three", "1123", "11 23" and "11:23" all become `1 1 2 3`.
   - "niner" = 9.
   - "oh" / "o" count as 0 only between two numbers ("twelve oh four" = `1 2 0 4`).
   - "one hundred" = `1 0 0`.
   - So writing digits or words never costs a provider anything. Each digit of a callsign, runway or frequency counts as one word, which gives numbers more weight in WER than a spoken-word count would.

The letters-and-digits split and "call sign" were added after seeing provider output (Universal-Streaming English wrote "klm644"). Every candidate was re-scored with the final rules via `--rescore`.

**Word error rate** is corpus-level: total substitutions + deletions + insertions over all 34 lines, divided by the total reference tokens (556 after normalization). A line with no transcript would count as all deleted; none occurred.

**Critical tokens** are hand-annotated per line in `spikes/voice-loop/results/stt/critical-tokens.json`. Each spoken item is in exactly one category:

| Category | What counts | Count in the script |
|---|---|---|
| Callsign | Airline radio name plus flight number of the aircraft addressed ("Delta four", "Qatari seven zero one"). "Heavy" isn't required. Line 31 has none. | 33 |
| Runway | An assigned or crossed runway ("three one left", "cross two two right"), not a hold-short target | 11 |
| Taxiway | Any other taxiway name: route, crossing point, exit ("Alpha", "Kilo Echo", "Kilo") | 35 |
| Hold-short target | The X in "hold short (of) (runway) X", taxiway or runway | 16 |

That's 95 items in total. `stt/critical.ts` pulls items out of the normalized transcript in this order, using each token once:
1. The callsign, as a contiguous match.
2. Hold-short targets, after "hold short [of] [runway]".
3. Runways: 1–2 digits followed by left, right or center.
4. Taxiways: longest match first, so "kilo echo" is one taxiway and never also counts as "kilo".

Accuracy is annotated items found / annotated items, counting repeats: line 26's two "hold short Bravo"s need two in the transcript.
- "Lines with every critical token right" counts lines where every annotated item was found.
- Not scored: turn directions, ATIS letters, frequencies, times and destinations. They appear under error patterns where they matter.
- A self-check runs every time the bench starts: each reference scored against itself must give 0 edits and 100% critical tokens.

### Cost

$/hr at peak uses the § Shortlist prices and the peak assumption: 450 transmissions/hr × 4 s = 30 min of audio/hr.
- **OpenAI and Deepgram** bill audio, so $/hr = 30 min × the per-minute rate (Deepgram: promo and list).
- **AssemblyAI** bills session time. The range runs from one session per transmission (session time = audio time) to one session open all hour. "Measured sessions" scales the low end by the session time AssemblyAI reported divided by audio time:
  - Universal-Streaming English: 241 s for 206.2 s of audio, 1.17×.
  - Universal-3.6 Pro: 260 s, 1.26×. That includes the bench's 1 s late-text window per clip, so without it about 1.10×.

Findings that move these numbers:
- **OpenAI bills each turn in whole seconds, rounded up.** The `usage` field reported 221 s for 206.2 s of audio, +7%. At 4 s transmissions that's about +12%: roughly $0.57/hr for `gpt-live-transcribe` and $0.15/hr for `gpt-transcribe`.
- **AssemblyAI's free tier can't do one session per transmission at peak.** Peak is 450 transmissions/hr, i.e. 7.5 new sessions/min, against a free-tier limit of 5 per minute.
  - Universal-3.6 Pro could instead keep one session open, since `ForceEndpoint` works for it. That costs $0.45/hr. Multi-turn sessions weren't tested here; every clip had a fresh session.
  - Universal-Streaming English can't keep a session open, because its working end-of-turn is `Terminate`.
  - A paid account raises the limit (the docs say it scales automatically).
- Every candidate is under $0.60/hr, far below the $5 soft cap.

**This bake-off's spend:** about $0.24 at list rates. That's $0.227 in `spend-log.jsonl` (probes, the full pass and the Flux re-run) plus about $0.01 of debugging sessions run outside the bench.

### Notes for 0.6

- **Nova-3:** `Finalize` at release; nothing else is needed.
  - Connect takes ~0.3 s. So either open the socket when push-to-talk is pressed, buffering the first audio, or keep a warm connection.
  - Unverified: whether Deepgram bills an idle open connection that sends KeepAlive and no audio.
- **Universal-3.6 Pro:** `ForceEndpoint` at release.
  - Opening a session per transmission takes ~0.4 s and needs a paid account at peak.
  - The alternative is keeping one session open and sending `ForceEndpoint` per transmission. Check that this stays complete and fast across many turns in one session; it wasn't tested here.
- **Live-loop check:** compare each final's last word against the expected command, the same check that caught Flux.
- **Measuring from the browser:** the live loop's push-to-talk clock starts at key release in the browser, so it adds browser-to-server time that this bench doesn't have.

## Interpreter

_Filled in by task 0.4 (interpreter bake-off)._

## Voices

_Task 0.5. Measured 2026-11-14 with `spikes/voice-loop/tts-bench.ts`. API details were checked
against each provider's docs the same day (links under [Sources](#voice-sources)). Raw timings are in
`spikes/voice-loop/results/tts/`. The clips Q listens to are in `spikes/voice-loop/samples/`
(gitignored), with a rating page at `samples/index.html`._

### Results

Time to first audio is measured from sending the request to receiving the first audio bytes, on a
warm connection. Figures are pooled over two runs about 5 minutes apart: 62 requests per provider
(15 timing lines on the primary voice plus 4 lines on each of 4 more voices, per run). The budget
is **0.2 s** (PRD §6.3).

| Provider / model | First audio median | p95 | Within 0.2 s | Usable pilot voices | Rate control | Accents | $/hr at peak | Paraphrase |
|---|---|---|---|---|---|---|---|---|
| ElevenLabs `eleven_flash_v2_5` | **178 ms** | **249 ms** | 84% | 9 on this key (free plan: premade only); 4,289 with a paid plan | **y** (×1.2 → 1.27× faster) | **y** (premade British and Australian now; 14+ accents in the library with a paid plan) | $1.26 | n/a (reads text verbatim) |
| Cartesia `sonic-3.6` | 188 ms | 366 ms | 52% | ≤ 202 (keyword filter, upper bound) | **n** (×1.5 → 1.03×; "guidance" only on 3.6) | **y** (explicit `accent` field; 53 regional-English and 12 foreign-native voices pass the filter) | $1.20–$2.05 | n/a (reads text verbatim) |
| OpenAI `gpt-realtime-2.1-mini` | 458 ms | 738 ms | 0% | 10 (built-in; no metadata) | **y** (×1.3 → 1.53×; playback rate) | **n** (not documented; instruction-based attempt for Q to judge) | $0.78 | 16 of 55 "niner" said as "nine" (13/80 lines); no other changes |

$/hr is from [Cost at peak](#cost-at-peak) (§ Shortlist).

**Per run** (median / p95, n = 31 each):

| Provider | Run A (07:41 UTC, full) | Run B (07:45 UTC, timing only) | Pooled |
|---|---|---|---|
| ElevenLabs | 173 / 225 ms | 191 / 252 ms | 178 / 249 ms |
| Cartesia | 150 / 364 ms | 278 / 369 ms | 188 / 366 ms |
| OpenAI (reasoning effort `none`) | 449 / 932 ms | 469 / 725 ms | 458 / 738 ms |
| OpenAI (default effort, primary voice, n = 15 per run) | 571 / 873 ms | 544 / 830 ms | — |

- **Cartesia is close to bimodal.** Of 62 requests, 32 returned in 125–200 ms, 21 took 300–450
  ms, and 9 fell in between. The slow share (≥ 300 ms) was 9 of 31 in run A and 12 of 31 in run
  B, which is why its median moved from 150 to 278 ms while its p95 held at about 365 ms.
  - It isn't connection setup: no in-stats request opened a new connection in either run. That
    was checked with Node's `undici:client:connected` diagnostics channel. A scratch test showed
    slow responses on reused connections too.
  - The cause is server-side and not identified.
- **ElevenLabs is the steadiest:** 149–410 ms over 62 requests, with one outlier above 260 ms.
- **OpenAI never got under 0.2 s** (min 311 ms).
  - Session setup is separate and not on the critical path in a game, since each flight's session
    can be opened ahead of time: median 368 ms, connect → `session.updated`.
  - `reasoning: {effort: "none"}` was accepted and echoed by the server, and used 0 reasoning
    tokens per line. The default effort used a median of 15–29 reasoning tokens and was about
    100 ms slower.
  - Latency also drifted by time: smoke tests the same morning gave 310–356 ms at effort `none`.

### Method

- **Lines.** 15 pilot readbacks from `test-set/script.md`, chosen to vary:
  - long and short: 02, 05, 06, 07, 08, 11, 16, 19, 21, 22, 24, 25, 30, 31, 33
  - numbers: 06, 22, 24, 33
  - "heavy" callsigns
  - international airlines: Lufthansa, Emirates, Qatari, Speedbird, KLM, Aeromexico
  - initial calls: 30, 31

  The primary voice reads all 15. Four more voices per provider read 05, 06, 24 and 31.
- **One request at a time**, after a warm-up request that isn't counted. Audio is 24 kHz 16-bit
  mono PCM from all three, wrapped as WAV for the page.
  - ElevenLabs: `POST /v1/text-to-speech/{voice}/stream?output_format=pcm_24000` with
    `voice_settings.speed`.
  - Cartesia: `POST /tts/bytes` with `output_format` raw `pcm_s16le`, `generation_config.speed`,
    `Cartesia-Version: 2026-08-14`.
  - OpenAI: Realtime WebSocket with one session per (voice, speed). Each line is an out-of-band
    `response.create` (`conversation: "none"`, the line as the only input item), so lines don't
    build up context.
  - The OpenAI instructions say to read the text exactly, never reply, and use a brisk,
    professional pilot delivery. The full text is in the results JSON (`constants.instructions`).
- **Clock.** For ElevenLabs and Cartesia: from just before `fetch()` to the first non-empty
  body chunk. For OpenAI: from sending `response.create` to the first
  `response.output_audio.delta`. These times include the network round trip from Q's machine.
- **Speaking rate.** Words per minute = words in the line ÷ speech span × 60.
  - Words split on spaces and hyphens, so "twenty-three" is 2 words.
  - The speech span runs from the first to the last 50 ms run of audio within 35 dB of the clip's
    loudest 10 ms frame (and above −50 dBFS). Pauses inside the line count, as on the radio.
  - The same rule is applied to Q's recordings and to the generated clips.
- **Rate control.** The primary voice reads 6 lines (02, 06, 19, 22, 24, 33) at each tested
  speed. The verdict uses the median, over lines, of speech time at ×1 ÷ speech time at the
  fastest setting: **y** if ≥ 1.10, **weak** if 1.03–1.10, **n** below that.
  - The same line at the same setting varies about ±10% between takes (ElevenLabs line 02 at ×1:
    4.95–5.95 s over 3 takes), so smaller effects aren't measurable with 6 lines.
  - The bench picks the tested speed whose median wpm is closest to Q's median.
- **Paraphrasing (OpenAI).** The bench compares the model's own transcript of what it said
  (`response.output_audio_transcript.done`) with the input line. Words are normalized for case,
  punctuation and hyphens, then aligned word by word. This checks the model's transcript, not an
  independent transcription of the audio.

Reproduce:
- Full run: `npm --prefix spikes/voice-loop run tts-bench`. That's about 180 requests, about $0.63
  at list prices, and a few minutes.
- Cheap slice: `-- --provider cartesia --limit 3`.
- Plan and cost estimate only: `-- --dry-run`.
- Rebuild the page without any API calls: `-- --page-only`.

### Speaking rate vs Q's cadence

**Q's controller cadence** (34 recordings in `test-set/audio/`, word counts from the `say` text):
median **165 wpm**, middle half 145–195, pooled 167. Pilots should sound about this fast.

Primary voice at each speed setting (run A, 6 lines each):

| Provider | Speed | Median wpm | Speech-time speedup vs ×1 | vs Q's 165 |
|---|---|---|---|---|
| ElevenLabs Flash v2.5 (Eric) | ×0.9 | 175 | 0.89× | +6% ◀ chosen |
| | ×1 | 198 | 1.00× | +20% |
| | ×1.1 | 211 | 1.04× | +28% |
| | ×1.2 | 251 | 1.27× | +52% |
| ElevenLabs `eleven_v4_turbo` (check, 2 lines) | ×1 / ×1.2 | 163 / 160 | 0.98× | no effect |
| Cartesia sonic-3.6 (Derrick) | ×1 | 147 | 1.00× | −11% |
| | ×1.25 | 148 | 1.00× | −10% ◀ chosen (within noise) |
| | ×1.5 | 147 | 1.03× | −11% |
| Cartesia `sonic-3` (check, 2 lines) | ×1 / ×1.3 | 180 / 227 | 1.15× | works |
| OpenAI realtime (cedar) | ×1 | 134 | 1.00× | −19% |
| | ×1.15 | 178 | 1.27× | +8% ◀ chosen |
| | ×1.3 | 202 | 1.53× | +22% |

**Each voice at its provider's chosen speed** (median wpm over its in-stats lines, run A):

| Provider | Voices |
|---|---|
| ElevenLabs at ×0.9 | Eric 188, Chris 159, Roger 137, Bella 127, Daniel 105 |
| Cartesia at ×1.25 | Derrick 155, Sebastian 153, Wyatt 144, Gary 139, Samantha 137 |
| OpenAI at ×1.15 | cedar 171, marin 166, cedar + German instruction 152, ash 143, echo 138 |

What this means:
- **Natural pace varies more between voices than the speed setting can fix in one global value.**
  - At the same ElevenLabs setting, Eric reads at 188 wpm and Daniel at 105.
  - The game should store a speed per voice. On ElevenLabs that's roughly ×0.9 for Eric, ×1.0
    for Chris, and ×1.1–1.2 for Roger and Bella. Daniel can't reach 165 wpm within the 1.2
    maximum.
- **ElevenLabs:** rate control works, but it isn't linear. ×1.1 barely moved (1.04×) and ×1.2
  jumped (1.27×). The useful range for pilots is about ×0.9–1.2 depending on the voice.
- **Cartesia sonic-3.6: speed is close to inert.**
  - The bench measured ×1.5 → 1.03×. Scratch tests with 2 voices over the full ×0.6–×1.5 range
    gave 1.19× (Derrick) and 1.12× (Samantha) from end to end. The inline SSML tag
    `<speed ratio="1.4"/>` gave about 1.05× (2 takes).
  - Cartesia's docs call speed "guidance, not a strict multiplier", and the changelog says 3.6
    behaves like 3.5. (In April 2026, while 3.5 was in preview, controls were "temporarily
    disabled" and users who need speed were advised to stay on `sonic-3`.)
  - Its voices already run at 137–155 wpm, 6–17% under Q's cadence, and this can't be pushed
    faster on 3.6.
  - The older `sonic-3` does respond (×1.3 → 1.15×) and runs faster by default (about 180 wpm).
    But its takes were erratic in a scratch test: 3.99 s vs 5.83 s for the same line at ×1.
    Q can hear both in the page's Cartesia "Checks".
- **OpenAI:** `speed` works, but OpenAI documents it as a playback-rate change after generation,
  so pitch and timbre may shift. Q should listen to the speed comparison.

### Voices and accents

**Usable "professional pilot" voices.** These are adult English voices that read as calm, clear
and conversational, not character, novelty, child, elderly or high-energy voices. Counts come from
each provider's API metadata and are an upper bound; Q's ear decides.

- **ElevenLabs.**
  - Criteria on labels:
    - language `en`
    - age `young` or `middle_aged`
    - use case `conversational` or `informative_educational`
    - descriptive one of calm, casual, chill, classy, confident, crisp, formal, neutral,
      professional, relaxed, serious, deep, mature, pleasant
  - 9 of the 21 premade voices pass: Bella, Roger, River, Alice, Will, Eric, Chris, Daniel and
    Lily. Those are the only voices this key can use.
  - In the shared Voice Library (`GET /v1/shared-voices`, `total_count`), 4,280 voices pass the
    same filters, out of 12,525 English library voices.
  - **The account is on the free plan.** A TTS request with a library voice returned
    `HTTP 402 Free users cannot use library voices via the API. Please upgrade your subscription
    to use this voice.` The key also lacks `user_read`, so I couldn't read the plan directly.
- **Cartesia.**
  - A keyword filter on tagline + description (the API has no age or use-case fields). A voice
    needs one of: calm, clear, steady, confident, professional, composed, measured, crisp,
    precise, poised, authoritative, reliable, dependable, polished, seasoned, firm, articulate,
    formal, neutral, balanced, relaxed, laid-back, easygoing, conversational, casual.
  - And none of: child, teen, elderly, whisper, ASMR, meditation, character, cartoon, villain,
    Broadway, cheerleader, enthusiastic, energetic, hyped, bubbly, cheerful, playful, sassy,
    sultry, sad, scared, angry, yelling, dramatic, emotive, cute, excited, lively, upbeat (full
    list in `tts/voices.ts`).
  - 202 of 359 English voices pass. The filter is generous: it still admits e.g. "Yogi —
    soothing".
- **OpenAI.** 10 built-in voices (alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin,
  cedar) with no metadata to filter on. OpenAI recommends marin and cedar.

**Accented English** (confirmed through each API; accents are deferred, PRD §6.2):

- **ElevenLabs: yes.**
  - Usable now: premade British (George, Alice, Daniel, Lily) and Australian (Charlie).
  - The library has English voices labelled with these accents (not filtered for pilot
    suitability): British 1,504, Indian 1,177, Australian 393, Nigerian 211, South African 133,
    Irish 103, German 94, Spanish 85, Scottish 60, Arabic 52, French 48, Dutch 30, Swedish 30,
    Italian 20.
  - Examples: Micha Frey — Warm (German); Angus — Calm & Measured (Scottish); Agita — Natural &
    Conversational (Irish).
  - **Foreign accents need a paid plan.**
- **Cartesia: yes, and it's the strongest.**
  - Each voice lists `accents[]` with an `is_native` flag, and the TTS request takes a top-level
    `accent` field, which was accepted (HTTP 200).
  - Usable voices with a native English accent other than US: en-GB 23, en-ZA 9, en-AU 7, en-CA 5,
    en-SG 4, en-IE 2, en-NZ 2, en-IN 1.
  - 12 usable voices are native in another language and speak English, e.g. Sebastian (German),
    Rohan and Sanjay (Hindi), Amélie (French), Paloma (Castilian), Walid (Gulf Arabic),
    Taylan (Turkish).
  - The page has Sebastian with and without `accent: standard-german`, so Q can hear what the
    field does.
- **OpenAI: no.** No accent field or metadata for realtime voices. One preview asks cedar for "a
  light German accent" in the instructions. That's undocumented behavior for Q to judge, not a
  feature.

**Voices on the samples page:**
- ElevenLabs: Eric (primary), Chris, Roger, Bella, Daniel (British).
- Cartesia: Derrick (primary), Wyatt (Southern US, "Dependable Dispatcher"), Samantha, Gary
  (British), Sebastian (German, accent field).
- OpenAI: cedar (primary), marin, ash, echo, cedar + German-accent instruction.

### OpenAI paraphrasing

Across 110 lines over the two runs, **the only change OpenAI ever made was saying "niner" as
"nine".** It never added, dropped or reordered a word.

- **Effort `none`** (main runs, incl. calibration): 16 of 55 "niner" tokens became "nine", in 13
  of 80 lines (16%).
- **Default effort:** 3 of 14 tokens, in 2 of 30 lines (7%).

It depended on the line:
- line 24, "one one niner point one": 8 of 13 changed
- line 06, "two niner niner two": 3 of 13
- line 11, "Alaska niner three": 2 of 2
- line 31, "four zero niner": 0 of 10

"Niner" is standard radio phraseology, so the instructions or a pronunciation workaround would
need to fix this if OpenAI were used. All of this comes from the model's own transcript of its
audio, not an independent transcription.

### What failed or surprised

- **ElevenLabs library voices need a paid plan** (HTTP 402, above). So the bench and samples use
  premade voices only. Variety and foreign accents on ElevenLabs depend on upgrading. The
  shortlist cites Creator at $22/mo, which includes 550K Flash characters.
- **Cartesia sonic-3.6 rate control is close to inert** (above). The shortlist listed
  `generation_config.speed` 0.6–1.5 as rate control, which is true of the API surface but not of
  the effect.
- **Cartesia latency is bimodal and server-side** (above).
- **ElevenLabs v4 Turbo ignores `speed` through the TTS API** (×1.2 → 0.98×, 2 lines), which
  confirms the Agents docs.
- **A bench bug in run A, now fixed.** In each provider's speed comparison, the calibration clip at
  the chosen speed had the same file name as the timing clip for that line, and was overwritten
  (6 clips per provider).
  - Timings and durations were measured before the overwrite, so the stats are unaffected. But in
    run A's JSON, those 18 calibration records' `file` points at the timing take.
  - Calibration clips now go to `<voice>/speed/`. The page fills the 6 gaps per provider with the
    timing take of the same line, voice and speed, labelled as such.
- **Not verified:**
  - Whether sending only `voice_settings.speed` resets each ElevenLabs voice's other stored
    settings (stability, similarity) to API defaults.
  - Whether OpenAI's audio matches its transcript.
  - Whether the WebSocket TTS endpoints of ElevenLabs and Cartesia would be faster or steadier
    than HTTP. Not tested.
- **Spend:** about $1.63 estimated over all bench runs, smoke tests and scratch experiments, at
  list or overage prices.
  - ElevenLabs: about 10,750 characters.
  - Cartesia: about 12,100 characters.
  - OpenAI: about $0.41.

  ElevenLabs and Cartesia usage comes out of plan credits. ElevenLabs gave no quota error, but the
  key can't read the plan, so Q may want to check the ElevenLabs usage page.

### Provisional recommendation for 0.6

**ElevenLabs Flash v2.5**, pending Q's ears:
- It's the steadiest within the 0.2 s budget: median 178 ms, p95 249 ms, 84% of requests within
  0.2 s, and under budget in both runs. (Correction, 2026-11-14: this line first said ElevenLabs
  was the only service under 0.2 s at the median. Cartesia's pooled median, 188 ms, is also
  under; it missed only in run B, at 278 ms, and only 52% of its requests were within 0.2 s.)
- Rate control works, so each voice can be tuned to Q's cadence. Store a speed per voice.
- Accented voices exist.
- The cost: a paid plan is needed for library voices, which means variety beyond the 9 premade
  pilot-suitable voices and any foreign accent.

**Cartesia sonic-3.6 is the fallback.**
- It's the strongest on accents (explicit field, foreign-native voices, regional English).
- Its fast responses are the fastest of the three. But about a third of requests take about 340 ms
  (p95 366 ms), and its voices can't be sped up to Q's cadence on 3.6.
- If Q prefers its voices, 0.6 could try its WebSocket API for steadier latency, or `sonic-3` for
  rate control.

**OpenAI ranks last**, as Q decided: it's 2–4× over the latency budget, says "nine" for "niner"
about a quarter of the time, and has no documented accents.

For 0.6: use ElevenLabs Flash v2.5 over HTTP streaming with a warm keep-alive connection and a
per-voice speed table, and keep Cartesia behind a switch.

### Q's listening verdict

_Q rated the voices on the samples page on 2026-11-14. Table pasted as given._

| Provider | Voice | Naturalness (1–5) | Cadence (1–5) | Sounds like a pilot (y/n) | Notes |
|---|---|---|---|---|---|
| ElevenLabs | Eric | 4 | 4 | n |  |
| ElevenLabs | Chris | 3 | 3 | n |  |
| ElevenLabs | Roger | 3 | 4 | y |  |
| ElevenLabs | Bella | 2 | 3 | n |  |
| ElevenLabs | Daniel | 5 | 4 | y |  |
| Cartesia | Derrick | 5 | 4 | y |  |
| Cartesia | Wyatt | 5 | 3 | n |  |
| Cartesia | Samantha | 3 | 3 | n |  |
| Cartesia | Gary | 5 | 4 | y |  |
| Cartesia | Sebastian | 5 | 5 | y |  |
| OpenAI | cedar | 4 | 4 | n |  |
| OpenAI | marin | 3 | 3 | y |  |
| OpenAI | ash | 2 | 3 | y |  |
| OpenAI | echo | 2 | 2 | n |  |
| OpenAI | cedar + German accent instruction |  |  |  | accent didn't do anything |

Per provider (my arithmetic on Q's table):

| Provider | Mean naturalness | Mean cadence | Sound like a pilot |
|---|---|---|---|
| ElevenLabs (5 voices) | 3.4 | 3.6 | 2 of 5 (Roger, Daniel) |
| Cartesia (5 voices) | **4.6** | **3.8** | **3 of 5** (Derrick, Gary, Sebastian) |
| OpenAI (4 rated voices) | 2.75 | 3.0 | 2 of 4 (marin, ash) |

What it means:
- **Q's ears favour Cartesia.** Its three pilot voices are three of the four best-rated voices.
  Sebastian is the only 5/5. The fourth is ElevenLabs Daniel (5/4, pilot).
- **The measurements favour ElevenLabs.** It's steadier under the 0.2 s budget (84% of requests
  vs Cartesia's 52%), and its rate control works. Cartesia sonic-3.6's speed setting is close to
  inert.
- **Cadence ratings don't follow measured pace.** Daniel measured 105 wpm at ×0.9 and got a 4.
  Sebastian measured 153 wpm and got a 5. Eric measured 188 wpm and got a 4. So per-voice speed
  should be tuned by ear in 0.6, not from wpm alone.
- **OpenAI's accent instruction had no audible effect** (Q). That confirms it has no accent
  support.
- **Not answered:** the page's other questions. Those were whether Cartesia's `accent` field
  changes Sebastian, `sonic-3` vs `sonic-3.6`, and whether OpenAI sounds pitch-shifted when
  sped up. None blocks 0.6.

**Revised recommendation for 0.6:** take both ElevenLabs and Cartesia into the live loop, and
pick on live latency plus Q's ears.
- **Cartesia:** Sebastian, Derrick and Gary. Try its WebSocket API, to see whether the slow
  third of requests goes away.
- **ElevenLabs:** Daniel, plus library voices once the account is on a paid plan. Q is open to
  upgrading (2026-11-14). Starter ($6/mo, 150K Flash characters) is likely enough: ElevenLabs
  says library voices are unavailable through the API to *free* users. No page names Starter
  explicitly.
- **OpenAI:** drop it.

### Raw results

In `spikes/voice-loop/results/tts/`:
- `2026-11-14T07-41-27-060Z-elevenlabs+cartesia+openai.json` and `-summary.txt`: run A, the full
  run the samples page comes from.
- `2026-11-14T07-45-43-577Z-elevenlabs.*`, `2026-11-14T07-46-02-189Z-cartesia.*` and
  `2026-11-14T07-46-32-522Z-openai.*`: run B, timing and voice lines at the chosen speeds. These
  also record the echoed OpenAI reasoning setting and reasoning tokens.

### Voice sources

All read 2026-11-14.

- **ElevenLabs:** [Stream speech](https://elevenlabs.io/docs/api-reference/text-to-speech/stream) ·
  [List voices (v2)](https://elevenlabs.io/docs/api-reference/voices/search) ·
  [Shared voices](https://elevenlabs.io/docs/api-reference/voices/voice-library/get-shared) ·
  [Models](https://elevenlabs.io/docs/overview/models) ·
  [Why can't I use some Voice Library voices](https://elevenlabs.io/docs/help-center/product/voices/voice-library/why-cant-i-use-some-voices-from-the-voice-library/llms.txt) (seen in search results)
- **Cartesia:** [TTS bytes](https://docs.cartesia.ai/api-reference/tts/bytes) ·
  [List voices](https://docs.cartesia.ai/api-reference/voices/list) ·
  [Volume, speed and emotion](https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion.md) ·
  [Changelog 2026](https://docs.cartesia.ai/changelog/2026.md)
- **OpenAI:** [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations) ·
  [Realtime WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket) ·
  [Realtime session reference (`speed`, voices)](https://developers.openai.com/api/reference/resources/realtime/subresources/sessions/methods/create) ·
  [gpt-realtime-2.1-mini](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini) ·
  [gpt-realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1.md) (reasoning effort is configurable; parameter values not documented there)

## Findings

_Filled in by task 0.6 (live end-to-end loop, picks and Q's sign-off)._
