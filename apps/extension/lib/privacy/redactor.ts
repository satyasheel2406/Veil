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

  serialize(): string {
    const data: Record<string, { value: string; kind: PiiKind }> = {};
    for (const [ref, v] of this.values) {
      data[ref] = v;
    }
    const counters: Record<string, number> = {};
    for (const [kind, n] of this.counters) {
      counters[kind] = n;
    }
    return JSON.stringify({ data, counters });
  }

  static deserialize(json: string): PlaceholderMap {
    const map = new PlaceholderMap();
    try {
      const parsed = JSON.parse(json);
      if (parsed.data) {
        for (const [ref, v] of Object.entries(parsed.data)) {
          const val = v as { value: string; kind: PiiKind };
          map.values.set(ref, val);
        }
      }
      if (parsed.counters) {
        for (const [kind, n] of Object.entries(parsed.counters)) {
          map.counters.set(kind as PiiKind, n as number);
        }
      }
    } catch {
      // Return empty map on parse failure
    }
    return map;
  }

  merge(other: PlaceholderMap): void {
    for (const [ref, v] of other.values) {
      if (!this.values.has(ref)) {
        this.values.set(ref, v);
      }
    }
    for (const [kind, n] of other.counters) {
      const existing = this.counters.get(kind) ?? 0;
      if (n > existing) {
        this.counters.set(kind, n);
      }
    }
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
  {
    kind: "api_key",
    // Prefixed vendor keys (sk-..., gsk_...) plus Google-style AIza keys,
    // which carry NO separator between prefix and body.
    re: /\b(?:(?:sk|gsk|pk_live|pk_test|api)[-_][A-Za-z0-9_-]{15,}|AIza[A-Za-z0-9_-]{20,})\b/g,
  },
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    kind: "card",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    verify: (m) => luhnValid(m.replace(/[ -]/g, "")),
  },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    // Bank account identifiers written inline ("Account: 123456789",
    // "acct no 0012345678"). Requires an explicit keyword + digit run so
    // ordinary numbers never trip it.
    kind: "other",
    re: /\b(?:account|acct)\s*(?:no\.?|number|#)?\s*[:#-]?\s*\d{8,17}\b/gi,
  },
  {
    kind: "aadhaar",
    re: /(?<![\d][ -])\b\d{4}[ -]\d{4}[ -]\d{4}(?!\s?\d)/g,
  },
  {
    kind: "phone",
    re: /(?<![\w])(?:[+(]?\d[\d\s().-]{6,17}\d)(?![\w])/g,
    verify: (m) => {
      const digits = (m.match(/\d/g) ?? []).length;
      if (digits < 10 || digits > 13) return false;
      const groups = m.split(/[^\d]+/).filter(Boolean);
      if (groups.length === 4 && groups.every((g) => g.length <= 3)) return false;
      // Long unseparated digit runs are ambiguous (order ids, tracking codes),
      // not phone numbers.
      if (groups.length === 1 && digits > 11) return false;
      return true;
    },
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
