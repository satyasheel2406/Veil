import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { extractAndRedact } from "@/lib/perception/dom-extractor";
import { executeActions } from "@/lib/executor/actions";
import { PlaceholderMap } from "@/lib/privacy/redactor";
import type { AgentAction } from "@pv/schema";

const SESSION_KEY = "veil_placeholder_map";

async function persistMap(map: PlaceholderMap): Promise<void> {
  try {
    await browser.storage.session.set({ [SESSION_KEY]: map.serialize() });
  } catch {
    // storage.session may not be available in all contexts; fall back silently
    try {
      await browser.storage.local.set({ [SESSION_KEY]: map.serialize() });
    } catch { /* ignore */ }
  }
}

async function restoreMap(): Promise<PlaceholderMap | null> {
  try {
    const stored = await browser.storage.session.get(SESSION_KEY);
    if (stored[SESSION_KEY]) return PlaceholderMap.deserialize(stored[SESSION_KEY] as string);
  } catch {
    try {
      const stored = await browser.storage.local.get(SESSION_KEY);
      if (stored[SESSION_KEY]) return PlaceholderMap.deserialize(stored[SESSION_KEY] as string);
    } catch { /* ignore */ }
  }
  return null;
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",

  main() {
    let nodes = new Map<number, HTMLElement>();
    let map: PlaceholderMap | null = null;

    browser.runtime.onMessage.addListener((msg: unknown) => {
      const m = msg as { type?: string; actions?: AgentAction[]; clearMap?: boolean; target?: string };
      if (m?.target) return undefined; // inter-context messages (e.g. offscreen)
      if (m?.type === "EXTRACT") {
        return (async () => {
          try {
            // Restore previous session's map to maintain cross-page refs
            const previousMap = await restoreMap();
            const out = extractAndRedact(previousMap ?? undefined);
            nodes = out.nodes;
            map = out.map;
            // Persist the updated map for future pages
            await persistMap(map);
            return {
              ok: true,
              screen: out.screen,
              timings: out.timings,
              sensitiveRects: out.sensitiveRects,
              dpr: window.devicePixelRatio || 1,
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        })();
      }

      if (m?.type === "EXECUTE") {
        return (async () => {
          try {
            const results = await executeActions(m.actions ?? [], nodes, map);
            return { ok: true, results };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        })();
      }

      if (m?.type === "CLEAR_MAP") {
        return (async () => {
          try {
            map = null;
            await browser.storage.session.remove(SESSION_KEY).catch(() => {});
            await browser.storage.local.remove(SESSION_KEY).catch(() => {});
            return { ok: true };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        })();
      }

      return undefined;
    });
  },
});
