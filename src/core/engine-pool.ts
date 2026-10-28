interface DisposableEngine {
  destroy(): Promise<void>;
}

interface Entry<T> {
  engine: Promise<T>;
  users: number;
  retired: boolean;
  disposing?: Promise<void>;
}

/** Share initialization and keep sessions alive until their last request finishes. */
export class EnginePool<T extends DisposableEngine> {
  private entries = new Map<string, Entry<T>>();

  constructor(private create: (id: string) => Promise<T>, private capacity = 2) {
    if (capacity < 1) throw new Error('Engine pool capacity must be positive');
  }

  async use<R>(id: string, task: (engine: T) => Promise<R>): Promise<R> {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { engine: Promise.resolve().then(() => this.create(id)), users: 0, retired: false };
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    entry.users++;
    try {
      let engine: T;
      try {
        engine = await entry.engine;
      } catch (error) {
        if (this.entries.get(id) === entry) this.entries.delete(id);
        entry.retired = true;
        throw error;
      }
      return await task(engine);
    } finally {
      entry.users--;
      if (entry.retired) await this.dispose(entry);
      await this.trim();
    }
  }

  async invalidate(id?: string): Promise<void> {
    const retired: Entry<T>[] = [];
    for (const [key, entry] of this.entries) {
      if (id !== undefined && id !== key) continue;
      this.entries.delete(key);
      entry.retired = true;
      retired.push(entry);
    }
    await Promise.all(retired.map(entry => this.dispose(entry)));
  }

  private async trim(): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      if (entry.users > 0) continue;
      this.entries.delete(id);
      entry.retired = true;
      await this.dispose(entry);
    }
  }

  private async dispose(entry: Entry<T>): Promise<void> {
    if (entry.users > 0) return;
    entry.disposing ??= entry.engine.then(
      engine => engine.destroy().catch(error => console.warn('Engine release failed:', error)),
      () => {},
    );
    await entry.disposing;
  }
}
