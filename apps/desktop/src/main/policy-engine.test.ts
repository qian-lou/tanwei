import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  TargetConnection,
  TeamPolicyDescriptor,
} from "../shared/contracts.js";
import {
  publicKeyFingerprint,
  signCanonical,
  teamPolicySignedPayload,
} from "./governance-signatures.js";
import {
  authorizeAction,
  enforceTeamPolicy,
  PolicyError,
  stricterRiskLevel,
  validateDiagnosticTemplateAction,
} from "./policy-engine.js";

const emptyReplayArguments = {
  argument0: "",
  argument1: "",
  argument2: "",
  argument3: "",
  argument4: "",
  argument5: "",
  argument6: "",
  argument7: "",
};

const readyConnection: TargetConnection = {
  target: {
    id: "local:42",
    pid: 42,
    displayName: "Test JVM",
    mainClass: "example.Main",
    arguments: [],
    javaPath: null,
    javaVersion: "21",
    user: null,
    startTime: null,
    attachable: true,
    attachReason: null,
  },
  state: "READY",
  protocolVersion: "1.0",
  agentVersion: "0.1.0",
  javaVersion: "21",
  capabilities: [
    {
      id: "runtime",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "runtime-mutation",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "invoke-replay",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "heap-instances",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "static-fields",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "classloaders",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "classloader-metaspace",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "class-redefine",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "mbeans",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "thread-control",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "thread-locks",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "thread-pools",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "thread-pool-latency",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "thread-dump",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "tasks",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "loggers",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "perfcounters",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "snapshots",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "monitor",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "trace",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "observe",
      state: "AVAILABLE",
      reason: null,
    },
    {
      id: "line-probe",
      state: "AVAILABLE",
      reason: null,
    },
  ],
  connectedAt: new Date(0).toISOString(),
  errorCode: null,
  errorMessage: null,
};

describe("observation condition policy", () => {
  const parameters = {
    className: "example.Probe",
    classLoader: "jdk.internal.loader.ClassLoaders$AppClassLoader@1",
    methodName: "echo",
    parameterTypes: "java.lang.String",
    maximumEvents: "20",
    timeoutMillis: "30000",
    includeInternal: "true",
    condition:
      'durationMs >= 0 && arg0 contains "order-" && outcome == "RETURNED"',
    phases: "BEFORE,RETURN,THROW,FINISH",
    confirmed: "true",
  };

  it("authorizes the shared bounded AND grammar as R2", () => {
    expect(
      authorizeAction(readyConnection, "observe.start", parameters).riskLevel,
    ).toBe("R2");
  });

  it("rejects script-like and excessive condition expressions", () => {
    expect(() =>
      authorizeAction(readyConnection, "observe.start", {
        ...parameters,
        condition: 'arg0 == "x" || java.lang.Runtime.getRuntime()',
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "observe.start", {
        ...parameters,
        condition:
          'durationMs >= 0 && durationMs < 1 && thread contains "main" && outcome == "RETURNED" && exception',
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "observe.start", {
        ...parameters,
        phases: "BEFORE,BEFORE",
      }),
    ).toThrowError(PolicyError);
  });
});

describe("Action Contract version policy", () => {
  it("fails closed with a structured error for an unknown version", () => {
    try {
      authorizeAction(readyConnection, "jvm.info", {}, "R4", "2.0");
      throw new Error("expected authorizeAction to reject an unknown version");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).code).toBe(
        "ACTION_CONTRACT_VERSION_UNSUPPORTED",
      );
    }
  });
});

describe("source-line probe policy", () => {
  const selection = {
    className: "example.Probe",
    classLoader: "jdk.internal.loader.ClassLoaders$AppClassLoader@1",
    methodName: "run",
    parameterTypes: "java.lang.String",
    lineNumber: "42",
  };

  it("previews as R0 and starts only inside bounded budgets", () => {
    expect(
      authorizeAction(readyConnection, "line.preview", selection).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "line.start", {
        ...selection,
        maximumEvents: "20",
        timeoutMillis: "30000",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "line.start", {
        ...selection,
        maximumEvents: "101",
        timeoutMillis: "30000",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("reads events only by an exact task identity", () => {
    expect(
      authorizeAction(readyConnection, "line.events", {
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        limit: "20",
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "line.events", {
        taskId: "not-a-task",
        limit: "20",
      }),
    ).toThrowError(PolicyError);
  });
});

describe("runtime mutation policy", () => {
  it("authorizes bounded VM option inventory queries as R0", () => {
    expect(
      authorizeAction(readyConnection, "vm.option.list", {
        query: "Heap",
        category: "MEMORY",
        mutability: "WRITEABLE",
        offset: "0",
        limit: "50",
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "vm.option.list", {
        query: "Heap\n",
        category: "ALL",
        mutability: "ALL",
        offset: "0",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "vm.option.list", {
        query: "",
        category: "ALL",
        mutability: "ALL",
        offset: "0",
        limit: "201",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded system property inventory queries as R0", () => {
    expect(
      authorizeAction(readyConnection, "system.property.list", {
        query: "java",
        category: "JAVA",
        offset: "0",
        limit: "50",
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "system.property.list", {
        query: "password\n",
        category: "ALL",
        offset: "0",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "system.property.list", {
        query: "",
        category: "ALL",
        offset: "0",
        limit: "201",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded environment inventory queries as R0", () => {
    expect(
      authorizeAction(readyConnection, "environment.list", {
        query: "JAVA",
        category: "JAVA",
        offset: "0",
        limit: "50",
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "environment.list", {
        query: "TOKEN\n",
        category: "ALL",
        offset: "0",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "environment.list", {
        query: "",
        category: "ALL",
        offset: "0",
        limit: "201",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded JIT compiler summaries as R0", () => {
    expect(
      authorizeAction(readyConnection, "jit.compiler.summary", {}).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "jit.compiler.summary", {
        unexpected: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes a confirmed mutation as R3", () => {
    const action = authorizeAction(readyConnection, "system.property.set", {
      name: "example.mode",
      expectedOldValue: "safe",
      newValue: "diagnostic",
      confirmed: "true",
    });

    expect(action.riskLevel).toBe("R3");
    expect(action.parameters).toEqual({
      name: "example.mode",
      expectedOldValue: "safe",
      newValue: "diagnostic",
      confirmed: "true",
    });
  });

  it("requires two confirmations for a GC request", () => {
    expect(() =>
      authorizeAction(readyConnection, "gc.run", {
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);

    expect(
      authorizeAction(readyConnection, "gc.run", {
        confirmed: "true",
        confirmedSecondary: "true",
      }).riskLevel,
    ).toBe("R4");
  });

  it("enforces the host-configured maximum risk level", () => {
    expect(() =>
      authorizeAction(
        readyConnection,
        "system.property.set",
        {
          name: "example.mode",
          expectedOldValue: "safe",
          newValue: "diagnostic",
          confirmed: "true",
        },
        "R2",
      ),
    ).toThrowError(/本机策略仅允许 R2/u);
  });

  it("rejects control characters in mutation parameters", () => {
    expect(() =>
      authorizeAction(readyConnection, "logging.set", {
        name: "example\nInjected",
        expectedOldValue: "INFO",
        newValue: "FINE",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("requires an exact preview fingerprint and two confirmations for replay", () => {
    const parameters = {
      className: "example.Main",
      classLoader: "app",
      methodName: "echo",
      parameterTypes: "java.lang.String",
      argumentCount: "1",
      ...emptyReplayArguments,
      argument0: "captured",
      expectedFingerprint: "a".repeat(64),
      confirmed: "true",
      confirmedSecondary: "true",
    };
    expect(
      authorizeAction(readyConnection, "invoke.replay", parameters).riskLevel,
    ).toBe("R4");
    expect(() =>
      authorizeAction(readyConnection, "invoke.replay", {
        ...parameters,
        confirmedSecondary: "false",
      }),
    ).toThrowError(PolicyError);
  });

  it("rejects non-empty replay arguments beyond argumentCount", () => {
    expect(() =>
      authorizeAction(readyConnection, "invoke.replay.preview", {
        className: "example.Main",
        classLoader: "app",
        methodName: "echo",
        parameterTypes: "java.lang.String",
        argumentCount: "1",
        ...emptyReplayArguments,
        argument0: "only-one",
        argument1: "unexpected",
      }),
    ).toThrowError(PolicyError);
  });

  it("binds instance replay to an exact live snapshot", () => {
    const parameters = {
      className: "example.Counter",
      classLoader: "app",
      methodName: "increment",
      parameterTypes: "int",
      argumentCount: "1",
      ...emptyReplayArguments,
      argument0: "2",
      snapshotId: "1001",
      replayMode: "INSTANCE",
    };

    expect(
      authorizeAction(readyConnection, "invoke.replay.preview", parameters)
        .parameters,
    ).toMatchObject({ snapshotId: "1001", replayMode: "INSTANCE" });
    expect(() =>
      authorizeAction(readyConnection, "invoke.replay.preview", {
        ...parameters,
        snapshotId: undefined,
      } as unknown as Record<string, string>),
    ).toThrowError(PolicyError);
  });

  it("bounds and confirms exact-class heap instance queries", () => {
    expect(
      authorizeAction(readyConnection, "heap.instances", {
        name: "example.Order",
        classLoader: "app",
        limit: "20",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.instances", {
        name: "example.Order",
        classLoader: "app",
        limit: "21",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds and confirms heap histogram scans", () => {
    expect(
      authorizeAction(readyConnection, "heap.histogram", {
        query: "example.",
        limit: "200",
        scanLimit: "5000000",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.histogram", {
        query: "",
        limit: "201",
        scanLimit: "5000000",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.histogram", {
        query: "",
        limit: "100",
        scanLimit: "5000001",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.histogram", {
        query: "",
        limit: "100",
        scanLimit: "9999",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds and confirms class retained-size scans", () => {
    const parameters = {
      query: "example.",
      limit: "200",
      maximumNodes: "500000",
      maximumEdges: "2000000",
      confirmed: "true",
    };
    expect(
      authorizeAction(readyConnection, "heap.retained.classes", parameters)
        .riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.retained.classes", {
        ...parameters,
        maximumNodes: "500001",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.retained.classes", {
        ...parameters,
        maximumEdges: "2000001",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.retained.classes", {
        ...parameters,
        confirmed: "false",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds and confirms dominator-tree scans", () => {
    const parameters = {
      maximumDepth: "8",
      maximumViewNodes: "200",
      rootLimit: "20",
      branchLimit: "20",
      maximumNodes: "500000",
      maximumEdges: "2000000",
      confirmed: "true",
    };
    expect(
      authorizeAction(readyConnection, "heap.dominator.tree", parameters)
        .riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.dominator.tree", {
        ...parameters,
        maximumDepth: "9",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.dominator.tree", {
        ...parameters,
        maximumViewNodes: "201",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.dominator.tree", {
        ...parameters,
        branchLimit: "0",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes opaque bounded heap relation traversal", () => {
    const parameters = {
      objectHandle: "10aab2dd-ecdf-4d28-8bc8-a6a68a099875",
      direction: "INCOMING",
      limit: "50",
      scanLimit: "250000",
      confirmed: "true",
    };
    expect(
      authorizeAction(readyConnection, "heap.relations", parameters).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.relations", {
        ...parameters,
        objectHandle: "identity-hash-is-not-a-handle",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.relations", {
        ...parameters,
        scanLimit: "1000001",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded multi-layer object graphs", () => {
    const parameters = {
      objectHandle: "10aab2dd-ecdf-4d28-8bc8-a6a68a099875",
      direction: "INCOMING",
      maximumDepth: "5",
      maximumNodes: "80",
      maximumEdgesPerNode: "8",
      scanLimit: "1000000",
      confirmed: "true",
    };
    expect(
      authorizeAction(readyConnection, "heap.object.graph", parameters)
        .riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.object.graph", {
        ...parameters,
        maximumDepth: "6",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.object.graph", {
        ...parameters,
        maximumNodes: "81",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.object.graph", {
        ...parameters,
        maximumEdgesPerNode: "9",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded GC Root path traversal", () => {
    const parameters = {
      objectHandle: "10aab2dd-ecdf-4d28-8bc8-a6a68a099875",
      maximumDepth: "32",
      maximumNodes: "100000",
      maximumEdges: "1000000",
      confirmed: "true",
    };
    expect(
      authorizeAction(readyConnection, "heap.root.path", parameters).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.root.path", {
        ...parameters,
        maximumDepth: "33",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.root.path", {
        ...parameters,
        maximumNodes: "100001",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded multi-path GC Root traversal", () => {
    const parameters = {
      objectHandle: "10aab2dd-ecdf-4d28-8bc8-a6a68a099875",
      maximumPaths: "8",
      maximumDepth: "32",
      maximumNodes: "100000",
      maximumEdges: "1000000",
      confirmed: "true",
    };
    expect(
      authorizeAction(readyConnection, "heap.root.paths", parameters).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.root.paths", {
        ...parameters,
        maximumPaths: "9",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.root.paths", {
        ...parameters,
        maximumEdges: "999",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded retained-size analysis", () => {
    const parameters = {
      objectHandle: "10aab2dd-ecdf-4d28-8bc8-a6a68a099875",
      maximumNodes: "100000",
      maximumEdges: "1000000",
      confirmed: "true",
    };
    expect(
      authorizeAction(readyConnection, "heap.retained", parameters).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.retained", {
        ...parameters,
        maximumEdges: "1000001",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.retained", {
        ...parameters,
        confirmed: "false",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes a bounded retained-size ranking", () => {
    const parameters = {
      name: "dev.tanwei.integration.HeapProbe",
      classLoader: "jdk.internal.loader.ClassLoaders$AppClassLoader@1",
      instanceLimit: "20",
      maximumNodes: "500000",
      maximumEdges: "2000000",
      confirmed: "true",
    };
    expect(
      authorizeAction(readyConnection, "heap.retained.ranking", parameters)
        .riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "heap.retained.ranking", {
        ...parameters,
        maximumNodes: "500001",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "heap.retained.ranking", {
        ...parameters,
        maximumEdges: "2000001",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded MBean inspection and rejects broad input", () => {
    expect(
      authorizeAction(readyConnection, "mbean.list", {
        query: "java.lang:type=Memory",
        offset: "0",
        limit: "50",
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "mbean.attribute.read", {
        objectName: "java.lang:type=Memory",
        attribute: "HeapMemoryUsage",
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "mbean.list", {
        query: "",
        offset: "0",
        limit: "101",
      }),
    ).toThrowError(PolicyError);
  });

  it("requires an exact fingerprint and two confirmations for MBean operations", () => {
    const operation = {
      objectName: "dev.tanwei.integration:type=Control",
      operation: "ping",
      parameterTypes: "java.lang.String",
      argumentCount: "1",
      argument0: "desktop",
      argument1: "",
      argument2: "",
      argument3: "",
      argument4: "",
      argument5: "",
      argument6: "",
      argument7: "",
    };
    expect(
      authorizeAction(readyConnection, "mbean.operation.preview", operation)
        .riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "mbean.operation.invoke", {
        ...operation,
        expectedFingerprint: "a".repeat(64),
        confirmed: "true",
        confirmedSecondary: "true",
      }).riskLevel,
    ).toBe("R4");
    expect(() =>
      authorizeAction(readyConnection, "mbean.operation.invoke", {
        ...operation,
        argument1: "unused",
        expectedFingerprint: "a".repeat(64),
        confirmed: "true",
        confirmedSecondary: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded OpenType JSON operation arguments", () => {
    const operation = {
      objectName: "dev.tanwei.integration:type=OpenControl",
      operation: "applySettings",
      parameterTypes: "javax.management.openmbean.CompositeData",
      argumentCount: "1",
      argument0:
        '{\n  "enabled": false,\n  "labels": ["desktop"],\n  "threshold": 42\n}',
      argument1: "",
      argument2: "",
      argument3: "",
      argument4: "",
      argument5: "",
      argument6: "",
      argument7: "",
      argumentFormat0: "OPEN_TYPE_JSON" as const,
    };
    expect(
      authorizeAction(readyConnection, "mbean.operation.preview", operation)
        .riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "mbean.operation.preview", {
        ...operation,
        argument0: "x".repeat(32_769),
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "mbean.operation.preview", {
        ...operation,
        argumentFormat1: "SCALAR",
      }),
    ).toThrowError(PolicyError);
  });

  it("requires old-value preview identity and two confirmations for MBean attribute writes", () => {
    const preview = {
      objectName: "dev.tanwei.integration:type=Control",
      attribute: "Mode",
      proposedValue: "desktop",
    };
    expect(
      authorizeAction(readyConnection, "mbean.attribute.write.preview", preview)
        .riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "mbean.attribute.write", {
        ...preview,
        expectedFingerprint: "b".repeat(64),
        confirmed: "true",
        confirmedSecondary: "true",
      }).riskLevel,
    ).toBe("R4");
    expect(() =>
      authorizeAction(readyConnection, "mbean.attribute.write", {
        ...preview,
        proposedValue: "desktop\nunsafe",
        expectedFingerprint: "b".repeat(64),
        confirmed: "true",
        confirmedSecondary: "true",
      }),
    ).toThrowError(PolicyError);
    expect(
      authorizeAction(readyConnection, "mbean.attribute.write.preview", {
        objectName: "dev.tanwei.integration:type=Control",
        attribute: "Settings",
        valueFormat: "OPEN_TYPE_JSON",
        proposedValue: '{\n  "enabled": true,\n  "threshold": 42\n}',
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "mbean.attribute.write.preview", {
        objectName: "dev.tanwei.integration:type=Control",
        attribute: "Settings",
        valueFormat: "OPEN_TYPE_JSON",
        proposedValue: `{"value":"${"a".repeat(32_769)}"}`,
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded logger inspection and exact framework identity", () => {
    expect(
      authorizeAction(readyConnection, "logger.list", {
        query: "dev.tanwei",
        framework: "ALL",
        offset: "0",
        limit: "50",
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "logger.describe", {
        framework: "JUL",
        contextId: "jul:platform",
        name: "<root>",
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "logger.level.preview", {
        framework: "LOG4J",
        contextId: "log4j:app@1",
        name: "dev.tanwei",
        newLevel: "DEBUG",
      }).riskLevel,
    ).toBe("R1");
    expect(
      authorizeAction(readyConnection, "logger.level.set", {
        framework: "LOG4J2",
        contextId: "log4j2:app@1",
        name: "dev.tanwei",
        newLevel: "ERROR",
        expectedFingerprint: "a".repeat(64),
        confirmed: "true",
      }).riskLevel,
    ).toBe("R3");
    expect(() =>
      authorizeAction(readyConnection, "logger.list", {
        query: "",
        framework: "LOG4J1",
        offset: "0",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "logger.level.preview", {
        framework: "LOG4J2",
        contextId: "log4j2:app@1",
        name: "dev.tanwei",
        newLevel: "<inherited>",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "logger.level.set", {
        framework: "JUL",
        contextId: "jul:platform",
        name: "<root>",
        newLevel: "INFO",
        expectedFingerprint: "not-a-fingerprint",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes only bounded read-only PerfCounter queries", () => {
    expect(
      authorizeAction(readyConnection, "perfcounter.list", {
        query: "java.cls",
        namespace: "JAVA",
        offset: "0",
        limit: "50",
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "perfcounter.list", {
        query: "",
        namespace: "VENDOR",
        offset: "0",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "perfcounter.list", {
        query: "",
        namespace: "ALL",
        offset: "0",
        limit: "201",
      }),
    ).toThrowError(PolicyError);
    expect(
      authorizeAction(readyConnection, "perfcounter.snapshot", {
        names: "java.cls.loadedClasses\nsun.gc.collector.0.invocations",
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "perfcounter.snapshot", {
        names: "a\nb\nc\nd\ne\nf\ng\nh\ni",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "perfcounter.snapshot", {
        names: "java.cls.loadedClasses\njava.cls.loadedClasses",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded snapshot inspection and exact deletion", () => {
    expect(
      authorizeAction(readyConnection, "snapshot.list", {
        query: "heartbeat",
        outcome: "RETURNED",
        scope: "ROOT",
        taskId: "task-42",
        threadQuery: "worker",
        replay: "INSTANCE",
        minimumDurationMillis: "2",
        maximumDurationMillis: "250",
        offset: "0",
        limit: "50",
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "snapshot.describe", {
        snapshotId: "1000",
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "snapshot.delete", {
        snapshotId: "1000",
      }).riskLevel,
    ).toBe("R1");
    expect(() =>
      authorizeAction(readyConnection, "snapshot.list", {
        query: "",
        outcome: "SUCCESS",
        scope: "ROOT",
        offset: "0",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "snapshot.list", {
        query: "",
        outcome: "ALL",
        scope: "ROOT",
        replay: "REPLAYABLE",
        minimumDurationMillis: "251",
        maximumDurationMillis: "250",
        offset: "0",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
  });

  it("requires preview identity and two confirmations for thread interruption", () => {
    expect(
      authorizeAction(readyConnection, "thread.interrupt.preview", {
        threadId: "42",
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "thread.interrupt", {
        threadId: "42",
        expectedName: "application-worker",
        confirmed: "true",
        confirmedSecondary: "true",
      }).riskLevel,
    ).toBe("R4");
    expect(() =>
      authorizeAction(readyConnection, "thread.interrupt", {
        threadId: "42",
        expectedName: "application-worker",
        confirmed: "true",
        confirmedSecondary: "false",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds lock relationship inspection as R0", () => {
    expect(
      authorizeAction(readyConnection, "thread.locks", {
        includeUncontended: "false",
        maximumNodes: "200",
      }).riskLevel,
    ).toBe("R0");
    expect(() =>
      authorizeAction(readyConnection, "thread.locks", {
        includeUncontended: "false",
        maximumNodes: "501",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds exact thread-pool inspection and requires confirmation", () => {
    expect(
      authorizeAction(readyConnection, "thread.pools", {
        limit: "12",
        memberLimit: "100",
        includeEvidence: "true",
        queueTaskLimit: "100",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "thread.pools", {
        limit: "21",
        memberLimit: "100",
        includeEvidence: "true",
        queueTaskLimit: "100",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "thread.pools", {
        limit: "12",
        memberLimit: "100",
        includeEvidence: "true",
        queueTaskLimit: "100",
        confirmed: "false",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "thread.pools", {
        limit: "12",
        memberLimit: "201",
        includeEvidence: "true",
        queueTaskLimit: "100",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "thread.pools", {
        limit: "12",
        memberLimit: "100",
        includeEvidence: "true",
        queueTaskLimit: "201",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds exact supported thread-pool attribution and its lifecycle", () => {
    const taskId = "5de4860f-1d3f-46bd-b465-2190967702e7";
    expect(
      authorizeAction(readyConnection, "thread.pool.latency.start", {
        poolIdentity: "ThreadPoolExecutor@1a2b3c",
        poolClassName: "java.util.concurrent.ThreadPoolExecutor",
        durationMillis: "30000",
        maximumTrackedTasks: "1024",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(
      authorizeAction(readyConnection, "thread.pool.latency.snapshot", {
        taskId,
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "thread.pool.latency.stop", {
        taskId,
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(
      authorizeAction(readyConnection, "thread.pool.latency.start", {
        poolIdentity: "ScheduledThreadPoolExecutor@1a2b3c",
        poolClassName: "java.util.concurrent.ScheduledThreadPoolExecutor",
        durationMillis: "30000",
        maximumTrackedTasks: "1024",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(
      authorizeAction(readyConnection, "thread.pool.latency.start", {
        poolIdentity: "ForkJoinPool@abc123",
        poolClassName: "java.util.concurrent.ForkJoinPool",
        durationMillis: "30000",
        maximumTrackedTasks: "128",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(() =>
      authorizeAction(readyConnection, "thread.pool.latency.start", {
        poolIdentity: "ThreadPoolExecutor@1a2b3c",
        poolClassName: "java.util.concurrent.ForkJoinPool",
        durationMillis: "30000",
        maximumTrackedTasks: "128",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "thread.pool.latency.start", {
        poolIdentity: "ThreadPoolExecutor@1a2b3c",
        poolClassName: "java.util.concurrent.ThreadPoolExecutor",
        durationMillis: "300001",
        maximumTrackedTasks: "1024",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds thread dump artifact capture as R1", () => {
    expect(
      authorizeAction(readyConnection, "thread.dump", {
        maximumThreads: "10000",
        maximumStackDepth: "256",
        includeLocks: "true",
      }).riskLevel,
    ).toBe("R1");
    expect(() =>
      authorizeAction(readyConnection, "thread.dump", {
        maximumThreads: "10001",
        maximumStackDepth: "256",
        includeLocks: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "thread.dump", {
        maximumThreads: "10000",
        maximumStackDepth: "513",
        includeLocks: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("lists tasks as R0 and requires an exact confirmed identity to cancel", () => {
    expect(authorizeAction(readyConnection, "tasks.list", {}).riskLevel).toBe(
      "R0",
    );
    expect(
      authorizeAction(readyConnection, "tasks.cancel", {
        kind: "THREAD_POOL_LATENCY",
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R1");
    expect(() =>
      authorizeAction(readyConnection, "tasks.cancel", {
        kind: "THREAD",
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "tasks.cancel", {
        kind: "PROFILE",
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        confirmed: "false",
      }),
    ).toThrowError(PolicyError);
  });

  it("previews a managed session reset as R0 and executes it only with an R4 fingerprint", () => {
    expect(
      authorizeAction(readyConnection, "session.reset.preview", {}).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "session.reset", {
        expectedFingerprint: "a".repeat(64),
        confirmed: "true",
        confirmedSecondary: "true",
      }).riskLevel,
    ).toBe("R4");
    expect(() =>
      authorizeAction(readyConnection, "session.reset", {
        expectedFingerprint: "a".repeat(64),
        confirmed: "true",
        confirmedSecondary: "false",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds an exact method monitor and its window reads", () => {
    const identity = {
      className: "example.Main",
      classLoader: "app",
      methodName: "heartbeat",
      parameterTypes: "java.lang.String",
    };
    expect(
      authorizeAction(readyConnection, "monitor.preview", identity).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "monitor.start", {
        ...identity,
        intervalMillis: "1000",
        durationMillis: "60000",
        minimumDurationMillis: "0",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R1");
    expect(
      authorizeAction(readyConnection, "monitor.windows", {
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        afterSequence: "0",
        limit: "100",
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "monitor.threshold.update", {
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        minimumDurationMillis: "25",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R1");
    expect(() =>
      authorizeAction(readyConnection, "monitor.threshold.update", {
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        minimumDurationMillis: "60001",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "monitor.start", {
        ...identity,
        intervalMillis: "999",
        durationMillis: "60000",
        minimumDurationMillis: "0",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
  });

  it("bounds a same-loader package trace and rejects JDK scopes", () => {
    const identity = {
      className: "dev.tanwei.example.Main",
      classLoader: "app",
      methodName: "heartbeat",
      parameterTypes: "java.lang.String",
      scopePrefix: "dev.tanwei.example",
      includeRules:
        "dev.tanwei.example.service.*\n" + "dev.tanwei.example.Repository#load",
      excludeRules: "dev.tanwei.example.service.InternalService",
    };
    expect(
      authorizeAction(readyConnection, "trace.preview", identity).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "trace.start", {
        ...identity,
        maximumTraces: "5",
        maximumDepth: "12",
        maximumSpans: "256",
        minimumDurationMillis: "0",
        timeoutMillis: "15000",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R2");
    expect(
      authorizeAction(readyConnection, "trace.events", {
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        limit: "5",
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "trace.threshold.update", {
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        minimumDurationMillis: "25",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R1");
    expect(() =>
      authorizeAction(readyConnection, "trace.threshold.update", {
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
        minimumDurationMillis: "60001",
        confirmed: "true",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "trace.preview", {
        ...identity,
        className: "java.lang.String",
        scopePrefix: "java.lang",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "trace.preview", {
        ...identity,
        includeRules: "dev.other.Service#run",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "trace.preview", {
        ...identity,
        includeRules: "dev.tanwei.example.*#run",
      }),
    ).toThrowError(PolicyError);
  });

  it("keeps static metadata R0 and requires an exact confirmed R3 read", () => {
    const identity = {
      name: "example.Main",
      classLoader: "app",
      declaringClass: "example.Main",
      fieldName: "CONFIG",
    };
    expect(
      authorizeAction(readyConnection, "class.static.fields", {
        name: identity.name,
        classLoader: identity.classLoader,
      }).riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "classloader.resources", {
        name: identity.name,
        classLoader: identity.classLoader,
        resourceName: "example/Main.class",
      }).riskLevel,
    ).toBe("R1");
    expect(() =>
      authorizeAction(readyConnection, "classloader.resources", {
        name: identity.name,
        classLoader: identity.classLoader,
        resourceName: "../application.properties",
      }),
    ).toThrowError(PolicyError);
    expect(
      authorizeAction(readyConnection, "class.static.read.preview", identity)
        .riskLevel,
    ).toBe("R0");
    expect(
      authorizeAction(readyConnection, "class.static.read", {
        ...identity,
        expectedFingerprint:
          "0000000000000000000000000000000000000000000000000000000000000000",
        confirmed: "true",
      }).riskLevel,
    ).toBe("R3");
    expect(() =>
      authorizeAction(readyConnection, "class.static.read", {
        ...identity,
        expectedFingerprint:
          "0000000000000000000000000000000000000000000000000000000000000000",
        confirmed: "false",
      }),
    ).toThrowError(PolicyError);
  });

  it("authorizes bounded ClassLoader metaspace sampling as R1", () => {
    expect(
      authorizeAction(readyConnection, "classloader.metaspace", {
        durationMillis: "1000",
        periodMillis: "250",
        limit: "50",
      }).riskLevel,
    ).toBe("R1");
    expect(() =>
      authorizeAction(readyConnection, "classloader.metaspace", {
        durationMillis: "1000",
        periodMillis: "1001",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "classloader.metaspace", {
        durationMillis: "500",
        periodMillis: "750",
        limit: "50",
      }),
    ).toThrowError(PolicyError);
  });

  it("binds a same-loader class change set to one R3 fingerprint", () => {
    const bytecodeBase64 = "QUFBQUFBQUFB";
    const changeSet = {
      count: "2",
      item0Name: "example.Main",
      item0ClassLoader: "app-loader",
      item0BytecodeBase64: bytecodeBase64,
      item1Name: "example.Support",
      item1ClassLoader: "app-loader",
      item1BytecodeBase64: bytecodeBase64,
    };
    expect(
      authorizeAction(readyConnection, "class.change-set.preview", changeSet)
        .riskLevel,
    ).toBe("R2");
    expect(
      authorizeAction(readyConnection, "class.change-set.apply", {
        ...changeSet,
        expectedFingerprint: "a".repeat(64),
        confirmed: "true",
      }).riskLevel,
    ).toBe("R3");
    expect(
      authorizeAction(readyConnection, "class.change-set.restore", {
        rollbackToken: "5de4860f-1d3f-46bd-b465-2190967702e7",
        expectedCurrentFingerprint: "b".repeat(64),
        confirmed: "true",
      }).riskLevel,
    ).toBe("R3");

    expect(() =>
      authorizeAction(readyConnection, "class.change-set.preview", {
        ...changeSet,
        item1ClassLoader: "other-loader",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "class.change-set.preview", {
        ...changeSet,
        item1Name: "example.Main",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      authorizeAction(readyConnection, "class.change-set.preview", {
        ...changeSet,
        item2Name: "example.Uncounted",
        item2ClassLoader: "app-loader",
        item2BytecodeBase64: bytecodeBase64,
      }),
    ).toThrowError(PolicyError);
  });

  it("allows only schema-valid R0/R1 templates and picks the stricter ceiling", () => {
    expect(validateDiagnosticTemplateAction("jvm.info", {}).riskLevel).toBe(
      "R0",
    );
    expect(
      validateDiagnosticTemplateAction("profile.start", {
        event: "CPU",
        intervalMillis: "10",
        durationMillis: "1000",
        stackDepth: "256",
        threads: "false",
        includeRules: "",
        excludeRules: "",
      }).riskLevel,
    ).toBe("R1");
    expect(
      validateDiagnosticTemplateAction("profile.dump", {
        taskId: "5de4860f-1d3f-46bd-b465-2190967702e7",
      }).riskLevel,
    ).toBe("R1");
    expect(
      validateDiagnosticTemplateAction("jfr.start", {
        configuration: "PROFILE",
        maxAgeMillis: "60000",
        maxSizeBytes: "1048576",
        recordingName: "checkout-profile",
      }).riskLevel,
    ).toBe("R1");
    expect(() =>
      validateDiagnosticTemplateAction("jfr.start", {
        configuration: "PROFILE",
        maxAgeMillis: "60000",
        maxSizeBytes: "1048576",
        recordingName: "unsafe\nname",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      validateDiagnosticTemplateAction("profile.start", {
        event: "CPU",
        intervalMillis: "10",
        durationMillis: "1000",
        stackDepth: "256",
        threads: "false",
        includeRules: "com/*/Service",
        excludeRules: "",
      }),
    ).toThrowError(PolicyError);
    expect(() =>
      validateDiagnosticTemplateAction("heap.dump", {
        confirmed: "true",
        live: "true",
      }),
    ).toThrowError(/R0\/R1/u);
    expect(stricterRiskLevel("R4", "R1")).toBe("R1");
    expect(stricterRiskLevel("R2", "R3")).toBe("R2");
  });

  it("enforces a verified team policy and fails closed on tampering", () => {
    const policy = signedTeamPolicy();
    expect(enforceTeamPolicy("jvm.info", "R4", policy)).toBe("R1");
    expect(() => enforceTeamPolicy("gc.run", "R4", policy)).toThrowError(
      /团队策略已禁用/u,
    );
    expect(() =>
      enforceTeamPolicy("jvm.info", "R4", {
        ...policy,
        signature: `${policy.signature.slice(0, -2)}AA`,
      }),
    ).toThrowError(/签名无效/u);
    expect(() =>
      enforceTeamPolicy(
        "jvm.info",
        "R4",
        signedTeamPolicy(new Date(0).toISOString()),
      ),
    ).toThrowError(/已过期/u);
  });
});

function signedTeamPolicy(
  expiresAt: string | null = null,
): TeamPolicyDescriptor {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
  const unsigned = {
    apiVersion: "tanwei.dev/team-policy/v1",
    id: "production",
    name: "Production",
    version: "1.0.0",
    issuedAt: new Date().toISOString(),
    expiresAt,
    maximumRiskLevel: "R1",
    deniedActions: ["gc.run"],
    signer: "Platform",
    publicKey,
  } as const;
  const descriptor: TeamPolicyDescriptor = {
    ...unsigned,
    deniedActions: [...unsigned.deniedActions],
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
    signature: "",
    verified: true,
    activatedAt: null,
  };
  return {
    ...descriptor,
    signature: signCanonical(
      pair.privateKey,
      teamPolicySignedPayload(descriptor),
    ),
  };
}
