import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import type { AgentAction, PlanMsg, ScreenContext } from "@pv/schema";
import { AgentSocket, DEFAULT_SERVER_URL, type SocketStatus } from "@/lib/ws-client";

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

interface PopupSnapshot {
  socketStatus: SocketStatus;
  socketDetail: string;
  serverUrl: string;
  taskRunning: boolean;
  currentTask: string;
  logs: LogEntry[];
  lastPlan: PlanMsg | null;
  lastStats: { elements: number; redactions: number } | null;
}

const MAX_TURNS = 3;
const sock = new AgentSocket();

let socketDetail = "";
let taskRunning = false;
let currentTask = "";
let lastPlan: PlanMsg | null = null;
let lastStats: { elements: number; redactions: number } | null = null;
const logRing: LogEntry[] = [];
const popupPorts = new Set<RuntimePort>();

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
    taskRunning,
    currentTask,
    logs: logRing.slice(-80),
    lastPlan,
    lastStats,
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

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(async () => {
    const stored = await browser.storage.local.get("serverUrl");
    if (!stored.serverUrl) await browser.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
    await sock.loadUrl();
  });

  browser.runtime.onStartup.addListener(() => void sock.loadUrl());
  void sock.loadUrl().then(() => sock.ensure()).catch(() => {});

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "popup") return;
    popupPorts.add(port);
    port.postMessage({ kind: "snapshot", snapshot: snapshot() });
    port.onDisconnect.addListener(() => popupPorts.delete(port));
  });

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; task?: string; url?: string };
    switch (m?.type) {
      case "GET_STATE":
        return Promise.resolve(snapshot());
      case "SET_SERVER_URL":
        return sock
          .setUrl(m.url ?? DEFAULT_SERVER_URL)
          .then(() => ({ ok: true }))
          .catch((e) => ({ ok: false, error: String(e) }));
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

async function getActiveTabId(): Promise<number> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  return tab.id;
}

async function extractScreen(tabId: number): Promise<{ screen: ScreenContext; timings: Record<string, number> }> {
  const t0 = performance.now();
  const resp = await browser.tabs.sendMessage(tabId, { type: "EXTRACT" });
  if (!resp?.ok) throw new Error(resp?.error ?? "extraction failed");
  const wallMs = performance.now() - t0;
  const t = resp.timings ?? {};
  return {
    screen: resp.screen as ScreenContext,
    timings: {
      extract_ms: t.extract_ms ?? 0,
      redact_ms: t.redact_ms ?? 0,
      serialize_ms: t.serialize_ms ?? 0,
      rtt_ms: round1(wallMs),
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

async function runTask(task: string): Promise<void> {
  taskRunning = true;
  stopRequested = false;
  currentTask = task;
  broadcast({ kind: "task", running: true, task });
  const taskStart = performance.now();

  try {
    if (!task.trim()) throw new Error("empty task");
    const tabId = await getActiveTabId();
    log("info", "agent", `starting task on tab ${tabId}`);

    await sock.ensure();
    if (sock.status !== "open") throw new Error(`server unreachable (${sock.currentUrl()})`);

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (stopRequested) break;

      const { screen, timings } = await extractScreen(tabId);
      lastStats = { elements: screen.elements.length, redactions: screen.redaction_count };
      broadcast({ kind: "stats", stats: lastStats });
      log(
        "success",
        `redact`,
        `${screen.redaction_count} sensitive value(s) masked locally before send`,
        timings.redact_ms
      );

      const planStart = performance.now();
      const resp = await sock.request(
        { type: "perception", task, screen, timings },
        30000
      );
      if (resp.type === "error") throw new Error(`${resp.code}: ${resp.message}`);
      if (resp.type !== "plan") throw new Error("unexpected server frame");

      const rtt = performance.now() - planStart;
      lastPlan = resp;
      broadcast({ kind: "plan", plan: resp });
      log("info", "plan", resp.thought || "(no thought)", Math.max(0.1, round1(rtt - (resp.usage_ms ?? 0))));

      const actions: AgentAction[] = resp.actions;
      if (actions.length === 0) {
        log("warn", "agent", "server returned no actions");
        break;
      }

      const terminalIdx = actions.findIndex((a) => a.type === "done" || a.type === "fail");
      const executable = terminalIdx >= 0 ? actions.slice(0, terminalIdx) : actions;

      if (executable.length > 0) {
        const execResp = await browser.tabs.sendMessage(tabId, { type: "EXECUTE", actions: executable });
        if (!execResp?.ok) throw new Error(execResp?.error ?? "execution failed");
        const failures = (execResp.results ?? []).filter((r: { ok: boolean }) => !r.ok);
        if (failures.length > 0)
          log("warn", "execute", `${failures.length} action(s) failed`, undefined);
        else log("success", "execute", `${executable.length} action(s) executed`);
        void sock.send({
          type: "action_result",
          seq: resp.seq,
          results: execResp.results ?? [],
        });
      }

      const terminal =
        terminalIdx >= 0
          ? actions[terminalIdx]
          : null;
      if (terminal && terminal.type === "done") {
        log("success", "done", terminal.summary, round1(performance.now() - taskStart));
        break;
      }
      if (terminal && terminal.type === "fail") {
        log("error", "done", `failed: ${terminal.reason}`, round1(performance.now() - taskStart));
        break;
      }
      if (turn === MAX_TURNS) log("warn", "agent", "max turns reached without completion");
    }

    log("info", "agent", `total wall time ${round1(performance.now() - taskStart)}ms`);
  } finally {
    taskRunning = false;
    currentTask = "";
    broadcast({ kind: "task", running: false, task: "" });
  }
}
