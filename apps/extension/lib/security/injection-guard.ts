import type { ScreenContext } from "@pv/schema";

const BLOCK = "[INJECTION_BLOCKED]";

const HIDDEN_CHARS = /[\u200B\u200C\u200D\u2060\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|directions?)\b/gi,
  /\b(reveal|expose|print|show|leak|output|repeat)\b[^.\n]{0,30}\b(placeholders?|refs?|values?|passwords?|secrets?|credentials?)\b/gi,
  /\b(you are now|act as|pretend to be|behave as if)\b/gi,
  /(?:^|\n)[ \t]*(system|assistant|developer)[ \t]*:/gi,
  /<\|(?:im_start|im_end|endoftext)\|>|\[INST\]|\[\/INST\]/gi,
  /\b(send|upload|post|forward|email)\b[^.\n]{0,40}\b(api[ -]?keys?|clipboard|pii|credentials?|placeholders?|the refs?)\b/gi,
  /\b(bypass|disable|turn off|switch off)\b[^.\n]{0,30}\b(safety|guardrails?|filters?|restrictions?|security|redaction)\b/gi,
  /\b(new|updated) instructions?[ \t]*:/gi,
  /\bimportant (?:note|message) (?:from|for) (?:the )?(?:developer|admin|system)/gi,
];

export interface ScrubResult {
  text: string;
  hits: number;
}

export function scrubText(text: string): ScrubResult {
  let hits = 0;

  const stripped = text.replace(HIDDEN_CHARS, () => {
    hits++;
    return "";
  });

  let out = stripped;
  for (let i = 0; i < PATTERNS.length; i++) {
    out = out.replace(PATTERNS[i], () => {
      hits++;
      return BLOCK;
    });
  }

  return { text: out, hits };
}

function scrubSlot(value: ScreenContext["elements"][number]["value"]): {
  value: ScreenContext["elements"][number]["value"];
  hits: number;
} {
  if (value?.kind !== "text") return { value, hits: 0 };
  const r = scrubText(value.text);
  if (r.hits === 0) return { value, hits: 0 };
  return { value: { kind: "text", text: r.text }, hits: r.hits };
}

export interface GuardResult {
  screen: ScreenContext;
  flaggedIds: number[];
  hits: number;
}

export function sanitizeScreen(screen: ScreenContext): GuardResult {
  const flaggedIds: number[] = [];
  let totalHits = 0;

  const elements = screen.elements.map((el) => {
    const nameScrub = el.name ? scrubText(el.name) : null;
    const valueScrub = scrubSlot(el.value);
    const hits = (nameScrub?.hits ?? 0) + valueScrub.hits;
    if (hits === 0) return el;

    flaggedIds.push(el.id);
    totalHits += hits;
    return {
      ...el,
      name: nameScrub ? nameScrub.text || null : el.name,
      value: valueScrub.value,
    };
  });

  const titleScrub = scrubText(screen.title);
  if (titleScrub.hits > 0) totalHits += titleScrub.hits;

  if (totalHits === 0) return { screen, flaggedIds, hits: 0 };

  return {
    screen: {
      ...screen,
      title: titleScrub.text.slice(0, 160),
      elements,
    },
    flaggedIds,
    hits: totalHits,
  };
}
