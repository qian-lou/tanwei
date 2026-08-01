// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseThreadPoolInspection } from "./thread-pool-inspection";

describe("thread-pool inspection parser", () => {
  it("parses exact members and bounded scan evidence", () => {
    const inspection = parseThreadPoolInspection({
      count: "1",
      queriedTypes: "3",
      requestedMemberLimit: "100",
      includeEvidence: "true",
      requestedQueueTaskLimit: "100",
      scannedThreads: "37",
      discoveredMembers: "2",
      returnedMembers: "2",
      boundary: "identity association",
      "pool.0000.kind": "THREAD_POOL",
      "pool.0000.className": "java.util.concurrent.ThreadPoolExecutor",
      "pool.0000.identity": "ThreadPoolExecutor@abc",
      "pool.0000.state": "RUNNING",
      "pool.0000.poolSize": "2",
      "pool.0000.threadFactoryType": "example.WorkerFactory",
      "pool.0000.rejectionHandlerType":
        "java.util.concurrent.ThreadPoolExecutor$AbortPolicy",
      "pool.0000.queueInspectionAvailable": "true",
      "pool.0000.queueTasksScanned": "3",
      "pool.0000.queueTaskTypeCount": "2",
      "pool.0000.queueTaskType.000.className": "example.DatabaseTask",
      "pool.0000.queueTaskType.000.count": "2",
      "pool.0000.queueTaskType.001.className": "example.HttpTask",
      "pool.0000.queueTaskType.001.count": "1",
      "pool.0000.membershipAvailable": "true",
      "pool.0000.memberCount": "2",
      "pool.0000.returnedMemberCount": "2",
      "pool.0000.member.000.threadId": "41",
      "pool.0000.member.000.name": "worker-1",
      "pool.0000.member.000.groupName": "main",
      "pool.0000.member.000.state": "WAITING",
      "pool.0000.member.000.daemon": "true",
      "pool.0000.member.000.priority": "5",
      "pool.0000.member.000.topFrame": "java.lang.Thread#sleep(Thread.java)",
      "pool.0000.member.000.applicationFrame":
        "example.DatabaseWorker#run(DatabaseWorker.java:17)",
      "pool.0000.member.000.blockerType": "example.DatabasePermit",
      "pool.0000.member.001.threadId": "42",
      "pool.0000.member.001.name": "worker-2",
      "pool.0000.member.001.groupName": "main",
      "pool.0000.member.001.state": "RUNNABLE",
      "pool.0000.member.001.daemon": "false",
      "pool.0000.member.001.priority": "7",
    });

    expect(inspection.summary).toMatchObject({
      queriedTypes: 3,
      requestedMemberLimit: 100,
      scannedThreads: 37,
      discoveredMembers: 2,
      returnedMembers: 2,
      includeEvidence: true,
      requestedQueueTaskLimit: 100,
    });
    expect(inspection.pools[0]).toMatchObject({
      identity: "ThreadPoolExecutor@abc",
      poolSize: "2",
      membershipAvailable: true,
      memberCount: 2,
      threadFactoryType: "example.WorkerFactory",
      rejectionHandlerType:
        "java.util.concurrent.ThreadPoolExecutor$AbortPolicy",
      queueInspectionAvailable: true,
      queueTasksScanned: 3,
      queueTaskTypes: [
        { className: "example.DatabaseTask", count: 2 },
        { className: "example.HttpTask", count: 1 },
      ],
      members: [
        {
          threadId: 41,
          name: "worker-1",
          groupName: "main",
          state: "WAITING",
          daemon: true,
          priority: 5,
          applicationFrame:
            "example.DatabaseWorker#run(DatabaseWorker.java:17)",
          blockerType: "example.DatabasePermit",
        },
        {
          threadId: 42,
          name: "worker-2",
          daemon: false,
          priority: 7,
        },
      ],
    });
  });

  it("bounds hostile counts and drops malformed members", () => {
    const values: Record<string, string> = {
      count: "999999999",
      queriedTypes: "999",
      returnedMembers: "999",
      scannedThreads: "999999",
      "pool.0000.className": "java.util.concurrent.ThreadPoolExecutor",
      "pool.0000.identity": "ThreadPoolExecutor@safe",
      "pool.0000.returnedMemberCount": "999999",
      "pool.0000.queueTaskTypeCount": "999999",
      "pool.0000.queueTaskType.000.className": "example.BadTask",
      "pool.0000.queueTaskType.000.count": "0",
      "pool.0000.member.000.threadId": "not-a-number",
      "pool.0000.member.000.name": "bad",
      "pool.0000.member.000.priority": "5",
      "pool.0000.member.001.threadId": "7",
      "pool.0000.member.001.name": "valid",
      "pool.0000.member.001.priority": "999",
    };

    const inspection = parseThreadPoolInspection(values);

    expect(inspection.pools).toHaveLength(1);
    expect(inspection.pools[0]?.members).toEqual([]);
    expect(inspection.pools[0]?.queueTaskTypes).toEqual([]);
    expect(inspection.summary).toMatchObject({
      queriedTypes: 3,
      returnedMembers: 200,
      scannedThreads: 10_000,
    });
  });

  it("ignores invalid pool rows without inventing identities", () => {
    const inspection = parseThreadPoolInspection({
      count: "2",
      "pool.0000.className": "java.util.concurrent.ThreadPoolExecutor",
      "pool.0001.identity": "ThreadPoolExecutor@missing-class",
    });

    expect(inspection.pools).toEqual([]);
  });
});
