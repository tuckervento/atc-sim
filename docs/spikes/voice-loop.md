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

_Task 0.4. Run 2026-11-14 with `spikes/voice-loop/interp-bench.ts`. API details checked against the claude-api skill, platform.claude.com and developers.openai.com the same day. Raw results (every response, its tokens and timing): `spikes/voice-loop/results/interp/`._

### Results

Each model got a transcript plus a fixed fake game context and returned one command object matching `src/sim/commands.ts`. Two approaches:
- **prompt (A):** the game context (flights on frequency, JFK names, airline names) is in the prompt. One request.
- **tools (B):** only the transcript. The model looks up the flight (`find_flight`) and checks names (`check_names`) with tool calls, then answers.

Four inputs, the same 34 script lines and expected commands in each:
- **perfect:** the script's `say` text
- **Universal-3.6 Pro** and **Nova-3:** 0.3's saved transcripts
- **perturbed:** 12 lines with mishearings, mostly ones 0.3 actually saw (list under [Method](#method))

Three repeats per line. Line 34 (C11) ran but isn't scored, so each input has 33 scored lines (12 for perturbed), and 99 (36) scored samples.

"Median" and "p95" are the time for the whole transcript: every request plus local tool time, on a warm keep-alive connection. The budget is 400 ms (PRD §6.3). **No sample met it: 0 of 1,368 here, and 0 of 276 in the terse experiment.**

| Model | Approach | Input | Exact match | Valid answers | Lines exact on all 3 repeats | Median | p95 | Round trips (mean) | $/hr at peak |
|---|---|---|---|---|---|---|---|---|---|
| Haiku 5.5 | prompt | perfect | 83.8% (83/99) | 96.0% | 27/33 | 1108 ms | 1661 ms | 1.00 | $0.17 |
| Haiku 5.5 | prompt | Universal-3.6 Pro | 80.8% (80/99) | 96.0% | 26/33 | 1099 ms | 1719 ms | 1.00 | $0.17 |
| Haiku 5.5 | prompt | Nova-3 | 89.9% (89/99) | 100% | 29/33 | 1093 ms | 1718 ms | 1.00 | $0.17 |
| Haiku 5.5 | prompt | perturbed | 69.4% (25/36) | 86.1% | 7/12 | 1163 ms | 2357 ms | 1.00 | $0.18 |
| Haiku 5.5 | tools | perfect | 81.8% (81/99) | 85.9% | 23/33 | 2708 ms | 4282 ms | 1.99 | $0.13 |
| Haiku 5.5 | tools | Universal-3.6 Pro | 82.8% (82/99) | 89.9% | 24/33 | 2408 ms | 3583 ms | 2.07 | $0.14 |
| Haiku 5.5 | tools | Nova-3 | 68.7% (68/99) | 76.8% | 19/33 | 2268 ms | 3757 ms | 2.01 | $0.13 |
| Haiku 5.5 | tools | perturbed | 55.6% (20/36) | 58.3% | 5/12 | 2538 ms | 4820 ms | 2.03 | $0.15 |
| **gpt-6-luna** | **prompt** | **perfect** | **97.0% (96/99)** | **100%** | **32/33** | 1242 ms | 1765 ms | 1.00 | $0.10 |
| **gpt-6-luna** | **prompt** | **Universal-3.6 Pro** | **93.9% (93/99)** | **100%** | **31/33** | 1262 ms | 1785 ms | 1.00 | $0.10 |
| **gpt-6-luna** | **prompt** | **Nova-3** | **97.0% (96/99)** | **100%** | **32/33** | 1243 ms | 1944 ms | 1.00 | $0.10 |
| **gpt-6-luna** | **prompt** | **perturbed** | **83.3% (30/36)** | **100%** | **9/12** | 1293 ms | 1865 ms | 1.00 | $0.10 |
| gpt-6-luna | tools | perfect | 96.0% (95/99) | 100% | 31/33 | 2754 ms | 3881 ms | 2.16 | $0.07 |
| gpt-6-luna | tools | Universal-3.6 Pro | 92.9% (92/99) | 100% | 30/33 | 2783 ms | 4444 ms | 2.25 | $0.07 |
| gpt-6-luna | tools | Nova-3 | 87.9% (87/99) | 100% | 27/33 | 2888 ms | 3991 ms | 2.24 | $0.07 |
| gpt-6-luna | tools | perturbed | 80.6% (29/36) | 100% | 9/12 | 2756 ms | 3581 ms | 2.14 | $0.07 |

Haiku 5.5 answers as plain JSON text, because Anthropic rejects this schema for grammar-constrained output (see [What didn't work](#what-didnt-work-as-documented)). gpt-6-luna uses strict structured output. "Valid" is the share that parsed and passed the shape check; an invalid answer is a miss.

**Per field.** Correct / lines where the expected or the model's command has the field, so a missed value and an invented one both count as wrong. An invalid answer is wrong on every expected field.

| Model | Approach | Input | Callsign | Instruction types | Destination | Route taxiways | Turns | Hold-shorts | Crossings | Other values |
|---|---|---|---|---|---|---|---|---|---|---|
| Haiku 5.5 | prompt | perfect | 96.0% (95/99) | 92.9% (92/99) | 84.4% (38/45) | 84.4% (38/45) | 95.8% (23/24) | 85.7% (36/42) | 100% (9/9) | 96.3% (26/27) |
| Haiku 5.5 | prompt | Universal-3.6 Pro | 96.0% (95/99) | 86.9% (86/99) | 86.7% (39/45) | 84.4% (38/45) | 100% (24/24) | 97.4% (38/39) | 100% (9/9) | 88.9% (24/27) |
| Haiku 5.5 | prompt | Nova-3 | 100% (99/99) | 96.0% (95/99) | 86.7% (39/45) | 86.7% (39/45) | 100% (24/24) | 100% (39/39) | 100% (9/9) | 96.3% (26/27) |
| Haiku 5.5 | prompt | perturbed | 86.1% (31/36) | 83.3% (30/36) | 61.9% (13/21) | 66.7% (14/21) | 91.7% (11/12) | 77.8% (14/18) | 100% (9/9) | 50.0% (6/12) |
| Haiku 5.5 | tools | perfect | 85.9% (85/99) | 82.8% (82/99) | 91.1% (41/45) | 91.1% (41/45) | 87.5% (21/24) | 89.7% (35/39) | 77.8% (7/9) | 88.9% (24/27) |
| Haiku 5.5 | tools | Universal-3.6 Pro | 89.9% (89/99) | 86.9% (86/99) | 88.9% (40/45) | 80.0% (36/45) | 79.2% (19/24) | 87.2% (34/39) | 88.9% (8/9) | 92.6% (25/27) |
| Haiku 5.5 | tools | Nova-3 | 76.8% (76/99) | 75.8% (75/99) | 80.0% (36/45) | 75.6% (34/45) | 54.2% (13/24) | 82.1% (32/39) | 100% (9/9) | 71.4% (20/28) |
| Haiku 5.5 | tools | perturbed | 58.3% (21/36) | 55.6% (20/36) | 38.1% (8/21) | 38.1% (8/21) | 41.7% (5/12) | 83.3% (15/18) | 66.7% (6/9) | 33.3% (4/12) |
| gpt-6-luna | prompt | perfect | 100% (99/99) | 97.0% (96/99) | 100% (45/45) | 100% (45/45) | 100% (24/24) | 100% (39/39) | 100% (9/9) | 100% (27/27) |
| gpt-6-luna | prompt | Universal-3.6 Pro | 100% (99/99) | 97.0% (96/99) | 100% (45/45) | 93.3% (42/45) | 87.5% (21/24) | 100% (39/39) | 100% (9/9) | 100% (27/27) |
| gpt-6-luna | prompt | Nova-3 | 100% (99/99) | 100% (99/99) | 100% (45/45) | 100% (45/45) | 87.5% (21/24) | 100% (39/39) | 100% (9/9) | 100% (27/27) |
| gpt-6-luna | prompt | perturbed | 100% (36/36) | 97.2% (35/36) | 100% (21/21) | 81.0% (17/21) | 83.3% (10/12) | 100% (18/18) | 100% (9/9) | 100% (12/12) |
| gpt-6-luna | tools | perfect | 100% (99/99) | 96.0% (95/99) | 100% (45/45) | 100% (45/45) | 100% (24/24) | 100% (39/39) | 100% (9/9) | 100% (27/27) |
| gpt-6-luna | tools | Universal-3.6 Pro | 100% (99/99) | 97.0% (96/99) | 100% (45/45) | 84.4% (38/45) | 96.0% (24/25) | 100% (39/39) | 100% (9/9) | 100% (27/27) |
| gpt-6-luna | tools | Nova-3 | 100% (99/99) | 99.0% (98/99) | 100% (45/45) | 82.2% (37/45) | 84.0% (21/25) | 100% (39/39) | 100% (9/9) | 100% (27/27) |
| gpt-6-luna | tools | perturbed | 100% (36/36) | 97.2% (35/36) | 100% (21/21) | 85.7% (18/21) | 75.0% (9/12) | 94.7% (18/19) | 100% (9/9) | 100% (12/12) |

"Other values" is ATIS letter, altimeter, handoff mode and facility, frequency, delay minutes, ground-stop destination and release time. gpt-6-luna got every one of them right in every row. Haiku's misses there come from invalid answers and from dropping the ATIS instruction (below). The full breakdown is printed by the bench.

**Extra experiment: terse answers.** Not part of the planned matrix. To see whether shorter output cuts latency, the model wrote one line of 1.2's terse syntax (about 15 tokens instead of 60–90 of JSON), which `parseTerse` turns into the same command object. Approach A only, perfect and perturbed, 3 repeats. Results in `results/interp/terse-answer/`, spend $0.08.

| Model | Input | Exact match | Valid | Median | p95 | Output tokens (mean) |
|---|---|---|---|---|---|---|
| Haiku 5.5 | perfect | 72.7% (72/99) | 87.9% | 1209 ms | 1732 ms | 17 |
| Haiku 5.5 | perturbed | 58.3% (21/36) | 77.8% | 1214 ms | 2644 ms | 43 |
| gpt-6-luna | perfect | 83.8% (83/99) | 89.9% | 762 ms | 1203 ms | 14 |
| gpt-6-luna | perturbed | 63.9% (23/36) | 77.8% | 730 ms | 1322 ms | 17 |

- **gpt-6-luna got about 0.5 s faster** without the strict JSON schema, but less accurate. Most of the loss is syntax: `taxi T4 via …` without `ramp`, and `L: A` with a space. This was a first-pass terse prompt; it hasn't been tuned.
- **Haiku 5.5 didn't get faster.** Its latency doesn't depend on output length here (see [Latency](#latency-what-the-time-goes-on)).

### Recommendation for 0.6

**Context in the prompt, not tool calls. Take gpt-6-luna with strict structured output into the live loop.**
- **Prompt beats tools on both models.** Tools never made the answer more accurate, and on Haiku they made it worse. They cost a second (sometimes third) round trip: 2.0–2.25 on average. Each round trip costs the full per-request time, so tools take 2.3–2.9 s at the median against 1.1–1.3 s. This confirms the PRD's lean (§6.1).
- **gpt-6-luna is the more accurate model:**
  - 97.0% exact on perfect text, 93.9% on Universal-3.6 Pro, 97.0% on Nova-3, 83.3% on the perturbed set
  - every answer valid, because the strict schema guarantees the shape
  - every misheard callsign fixed from context (36/36 on the perturbed set)
  - $0.10/hr at peak
  - It's slightly slower than Haiku: median 1.24 s against 1.10 s.
- **Haiku 5.5 is held back by output format, not only content.** Anthropic can't grammar-constrain the full command schema, so Haiku answers as plain JSON:
  - Up to 14% of its prompt answers are invalid (on the perturbed set), and up to 42% in tools mode.
  - With thinking disabled, it often writes a sentence before the JSON.
  - Its content is also weaker: 81–90% exact on the real transcripts.
- **Neither model meets the 0.4 s budget.** The fastest answer in the main matrix took 757 ms, and the fastest anywhere 533 ms (gpt-6-luna, terse experiment). Both models have a fixed cost of about 0.9 s per request (below).
  - With 0.3's speech-to-text (~0.12 s) and 0.5's voice (~0.18 s), a gpt-6-luna median puts the loop at about 1.55 s before scheduling, against the 1.0 s target.
  - 0.6 should measure it live. Q decides whether PRD §6.3's budget changes.

### What didn't work as documented

1. **Anthropic rejects the command schema for structured output.**
   - Both `output_config.format` and a strict tool with the same schema return HTTP 400: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."
   - The schema is within every documented explicit limit: 12 union-typed parameters (limit 16), 0 optional parameters (limit 24), one strict schema.
   - The docs say an internal grammar limit fails with "Schema is too complex for compilation". The message seen was different.
   - What I tried (each 400 is free):
     - Removing the `taxi` or the `correction` branch makes it compile. Removing any one of 8 other branches I tried (cross, handoff, atis, hold-short, ground-stop, release-time, expect-delay) doesn't. Each part compiles alone.
     - No help from removing descriptions, from `$defs`/`$ref` for shared parts, from type arrays instead of `anyOf [X, null]`, or from other encodings of `turn` or the destination name.
     - An empty schema `{}` for the correction's parts is rejected: "Empty schema ({}) that accepts any JSON value is not supported."
     - `{"type": ["string", "null"], "enum": ["left", "right", null]}` is rejected: "Enum value 'left' does not match declared type '['string', 'null']'". `{"enum": ["left", "right", null]}` with no `type` works.
   - gpt-6-luna's strict mode takes the same schema with no problem.
2. **A non-strict tool as the answer channel drops required fields.** I tried a `submit_command` tool, forced with `tool_choice`. Its input schema was the full command, without strict mode. All 3 probe answers left out the root `"type": "transmission"` field, so this route wasn't used. Plain JSON text with the schema in the prompt passed all 3, so Haiku runs that way.
3. **Haiku 5.5 with thinking disabled often explains before answering.** "The controller…", "This is an unknown station, so…", then the JSON. Strict parsing counts these as invalid.
   - It's most common in tools mode: 10–21 answers per input.
   - If the first JSON object in the text had been taken instead, most would have scored. On perfect text in tools mode, 12 of 14 would have been exact.
   - That rescue isn't in the main numbers.
4. **OpenAI's automatic caching did reuse the static prefix.** The prompt-caching guide says that in the default ("implicit") mode, a static developer message followed by a changing user message gets a breakpoint only at the end of the user message, so the prefix isn't reused.
   - Measured: calls 2 and 3 read 3,449 cached tokens, which is the static prefix.
   - Each call also wrote its own changing part (~1,607 tokens) to the cache, at 1.25× the input rate.
   - The bench uses the guide's explicit mode instead (`prompt_cache_options: {mode: "explicit"}` plus a `prompt_cache_breakpoint` on the static block). That caches only the prefix, like Anthropic's single `cache_control` breakpoint. The cost difference is under $0.02/hr.
5. **OpenAI's `input_tokens` includes cached and written tokens.** For example, 5,049 = 1,604 uncached + 3,445 written. Anthropic's `input_tokens` excludes both. The bench converts both providers to the same split.
6. **Effort "none" doesn't make gpt-6-luna fast.** OpenAI's own `openai-processing-ms` header has a median of about 1.14 s per request. The client measured about 1.24 s, so network and HTTP add only ~0.1 s. Each answer is about 60 output tokens.

### Latency: what the time goes on

A straight-line fit of warm request time against output tokens:

| Runner | Requests | Median output tokens | Fixed part | Per output token |
|---|---|---|---|---|
| Haiku 5.5, prompt | 342 | 87 | 933 ms | 2.8 ms |
| Haiku 5.5, tools | 692 | 125 | 849 ms | 3.8 ms |
| gpt-6-luna, prompt (strict JSON) | 342 | 60 | 920 ms | 6.3 ms |
| gpt-6-luna, tools (strict JSON) | 754 | 57 | 940 ms | 7.3 ms |
| gpt-6-luna, prompt, terse (no schema) | 138 | 14 | 658 ms | 12.0 ms |
| Haiku 5.5, prompt, terse | 138 | 17 | 1200 ms | 4.4 ms |

What this says:
- **About 0.85–0.95 s is fixed cost** on both models, before output length matters. Output adds 0.25–0.4 s at the median.
- **Input size isn't the cause, as far as this shows.** Haiku's tools requests carry about 110–660 uncached tokens and its prompt requests about 2,680, and both take about 1.1–1.3 s per request. gpt-6-luna is the same: about 30–300 against 1,610 tokens, both about 1.25 s.
- **For gpt-6-luna, dropping the strict schema cut about 0.26 s of fixed time** (920 to 658 ms). That run also dropped the schema's ~1,500 rendered prompt tokens, so this doesn't separate the grammar from the prompt size. For Haiku, shorter output didn't help.
- **New connections:** each run opened one, on its warm-up request; no sample was cold. A cold first request cost about +0.44 s on gpt-6-luna and nothing measurable on Haiku. 0.6 should keep a warm connection.

### Error patterns

Across both models:
- **"and sit tight" (line 22) becomes an extra instruction.** gpt-6-luna adds `hold`, and Haiku adds `hold` or `hold-for-release`, on almost every sample. In the sim, `hold` would stop the aircraft before it reaches the pad. The expected command has no such instruction; that's worth confirming with Q.
- **"Kilo, Kilo" (line 22) becomes two taxiways, `K K`, not KK.** Universal-3.6 Pro wrote the commas, and both models followed them. The context lists KK, but neither used it. The perturbed set has the same phrasing and failed the same way.
- **Without commas, turns slide onto the previous taxiway.** Line 10 on both speech-to-text inputs: "kilo delta right on bravo left hotel" came back as `R:KD L:B H` instead of `KD R:B L:H`. gpt-6-luna did this on all 3 repeats of both. Haiku tools mode did the same on Nova-3's line 01 ("alpha right on kilo echo" → `R:A KE`). With the script's commas, every model got it right.
- **"red on Alpha" (perturbed line 09):** gpt-6-luna dropped the turn (`via KF A`) in 5 of 6 samples. Haiku's prompt mode read it as right. Everyone read "monitor right" as monitor ramp.

gpt-6-luna:
- In tools mode, "Kilo Delta" was split into two taxiways (`K D`) on Nova-3 line 02 (3 of 3) and on line 06 with both speech-to-text inputs.
- In tools mode, line 12 ("actually, I need you to hold short of three one right") twice became a correction (`neg hs 31R`). That would replace the hold-short list instead of adding to it.
- In tools mode, line 29's corrected route came back as corrected turns (`neg turn L:A R:J hs B`), twice.

Haiku 5.5 (prompt mode):
- **"Alpha, Juliet" (line 04) becomes `A JA` or `A JB`** on every repeat of all three full inputs (tools mode once gave `AJ`). JA and JB are real JFK taxiways (Juliet Alpha, Juliet Bravo) in the names list.
- **"departure runway is three one left, not right" (line 28) becomes `neg hs 31L`**, a hold-short, on all 3 perfect-text repeats, instead of `neg to 31L`. The speech-to-text inputs got it right.
- **"into the ramp" (line 09) becomes `ramp T5`**, the arrival's own terminal, on every repeat. The sim reads both the same way (null means the aircraft's own ramp), but the controller didn't name a terminal, and the prompt says to use null. Scored as a miss.
- **On Universal-3.6 Pro line 06** ("information Papa is current altimeter 2992", with no comma), it dropped the ATIS instruction on all 3 repeats.
- **Shape slips without a grammar:** a correction's `via` as an object instead of a list, an empty correction, and `minutes` that wasn't a whole number.

Context fixes (perturbed set):
- gpt-6-luna resolved every misheard callsign in both approaches:
  - "Delta for" (with DAL40 "Delta forty" also on frequency)
  - "The tons are four zero five" (Lufthansa)
  - "Delta thirty twenty-three forty"
  - "Alaska men are three", "Iberia has six twenty six", "Swiss won seven hui"
  - "Qatary", "Delta twelver for"
- "cross one way three one right" and "old short of Bravo" were read correctly everywhere.
- "stop, stop hold short" (a mishearing of hold position) became `hold` on every prompt-mode sample, from the context "the aircraft ahead has stopped suddenly". gpt-6-luna's tools mode got it 2 of 3 (once `hs K`).

Unscored line 34 (C11, give way, then follow):
- No model said it couldn't do this. gpt-6-luna answered `JBU1123 continue` every time; Haiku answered `hold`, `hs A` or `hs KE`.
- The command format has no "not understood" output, so an unsupported instruction becomes a confident, wrong command.

### Method

**Run:** `npm --prefix spikes/voice-loop run interp-bench` runs every model × approach × input. The two models ran as two parallel processes, with requests one at a time within each.

Flags:
- `--model`, `--approach`, `--input`, `--lines`, `--limit`, `--repeats` (default 3)
- `--rescore` (no API calls), `--misses` (prints every miss), `--resume`
- `--opt` (needs `--out`): `answer=text|tool|format|terse`, `cache=explicit|implicit`
- `--out`, `--max-spend` (default $5)

Code: `interp-bench.ts` and `interp/`. `interp/analyze.ts` prints the latency fit, the tools' lookups and the format-vs-content check.

**Models:**
- `claude-haiku-5-5`: `@anthropic-ai/sdk` 1.3.0, `thinking: {type: "disabled"}`, effort left at its default (medium), `max_tokens` 1024, `maxRetries: 0`. It answers as JSON text, with the command's JSON Schema written into the cached prompt.
- `gpt-6-luna`: Responses API through `fetch`, `reasoning: {effort: "none"}`, `store: false`, `max_output_tokens` 1024, `text.format` json_schema with `strict: true`.

**Schema** (`interp/schema.ts`): it mirrors `commands.ts` field for field, with every field required and null for "not given".
- Two unions are flattened to `{kind, name}` objects that produce the same JSON: destination and hold-short target. That keeps the count under Anthropic's union limit.
- `interp/shape.ts` checks what the schema can't say: name and runway formats, non-empty lists, the correction rules. It also round-trips each answer through `parseTerse`.

**Game context** (`interp/context.ts`). It's the same for every model and input; only the transcript changes.
- **Static part, cached:**
  - the rules
  - JFK's 87 taxiway names from the FAA diagram plus the script's KC, KF and KK, each with its spoken form
  - the 8 runway ends and the terminal ramps T1, T4, T5, T7, T8
  - 25 airline radio names: the script's, with 1.2's codes, plus 8 other JFK operators
- **Live part, after the cache breakpoint:**
  - current ATIS Papa, altimeter 2992; runway configuration
  - 22 flights on frequency: every script flight, plus one decoy, DAL40 "Delta forty"
  - Each flight shows its role, terminal, runway, position, clearance, last pilot transmission and notes (tower approvals, traffic management).
  - The addressed flight's state is as of its line. Correction lines show the issued clearance and the pilot's wrong readback.
  - Line 31 has an "unattributed transmission" instead.
- Approach B gets only the transcript. `find_flight` matches the spoken callsign fuzzily (airline words within a small edit distance, digits through 0.3's normalizer) and returns the flight's full state. `check_names` maps spoken or written names to airport IDs.

**Prompt** (`interp/prompt.ts`):
- It restates the command contract: hold-shorts go in the taxi, one transmission per aircraft, a correction replaces only what it names, and so on.
- It adds Q's lower-bound rule for delay ranges.
- It lists what to leave out: traffic information, sequence, "when you get there", and repeats for emphasis.
- It has three invented examples. They share structure with script lines 01, 18 and 26, and the prompt was written after reading the script. **Expect live accuracy on unseen phrasing to be lower than the perfect-text numbers.** The prompt wasn't tuned after the run.

**Perturbed set** (`interp/inputs.ts`): 12 lines, each one line's `say` text with one or two mishearings:
- 0.3's candidates: "Qatary" (gpt-live-transcribe), "Delta thirty twenty-three forty" (gpt-transcribe), "Alaska men are three", "The tons are", "Iberia has six twenty six", "Swiss won seven hui", "old short", "Delta twelver for" (Flux), "cross one way" (Nova-3 and others), "red on" and "monitor right" (Universal-Streaming English), "Kilo, Kilo" (Universal-3.6 Pro) and "zip type" (Nova-3)
- "stop, stop hold short" (gpt-live-transcribe)
- PLAN's "Delta for"

**Latency:**
- `performance.now()` from just before each request to the parsed response, non-streaming. A tools transcript adds up every request plus local tool time (under 1 ms).
- Connections are Node's built-in fetch with keep-alive. New connections are counted from undici's `undici:client:connected` diagnostics channel.
- One unscored warm-up request per runner and input opens the connection, compiles the schema and writes the cache. Samples where any request opened a new connection would be left out; there were none.
- Order: for each repeat, every line in script order.
- p95 is nearest-rank.

### Scoring

**Expected commands:** the `expected:` rows of `test-set/script.md`, in terse syntax, parsed with `parseTerse`.
- 1.2's draft forms still matched the current `say` text, including the five lines edited after recording.
- Line 32 is `delay 20` (Q: a range scores as its lower bound).
- Line 34 is `UNSCORED (C11 has no command)`.

**One normalization rule**, on both sides: hold-short instructions right after a taxi are folded into that taxi's hold-short list. Hold-shorts after anything else, such as a crossing, stay separate.
- It changed the result on 4 samples, all Haiku tools mode and all line 05: 3 on perfect text and 1 on Nova-3. Haiku had given the two hold-shorts as separate instructions.
- It never changed a gpt-6-luna result.
- Nothing else is normalized. A `ramp T5` for "the ramp" is a miss.

**Exact match:** deep equality after that rule. An answer that isn't pure JSON, or fails the shape check, counts as a miss, and its reason is saved.

**Self-checks at start:** every expected command must pass the shape check and score as exact against itself.

### Cost

$/hr at peak = 450 transmissions/hr × the measured mean cost per transmission, at the § Shortlist prices. Both models cost the same per token: $0.10/M input, $0.01/M cache read, $0.125/M cache write, $0.50/M output.

| Runner | Cached prefix (tokens per request) | Uncached input per transmission | Output per transmission | $/hr measured | $/hr if nothing were cached |
|---|---|---|---|---|---|
| Haiku 5.5, prompt | 5,964 | ~2,680 | ~90 | $0.17 | $0.41 |
| Haiku 5.5, tools | 5,256 | ~630–800 | ~230–275 | $0.13–0.15 | $0.55–0.58 |
| gpt-6-luna, prompt | 3,449 | ~1,610 | ~60 | $0.10 | $0.24 |
| gpt-6-luna, tools | 2,889 | ~330–380 | ~110–120 | $0.07 | $0.32–0.33 |

- **Every prefix is over its provider's minimum** (512 tokens for Haiku 5.5, 1,024 for gpt-6-luna), and every warm request read it from cache.
- **The same live context costs Haiku about 65% more tokens** (2,680 against 1,610): its tokenizer splits text into more tokens.
- **Tools mode is cheaper per hour** because its live context is small, but it's slower and no more accurate.
- **Cache writes** only happened on warm-ups. At 450 transmissions an hour the cache never goes cold (Anthropic's lasts 5 minutes from last use, OpenAI's 30).
- **Every option is far under the $5/hr soft cap.** The § Shortlist estimate ($0.09 cached, $0.22 uncached) assumed a 1,000-token live context. The measured one is 1.6–2.7K tokens.

**This bake-off's spend:** $0.45, from `results/interp/spend-log.jsonl`, estimated from measured tokens at list prices:

| Run | Spend |
|---|---|
| Probes and schema bisect | $0.01 |
| Haiku, prompt | $0.13 |
| Haiku, tools | $0.10 |
| gpt-6-luna, prompt | $0.08 |
| gpt-6-luna, tools | $0.05 |
| Terse experiment | $0.08 |

### Notes for 0.6

- **Use gpt-6-luna, prompt approach, strict `text.format` schema, explicit cache breakpoint.** Reuse `interp/schema.ts`, `interp/context.ts`'s layout and `interp/shape.ts`.
- **Keep one warm keep-alive connection to OpenAI.** A cold first request cost about +0.44 s.
- **Budget about 1.25 s for interpretation, not 0.4 s.** Ways to claw time back, none tried live yet:
  - Answer in terse syntax without the schema: 0.76 s median here, but it needs prompt work and accuracy checks first.
  - Start the readback template from a partial answer.
  - Revise PRD §6.3.
- **The command format needs a "not understood" output.** Line 34 shows the model will otherwise invent a command. PRD §6.1 already wants the pilot to say "say again" when the game can't work out an instruction.
- **Speech-to-text punctuation matters.**
  - Universal-3.6 Pro's commas split "Kilo Kilo" into two Kilos.
  - Missing commas let turns slide onto the previous taxiway.
  - A post-check against the airport graph (an impossible route like A K K, or a turn onto the taxiway you're already on) could catch some of these before the readback. The readback is the player's last chance to catch the rest.
- **If Haiku is ever reconsidered:** Anthropic's grammar can't take the full schema. It would need a smaller per-instruction schema, or lenient JSON extraction plus the shape check.

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
