import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { classifySensitiveField, PlaceholderMap, scanText } from "../../privacy/redactor";
import { maskCuedNames } from "../../privacy/ner";
import { guessFromContext } from "../../perception/dom-extractor";
import { greedyMatchIoU, type Box } from "../../geometry/iou";

interface FixtureElement {
  id: number;
  role: string;
  tag: string;
  name: string | null;
  value_text: string | null;
  editable: boolean;
  rect: Box;
  attributes: Record<string, string>;
}

interface Layout {
  name: string;
  elements: FixtureElement[];
  ground_truth: Box[];
}

const { layouts } = JSON.parse(
  readFileSync(new URL("../../../../../eval/fixtures/layouts.json", import.meta.url), "utf-8")
) as { layouts: Layout[] };

// Mirrors the production decision precedence in dom-extractor.inputSlot:
// semantic classification first (type/autocomplete), label context second,
// content regex scan third, greeting-cue name masking last — applied to both
// the value and the visible name.
function predictedRedactionRects(els: FixtureElement[]): Box[] {
  const map = new PlaceholderMap();
  const out: Box[] = [];
  for (const el of els) {
    let sensitive = false;

    const forced =
      classifySensitiveField(el.attributes.type ?? null, el.attributes.autocomplete ?? null) ??
      guessFromContext(el.attributes, el.name ?? "");
    if (el.editable && guessed(forced)) sensitive = true;

    if (!sensitive && el.value_text && scanText(el.value_text, map).hits > 0) sensitive = true;
    if (!sensitive && el.name) {
      if (
        scanText(el.name, map).hits > 0 ||
        maskCuedNames(el.name, (v, k) => map.register(v, k)) !== null
      ) {
        sensitive = true;
      }
    }

    if (sensitive) out.push(el.rect);
  }
  return out;
}

function guessed(kind: string | null): boolean {
  return kind !== null;
}

describe("redaction precision vs labeled layouts", () => {
  for (const layout of layouts) {
    it(`layout: ${layout.name}`, () => {
      const pred = predictedRedactionRects(layout.elements);
      const gt = layout.ground_truth;

      const { matches, meanMatchedIoU } = greedyMatchIoU(pred, gt, 0.5);
      const precision = pred.length === 0 ? 1 : matches / pred.length;
      const recall = gt.length === 0 ? 1 : matches / gt.length;

      console.log(
        `[layout-iou] ${layout.name.padEnd(20)} P=${(precision * 100).toFixed(1)}% ` +
          `R=${(recall * 100).toFixed(1)}% IoU=${meanMatchedIoU.toFixed(3)} ` +
          `(${matches}/${pred.length} boxes vs ${gt.length} gt)`
      );
    });
  }

  it("aggregate meets SIH targets (P>=85%, R>=90%)", () => {
    let tp = 0;
    let np = 0;
    let ng = 0;
    for (const layout of layouts) {
      const { matches } = greedyMatchIoU(predictedRedactionRects(layout.elements), layout.ground_truth, 0.5);
      tp += matches;
      np += predictedRedactionRects(layout.elements).length;
      ng += layout.ground_truth.length;
    }
    const precision = np === 0 ? 1 : tp / np;
    const recall = ng === 0 ? 1 : tp / ng;
    console.log(
      `[layout-iou] AGGREGATE precision=${(precision * 100).toFixed(1)}% recall=${(recall * 100).toFixed(1)}% over ${layouts.length} layouts`
    );
    if (precision < 0.85 || recall < 0.9) {
      throw new Error(`targets missed: P=${precision.toFixed(2)} R=${recall.toFixed(2)}`);
    }
  });
});
