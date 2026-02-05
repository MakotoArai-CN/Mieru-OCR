export interface SiteStats {
  count: number;
  lastTime: number;
  totalTime: number;
}

export interface StatsData {
  sites: Record<string, SiteStats>;
  total: number;
  updated: number;
}

const STATS_KEY = 'ddddocr_stats';
const MAX_SITES = 100;

export class StatisticsManager {
  private data: StatsData;
  private storage: {
    get: (key: string) => any;
    set: (key: string, value: any) => void;
  };
  private dirty = false;
  private saveTimer: number | null = null;

  constructor(storage: { get: (key: string) => any; set: (key: string, value: any) => void }) {
    this.storage = storage;
    this.data = this.load();
  }

  private load(): StatsData {
    const stored = this.storage.get(STATS_KEY);
    if (stored && typeof stored === 'object' && stored.sites) {
      return stored as StatsData;
    }
    return { sites: {}, total: 0, updated: Date.now() };
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.flush();
      this.saveTimer = null;
    }, 5000);
  }

  flush(): void {
    if (this.dirty) {
      this.data.updated = Date.now();
      this.storage.set(STATS_KEY, this.data);
      this.dirty = false;
    }
  }

  record(hostname: string, elapsed: number): void {
    if (!this.data.sites[hostname]) {
      if (Object.keys(this.data.sites).length >= MAX_SITES) {
        this.pruneOldest();
      }
      this.data.sites[hostname] = { count: 0, lastTime: 0, totalTime: 0 };
    }
    const site = this.data.sites[hostname];
    site.count++;
    site.lastTime = Date.now();
    site.totalTime += elapsed;
    this.data.total++;
    this.dirty = true;
    this.scheduleSave();
  }

  private pruneOldest(): void {
    const entries = Object.entries(this.data.sites);
    entries.sort((a, b) => a[1].lastTime - b[1].lastTime);
    const toRemove = entries.slice(0, 10);
    for (const [key] of toRemove) {
      delete this.data.sites[key];
    }
  }

  getStats(): StatsData {
    return { ...this.data };
  }

  getSiteStats(hostname: string): SiteStats | null {
    return this.data.sites[hostname] || null;
  }

  getTopSites(limit = 10): Array<{ hostname: string; stats: SiteStats }> {
    return Object.entries(this.data.sites)
      .map(([hostname, stats]) => ({ hostname, stats }))
      .sort((a, b) => b.stats.count - a.stats.count)
      .slice(0, limit);
  }

  getAverageTime(hostname?: string): number {
    if (hostname) {
      const site = this.data.sites[hostname];
      return site && site.count > 0 ? Math.round(site.totalTime / site.count) : 0;
    }
    if (this.data.total === 0) return 0;
    const totalTime = Object.values(this.data.sites).reduce((sum, s) => sum + s.totalTime, 0);
    return Math.round(totalTime / this.data.total);
  }

  clear(): void {
    this.data = { sites: {}, total: 0, updated: Date.now() };
    this.dirty = true;
    this.flush();
  }
}