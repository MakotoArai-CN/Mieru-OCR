/**
 * 完整性校验（SHA-256），用于订阅指定的检测模型直链下载防篡改。
 * 浏览器环境用 Web Crypto（crypto.subtle），service worker / offscreen / content 均可用。
 */

/** 计算 buffer 的 SHA-256，返回小写 hex。 */
export async function sha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  // 统一成一个明确的 ArrayBuffer 传给 digest（规避 TS DOM 对 SharedArrayBuffer 的严格类型）。
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', ab);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export interface IntegrityResult {
  ok: boolean;
  actual: string;
  expected?: string;
}

/**
 * 校验 buffer 的 SHA-256 是否匹配 expectedHex。
 * 未提供 expectedHex 时视为通过（ok=true），仅返回实际哈希供调用方记录。
 */
export async function verifyIntegrity(
  buffer: ArrayBuffer | Uint8Array,
  expectedHex?: string,
): Promise<IntegrityResult> {
  const actual = await sha256Hex(buffer);
  if (!expectedHex) return { ok: true, actual };
  const expected = expectedHex.trim().toLowerCase();
  return { ok: actual === expected, actual, expected };
}
