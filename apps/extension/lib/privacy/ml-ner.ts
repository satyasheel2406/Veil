import { pipeline } from '@huggingface/transformers';
import type { PiiKind } from '@pv/schema';

export interface NerHit {
  text: string;
  kind: PiiKind;
  score: number;
}

let nerInstance: any = null;
let initPromise: Promise<void> | null = null;
let isInitializing = false;

async function initNer() {
  if (nerInstance) return;
  if (isInitializing && initPromise) {
    await initPromise;
    return;
  }
  isInitializing = true;
  initPromise = (async () => {
    try {
      // Use quantized distilbert NER model for fast browser inference
      nerInstance = await pipeline('token-classification', 'Xenova/distilbert-base-uncased-finetuned-conll03-english', {
        device: 'wasm', // NER models usually run well on WASM
      });
    } catch (e) {
      console.warn('Failed to load NER model:', e);
    } finally {
      isInitializing = false;
    }
  })();
  await initPromise;
}

export async function detectEntitiesML(text: string): Promise<NerHit[]> {
  await initNer();
  if (!nerInstance || !text.trim()) return [];

  try {
    // ignore_labels: [] means don't ignore anything. 
    // Transformers.js provides grouped entities if configured, but we can do it manually.
    const results = await nerInstance(text, { ignore_labels: [] });
    
    // Group adjacent PER (person) tokens
    const hits: NerHit[] = [];
    let currentEntity = "";
    let currentScore = 0;
    let count = 0;

    const flush = () => {
      if (currentEntity && count > 0) {
        // Clean up subword artifacts like '##'
        const cleanText = currentEntity.replace(/ ##/g, '').replace(/##/g, '').trim();
        if (cleanText.length > 2) {
            hits.push({ text: cleanText, kind: 'person_name', score: currentScore / count });
        }
      }
      currentEntity = "";
      currentScore = 0;
      count = 0;
    };

    for (const r of results) {
      const entityGroup = r.entity_group || r.entity; // Depending on Transformers.js version
      if (entityGroup === 'B-PER' || entityGroup === 'I-PER' || entityGroup === 'PER') {
        if (entityGroup === 'B-PER') flush();
        
        if (currentEntity) {
            // Handle subwords (##) or regular words
            if (r.word.startsWith('##')) {
                currentEntity += r.word.substring(2);
            } else {
                currentEntity += ' ' + r.word;
            }
        } else {
            currentEntity = r.word.startsWith('##') ? r.word.substring(2) : r.word;
        }
        currentScore += r.score;
        count++;
      } else {
        flush();
      }
    }
    flush();
    
    return hits;
  } catch (e) {
    console.error('ML NER Error:', e);
    return [];
  }
}
