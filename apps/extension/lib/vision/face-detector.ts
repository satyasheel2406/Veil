import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { browser } from "wxt/browser";
import { offscreenSupported, requestOffscreen } from "./offscreen-bridge";

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

let detectorPromise: Promise<FaceDetector> | null = null;

const extUrl = (p: string): string =>
  (browser.runtime.getURL as unknown as (path: string) => string)(p);

async function createDetector(): Promise<FaceDetector> {
  const errors: string[] = [];
  try {
    const fileset = await FilesetResolver.forVisionTasks(extUrl("tasks-vision"));
    const modelUrl = extUrl("models/blaze_face_short_range.tflite");
    for (const delegate of ["GPU", "CPU"] as const) {
      try {
        return await FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: modelUrl, delegate },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.5,
        });
      } catch (e) {
        errors.push(`${delegate}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    errors.push(`fileset: ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(errors.join(" | ") || "unknown face detector failure");
}

export async function getFaceDetector(): Promise<FaceDetector> {
  if (!detectorPromise) {
    detectorPromise = createDetector().catch((e) => {
      detectorPromise = null;
      throw e;
    });
  }
  return detectorPromise;
}

const PADDING = 0.25;

// ---------------------------------------------------------------------------
// Chrome path: run MediaPipe in the offscreen document. The MV3 service
// worker cannot importScripts() after installation, which is how tasks-vision
// loads its wasm glue — a hidden DOM page has no such restriction.

const OFFSCREEN_UNSUPPORTED = Symbol("offscreen-unsupported");

async function detectFacesOffscreen(
  dataUrl: string
): Promise<FaceBox[] | typeof OFFSCREEN_UNSUPPORTED> {
  if (!offscreenSupported()) return OFFSCREEN_UNSUPPORTED;
  // Real errors surface verbatim — never masked by the legacy attempt.
  const resp = await requestOffscreen<{ ok: true; faces?: FaceBox[] }>(
    { type: "DETECT_FACES", dataUrl },
    30000,
    "face detect"
  );
  return resp.faces ?? [];
}

/**
 * Detect faces on a raw frame. Prefers the offscreen document (Chrome);
 * falls back to direct in-context detection ONLY where offscreen cannot
 * exist at all (e.g. Firefox background pages, which have full DOM access).
 */
export async function detectFacesSmart(
  dataUrl: string,
  canvas: OffscreenCanvas
): Promise<{ faces: FaceBox[]; viaOffscreen: boolean }> {
  const result = await detectFacesOffscreen(dataUrl);
  if (result === OFFSCREEN_UNSUPPORTED) {
    return { faces: await detectFaces(canvas), viaOffscreen: false };
  }
  return { faces: result, viaOffscreen: true };
}

export async function detectFaces(canvas: OffscreenCanvas): Promise<FaceBox[]> {
  const detector = await getFaceDetector();
  const result = detector.detect(canvas);
  const out: FaceBox[] = [];
  for (const d of result.detections ?? []) {
    const bb = d.boundingBox;
    if (!bb) continue;
    const px = bb.width * PADDING;
    const py = bb.height * PADDING * 1.4;
    out.push({
      x: Math.max(0, Math.round(bb.originX - px)),
      y: Math.max(0, Math.round(bb.originY - py)),
      w: Math.min(canvas.width, Math.round(bb.width + px * 2)),
      h: Math.round(bb.height + py * 2),
    });
  }
  return out;
}
