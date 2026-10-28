import { describe, expect, test } from 'bun:test';
import { looksLikeOnnxBuffer, isValidCharsets } from '../src/core/onnx-validate';

function bufferWithHead(head: number[], size = 4096): ArrayBuffer {
  const bytes = new Uint8Array(size);
  head.forEach((value, index) => { bytes[index] = value; });
  return bytes.buffer;
}

describe('onnx magic validation', () => {
  test('accepts protobuf-encoded model headers', () => {
    expect(looksLikeOnnxBuffer(bufferWithHead([0x08, 0x07]))).toBe(true);
    expect(looksLikeOnnxBuffer(bufferWithHead([0x0a, 0x10, 0x01]))).toBe(true);
  });

  test('rejects error pages and non-model payloads', () => {
    expect(looksLikeOnnxBuffer(bufferWithHead([0x3c, 0x21]))).toBe(false); // <!doctype html
    expect(looksLikeOnnxBuffer(bufferWithHead([0x7b, 0x22]))).toBe(false); // {"error":...
    expect(looksLikeOnnxBuffer(bufferWithHead([0x50, 0x4b]))).toBe(false); // ZIP
    expect(looksLikeOnnxBuffer(bufferWithHead([0x89, 0x50]))).toBe(false); // PNG
    expect(looksLikeOnnxBuffer(bufferWithHead([0xff, 0xd8]))).toBe(false); // JPEG
    expect(looksLikeOnnxBuffer(bufferWithHead([0x67, 0x69]))).toBe(false); // git-lfs pointer
  });

  test('rejects truncated or empty responses', () => {
    expect(looksLikeOnnxBuffer(new ArrayBuffer(0))).toBe(false);
    expect(looksLikeOnnxBuffer(bufferWithHead([0x08], 16))).toBe(false);
    expect(looksLikeOnnxBuffer(bufferWithHead([0x08], 4096), 8192)).toBe(false);
  });

  test('accepts Uint8Array input and honours the min size override', () => {
    const small = new Uint8Array([0x08, 0x07]);
    expect(looksLikeOnnxBuffer(small, 2)).toBe(true);
    expect(looksLikeOnnxBuffer(small)).toBe(false);
  });
});

describe('charsets validation', () => {
  test('accepts non-empty string arrays', () => {
    expect(isValidCharsets(['a', 'b'])).toBe(true);
    expect(isValidCharsets(['汉'])).toBe(true);
  });

  test('rejects malformed charsets', () => {
    expect(isValidCharsets([])).toBe(false);
    expect(isValidCharsets('abc')).toBe(false);
    expect(isValidCharsets([1, 2])).toBe(false);
    expect(isValidCharsets(null)).toBe(false);
    expect(isValidCharsets({ 0: 'a' })).toBe(false);
  });
});
