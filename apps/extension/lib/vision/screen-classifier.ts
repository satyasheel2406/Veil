import { pipeline } from '@huggingface/transformers';

export interface ScreenClassification {
  label: string;
  score: number;
}

// Nothing in the vision path may ever stall an agent turn indefinitely.
const INIT_TIMEOUT_MS = 90_000;
const INFER_TIMEOUT_MS = 45_000;

let classifierInstance: any = null;
let isInitializing = false;
let initPromise: Promise<void> | null = null;
let permanentlyUnavailable = false;
let announcedFailure = false;
let lastError = "";

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function initClassifier(): Promise<void> {
  if (classifierInstance || permanentlyUnavailable) return;
  if (isInitializing && initPromise) {
    await initPromise;
    return;
  }

  isInitializing = true;
  initPromise = (async () => {
    try {
      // wasm only: WebGPU in MV3 service workers is flaky and has been
      // observed hanging mid-inference with no error surfaced.
      classifierInstance = await withTimeout(
        pipeline('image-classification', 'Xenova/vit-base-patch16-224', { device: 'wasm' }),
        INIT_TIMEOUT_MS,
        'ViT model load'
      );
    } catch (e) {
      permanentlyUnavailable = true;
      lastError = e instanceof Error ? e.message : String(e);
    }
  })();

  try {
    await initPromise;
  } finally {
    isInitializing = false;
  }
}

export async function classifyScreen(imageDataUrl: string): Promise<ScreenClassification[]> {
  if (permanentlyUnavailable) {
    // Surface the failure exactly once (the caller logs it); stay silent after.
    if (!announcedFailure) {
      announcedFailure = true;
      throw new Error(lastError || "screen classifier unavailable");
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
