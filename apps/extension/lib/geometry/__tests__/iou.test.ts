import { describe, expect, it } from "vitest";
import { greedyMatchIoU, iou } from "../iou";

describe("IoU geometry", () => {
  it("returns 1 for identical boxes", () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1);
  });

  it("returns 0 for disjoint boxes", () => {
    expect(iou({ x: 0, y: 0, w: 5, h: 5 }, { x: 10, y: 10, w: 5, h: 5 })).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    const v = iou({ x: 0, y: 0, w: 4, h: 4 }, { x: 2, y: 2, w: 4, h: 4 });
    expect(v).toBeCloseTo(4 / 28, 6);
  });
});

describe("greedyMatchIoU", () => {
  it("matches predictions to ground truth above threshold", () => {
    const gt = [
      { x: 0, y: 0, w: 100, h: 30 },
      { x: 0, y: 50, w: 200, h: 30 },
    ];
    const pred = [
      { x: 2, y: 1, w: 98, h: 29 },
      { x: 500, y: 500, w: 50, h: 20 },
      { x: 1, y: 51, w: 198, h: 29 },
    ];
    const r = greedyMatchIoU(pred, gt, 0.5);
    expect(r.matches).toBe(2);
    expect(r.meanMatchedIoU).toBeGreaterThan(0.9);
  });

  it("never matches a ground truth box twice", () => {
    const gt = [{ x: 0, y: 0, w: 10, h: 10 }];
    const pred = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 1, y: 1, w: 9, h: 9 },
    ];
    const r = greedyMatchIoU(pred, gt, 0.5);
    expect(r.matches).toBe(1);
  });
});
