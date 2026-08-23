# Veil — Privacy-Preserving Browser Vision Agent

A browser extension + server system where an agent **reads your screen locally**, redacts
every sensitive value **on-device** (in structure *and* in pixels), and sends only
anonymized data to the server for LLM reasoning. The server orchestrates actions
(click / fill / scroll) that the extension executes — without ever seeing your actual data.

```
┌────────────────────────── BROWSER ──────────────────────────┐      ┌──────────────────── SERVER ────────────────────┐
│  content script (per tab)                                   │      │  FastAPI gateway (WebSocket /ws)               │
│   ├ DOM → element graph (roles, names, rects, stable IDs)   │      │    └ Orchestrator (bounded ReAct-style loop)   │
│   ├ Layer 1 · regex engine → [EMAIL_1]-style placeholder    │ WSS  │        ├ LLM provider (pluggable)              │
│   │   refs; values stay in a local PlaceholderMap           │ ───► │        │  echo | groq | openrouter | vllm       │
│   ├ Layer 2 · name/entity masking (heuristic NER)           │ ◄─── │        └ action validator (target/ref allowlist)│
│   └ action executor (click/fill/scroll/nav + safety gates)  │ plan │  receives ONLY anonymized structure + already- │
│  background service worker                                  │      │  redacted pixels — never raw values            │
│   ├ WS session, seq-correlated request/response             │      └────────────────────────────────────────────────┘
│   ├ Layer 3 · screenshot sanitization (OffscreenCanvas):    │
│   │   captureVisibleTab → PII rects blacked out →           │
│   │   BlazeFace detection → faces blurred/blackened → WebP  │
│   └ timing marks for every pipeline stage                   │
└─────────────────────────────────────────────────────────────┘
```

**The key mechanism:** when the server decides `{"type":"fill","target":15,"ref":"[EMAIL_1]"}`,
the real value is resolved from a map held *only* inside the page's content script. The email
never exists outside the machine, yet multi-step workflows still complete.

## Privacy pipeline (3 layers on-device + server-side guard)

| Layer | What it masks | Where | Cost |
|---|---|---|---|
| 1 · Structural regex | emails, phones (+digit-count validation), cards (**Luhn-verified**), SSN/Aadhaar/IBAN, API keys — in field names, values, titles | content script | ~1–3 ms |
| 2 · Entity masking | person-name runs in text values (`[PERSON_NAME_101]…`) | background | <1 ms |
| 3 · Pixel redaction | element rects → black boxes; faces → blur (or black); exported WebP q0.72 | background OffscreenCanvas + BlazeFace (230 KB model, GPU→CPU fallback) | ~30–80 ms |
| 4 · Prompt-injection guard | instruction-override / role-hijack / placeholder-exfiltration patterns + zero-width steganography → `[INJECTION_BLOCKED]`; flagged in popup log & plan thought | client `lib/security` **and** mirrored server-side (`app/security/injection.py`) before any LLM sees the payload | <1 ms |

Sensitive-value detection also uses form semantics: `type=password`, `autocomplete`
tokens (email/tel/name/cc-*), and label context hints — so fields are masked even before
regex would fire.

The LLM system prompt additionally declares all page text untrusted data and forbids
acting on embedded instructions or repeating anything behind a ref.

## Repository layout

```
apps/
  extension/               WXT — one codebase → Chrome MV3 + Firefox (~12 MB total)
    entrypoints/
      background.ts        agent loop, vision pipeline, settings, WS client wiring
      content.ts           per-page extractor + executor bridge
      popup/               React + Tailwind dashboard (toggles, stats, live log, timings)
    lib/
      perception/          DOM→element-graph extractor (+ sensitive-rect collection)
      privacy/             regex engine, PlaceholderMap, entity masking
      security/            prompt-injection guard (pattern scrub + element flagging)
      vision/              BlazeFace detector + screenshot redact/export pipeline
      executor/            action runner with safety gates
      geometry/            IoU utilities (redaction scoring)
      ws-client.ts         reconnecting socket w/ seq correlation + keepalive
      __tests__/           vitest suites (PII precision/recall corpus, IoU)
  server/                  FastAPI app
    app/gateway/ws.py      WebSocket endpoint, session handling, origin check
    app/agent/             orchestrator
    app/llm/               provider registry: echo | groq | openrouter | vllm
                           (OpenAI-compatible wire format incl. image parts for VLMs)
    app/security/          action validator (unknown targets/refs rejected server-side too)
                           + injection guard (mirrors client scrubbing before LLM)
    app/protocol/models.py pydantic mirror of the Zod contracts
    tests/                 protocol round-trip + validator suite (pytest)
packages/shared-schema/    Zod contracts — single source of truth
demo/login.html            fake bank sign-in seeded with fictional PII
eval/                      benchmark pages + metric runners (growing)
infra/                     docker-compose deployment — Phase 6
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

### 3. Run a task end-to-end

1. Start the server (`npm run server:dev`)
2. Open `http://localhost:8765/demo/login.html` — a fake banking sign-in
3. Click **Fill demo data** on the page (inserts fictional email/password)
4. Click the **Veil** toolbar icon, type `Log in to my account`, press **Run task**
5. Watch the pipeline live in the popup: extraction/redact/capture/vision timings,
   "N sensitive values masked", "faces blurred", sanitized-screenshot size, server
   thought, executed actions, wall-clock total.

The log shows fills referencing `[EMAIL_1]` / `[PASSWORD_1]` — proof the raw values stayed
local while the workflow completed.

### Popup controls

| Toggle | Effect |
|---|---|
| Sanitized screenshot | enables Layer-3 pixel redaction + sends the cleaned image |
| Blur faces (vs blackout) | face regions blurred instead of solid black |
| AI name detection | Layer-2 entity masking pass |
| Server URL | click the footer to point at any backend |

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
| PII detection precision / recall | ≥85% / ≥90% | **100% / 100%** (21-sample seed corpus — grows each phase) |
| Client package size | minimal | 12.1 MB total; content script **12 kB**, background **208 kB** (rest is lazily-loaded face-detection wasm) |
| E2E demo latency | p50 ≤3.5 s | **p50 = 3 ms** client round-trip on echo (probe: 20/20 runs PASS); live per-stage budget bars in popup |

Golden tasks (`apps/server/tests/test_golden_tasks.py`) lock plan quality end-to-end:
login fill→fill→click→done, signup multi-field mapping, prompt-injection resilience
(plan unaffected + guard note), and validator rejection of rogue provider output.

## Switching to a real LLM

The provider abstraction reads env vars (copy `.env.example` → `.env`):

```env
LLM_PROVIDER=groq
LLM_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
LLM_API_KEY=gsk_...
```

- `echo` — deterministic heuristic planner, fully offline; maps known `[REF]`s onto
  matching empty fields by label keywords, then clicks submit-like buttons. Great for
  demos without keys and for CI.
- `groq` / `openrouter` — cloud-hosted open-weight models during SIH. VLM models receive
  the sanitized screenshot as an image part; text-only models just get the structure.
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

## Protocol

Client → server frames: `hello {caps}`, `perception {task, screen, timings}`,
`action_result`. Server → client frames: `welcome {provider, model}`,
`plan {thought, actions[], model}`, `error {code, message}`.

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
      (transformer NER via offscreen document deferred — WXT IIFE entrypoint bundling
      blocks lazy model chunks today)
- [x] Phase 5 — latency probe + /stats endpoint, popup budget panel
- [x] Phase 6 — docker-compose deploy (gateway image + optional vLLM profile); store builds
      and pitch deck remain for submission week
