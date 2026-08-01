import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ring-buffer";

describe("RingBuffer", () => {
  it("keeps only the newest values in insertion order", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.append(1);
    buffer.append(2);
    buffer.append(3);
    buffer.append(4);

    expect(buffer.size).toBe(3);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
  });

  it("rejects invalid capacities and clears retained values", () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError);
    const buffer = new RingBuffer<string>(2);
    buffer.append("value");
    buffer.clear();

    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
  });
});
