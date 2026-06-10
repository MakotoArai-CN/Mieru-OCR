/**
 * 校验 public/common_det.onnx 的完整性，并打印输入/输出张量信息，
 * 用来核对 DetectionEngine 的预处理假设（输入名、(1,3,416,416)、输出维度）。
 *
 *   bun run scripts/verify-det-model.ts
 *
 * 用 onnxruntime-node（cpu EP）仅做「能否解析 protobuf + 构建图」的完整性校验，
 * 与 DetectionEngine 走的 web/wasm EP 无关——这里只关心模型文件本身没坏。
 */
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';

const MODEL = resolve(import.meta.dir, '../public/common_det.onnx');
const EXPECTED_SIZE = 20127694;

async function main() {
  const st = statSync(MODEL);
  console.log(`文件大小: ${st.size} bytes (期望 ${EXPECTED_SIZE}, 差 ${EXPECTED_SIZE - st.size})`);
  if (st.size !== EXPECTED_SIZE) {
    console.warn('⚠️  大小与期望不一致——可能仍在下载或被截断');
  }

  const buf = readFileSync(MODEL);
  const b0 = buf[0];
  console.log(`首字节: 0x${b0.toString(16).padStart(2, '0')} (ONNX 通常为 0x08)`);
  if (b0 !== 0x08 && b0 !== 0x0a) {
    console.error('❌ 首字节不像 ONNX protobuf，文件可能损坏');
    process.exit(1);
  }

  const ort = await import('onnxruntime-node');
  console.log('正在用 onnxruntime-node 加载（cpu EP，仅校验解析）...');
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'] });

  console.log('✅ protobuf 解析 + 图构建成功');
  console.log('输入:');
  for (const name of session.inputNames) {
    const meta: any = (session as any).inputMetadata?.[name];
    console.log(`  - ${name}`, meta ? JSON.stringify({ type: meta.type, dims: meta.dimensions ?? meta.shape }) : '(无 metadata)');
  }
  console.log('输出:');
  for (const name of session.outputNames) {
    const meta: any = (session as any).outputMetadata?.[name];
    console.log(`  - ${name}`, meta ? JSON.stringify({ type: meta.type, dims: meta.dimensions ?? meta.shape }) : '(无 metadata)');
  }

  // 跑一次 416×416 全 114 的 dummy 输入，确认推理通路 + 输出维度。
  const S = 416;
  const data = new Float32Array(3 * S * S).fill(114);
  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor('float32', data, [1, 3, S, S]);
  const out = await session.run({ [inputName]: tensor });
  const outName = session.outputNames[0];
  const o: any = out[outName];
  console.log(`\nDummy 推理输出 [${outName}] dims=${JSON.stringify(o.dims)} (期望 [1, 3549, 类别数+5])`);
  console.log('   3549 = 52²+26²+13² = strides[8,16,32] 的 anchor 总数 → 与 DetectionEngine.getGrid 一致' );
}

main().catch((e) => {
  console.error('❌ 校验失败:', e.message || e);
  process.exit(1);
});
