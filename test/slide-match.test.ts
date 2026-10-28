import { expect, test } from 'bun:test';
import { matchTemplate, type GrayImage } from '../src/core/slide-detector';

function reference(image: GrayImage, template: GrayImage) {
  let score = -Infinity, bestX = 0, bestY = 0;
  const t = [...template.data], mean = t.reduce((a, b) => a + b, 0) / t.length;
  for (let y = 0; y <= image.height - template.height; y++) {
    for (let x = 0; x <= image.width - template.width; x++) {
      const window = t.map((_, i) => image.data[(y + Math.floor(i / template.width)) * image.width + x + i % template.width]);
      const wm = window.reduce((a, b) => a + b, 0) / t.length;
      const numerator = t.reduce((sum, value, i) => sum + (value - mean) * (window[i] - wm), 0);
      const denom = Math.sqrt(t.reduce((sum, value) => sum + (value - mean) ** 2, 0) * window.reduce((sum, value) => sum + (value - wm) ** 2, 0));
      const candidate = denom > 1e-9 ? numerator / denom : 0;
      if (candidate > score) { score = candidate; bestX = x; bestY = y; }
    }
  }
  return { x: bestX, y: bestY, score };
}

for (const sparse of [false, true]) {
  test(`optimized NCC matches reference (${sparse ? 'sparse edges' : 'grayscale'})`, () => {
    for (let sample = 1; sample <= 8; sample++) {
      const image = { width: 19, height: 14, data: Float32Array.from({ length: 266 }, (_, i) => ((i * 37 + sample * 17) ** 2 % 251) / 3) };
      const template = { width: 4, height: 3, data: Float32Array.from({ length: 12 }, (_, i) => sparse ? (i % 3 ? 0 : 255) : ((i + 1) * sample * 13 % 127)) };
      const expected = reference(image, template), actual = matchTemplate(image, template);
      expect(actual.x).toBe(expected.x);
      expect(actual.y).toBe(expected.y);
      expect(actual.score).toBeCloseTo(expected.score, 8);
    }
  });
}

test('constant templates and oversized templates retain their behavior', () => {
  const image = { width: 5, height: 5, data: new Float32Array(25).fill(7) };
  expect(matchTemplate(image, { width: 2, height: 2, data: new Float32Array(4) }).score).toBe(0);
  expect(() => matchTemplate(image, { ...image, width: 6 })).toThrow('larger than image');
});
