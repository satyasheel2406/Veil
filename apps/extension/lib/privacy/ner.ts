import type { ElementNode, PiiKind, PiiRef, ScreenContext } from "@pv/schema";

const REF_OFFSET = 100;

interface NerHit {
  text: string;
  kind: PiiKind;
}

const STOPWORDS = new Set([
  "the","this","that","please","enter","your","you","our","we","my","me","i","a","an","and","or",
  "for","with","from","into","onto","about","above","below","over","under","again","then","once",
  "here","there","when","where","why","how","all","any","both","each","few","more","most","other",
  "some","such","only","own","same","so","than","too","very","can","will","just","should","now",
  "new","old","see","two","way","who","its","did","yes","also","user","name","email","address",
  "card","bank","account","password","login","sign","page","home","next","back","done","edit",
  "delete","save","cancel","submit","search","menu","profile","settings","help","contact","terms",
  "privacy","policy","copyright","rights","reserved","inc","ltd","llc","corp","company","limited",
]);

function isCandidateToken(t: string): boolean {
  if (t.length < 2 || t.length > 20) return false;
  if (!/^[A-Z][a-z'’-]+$/.test(t)) return false;
  return !STOPWORDS.has(t.toLowerCase());
}

export function heuristicNameHits(text: string): NerHit[] {
  const hits: NerHit[] = [];
  const tokens = text.split(/(\s+)/);

  let run: string[] = [];
  let runStartIdx = 0;

  const flush = (endExclusive: number) => {
    if (run.length >= 2 && run.length <= 4) {
      hits.push({
        text: tokens.slice(runStartIdx, endExclusive).join(""),
        kind: "person_name",
      });
    }
    run = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^\s+$/.test(tok)) continue;
    if (isCandidateToken(tok)) {
      if (run.length === 0) runStartIdx = i;
      run.push(tok);

      const nextTok = tokens[i + 2] ?? "";
      const nextIsName = /^[A-Z][a-z]/.test(nextTok) && !STOPWORDS.has(nextTok.toLowerCase());
      if (!nextIsName) flush(i + 1);
    } else {
      flush(i);
    }
  }
  return dedupe(hits);
}

function dedupe(hits: NerHit[]): NerHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.kind}:${h.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Greeting/address cues that precede the user's name in page text
// ("Welcome back, John Doe", "Logged in as Jane Doe", "Dear John Doe,").
const NAME_CUE_RE =
  /\b(?:welcome back|welcome|logged[ -]?in as|signed[ -]?in as|my name is|i am|dear)\b[:,]?\s+((?:[A-Z][a-z'’-]+)(?:\s+[A-Z][a-z'’-]+){0,3})/gi;

export function cuedNameHits(text: string): NerHit[] {
  const hits: NerHit[] = [];
  NAME_CUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_CUE_RE.exec(text)) !== null) {
    const candidate = m[1].trim();
    const words = candidate.split(/\s+/);
    if (words.length >= 2 && words.length <= 4) {
      hits.push({ text: candidate, kind: "person_name" });
    }
  }
  return dedupe(hits);
}

/** Replace cued person names with placeholder refs. Returns null when untouched. */
export function maskCuedNames(text: string, register: (value: string, kind: PiiKind) => string): string | null {
  const hits = cuedNameHits(text);
  if (hits.length === 0) return null;
  let out = text;
  for (const h of [...hits].sort((a, b) => b.text.length - a.text.length)) {
    if (!out.includes(h.text)) continue;
    out = out.split(h.text).join(register(h.text, h.kind));
  }
  return out === text ? null : out;
}

export interface NerResult {
  screen: ScreenContext;
  maskedCount: number;
}

export async function nerEnrichScreen(screen: ScreenContext): Promise<NerResult> {
  let masked = 0;
  let counter = REF_OFFSET;

  const piiRefs: PiiRef[] = [...screen.pii_refs];

  const { detectEntitiesML } = await import("./ml-ner");

  const scrubElement = async (el: ElementNode): Promise<void> => {
    if (el.value?.kind !== "text") return;
    
    let hits = await detectEntitiesML(el.value.text);
    if (hits.length === 0) {
       // Fallback to heuristic if ML found nothing (or hasn't loaded)
       hits = heuristicNameHits(el.value.text).map(h => ({ ...h, score: 1.0 }));
    }

    let text = el.value.text;
    for (const h of [...hits].sort((a, b) => b.text.length - a.text.length)) {
      if (!text.includes(h.text)) continue;
      const ref = `[${h.kind.toUpperCase()}_${counter++}]`;
      text = text.split(h.text).join(ref);
      piiRefs.push({ ref, kind: h.kind });
      masked++;
    }
    if (hits.length > 0) el.value = { kind: "text", text };
  };

  for (const el of screen.elements) {
    await scrubElement(el);
  }

  return {
    screen: {
      ...screen,
      pii_refs: piiRefs.slice(0, 200),
      redaction_count: screen.redaction_count + masked,
    },
    maskedCount: masked,
  };
}
