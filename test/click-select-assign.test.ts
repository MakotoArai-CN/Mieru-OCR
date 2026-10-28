import { expect, test } from 'bun:test';
import { assignTargets } from '../src/core/interaction/click-select-solver';

test('assignTargets picks the highest-confidence exact match', () => {
  const result = assignTargets(['春', '夏'], [
    { char: '夏', conf: 0.9 },
    { char: '春', conf: 0.8 },
  ]);
  expect(result).not.toBeNull();
  expect(result!.indices).toEqual([1, 0]);
  expect(result!.warnings).toEqual([]);
});

test('assignTargets uses distinct boxes for duplicate target characters', () => {
  const result = assignTargets(['天', '天'], [
    { char: '天', conf: 0.95 },
    { char: '天', conf: 0.6 },
    { char: '地', conf: 0.99 },
  ]);
  expect(result!.indices).toEqual([0, 1]);
});

test('assignTargets accepts multi-character box labels containing the target', () => {
  const result = assignTargets(['瓜'], [{ char: '西瓜', conf: 0.7 }]);
  expect(result!.indices).toEqual([0]);
});

test('assignTargets falls back to confusable glyphs instead of failing', () => {
  const result = assignTargets(['未'], [{ char: '末', conf: 0.8 }]);
  expect(result!.indices).toEqual([0]);
  expect(result!.warnings[0]).toContain('confusable');
});

test('assignTargets eliminates remaining boxes when counts match', () => {
  // det 漏标了「下」（OCR 空串），但候选数与目标数相同 → 用排除法补上
  const result = assignTargets(['上', '下'], [
    { char: '上', conf: 0.9 },
    { char: '', conf: 0.1 },
  ]);
  expect(result!.indices).toEqual([0, 1]);
  expect(result!.warnings[0]).toContain('eliminated');
});

test('assignTargets refuses when there are fewer boxes than targets', () => {
  expect(assignTargets(['甲', '乙'], [{ char: '甲', conf: 0.9 }])).toBeNull();
});

test('assignTargets refuses to guess when counts differ and nothing matches', () => {
  expect(assignTargets(['甲', '乙'], [
    { char: '甲', conf: 0.9 },
    { char: '丙', conf: 0.8 },
    { char: '丁', conf: 0.7 },
  ])).toBeNull();
});
