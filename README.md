# Veil — Privacy-Preserving Browser Vision Agent

A browser extension + server system where an agent **reads your screen locally**, redacts
every sensitive value **on-device**, and sends only anonymized structure to the server for
LLM reasoning. The server orchestrates actions (click / fill / scroll) that the extension
executes — without ever seeing your actual data.

```
┌──────────────── BROWSER ────────────────┐        ┌──────────────── SERVER ────────────────┐
│  content script                         │        │  FastAPI gateway (WebSocket)           │
│   ├ DOM → element graph (a11y signals)  │  WSS   │    └ Orchestrator (agent loop)         │
│   ├ PII scan → placeholder refs         │ ────►  │        ├ LLM provider (pluggable)      │
│   └ action executor (click/fill/scroll) │ ◄────  │        └ action validator              │
│  background: WS session, timing marks   │ plan   │  values NEVER received, only [EMAIL_1] │
└─────────────────────────────────────────┘        └────────────────────────────────────────┘
```

**The key mechanism:** when the server decides `{"fill": 15, "ref": "[EMAIL_1]"}`, the real
value is resolved from a map held *only* inside the page's content script. The email never
exists outside the machine, yet multi-step workflows still complete.

## Repository layout

```
apps/
  extension/          WXT (Chrome MV3 + Firefox) — React + Tailwind popup
    entrypoints/      background (WS client), content (extractor+executor), popup UI
    lib/perception/   DOM→element-graph extractor
    lib/privacy/      PII regex engine + PlaceholderMap
    lib/executor/     action runner with safety gates
  server/             FastAPI app
    app/gateway/      WebSocket endpoint, session handling
    app/agent/        orchestrator
    app/llm/          provider registry: echo | groq | openrouter | vllm
    app/security/     action validator (target/ref whitelisting)
    tests/            protocol + validator test suite
packages/shared-schema/  Zod contracts (single source of truth, mirrored in pydantic)
demo/login.html       fake bank sign-in page seeded with fictional PII
eval/                 metric harness (PII precision/recall, IoU, latency) — Phase 2
infra/                docker-compose deployment — Phase 6
```

## Quickstart

### 1. Server

```powershell
npm run server:install          # creates apps/server/.venv and installs deps
npm run server:dev              # uvicorn on ws://localhost:8765/ws
# verify:
curl http://localhost:8765/health
```

Tests:

```powershell
npm run test:server
```

### 2. Extension

```powershell
npm install                     # workspace install (extension + shared schema)
npm run dev:ext                 # WXT dev build with HMR → .output/chrome-mv3
```

Load into Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `apps/extension/.output/chrome-mv3`

Firefox: `npx wxt -b firefox` then load `.output/firefox-mv2` via `about:debugging`.

### 3. Run a task end-to-end

1. Start the server (`npm run server:dev`)
2. Open `http://localhost:8765/demo/login.html` — a fake banking sign-in
3. Click **Fill demo data** on the page (inserts fictional email/password)
4. Click the **Veil** toolbar icon, type `Log in to my account`, press **Run task**
5. Watch the pipeline live in the popup: extraction timings, "N sensitive values masked",
   server thought, executed actions, wall-clock total.

The server log/popup will show fills referencing `[EMAIL_1]` / `[PASSWORD_1]` — proof the
raw values stayed local while the workflow completed.

## Switching to a real LLM

The provider abstraction reads one env var (copy `.env.example` → `.env`):

```env
LLM_PROVIDER=groq
LLM_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
LLM_API_KEY=gsk_...
```

`echo` mode runs a deterministic heuristic planner offline — useful for demos without keys
and for CI. Groq/OpenRouter give cloud open-weight inference during SIH; `vllm` preset is
the self-hosted production path.

## Protocol

Client → server frames: `hello`, `perception {task, screen, timings}`, `action_result`.
Server → client frames: `welcome`, `plan {thought, actions[], model}`, `error`.

`screen.elements[i] = {id, role, name, value, editable, rect, attributes}` where sensitive
values are `{kind:"redacted", ref:"[KIND_n]", pii}` and `pii_refs` enumerates what's
available this frame. Contracts: `packages/shared-schema/src/index.ts`.

## Roadmap

- [x] Phase 0 — monorepo, shared contracts, echo round-trip
- [x] Phase 1 — extractor, executor, popup dashboard, WS loop
- [ ] Phase 2 — privacy engine hardening (NER model via transformers.js), eval harness v1
- [ ] Phase 3 — vision layer: screenshot capture + WebGPU face/UI detection, pixel redaction
- [ ] Phase 4 — LLM planner tuning, prompt-injection guards, Firefox QA
- [ ] Phase 5 — perf instrumentation dashboard, latency budget tuning
- [ ] Phase 6 — docker-compose deploy (vLLM path), store builds, docs/pitch
