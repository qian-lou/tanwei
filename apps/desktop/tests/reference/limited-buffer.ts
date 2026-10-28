export class LimitedBuffer {
  readonly #maximumBytes: number;
  readonly #chunks: Buffer<ArrayBufferLike>[] = [];
  #byteLength = 0;

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError("maximumBytes 必须是非负安全整数");
    }
    this.#maximumBytes = maximumBytes;
  }

  /**
   * Appends one chunk without copying previously received data.
   *
   * Total append time is O(N); materialization performs one final O(N) copy.
   */
  append(chunk: Buffer<ArrayBufferLike>): void {
    const nextLength = this.#byteLength + chunk.length;
    if (!Number.isSafeInteger(nextLength) || nextLength > this.#maximumBytes) {
      throw new Error("远程命令输出超过安全上限");
    }
    if (chunk.length === 0) {
      return;
    }
    this.#chunks.push(chunk);
    this.#byteLength = nextLength;
  }

  value(): Buffer<ArrayBufferLike> {
    return Buffer.concat(this.#chunks, this.#byteLength);
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  get chunkCount(): number {
    return this.#chunks.length;
  }
}
