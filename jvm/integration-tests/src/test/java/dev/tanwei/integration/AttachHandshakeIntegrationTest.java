package dev.tanwei.integration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tanwei.protocol.BuildMetadata;
import dev.tanwei.protocol.v1.CapabilitiesRequest;
import dev.tanwei.protocol.v1.CapabilitiesResponse;
import dev.tanwei.protocol.v1.ActionRequest;
import dev.tanwei.protocol.v1.ActionResponse;
import dev.tanwei.protocol.v1.ArtifactChunk;
import dev.tanwei.protocol.v1.ArtifactDownloadRequest;
import dev.tanwei.protocol.v1.ClassListRequest;
import dev.tanwei.protocol.v1.ClassListResponse;
import dev.tanwei.protocol.v1.ClassDetailsRequest;
import dev.tanwei.protocol.v1.ClassDetailsResponse;
import dev.tanwei.protocol.v1.DiagnosticServiceGrpc;
import dev.tanwei.protocol.v1.RequestContext;
import dev.tanwei.protocol.v1.RemoteArtifactRequest;
import dev.tanwei.protocol.v1.ObservationEventsRequest;
import dev.tanwei.protocol.v1.ObservationEventsResponse;
import dev.tanwei.protocol.v1.ObservationTaskRequest;
import dev.tanwei.protocol.v1.RuntimeSnapshot;
import dev.tanwei.protocol.v1.ShutdownRequest;
import dev.tanwei.protocol.v1.SnapshotRequest;
import dev.tanwei.protocol.v1.ThreadListRequest;
import dev.tanwei.protocol.v1.ThreadListResponse;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.grpc.netty.shaded.io.netty.handler.ssl.util.SelfSignedCertificate;
import io.grpc.stub.MetadataUtils;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

final class AttachHandshakeIntegrationTest {
  private static final Duration PROCESS_TIMEOUT = Duration.ofSeconds(15L);
  private static final SecureRandom SECURE_RANDOM = new SecureRandom();

  @Test
  void attachesAuthenticatesAndCollectsSnapshot() throws Exception {
    TargetProcess target = startTarget();
    ManagedChannel channel = null;
    try {
      assertTrue(awaitReady(target), "Target did not become ready:\n" + target.output());
      long pid = target.process.pid();
      int port = reservePort();
      String secret = sessionSecret();

      ProcessResult attach = attach(pid, port, secret);
      assertEquals(
          0,
          attach.exitCode,
          attach.output + "\nTarget output:\n" + target.output());
      assertTrue(attach.output.contains("\"ok\":true"), attach.output);
      assertTrue(
          awaitOutput(target, "TANWEI_PRIVATE_VISIBLE=false"),
          "Agent private classes leaked to the target ClassLoader:\n" + target.output());

      channel =
          NettyChannelBuilder.forAddress("127.0.0.1", port)
              .usePlaintext()
              .build();
      Metadata headers = new Metadata();
      headers.put(
          Metadata.Key.of("x-tanwei-secret", Metadata.ASCII_STRING_MARSHALLER), secret);
      DiagnosticServiceGrpc.DiagnosticServiceBlockingStub authenticated =
          DiagnosticServiceGrpc.newBlockingStub(channel)
              .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
              .withDeadlineAfter(30L, TimeUnit.SECONDS);

      CapabilitiesResponse capabilities =
          authenticated.getCapabilities(
              CapabilitiesRequest.newBuilder()
                  .setContext(context("capabilities"))
                  .setClientProtocolVersion(BuildMetadata.PROTOCOL_VERSION)
                  .build());
      assertEquals(pid, capabilities.getProcessId());
      assertEquals(
          BuildMetadata.PROTOCOL_VERSION, capabilities.getProtocolVersion());
      assertFalse(capabilities.getCapabilitiesList().isEmpty());
      StatusRuntimeException incompatibleProtocol =
          assertThrows(
              StatusRuntimeException.class,
              () ->
                  authenticated.getCapabilities(
                      CapabilitiesRequest.newBuilder()
                          .setContext(context("incompatible-capabilities"))
                          .setClientProtocolVersion("2.0")
                          .build()));
      assertEquals(
          Status.Code.FAILED_PRECONDITION, incompatibleProtocol.getStatus().getCode());
      assertTrue(
          String.valueOf(incompatibleProtocol.getStatus().getDescription())
              .contains("PROTOCOL_INCOMPATIBLE"));
      assertTrue(
          capabilities.getCapabilitiesList().stream()
              .anyMatch(
                  capability ->
                      "perfcounters".equals(capability.getId())
                          && "AVAILABLE".equals(capability.getState())),
          capabilities.toString());
      assertTrue(
          capabilities.getCapabilitiesList().stream()
              .anyMatch(
                  capability ->
                      "snapshots".equals(capability.getId())
                          && "AVAILABLE".equals(capability.getState())),
          capabilities.toString());

      RuntimeSnapshot snapshot =
          authenticated.getSnapshot(
              SnapshotRequest.newBuilder().setContext(context("snapshot")).build());
      assertTrue(snapshot.getCapturedAtEpochMillis() > 0L);
      assertTrue(snapshot.getHeapUsedBytes() >= 0L);
      assertTrue(snapshot.getLiveThreads() > 0);
      assertRelayProxy(port, secret);
      assertMutualTlsRelayProxy(port, secret);

      ThreadListResponse threads =
          authenticated.listThreads(
              ThreadListRequest.newBuilder()
                  .setContext(context("threads"))
                  .setLimit(20)
                  .setStackDepth(8)
                  .build());
      assertTrue(threads.getTotal() > 0);
      assertFalse(threads.getThreadsList().isEmpty());

      ThreadListResponse interruptibleThreads =
          authenticated.listThreads(
              ThreadListRequest.newBuilder()
                  .setContext(context("interruptible-thread"))
                  .setLimit(10)
                  .setStackDepth(8)
                  .setNameQuery("integration-interruptible-worker")
                  .build());
      assertEquals(1, interruptibleThreads.getTotal());
      dev.tanwei.protocol.v1.ThreadDescriptor interruptibleThread =
          interruptibleThreads.getThreads(0);
      ActionResponse interruptPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-interrupt-preview"))
                  .setActionId("thread.interrupt.preview")
                  .putParameters(
                      "threadId",
                      Long.toString(interruptibleThread.getId()))
                  .build());
      assertEquals(
          "SUCCEEDED", interruptPreview.getStatus(), interruptPreview.toString());
      assertEquals(
          "integration-interruptible-worker",
          interruptPreview.getValuesOrThrow("name"));
      ActionResponse interrupt =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-interrupt"))
                  .setActionId("thread.interrupt")
                  .putParameters(
                      "threadId",
                      Long.toString(interruptibleThread.getId()))
                  .putParameters(
                      "expectedName",
                      interruptPreview.getValuesOrThrow("name"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals("SUCCEEDED", interrupt.getStatus(), interrupt.toString());
      assertEquals("true", interrupt.getValuesOrThrow("interruptSent"));
      assertTrue(
          awaitOutput(target, "TANWEI_INTERRUPTIBLE_WORKER_STOPPED"),
          target.output());

      ActionResponse lockRelationships =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-locks"))
                  .setActionId("thread.locks")
                  .putParameters("includeUncontended", "false")
                  .putParameters("maximumNodes", "100")
                  .build());
      assertEquals(
          "SUCCEEDED",
          lockRelationships.getStatus(),
          lockRelationships.toString());
      assertTrue(
          lockRelationships.getValuesMap().containsValue(
              "integration-lock-holder"),
          lockRelationships.toString());
      assertTrue(
          lockRelationships.getValuesMap().containsValue(
              "integration-lock-waiter"),
          lockRelationships.toString());
      assertTrue(
          Integer.parseInt(lockRelationships.getValuesOrThrow("edges")) >= 1,
          lockRelationships.toString());

      ActionResponse threadPools =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-pools"))
                  .setActionId("thread.pools")
                  .putParameters("limit", "12")
                  .putParameters("memberLimit", "100")
                  .putParameters("includeEvidence", "true")
                  .putParameters("queueTaskLimit", "100")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          threadPools.getStatus(),
          threadPools.toString());
      assertTrue(
          Integer.parseInt(threadPools.getValuesOrThrow("count")) >= 2,
          threadPools.toString());
      assertTrue(
          threadPools.getValuesMap().containsValue(
              "java.util.concurrent.ThreadPoolExecutor"),
          threadPools.toString());
      assertTrue(
          threadPools.getValuesMap().containsValue(
              "java.util.concurrent.ScheduledThreadPoolExecutor"),
          threadPools.toString());
      assertTrue(
          threadPools.getValuesMap().containsValue(
              "java.util.concurrent.ForkJoinPool"),
          threadPools.toString());
      String executorPrefix =
          findPoolPrefixByMemberName(
              threadPools.getValuesMap(),
              "integration-worker-pool-");
      assertEquals(
          "java.util.concurrent.ThreadPoolExecutor",
          threadPools.getValuesOrThrow(executorPrefix + "className"),
          threadPools.toString());
      assertEquals(
          "true",
          threadPools.getValuesOrThrow(
              executorPrefix + "membershipAvailable"),
          threadPools.toString());
      assertTrue(
          Integer.parseInt(
                  threadPools.getValuesOrThrow(
                      executorPrefix + "memberCount"))
              >= 2,
          threadPools.toString());
      assertTrue(
          containsValueWithKeySuffix(
              threadPools.getValuesMap(),
              executorPrefix,
              ".name",
              "integration-worker-pool-"),
          threadPools.toString());
      assertTrue(
          containsNonEmptyValueWithKeySuffix(
              threadPools.getValuesMap(),
              executorPrefix,
              ".groupName"),
          threadPools.toString());
      assertFalse(
          threadPools
              .getValuesOrThrow(executorPrefix + "threadFactoryType")
              .isEmpty(),
          threadPools.toString());
      assertTrue(
          threadPools
              .getValuesOrThrow(executorPrefix + "rejectionHandlerType")
              .endsWith("AbortPolicy"),
          threadPools.toString());
      assertEquals(
          "true",
          threadPools.getValuesOrThrow(
              executorPrefix + "queueInspectionAvailable"),
          threadPools.toString());
      assertTrue(
          Integer.parseInt(
                  threadPools.getValuesOrThrow(
                      executorPrefix + "queueTasksScanned"))
              >= 3,
          threadPools.toString());
      assertTrue(
          threadPools.getValuesMap().containsValue(
              "dev.tanwei.integration.DatabaseBacklogTask"),
          threadPools.toString());
      assertTrue(
          containsValueWithKeySuffix(
              threadPools.getValuesMap(),
              executorPrefix,
              ".applicationFrame",
              "dev.tanwei.integration.ThreadPoolEvidenceTasks"),
          threadPools.toString());

      String latencyPoolPrefix =
          findPoolPrefixByMemberName(
              threadPools.getValuesMap(), "latency-worker-pool-");
      String latencyPoolIdentity =
          threadPools.getValuesOrThrow(latencyPoolPrefix + "identity");
      String scheduledPoolPrefix =
          findPoolPrefixByMemberName(
              threadPools.getValuesMap(), "integration-scheduler-");
      String forkJoinPoolPrefix =
          findPoolPrefixByMemberName(
              threadPools.getValuesMap(), "integration-forkjoin-pool-");
      ActionResponse latencyStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-pool-latency-start"))
                  .setActionId("thread.pool.latency.start")
                  .putParameters("poolIdentity", latencyPoolIdentity)
                  .putParameters(
                      "poolClassName",
                      "java.util.concurrent.ThreadPoolExecutor")
                  .putParameters("durationMillis", "10000")
                  .putParameters("maximumTrackedTasks", "512")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", latencyStart.getStatus(), latencyStart.toString());
      String latencyTaskId = latencyStart.getValuesOrThrow("taskId");
      Thread.sleep(1_500L);
      ActionResponse latencySnapshot =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-pool-latency-snapshot"))
                  .setActionId("thread.pool.latency.snapshot")
                  .putParameters("taskId", latencyTaskId)
                  .build());
      assertEquals(
          "SUCCEEDED",
          latencySnapshot.getStatus(),
          latencySnapshot.toString());
      assertEquals("RUNNING", latencySnapshot.getValuesOrThrow("state"));
      assertEquals(
          latencyPoolIdentity,
          latencySnapshot.getValuesOrThrow("poolIdentity"));
      assertTrue(
          Long.parseLong(latencySnapshot.getValuesOrThrow("submitted")) > 0L,
          latencySnapshot.toString());
      assertTrue(
          Long.parseLong(latencySnapshot.getValuesOrThrow("completed")) > 0L,
          latencySnapshot.toString()
              + "\nTarget output:\n"
              + target.output());
      assertTrue(
          Long.parseLong(latencySnapshot.getValuesOrThrow("waitObserved"))
              > 0L,
          latencySnapshot.toString());
      assertTrue(
          Long.parseLong(
                  latencySnapshot.getValuesOrThrow("waitDurationNanos"))
              > 0L,
          latencySnapshot.toString());
      assertTrue(
          Long.parseLong(
                  latencySnapshot.getValuesOrThrow("runDurationNanos"))
              > 0L,
          latencySnapshot.toString());
      assertTrue(
          latencySnapshot.getValuesMap().containsValue(
              "dev.tanwei.integration.MeasuredLatencyTask"),
          latencySnapshot.toString());

      ActionResponse latencyTasks =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-pool-latency-tasks"))
                  .setActionId("tasks.list")
                  .build());
      assertTrue(
          latencyTasks.getValuesMap().containsValue("THREAD_POOL_LATENCY"),
          latencyTasks.toString());
      assertTrue(
          latencyTasks.getValuesMap().containsValue(latencyTaskId),
          latencyTasks.toString());

      ActionResponse latencyStop =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-pool-latency-stop"))
                  .setActionId("thread.pool.latency.stop")
                  .putParameters("taskId", latencyTaskId)
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", latencyStop.getStatus(), latencyStop.toString());
      assertEquals("CANCELLED", latencyStop.getValuesOrThrow("state"));
      ActionResponse latencyTasksAfterStop =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-pool-latency-tasks-after-stop"))
                  .setActionId("tasks.list")
                  .build());
      assertFalse(
          latencyTasksAfterStop
              .getValuesMap()
              .containsValue("THREAD_POOL_LATENCY"),
          latencyTasksAfterStop.toString());

      assertScheduledThreadPoolAttribution(
          authenticated,
          threadPools.getValuesOrThrow(scheduledPoolPrefix + "identity"),
          "java.util.concurrent.ScheduledThreadPoolExecutor$ScheduledFutureTask");
      assertRunOnlyThreadPoolAttribution(
          authenticated,
          threadPools.getValuesOrThrow(forkJoinPoolPrefix + "identity"),
          "java.util.concurrent.ForkJoinPool",
          "dev.tanwei.integration.MeasuredForkJoinTask",
          "forkjoin");

      ActionResponse threadDump =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("thread-dump"))
                  .setActionId("thread.dump")
                  .putParameters("maximumThreads", "10000")
                  .putParameters("maximumStackDepth", "256")
                  .putParameters("includeLocks", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          threadDump.getStatus(),
          threadDump.toString());
      assertEquals(
          "THREAD_DUMP",
          threadDump.getValuesOrThrow("type"));
      ByteArrayOutputStream threadDumpBytes =
          downloadArtifact(
              authenticated,
              threadDump.getValuesOrThrow("token"),
              "thread-dump-download");
      assertEquals(
          Long.parseLong(threadDump.getValuesOrThrow("size")),
          threadDumpBytes.size());
      String threadDumpText =
          threadDumpBytes.toString(StandardCharsets.UTF_8.name());
      assertTrue(
          threadDumpText.startsWith("Tanwei Thread Dump\n"),
          threadDumpText);
      assertTrue(
          threadDumpText.contains("\"integration-lock-holder\""),
          threadDumpText);
      assertTrue(
          threadDumpText.contains("\"integration-lock-waiter\""),
          threadDumpText);
      assertTrue(
          threadDumpText.contains("waitingOn="),
          threadDumpText);
      assertTrue(
          authenticated
              .deleteArtifact(
                  RemoteArtifactRequest.newBuilder()
                      .setContext(
                          context("thread-dump-delete"))
                      .setToken(
                          threadDump.getValuesOrThrow("token"))
                      .build())
              .getDeleted());

      ClassListResponse classes =
          authenticated.listClasses(
              ClassListRequest.newBuilder()
                  .setContext(context("classes"))
                  .setLimit(20)
                  .setNameQuery(TestTargetMain.class.getName())
                  .build());
      assertTrue(classes.getTotalMatches() >= 1);
      dev.tanwei.protocol.v1.ClassDescriptor targetMainClass =
          classes.getClassesList().stream()
              .filter(type -> TestTargetMain.class.getName().equals(type.getName()))
              .findFirst()
              .orElseThrow(() -> new AssertionError("Exact TestTargetMain class was not found"));

      ClassDetailsResponse classDetails =
          authenticated.getClassDetails(
              ClassDetailsRequest.newBuilder()
                  .setContext(context("class-details"))
                  .setName(targetMainClass.getName())
                  .setClassLoader(targetMainClass.getClassLoader())
                  .build());
      assertTrue(classDetails.getFound());
      assertTrue(
          classDetails.getMethodsList().stream()
              .anyMatch(method -> "main".equals(method.getName())));

      ActionResponse staticFields =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("static-fields"))
                  .setActionId("class.static.fields")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .build());
      assertEquals("SUCCEEDED", staticFields.getStatus(), staticFields.toString());
      assertTrue(
          staticFields.getValuesMap().containsValue("STATIC_PROBE"),
          staticFields.toString());
      ActionResponse staticFieldPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("static-field-preview"))
                  .setActionId("class.static.read.preview")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("declaringClass", targetMainClass.getName())
                  .putParameters("fieldName", "STATIC_PROBE")
                  .build());
      assertEquals(
          "SUCCEEDED",
          staticFieldPreview.getStatus(),
          staticFieldPreview.toString());
      ActionResponse staticFieldRead =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("static-field-read"))
                  .setActionId("class.static.read")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("declaringClass", targetMainClass.getName())
                  .putParameters("fieldName", "STATIC_PROBE")
                  .putParameters(
                      "expectedFingerprint",
                      staticFieldPreview.getValuesOrThrow("fingerprint"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", staticFieldRead.getStatus(), staticFieldRead.toString());
      assertEquals(
          "tanwei-static-probe",
          staticFieldRead.getValuesOrThrow("value"));

      ActionResponse heapHistogram =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-histogram"))
                  .setActionId("heap.histogram")
                  .putParameters(
                      "query", "dev.tanwei.integration.Heap")
                  .putParameters("limit", "100")
                  .putParameters("scanLimit", "1000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          heapHistogram.getStatus(),
          heapHistogram.toString());
      assertTrue(
          Integer.parseInt(
                  heapHistogram.getValuesOrThrow("scannedObjects"))
              > 0,
          heapHistogram.toString());
      assertTrue(
          Integer.parseInt(
                  heapHistogram.getValuesOrThrow("nonEmptyClasses"))
              >= Integer.parseInt(
                  heapHistogram.getValuesOrThrow("count")),
          heapHistogram.toString());
      assertTrue(
          heapHistogram.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapProbe"),
          heapHistogram.toString());
      assertTrue(
          heapHistogram.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapLeaf"),
          heapHistogram.toString());

      ClassListResponse heapProbeClasses =
          authenticated.listClasses(
              ClassListRequest.newBuilder()
                  .setContext(context("heap-probe-classes"))
                  .setLimit(20)
                  .setNameQuery("dev.tanwei.integration.HeapProbe")
                  .build());
      dev.tanwei.protocol.v1.ClassDescriptor heapProbeClass =
          heapProbeClasses.getClassesList().stream()
              .filter(type -> "dev.tanwei.integration.HeapProbe".equals(type.getName()))
              .findFirst()
              .orElseThrow(() -> new AssertionError("Exact HeapProbe class was not found"));
      ActionResponse heapInstances =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-instances"))
                  .setActionId("heap.instances")
                  .putParameters("name", heapProbeClass.getName())
                  .putParameters(
                      "classLoader",
                      heapProbeClass.getClassLoader())
                  .putParameters("limit", "5")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", heapInstances.getStatus(), heapInstances.toString());
      assertEquals("3", heapInstances.getValuesOrThrow("count"));
      assertTrue(heapInstances.getValuesMap().containsValue("alpha"));
      assertTrue(heapInstances.getValuesMap().containsValue("33"));
      String heapProbeHandle =
          heapInstances.getValuesOrThrow("instance.0000.handle");

      ActionResponse outgoingRelations =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-relations-outgoing"))
                  .setActionId("heap.relations")
                  .putParameters("objectHandle", heapProbeHandle)
                  .putParameters("direction", "OUTGOING")
                  .putParameters("limit", "20")
                  .putParameters("scanLimit", "250000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          outgoingRelations.getStatus(),
          outgoingRelations.toString());
      String heapLeafHandle = "";
      int outgoingCount =
          Integer.parseInt(outgoingRelations.getValuesOrThrow("count"));
      for (int index = 0; index < outgoingCount; index++) {
        String prefix =
            "relation." + String.format(java.util.Locale.ROOT, "%04d", index) + ".";
        if ("dev.tanwei.integration.HeapLeaf"
            .equals(outgoingRelations.getValuesOrDefault(prefix + "type", ""))) {
          heapLeafHandle =
              outgoingRelations.getValuesOrDefault(prefix + "handle", "");
          break;
        }
      }
      assertFalse(heapLeafHandle.isEmpty(), outgoingRelations.toString());

      ActionResponse incomingRelations =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-relations-incoming"))
                  .setActionId("heap.relations")
                  .putParameters("objectHandle", heapLeafHandle)
                  .putParameters("direction", "INCOMING")
                  .putParameters("limit", "20")
                  .putParameters("scanLimit", "1000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          incomingRelations.getStatus(),
          incomingRelations.toString());
      assertTrue(
          incomingRelations.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapProbe"),
          incomingRelations.toString());

      ActionResponse outgoingObjectGraph =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-object-graph-outgoing"))
                  .setActionId("heap.object.graph")
                  .putParameters("objectHandle", heapProbeHandle)
                  .putParameters("direction", "OUTGOING")
                  .putParameters("maximumDepth", "2")
                  .putParameters("maximumNodes", "40")
                  .putParameters("maximumEdgesPerNode", "8")
                  .putParameters("scanLimit", "250000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          outgoingObjectGraph.getStatus(),
          outgoingObjectGraph.toString());
      assertTrue(
          Integer.parseInt(
                  outgoingObjectGraph
                      .getValuesOrThrow("node.count"))
              >= 3,
          outgoingObjectGraph.toString());
      assertTrue(
          Integer.parseInt(
                  outgoingObjectGraph
                      .getValuesOrThrow("edge.count"))
              >= 2,
          outgoingObjectGraph.toString());
      assertTrue(
          outgoingObjectGraph.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapLeaf"),
          outgoingObjectGraph.toString());

      ActionResponse incomingObjectGraph =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-object-graph-incoming"))
                  .setActionId("heap.object.graph")
                  .putParameters("objectHandle", heapLeafHandle)
                  .putParameters("direction", "INCOMING")
                  .putParameters("maximumDepth", "4")
                  .putParameters("maximumNodes", "40")
                  .putParameters("maximumEdgesPerNode", "4")
                  .putParameters("scanLimit", "1000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          incomingObjectGraph.getStatus(),
          incomingObjectGraph.toString());
      assertTrue(
          Integer.parseInt(
                  incomingObjectGraph
                      .getValuesOrThrow("node.count"))
              >= 3,
          incomingObjectGraph.toString());
      assertTrue(
          Integer.parseInt(
                  incomingObjectGraph
                      .getValuesOrThrow("edge.count"))
              >= 2,
          incomingObjectGraph.toString());
      assertTrue(
          incomingObjectGraph.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapProbe"),
          incomingObjectGraph.toString());

      ActionResponse heapRootPath =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-root-path"))
                  .setActionId("heap.root.path")
                  .putParameters("objectHandle", heapLeafHandle)
                  .putParameters("maximumDepth", "16")
                  .putParameters("maximumNodes", "100000")
                  .putParameters("maximumEdges", "1000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          heapRootPath.getStatus(),
          heapRootPath.toString());
      assertEquals(
          "true",
          heapRootPath.getValuesOrThrow("rootReached"),
          heapRootPath.toString());
      assertTrue(
          Integer.parseInt(heapRootPath.getValuesOrThrow("count")) >= 3,
          heapRootPath.toString());
      assertTrue(
          heapRootPath.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapLeaf"),
          heapRootPath.toString());
      assertTrue(
          heapRootPath.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapProbe"),
          heapRootPath.toString());
      ActionResponse heapRootPaths =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-root-paths"))
                  .setActionId("heap.root.paths")
                  .putParameters("objectHandle", heapLeafHandle)
                  .putParameters("maximumPaths", "4")
                  .putParameters("maximumDepth", "16")
                  .putParameters("maximumNodes", "100000")
                  .putParameters("maximumEdges", "1000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          heapRootPaths.getStatus(),
          heapRootPaths.toString());
      assertTrue(
          Integer.parseInt(heapRootPaths.getValuesOrThrow("count"))
              >= 2,
          heapRootPaths.toString());
      assertTrue(
          heapRootPaths.getValuesMap().entrySet().stream()
              .filter(
                  entry ->
                      entry.getKey().endsWith(".rootReached"))
              .filter(entry -> "true".equals(entry.getValue()))
              .count()
              >= 2,
          heapRootPaths.toString());
      assertTrue(
          heapRootPaths.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapLeaf"),
          heapRootPaths.toString());
      assertTrue(
          heapRootPaths.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapProbe"),
          heapRootPaths.toString());
      ActionResponse heapRetained =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-retained"))
                  .setActionId("heap.retained")
                  .putParameters("objectHandle", heapProbeHandle)
                  .putParameters("maximumNodes", "100000")
                  .putParameters("maximumEdges", "1000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          heapRetained.getStatus(),
          heapRetained.toString());
      assertEquals(
          "true",
          heapRetained.getValuesOrThrow("exact"),
          heapRetained.toString());
      assertTrue(
          Long.parseLong(
                  heapRetained.getValuesOrThrow("retainedBytes"))
              >= Long.parseLong(
                  heapRetained.getValuesOrThrow(
                      "object.shallowSize")),
          heapRetained.toString());
      assertTrue(
          heapRetained.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapProbe"),
          heapRetained.toString());
      assertTrue(
          heapRetained.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapLeaf"),
          heapRetained.toString());
      ActionResponse originalHandleAfterRootPath =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-handle-after-root-path"))
                  .setActionId("heap.relations")
                  .putParameters("objectHandle", heapProbeHandle)
                  .putParameters("direction", "OUTGOING")
                  .putParameters("limit", "5")
                  .putParameters("scanLimit", "10000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          originalHandleAfterRootPath.getStatus(),
          originalHandleAfterRootPath.toString());

      ActionResponse retainedRanking =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-retained-ranking"))
                  .setActionId("heap.retained.ranking")
                  .putParameters("name", heapProbeClass.getName())
                  .putParameters(
                      "classLoader",
                      heapProbeClass.getClassLoader())
                  .putParameters("instanceLimit", "3")
                  .putParameters("maximumNodes", "500000")
                  .putParameters("maximumEdges", "2000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          retainedRanking.getStatus(),
          retainedRanking.toString());
      assertEquals(
          "3",
          retainedRanking.getValuesOrThrow("count"),
          retainedRanking.toString());
      assertEquals(
          "true",
          retainedRanking.getValuesOrThrow("exact"),
          retainedRanking.toString());
      assertTrue(
          Long.parseLong(
                  retainedRanking.getValuesOrThrow(
                      "entry.0000.retainedBytes"))
              >= Long.parseLong(
                  retainedRanking.getValuesOrThrow(
                      "entry.0000.shallowSize")),
          retainedRanking.toString());
      assertTrue(
          Long.parseLong(
                  retainedRanking.getValuesOrThrow(
                      "entry.0000.candidateBytes"))
              >= Long.parseLong(
                  retainedRanking.getValuesOrThrow(
                      "entry.0001.candidateBytes")),
          retainedRanking.toString());
      assertTrue(
          retainedRanking.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapProbe"),
          retainedRanking.toString());

      ActionResponse classRetained =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-retained-classes"))
                  .setActionId("heap.retained.classes")
                  .putParameters(
                      "query", "dev.tanwei.integration.Heap")
                  .putParameters("limit", "20")
                  .putParameters("maximumNodes", "500000")
                  .putParameters("maximumEdges", "2000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          classRetained.getStatus(),
          classRetained.toString());
      assertEquals(
          "true",
          classRetained.getValuesOrThrow("exact"),
          classRetained.toString());
      assertTrue(
          Integer.parseInt(
                  classRetained.getValuesOrThrow("count"))
              >= 2,
          classRetained.toString());
      assertTrue(
          classRetained.getValuesMap().containsValue(
              "dev.tanwei.integration.HeapProbe"),
          classRetained.toString());
      assertTrue(
          Long.parseLong(
                  classRetained.getValuesOrThrow(
                      "row.0000.retainedBytes"))
              >= Long.parseLong(
                  classRetained.getValuesOrThrow(
                      "row.0000.shallowBytes")),
          classRetained.toString());
      String heapChainPrefix = "";
      int classRetainedCount =
          Integer.parseInt(
              classRetained.getValuesOrThrow("count"));
      for (int rowIndex = 0;
          rowIndex < classRetainedCount;
          rowIndex++) {
        String candidatePrefix =
            "row."
                + String.format(
                    java.util.Locale.ROOT, "%04d", rowIndex)
                + ".";
        if ("dev.tanwei.integration.HeapChain".equals(
            classRetained.getValuesOrThrow(
                candidatePrefix + "className"))) {
          heapChainPrefix = candidatePrefix;
          break;
        }
      }
      assertFalse(
          heapChainPrefix.isEmpty(),
          classRetained.toString());
      assertEquals(
          "2",
          classRetained.getValuesOrThrow(
              heapChainPrefix + "instanceCount"),
          classRetained.toString());
      assertEquals(
          classRetained.getValuesOrThrow(
              heapChainPrefix + "instanceCount"),
          classRetained.getValuesOrThrow(
              heapChainPrefix + "candidateRetainedObjects"),
          classRetained.toString());
      assertEquals(
          classRetained.getValuesOrThrow(
              heapChainPrefix + "shallowBytes"),
          classRetained.getValuesOrThrow(
              heapChainPrefix + "retainedBytes"),
          classRetained.toString());

      ActionResponse dominatorTree =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-dominator-tree"))
                  .setActionId("heap.dominator.tree")
                  .putParameters("maximumDepth", "4")
                  .putParameters("maximumViewNodes", "80")
                  .putParameters("rootLimit", "10")
                  .putParameters("branchLimit", "5")
                  .putParameters("maximumNodes", "500000")
                  .putParameters("maximumEdges", "2000000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          dominatorTree.getStatus(),
          dominatorTree.toString());
      assertEquals(
          "true",
          dominatorTree.getValuesOrThrow("exact"),
          dominatorTree.toString());
      assertTrue(
          Integer.parseInt(
                  dominatorTree.getValuesOrThrow("count"))
              > 0,
          dominatorTree.toString());
      assertEquals(
          "-1",
          dominatorTree.getValuesOrThrow(
              "node.0000.parentIndex"),
          dominatorTree.toString());
      assertTrue(
          Long.parseLong(
                  dominatorTree.getValuesOrThrow(
                      "node.0000.retainedBytes"))
              >= Long.parseLong(
                  dominatorTree.getValuesOrThrow(
                      "node.0000.shallowBytes")),
          dominatorTree.toString());
      String dominatorHandle =
          dominatorTree.getValuesOrThrow(
              "node.0000.handle");
      ActionResponse dominatorNodeRelations =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("heap-dominator-node-relations"))
                  .setActionId("heap.relations")
                  .putParameters(
                      "objectHandle", dominatorHandle)
                  .putParameters("direction", "OUTGOING")
                  .putParameters("limit", "5")
                  .putParameters("scanLimit", "10000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          dominatorNodeRelations.getStatus(),
          dominatorNodeRelations.toString());
      assertEquals(
          dominatorHandle,
          dominatorNodeRelations.getValuesOrThrow(
              "object.handle"),
          dominatorNodeRelations.toString());

      ActionResponse classDump =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("class-dump"))
                  .setActionId("class.dump")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", classDump.getStatus());
      ByteArrayOutputStream classBytes =
          downloadArtifact(
              authenticated,
              classDump.getValuesOrThrow("token"),
              "class-download");
      assertEquals(
          Long.parseLong(classDump.getValuesOrThrow("size")),
          classBytes.size());
      byte[] classHeader = classBytes.toByteArray();
      assertTrue(classHeader.length > 4);
      assertEquals(0xca, classHeader[0] & 0xff);
      assertEquals(0xfe, classHeader[1] & 0xff);
      assertEquals(0xba, classHeader[2] & 0xff);
      assertEquals(0xbe, classHeader[3] & 0xff);
      assertTrue(
          authenticated
              .deleteArtifact(
                  RemoteArtifactRequest.newBuilder()
                      .setContext(context("class-delete"))
                      .setToken(classDump.getValuesOrThrow("token"))
                      .build())
              .getDeleted());

      int heartbeatLine =
          maximumMethodLine(
              classHeader,
              "heartbeat",
              "(Ljava/lang/String;)Ljava/lang/String;");
      ActionResponse linePreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("line-preview"))
                  .setActionId("line.preview")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "heartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("lineNumber", Integer.toString(heartbeatLine))
                  .build());
      assertEquals("SUCCEEDED", linePreview.getStatus(), linePreview.toString());
      assertEquals(
          Integer.toString(heartbeatLine),
          linePreview.getValuesOrThrow("lineNumber"));
      assertTrue(
          Integer.parseInt(linePreview.getValuesOrThrow("maximumLocalCount"))
              >= 1,
          linePreview.toString());

      ActionResponse lineStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("line-start"))
                  .setActionId("line.start")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "heartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("lineNumber", Integer.toString(heartbeatLine))
                  .putParameters("maximumEvents", "2")
                  .putParameters("timeoutMillis", "5000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", lineStart.getStatus(), lineStart.toString());
      Thread.sleep(400L);
      ActionResponse lineEvents =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("line-events"))
                  .setActionId("line.events")
                  .putParameters(
                      "taskId", lineStart.getValuesOrThrow("taskId"))
                  .putParameters("limit", "10")
                  .build());
      assertEquals("SUCCEEDED", lineEvents.getStatus(), lineEvents.toString());
      assertEquals("2", lineEvents.getValuesOrThrow("captured"));
      assertEquals("2", lineEvents.getValuesOrThrow("event.count"));
      assertEquals(
          Integer.toString(heartbeatLine),
          lineEvents.getValuesOrThrow("event.0000.lineNumber"));
      assertTrue(
          Integer.parseInt(
                  lineEvents.getValuesOrThrow("event.0000.local.count"))
              >= 1,
          lineEvents.toString());
      assertTrue(
          lineEvents.getValuesMap().containsValue("value"),
          lineEvents.toString());
      assertTrue(
          lineEvents.getValuesMap().values().stream()
              .anyMatch(value -> value.startsWith("tick-")),
          lineEvents.toString());

      ActionResponse observationStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("observe-task"))
                  .setActionId("observe.start")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "heartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("maximumEvents", "3")
                  .putParameters("timeoutMillis", "5000")
                  .putParameters("includeInternal", "true")
                  .putParameters(
                      "condition",
                      "durationMs >= 0"
                          + " && arg0 contains \"tick-\""
                          + " && outcome == \"RETURNED\"")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", observationStart.getStatus(), observationStart.toString());
      Thread.sleep(500L);
      ObservationEventsResponse observationEvents =
          authenticated.getObservationEvents(
              ObservationEventsRequest.newBuilder()
                  .setContext(context("observe-events"))
                  .setTaskId(observationStart.getValuesOrThrow("taskId"))
                  .setLimit(10)
                  .build());
      assertEquals(3, observationEvents.getCaptured());
      assertEquals(3, observationEvents.getEventsCount());
      assertTrue(
          observationEvents.getEventsList().stream()
              .allMatch(event -> event.getArgumentsCount() == 1));
      assertTrue(
          observationEvents.getEventsList().stream()
              .allMatch(event -> event.getCallStackCount() > 0));
      assertTrue(
          observationEvents.getEventsList().stream()
              .anyMatch(
                  event ->
                      event.getDepth() > 0
                          && event.getParentSequence() >= 0
                          && event.getMethod().startsWith("decorateTick")));

      ActionResponse snapshotList =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("snapshot-list"))
                  .setActionId("snapshot.list")
                  .putParameters("query", "TestTargetMain")
                  .putParameters("outcome", "RETURNED")
                  .putParameters("scope", "ROOT")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals("SUCCEEDED", snapshotList.getStatus(), snapshotList.toString());
      assertTrue(
          Integer.parseInt(snapshotList.getValuesOrThrow("count")) > 0,
          snapshotList.toString());
      assertEquals(
          targetMainClass.getName(),
          snapshotList.getValuesOrThrow("snapshot.0000.className"));
      String archivedSnapshotId =
          snapshotList.getValuesOrThrow("snapshot.0000.snapshotId");

      ActionResponse snapshotDetails =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("snapshot-describe"))
                  .setActionId("snapshot.describe")
                  .putParameters("snapshotId", archivedSnapshotId)
                  .build());
      assertEquals(
          "SUCCEEDED", snapshotDetails.getStatus(), snapshotDetails.toString());
      assertEquals(targetMainClass.getName(), snapshotDetails.getValuesOrThrow("className"));
      assertTrue(
          snapshotDetails.getValuesOrThrow("method").startsWith("heartbeat"),
          snapshotDetails.toString());
      assertEquals("heartbeat", snapshotDetails.getValuesOrThrow("rootMethodName"));
      assertEquals("true", snapshotDetails.getValuesOrThrow("replayEligible"));
      assertEquals("1", snapshotDetails.getValuesOrThrow("argument.count"));
      assertTrue(
          Integer.parseInt(snapshotDetails.getValuesOrThrow("stack.count")) > 0,
          snapshotDetails.toString());

      ActionResponse filteredStaticSnapshots =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("snapshot-filtered-static"))
                  .setActionId("snapshot.list")
                  .putParameters("query", "heartbeat")
                  .putParameters("outcome", "RETURNED")
                  .putParameters("scope", "ROOT")
                  .putParameters(
                      "taskId", observationStart.getValuesOrThrow("taskId"))
                  .putParameters(
                      "threadQuery",
                      snapshotDetails.getValuesOrThrow("threadName"))
                  .putParameters("replay", "STATIC")
                  .putParameters("minimumDurationMillis", "0")
                  .putParameters("maximumDurationMillis", "1000")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "SUCCEEDED",
          filteredStaticSnapshots.getStatus(),
          filteredStaticSnapshots.toString());
      assertTrue(
          Integer.parseInt(filteredStaticSnapshots.getValuesOrThrow("count")) > 0,
          filteredStaticSnapshots.toString());
      assertEquals(
          observationStart.getValuesOrThrow("taskId"),
          filteredStaticSnapshots.getValuesOrThrow("snapshot.0000.taskId"));
      assertEquals(
          "STATIC",
          filteredStaticSnapshots.getValuesOrThrow("snapshot.0000.replayMode"));

      ActionResponse invalidSnapshotDuration =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("snapshot-filter-invalid-duration"))
                  .setActionId("snapshot.list")
                  .putParameters("query", "")
                  .putParameters("outcome", "ALL")
                  .putParameters("scope", "ROOT")
                  .putParameters("minimumDurationMillis", "100")
                  .putParameters("maximumDurationMillis", "99")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "FAILED",
          invalidSnapshotDuration.getStatus(),
          invalidSnapshotDuration.toString());
      assertEquals(
          "INVALID_SNAPSHOT_QUERY",
          invalidSnapshotDuration.getErrorCode());

      ActionResponse snapshotDelete =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("snapshot-delete"))
                  .setActionId("snapshot.delete")
                  .putParameters("snapshotId", archivedSnapshotId)
                  .build());
      assertEquals("SUCCEEDED", snapshotDelete.getStatus(), snapshotDelete.toString());
      assertEquals("true", snapshotDelete.getValuesOrThrow("deleted"));

      ActionResponse missingSnapshot =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("snapshot-describe-missing"))
                  .setActionId("snapshot.describe")
                  .putParameters("snapshotId", archivedSnapshotId)
                  .build());
      assertEquals("FAILED", missingSnapshot.getStatus(), missingSnapshot.toString());
      assertEquals(
          "SNAPSHOT_NOT_FOUND",
          missingSnapshot.getErrorCode());
      authenticated.cancelObservation(
          ObservationTaskRequest.newBuilder()
              .setContext(context("observe-cancel"))
              .setTaskId(observationStart.getValuesOrThrow("taskId"))
              .build());

      ActionResponse instanceObservationStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("instance-observe-task"))
                  .setActionId("observe.start")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "instanceHeartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("maximumEvents", "1")
                  .putParameters("timeoutMillis", "5000")
                  .putParameters("includeInternal", "false")
                  .putParameters("condition", "arg0 contains \"instance-\"")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          instanceObservationStart.getStatus(),
          instanceObservationStart.toString());
      Thread.sleep(300L);
      ObservationEventsResponse instanceEvents =
          authenticated.getObservationEvents(
              ObservationEventsRequest.newBuilder()
                  .setContext(context("instance-observe-events"))
                  .setTaskId(
                      instanceObservationStart.getValuesOrThrow("taskId"))
                  .setLimit(5)
                  .build());
      assertEquals(1, instanceEvents.getEventsCount(), instanceEvents.toString());

      ActionResponse instanceSnapshotList =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("instance-snapshot-list"))
                  .setActionId("snapshot.list")
                  .putParameters("query", "instanceHeartbeat")
                  .putParameters("outcome", "RETURNED")
                  .putParameters("scope", "ROOT")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "SUCCEEDED",
          instanceSnapshotList.getStatus(),
          instanceSnapshotList.toString());
      String instanceSnapshotId =
          instanceSnapshotList.getValuesOrThrow("snapshot.0000.snapshotId");
      ActionResponse instanceSnapshotDetails =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("instance-snapshot-describe"))
                  .setActionId("snapshot.describe")
                  .putParameters("snapshotId", instanceSnapshotId)
                  .build());
      assertEquals(
          "SUCCEEDED",
          instanceSnapshotDetails.getStatus(),
          instanceSnapshotDetails.toString());
      assertEquals(
          "INSTANCE",
          instanceSnapshotDetails.getValuesOrThrow("replayMode"));
      assertEquals(
          "true",
          instanceSnapshotDetails.getValuesOrThrow("receiverAvailable"));
      assertEquals(
          "true",
          instanceSnapshotDetails.getValuesOrThrow("replayEligible"));
      assertEquals(
          "true",
          instanceSnapshotDetails.getValuesOrThrow(
              "receiverState.available"));
      assertEquals(
          "1",
          instanceSnapshotDetails.getValuesOrThrow("receiverState.count"));
      assertEquals(
          targetMainClass.getName() + "#instanceReplaySequence",
          instanceSnapshotDetails.getValuesOrThrow("receiverState.00.name"));
      assertTrue(
          Long.parseLong(
                  instanceSnapshotDetails.getValuesOrThrow(
                      "receiverState.00.value"))
              > 0L,
          instanceSnapshotDetails.toString());
      ActionResponse filteredInstanceSnapshots =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("snapshot-filtered-instance"))
                  .setActionId("snapshot.list")
                  .putParameters("query", "instanceHeartbeat")
                  .putParameters("outcome", "RETURNED")
                  .putParameters("scope", "ROOT")
                  .putParameters(
                      "taskId",
                      instanceObservationStart.getValuesOrThrow("taskId"))
                  .putParameters(
                      "threadQuery",
                      instanceSnapshotDetails.getValuesOrThrow("threadName"))
                  .putParameters("replay", "INSTANCE")
                  .putParameters("minimumDurationMillis", "0")
                  .putParameters("maximumDurationMillis", "1000")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "SUCCEEDED",
          filteredInstanceSnapshots.getStatus(),
          filteredInstanceSnapshots.toString());
      assertEquals(
          "1",
          filteredInstanceSnapshots.getValuesOrThrow("count"),
          filteredInstanceSnapshots.toString());
      assertEquals(
          "INSTANCE",
          filteredInstanceSnapshots.getValuesOrThrow(
              "snapshot.0000.replayMode"));
      String instanceArgument =
          instanceSnapshotDetails.getValuesOrThrow("argument.00");
      ActionResponse instanceReplayPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("instance-replay-preview"))
                  .setActionId("invoke.replay.preview")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "instanceHeartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("argumentCount", "1")
                  .putParameters("argument0", instanceArgument)
                  .putParameters("snapshotId", instanceSnapshotId)
                  .putParameters("replayMode", "INSTANCE")
                  .build());
      assertEquals(
          "SUCCEEDED",
          instanceReplayPreview.getStatus(),
          instanceReplayPreview.toString());
      assertEquals(
          "INSTANCE",
          instanceReplayPreview.getValuesOrThrow("replayMode"));
      assertTrue(
          instanceReplayPreview.getValuesOrThrow("invocation")
              .startsWith("<receiver:"),
          instanceReplayPreview.toString());
      assertEquals(
          "true",
          instanceReplayPreview.getValuesOrThrow("currentState.available"));
      assertEquals(
          targetMainClass.getName() + "#instanceReplaySequence",
          instanceReplayPreview.getValuesOrThrow("currentState.00.name"));
      ActionResponse instanceReplay =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("instance-replay"))
                  .setActionId("invoke.replay")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "instanceHeartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("argumentCount", "1")
                  .putParameters("argument0", instanceArgument)
                  .putParameters("snapshotId", instanceSnapshotId)
                  .putParameters("replayMode", "INSTANCE")
                  .putParameters(
                      "expectedFingerprint",
                      instanceReplayPreview.getValuesOrThrow("fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", instanceReplay.getStatus(), instanceReplay.toString());
      assertEquals("RETURNED", instanceReplay.getValuesOrThrow("outcome"));
      assertTrue(
          instanceReplay.getValuesOrThrow("returnValue")
              .startsWith(instanceArgument + ":"),
          instanceReplay.toString());
      assertEquals(
          "1",
          instanceReplay.getValuesOrThrow("stateChange.count"),
          instanceReplay.toString());
      assertEquals(
          targetMainClass.getName() + "#instanceReplaySequence",
          instanceReplay.getValuesOrThrow("stateChange.00.name"));
      assertTrue(
          Long.parseLong(
                  instanceReplay.getValuesOrThrow("stateChange.00.after"))
              > Long.parseLong(
                  instanceReplay.getValuesOrThrow("stateChange.00.before")),
          instanceReplay.toString());

      ActionResponse structuredObservationStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("structured-observe-task"))
                  .setActionId("observe.start")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "structuredHeartbeat")
                  .putParameters(
                      "parameterTypes",
                      "dev.tanwei.integration.ObservationPayload")
                  .putParameters("maximumEvents", "1")
                  .putParameters("timeoutMillis", "5000")
                  .putParameters("includeInternal", "false")
                  .putParameters("condition", "")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          structuredObservationStart.getStatus(),
          structuredObservationStart.toString());
      Thread.sleep(300L);
      ObservationEventsResponse structuredEvents =
          authenticated.getObservationEvents(
              ObservationEventsRequest.newBuilder()
                  .setContext(context("structured-observe-events"))
                  .setTaskId(
                      structuredObservationStart.getValuesOrThrow("taskId"))
                  .setLimit(5)
                  .build());
      assertEquals(1, structuredEvents.getEventsCount(), structuredEvents.toString());

      ActionResponse structuredSnapshotList =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("structured-snapshot-list"))
                  .setActionId("snapshot.list")
                  .putParameters("query", "structuredHeartbeat")
                  .putParameters("outcome", "RETURNED")
                  .putParameters("scope", "ROOT")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "SUCCEEDED",
          structuredSnapshotList.getStatus(),
          structuredSnapshotList.toString());
      assertEquals("1", structuredSnapshotList.getValuesOrThrow("count"));
      String structuredSnapshotId =
          structuredSnapshotList.getValuesOrThrow("snapshot.0000.snapshotId");
      ActionResponse structuredSnapshot =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("structured-snapshot-describe"))
                  .setActionId("snapshot.describe")
                  .putParameters("snapshotId", structuredSnapshotId)
                  .build());
      assertEquals(
          "SUCCEEDED", structuredSnapshot.getStatus(), structuredSnapshot.toString());
      assertEquals(
          "true", structuredSnapshot.getValuesOrThrow("invocationValue.available"));
      assertTrue(
          Integer.parseInt(
                  structuredSnapshot.getValuesOrThrow("invocationValue.count"))
              >= 12,
          structuredSnapshot.toString());
      assertEquals(
          "<masked>",
          invocationNodeValue(structuredSnapshot, "arg[0].apiToken", "value"));
      assertEquals(
          "us-west",
          invocationNodeValue(structuredSnapshot, "arg[0].detail.region", "value"));
      assertEquals(
          "ARRAY",
          invocationNodeValue(structuredSnapshot, "arg[0].samples", "kind"));
      assertEquals(
          "MAP",
          invocationNodeValue(structuredSnapshot, "arg[0].attributes", "kind"));
      assertEquals(
          "ENTRY",
          invocationNodeValue(
              structuredSnapshot, "arg[0].attributes[0]", "kind"));
      assertEquals(
          "region",
          invocationNodeValue(
              structuredSnapshot, "arg[0].attributes[0].key", "value"));
      assertEquals(
          "us-west",
          invocationNodeValue(
              structuredSnapshot, "arg[0].attributes[0].value", "value"));
      assertEquals(
          "MASKED",
          invocationNodeValue(
              structuredSnapshot, "arg[0].attributes[1].value", "kind"));
      assertEquals(
          "COLLECTION",
          invocationNodeValue(structuredSnapshot, "arg[0].tags", "kind"));
      assertEquals(
          "checkout",
          invocationNodeValue(structuredSnapshot, "arg[0].tags[0]", "value"));
      assertEquals(
          "REFERENCE",
          invocationNodeValue(structuredSnapshot, "arg[0].self", "kind"));
      assertEquals(
          "arg[0]",
          invocationNodeValue(structuredSnapshot, "result.payload", "value"));
      assertEquals(
          "false", structuredSnapshot.getValuesOrThrow("replayEligible"));
      ActionResponse structuredValueSearch =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("structured-value-search"))
                  .setActionId("snapshot.list")
                  .putParameters("query", "us-west")
                  .putParameters("outcome", "ALL")
                  .putParameters("scope", "ROOT")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "1", structuredValueSearch.getValuesOrThrow("count"), structuredValueSearch.toString());

      ActionResponse monitorPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("monitor-preview"))
                  .setActionId("monitor.preview")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "unstableHeartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .build());
      assertEquals(
          "SUCCEEDED", monitorPreview.getStatus(), monitorPreview.toString());
      assertEquals("1", monitorPreview.getValuesOrThrow("matchCount"));

      ActionResponse monitorStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("monitor-task"))
                  .setActionId("monitor.start")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "unstableHeartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("intervalMillis", "1000")
                  .putParameters("durationMillis", "10000")
                  .putParameters("minimumDurationMillis", "60000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", monitorStart.getStatus(), monitorStart.toString());
      assertEquals(
          "60000",
          monitorStart.getValuesOrThrow("minimumDurationMillis"));
      ActionResponse monitorThresholdUpdate =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("monitor-threshold-update"))
                  .setActionId("monitor.threshold.update")
                  .putParameters(
                      "taskId", monitorStart.getValuesOrThrow("taskId"))
                  .putParameters("minimumDurationMillis", "0")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          monitorThresholdUpdate.getStatus(),
          monitorThresholdUpdate.toString());
      assertEquals(
          "60000",
          monitorThresholdUpdate.getValuesOrThrow(
              "previousMinimumDurationMillis"));
      assertEquals(
          "0",
          monitorThresholdUpdate.getValuesOrThrow(
              "minimumDurationMillis"));
      Thread.sleep(1_300L);
      ActionResponse monitorWindows =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("monitor-windows"))
                  .setActionId("monitor.windows")
                  .putParameters(
                      "taskId", monitorStart.getValuesOrThrow("taskId"))
                  .putParameters("afterSequence", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "SUCCEEDED", monitorWindows.getStatus(), monitorWindows.toString());
      assertTrue(
          Integer.parseInt(
                  monitorWindows.getValuesOrThrow("window.count"))
              >= 2,
          monitorWindows.toString());
      assertEquals(
          "0", monitorWindows.getValuesOrThrow("minimumDurationMillis"));
      assertEquals(
          "60000",
          monitorWindows.getValuesOrThrow(
              "window.0000.minimumDurationMillis"));
      assertEquals(
          "0",
          monitorWindows.getValuesOrThrow(
              "window.0001.minimumDurationMillis"));
      assertTrue(
          Long.parseLong(monitorWindows.getValuesOrThrow("totalCalls")) >= 5L,
          monitorWindows.toString());
      assertTrue(
          Long.parseLong(
                  monitorWindows.getValuesOrThrow("totalFailures"))
              >= 1L,
          monitorWindows.toString());
      long totalP95DurationNanos =
          Long.parseLong(
              monitorWindows.getValuesOrThrow(
                  "totalP95DurationNanos"));
      long totalP99DurationNanos =
          Long.parseLong(
              monitorWindows.getValuesOrThrow(
                  "totalP99DurationNanos"));
      assertTrue(totalP95DurationNanos > 0L, monitorWindows.toString());
      assertTrue(
          totalP99DurationNanos >= totalP95DurationNanos,
          monitorWindows.toString());
      long windowP95DurationNanos =
          Long.parseLong(
              monitorWindows.getValuesOrThrow(
                  "window.0001.p95DurationNanos"));
      long windowP99DurationNanos =
          Long.parseLong(
              monitorWindows.getValuesOrThrow(
                  "window.0001.p99DurationNanos"));
      assertTrue(windowP95DurationNanos > 0L, monitorWindows.toString());
      assertTrue(
          windowP99DurationNanos >= windowP95DurationNanos,
          monitorWindows.toString());

      ActionResponse monitorTasks =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("monitor-tasks"))
                  .setActionId("tasks.list")
                  .build());
      assertTrue(
          monitorTasks.getValuesMap().containsValue("MONITOR"),
          monitorTasks.toString());
      ActionResponse monitorCancel =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("monitor-cancel"))
                  .setActionId("tasks.cancel")
                  .putParameters("kind", "MONITOR")
                  .putParameters(
                      "taskId", monitorStart.getValuesOrThrow("taskId"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", monitorCancel.getStatus(), monitorCancel.toString());
      assertEquals("CANCELLED", monitorCancel.getValuesOrThrow("state"));

      ActionResponse tracePreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("trace-preview"))
                  .setActionId("trace.preview")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "heartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters(
                      "scopePrefix", "dev.tanwei.integration")
                  .putParameters(
                      "includeRules",
                      "dev.tanwei.integration.TraceSupport\n"
                          + "dev.tanwei.integration.TestTargetMain#decorateTick")
                  .putParameters(
                      "excludeRules",
                      "dev.tanwei.integration.TraceSupport#normalize")
                  .build());
      assertEquals(
          "SUCCEEDED", tracePreview.getStatus(), tracePreview.toString());
      assertEquals("true", tracePreview.getValuesOrThrow("withinLimit"));
      assertEquals("2", tracePreview.getValuesOrThrow("class.count"));
      assertEquals(
          "3",
          tracePreview.getValuesOrThrow("instrumentedMethodCount"));
      assertEquals(
          "dev.tanwei.integration.TraceSupport\n"
              + "dev.tanwei.integration.TestTargetMain#decorateTick",
          tracePreview.getValuesOrThrow("includeRules"));
      assertEquals(
          "dev.tanwei.integration.TraceSupport#normalize",
          tracePreview.getValuesOrThrow("excludeRules"));

      ActionResponse traceStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("trace-task"))
                  .setActionId("trace.start")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "heartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters(
                      "scopePrefix", "dev.tanwei.integration")
                  .putParameters(
                      "includeRules",
                      "dev.tanwei.integration.TraceSupport\n"
                          + "dev.tanwei.integration.TestTargetMain#decorateTick")
                  .putParameters(
                      "excludeRules",
                      "dev.tanwei.integration.TraceSupport#normalize")
                  .putParameters("maximumTraces", "20")
                  .putParameters("maximumDepth", "8")
                  .putParameters("maximumSpans", "64")
                  .putParameters("minimumDurationMillis", "60000")
                  .putParameters("timeoutMillis", "5000")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", traceStart.getStatus(), traceStart.toString());
      ActionResponse traceThresholdUpdate =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("trace-threshold-update"))
                  .setActionId("trace.threshold.update")
                  .putParameters(
                      "taskId", traceStart.getValuesOrThrow("taskId"))
                  .putParameters("minimumDurationMillis", "0")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          traceThresholdUpdate.getStatus(),
          traceThresholdUpdate.toString());
      assertEquals(
          "60000",
          traceThresholdUpdate.getValuesOrThrow(
              "previousMinimumDurationMillis"));
      assertEquals(
          "0",
          traceThresholdUpdate.getValuesOrThrow("minimumDurationMillis"));
      Thread.sleep(400L);
      ActionResponse traceEvents =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("trace-events"))
                  .setActionId("trace.events")
                  .putParameters(
                      "taskId", traceStart.getValuesOrThrow("taskId"))
                  .putParameters("limit", "5")
                  .build());
      assertEquals(
          "SUCCEEDED", traceEvents.getStatus(), traceEvents.toString());
      assertEquals(
          "0", traceEvents.getValuesOrThrow("minimumDurationMillis"));
      assertTrue(
          Integer.parseInt(traceEvents.getValuesOrThrow("trace.count"))
              >= 1,
          traceEvents.toString());
      assertTrue(
          traceEvents.getValuesMap().entrySet().stream()
              .filter(entry -> entry.getKey().endsWith(".method"))
              .map(entry -> entry.getValue())
              .anyMatch(
                  value ->
                      value.startsWith(
                          "dev.tanwei.integration.TraceSupport#decorate")),
          traceEvents.toString());
      String decorateMethodKey =
          traceEvents.getValuesMap().entrySet().stream()
              .filter(entry -> entry.getKey().endsWith(".method"))
              .filter(
                  entry ->
                      entry.getValue().startsWith(
                          "dev.tanwei.integration.TraceSupport#decorate"))
              .map(Map.Entry::getKey)
              .findFirst()
              .orElseThrow(
                  () -> new AssertionError(traceEvents.toString()));
      String decorateSpanPrefix =
          decorateMethodKey.substring(
              0, decorateMethodKey.length() - "method".length());
      assertEquals(
          "TestTargetMain.java",
          traceEvents.getValuesOrThrow(decorateSpanPrefix + "callSiteFile"));
      assertTrue(
          Integer.parseInt(
                  traceEvents.getValuesOrThrow(
                      decorateSpanPrefix + "callSiteLine"))
              > 0,
          traceEvents.toString());
      assertFalse(
          traceEvents.getValuesMap().entrySet().stream()
              .filter(entry -> entry.getKey().endsWith(".method"))
              .map(entry -> entry.getValue())
              .anyMatch(
                  value ->
                      value.startsWith(
                          "dev.tanwei.integration.TraceSupport#normalize")),
          traceEvents.toString());

      ActionResponse traceTasks =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("trace-tasks"))
                  .setActionId("tasks.list")
                  .build());
      assertTrue(
          traceTasks.getValuesMap().containsValue("TRACE"),
          traceTasks.toString());
      ActionResponse traceCancel =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("trace-cancel"))
                  .setActionId("tasks.cancel")
                  .putParameters("kind", "TRACE")
                  .putParameters(
                      "taskId", traceStart.getValuesOrThrow("taskId"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", traceCancel.getStatus(), traceCancel.toString());
      assertEquals("CANCELLED", traceCancel.getValuesOrThrow("state"));

      ActionResponse replayPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("replay-preview"))
                  .setActionId("invoke.replay.preview")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "heartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("argumentCount", "1")
                  .putParameters("argument0", "replay")
                  .build());
      assertEquals("SUCCEEDED", replayPreview.getStatus(), replayPreview.toString());
      ActionResponse replay =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("replay-execute"))
                  .setActionId("invoke.replay")
                  .putParameters("className", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("methodName", "heartbeat")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("argumentCount", "1")
                  .putParameters("argument0", "replay")
                  .putParameters(
                      "expectedFingerprint",
                      replayPreview.getValuesOrThrow("fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals("SUCCEEDED", replay.getStatus(), replay.toString());
      assertEquals("RETURNED", replay.getValuesOrThrow("outcome"));
      assertEquals("REPLAY", replay.getValuesOrThrow("returnValue"));

      byte[] replacementBytecode =
          replaceStringConstant(classHeader, "redefineProbe", "before", "after");
      String encodedReplacement =
          Base64.getEncoder().encodeToString(replacementBytecode);
      ActionResponse redefinePreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("class-redefine-preview"))
                  .setActionId("class.redefine.preview")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("bytecodeBase64", encodedReplacement)
                  .build());
      assertEquals(
          "SUCCEEDED", redefinePreview.getStatus(), redefinePreview.toString());
      assertEquals(
          "true", redefinePreview.getValuesOrThrow("structuralCompatible"));
      int outputBeforeRedefine = target.output().length();
      ActionResponse redefine =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("class-redefine"))
                  .setActionId("class.redefine")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("bytecodeBase64", encodedReplacement)
                  .putParameters(
                      "expectedCurrentSha256",
                      redefinePreview.getValuesOrThrow("currentSha256"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", redefine.getStatus(), redefine.toString());
      assertTrue(
          awaitOutputAfter(
              target, "TANWEI_REDEFINE=after", outputBeforeRedefine),
          target.output());

      ActionResponse staleRedefine =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("class-redefine-stale"))
                  .setActionId("class.redefine")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("bytecodeBase64", encodedReplacement)
                  .putParameters(
                      "expectedCurrentSha256",
                      redefinePreview.getValuesOrThrow("currentSha256"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("FAILED", staleRedefine.getStatus());
      assertEquals("STALE_CLASS_DEFINITION", staleRedefine.getErrorCode());

      int outputBeforeRestore = target.output().length();
      ActionResponse restore =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("class-redefine-restore"))
                  .setActionId("class.redefine.restore")
                  .putParameters(
                      "rollbackToken", redefine.getValuesOrThrow("rollbackToken"))
                  .putParameters(
                      "expectedCurrentSha256",
                      redefine.getValuesOrThrow(
                          "rollbackExpectedCurrentSha256"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", restore.getStatus(), restore.toString());
      assertTrue(
          awaitOutputAfter(
              target, "TANWEI_REDEFINE=before", outputBeforeRestore),
          target.output());

      ClassListResponse supportClasses =
          authenticated.listClasses(
              ClassListRequest.newBuilder()
                  .setContext(context("change-set-support-class"))
                  .setLimit(20)
                  .setNameQuery(
                      "dev.tanwei.integration.ChangeSetSupport")
                  .build());
      dev.tanwei.protocol.v1.ClassDescriptor supportClass =
          supportClasses.getClassesList().stream()
              .filter(
                  type ->
                      "dev.tanwei.integration.ChangeSetSupport"
                          .equals(type.getName()))
              .findFirst()
              .orElseThrow(
                  () ->
                      new AssertionError(
                          "Exact ChangeSetSupport class was not found"));
      assertEquals(
          targetMainClass.getClassLoader(),
          supportClass.getClassLoader());
      ActionResponse supportDump =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("change-set-support-dump"))
                  .setActionId("class.dump")
                  .putParameters("name", supportClass.getName())
                  .putParameters(
                      "classLoader", supportClass.getClassLoader())
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", supportDump.getStatus(), supportDump.toString());
      byte[] supportBytecode =
          downloadArtifact(
                  authenticated,
                  supportDump.getValuesOrThrow("token"),
                  "change-set-support-download")
              .toByteArray();
      assertTrue(
          authenticated
              .deleteArtifact(
                  RemoteArtifactRequest.newBuilder()
                      .setContext(context("change-set-support-delete"))
                      .setToken(
                          supportDump.getValuesOrThrow("token"))
                      .build())
              .getDeleted());

      String encodedMainChange =
          Base64.getEncoder()
              .encodeToString(
                  replaceStringConstant(
                      classHeader,
                      "redefineProbe",
                      "before",
                      "batch-main"));
      String encodedSupportChange =
          Base64.getEncoder()
              .encodeToString(
                  replaceStringConstant(
                      supportBytecode,
                      "redefineProbe",
                      "support-before",
                      "support-after"));
      ActionRequest.Builder changeSetPreviewRequest =
          ActionRequest.newBuilder()
              .setContext(context("class-change-set-preview"))
              .setActionId("class.change-set.preview")
              .putParameters("count", "2")
              .putParameters("item0Name", targetMainClass.getName())
              .putParameters(
                  "item0ClassLoader",
                  targetMainClass.getClassLoader())
              .putParameters(
                  "item0BytecodeBase64", encodedMainChange)
              .putParameters("item1Name", supportClass.getName())
              .putParameters(
                  "item1ClassLoader", supportClass.getClassLoader())
              .putParameters(
                  "item1BytecodeBase64", encodedSupportChange);
      ActionResponse changeSetPreview =
          authenticated.executeAction(changeSetPreviewRequest.build());
      assertEquals(
          "SUCCEEDED",
          changeSetPreview.getStatus(),
          changeSetPreview.toString());
      assertEquals("2", changeSetPreview.getValuesOrThrow("count"));
      assertEquals(
          "true",
          changeSetPreview.getValuesOrThrow(
              "structuralCompatible"));

      int outputBeforeChangeSet = target.output().length();
      ActionResponse changeSetApply =
          authenticated.executeAction(
              changeSetPreviewRequest
                  .clone()
                  .setContext(context("class-change-set-apply"))
                  .setActionId("class.change-set.apply")
                  .putParameters(
                      "expectedFingerprint",
                      changeSetPreview.getValuesOrThrow(
                          "fingerprint"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          changeSetApply.getStatus(),
          changeSetApply.toString());
      assertEquals("2", changeSetApply.getValuesOrThrow("count"));
      assertTrue(
          awaitOutputAfter(
              target,
              "TANWEI_CHANGE_SET=batch-main/support-after",
              outputBeforeChangeSet),
          target.output());

      int outputBeforeChangeSetRestore = target.output().length();
      ActionResponse changeSetRestore =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("class-change-set-restore"))
                  .setActionId("class.change-set.restore")
                  .putParameters(
                      "rollbackToken",
                      changeSetApply.getValuesOrThrow(
                          "rollbackToken"))
                  .putParameters(
                      "expectedCurrentFingerprint",
                      changeSetApply.getValuesOrThrow(
                          "rollbackExpectedCurrentFingerprint"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          changeSetRestore.getStatus(),
          changeSetRestore.toString());
      assertTrue(
          awaitOutputAfter(
              target,
              "TANWEI_CHANGE_SET=before/support-before",
              outputBeforeChangeSetRestore),
          target.output());

      int outputBeforeManagedReset = target.output().length();
      ActionResponse managedResetRedefinePreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(
                      context("class-redefine-preview-for-session-reset"))
                  .setActionId("class.redefine.preview")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("bytecodeBase64", encodedReplacement)
                  .build());
      assertEquals(
          "SUCCEEDED",
          managedResetRedefinePreview.getStatus(),
          managedResetRedefinePreview.toString());
      ActionResponse redefineForManagedReset =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("class-redefine-for-session-reset"))
                  .setActionId("class.redefine")
                  .putParameters("name", targetMainClass.getName())
                  .putParameters(
                      "classLoader", targetMainClass.getClassLoader())
                  .putParameters("bytecodeBase64", encodedReplacement)
                  .putParameters(
                      "expectedCurrentSha256",
                      managedResetRedefinePreview.getValuesOrThrow(
                          "currentSha256"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          redefineForManagedReset.getStatus(),
          redefineForManagedReset.toString());
      assertTrue(
          awaitOutputAfter(
              target,
              "TANWEI_REDEFINE=after",
              outputBeforeManagedReset),
          target.output());

      ActionResponse managedResetPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("session-reset-preview-class"))
                  .setActionId("session.reset.preview")
                  .build());
      assertEquals(
          "SUCCEEDED",
          managedResetPreview.getStatus(),
          managedResetPreview.toString());
      assertEquals(
          "1", managedResetPreview.getValuesOrThrow("class.total"));
      assertEquals(
          "1", managedResetPreview.getValuesOrThrow("rollback.total"));

      ActionResponse unconfirmedManagedReset =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("session-reset-unconfirmed"))
                  .setActionId("session.reset")
                  .putParameters(
                      "expectedFingerprint",
                      managedResetPreview.getValuesOrThrow("fingerprint"))
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("FAILED", unconfirmedManagedReset.getStatus());
      assertEquals(
          "CONFIRMATION_REQUIRED",
          unconfirmedManagedReset.getErrorCode());

      int outputBeforeSessionReset = target.output().length();
      ActionResponse managedReset =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("session-reset-class"))
                  .setActionId("session.reset")
                  .putParameters(
                      "expectedFingerprint",
                      managedResetPreview.getValuesOrThrow("fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", managedReset.getStatus(), managedReset.toString());
      assertEquals("RESET", managedReset.getValuesOrThrow("outcome"));
      assertEquals(
          "0", managedReset.getValuesOrThrow("remainingClassCount"));
      assertTrue(
          awaitOutputAfter(
              target,
              "TANWEI_REDEFINE=before",
              outputBeforeSessionReset),
          target.output());

      ActionResponse jvmInfo =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("jvm-info"))
                  .setActionId("jvm.info")
                  .build());
      assertEquals("SUCCEEDED", jvmInfo.getStatus());
      assertTrue(jvmInfo.containsValues("java.version"));

      ActionResponse jitCompiler =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("jit-compiler-summary"))
                  .setActionId("jit.compiler.summary")
                  .build());
      assertEquals(
          "SUCCEEDED", jitCompiler.getStatus(), jitCompiler.toString());
      assertEquals("1", jitCompiler.getValuesOrThrow("schemaVersion"));
      assertTrue(
          Long.parseLong(
                  jitCompiler.getValuesOrThrow("sampledAtEpochMillis"))
              > 0L,
          jitCompiler.toString());
      assertEquals(
          "true",
          jitCompiler.getValuesOrThrow("compiler.available"),
          jitCompiler.toString());
      assertFalse(
          jitCompiler.getValuesOrThrow("compiler.name").isEmpty(),
          jitCompiler.toString());
      assertTrue(
          Integer.parseInt(jitCompiler.getValuesOrThrow("codeCache.count"))
              > 0,
          jitCompiler.toString());
      assertTrue(
          Long.parseLong(
                  jitCompiler.getValuesOrThrow(
                      "codeCache.totalCommittedBytes"))
              > 0L,
          jitCompiler.toString());
      assertEquals(
          "true",
          jitCompiler.getValuesOrThrow("internal.available"),
          jitCompiler.toString());
      assertTrue(
          jitCompiler.containsValues("metric.totalCompiles"),
          jitCompiler.toString());

      ActionResponse perfCounters =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("perfcounter-list"))
                  .setActionId("perfcounter.list")
                  .putParameters("query", "java.cls")
                  .putParameters("namespace", "JAVA")
                  .putParameters("offset", "0")
                  .putParameters("limit", "20")
                  .build());
      assertEquals(
          "SUCCEEDED", perfCounters.getStatus(), perfCounters.toString());
      assertTrue(
          Integer.parseInt(perfCounters.getValuesOrThrow("count")) > 0,
          perfCounters.toString());
      assertTrue(
          perfCounters.getValuesMap().entrySet().stream()
              .anyMatch(
                  entry ->
                      entry.getKey().endsWith(".name")
                          && entry.getValue().startsWith("java.cls.")),
          perfCounters.toString());
      assertTrue(
          perfCounters.containsValues("counter.0000.units"),
          perfCounters.toString());
      assertTrue(
          perfCounters.containsValues("counter.0000.variability"),
          perfCounters.toString());
      String firstCounterName =
          perfCounters.getValuesOrThrow("counter.0000.name");
      String secondCounterName =
          Integer.parseInt(perfCounters.getValuesOrThrow("count")) > 1
              ? perfCounters.getValuesOrThrow("counter.0001.name")
              : firstCounterName;
      String snapshotNames =
          firstCounterName.equals(secondCounterName)
              ? firstCounterName
              : firstCounterName + "\n" + secondCounterName;
      ActionResponse perfCounterSnapshot =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("perfcounter-snapshot"))
                  .setActionId("perfcounter.snapshot")
                  .putParameters("names", snapshotNames)
                  .build());
      assertEquals(
          "SUCCEEDED",
          perfCounterSnapshot.getStatus(),
          perfCounterSnapshot.toString());
      assertEquals(
          Integer.toString(snapshotNames.split("\\n").length),
          perfCounterSnapshot.getValuesOrThrow("count"),
          perfCounterSnapshot.toString());
      assertEquals(
          firstCounterName,
          perfCounterSnapshot.getValuesOrThrow("counter.0000.name"));
      assertTrue(
          Long.parseLong(
                  perfCounterSnapshot.getValuesOrThrow(
                      "sampledAtEpochMillis"))
              > 0L);

      for (String actionId :
          new String[] {
            "mbeans.summary",
            "vm.options",
            "logging.summary",
            "classloaders.summary"
          }) {
        ActionResponse response =
            authenticated.executeAction(
                ActionRequest.newBuilder()
                    .setContext(context(actionId))
                    .setActionId(actionId)
                    .build());
        assertEquals("SUCCEEDED", response.getStatus(), actionId);
        assertFalse(response.getValuesMap().isEmpty(), actionId);
      }

      ActionResponse mbeanList =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-list"))
                  .setActionId("mbean.list")
                  .putParameters("query", "java.lang:type=Memory")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals("SUCCEEDED", mbeanList.getStatus(), mbeanList.toString());
      assertTrue(
          mbeanList.getValuesMap().containsValue("java.lang:type=Memory"),
          mbeanList.toString());

      ActionResponse mbeanDescription =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-describe"))
                  .setActionId("mbean.describe")
                  .putParameters("objectName", "java.lang:type=Memory")
                  .build());
      assertEquals(
          "SUCCEEDED", mbeanDescription.getStatus(), mbeanDescription.toString());
      assertTrue(
          mbeanDescription.getValuesMap().containsValue("HeapMemoryUsage"),
          mbeanDescription.toString());

      ActionResponse mbeanAttribute =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-attribute-read"))
                  .setActionId("mbean.attribute.read")
                  .putParameters("objectName", "java.lang:type=Memory")
                  .putParameters("attribute", "HeapMemoryUsage")
                  .build());
      assertEquals(
          "SUCCEEDED", mbeanAttribute.getStatus(), mbeanAttribute.toString());
      assertTrue(
          mbeanAttribute.getValuesOrThrow("value").contains("used="),
          mbeanAttribute.toString());

      ActionResponse mbeanOperationPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-operation-preview"))
                  .setActionId("mbean.operation.preview")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=Control")
                  .putParameters("operation", "ping")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("argumentCount", "1")
                  .putParameters("argument0", "integration")
                  .build());
      assertEquals(
          "SUCCEEDED",
          mbeanOperationPreview.getStatus(),
          mbeanOperationPreview.toString());
      assertEquals(
          "R4", mbeanOperationPreview.getValuesOrThrow("risk"));

      ActionResponse mbeanOperation =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-operation-invoke"))
                  .setActionId("mbean.operation.invoke")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=Control")
                  .putParameters("operation", "ping")
                  .putParameters("parameterTypes", "java.lang.String")
                  .putParameters("argumentCount", "1")
                  .putParameters("argument0", "integration")
                  .putParameters(
                      "expectedFingerprint",
                      mbeanOperationPreview.getValuesOrThrow("fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", mbeanOperation.getStatus(), mbeanOperation.toString());
      assertEquals(
          "RETURNED", mbeanOperation.getValuesOrThrow("outcome"));
      assertEquals(
          "pong:integration",
          mbeanOperation.getValuesOrThrow("returnValue"));

      String openOperationArgument =
          "{\"threshold\":42,\"labels\":[\"desktop\",\"safe\"],\"enabled\":false}";
      ActionResponse openOperationPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-open-operation-preview"))
                  .setActionId("mbean.operation.preview")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=OpenControl")
                  .putParameters("operation", "applySettings")
                  .putParameters(
                      "parameterTypes",
                      "javax.management.openmbean.CompositeData")
                  .putParameters("argumentCount", "1")
                  .putParameters("argument0", openOperationArgument)
                  .putParameters("argumentFormat0", "OPEN_TYPE_JSON")
                  .build());
      assertEquals(
          "SUCCEEDED",
          openOperationPreview.getStatus(),
          openOperationPreview.toString());
      assertEquals(
          "OPEN_TYPE_JSON",
          openOperationPreview.getValuesOrThrow("argument.00.format"));
      assertEquals(
          "{\"enabled\":false,\"labels\":[\"desktop\",\"safe\"],\"threshold\":42}",
          openOperationPreview.getValuesOrThrow("argument.00.value"));

      ActionResponse openOperation =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-open-operation-invoke"))
                  .setActionId("mbean.operation.invoke")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=OpenControl")
                  .putParameters("operation", "applySettings")
                  .putParameters(
                      "parameterTypes",
                      "javax.management.openmbean.CompositeData")
                  .putParameters("argumentCount", "1")
                  .putParameters("argument0", openOperationArgument)
                  .putParameters("argumentFormat0", "OPEN_TYPE_JSON")
                  .putParameters(
                      "expectedFingerprint",
                      openOperationPreview.getValuesOrThrow("fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", openOperation.getStatus(), openOperation.toString());
      assertEquals(
          "accepted:false:42:2",
          openOperation.getValuesOrThrow("returnValue"));

      ActionResponse mbeanAttributeWritePreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-attribute-write-preview"))
                  .setActionId("mbean.attribute.write.preview")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=Control")
                  .putParameters("attribute", "Mode")
                  .putParameters("proposedValue", "integration")
                  .build());
      assertEquals(
          "SUCCEEDED",
          mbeanAttributeWritePreview.getStatus(),
          mbeanAttributeWritePreview.toString());
      assertEquals(
          "before",
          mbeanAttributeWritePreview.getValuesOrThrow("oldValue"));

      ActionResponse mbeanAttributeWrite =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-attribute-write"))
                  .setActionId("mbean.attribute.write")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=Control")
                  .putParameters("attribute", "Mode")
                  .putParameters("proposedValue", "integration")
                  .putParameters(
                      "expectedFingerprint",
                      mbeanAttributeWritePreview.getValuesOrThrow(
                          "fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          mbeanAttributeWrite.getStatus(),
          mbeanAttributeWrite.toString());
      assertEquals(
          "integration",
          mbeanAttributeWrite.getValuesOrThrow("newValue"));

      ActionResponse mbeanAttributeRestorePreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-attribute-restore-preview"))
                  .setActionId("mbean.attribute.write.preview")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=Control")
                  .putParameters("attribute", "Mode")
                  .putParameters("proposedValue", "before")
                  .build());
      assertEquals(
          "integration",
          mbeanAttributeRestorePreview.getValuesOrThrow("oldValue"));
      ActionResponse mbeanAttributeRestore =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-attribute-restore"))
                  .setActionId("mbean.attribute.write")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=Control")
                  .putParameters("attribute", "Mode")
                  .putParameters("proposedValue", "before")
                  .putParameters(
                      "expectedFingerprint",
                      mbeanAttributeRestorePreview.getValuesOrThrow(
                          "fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          mbeanAttributeRestore.getStatus(),
          mbeanAttributeRestore.toString());
      assertEquals(
          "before", mbeanAttributeRestore.getValuesOrThrow("newValue"));

      String compositeSettings =
          "{\"enabled\":false,\"labels\":[\"integration\",\"safe\"],\"threshold\":42}";
      ActionResponse mbeanCompositeWritePreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-composite-write-preview"))
                  .setActionId("mbean.attribute.write.preview")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=Control")
                  .putParameters("attribute", "Settings")
                  .putParameters("valueFormat", "OPEN_TYPE_JSON")
                  .putParameters("proposedValue", compositeSettings)
                  .build());
      assertEquals(
          "SUCCEEDED",
          mbeanCompositeWritePreview.getStatus(),
          mbeanCompositeWritePreview.toString());
      assertEquals(
          "OPEN_TYPE_JSON",
          mbeanCompositeWritePreview.getValuesOrThrow("valueFormat"));
      assertEquals(
          "{\"enabled\":true,\"labels\":[\"baseline\"],\"threshold\":7}",
          mbeanCompositeWritePreview.getValuesOrThrow("oldValue"));

      ActionResponse mbeanCompositeWrite =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("mbean-composite-write"))
                  .setActionId("mbean.attribute.write")
                  .putParameters(
                      "objectName",
                      "dev.tanwei.integration:type=Control")
                  .putParameters("attribute", "Settings")
                  .putParameters("valueFormat", "OPEN_TYPE_JSON")
                  .putParameters("proposedValue", compositeSettings)
                  .putParameters(
                      "expectedFingerprint",
                      mbeanCompositeWritePreview.getValuesOrThrow(
                          "fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          mbeanCompositeWrite.getStatus(),
          mbeanCompositeWrite.toString());
      assertEquals(
          compositeSettings,
          mbeanCompositeWrite.getValuesOrThrow("newValue"));

      ActionResponse loggerList =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("logger-list"))
                  .setActionId("logger.list")
                  .putParameters("query", "dev.tanwei.integration")
                  .putParameters("framework", "JUL")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals("SUCCEEDED", loggerList.getStatus(), loggerList.toString());
      assertEquals(
          "dev.tanwei.integration",
          loggerList.getValuesOrThrow("logger.0000.name"));
      assertEquals("INFO", loggerList.getValuesOrThrow("logger.0000.level"));
      assertEquals(
          "AVAILABLE",
          loggerList.getValuesOrThrow("framework.jul.state"));

      ActionResponse loggerDescription =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("logger-describe"))
                  .setActionId("logger.describe")
                  .putParameters("framework", "JUL")
                  .putParameters(
                      "contextId",
                      loggerList.getValuesOrThrow("logger.0000.contextId"))
                  .putParameters(
                      "name",
                      loggerList.getValuesOrThrow("logger.0000.name"))
                  .build());
      assertEquals(
          "SUCCEEDED",
          loggerDescription.getStatus(),
          loggerDescription.toString());
      assertEquals(
          "INFO",
          loggerDescription.getValuesOrThrow("effectiveLevel"));

      ActionResponse properties =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("property-read"))
                  .setActionId("system.properties")
                  .build());
      assertEquals("before", properties.getValuesOrThrow("tanwei.integration.mutable"));
      ActionResponse visibleProperty =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("property-list-visible"))
                  .setActionId("system.property.list")
                  .putParameters("query", "tanwei.integration.visible")
                  .putParameters("category", "APPLICATION")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "SUCCEEDED", visibleProperty.getStatus(), visibleProperty.toString());
      assertEquals("1", visibleProperty.getValuesOrThrow("total"));
      assertEquals(
          "tanwei.integration.visible",
          visibleProperty.getValuesOrThrow("property.0000.key"));
      assertEquals(
          "desktop-property",
          visibleProperty.getValuesOrThrow("property.0000.value"));
      assertEquals("true", visibleProperty.getValuesOrThrow("property.0000.mutable"));
      ActionResponse maskedProperty =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("property-list-masked"))
                  .setActionId("system.property.list")
                  .putParameters("query", "tanwei.integration.password")
                  .putParameters("category", "APPLICATION")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals(
          "SUCCEEDED", maskedProperty.getStatus(), maskedProperty.toString());
      assertEquals(
          "<masked>", maskedProperty.getValuesOrThrow("property.0000.value"));
      assertEquals("false", maskedProperty.getValuesOrThrow("property.0000.mutable"));
      assertFalse(maskedProperty.toString().contains("never-return-property-secret"));
      ActionResponse propertyChange =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("property-set"))
                  .setActionId("system.property.set")
                  .putParameters("name", "tanwei.integration.mutable")
                  .putParameters("expectedOldValue", "before")
                  .putParameters("newValue", "after")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", propertyChange.getStatus(), propertyChange.toString());
      assertEquals("before", propertyChange.getValuesOrThrow("oldValue"));
      assertEquals("after", propertyChange.getValuesOrThrow("newValue"));
      ActionResponse stalePropertyChange =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("property-stale"))
                  .setActionId("system.property.set")
                  .putParameters("name", "tanwei.integration.mutable")
                  .putParameters("expectedOldValue", "before")
                  .putParameters("newValue", "unexpected")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("FAILED", stalePropertyChange.getStatus());
      assertEquals("STALE_OLD_VALUE", stalePropertyChange.getErrorCode());
      ActionResponse propertyRestore =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("property-restore"))
                  .setActionId("system.property.set")
                  .putParameters("name", "tanwei.integration.mutable")
                  .putParameters("expectedOldValue", "after")
                  .putParameters("newValue", "before")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", propertyRestore.getStatus());

      ActionResponse loggingBefore =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("logging-before"))
                  .setActionId("logging.summary")
                  .build());
      String rootLevel = loggingBefore.getValuesOrThrow("<root>");
      String changedRootLevel = "FINE".equals(rootLevel) ? "INFO" : "FINE";
      ActionResponse loggingChange =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("logging-set"))
                  .setActionId("logging.set")
                  .putParameters("name", "<root>")
                  .putParameters("expectedOldValue", rootLevel)
                  .putParameters("newValue", changedRootLevel)
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", loggingChange.getStatus(), loggingChange.toString());
      assertEquals(changedRootLevel, loggingChange.getValuesOrThrow("newValue"));
      ActionResponse loggingRestore =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("logging-restore"))
                  .setActionId("logging.set")
                  .putParameters("name", "<root>")
                  .putParameters("expectedOldValue", changedRootLevel)
                  .putParameters("newValue", rootLevel)
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("SUCCEEDED", loggingRestore.getStatus(), loggingRestore.toString());

      ActionResponse vmOptions =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("vm-options-before"))
                  .setActionId("vm.options")
                  .build());
      ActionResponse vmOptionIndex =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("vm-option-list"))
                  .setActionId("vm.option.list")
                  .putParameters("query", "HeapDumpOnOutOfMemoryError")
                  .putParameters("category", "MEMORY")
                  .putParameters("mutability", "WRITEABLE")
                  .putParameters("offset", "0")
                  .putParameters("limit", "10")
                  .build());
      assertEquals("SUCCEEDED", vmOptionIndex.getStatus(), vmOptionIndex.toString());
      assertEquals("1", vmOptionIndex.getValuesOrThrow("total"));
      assertEquals(
          "HeapDumpOnOutOfMemoryError",
          vmOptionIndex.getValuesOrThrow("option.0000.name"));
      assertEquals("true", vmOptionIndex.getValuesOrThrow("option.0000.writeable"));
      assertEquals("true", vmOptionIndex.getValuesOrThrow("option.0000.mutable"));
      assertFalse(vmOptionIndex.getValuesOrThrow("option.0000.origin").isEmpty());
      String heapDumpOption = vmOptions.getValuesMap().get("HeapDumpOnOutOfMemoryError");
      if (heapDumpOption != null && heapDumpOption.contains(" | writeable=true | ")) {
        String oldOptionValue = heapDumpOption.split(" \\| writeable=", 2)[0];
        String newOptionValue = Boolean.toString(!Boolean.parseBoolean(oldOptionValue));
        ActionResponse vmChange =
            authenticated.executeAction(
                ActionRequest.newBuilder()
                    .setContext(context("vm-option-set"))
                    .setActionId("vm.option.set")
                    .putParameters("name", "HeapDumpOnOutOfMemoryError")
                    .putParameters("expectedOldValue", oldOptionValue)
                    .putParameters("newValue", newOptionValue)
                    .putParameters("confirmed", "true")
                    .build());
        assertEquals("SUCCEEDED", vmChange.getStatus(), vmChange.toString());
        ActionResponse vmRestore =
            authenticated.executeAction(
                ActionRequest.newBuilder()
                    .setContext(context("vm-option-restore"))
                    .setActionId("vm.option.set")
                    .putParameters("name", "HeapDumpOnOutOfMemoryError")
                    .putParameters("expectedOldValue", newOptionValue)
                    .putParameters("newValue", oldOptionValue)
                    .putParameters("confirmed", "true")
                    .build());
        assertEquals("SUCCEEDED", vmRestore.getStatus(), vmRestore.toString());
      }

      ActionResponse unconfirmedGc =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("gc-unconfirmed"))
                  .setActionId("gc.run")
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals("FAILED", unconfirmedGc.getStatus());
      assertEquals("CONFIRMATION_REQUIRED", unconfirmedGc.getErrorCode());
      ActionResponse gc =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("gc"))
                  .setActionId("gc.run")
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals("SUCCEEDED", gc.getStatus(), gc.toString());

      ActionResponse managedProfileStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("managed-profile-start"))
                  .setActionId("profile.start")
                  .putParameters("event", "WALL")
                  .putParameters("intervalMillis", "20")
                  .putParameters("durationMillis", "60000")
                  .build());
      assertEquals(
          "SUCCEEDED",
          managedProfileStart.getStatus(),
          managedProfileStart.toString());
      String managedProfileTaskId =
          managedProfileStart.getValuesOrThrow("taskId");
      ActionResponse activeTasks =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("tasks-list"))
                  .setActionId("tasks.list")
                  .build());
      assertEquals("SUCCEEDED", activeTasks.getStatus(), activeTasks.toString());
      assertTrue(
          activeTasks.getValuesMap().containsValue(managedProfileTaskId),
          activeTasks.toString());
      assertTrue(
          activeTasks.getValuesMap().containsValue("PROFILE"),
          activeTasks.toString());

      ActionResponse unconfirmedTaskCancel =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("tasks-cancel-unconfirmed"))
                  .setActionId("tasks.cancel")
                  .putParameters("kind", "PROFILE")
                  .putParameters("taskId", managedProfileTaskId)
                  .build());
      assertEquals("FAILED", unconfirmedTaskCancel.getStatus());
      assertEquals(
          "CONFIRMATION_REQUIRED",
          unconfirmedTaskCancel.getErrorCode());

      ActionResponse managedProfileStop =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("tasks-cancel"))
                  .setActionId("tasks.cancel")
                  .putParameters("kind", "PROFILE")
                  .putParameters("taskId", managedProfileTaskId)
                  .putParameters("confirmed", "true")
                  .build());
      assertEquals(
          "SUCCEEDED",
          managedProfileStop.getStatus(),
          managedProfileStop.toString());
      assertEquals(
          "CANCELLED",
          managedProfileStop.getValuesOrThrow("state"));
      assertEquals(
          "PROFILE",
          managedProfileStop.getValuesOrThrow("type"));
      ByteArrayOutputStream managedProfile =
          downloadArtifact(
              authenticated,
              managedProfileStop.getValuesOrThrow("token"),
              "managed-profile-download");
      assertTrue(managedProfile.size() > 0);
      assertTrue(
          authenticated
              .deleteArtifact(
                  RemoteArtifactRequest.newBuilder()
                      .setContext(context("managed-profile-delete"))
                      .setToken(
                          managedProfileStop.getValuesOrThrow("token"))
                      .build())
              .getDeleted());

      ActionResponse resetProfileStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("session-reset-profile-start"))
                  .setActionId("profile.start")
                  .putParameters("event", "WALL")
                  .putParameters("intervalMillis", "20")
                  .putParameters("durationMillis", "60000")
                  .build());
      assertEquals(
          "SUCCEEDED",
          resetProfileStart.getStatus(),
          resetProfileStart.toString());
      ActionResponse taskResetPreview =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("session-reset-preview-task"))
                  .setActionId("session.reset.preview")
                  .build());
      assertEquals(
          "SUCCEEDED",
          taskResetPreview.getStatus(),
          taskResetPreview.toString());
      assertEquals(
          "1", taskResetPreview.getValuesOrThrow("task.total"));
      assertEquals(
          "1",
          taskResetPreview.getValuesOrThrow("artifactPotential.total"));
      ActionResponse taskReset =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("session-reset-task"))
                  .setActionId("session.reset")
                  .putParameters(
                      "expectedFingerprint",
                      taskResetPreview.getValuesOrThrow("fingerprint"))
                  .putParameters("confirmed", "true")
                  .putParameters("confirmedSecondary", "true")
                  .build());
      assertEquals(
          "SUCCEEDED", taskReset.getStatus(), taskReset.toString());
      assertEquals("RESET", taskReset.getValuesOrThrow("outcome"));
      assertEquals("1", taskReset.getValuesOrThrow("artifact.total"));
      assertEquals(
          "PROFILE",
          taskReset.getValuesOrThrow("artifact.0000.type"));
      ByteArrayOutputStream resetProfile =
          downloadArtifact(
              authenticated,
              taskReset.getValuesOrThrow("artifact.0000.token"),
              "session-reset-profile-download");
      assertTrue(resetProfile.size() > 0);
      assertTrue(
          authenticated
              .deleteArtifact(
                  RemoteArtifactRequest.newBuilder()
                      .setContext(
                          context("session-reset-profile-delete"))
                      .setToken(
                          taskReset.getValuesOrThrow(
                              "artifact.0000.token"))
                      .build())
              .getDeleted());

      ActionResponse profileStart =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("profile-start"))
                  .setActionId("profile.start")
                  .putParameters("event", "WALL")
                  .putParameters("intervalMillis", "20")
                  .putParameters("durationMillis", "1000")
                  .build());
      assertEquals("SUCCEEDED", profileStart.getStatus());
      Thread.sleep(1200L);
      ActionResponse profileStatus =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("profile-status"))
                  .setActionId("profile.status")
                  .putParameters(
                      "taskId", profileStart.getValuesOrThrow("taskId"))
                  .build());
      assertEquals("SUCCEEDED", profileStatus.getStatus());
      assertEquals("SUCCEEDED", profileStatus.getValuesOrThrow("state"));
      assertEquals("PROFILE", profileStatus.getValuesOrThrow("type"));
      assertFalse(profileStatus.getValuesOrThrow("engine").isEmpty());
      if (nativeProfilerPlatform()) {
        assertEquals(
            "ASYNC_PROFILER_4_5",
            profileStatus.getValuesOrThrow("engine"));
      }
      ByteArrayOutputStream profile =
          downloadArtifact(
              authenticated,
              profileStatus.getValuesOrThrow("token"),
              "profile-download");
      String profileHtml = profile.toString(StandardCharsets.UTF_8);
      assertTrue(
          profileHtml.toLowerCase(java.util.Locale.ROOT).contains("<html"),
          profileHtml.substring(0, Math.min(profileHtml.length(), 200)));
      assertTrue(
          authenticated
              .deleteArtifact(
                  RemoteArtifactRequest.newBuilder()
                      .setContext(context("profile-delete"))
                      .setToken(profileStatus.getValuesOrThrow("token"))
                      .build())
              .getDeleted());

      boolean jfrAvailable =
          capabilities.getCapabilitiesList().stream()
              .anyMatch(
                  capability ->
                      "jfr".equals(capability.getId())
                          && "AVAILABLE".equals(capability.getState()));
      if (jfrAvailable) {
        ActionResponse jfrStart =
            authenticated.executeAction(
                ActionRequest.newBuilder()
                    .setContext(context("jfr-start"))
                    .setActionId("jfr.start")
                    .build());
        assertEquals("SUCCEEDED", jfrStart.getStatus());
        Thread.sleep(100L);
        ActionResponse jfrStop =
            authenticated.executeAction(
                ActionRequest.newBuilder()
                    .setContext(context("jfr-stop"))
                    .setActionId("jfr.stop")
                    .build());
        assertEquals("SUCCEEDED", jfrStop.getStatus());
        assertEquals("JFR", jfrStop.getValuesOrThrow("type"));

        ByteArrayOutputStream downloaded =
            downloadArtifact(
                authenticated,
                jfrStop.getValuesOrThrow("token"),
                "jfr-download");
        assertEquals(
            Long.parseLong(jfrStop.getValuesOrThrow("size")),
            downloaded.size());
        assertTrue(downloaded.size() > 0);
        assertTrue(
            authenticated
                .deleteArtifact(
                    RemoteArtifactRequest.newBuilder()
                        .setContext(context("jfr-delete"))
                        .setToken(jfrStop.getValuesOrThrow("token"))
                        .build())
                .getDeleted());
      }

      ActionResponse unsupported =
          authenticated.executeAction(
              ActionRequest.newBuilder()
                  .setContext(context("unsupported"))
                  .setActionId("unknown.action")
                  .build());
      assertEquals("FAILED", unsupported.getStatus());
      assertEquals("UNSUPPORTED_ACTION", unsupported.getErrorCode());

      DiagnosticServiceGrpc.DiagnosticServiceBlockingStub unauthenticated =
          DiagnosticServiceGrpc.newBlockingStub(channel).withDeadlineAfter(5L, TimeUnit.SECONDS);
      try {
        unauthenticated.getSnapshot(
            SnapshotRequest.newBuilder().setContext(context("unauthenticated")).build());
        throw new AssertionError("request without secret should fail");
      } catch (StatusRuntimeException exception) {
        assertEquals(Status.Code.UNAUTHENTICATED, exception.getStatus().getCode());
      }

      authenticated.shutdown(
          ShutdownRequest.newBuilder().setContext(context("shutdown")).build());
    } finally {
      if (channel != null) {
        channel.shutdownNow();
        channel.awaitTermination(5L, TimeUnit.SECONDS);
      }
      target.process.destroy();
      if (!target.process.waitFor(5L, TimeUnit.SECONDS)) {
        target.process.destroyForcibly();
        target.process.waitFor(5L, TimeUnit.SECONDS);
      }
      Files.deleteIfExists(target.outputPath);
    }
  }

  private static int maximumMethodLine(
      byte[] bytecode, String methodName, String methodDescriptor) {
    int[] maximum = new int[] {Integer.MIN_VALUE};
    new ClassReader(bytecode)
        .accept(
            new ClassVisitor(Opcodes.ASM9) {
              @Override
              public MethodVisitor visitMethod(
                  int access,
                  String name,
                  String descriptor,
                  String signature,
                  String[] exceptions) {
                if (!methodName.equals(name)
                    || !methodDescriptor.equals(descriptor)) {
                  return null;
                }
                return new MethodVisitor(Opcodes.ASM9) {
                  @Override
                  public void visitLineNumber(
                      int line, org.objectweb.asm.Label start) {
                    maximum[0] = Math.max(maximum[0], line);
                  }
                };
              }
            },
            ClassReader.SKIP_FRAMES);
    if (maximum[0] == Integer.MIN_VALUE) {
      throw new IllegalArgumentException(
          "Method source line table is unavailable: " + methodName);
    }
    return maximum[0];
  }

  private static TargetProcess startTarget() throws IOException {
    String javaExecutable =
        Paths.get(
                System.getProperty("java.home"),
                "bin",
                isWindows() ? "java.exe" : "java")
            .toString();
    Path testClasses =
        Paths.get(System.getProperty("user.dir"), "target", "test-classes").normalize();
    assertTrue(
        Files.isRegularFile(
            testClasses.resolve(
                TestTargetMain.class.getName().replace('.', '/') + ".class")),
        "Test target class missing: " + testClasses);
    Path log4jRuntime =
        Paths.get(
                System.getProperty("user.dir"),
                "target",
                "e2e-libs",
                "log4j-1.2.17.jar")
            .normalize();
    assertTrue(
        Files.isRegularFile(log4jRuntime),
        "Log4j 1.x test runtime missing: " + log4jRuntime);
    String targetClasspath =
        testClasses
            + System.getProperty("path.separator")
            + log4jRuntime;
    Path outputPath = Files.createTempFile("tanwei-integration-target-", ".log");
    Process process =
        new ProcessBuilder(
                javaExecutable,
                "-cp",
                targetClasspath,
                TestTargetMain.class.getName())
            .redirectErrorStream(true)
            .redirectOutput(outputPath.toFile())
            .start();
    return new TargetProcess(process, outputPath);
  }

  private static boolean awaitReady(TargetProcess target)
      throws IOException, InterruptedException {
    return awaitOutput(target, "TANWEI_TEST_TARGET_READY");
  }

  private static boolean nativeProfilerPlatform() {
    String os =
        System.getProperty("os.name", "")
            .toLowerCase(java.util.Locale.ROOT);
    String architecture =
        System.getProperty("os.arch", "")
            .toLowerCase(java.util.Locale.ROOT);
    return (os.contains("linux") || os.contains("mac"))
        && ("amd64".equals(architecture)
            || "x86_64".equals(architecture)
            || "aarch64".equals(architecture)
            || "arm64".equals(architecture));
  }

  private static boolean awaitOutput(TargetProcess target, String expected)
      throws IOException, InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
    while (System.nanoTime() < deadline) {
      if (target.output().contains(expected)) {
        return true;
      }
      if (!target.process.isAlive()) {
        return false;
      }
      Thread.sleep(50L);
    }
    return false;
  }

  private static boolean awaitOutputAfter(
      TargetProcess target, String expected, int offset)
      throws IOException, InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
    while (System.nanoTime() < deadline) {
      String output = target.output();
      if (offset <= output.length() && output.substring(offset).contains(expected)) {
        return true;
      }
      if (!target.process.isAlive()) {
        return false;
      }
      Thread.sleep(50L);
    }
    return false;
  }

  private static byte[] replaceStringConstant(
      byte[] bytecode, String methodName, String before, String after) {
    ClassReader reader = new ClassReader(bytecode);
    ClassWriter writer = new ClassWriter(reader, 0);
    reader.accept(
        new ClassVisitor(Opcodes.ASM9, writer) {
          @Override
          public MethodVisitor visitMethod(
              int access,
              String name,
              String descriptor,
              String signature,
              String[] exceptions) {
            MethodVisitor delegate =
                super.visitMethod(
                    access, name, descriptor, signature, exceptions);
            if (!methodName.equals(name)) {
              return delegate;
            }
            return new MethodVisitor(Opcodes.ASM9, delegate) {
              @Override
              public void visitLdcInsn(Object value) {
                super.visitLdcInsn(before.equals(value) ? after : value);
              }
            };
          }
        },
        0);
    return writer.toByteArray();
  }

  private static ProcessResult attach(long pid, int port, String secret)
      throws IOException, InterruptedException {
    Path moduleDirectory = Paths.get(System.getProperty("user.dir"));
    Path helper =
        moduleDirectory
            .resolve(
                "../attach-helper/target/tanwei-attach-helper-"
                    + BuildMetadata.PRODUCT_VERSION
                    + ".jar")
            .normalize();
    Path bootstrap =
        moduleDirectory
            .resolve(
                "../bootstrap/target/tanwei-bootstrap-"
                    + BuildMetadata.PRODUCT_VERSION
                    + ".jar")
            .normalize();
    Path agent =
        moduleDirectory
            .resolve(
                "../agent/target/tanwei-agent-"
                    + BuildMetadata.PRODUCT_VERSION
                    + ".jar")
            .normalize();
    assertTrue(Files.isRegularFile(helper), "Attach Helper missing: " + helper);
    assertTrue(Files.isRegularFile(bootstrap), "Agent Bootstrap missing: " + bootstrap);
    assertTrue(Files.isRegularFile(agent), "Agent missing: " + agent);

    String javaExecutable =
        Paths.get(
                System.getProperty("java.home"),
                "bin",
                isWindows() ? "java.exe" : "java")
            .toString();
    Process process =
        new ProcessBuilder(
                javaExecutable,
                "-jar",
                helper.toString(),
                "attach",
                "--pid",
                Long.toString(pid),
                "--bootstrap",
                bootstrap.toString(),
                "--agent",
                agent.toString(),
                "--port",
                Integer.toString(port),
                "--secret",
                secret)
            .redirectErrorStream(true)
            .start();
    if (!process.waitFor(PROCESS_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
      process.destroyForcibly();
      throw new AssertionError("Attach Helper timed out");
    }
    String output =
        new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    return new ProcessResult(process.exitValue(), output);
  }

  private static void assertRelayProxy(int upstreamPort, String upstreamSecret)
      throws Exception {
    int relayPort = reservePort();
    String relaySecret = sessionSecret();
    Path descriptor = Files.createTempFile("tanwei-relay-", ".properties");
    Path output = Files.createTempFile("tanwei-relay-", ".log");
    Files.writeString(
        descriptor,
        "listen.port="
            + relayPort
            + "\nupstream.port="
            + upstreamPort
            + "\nsession.secret="
            + relaySecret
            + "\nupstream.secret="
            + upstreamSecret
            + "\n",
        StandardCharsets.ISO_8859_1);
    Path relayJar =
        Paths.get(System.getProperty("user.dir"))
            .resolve(
                "../relay/target/tanwei-relay-"
                    + BuildMetadata.PRODUCT_VERSION
                    + ".jar")
            .normalize();
    String javaExecutable =
        Paths.get(
                System.getProperty("java.home"),
                "bin",
                isWindows() ? "java.exe" : "java")
            .toString();
    Process relay =
        new ProcessBuilder(
                javaExecutable,
                "-jar",
                relayJar.toString(),
                "--descriptor",
                descriptor.toString())
            .redirectErrorStream(true)
            .redirectOutput(output.toFile())
            .start();
    ManagedChannel relayChannel = null;
    try {
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
      while (System.nanoTime() < deadline
          && !Files.readString(output).contains("TANWEI_RELAY_READY")) {
        if (!relay.isAlive()) {
          throw new AssertionError("Relay exited:\n" + Files.readString(output));
        }
        Thread.sleep(50L);
      }
      Metadata headers = new Metadata();
      headers.put(
          Metadata.Key.of(
              "x-tanwei-secret",
              Metadata.ASCII_STRING_MARSHALLER),
          relaySecret);
      relayChannel =
          NettyChannelBuilder.forAddress("127.0.0.1", relayPort)
              .usePlaintext()
              .build();
      RuntimeSnapshot snapshot =
          DiagnosticServiceGrpc.newBlockingStub(relayChannel)
              .withInterceptors(
                  MetadataUtils.newAttachHeadersInterceptor(headers))
              .withDeadlineAfter(5L, TimeUnit.SECONDS)
              .getSnapshot(
                  SnapshotRequest.newBuilder()
                      .setContext(context("relay-snapshot"))
                      .build());
      assertTrue(snapshot.getLiveThreads() > 0);
      assertFalse(Files.exists(descriptor));
    } finally {
      if (relayChannel != null) {
        relayChannel.shutdownNow();
        relayChannel.awaitTermination(5L, TimeUnit.SECONDS);
      }
      relay.destroy();
      if (!relay.waitFor(5L, TimeUnit.SECONDS)) {
        relay.destroyForcibly();
      }
      Files.deleteIfExists(descriptor);
      Files.deleteIfExists(output);
    }
  }

  private static void assertMutualTlsRelayProxy(
      int upstreamPort, String upstreamSecret) throws Exception {
    int relayPort = reservePort();
    String relaySecret = sessionSecret();
    Path descriptor = Files.createTempFile("tanwei-relay-mtls-", ".properties");
    Path output = Files.createTempFile("tanwei-relay-mtls-", ".log");
    SelfSignedCertificate serverCertificate =
        new SelfSignedCertificate("localhost");
    SelfSignedCertificate clientCertificate =
        new SelfSignedCertificate("tanwei-client");
    Files.writeString(
        descriptor,
        "listen.port="
            + relayPort
            + "\nlisten.address=127.0.0.1"
            + "\nupstream.port="
            + upstreamPort
            + "\nsession.secret="
            + relaySecret
            + "\nupstream.secret="
            + upstreamSecret
            + "\ntls.enabled=true"
            + "\ntls.certificate="
            + propertiesPath(serverCertificate.certificate().toPath())
            + "\ntls.privateKey="
            + propertiesPath(serverCertificate.privateKey().toPath())
            + "\ntls.clientCa="
            + propertiesPath(clientCertificate.certificate().toPath())
            + "\n",
        StandardCharsets.ISO_8859_1);
    Path relayJar =
        Paths.get(System.getProperty("user.dir"))
            .resolve(
                "../relay/target/tanwei-relay-"
                    + BuildMetadata.PRODUCT_VERSION
                    + ".jar")
            .normalize();
    String javaExecutable =
        Paths.get(
                System.getProperty("java.home"),
                "bin",
                isWindows() ? "java.exe" : "java")
            .toString();
    Process relay =
        new ProcessBuilder(
                javaExecutable,
                "-jar",
                relayJar.toString(),
                "--descriptor",
                descriptor.toString())
            .redirectErrorStream(true)
            .redirectOutput(output.toFile())
            .start();
    ManagedChannel relayChannel = null;
    try {
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
      while (System.nanoTime() < deadline
          && !Files.readString(output).contains("TANWEI_RELAY_READY")) {
        if (!relay.isAlive()) {
          throw new AssertionError(
              "mTLS Relay exited:\n" + Files.readString(output));
        }
        Thread.sleep(50L);
      }
      assertTrue(
          Files.readString(output).contains("tls=true"),
          Files.readString(output));
      Metadata headers = new Metadata();
      headers.put(
          Metadata.Key.of(
              "x-tanwei-secret",
              Metadata.ASCII_STRING_MARSHALLER),
          relaySecret);
      relayChannel =
          NettyChannelBuilder.forAddress("127.0.0.1", relayPort)
              .overrideAuthority("localhost")
              .sslContext(
                  GrpcSslContexts.forClient()
                      .trustManager(serverCertificate.certificate())
                      .keyManager(
                          clientCertificate.certificate(),
                          clientCertificate.privateKey())
                      .build())
              .build();
      RuntimeSnapshot snapshot =
          DiagnosticServiceGrpc.newBlockingStub(relayChannel)
              .withInterceptors(
                  MetadataUtils.newAttachHeadersInterceptor(headers))
              .withDeadlineAfter(5L, TimeUnit.SECONDS)
              .getSnapshot(
                  SnapshotRequest.newBuilder()
                      .setContext(context("relay-mtls-snapshot"))
                      .build());
      assertTrue(snapshot.getLiveThreads() > 0);
      assertFalse(Files.exists(descriptor));
    } finally {
      if (relayChannel != null) {
        relayChannel.shutdownNow();
        relayChannel.awaitTermination(5L, TimeUnit.SECONDS);
      }
      relay.destroy();
      if (!relay.waitFor(5L, TimeUnit.SECONDS)) {
        relay.destroyForcibly();
      }
      serverCertificate.delete();
      clientCertificate.delete();
      Files.deleteIfExists(descriptor);
      Files.deleteIfExists(output);
    }
  }

  private static String propertiesPath(Path path) {
    return path.toAbsolutePath().normalize().toString().replace("\\", "/");
  }

  private static String findPoolPrefixByMemberName(
      Map<String, String> values, String memberNamePrefix) {
    for (Map.Entry<String, String> entry : values.entrySet()) {
      int memberOffset = entry.getKey().indexOf("member.");
      if (memberOffset > 0
          && entry.getKey().endsWith(".name")
          && entry.getValue().startsWith(memberNamePrefix)) {
        return entry.getKey().substring(0, memberOffset);
      }
    }
    throw new AssertionError(
        "Thread-pool member was not found: "
            + memberNamePrefix
            + " in "
            + values);
  }

  private static void assertRunOnlyThreadPoolAttribution(
      DiagnosticServiceGrpc.DiagnosticServiceBlockingStub authenticated,
      String poolIdentity,
      String poolClassName,
      String expectedTaskType,
      String contextSuffix)
      throws Exception {
    ActionResponse start =
        authenticated.executeAction(
            ActionRequest.newBuilder()
                .setContext(
                    context("thread-pool-" + contextSuffix + "-start"))
                .setActionId("thread.pool.latency.start")
                .putParameters("poolIdentity", poolIdentity)
                .putParameters("poolClassName", poolClassName)
                .putParameters("durationMillis", "10000")
                .putParameters("maximumTrackedTasks", "128")
                .putParameters("confirmed", "true")
                .build());
    assertEquals("SUCCEEDED", start.getStatus(), start.toString());
    assertEquals(
        "RUN_ONLY", start.getValuesOrThrow("attributionMode"), start.toString());
    String taskId = start.getValuesOrThrow("taskId");
    Thread.sleep(1_200L);

    ActionResponse snapshot =
        authenticated.executeAction(
            ActionRequest.newBuilder()
                .setContext(
                    context("thread-pool-" + contextSuffix + "-snapshot"))
                .setActionId("thread.pool.latency.snapshot")
                .putParameters("taskId", taskId)
                .build());
    assertEquals("SUCCEEDED", snapshot.getStatus(), snapshot.toString());
    assertEquals(
        "RUN_ONLY",
        snapshot.getValuesOrThrow("attributionMode"),
        snapshot.toString());
    assertEquals("0", snapshot.getValuesOrThrow("submitted"));
    assertEquals("0", snapshot.getValuesOrThrow("waitObserved"));
    assertEquals("0", snapshot.getValuesOrThrow("waitDurationNanos"));
    assertEquals("0", snapshot.getValuesOrThrow("pendingTracked"));
    assertTrue(
        Long.parseLong(snapshot.getValuesOrThrow("started")) > 0L,
        snapshot.toString());
    assertTrue(
        Long.parseLong(snapshot.getValuesOrThrow("completed")) > 0L,
        snapshot.toString());
    assertTrue(
        Long.parseLong(snapshot.getValuesOrThrow("runDurationNanos")) > 0L,
        snapshot.toString());
    assertTrue(
        snapshot.getValuesMap().containsValue(expectedTaskType),
        snapshot.toString());

    ActionResponse stop =
        authenticated.executeAction(
            ActionRequest.newBuilder()
                .setContext(
                    context("thread-pool-" + contextSuffix + "-stop"))
                .setActionId("thread.pool.latency.stop")
                .putParameters("taskId", taskId)
                .putParameters("confirmed", "true")
                .build());
    assertEquals("SUCCEEDED", stop.getStatus(), stop.toString());
    assertEquals("CANCELLED", stop.getValuesOrThrow("state"));
  }

  private static void assertScheduledThreadPoolAttribution(
      DiagnosticServiceGrpc.DiagnosticServiceBlockingStub authenticated,
      String poolIdentity,
      String expectedTaskType)
      throws Exception {
    ActionResponse start =
        authenticated.executeAction(
            ActionRequest.newBuilder()
                .setContext(context("thread-pool-scheduled-start"))
                .setActionId("thread.pool.latency.start")
                .putParameters("poolIdentity", poolIdentity)
                .putParameters(
                    "poolClassName",
                    "java.util.concurrent.ScheduledThreadPoolExecutor")
                .putParameters("durationMillis", "10000")
                .putParameters("maximumTrackedTasks", "128")
                .putParameters("confirmed", "true")
                .build());
    assertEquals("SUCCEEDED", start.getStatus(), start.toString());
    assertEquals(
        "SCHEDULE_AND_RUN",
        start.getValuesOrThrow("attributionMode"),
        start.toString());
    String taskId = start.getValuesOrThrow("taskId");
    Thread.sleep(1_200L);

    ActionResponse snapshot =
        authenticated.executeAction(
            ActionRequest.newBuilder()
                .setContext(context("thread-pool-scheduled-snapshot"))
                .setActionId("thread.pool.latency.snapshot")
                .putParameters("taskId", taskId)
                .build());
    assertEquals("SUCCEEDED", snapshot.getStatus(), snapshot.toString());
    assertEquals(
        "SCHEDULE_AND_RUN",
        snapshot.getValuesOrThrow("attributionMode"),
        snapshot.toString());
    assertEquals("0", snapshot.getValuesOrThrow("waitObserved"));
    assertEquals("0", snapshot.getValuesOrThrow("waitDurationNanos"));
    assertTrue(
        Long.parseLong(snapshot.getValuesOrThrow("submitted")) > 0L,
        snapshot.toString());
    assertTrue(
        Long.parseLong(snapshot.getValuesOrThrow("scheduleDelayObserved"))
            > 0L,
        snapshot.toString());
    assertTrue(
        Long.parseLong(
                snapshot.getValuesOrThrow("scheduleDelayDurationNanos"))
            > 0L,
        snapshot.toString());
    assertTrue(
        Long.parseLong(snapshot.getValuesOrThrow("startLatenessObserved"))
            > 0L,
        snapshot.toString());
    assertTrue(
        Long.parseLong(snapshot.getValuesOrThrow("runDurationNanos")) > 0L,
        snapshot.toString());
    assertTrue(
        snapshot.getValuesMap().containsValue(expectedTaskType),
        snapshot.toString());

    ActionResponse stop =
        authenticated.executeAction(
            ActionRequest.newBuilder()
                .setContext(context("thread-pool-scheduled-stop"))
                .setActionId("thread.pool.latency.stop")
                .putParameters("taskId", taskId)
                .putParameters("confirmed", "true")
                .build());
    assertEquals("SUCCEEDED", stop.getStatus(), stop.toString());
    assertEquals("CANCELLED", stop.getValuesOrThrow("state"));
  }

  private static boolean containsValueWithKeySuffix(
      Map<String, String> values,
      String prefix,
      String suffix,
      String valuePrefix) {
    for (Map.Entry<String, String> entry : values.entrySet()) {
      if (entry.getKey().startsWith(prefix + "member.")
          && entry.getKey().endsWith(suffix)
          && entry.getValue().startsWith(valuePrefix)) {
        return true;
      }
    }
    return false;
  }

  private static boolean containsNonEmptyValueWithKeySuffix(
      Map<String, String> values, String prefix, String suffix) {
    for (Map.Entry<String, String> entry : values.entrySet()) {
      if (entry.getKey().startsWith(prefix + "member.")
          && entry.getKey().endsWith(suffix)
          && !entry.getValue().isEmpty()) {
        return true;
      }
    }
    return false;
  }

  private static String invocationNodeValue(
      ActionResponse response, String path, String field) {
    int count =
        Integer.parseInt(response.getValuesOrThrow("invocationValue.count"));
    for (int index = 0; index < count; index++) {
      String prefix =
          "invocationValue." + String.format("%03d.", index);
      if (path.equals(response.getValuesMap().get(prefix + "path"))) {
        String value = response.getValuesMap().get(prefix + field);
        if (value == null) {
          throw new AssertionError(
              "Missing invocation node field " + field + " for " + path);
        }
        return value;
      }
    }
    throw new AssertionError("Missing invocation value node " + path);
  }

  private static RequestContext context(String taskId) {
    return RequestContext.newBuilder()
        .setRequestId(java.util.UUID.randomUUID().toString())
        .setTaskId(taskId)
        .setTimestampEpochMillis(System.currentTimeMillis())
        .build();
  }

  private static ByteArrayOutputStream downloadArtifact(
      DiagnosticServiceGrpc.DiagnosticServiceBlockingStub authenticated,
      String token,
      String taskId)
      throws IOException {
    Iterator<ArtifactChunk> chunks =
        authenticated.downloadArtifact(
            ArtifactDownloadRequest.newBuilder()
                .setContext(context(taskId))
                .setToken(token)
                .build());
    ByteArrayOutputStream downloaded = new ByteArrayOutputStream();
    long expectedSequence = 0L;
    while (chunks.hasNext()) {
      ArtifactChunk chunk = chunks.next();
      assertEquals(expectedSequence++, chunk.getSequence());
      chunk.getData().writeTo(downloaded);
    }
    return downloaded;
  }

  private static int reservePort() throws IOException {
    try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
      return socket.getLocalPort();
    }
  }

  private static String sessionSecret() {
    byte[] bytes = new byte[32];
    SECURE_RANDOM.nextBytes(bytes);
    StringBuilder builder = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) {
      builder.append(String.format("%02x", value & 0xff));
    }
    return builder.toString();
  }

  private static boolean isWindows() {
    return System.getProperty("os.name", "").toLowerCase().contains("win");
  }

  private static final class ProcessResult {
    private final int exitCode;
    private final String output;

    private ProcessResult(int exitCode, String output) {
      this.exitCode = exitCode;
      this.output = output;
    }
  }

  private static final class TargetProcess {
    private final Process process;
    private final Path outputPath;

    private TargetProcess(Process process, Path outputPath) {
      this.process = process;
      this.outputPath = outputPath;
    }

    private String output() throws IOException {
      return Files.readString(outputPath, StandardCharsets.UTF_8);
    }
  }
}
