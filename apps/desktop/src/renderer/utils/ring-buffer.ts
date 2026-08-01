export class RingBuffer<T> {
  readonly #items: Array<T | undefined>;
  #head = 0;
  #size = 0;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("RingBuffer capacity must be a positive integer");
    }
    this.#items = new Array<T | undefined>(capacity);
  }

  get capacity(): number {
    return this.#items.length;
  }

  get size(): number {
    return this.#size;
  }

  append(value: T): void {
    const index = (this.#head + this.#size) % this.capacity;
    this.#items[index] = value;
    if (this.#size < this.capacity) {
      this.#size += 1;
      return;
    }
    this.#head = (this.#head + 1) % this.capacity;
  }

  clear(): void {
    this.#items.fill(undefined);
    this.#head = 0;
    this.#size = 0;
  }

  toArray(): readonly T[] {
    const result = new Array<T>(this.#size);
    for (let index = 0; index < this.#size; index += 1) {
      result[index] = this.#items[(this.#head + index) % this.capacity] as T;
    }
    return result;
  }
}
