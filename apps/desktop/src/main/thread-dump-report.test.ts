import { describe, expect, it } from "vitest";
import { parseThreadDumpReport } from "./thread-dump-report.js";

const report = `Tanwei Thread Dump
formatVersion=1
capturedAt=2026-07-30T22:00:00Z
processId=42
jvmStartTimeMillis=1785450000000
javaVersion=21.0.8
threadsSeen=3
threadsSelected=3
truncated=false
maximumStackDepth=256
monitorsIncluded=true
synchronizersIncluded=true
deadlockedThreads=1

"blocked-worker" #7 state=BLOCKED cpuTimeNanos=12000 deadlocked=true
  waitingOn=java.lang.Object@123 owner=#8 "lock-owner"
    at example.Work.run(Work.java:42)
      - locked java.lang.Object@456
    Locked ownable synchronizers:
      - java.util.concurrent.locks.ReentrantLock$NonfairSync@789

"idle-worker" #8 state=WAITING cpuTimeNanos=-1 deadlocked=false
    at java.lang.Object.wait(Native Method)
`;

describe("thread dump report parser", () => {
  it("parses metadata, states, stacks and lock relationships", () => {
    const parsed = parseThreadDumpReport(report, "artifact-1");

    expect(parsed.processId).toBe(42);
    expect(parsed.jvmStartTimeMillis).toBe("1785450000000");
    expect(parsed.threadsSeen).toBe(3);
    expect(parsed.stateCounts).toEqual({
      BLOCKED: 1,
      WAITING: 1,
    });
    expect(parsed.threads).toHaveLength(2);
    expect(parsed.threads[0]).toMatchObject({
      id: "7",
      name: "blocked-worker",
      state: "BLOCKED",
      cpuTimeNanos: "12000",
      deadlocked: true,
      waitingOn: "java.lang.Object@123",
      lockOwnerId: "8",
      lockOwnerName: "lock-owner",
      stack: ["example.Work.run(Work.java:42)"],
      monitors: ["java.lang.Object@456"],
      synchronizers: [
        "java.util.concurrent.locks.ReentrantLock$NonfairSync@789",
      ],
    });
    expect(parsed.threads[1]?.cpuTimeNanos).toBeNull();
  });

  it("rejects unknown signatures and format versions", () => {
    expect(() =>
      parseThreadDumpReport("other\n", "artifact-1"),
    ).toThrow(/signature/u);
    expect(() =>
      parseThreadDumpReport(
        report.replace("formatVersion=1", "formatVersion=2"),
        "artifact-1",
      ),
    ).toThrow(/version/u);
  });

  it("rejects oversized individual lines", () => {
    expect(() =>
      parseThreadDumpReport(
        `${report}\n${"x".repeat(4_097)}`,
        "artifact-1",
      ),
    ).toThrow(/4096/u);
  });
});
