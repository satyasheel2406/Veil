import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { extractAndRedact } from "@/lib/perception/dom-extractor";
import { executeActions } from "@/lib/executor/actions";
import { PlaceholderMap } from "@/lib/privacy/redactor";
import type { AgentAction } from "@pv/schema";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",

  main() {
    let nodes = new Map<number, HTMLElement>();
    let map: PlaceholderMap | null = null;

    browser.runtime.onMessage.addListener((msg: unknown) => {
      const m = msg as { type?: string; actions?: AgentAction[] };
      if (m?.type === "EXTRACT") {
        return (async () => {
          try {
            const out = extractAndRedact();
            nodes = out.nodes;
            map = out.map;
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

      return undefined;
    });
  },
});
