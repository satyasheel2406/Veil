import { browser } from "wxt/browser";

/**
 * Single choke point for talking to the offscreen document (Chrome MV3).
 * The service worker cannot host DOM-dependent libraries (MediaPipe's
 * importScripts-after-install restriction, hidden-doc image decoding),
 * so those run in the hidden offscreen page instead.
 */

type OffscreenApi = {
  createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
};

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

export function offscreenSupported(): boolean {
  return Boolean((globalThis as { chrome?: { offscreen?: OffscreenApi } }).chrome?.offscreen);
}

let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<boolean> {
  const api = (globalThis as { chrome?: { offscreen?: OffscreenApi } }).chrome?.offscreen;
  if (!api) return false;
  try {
    const runtime = browser.runtime as unknown as {
      getContexts?: (o: { contextTypes: string[] }) => Promise<unknown[]>;
    };
    if (runtime.getContexts) {
      const ctxs = await withTimeout(
        runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }),
        5000,
        "getContexts"
      );
      if (ctxs && ctxs.length > 0) return true;
    }
    console.info("[veil] creating offscreen document…");
    creating = creating ?? api.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_SCRAPING"],
      justification: "On-device vision models (face detection, OCR) for privacy redaction",
    });
    await withTimeout(creating, 12000, "offscreen.createDocument");
    // Give the page's module time to register its listener.
    await new Promise((r) => setTimeout(r, 400));
    return true;
  } catch (e) {
    if (String(e).toLowerCase().includes("exist")) return true;
    console.warn("[veil] Failed to create offscreen document:", e);
    return false;
  } finally {
    creating = null;
  }
}

/** Round-trip a request to the offscreen document. Throws on failure. */
export async function requestOffscreen<T>(payload: Record<string, unknown>, timeoutMs: number, label: string): Promise<T> {
  if (!(await ensureOffscreen())) {
    throw new Error("offscreen unavailable");
  }
  console.info(`[veil] sending ${String(payload.type)} to offscreen…`);
  const resp = (await withTimeout(
    browser.runtime.sendMessage({ target: "offscreen", ...payload }) as Promise<
      { ok: boolean; error?: string } & Record<string, unknown>
    >,
    timeoutMs,
    `${label} round-trip`
  )) as { ok: boolean; error?: string } & Record<string, unknown>;
  if (!resp) throw new Error("no response from offscreen document");
  if (!resp.ok) throw new Error(String(resp.error || "offscreen request failed"));
  return resp as T;
}
