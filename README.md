# Veil — Privacy-Preserving Browser Vision Agent

A browser extension + server system where an agent **reads your screen locally**, redacts
every sensitive value **on-device** (in structure *and* in pixels), and sends only
anonymized data to the server for LLM reasoning. The server orchestrates actions
(click / fill / scroll) that the extension executes — without ever seeing your actual data.

```
┌────────────────────────────── BROWSER ─────────────────────────────┐      ┌────────────────── SERVER ──────────────────┐
│  content script (per tab)                                          │      │  FastAPI gateway (WebSocket /ws)           │
│   ├ DOM (+shadow/iframes) → element graph w/ stable IDs            │      │    └ Orchestrator (bounded loop, memory)   │
│   ├ regex engine → [EMAIL_1]-style refs; values live ONLY in       │ WSS  │        ├ LLM provider (pluggable)          │
│   │   the page-local PlaceholderMap                                │ ───► │        │ echo | groq | openrouter | vllm    │
│   ├ name masking (heuristic cues, optional DistilBERT NER)         │ ◄─── │        │ streamed plan_delta tokens         │
│   └ action executor (click/fill/scroll/nav + safety gates)         │ plan │        └ action validator (allowlists)     │
│  background service worker                                         │      │  receives ONLY anonymized structure and    │
│   ├ WS session, multi-turn history, first_turn reset               │      │  pre-redacted pixels — never raw values    │
│   ├ ViT screen classifier (Transformers.js/ONNX, wasm)             │      └────────────────────────────────────────────┘
│   ├ screenshot sanitization (OffscreenCanvas): PII blackouts       │
│   └ OFFSCREEN DOCUMENT (hidden DOM page, Chrome MV3):              │
│       BlazeFace face detection (tiled, CPU/GPU) +                  │
│       tesseract.js OCR — models that cannot run in a SW            │
└────────────────────────────────────────────────────────────────────┘
```

**The key mechanism:** when the server decides `{"type":"fill","target":15,"ref":"[EMAIL_1]"}`,
the real value is resolved from a map held *only* inside the page's content script. The email
never exists outside the machine, yet multi-step workflows still complete.

## Privacy & perception pipeline (on-device layers + server-side guard)

| Layer | What it does | Where | Cost |
|---|---|---|---|
| 1 · Structural regex | emails, phones (+digit-count validation), cards (**Luhn-verified**), SSN/Aadhaar/IBAN, API keys, account numbers — in field names, values, titles | content script | ~1–3 ms |
| 2 · Entity masking | person-name runs via greeting cues; optional DistilBERT NER toggle (`AI name detection`) | background / offscreen | <1 ms – ~300 ms |
| 3 · ViT screen understanding | Xenova/vit-base-patch16-224 (Transformers.js, wasm-only after WebGPU hangs) classifies each frame for the planner; hard watchdogs: 90 s load / 45 s inference → graceful skip, never stalls a task | background | 0.6–3 s warm |
| 4 · Pixel redaction (vision-first) | **BlazeFace reads the RAW frame before anything else** and its detections decide extra redaction regions — catching faces inside `<img>/<canvas>/<video>` DOM cannot see. Tiled pass (frame + four overlapping 60% tiles → NMS merge) catches small grid portraits; element rects → black boxes, faces → blur/black; WebP q0.72 | offscreen document (MediaPipe), compositing in SW | ~0.2–1 s |
| 5 · OCR text masking (opt-in) | tesseract.js recognizes text rendered into images/canvas that DOM extraction can never see; sensitive-pattern words blacked out. Fully self-hosted assets (worker + wasm core + eng traineddata in the extension) — CSP-clean and offline-capable | offscreen document | first init ~10 s, then ~1 s/frame |
| 6 · Prompt-injection guard | instruction-override / role-hijack / placeholder-exfiltration patterns + zero-width steganography → `[INJECTION_BLOCKED]`; flagged in popup log & plan thought | client `lib/security` **and** mirrored server-side (`app/security/injection.py`) before any LLM sees the payload | <1 ms |

Sensitive-value detection also uses form semantics: `type=password`, `autocomplete`
tokens (email/tel/name/cc-*), and label context hints — so fields are masked even before
regex would fire. The LLM system prompt declares all page text untrusted data and forbids
acting on embedded instructions or repeating anything behind a ref.

> **Why an offscreen document?** MV3 service workers cannot `importScripts()` after
> installation (blocks MediaPipe's wasm loader) and hidden documents defer DOM image
> decoding (blocks `<img>` pipelines). The offscreen page is Chrome's sanctioned escape
> hatch: full DOM APIs, message-wired to the worker. Firefox has no such restriction —
> its background *page* runs the fallbacks directly.

## Repository layout

```
apps/
  extension/               WXT — one codebase → Chrome MV3 + Firefox
    entrypoints/
      background.ts        agent loop, vision orchestration, settings, WS client wiring
      content.ts           per-page extractor + executor bridge (PlaceholderMap lives here)
      popup/               React + Tailwind dashboard (toggles, stats, live log, timings,
                           streaming "thinking" card, server URL + auth token fields)
      offscreen/           hidden DOM page: MediaPipe face detection + tesseract.js OCR
    lib/
      perception/          DOM→element-graph extractor (+ sensitive-rect collection),
                           shadow-DOM & same-origin iframe traversal
      privacy/             regex engine, PlaceholderMap, entity masking, ML NER wrapper
      security/            prompt-injection guard (pattern scrub + element flagging)
      vision/              screen-classifier (ViT), face-detector, ocr, offscreen-bridge,
                           screenshot redact/export pipeline
      executor/            action runner with safety gates
      geometry/            IoU utilities (redaction scoring)
      ws-client.ts         reconnecting socket w/ seq correlation, keepalive, plan_delta,
                           optional ?token= auth
   models/, tasks-vision/, tesseract/   self-hosted on-device model assets (public/)
  server/                  FastAPI app
    app/gateway/ws.py      WebSocket endpoint: sessions, origin check, optional token gate
                           (?token= → close 4001), sliding-window rate limiter (close 4008)
    app/agent/             orchestrator — bounded loop, multi-turn memory, first_turn reset
    app/llm/               provider registry: echo | groq | openrouter | vllm
                           (OpenAI-compatible wire; SSE streaming; image parts for VLMs;
                           in-stream error + safety-refusal detection with retries)
    app/security/          action validator (unknown targets/refs rejected server-side too)
                           + injection guard (mirrors client scrubbing before LLM)
    app/protocol/models.py pydantic mirror of the Zod contracts
    tests/                 protocol round-trip, validator suite, golden multi-page tasks
packages/shared-schema/    Zod contracts — single source of truth
demo/                      login.html, dashboard.html, transfer.html, confirmation.html,
                           faces.html (face-blur gallery)
eval/                      layout corpus + latency probe (plan_delta-aware)
infra/                     docker-compose deployment
```

## Quickstart

### 1. Server

```powershell
npm run server:install          # creates apps/server/.venv and installs deps
npm run server:dev              # uvicorn on ws://localhost:8765/ws
# verify:
curl http://localhost:8765/health
```

### 2. Extension

```powershell
npm install                     # workspace install (extension + shared schema)
npm run dev:ext                 # WXT dev build with HMR → .output/chrome-mv3
# production build:
npm run build:ext               # Chrome
npx wxt build -b firefox        # Firefox (run inside apps/extension)
```

Load into Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `apps/extension/.output/chrome-mv3`

Firefox: load `.output/firefox-mv2` via `about:debugging` → **Load Temporary Add-on**.

### 3. Run tasks end-to-end

1. Start the server (`npm run server:dev`) and configure a planner (see below)
2. **Multi-page transfer** — open `demo/dashboard.html`, task:
   `Send 500 to Rahul Sharma`
   → the agent clicks *Transfer Money*, fills recipient via `[PERSON_NAME_1]` +
   amount `500`, submits, detects the confirmation page, and reports done
   (~30 s end-to-end on a free-tier cloud model).
3. **Login with refs** — open `demo/login.html`, click **Fill demo data**, task:
   `Log in to my account` — the plan references `[EMAIL_1]/[PASSWORD_1]`; the raw
   values never leave the machine.
4. **Face privacy** — open `demo/faces.html` (needs internet for the photos),
   any task: the vision line reports `N face(s) blurred` — and the server's own
   thought confirms it *sees* blurred faces in the sanitized image.
5. Watch every stage live in the popup log: redact / ner / vision / ocr / vit /
   plan / execute, with timings and the streaming "thinking" card.

### Popup controls

| Toggle | Effect |
|---|---|
| Sanitized screenshot | enables pixel redaction + sends the cleaned image |
| Blur faces (vs blackout) | face regions blurred instead of solid black |
| AI name detection | DistilBERT NER pass over text values (model downloads once) |
| OCR text masking | scans text baked into images/canvas; opt-in, assets self-hosted |
| Server URL / auth token | footer fields — point at any backend, shared gateway secret |

## Tests & metrics

```powershell
npm run test:ext                # vitest: PII precision/recall corpus + IoU geometry
npm run test:server             # pytest: WS protocol, echo planner, validator, golden tasks, stats
npm run test                    # both
```

### Latency evidence

With the server running:

```powershell
apps\server\.venv\Scripts\python eval\latency_probe.py --runs 20 --check
curl http://localhost:8765/stats        # rolling p50/p95 per provider, failure count
```

The probe replays a synthetic login screen N times over WebSocket and prints
client round-trip vs server planner percentiles; `--check` exits non-zero when the
p50 exceeds the 3.5 s budget. The extension popup mirrors this live with a
**latency budget** panel (extract / redact / vision / capture / server-rtt bars
against their targets).

Current status against SIH criteria:

| Metric | Target | Current |
|---|---|---|
| Visual context accuracy (M1) | qualitative+quantitative | DOM graph (incl. shadow/iframes) + ViT frame classification + sanitized screenshot region; vision-first redaction decisions |
| PII detection precision / recall (M2) | ≥85% / ≥90% | **100% / 100%** — 21-sample text corpus + 8 labeled screen layouts |
| Precision of redaction (M3) | box-level IoU | **P=100%, R=100%, matched-IoU=1.000** across `eval/fixtures/layouts.json` (incl. decoy labels); greedy IoU@0.5 matching in vitest |
| Client package size / runtime (M4) | minimal | on-device models are lazy per feature; redaction <1 ms; ViT warm 0.6–3 s, faces ~0.2 s/frame, OCR ~1 s/frame. Trade-off note: Transformers.js bundling puts `background.js` at ~63 MB disk — a documented cost of full offline capability (RAM footprint stays modest; offscreen-document split is the slimming path) |
| E2E demo latency (M5) | p50 ≤3.5 s | echo planner: p50 ≈ 1 ms (probe PASS); real demos 7–30 s dominated by cloud LLM turns (~1 s/plan on free Nemotron) — budget panel shows both |

Golden tasks (`apps/server/tests/test_golden_tasks.py`) lock plan quality end-to-end:
login fill→fill→click→done, signup multi-field mapping, the multi-page transfer flow
(dashboard click → refs+amount fills+submit, *no* premature done until confirmation),
`first_turn` memory reset, prompt-injection resilience (plan unaffected + guard note),
and validator rejection of rogue provider output.

## Switching to a real LLM

The provider abstraction reads env vars (copy `.env.example` → `.env`):

```env
LLM_PROVIDER=groq
LLM_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
LLM_API_KEY=gsk_...
```

- `echo` — deterministic heuristic planner, fully offline; drives the multi-page
  demo flow (dashboard→transfer→confirmation) and CI without any keys.
- `groq` / `openrouter` — cloud-hosted open-weight models during SIH. VLM models receive
  the sanitized screenshot as an image part; text-only models just get the structure.
  **Pin a concrete model** — rotating pools (`openrouter/free`) randomly serve tiny
  over-censored models that break JSON plans; e.g. `nvidia/nemotron-3-super-120b-a12b:free`.
  The provider also auto-retries in-stream SSE errors and safety-refusal verdicts
  (`User Safety: unsafe …`) with plain completions before surfacing a clear error.
- `vllm` — self-hosted production path (same OpenAI-compatible contract).

The system prompt explicitly tells the model that boxed/blurred regions are redacted and
must never be guessed or reconstructed.

## Deployment

`infra/docker-compose.yml` ships the gateway as a container:

```powershell
docker compose -f infra/docker-compose.yml up --build          # echo provider
LLM_PROVIDER=groq LLM_MODEL=... LLM_API_KEY=... \              # cloud planner
  docker compose -f infra/docker-compose.yml up
docker compose -f infra/docker-compose.yml --profile vllm up   # + local vLLM planner (GPU)
```

With the `vllm` profile, point the gateway at it via
`LLM_PROVIDER=vllm LLM_MODEL=local-planner LLM_BASE_URL=http://vllm:8000/v1`.
The demo page mounts at `/demo`, health at `/health`, rolling latency stats at `/stats`.

### Securing the gateway (production)

- **Auth token** — set `WS_AUTH_TOKEN=<secret>` on the server; connections without a
  matching `?token=` are closed `4001`. Enter the same token in the popup
  ("auth token: none → configure"). Leave it empty in local dev to disable the gate.
- **Rate limiting** — per-connection sliding window (`RATE_LIMIT_MSGS` per
  `RATE_LIMIT_WINDOW_S`, default 60/10s); floods are closed with `4008`.
- **TLS / WSS** — terminate TLS at your reverse proxy, or run uvicorn with
  `--ssl-keyfile/--ssl-certfile` (mkcert for dev) and switch the popup URL to `wss://…`.

## Protocol

Client → server frames: `hello {caps}`, `perception {task, screen, timings, first_turn}`,
`action_result`. Server → client frames: `welcome {provider, model}`,
`plan_delta {seq, delta}` (streamed thought tokens), `plan {thought, actions[], model}`,
`error {code, message}`.

`first_turn: true` marks the first perception of a new task on a persistent connection —
the orchestrator clears its multi-turn memory so recycled element ids from a previous
task can never be skipped or replayed. Providers receive a compact history
(last turns' page titles + action types) enabling multi-page flows:
dashboard → transfer form (refs + amount literal) → confirmation → done.

`screen.elements[i] = {id, role, tag, name, value, editable, rect, in_viewport, attributes}` —
sensitive values become `{kind:"redacted", ref:"[KIND_n]", pii}` and `pii_refs` enumerates
what's available this frame. Images travel as `image_regions[{ref, mime, width, height,
data_b64}]` — pre-redacted, always. Contracts: `packages/shared-schema/src/index.ts`
(mirrored in `app/protocol/models.py`).

Server-side defense-in-depth: the action validator rejects clicks/fills targeting elements
not present on screen, fills referencing unknown placeholders, non-http navigation, and
plans exceeding the action cap.

## Roadmap

- [x] Phase 0 — monorepo, shared contracts, echo round-trip
- [x] Phase 1 — extractor, executor, popup dashboard, WS loop
- [x] Phase 2 — privacy engine hardening + eval harness v1 (vitest P/R + IoU suites)
- [x] Phase 3 — vision layer: screenshot capture, pixel blackouts, BlazeFace blur, VLM images
- [x] Phase 4b — prompt-injection guards (client + server + system prompt), golden-task suite
- [x] Phase 5 — latency probe + /stats endpoint, popup budget panel, golden-task QA
- [x] Phase 6 — docker-compose deploy (gateway image + optional vLLM profile); store builds
      and pitch deck remain for submission week
- [x] Phase 7 — ML perception (Transformers.js ViT screen classifier + DistilBERT NER),
      shadow-DOM/same-origin iframe traversal, PlaceholderMap persistence across pages,
      multi-page golden flows (dashboard→transfer→confirmation), multi-turn orchestrator
      memory with `first_turn` reset
- [x] Phase 8 — OCR text masking (tesseract.js, opt-in toggle, self-hosted worker/wasm/lang
      assets in-extension → CSP-clean + offline), WS auth token + rate limiter + WSS docs,
      streaming `plan_delta` thought frames end-to-end (provider SSE → gateway → popup
      "thinking" card), account-number & address field detection, greeting-cue name masking
      (eval: P=100% R=100% IoU=1.000 over 8 layouts)
- [x] Phase 9 — offscreen-document architecture for DOM-dependent models (MediaPipe faces
      + tesseract OCR) with watchdog timeouts at every hop; tiled face detection
      (frame + 4 overlapping tiles → NMS) for small portraits; ViT wasm-only with
      load/inference watchdogs; MV3 CSP `wasm-unsafe-eval`; content-script auto-reinjection
      across navigations; live-verified end-to-end: multi-page transfer (~30 s), ref-based
      login (~20 s), face gallery (10/10 faces blurred @ ~230 ms), OCR masking of
      in-image PII
