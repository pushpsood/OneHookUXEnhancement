import type { ContainerClient } from '@azure/storage-blob';

/**
 * An in-memory blob container with the conditional-write semantics the stores rely on (ifNoneMatch '*',
 * ifMatch ETag; 412 otherwise) and 404 on reading a missing blob.
 */
export class MemoryContainer {
  readonly blobs = new Map<string, Buffer>();
  readonly etags = new Map<string, string>();
  private nextEtag = 1;
  /** Names that fail every operation (storage outage for one member). */
  failPrefix: string | undefined;

  private fail(name: string): void {
    if (this.failPrefix && name.startsWith(this.failPrefix)) throw Object.assign(new Error('storage down'), { statusCode: 500 });
  }

  getBlockBlobClient(name: string) {
    const missing = () => Object.assign(new Error('BlobNotFound'), { statusCode: 404 });
    return {
      exists: async () => { this.fail(name); return this.blobs.has(name); },
      downloadToBuffer: async () => {
        this.fail(name);
        const blob = this.blobs.get(name);
        if (!blob) throw missing();
        return Buffer.from(blob);
      },
      getProperties: async () => {
        this.fail(name);
        if (!this.blobs.has(name)) throw missing();
        return { etag: this.etags.get(name) };
      },
      deleteIfExists: async () => {
        this.fail(name);
        const deleted = this.blobs.delete(name);
        this.etags.delete(name);
        return { succeeded: deleted };
      },
      uploadData: async (data: Uint8Array, options?: { conditions?: { ifMatch?: string; ifNoneMatch?: string } }) => {
        this.fail(name);
        const currentEtag = this.etags.get(name);
        if (options?.conditions?.ifNoneMatch === '*' && this.blobs.has(name)) {
          throw Object.assign(new Error('Precondition failed'), { statusCode: 412 });
        }
        if (options?.conditions?.ifMatch && options.conditions.ifMatch !== currentEtag) {
          throw Object.assign(new Error('Precondition failed'), { statusCode: 412 });
        }
        const etag = `etag-${this.nextEtag++}`;
        this.blobs.set(name, Buffer.from(data));
        this.etags.set(name, etag);
        return { etag };
      },
    };
  }

  async *listBlobsFlat(options: { prefix?: string }) {
    for (const name of [...this.blobs.keys()]) {
      if (!options.prefix || name.startsWith(options.prefix)) yield { name };
    }
  }

  asContainer(): ContainerClient {
    return this as unknown as ContainerClient;
  }

  names(prefix = ''): string[] {
    return [...this.blobs.keys()].filter((n) => n.startsWith(prefix)).sort();
  }
}
