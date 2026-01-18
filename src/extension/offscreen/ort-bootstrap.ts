(() => {
  const base: string = chrome.runtime.getURL('/');
  const g = globalThis as Record<string, any>;
  if (!g.ortConfig) g.ortConfig = {};
  g.ortConfig.base = base;
  g.ortConfig.numThreads = 1;
  g.ortConfig.simd = true;
  g.ortConfig.proxy = false;
})();