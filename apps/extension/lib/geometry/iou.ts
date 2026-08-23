export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

export function greedyMatchIoU(
  predicted: Box[],
  groundTruth: Box[],
  threshold = 0.5
): { matches: number; ious: number[]; meanMatchedIoU: number } {
  const remaining = [...groundTruth];
  const ious: number[] = [];
  for (const p of predicted) {
    let bestIdx = -1;
    let bestVal = 0;
    remaining.forEach((g, idx) => {
      const v = iou(p, g);
      if (v > bestVal) {
        bestVal = v;
        bestIdx = idx;
      }
    });
    if (bestIdx >= 0 && bestVal >= threshold) {
      ious.push(bestVal);
      remaining.splice(bestIdx, 1);
    }
  }
  const mean = ious.length ? ious.reduce((s, v) => s + v, 0) / ious.length : 0;
  return { matches: ious.length, ious, meanMatchedIoU: mean };
}
