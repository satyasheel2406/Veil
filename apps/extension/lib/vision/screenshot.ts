import type { ImageRegion } from "@pv/schema";
import { detectFaces, type FaceBox } from "./face-detector";
import { detectSensitiveTextRects } from "./ocr";

export interface SensitiveRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisionResult {
  region: ImageRegion | null;
  facesBlurred: number;
  detectorAvailable: boolean;
  ocrMasked: number;
  ocrAvailable: boolean;
}

const REGION_REF = "[SCREEN_1]";

async function toBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

function expand(r: SensitiveRect, pad = 4): SensitiveRect {
  return {
    x: Math.max(0, r.x - pad),
    y: Math.max(0, r.y - pad),
    w: r.w + pad * 2,
    h: r.h + pad * 2,
  };
}

function blackOut(ctx: OffscreenCanvasRenderingContext2D, r: SensitiveRect): void {
  ctx.save();
  ctx.fillStyle = "#0b0b0f";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = "rgba(99,102,241,0.55)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
  ctx.restore();
}

function blurRegion(
  ctx: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  r: SensitiveRect
): boolean {
  try {
    const w = Math.max(2, Math.round(r.w));
    const h = Math.max(2, Math.round(r.h));
    const tmp = new OffscreenCanvas(w, h);
    const tctx = tmp.getContext("2d");
    if (!tctx) return false;
    tctx.filter = "blur(14px)";
    tctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, w, h);
    tctx.filter = "none";
    ctx.drawImage(tmp, r.x, r.y);
    return true;
  } catch {
    return false;
  }
}

export async function redactScreenshot(
  dataUrl: string,
  sensitiveRects: SensitiveRect[],
  dpr: number,
  blurFaces: boolean,
  ocrEnabled = false
): Promise<VisionResult> {
  const bitmap = await toBitmap(dataUrl);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) return { region: null, facesBlurred: 0, detectorAvailable: false, ocrMasked: 0, ocrAvailable: false };
  ctx.drawImage(bitmap, 0, 0);

  // Vision-first pass: the on-device models evaluate the RAW frame and decide
  // additional regions to redact — including faces and rendered-in-image text
  // that DOM inspection can never see. Failure here never blocks DOM blackouts.
  let faceBoxes: FaceBox[] = [];
  let detectorAvailable = true;
  try {
    faceBoxes = await detectFaces(canvas);
  } catch {
    faceBoxes = [];
    detectorAvailable = false;
  }

  let ocrMasked = 0;
  let ocrAvailable = false;
  if (ocrEnabled) {
    try {
      const ocr = await detectSensitiveTextRects(bitmap);
      ocrAvailable = ocr.available;
      for (const r of ocr.rects) {
        blackOut(ctx, expand(r));
        ocrMasked++;
      }
    } catch {
      ocrAvailable = false;
    }
  }
  bitmap.close();

  for (const raw of sensitiveRects) {
    blackOut(ctx, expand({ ...raw, x: raw.x * dpr, y: raw.y * dpr, w: raw.w * dpr, h: raw.h * dpr }));
  }

  let facesBlurred = 0;
  for (const f of faceBoxes) {
    const ok = blurFaces && blurRegion(ctx, canvas, f);
    if (!ok) blackOut(ctx, f);
    facesBlurred++;
  }

  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.72 });
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return {
    region: {
      ref: REGION_REF,
      mime: "image/webp",
      width: canvas.width,
      height: canvas.height,
      data_b64: btoa(binary),
    },
    facesBlurred,
    detectorAvailable,
    ocrMasked,
    ocrAvailable,
  };
}
