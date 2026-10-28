/**
 * ONNX 模型文件的魔数校验（三个产物共用）。
 *
 * 背景：GitHub 镜像 / 订阅直链经常以 HTTP 200 返回 HTML 错误页或 JSON 报错。
 * 如果只判断「下载成功 + 体积够大」，这些垃圾会被写进 IndexedDB 缓存，
 * 之后每次建会话都失败，用户只能手动清缓存——所以下载落盘前必须先验魔数。
 *
 * ONNX 是 protobuf 编码的 ModelProto：首字节通常是 0x08（field 1 varint，ir_version），
 * 少数编码器用 0x0a（field 1 length-delimited）。这里只做「显然不是 ONNX」的排除。
 */

/** 判断 buffer 是否看起来像 ONNX 模型。minBytes 用于排除空响应/超短错误页。 */
export function looksLikeOnnxBuffer(buffer: ArrayBuffer | Uint8Array, minBytes = 1024): boolean {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < minBytes) return false;

  const head = bytes.subarray(0, Math.min(64, bytes.byteLength));
  if (head.length < 2) return false;
  // 常见「其实不是模型」的文件头
  if (head[0] === 0x50 && head[1] === 0x4b) return false; // ZIP（PK..）
  if (head[0] === 0x89 && head[1] === 0x50) return false; // PNG
  if (head[0] === 0xff && head[1] === 0xd8) return false; // JPEG
  if (head[0] === 0x7b) return false; // '{' —— JSON 错误响应
  if (head[0] === 0x3c) return false; // '<' —— HTML / XML 错误页
  if (head[0] === 0x67 && head[1] === 0x69) return false; // "gi" —— git LFS 指针
  return head[0] === 0x08 || head[0] === 0x0a;
}

/** 判断字符表（charsets.json）是否形如「非空字符串数组」。 */
export function isValidCharsets(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string');
}
