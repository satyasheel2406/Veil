import { pipeline, env } from '@huggingface/transformers';

export interface ScreenClassification {
  label: string;
  score: number;
}

let classifierInstance: any = null;
let isInitializing = false;
let initPromise: Promise<void> | null = null;

async function initClassifier() {
  if (classifierInstance) return;
  if (isInitializing && initPromise) {
    await initPromise;
    return;
  }

  isInitializing = true;
  initPromise = (async () => {
    // Configure transformers env if needed
    // env.allowLocalModels = false;

    try {
      // Try WebGPU first
      classifierInstance = await pipeline('image-classification', 'Xenova/vit-base-patch16-224', {
        device: 'webgpu'
      });
    } catch (e) {
      console.warn('WebGPU fallback to wasm for ViT classifier:', e);
      // Fallback to WASM
      classifierInstance = await pipeline('image-classification', 'Xenova/vit-base-patch16-224', {
        device: 'wasm'
      });
    }
    isInitializing = false;
  })();

  await initPromise;
}

export async function classifyScreen(imageDataUrl: string): Promise<ScreenClassification[]> {
  try {
    await initClassifier();
    
    if (!classifierInstance) {
      return [];
    }

    const results = await classifierInstance(imageDataUrl, { topk: 5 });
    return results as ScreenClassification[];
  } catch (error) {
    console.error('Failed to classify screen:', error);
    return [];
  }
}
