import type { AgentAction } from "@pv/schema";
import type { PlaceholderMap } from "../privacy/redactor";

export interface ActionResult {
  ok: boolean;
  action_index: number;
  error?: string;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function executeActions(
  actions: AgentAction[],
  nodes: Map<number, HTMLElement>,
  map: PlaceholderMap | null,
  maxActions = 10
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const bounded = actions.slice(0, maxActions);

  for (let i = 0; i < bounded.length; i++) {
    const a = bounded[i];
    try {
      switch (a.type) {
        case "click": {
          const el = nodes.get(a.target);
          if (!el) throw new Error(`no element with id ${a.target}`);
          el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
          (el as HTMLElement).click();
          break;
        }
        case "fill": {
          const el = nodes.get(a.target);
          if (!el) throw new Error(`no element with id ${a.target}`);
          let value: string | null = null;
          if (a.ref) value = map?.resolve(a.ref) ?? null;
          if (value === null) value = a.text ?? null;
          if (value === null) throw new Error(`cannot resolve fill value for ref ${a.ref}`);
          el.focus();
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            setNativeValue(el, value);
          } else {
            (el as HTMLElement).textContent = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          break;
        }
        case "scroll": {
          window.scrollBy({ top: a.direction === "down" ? a.amount : -a.amount });
          break;
        }
        case "navigate": {
          location.assign(a.url);
          break;
        }
        case "wait": {
          await new Promise((r) => setTimeout(r, a.ms));
          break;
        }
        case "done":
        case "fail":
          break;
        default:
          throw new Error("unsupported action type");
      }
      results.push({ ok: true, action_index: i });
    } catch (e) {
      results.push({ ok: false, action_index: i, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
