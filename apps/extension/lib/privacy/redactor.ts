import type { PiiKind, PiiRef } from "@pv/schema";

export class PlaceholderMap {
  private counters = new Map<PiiKind, number>();
  private values = new Map<string, { value: string; kind: PiiKind }>();

  register(value: string, kind: PiiKind): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const ref = `[${kind.toUpperCase()}_${n}]`;
    this.values.set(ref, { value, kind });
    return ref;
  }

  resolve(ref: string): string | null {
    return this.values.get(ref)?.value ?? null;
  }

  refs(): PiiRef[] {
    return Array.from(this.values.entries()).map(([ref, v]) => ({ ref, kind: v.kind }));
  }

  get count(): number {
    return this.values.size;
  }
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0 && digits.length >= 13;
}

interface Pattern {
  kind: PiiKind;
  re: RegExp;
  verify?: (match: string) => boolean;
}

const PATTERNS: Pattern[] = [
  { kind: "api_key", re: /\b(?:sk|gsk|pk_live|pk_test|api)[-_][A-Za-z0-9]{16,}\b/g },
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    kind: "card",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    verify: (m) => luhnValid(m[0].replace(/[ -]/g, "")),
  },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "aadhaar", re: /\b\d{4}[ -]\d{4}[ -]\d{4}\b/g },
  {
    kind: "phone",
    re: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{3}[\s.-]?\d{3}[\s.-]?\d{3,4}/g,
    verify: (m) => (m[0].match(/\d/g) ?? []).length >= 10,
  },
];

export function scanText(text: string, map: PlaceholderMap): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, (match) => {
      if (p.verify && !p.verify(match)) return match;
      hits++;
      return map.register(match, p.kind);
    });
  }
  return { text: out, hits };
}

export function classifySensitiveField(
  type: string | null,
  autocomplete: string | null
): PiiKind | null {
  const ac = (autocomplete ?? "").toLowerCase();
  if (type === "password") return "password";
  if (/cc-(csc|cvc|number)/.test(ac)) return ac.includes("csc") || ac.includes("cvc") ? "cvv" : "card";
  if (ac === "email") return "email";
  if (/^(tel|mobile|fax)/.test(ac)) return "phone";
  if (/^(name|given-name|family-name|additional-name|honorific-prefix|honorific-suffix|nickname)/.test(ac))
    return "person_name";
  if (/^(street-address|address-line|postal-code|address-level)/.test(ac)) return "address";
  if (/^bday/.test(ac)) return "dob";
  return null;
}
