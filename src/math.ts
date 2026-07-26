export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

export function linePath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) {
    return "";
  }
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x, 1)} ${round(point.y, 1)}`).join(" ");
}
