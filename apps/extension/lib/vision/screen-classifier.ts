import { pipeline } from '@huggingface/transformers';

export interface ScreenClassification {
  label: string;
  score: number;
}

const extUrl = (p: string): string =>
  (browser.runtime.getURL as unknown as (path: string) => string)(p);

const INIT_TIMEOUT_MS = 90_000;
const INFER_TIMEOUT_MS = 45_000;

let classifierInstance: any = null;
let permanentlyUnavailable = false;
let announcedFailure = false;
let lastError = '';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function prefetchAllFiles(): Promise<void> {
  const files = ['config.json', 'preprocessor_config.json', 'onnx/model_quantized.onnx'];
  await Promise.all(
    files.map((f) => fetch(extUrl(`models/vit-base-patch16-224/${f}`)).then((r) => r.blob()))
  );
}

async function initClassifier(): Promise<void> {
  if (classifierInstance || permanentlyUnavailable) return;

  try {
    await withTimeout(prefetchAllFiles(), 15_000, 'model file prefetch');
    classifierInstance = await withTimeout(
      pipeline('image-classification', extUrl('models/vit-base-patch16-224'), { device: 'wasm' }),
      INIT_TIMEOUT_MS,
      'ViT model load'
    );
  } catch (_e) {
    try {
      classifierInstance = await withTimeout(
        pipeline('image-classification', 'Xenova/vit-base-patch16-224', { device: 'wasm' }),
        INIT_TIMEOUT_MS,
        'ViT model load (fallback)'
      );
    } catch (e2) {
      permanentlyUnavailable = true;
      lastError = e2 instanceof Error ? e2.message : String(e2);
    }
  }
}

export async function classifyScreen(imageDataUrl: string): Promise<ScreenClassification[]> {
  if (permanentlyUnavailable) {
    if (!announcedFailure) {
      announcedFailure = true;
      throw new Error(lastError || 'screen classifier unavailable');
    }
    return [];
  }

  try {
    await initClassifier();
  } catch (e) {
    permanentlyUnavailable = true;
    announcedFailure = true;
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }

  if (!classifierInstance) return [];

  try {
    const results = await withTimeout(
      classifierInstance(imageDataUrl, { topk: 5 }),
      INFER_TIMEOUT_MS,
      'ViT inference'
    );
    return results as ScreenClassification[];
  } catch (error) {
    console.error('Failed to classify screen:', error);
    permanentlyUnavailable = true;
    announcedFailure = true;
    lastError = error instanceof Error ? error.message : String(error);
    throw new Error(lastError);
  }
}
