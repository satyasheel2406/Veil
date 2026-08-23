import type { ElementNode, PiiKind, ScreenContext, ValueSlot } from "@pv/schema";
import { PlaceholderMap, classifySensitiveField, scanText } from "../privacy/redactor";

export interface ExtractOutput {
  screen: ScreenContext;
  nodes: Map<number, HTMLElement>;
  map: PlaceholderMap;
  sensitiveRects: Array<{ x: number; y: number; w: number; h: number }>;
  timings: { extract_ms: number; redact_ms: number; serialize_ms: number };
}

const SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='tab']",
  "h1",
  "h2",
  "h3",
  "h4",
  "img",
  "[onclick]",
  "[contenteditable='true']",
].join(",");

const MAX_ELEMENTS = 350;
const MAX_TEXT = 200;

class RedactTimer {
  ms = 0;
  lastHits = 0;
  constructor(private map: PlaceholderMap) {}
  scan(text: string): string {
    const t0 = performance.now();
    try {
      const r = scanText(text, this.map);
      this.lastHits = r.hits;
      return r.text;
    } finally {
      this.ms += performance.now() - t0;
    }
  }
  register(value: string, kind: PiiKind): string {
    this.lastHits = 1;
    return this.map.register(value, kind);
  }
}

function collapse(ws: string): string {
  return ws.replace(/\s+/g, " ").trim();
}

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "file") return "button";
    return "textbox";
  }
  if (el instanceof HTMLTextAreaElement) return "textbox";
  if (el instanceof HTMLSelectElement) return "combobox";
  if (el instanceof HTMLButtonElement) return "button";
  if (el instanceof HTMLAnchorElement) return "link";
  if (el instanceof HTMLImageElement) return "image";
  if (/^H[1-6]$/.test(el.tagName)) return "heading";
  if ((el as HTMLElement).isContentEditable) return "textbox";
  return "generic";
}

function accessibleName(el: HTMLElement): string {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && collapse(ariaLabel)) return collapse(ariaLabel).slice(0, MAX_TEXT);

  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText ?? "")
      .join(" ");
    const t = collapse(parts);
    if (t) return t.slice(0, MAX_TEXT);
  }

  if (el.id) {
    const label = document.querySelector(`label[for='${CSS.escape(el.id)}']`);
    if (label) {
      const t = collapse(label.textContent ?? "");
      if (t) return t.slice(0, MAX_TEXT);
    }
  }
  const wrapLabel = el.closest("label");
  if (wrapLabel && wrapLabel !== el) {
    const clone = wrapLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("input,textarea,select").forEach((n) => n.remove());
    const t = collapse(clone.textContent ?? "");
    if (t) return t.slice(0, MAX_TEXT);
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const ph = el.getAttribute("placeholder");
    if (ph && collapse(ph)) return collapse(ph).slice(0, MAX_TEXT);
  }
  if (el instanceof HTMLImageElement) {
    const alt = el.alt;
    if (alt && collapse(alt)) return collapse(alt).slice(0, MAX_TEXT);
  }

  const inner = collapse(el.innerText ?? "");
  if (inner) return inner.slice(0, MAX_TEXT);
  return "";
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (parseFloat(style.opacity ?? "1") < 0.05) return false;
  if (el.closest("[hidden], [aria-hidden='true']")) return false;
  return true;
}

function safeAttributes(el: HTMLElement): Record<string, string> {
  const attrs: Record<string, string> = {};
  const type = el.getAttribute("type");
  if (type) attrs.type = type;
  const ac = el.getAttribute("autocomplete");
  if (ac) attrs.autocomplete = ac;
  if ("required" in el && (el as HTMLInputElement).required) attrs.required = "true";
  return attrs;
}

function guessFromContext(inp: HTMLInputElement | HTMLTextAreaElement, displayName: string): PiiKind | null {
  const hints = `${inp.name} ${inp.id} ${displayName}`.toLowerCase();
  if (/password|passwd|passcode/.test(hints)) return "password";
  if (/e-?mail/.test(hints)) return "email";
  if (/\b(phone|mobile|tel)\b/.test(hints)) return "phone";
  if (/\b(card|cc)[- ]?(no|number|num)?\b/.test(hints) && /\d/.test(inp.value)) return "card";
  if (/\baadhaa?r\b/.test(hints)) return "aadhaar";
  if (/\bssn\b|social security/.test(hints)) return "ssn";
  if (/\b(cvv|cvc|security ?code)\b/.test(hints)) return "cvv";
  if (/\b(name|full ?name|first ?name|last ?name)\b/.test(hints)) return "person_name";
  return null;
}

function inputSlot(
  inp: HTMLInputElement | HTMLTextAreaElement,
  displayName: string,
  rt: RedactTimer
): ValueSlot | null {
  const raw = inp.value.trim();
  if (!raw) return null;

  const forced =
    classifySensitiveField(inp.tagName === "TEXTAREA" ? null : inp.type, inp.getAttribute("autocomplete")) ??
    guessFromContext(inp, displayName);
  if (forced && !(inp instanceof HTMLTextAreaElement)) {
    return { kind: "redacted", ref: rt.register(raw, forced), pii: forced };
  }

  const scanned = rt.scan(raw);
  return scanned ? { kind: "text", text: scanned.slice(0, 120) } : null;
}

function valueSlotFor(el: HTMLElement, role: string, rt: RedactTimer): ValueSlot | null {
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (["checkbox", "radio"].includes(t))
      return { kind: "text", text: el.checked ? "checked" : "unchecked" };
    if (["button", "submit", "reset", "file", "hidden"].includes(t)) return null;
    return inputSlot(el, accessibleName(el), rt);
  }
  if (el instanceof HTMLTextAreaElement) return inputSlot(el, accessibleName(el), rt);
  if (el instanceof HTMLSelectElement) {
    const opt = collapse(el.selectedOptions[0]?.textContent ?? "");
    const scanned = opt ? rt.scan(opt) : "";
    return scanned ? { kind: "text", text: scanned.slice(0, 120) } : null;
  }
  if ((el as HTMLElement).isContentEditable) {
    const txt = collapse((el as HTMLElement).innerText ?? "");
    const scanned = txt ? rt.scan(txt) : "";
    return scanned ? { kind: "text", text: scanned.slice(0, 120) } : null;
  }
  void role;
  return null;
}

function urlSkeleton(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/[^/]+/g, "*")}**`;
  } catch {
    return "**";
  }
}

function frameHash(payload: unknown): string {
  const s = JSON.stringify(payload);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function extractAndRedact(): ExtractOutput {
  const t0 = performance.now();
  const map = new PlaceholderMap();
  const rt = new RedactTimer(map);
  const nodes = new Map<number, HTMLElement>();
  const elements: ElementNode[] = [];
  const sensitiveRects: ExtractOutput["sensitiveRects"] = [];

  const candidates = Array.from(document.body.querySelectorAll<HTMLElement>(SELECTOR));

  for (const el of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (!isVisible(el)) continue;
    if (el.querySelector("button, a[href], input, select, textarea")) continue;

    const rect = el.getBoundingClientRect();
    const id = nodes.size;
    nodes.set(id, el);

    const role = roleOf(el);
    const rawName = accessibleName(el);
    const nameBefore = rawName ? rt.scan(rawName) : "";
    rt.lastHits = 0;
    const name = rawName ? nameBefore || null : null;

    const vs = valueSlotFor(el, role, rt);
    const elementSensitive =
      vs?.kind === "redacted" ||
      rt.lastHits > 0 ||
      (el instanceof HTMLInputElement && el.type === "password");

    const isEditable =
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLSelectElement) ||
      (el as HTMLElement).isContentEditable ||
      (el instanceof HTMLInputElement &&
        !["button", "submit", "reset", "file", "hidden", "checkbox", "radio"].includes(el.type));

    if (elementSensitive) {
      sensitiveRects.push({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }

    elements.push({
      id,
      role,
      tag: el.tagName.toLowerCase(),
      name,
      value: vs,
      editable: isEditable,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      in_viewport:
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth,
      attributes: safeAttributes(el),
    });
  }

  const serializeStart = performance.now();
  const titleScanned = rt.scan(document.title);
  const screen: ScreenContext = {
    url_skeleton: urlSkeleton(location.href),
    title: titleScanned.slice(0, 160),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    frame_hash: "",
    elements,
    pii_refs: map.refs(),
    redaction_count: map.count,
    image_regions: [],
  };
  screen.frame_hash = frameHash([screen.url_skeleton, elements.map((e) => [e.role, e.name, e.value])]);
  const done = performance.now();

  return {
    screen,
    nodes,
    map,
    sensitiveRects,
    timings: {
      extract_ms: r1(serializeStart - t0 - rt.ms),
      redact_ms: r1(rt.ms),
      serialize_ms: r1(done - serializeStart),
    },
  };
}

function r1(n: number): number {
  return Math.max(0, Math.round(n * 10) / 10);
}
