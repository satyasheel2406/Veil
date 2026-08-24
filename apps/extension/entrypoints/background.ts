import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { AgentAction, PlanMsg, ScreenContext, Timings } from "@pv/schema";
import { AgentSocket, DEFAULT_SERVER_URL, type SocketStatus } from "@/lib/ws-client";
import { redactScreenshot, type SensitiveRect } from "@/lib/vision/screenshot";
import { nerEnrichScreen } from "@/lib/privacy/ner";
import { sanitizeScreen } from "@/lib/security/injection-guard";

interface RuntimePort {
  postMessage(msg: unknown): void;
  onDisconnect: { addListener(f: () => void): void };
}

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "success";
  stage: string;
  message: string;
  ms?: number;
}

interface LastStats {
  elements: number;
  redactions: number;
  facesBlurred: number;
  screenshotKb: number;
}

interface PopupSnapshot {
  socketStatus: SocketStatus;
  socketDetail: string;
  serverUrl: string;
  hasAuthToken: boolean;
  taskRunning: boolean;
  currentTask: string;
  settings: AgentSettings;
  logs: LogEntry[];
  lastPlan: PlanMsg | null;
  lastStats: LastStats | null;
  lastTimings: Timings | null;
}

interface AgentSettings {
  visionEnabled: boolean;
  blurFaces: boolean;
  nerEnabled: boolean;
  ocrEnabled: boolean;
}

interface LastStats {
  elements: number;
  redactions: number;
  facesBlurred: number;
  screenshotKb: number;
}

const DEFAULT_SETTINGS: AgentSettings = {
  visionEnabled: true,
  blurFaces: true,
  nerEnabled: false,
  ocrEnabled: false,
};

const MAX_TURNS = 5;
const sock = new AgentSocket();

let socketDetail = "";
let taskRunning = false;
let currentTask = "";
let lastPlan: PlanMsg | null = null;
let lastStats: LastStats | null = null;
let lastTimings: Timings | null = null;
let settings: AgentSettings = { ...DEFAULT_SETTINGS };
const logRing: LogEntry[] = [];
const popupPorts = new Set<RuntimePort>();

async function loadSettings(): Promise<void> {
  const stored = (await browser.storage.local.get(
    Object.keys(DEFAULT_SETTINGS)
  )) as Record<string, unknown>;
  settings = {
    visionEnabled: (stored.visionEnabled as boolean | undefined) ?? DEFAULT_SETTINGS.visionEnabled,
    blurFaces: (stored.blurFaces as boolean | undefined) ?? DEFAULT_SETTINGS.blurFaces,
    nerEnabled: (stored.nerEnabled as boolean | undefined) ?? DEFAULT_SETTINGS.nerEnabled,
    ocrEnabled: (stored.ocrEnabled as boolean | undefined) ?? DEFAULT_SETTINGS.ocrEnabled,
  };
}

function log(level: LogEntry["level"], stage: string, message: string, ms?: number): void {
  const entry: LogEntry = { ts: Date.now(), level, stage, message, ms };
  logRing.push(entry);
  if (logRing.length > 200) logRing.shift();
  broadcast({ kind: "log", entry });
}

function broadcast(event: Record<string, unknown>): void {
  for (const port of popupPorts) {
    try {
      port.postMessage(event);
    } catch {
      popupPorts.delete(port);
    }
  }
}

function snapshot(): PopupSnapshot {
  return {
    socketStatus: sock.status,
    socketDetail,
    serverUrl: sock.currentUrl() || DEFAULT_SERVER_URL,
    hasAuthToken: sock.hasToken(),
    taskRunning,
    currentTask,
    settings,
    logs: logRing.slice(-80),
    lastPlan,
    lastStats,
    lastTimings,
  };
}

sock.onStatus = (s, detail) => {
  socketDetail = detail ?? "";
  broadcast({ kind: "status", status: s, detail });
};
sock.onEvent = (e) => {
  if (e.kind === "server-error") log("error", "server", e.message);
  else log("warn", "socket", e.message);
};
sock.onPlanDelta = (seq, delta) => {
  broadcast({ kind: "plan-delta", seq, delta });
};

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    const stored = await browser.storage.local.get(["serverUrl", ...Object.keys(DEFAULT_SETTINGS)]);
    const patch: Record<string, unknown> = {};
    if (!stored.serverUrl) patch.serverUrl = DEFAULT_SERVER_URL;
    for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof AgentSettings>) {
      if (stored[k] === undefined) patch[k] = DEFAULT_SETTINGS[k];
    }
    await browser.storage.local.set(patch);
    await sock.loadUrl();
    await loadSettings();
  });

  browser.runtime.onStartup.addListener(() => {
    void sock.loadUrl().then(loadSettings);
  });
  void sock.loadUrl().then(loadSettings).then(() => sock.ensure()).catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let touched = false;
    for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof AgentSettings>) {
      if (changes[k]) {
        (settings[k] as boolean) = changes[k].newValue as boolean;
        touched = true;
      }
    }
    if (touched) broadcast({ kind: "settings", settings });
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup") return;
    popupPorts.add(port);
    port.postMessage({ kind: "snapshot", snapshot: snapshot() });
    port.onDisconnect.addListener(() => popupPorts.delete(port));
  });

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; task?: string; url?: string; key?: string; value?: boolean | string };
    switch (m?.type) {
      case "GET_STATE":
        return Promise.resolve(snapshot());
      case "SET_SERVER_URL":
        return sock
          .setUrl(m.url ?? DEFAULT_SERVER_URL)
          .then(() => ({ ok: true }))
          .catch((e) => ({ ok: false, error: String(e) }));
      case "SET_AUTH_TOKEN":
        return sock
          .setToken(typeof m.value === "string" ? m.value : "")
          .then(() => ({ ok: true }))
          .catch((e) => ({ ok: false, error: String(e) }));
      case "SET_SETTING":
        if (m.key && typeof m.value === "boolean" && m.key in DEFAULT_SETTINGS) {
          // Update the live cache too — turns read from `settings`, not
          // storage, and MV3 workers can stay alive across setting changes.
          (settings as unknown as Record<string, boolean>)[m.key] = m.value;
          void browser.storage.local.set({ [m.key]: m.value });
        }
        return Promise.resolve({ ok: true });
      case "START_TASK":
        if (taskRunning) return Promise.resolve({ ok: false, error: "task already running" });
        runTask(m.task ?? "").catch((e) => log("error", "agent", String(e)));
        return Promise.resolve({ ok: true });
      case "STOP_TASK":
        stopRequested = true;
        log("warn", "agent", "stop requested by user");
        return Promise.resolve({ ok: true });
      default:
        return undefined;
    }
  });
});

let stopRequested = false;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

async function getActiveTab(): Promise<BgTab> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab;
}

interface ExtractResponse {
  ok: boolean;
  error?: string;
  screen?: ScreenContext;
  timings?: { extract_ms: number; redact_ms: number; serialize_ms: number };
  sensitiveRects?: SensitiveRect[];
  dpr?: number;
  detectorError?: string;
}

interface BgTab {
  id?: number;
  windowId?: number;
}

/** Send a message to the tab's content script, recovering when the receiver is
 *  gone — either because the page predates the last extension reload or because
 *  an action just navigated the tab and the content script died mid-flight. */
const RETRYABLE_SEND_ERRORS = [
  "receiving end does not exist",
  "message port closed",
  "message channel closed",
  "asynchronous response",
];

function isRetryableSendError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return RETRYABLE_SEND_ERRORS.some((p) => msg.includes(p));
}

async function waitTabComplete(tabId: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.status === "complete") return;
    } catch {
      return; // tab gone — let the next sendMessage surface the real error
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function tabSend<T = unknown>(tabId: number, message: unknown): Promise<T> {
  try {
    return (await browser.tabs.sendMessage(tabId, message)) as T;
  } catch (e) {
    if (!isRetryableSendError(e)) throw e;
    // Navigation or stale injection: let the new document finish loading,
    // reinject the content script, give listeners a beat, then retry once.
    await waitTabComplete(tabId);
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["/content-scripts/content.js"],
    });
    await new Promise((r) => setTimeout(r, 200));
    return (await browser.tabs.sendMessage(tabId, message)) as T;
  }
}

async function captureSanitizedScreen(
  tab: BgTab,
  sensitiveRects: SensitiveRect[],
  dpr: number,
  timings: Timings
): Promise<{
  region: ScreenContext["image_regions"][number] | null;
  faces: number;
  detectorAvailable: boolean;
  detectorError?: string;
  ocrMasked: number;
  ocrAvailable: boolean;
  rawDataUrl: string;
}> {
  const t0 = performance.now();
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId!, { format: "jpeg", quality: 92 });
  timings.capture_ms = round1(performance.now() - t0);

  const t1 = performance.now();
  try {
    const result = await redactScreenshot(dataUrl, sensitiveRects, dpr, settings.blurFaces, settings.ocrEnabled);
    timings.vision_ms = round1(performance.now() - t1);
    if (!result.region) throw new Error("canvas unavailable");
    return {
      region: result.region,
      faces: result.facesBlurred,
      detectorAvailable: result.detectorAvailable,
      detectorError: result.detectorError,
      ocrMasked: result.ocrMasked,
      ocrAvailable: result.ocrAvailable,
      rawDataUrl: dataUrl,
    };
  } catch (e) {
    timings.vision_ms = round1(performance.now() - t1);
    log("warn", "vision", `screenshot sanitization failed: ${e instanceof Error ? e.message : e}`);
    return { region: null, faces: 0, detectorAvailable: false, detectorError: e instanceof Error ? e.message : String(e), ocrMasked: 0, ocrAvailable: false, rawDataUrl: dataUrl };
  }
}

async function runTask(task: string): Promise<void> {
  taskRunning = true;
  stopRequested = false;
  currentTask = task;
  broadcast({ kind: "task", running: true, task });
  const taskStart = performance.now();
  let tabId: number | undefined;

  try {
    if (!task.trim()) throw new Error("empty task");
    const tab = await getActiveTab();
    tabId = tab.id!;
    log("info", "agent", `starting task on tab ${tabId}`);

    await sock.ensure();
    if (sock.status !== "open") throw new Error(`server unreachable (${sock.currentUrl()})`);

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (stopRequested) break;

      const extractStart = performance.now();
      const resp: ExtractResponse = await tabSend<ExtractResponse>(tabId, { type: "EXTRACT" });
      if (!resp?.ok) throw new Error(resp?.error ?? "extraction failed");
      const wallMs = performance.now() - extractStart;

      const timings: Timings = {
        extract_ms: resp.timings?.extract_ms ?? 0,
        redact_ms: resp.timings?.redact_ms ?? 0,
        serialize_ms: resp.timings?.serialize_ms ?? 0,
        capture_ms: 0,
        vision_ms: 0,
        classify_ms: 0,
        rtt_ms: round1(wallMs),
      };

      let screen: ScreenContext = resp.screen!;

      const guard = sanitizeScreen(screen);
      screen = guard.screen;
      if (guard.hits > 0) {
        log(
          "warn",
          "guard",
          `${guard.hits} prompt-injection pattern(s) neutralized in page content (elements ${guard.flaggedIds.join(", ")})`
        );
      }

      log(
        "success",
        "redact",
        `${screen.redaction_count} sensitive value(s) masked in structure`,
        timings.redact_ms
      );

      if (settings.nerEnabled) {
        const t0 = performance.now();
        const enriched = await nerEnrichScreen(screen);
        screen = enriched.screen;
        log(
          enriched.maskedCount > 0 ? "success" : "info",
          "ner",
          `${enriched.maskedCount} entity value(s) masked via heuristic name detection`,
          round1(performance.now() - t0)
        );
      }

      if (settings.visionEnabled) {
        const dpr = resp.dpr ?? 1;
        const { region, faces, detectorAvailable, detectorError, ocrMasked, ocrAvailable, rawDataUrl } =
          await captureSanitizedScreen(tab, resp.sensitiveRects ?? [], dpr, timings);
        if (region) {
          screen.image_regions = [region];
          lastStats = lastStats ?? { elements: 0, redactions: 0, facesBlurred: 0, screenshotKb: 0 };
          lastStats.screenshotKb = Math.round((region.data_b64.length * 0.75) / 1024);
          const domBoxes = resp.sensitiveRects?.length ?? 0;
          if (!detectorAvailable) {
            log(
              "warn",
              "vision",
              `face detector unavailable — DOM-derived blackouts still applied${detectorError ? ` (${detectorError})` : ""}`
            );
          } else {
            log(
              "success",
              "vision",
              `on-device model read raw frame → ${faces} face(s) ${settings.blurFaces ? "blurred" : "blacked"}; ${domBoxes} DOM-derived box(es) blacked out`,
              round1(timings.capture_ms + timings.vision_ms)
            );
          }
          if (!settings.ocrEnabled) {
            log("info", "ocr", "OCR disabled — enable 'OCR text masking' to scan text rendered in images");
          } else if (ocrAvailable && ocrMasked > 0) {
            log("success", "ocr", `OCR masked ${ocrMasked} sensitive text region(s) rendered in images/canvas`);
          } else if (ocrAvailable) {
            log("info", "ocr", "OCR ran — no sensitive text found in rendered images");
          } else {
            log("warn", "ocr", "OCR enabled but engine failed — see SW console for details");
          }
          lastStats.facesBlurred = faces;
        }

        // Run ViT screen classifier on raw screenshot
        const t0class = performance.now();
        try {
          const { classifyScreen } = await import('@/lib/vision/screen-classifier');
          log('info', 'vit', 'loading screen classifier (first run may download ~90MB)…');
          const classifications = await classifyScreen(rawDataUrl);
          if (classifications.length > 0) {
            screen.screen_class = classifications;
            timings.classify_ms = round1(performance.now() - t0class);
            log('success', 'vit', `ViT classified screen: ${classifications[0].label} (${(classifications[0].score * 100).toFixed(1)}%)`, timings.classify_ms);
          }
        } catch (e) {
          log('warn', 'vit', `screen classification skipped: ${e instanceof Error ? e.message : e}`);
        }
      }

      lastStats = lastStats ?? { elements: 0, redactions: 0, facesBlurred: 0, screenshotKb: 0 };
      lastStats.elements = screen.elements.length;
      lastStats.redactions = screen.redaction_count;
      broadcast({ kind: "stats", stats: lastStats });

      const planStart = performance.now();
      const answer = await sock.request(
        { type: "perception", task, screen, timings, first_turn: turn === 1 },
        30000
      );
      if (answer.type === "error") throw new Error(`${answer.code}: ${answer.message}`);
      if (answer.type !== "plan") throw new Error("unexpected server frame");

      const rtt = performance.now() - planStart;
      timings.rtt_ms = round1(rtt);
      lastTimings = { ...timings };
      broadcast({ kind: "timings", timings: lastTimings });
      lastPlan = answer;
      broadcast({ kind: "plan", plan: answer });
      log("info", "plan", answer.thought || "(no thought)", Math.max(0.1, round1(rtt - (answer.usage_ms ?? 0))));

      const actions: AgentAction[] = answer.actions;
      if (actions.length === 0) {
        log("warn", "agent", "server returned no actions");
        break;
      }

      const terminalIdx = actions.findIndex((a) => a.type === "done" || a.type === "fail");
      const executable = terminalIdx >= 0 ? actions.slice(0, terminalIdx) : actions;

      if (executable.length > 0) {
        const execResp = await tabSend<{
          ok: boolean;
          error?: string;
          results?: Array<{ ok: boolean; action_index: number; error?: string }>;
        }>(tabId, { type: "EXECUTE", actions: executable });
        if (!execResp?.ok) throw new Error(execResp?.error ?? "execution failed");
        const failures = (execResp.results ?? []).filter((r: { ok: boolean }) => !r.ok);
        if (failures.length > 0) log("warn", "execute", `${failures.length} action(s) failed`, undefined);
        else log("success", "execute", `${executable.length} action(s) executed`);
        void sock.send({ type: "action_result", seq: answer.seq, results: execResp.results ?? [] });
      }

      const terminal = terminalIdx >= 0 ? actions[terminalIdx] : null;
      if (terminal && terminal.type === "done") {
        log("success", "done", terminal.summary, round1(performance.now() - taskStart));
        void browser.tabs.sendMessage(tabId, { type: "CLEAR_MAP" }).catch(() => {});
        break;
      }
      if (terminal && terminal.type === "fail") {
        log("error", "done", `failed: ${terminal.reason}`, round1(performance.now() - taskStart));
        void browser.tabs.sendMessage(tabId, { type: "CLEAR_MAP" }).catch(() => {});
        break;
      }
      if (turn === MAX_TURNS) log("warn", "agent", "max turns reached without completion");
    }

    log("info", "agent", `total wall time ${round1(performance.now() - taskStart)}ms`);
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const devMem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (perf.memory) {
      log(
        "info",
        "perf",
        `client footprint: SW heap ${round1(perf.memory.usedJSHeapSize / 1048576)}MB · device RAM ~${devMem ?? "?"}GB`
      );
    }
  } finally {
    taskRunning = false;
    currentTask = "";
    broadcast({ kind: "task", running: false, task: "" });
    if (tabId !== undefined) {
      void browser.tabs.sendMessage(tabId, { type: "CLEAR_MAP" }).catch(() => {});
    }
  }
}
