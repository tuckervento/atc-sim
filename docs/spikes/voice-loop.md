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
| Deepgram Nova-3 (monolingual) | Yes. WebSocket `/v1/listen`. | Keyterm prompting: up to 500 tokens, can change mid-stream | Finalize message (not checked in 0.1; 0.3 verifies) | $0.0048/min promo (list $0.0077) + keyterms $0.0013/min | **$0.18** promo / $0.27 list | The pricing page marks the STT rates as promo pricing. |
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

_Filled in by task 0.3 (speech-to-text bake-off)._

## Interpreter

_Filled in by task 0.4 (interpreter bake-off)._

## Voices

_Filled in by task 0.5 (voice bake-off and Q's listening verdict)._

## Findings

_Filled in by task 0.6 (live end-to-end loop, picks and Q's sign-off)._
