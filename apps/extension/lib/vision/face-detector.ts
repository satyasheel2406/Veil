import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
import { browser } from "wxt/browser";

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
  const fileset = await FilesetResolver.forVisionTasks(extUrl("tasks-vision"));
  const modelUrl = extUrl("models/blaze_face_short_range.tflite");
  try {
    return await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    });
  } catch {
    return await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    });
  }
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
