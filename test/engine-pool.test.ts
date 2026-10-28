import { expect, test } from 'bun:test';
import { EnginePool } from '../src/core/engine-pool';
import { OCREngine } from '../src/core/ocr-engine';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('concurrent requests share a single initialization', async () => {
  const loading = deferred<{ destroy(): Promise<void> }>();
  let creates = 0;
  const pool = new EnginePool(async () => { creates++; return loading.promise; });
  const requests = Array.from({ length: 3 }, () => pool.use('a', async engine => engine));
  const engine = { destroy: async () => {} };
  loading.resolve(engine);
  expect(await Promise.all(requests)).toEqual([engine, engine, engine]);
  expect(creates).toBe(1);
  await pool.invalidate();
});

test('eviction releases idle engines and retains recently used engines', async () => {
  const released: string[] = [];
  const pool = new EnginePool(async id => ({ destroy: async () => { released.push(id); } }));
  for (const id of ['a', 'b', 'a', 'c']) await pool.use(id, async () => {});
  expect(released).toEqual(['b']);
  await pool.invalidate();
  expect(released.sort()).toEqual(['a', 'b', 'c']);
});

test('invalidation during initialization or inference waits for the request to finish', async () => {
  const loading = deferred<void>(), running = deferred<void>(), started = deferred<void>();
  let released = 0, creates = 0;
  const pool = new EnginePool(async () => {
    creates++;
    await loading.promise;
    return { destroy: async () => { released++; } };
  });
  const request = pool.use('a', async () => { started.resolve(); await running.promise; });
  await pool.invalidate('a');
  loading.resolve();
  await started.promise;
  expect(released).toBe(0);
  await pool.use('a', async () => {});
  expect(creates).toBe(2);
  running.resolve();
  await request;
  expect(released).toBe(1);
  await pool.invalidate();
  expect(released).toBe(2);
});

test('failed initialization can be retried', async () => {
  let creates = 0;
  const pool = new EnginePool(async () => {
    if (++creates === 1) throw new Error('load failed');
    return { destroy: async () => {} };
  });
  await expect(pool.use('a', async () => {})).rejects.toThrow('load failed');
  await pool.use('a', async () => {});
  expect(creates).toBe(2);
  await pool.invalidate();
});

test('OCR init shares its promise and preserves the platform thread setting', async () => {
  let created = 0, released = 0;
  const ort = { env: { wasm: { numThreads: 1 } }, InferenceSession: { create: async () => {
    created++;
    return { release: async () => { released++; } };
  } } };
  const engine = new OCREngine({ getOrt: async () => ort, getModel: async () => ({ model: new ArrayBuffer(1), charsets: [''] }) });
  await Promise.all([engine.init(), engine.init(), engine.init()]);
  expect(created).toBe(1);
  expect(ort.env.wasm.numThreads).toBe(1);
  await Promise.all([engine.destroy(), engine.destroy()]);
  expect(released).toBe(1);
});
