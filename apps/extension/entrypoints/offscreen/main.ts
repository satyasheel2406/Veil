import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { browser } from "wxt/browser";
import { collectWords, looksSensitive, type TesseractishWord } from "@/lib/vision/ocr";
import type { SensitiveRect } from "@/lib/vision/screenshot";

// Hidden DOM page: hosts the on-device vision models that cannot run in the
// MV3 service worker (importScripts-after-install restriction, hidden-doc
// DOM image decoding). Chrome-only; Firefox uses in-context fallbacks.

const extUrl = (p: string): string =>
  (browser.runtime.getURL as unknown as (path: string) => string)(p);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Face detection (MediaPipe BlazeFace)

let detectorPromise: Promise<FaceDetector> | null = null;

async function getDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(extUrl("tasks-vision"));
      const modelUrl = extUrl("models/blaze_face_short_range.tflite");
      const errors: string[] = [];
      // CPU first: hidden-document GPU/WebGL has proven hang-prone, and a
      // 256KB blaze model needs no GPU. GPU kept as fallback.
      for (const delegate of ["CPU", "GPU"] as const) {
        try {
          const det = await withTimeout(
            FaceDetector.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: modelUrl, delegate },
              runningMode: "IMAGE",
              minDetectionConfidence: 0.4,
            }),
            15000,
            `${delegate} init`
          );
          console.info(`[veil/off] face detector ready (${delegate})`);
          return det;
        } catch (e) {
          errors.push(`${delegate}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw new Error(errors.join(" | "));
    })().catch((e) => {
      detectorPromise = null;
      throw e;
    });
  }
  return detectorPromise;
}

// Pre-warm: start loading the wasm glue + model as soon as this page exists,
// so the first DETECT_FACES request doesn't pay init cost inside its timeout.
void getDetector().catch(() => {});

interface RawBox {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

function iou(a: RawBox, b: RawBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter === 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(boxes: RawBox[], threshold: number): RawBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep: RawBox[] = [];
  for (const box of sorted) {
    if (keep.every((k) => iou(k, box) < threshold)) keep.push(box);
  }
  return keep;
}

/** Detect on one image source; returns tile-local boxes with scores. */
function detectOn(detector: FaceDetector, source: ImageBitmap | OffscreenCanvas): RawBox[] {
  const out: RawBox[] = [];
  for (const d of detector.detect(source).detections ?? []) {
    const bb = d.boundingBox;
    if (!bb) continue;
    out.push({
      x: bb.originX,
      y: bb.originY,
      w: bb.width,
      h: bb.height,
      score: d.categories?.[0]?.score ?? 0.5,
    });
  }
  return out;
}

/**
 * Tiled detection: BlazeFace prefers large faces, so grid portraits in a
 * full-screen capture often go unnoticed. Run the full frame plus four
 * overlapping 60% tiles (small faces become relatively larger), then merge
 * with NMS. Tile origins offset detections back to frame coordinates.
 */
function detectFacesTiled(detector: FaceDetector, bitmap: ImageBitmap): RawBox[] {
  const boxes: RawBox[] = detectOn(detector, bitmap);

  const tw = Math.round(bitmap.width * 0.6);
  const th = Math.round(bitmap.height * 0.6);
  const xs = [0, bitmap.width - tw];
  const ys = [0, bitmap.height - th];
  for (const ox of xs) {
    for (const oy of ys) {
      const tile = new OffscreenCanvas(tw, th);
      const tctx = tile.getContext("2d");
      if (!tctx) continue;
      tctx.drawImage(bitmap, ox, oy, tw, th, 0, 0, tw, th);
      for (const b of detectOn(detector, tile)) {
        boxes.push({ ...b, x: b.x + ox, y: b.y + oy });
      }
    }
  }
  return nms(boxes, 0.45);
}

const PADDING = 0.25;

// ---------------------------------------------------------------------------
// OCR (opt-in, lazy — tesseract fetches worker/wasm/lang data on first use,
// which stays an explicit user-consented download; never pre-warmed).

let ocrPromise: Promise<TesseractWorkerish | null> | null = null;
let ocrDead = false;

interface TesseractWorkerish {
  recognize: (
    image: Blob,
    options?: Record<string, unknown>,
    output?: Record<string, unknown>
  ) => Promise<{ data: { words?: TesseractishWord[]; blocks?: unknown } }>;
}

async function getOcrEngine(): Promise<TesseractWorkerish | null> {
  if (ocrDead) return null;
  if (!ocrPromise) {
    ocrPromise = (async () => {
      try {
        console.info("[veil/off] initializing OCR engine…");
        // Import tesseract's own ESM bundle from our extension files — the
        // npm package gets silently dropped by the bundler, and CDN/blob
        // workers are blocked by MV3 CSP. Same-origin import keeps CSP happy.
        const mod = (await withTimeout(
          import(/* @vite-ignore */ extUrl("tesseract/tesseract.esm.min.js")),
          15000,
          "tesseract module load"
        )) as { default?: { createWorker?: unknown }; createWorker?: unknown };
        // The esm build ships createWorker only as a default-export property.
        const impl = (mod.default ?? mod) as { createWorker?: unknown };
        const createWorker = impl.createWorker as (
          lang: string,
          oem: number,
          opts: Record<string, unknown>
        ) => Promise<TesseractWorkerish>;
        if (typeof createWorker !== "function") {
          throw new Error("tesseract.esm did not expose createWorker");
        }
        // Self-hosted assets: default CDN paths spawn blob: workers that MV3
        // CSP blocks. Same-origin files keep CSP 'self' happy and work offline.
        const worker = await withTimeout(
          createWorker("eng", 1, {
            workerPath: extUrl("tesseract/worker.min.js"),
            corePath: extUrl("tesseract/core"),
            langPath: extUrl("tesseract/lang"),
            workerBlobURL: false,
          }),
          60000,
          "ocr engine init"
        );
        console.info("[veil/off] OCR engine ready");
        return worker;
      } catch (e) {
        ocrDead = true;
        console.warn("[veil/off] OCR init failed:", e);
        return null;
      }
    })();
  }
  return ocrPromise;
}

async function runOcr(dataUrl: string): Promise<{ rects: SensitiveRect[]; available: boolean }> {
  const engine = await getOcrEngine();
  if (!engine) return { rects: [], available: false };
  const blob = await (await fetch(dataUrl)).blob();
  const { data } = await engine.recognize(blob, {}, { blocks: true });
  const rects: SensitiveRect[] = [];
  for (const w of collectWords(data as Parameters<typeof collectWords>[0])) {
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
}

// ---------------------------------------------------------------------------
// Message wiring

interface DetectMsg {
  target?: string;
  type?: string;
  dataUrl?: string;
}

browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as DetectMsg;
  if (msg?.target !== "offscreen") return;

  if (msg.type === "DETECT_FACES") {
    void (async () => {
      let bitmap: ImageBitmap | null = null;
      try {
        console.info("[veil/off] DETECT_FACES received");
        if (!msg.dataUrl) throw new Error("missing dataUrl");
        const detector = await getDetector();
        // No <img>: hidden documents defer DOM image decoding indefinitely.
        const blob = await (await fetch(msg.dataUrl)).blob();
        bitmap = await withTimeout(createImageBitmap(blob), 5000, "bitmap decode");
        console.info("[veil/off] frame decoded, running tiled detect…");
        const merged = detectFacesTiled(detector, bitmap);
        const faces = merged.map((b) => {
          const px = b.w * PADDING;
          const py = b.h * PADDING * 1.4;
          return {
            x: Math.max(0, Math.round(b.x - px)),
            y: Math.max(0, Math.round(b.y - py)),
            w: Math.min(bitmap!.width, Math.round(b.w + px * 2)),
            h: Math.round(b.h + py * 2),
          };
        });
        console.info(`[veil/off] detect done: ${faces.length} face(s)`);
        sendResponse({ ok: true, faces });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      } finally {
        bitmap?.close();
      }
    })();
    return true;
  }

  if (msg.type === "OCR_TEXT") {
    void (async () => {
      try {
        console.info("[veil/off] OCR_TEXT received");
        if (!msg.dataUrl) throw new Error("missing dataUrl");
        const result = await runOcr(msg.dataUrl);
        console.info(`[veil/off] ocr done: ${result.rects.length} sensitive rect(s)`);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), available: false });
      }
    })();
    return true;
  }
});
