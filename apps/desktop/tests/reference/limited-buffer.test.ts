import { describe, expect, it } from "vitest";
import { LimitedBuffer } from "./limited-buffer.js";

describe("LimitedBuffer", () => {
  it("collects ten thousand chunks with bounded append work", () => {
    const collector = new LimitedBuffer(10_000);

    for (let index = 0; index < 10_000; index += 1) {
      collector.append(Buffer.from([index % 251]));
    }

    expect(collector.byteLength).toBe(10_000);
    expect(collector.chunkCount).toBe(10_000);
    expect(collector.value()).toHaveLength(10_000);
  });

  it("rejects the first chunk beyond the limit without changing state", () => {
    const collector = new LimitedBuffer(4);
    collector.append(Buffer.from("test"));

    expect(() => collector.append(Buffer.from("!"))).toThrow(
      "远程命令输出超过安全上限",
    );
    expect(collector.byteLength).toBe(4);
    expect(collector.value().toString("utf8")).toBe("test");
  });

  it("rejects invalid limits", () => {
    expect(() => new LimitedBuffer(-1)).toThrow(RangeError);
    expect(() => new LimitedBuffer(Number.MAX_VALUE)).toThrow(RangeError);
  });
});
