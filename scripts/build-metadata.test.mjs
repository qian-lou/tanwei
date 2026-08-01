import assert from "node:assert/strict";
import test from "node:test";
import {
  componentFiles,
  parseBuildMetadata,
} from "./build-metadata.mjs";

test("build metadata derives every Tanwei artifact from one product version", () => {
  const metadata = parseBuildMetadata({
    version: "2.3.4",
    tanweiBuild: {
      protocolVersion: "3.1",
      decompilerVersion: "0.152",
      asyncProfilerVersion: "4.5",
      heapQueryVersion: "2.3.4",
      boundedProfilerVersion: "1.0",
    },
  });

  assert.deepEqual(componentFiles(metadata), {
    "attach-helper": "tanwei-attach-helper-2.3.4.jar",
    bootstrap: "tanwei-bootstrap-2.3.4.jar",
    agent: "tanwei-agent-2.3.4.jar",
    protocol: "tanwei.proto",
    relay: "tanwei-relay-2.3.4.jar",
    decompiler: "tanwei-decompiler-2.3.4.jar",
  });
  assert.equal(metadata.protocolVersion, "3.1");
});
