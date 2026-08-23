import { describe, expect, it } from "vitest";
import { PlaceholderMap, scanText } from "../redactor";
import type { PiiKind } from "@pv/schema";

interface Sample {
  text: string;
  hit: boolean;
  kind?: PiiKind;
}

const CORPUS: Sample[] = [
  { text: "Contact john.doe@gmail.com for details", hit: true, kind: "email" },
  { text: "Email: a+b@subdomain.test.co.in today", hit: true, kind: "email" },
  { text: "reach me at first_last99@outlook.com", hit: true, kind: "email" },
  { text: "+91 98765 43210", hit: true, kind: "phone" },
  { text: "(555) 123-4567", hit: true, kind: "phone" },
  { text: "555-867-5309", hit: true, kind: "phone" },
  { text: "Card 4532 0151 1283 0366 expires soon", hit: true, kind: "card" },
  { text: "6011-1111-1111-1117", hit: true, kind: "card" },
  { text: "Amex 378282246310005 on file", hit: true, kind: "card" },
  { text: "SSN 123-45-6789 verified", hit: true, kind: "ssn" },
  { text: "Aadhaar 2345 4321 5678 linked", hit: true, kind: "aadhaar" },
  { text: "IBAN DE89370400440532013000", hit: true, kind: "iban" },
  { text: "key sk-proj-abcdef1234567890abcdef leaked", hit: true, kind: "api_key" },

  { text: "Report filed in 2024 and revised in 2025", hit: false },
  { text: "Order #12345 shipped yesterday", hit: false },
  { text: "Invoice INV-2026-0042 pending", hit: false },
  { text: "Server at 192.168.1.100 responded", hit: false },
  { text: "Version 1.2.3 build 4567 installed", hit: false },
  { text: "Card 4444555566667777 is invalid (checksum fails)", hit: false },
  { text: "Meeting room booked for 12:45", hit: false },
  { text: "Price $1,299.99 including tax", hit: false },
];

function detect(text: string): { detected: boolean; kinds: PiiKind[] } {
  const map = new PlaceholderMap();
  const out = scanText(text, map).text;
  const kinds = Array.from(map.refs().map((r) => r.kind));
  return { detected: out !== text, kinds };
}

describe("PII detection engine", () => {
  const results = CORPUS.map((s) => ({ ...s, ...detect(s.text) }));

  const tp = results.filter((r) => r.hit && r.detected).length;
  const fp = results.filter((r) => !r.hit && r.detected).length;
  const fn = results.filter((r) => r.hit && !r.detected).length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;

  it.each(results.filter((s) => s.hit))("detects: $text", (s) => {
    expect(s.detected, `MISSED (FN): "${s.text}"`).toBe(true);
  });

  it.each(results.filter((s) => !s.hit))("ignores: $text", (s) => {
    expect(s.detected, `FALSE POSITIVE: "${s.text}"`).toBe(false);
  });

  it(`meets SIH targets — precision ${(precision * 100).toFixed(0)}% >= 85%, recall ${(recall * 100).toFixed(0)}% >= 90%`, () => {
    console.info(
      `[pii-metrics] TP=${tp} FP=${fp} FN=${fn} TN=${results.length - tp - fp - fn} | ` +
        `precision=${(precision * 100).toFixed(1)}% recall=${(recall * 100).toFixed(1)}%`
    );
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(precision).toBeGreaterThanOrEqual(0.85);
  });

  it("tags detected values with the right PII kind", () => {
    for (const s of results.filter((r) => r.hit && r.kind && r.detected)) {
      if (s.kind === "card") continue;
      expect(s.kinds, `"${s.text}"`).toContain(s.kind);
    }
  });
});

describe("PlaceholderMap", () => {
  it("produces stable incrementing refs per kind", () => {
    const map = new PlaceholderMap();
    const r1 = map.register("a@b.com", "email");
    const r2 = map.register("c@d.com", "email");
    const p1 = map.register("+91 98765 43210", "phone");
    expect(r1).toBe("[EMAIL_1]");
    expect(r2).toBe("[EMAIL_2]");
    expect(p1).toBe("[PHONE_1]");
    expect(map.resolve(r1)).toBe("a@b.com");
    expect(map.resolve("[EMAIL_9]")).toBeNull();
  });

  it("never exposes raw values through refs()", () => {
    const map = new PlaceholderMap();
    map.register("secret-password", "password");
    const json = JSON.stringify(map.refs());
    expect(json).not.toContain("secret-password");
  });

  it("Luhn rejects invalid cards while accepting valid ones", () => {
    const map = new PlaceholderMap();
    const good = scanText("Pay with 5500005555555559 now", map).hits;
    const bad = scanText("Pay with 4444555566667777 now", map).hits;
    expect(good).toBe(1);
    expect(bad).toBe(0);
  });
});
