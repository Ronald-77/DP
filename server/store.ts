import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseShape } from './types.js';

export class MetadataStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  async load(fallback: DatabaseShape): Promise<DatabaseShape> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    try {
      return JSON.parse(await readFile(this.filename, 'utf8')) as DatabaseShape;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.save(fallback);
      return structuredClone(fallback);
    }
  }

  async save(value: DatabaseShape): Promise<void> {
    const snapshot = JSON.stringify(value, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.filename}.tmp`;
      await writeFile(temporary, snapshot, 'utf8');
      await rename(temporary, this.filename);
    });
    return this.writeQueue;
  }
}
