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

interface Snapshot {
  socketStatus: string;
  socketDetail: string;
  serverUrl: string;
  taskRunning: boolean;
  currentTask: string;
  logs: LogEntry[];
  lastPlan: PlanMsg | null;
  lastStats: { elements: number; redactions: number } | null;
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
      } else if (msg.kind === "plan") {
        setSnap((prev) => (prev ? { ...prev, lastPlan: msg.plan as PlanMsg } : prev));
      } else if (msg.kind === "stats") {
        setSnap((prev) => (prev ? { ...prev, lastStats: msg.stats } : prev));
      } else if (msg.kind === "task") {
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

      {snap?.lastStats && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-slate-900 py-2">
            <p className="text-lg font-semibold leading-none">{snap.lastStats.elements}</p>
            <p className="mt-1 text-[9px] uppercase tracking-wide text-slate-500">elements read</p>
          </div>
          <div className="rounded-lg bg-indigo-950/60 py-2 ring-1 ring-indigo-800/50">
            <p className="text-lg font-semibold leading-none text-indigo-300">
              {snap.lastStats.redactions}
            </p>
            <p className="mt-1 text-[9px] uppercase tracking-wide text-indigo-400/70">PII masked</p>
          </div>
          <div className="rounded-lg bg-slate-900 py-2">
            <p className="text-lg font-semibold leading-none">{snap.logs.filter((l) => l.stage === "plan").length}</p>
            <p className="mt-1 text-[9px] uppercase tracking-wide text-slate-500">plans</p>
          </div>
        </div>
      )}

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
