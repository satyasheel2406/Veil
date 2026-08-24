import { useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";
import type { PlanMsg } from "@pv/schema";

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "success";
  stage: string;
  message: string;
  ms?: number;
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

interface TimingsView {
  extract_ms: number;
  redact_ms: number;
  serialize_ms: number;
  capture_ms: number;
  vision_ms: number;
  rtt_ms: number | null;
}

const BUDGETS: Array<{ key: keyof TimingsView; label: string; budget: number }> = [
  { key: "extract_ms", label: "extract", budget: 150 },
  { key: "redact_ms", label: "redact", budget: 50 },
  { key: "vision_ms", label: "vision", budget: 400 },
  { key: "capture_ms", label: "capture", budget: 150 },
  { key: "rtt_ms", label: "server rtt", budget: 2500 },
];

function barTone(ratio: number): string {
  if (ratio > 1) return "bg-rose-500";
  if (ratio > 0.6) return "bg-amber-400";
  return "bg-emerald-500";
}

interface Snapshot {
  socketStatus: string;
  socketDetail: string;
  serverUrl: string;
  hasAuthToken?: boolean;
  taskRunning: boolean;
  currentTask: string;
  settings: AgentSettings;
  logs: LogEntry[];
  lastPlan: PlanMsg | null;
  lastStats: LastStats | null;
  lastTimings: TimingsView | null;
}

const LEVEL_STYLE: Record<LogEntry["level"], string> = {
  info: "text-slate-300",
  warn: "text-amber-400",
  error: "text-rose-400",
  success: "text-emerald-400",
};

const LEVEL_DOT: Record<LogEntry["level"], string> = {
  info: "bg-slate-500",
  warn: "bg-amber-400",
  error: "bg-rose-400",
  success: "bg-emerald-400",
};

function actionLabel(a: PlanMsg["actions"][number]): string {
  switch (a.type) {
    case "click":
      return `click #${a.target}`;
    case "fill":
      return `fill #${a.target} ← ${a.ref ?? "text"}`;
    case "scroll":
      return `scroll ${a.direction}`;
    case "navigate":
      return `goto ${a.url.slice(0, 40)}`;
    case "wait":
      return `wait ${a.ms}ms`;
    case "done":
      return `done`;
    case "fail":
      return `fail`;
  }
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [task, setTask] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [editingToken, setEditingToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [streamingThought, setStreamingThought] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const port = browser.runtime.connect({ name: "popup" });
    port.onMessage.addListener((msg) => {
      if (msg.kind === "snapshot") {
        setSnap(msg.snapshot as Snapshot);
        setServerUrl((msg.snapshot as Snapshot).serverUrl);
      } else if (msg.kind === "log") {
        setSnap((prev) =>
          prev
            ? { ...prev, logs: [...prev.logs.slice(-79), msg.entry as LogEntry] }
            : prev
        );
      } else if (msg.kind === "status") {
        setSnap((prev) =>
          prev ? { ...prev, socketStatus: msg.status, socketDetail: msg.detail ?? "" } : prev
        );
      } else if (msg.kind === "plan-delta") {
        setStreamingThought((prev) => (prev + (msg.delta as string)).slice(-1200));
      } else if (msg.kind === "plan") {
        setStreamingThought("");
        setSnap((prev) => (prev ? { ...prev, lastPlan: msg.plan as PlanMsg } : prev));
      } else if (msg.kind === "stats") {
        setSnap((prev) => (prev ? { ...prev, lastStats: msg.stats as LastStats } : prev));
      } else if (msg.kind === "timings") {
        setSnap((prev) => (prev ? { ...prev, lastTimings: msg.timings as TimingsView } : prev));
      } else if (msg.kind === "settings") {
        setSnap((prev) => (prev ? { ...prev, settings: msg.settings as AgentSettings } : prev));
      } else if (msg.kind === "task") {
        if (msg.running) setStreamingThought("");
        setSnap((prev) =>
          prev ? { ...prev, taskRunning: msg.running, currentTask: msg.task } : prev
        );
      }
    });

    return () => port.disconnect();
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [snap?.logs.length]);

  const statusColor =
    snap?.socketStatus === "open"
      ? "bg-emerald-500"
      : snap?.socketStatus === "connecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-rose-500";

  const start = () => browser.runtime.sendMessage({ type: "START_TASK", task });
  const stop = () => browser.runtime.sendMessage({ type: "STOP_TASK" });
  const saveUrl = async () => {
    await browser.runtime.sendMessage({ type: "SET_SERVER_URL", url: serverUrl });
    setEditingUrl(false);
  };
  const saveToken = async () => {
    await browser.runtime.sendMessage({ type: "SET_AUTH_TOKEN", value: tokenDraft });
    setTokenDraft("");
    setEditingToken(false);
  };
  const setSetting = (key: string, value: boolean) =>
    browser.runtime.sendMessage({ type: "SET_SETTING", key, value });

  const Toggle = ({
    label,
    hint,
    k,
    checked,
  }: {
    label: string;
    hint?: string;
    k: string;
    checked?: boolean;
  }) => (
    <button
      onClick={() => setSetting(k, !checked)}
      className="flex w-full items-center justify-between rounded-lg bg-slate-900 px-2.5 py-1.5 text-left hover:bg-slate-800/70"
    >
      <span>
        <span className="block text-[11px] font-medium text-slate-200">{label}</span>
        {hint && <span className="block text-[9px] leading-tight text-slate-500">{hint}</span>}
      </span>
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full transition ${
          checked ? "bg-indigo-500" : "bg-slate-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            checked ? "left-3.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-3 bg-slate-950 p-3 text-slate-200">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white">
            V
          </div>
          <div>
            <h1 className="text-sm font-semibold leading-none">Veil Agent</h1>
            <p className="mt-0.5 text-[10px] text-slate-400">privacy-first vision pipeline</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-slate-900 px-2.5 py-1">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span className="text-[10px] uppercase tracking-wider text-slate-400">
            {snap?.socketStatus ?? "…"}
            {snap?.socketDetail ? ` · ${snap.socketDetail}` : ""}
          </span>
        </div>
      </header>

      {editingUrl ? (
        <div className="flex gap-1.5">
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs outline-none focus:border-indigo-500"
            placeholder="ws://localhost:8765/ws"
          />
          <button
            onClick={saveUrl}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium hover:bg-indigo-500"
          >
            Save
          </button>
        </div>
      ) : (
        <button
          onClick={() => setEditingUrl(true)}
          className="truncate rounded-md bg-slate-900 px-2 py-1 text-left text-[10px] text-slate-500 hover:text-slate-300"
        >
          server: {serverUrl || "not set"}
        </button>
      )}

      {editingToken ? (
        <div className="flex gap-1.5">
          <input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs outline-none focus:border-indigo-500"
            placeholder="WS auth token (blank = none)"
          />
          <button
            onClick={saveToken}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium hover:bg-indigo-500"
          >
            Save
          </button>
        </div>
      ) : (
        <button
          onClick={() => setEditingToken(true)}
          className="rounded-md bg-slate-900 px-2 py-1 text-left text-[10px] text-slate-600 hover:text-slate-300"
        >
          auth token: {snap?.hasAuthToken ? "configured" : "none"}
        </button>
      )}

      {snap?.lastStats && (
        <div className="grid grid-cols-4 gap-1.5 text-center">
          <div className="rounded-lg bg-slate-900 py-2">
            <p className="text-base font-semibold leading-none">{snap.lastStats.elements}</p>
            <p className="mt-1 text-[8px] uppercase tracking-wide text-slate-500">elements</p>
          </div>
          <div className="rounded-lg bg-indigo-950/60 py-2 ring-1 ring-indigo-800/50">
            <p className="text-base font-semibold leading-none text-indigo-300">
              {snap.lastStats.redactions}
            </p>
            <p className="mt-1 text-[8px] uppercase tracking-wide text-indigo-400/70">PII masked</p>
          </div>
          <div className="rounded-lg bg-emerald-950/40 py-2 ring-1 ring-emerald-900/50">
            <p className="text-base font-semibold leading-none text-emerald-300">
              {snap.lastStats.facesBlurred}
            </p>
            <p className="mt-1 text-[8px] uppercase tracking-wide text-emerald-400/70">faces</p>
          </div>
          <div className="rounded-lg bg-slate-900 py-2">
            <p className="text-base font-semibold leading-none">{snap.lastStats.screenshotKb ?? "—"}</p>
            <p className="mt-1 text-[8px] uppercase tracking-wide text-slate-500">KB sent</p>
          </div>
        </div>
      )}

      {snap?.lastTimings && (
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
          <div className="mb-1.5 flex items-baseline justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400">
              latency budget
            </p>
            <p className="text-[9px] text-slate-500">
              total{" "}
              <span
                className={
                  (snap.lastTimings.rtt_ms ?? 0) +
                    snap.lastTimings.extract_ms +
                    snap.lastTimings.redact_ms +
                    snap.lastTimings.capture_ms +
                    snap.lastTimings.vision_ms <=
                  3500
                    ? "text-emerald-400"
                    : "text-rose-400"
                }
              >
                ≤3.5s target
              </span>
            </p>
          </div>
          <div className="flex flex-col gap-1">
            {BUDGETS.map(({ key, label, budget }) => {
              const raw = snap.lastTimings![key];
              const ms = raw == null ? null : raw;
              const ratio = (ms ?? 0) / budget;
              return (
                <div key={key} className="flex items-center gap-1.5">
                  <span className="w-14 shrink-0 text-[9px] text-slate-500">{label}</span>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className={`h-full rounded-full ${ms == null ? "bg-slate-700" : barTone(ratio)}`}
                      style={{ width: `${Math.min(100, Math.max(2, ratio * 100))}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono text-[9px] text-slate-400">
                    {ms == null ? "—" : ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`}
                  </span>
                  <span className="w-8 shrink-0 text-right text-[8px] text-slate-600">
                    /{budget}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="flex flex-col gap-1">
        <Toggle
          label="Sanitized screenshot"
          hint="PII boxes + face blur applied on-device before send"
          k="visionEnabled"
          checked={snap?.settings.visionEnabled}
        />
        <Toggle
          label="Blur faces (vs blackout)"
          k="blurFaces"
          checked={snap?.settings.blurFaces}
        />
        <Toggle
          label="AI name detection"
          hint="masks person names in text values on-device"
          k="nerEnabled"
          checked={snap?.settings.nerEnabled}
        />
        <Toggle
          label="OCR text masking"
          hint="blacks out PII rendered inside images/canvas (experimental)"
          k="ocrEnabled"
          checked={snap?.settings.ocrEnabled}
        />
      </div>

      <textarea
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder='Describe the task… e.g. "Log in to my account"'
        rows={2}
        className="resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs outline-none placeholder:text-slate-600 focus:border-indigo-500"
      />

      <div className="flex gap-2">
        <button
          onClick={start}
          disabled={snap?.taskRunning || !task.trim()}
          className="flex-1 rounded-lg bg-indigo-600 py-2 text-xs font-semibold text-white transition enabled:hover:bg-indigo-500 disabled:opacity-40"
        >
          {snap?.taskRunning ? "Working…" : "Run task"}
        </button>
        <button
          onClick={stop}
          disabled={!snap?.taskRunning}
          className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 transition enabled:hover:bg-slate-700 disabled:opacity-30"
        >
          Stop
        </button>
      </div>

      {snap?.taskRunning && streamingThought && (
        <section className="rounded-lg border border-indigo-800/60 bg-indigo-950/40 p-2.5">
          <p className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
            thinking
          </p>
          <p className="line-clamp-4 whitespace-pre-wrap font-mono text-[10px] leading-snug text-slate-400">
            {streamingThought}
          </p>
        </section>
      )}

      {snap?.lastPlan && (
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-400">
            last plan · {snap.lastPlan.model}
            {snap.lastPlan.usage_ms != null && ` · ${Math.round(snap.lastPlan.usage_ms)}ms`}
          </p>
          {snap.lastPlan.thought && (
            <p className="mb-2 line-clamp-3 text-[11px] leading-snug text-slate-400">
              {snap.lastPlan.thought}
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {snap.lastPlan.actions.map((a, i) => (
              <span
                key={i}
                className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                  a.type === "done"
                    ? "bg-emerald-950 text-emerald-400"
                    : a.type === "fail"
                      ? "bg-rose-950 text-rose-400"
                      : "bg-slate-800 text-slate-300"
                }`}
              >
                {actionLabel(a)}
              </span>
            ))}
          </div>
        </section>
      )}

      <section ref={logRef} className="h-44 overflow-y-auto rounded-lg bg-black/40 p-2 font-mono">
        {(snap?.logs ?? []).map((l, i) => (
          <div key={`${l.ts}-${i}`} className="flex items-start gap-1.5 py-0.5 text-[10px] leading-relaxed">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[l.level]}`} />
            <span className="shrink-0 text-slate-600">
              {new Date(l.ts).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className={`shrink-0 font-semibold ${LEVEL_STYLE[l.level]}`}>{l.stage}</span>
            <span className="text-slate-400">{l.message}</span>
            {l.ms != null && <span className="ml-auto shrink-0 text-slate-600">{l.ms}ms</span>}
          </div>
        ))}
        {(snap?.logs.length ?? 0) === 0 && (
          <p className="py-8 text-center text-[10px] text-slate-600">
            no activity yet — run a task to see the pipeline live
          </p>
        )}
      </section>
    </div>
  );
}
