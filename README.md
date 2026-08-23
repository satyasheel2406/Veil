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

## Privacy pipeline (3 layers, all on-device)

| Layer | What it masks | Where | Cost |
|---|---|---|---|
| 1 · Structural regex | emails, phones (+digit-count validation), cards (**Luhn-verified**), SSN/Aadhaar/IBAN, API keys — in field names, values, titles | content script | ~1–3 ms |
| 2 · Entity masking | person-name runs in text values (`[PERSON_NAME_101]…`) | background | <1 ms |
| 3 · Pixel redaction | element rects → black boxes; faces → blur (or black); exported WebP q0.72 | background OffscreenCanvas + BlazeFace (230 KB model, GPU→CPU fallback) | ~30–80 ms |

Sensitive-value detection also uses form semantics: `type=password`, `autocomplete`
tokens (email/tel/name/cc-*), and label context hints — so fields are masked even before
regex would fire.

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
npm run test:server             # pytest: WS protocol, echo planner, validator rules
npm run test                    # both
```

Current status against SIH criteria:

| Metric | Target | Current |
|---|---|---|
| PII detection precision / recall | ≥85% / ≥90% | **100% / 100%** (21-sample seed corpus — grows each phase) |
| Client package size | minimal | 12.09 MB total; content script **12 kB**, background **207 kB** (rest is lazily-loaded face-detection wasm) |
| E2E demo latency | p50 ≤3.5 s | measured live per-stage in popup overlay |

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
- [ ] Phase 4 — transformer-based NER via offscreen document (WXT IIFE entrypoint bundling
      blocks lazy model chunks today), prompt-injection guards, golden-task scripts
- [ ] Phase 5 — perf instrumentation dashboard, latency budget tuning vs p50 target
- [ ] Phase 6 — docker-compose deploy (vLLM path), store builds, docs/pitch
