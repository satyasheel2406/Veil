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

export interface NerResult {
  screen: ScreenContext;
  maskedCount: number;
}

export async function nerEnrichScreen(screen: ScreenContext): Promise<NerResult> {
  let masked = 0;
  let counter = REF_OFFSET;

  const piiRefs: PiiRef[] = [...screen.pii_refs];

  const scrubElement = (el: ElementNode): void => {
    if (el.value?.kind !== "text") return;
    const hits = heuristicNameHits(el.value.text);
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
    scrubElement(el);
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
