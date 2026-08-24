import type { SensitiveRect } from "./screenshot";

/**
 * Opt-in OCR pass (default OFF). When enabled, renders-in-image text
 * (<canvas>, <svg>, <img> pixels) that DOM extraction can never see is
 * recognized on-device and blacked out before the screenshot leaves the machine.
 *
 * tesseract.js is imported dynamically so it never touches the main bundles.
 * Worker/wasm/lang assets are fetched lazily at first use — an explicit,
 * user-consented download — and failures degrade gracefully (OCR simply has
 * no effect for that frame). Upgrade path: host assets in public/ or run in
 * an offscreen document.
 */

export interface OcrResult {
  rects: SensitiveRect[];
  available: boolean;
}

let enginePromise: Promise<TesseractishWorker | null> | null = null;
let permanentlyUnavailable = false;

interface TesseractishWord {
  text?: string;
  confidence?: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

interface TesseractishBlock {
  paragraphs?: Array<{ lines?: Array<{ words?: TesseractishWord[] }> }>;
}

interface TesseractishWorker {
  recognize: (
    image: string | Blob,
    options?: Record<string, unknown>,
    output?: Record<string, unknown>
  ) => Promise<{
    data: {
      text?: string;
      words?: TesseractishWord[];
      blocks?: TesseractishBlock[] | null;
    };
  }>;
  terminate: () => Promise<void>;
}

// Patterns mirror lib/privacy/redactor.ts but standalone — OCR blackouts are
// purely visual; values are never registered as placeholder refs.
const TEXT_PATTERNS: RegExp[] = [
  /\b(?:sk|gsk|pk_live|pk_test|api|AIza)[-_][A-Za-z0-9_-]{15,}\b/, // api keys
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
  /\b(?:\d[ -]?){12,18}\d\b/, // card-ish digit runs
  /\b\d{3}-\d{2}-\d{4}\b/, // ssn
  /\b\d{4}[ -]\d{4}[ -]\d{4}\b/, // aadhaar
  /(?:\+?\d[\d\s().-]{8,17}\d)/, // phone-ish
];

function looksSensitive(text: string): boolean {
  return TEXT_PATTERNS.some((re) => re.test(text));
}

async function getEngine(): Promise<TesseractishWorker | null> {
  if (permanentlyUnavailable) return null;
  if (!enginePromise) {
    enginePromise = (async () => {
      try {
        const mod = await import("tesseract.js");
        const createWorker = mod.createWorker as unknown as (
          lang: string
        ) => Promise<TesseractishWorker>;
        return await createWorker("eng");
      } catch {
        // Service workers often cannot spawn tesseract's worker script;
        // remember the failure so we do not retry every frame.
        permanentlyUnavailable = true;
        return null;
      }
    })();
  }
  return enginePromise;
}

function collectWords(data: { words?: TesseractishWord[]; blocks?: TesseractishBlock[] | null }): TesseractishWord[] {
  const flat = data.words ?? [];
  if (flat.length > 0) return flat;
  const out: TesseractishWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        out.push(...(line.words ?? []));
      }
    }
  }
  return out;
}

export async function detectSensitiveTextRects(bitmap: ImageBitmap): Promise<OcrResult> {
  const engine = await getEngine();
  if (!engine) return { rects: [], available: false };

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return { rects: [], available: false };
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });

    const { data } = await engine.recognize(blob, {}, { blocks: true });
    const rects: SensitiveRect[] = [];
    for (const w of collectWords(data)) {
      const text = (w.text ?? "").trim();
      if (!text || !w.bbox) continue;
      if ((w.confidence ?? 0) < 55) continue;
      if (!looksSensitive(text)) continue;
      rects.push({
        x: Math.max(0, Math.round(w.bbox.x0) - 3),
        y: Math.max(0, Math.round(w.bbox.y0) - 3),
        w: Math.round(w.bbox.x1 - w.bbox.x0) + 6,
        h: Math.round(w.bbox.y1 - w.bbox.y0) + 6,
      });
    }
    return { rects, available: true };
  } catch {
    return { rects: [], available: false };
  }
}
