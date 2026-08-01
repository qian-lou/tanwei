package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.tanwei.protocol.v1.ObservationEvent;
import java.lang.ref.WeakReference;
import java.util.Arrays;
import java.util.Collections;
import org.junit.jupiter.api.Test;

final class SnapshotArchiveTest {
  @Test
  void evictsOldestSnapshotsWithinCountBound() {
    SnapshotArchive archive = new SnapshotArchive(2, 1_000_000L);
    SnapshotArchive.Snapshot first = record(archive, 1L, "", "one");
    record(archive, 2L, "", "two");
    SnapshotArchive.Snapshot newest = record(archive, 3L, "", "three");

    assertEquals(2, archive.size());
    assertNull(archive.find(first.getId()));
    assertEquals("three", archive.find(newest.getId()).getReturnValue());
    assertEquals(1L, archive.list("", "ALL", "ALL", 0, 10).getEvicted());
  }

  @Test
  void filtersNewestFirstByQueryOutcomeAndScope() {
    SnapshotArchive archive = new SnapshotArchive();
    record(archive, 1L, "", "older");
    record(archive, 2L, "java.lang.IllegalStateException", "");
    record(archive, 3L, "", "newer");

    SnapshotArchive.Page returned =
        archive.list("probe", "RETURNED", "ROOT", 0, 10);

    assertEquals(2, returned.getTotal());
    assertEquals("newer", returned.getItems().get(0).getReturnValue());
    assertEquals(2, returned.getReturned());
    assertEquals(1, returned.getThrew());
  }

  @Test
  void retainsBoundedDetailsAndMarksSafeStaticReplay() {
    SnapshotArchive archive = new SnapshotArchive();
    ObservationEvent event =
        ObservationEvent.newBuilder()
            .setSequence(7L)
            .setParentSequence(-1L)
            .setDepth(0)
            .setMethod("ping(Ljava/lang/String;)Ljava/lang/String;")
            .setCapturedAtEpochMillis(10L)
            .setDurationNanos(20L)
            .setThreadName("worker")
            .addArguments("desktop")
            .addCallStack("example.Probe.main(Probe.java:1)")
            .setReturnValue("pong")
            .build();

    SnapshotArchive.Snapshot snapshot =
        archive.record(
            "task",
            "example.Probe",
            "loader",
            "ping",
            "java.lang.String",
            "public static",
            event);

    assertTrue(snapshot.isReplayEligible());
    assertEquals(Collections.singletonList("desktop"), snapshot.getArguments());
    assertEquals(1, snapshot.getCallStack().size());
  }

  @Test
  void rejectsReplayForExceptionsAndObjectPlaceholders() {
    assertFalse(
        SnapshotArchive.replayEligible(
            0,
            "public static",
            "java.lang.Object",
            Collections.singletonList("<example.Payload>")));
    assertFalse(
        SnapshotArchive.replayEligible(
            1,
            "public static",
            "",
            Collections.<String>emptyList()));
  }

  @Test
  void instanceReplayExpiresWithoutRetainingReceiver() {
    SnapshotArchive archive = new SnapshotArchive();
    Object receiver = new Object();
    WeakReference<Object> receiverReference =
        new WeakReference<Object>(receiver);
    ObservationEvent event =
        ObservationEvent.newBuilder()
            .setSequence(8L)
            .setParentSequence(-1L)
            .setDepth(0)
            .setMethod("echo(Ljava/lang/String;)Ljava/lang/String;")
            .addArguments("desktop")
            .build();

    SnapshotArchive.Snapshot snapshot =
        archive.record(
            "task",
            "example.Probe",
            "loader",
            "echo",
            "java.lang.String",
            "public",
            event,
            receiverReference,
            receiver.getClass().getName());

    assertEquals("INSTANCE", snapshot.getReplayMode());
    assertTrue(snapshot.isReceiverAvailable());
    assertTrue(snapshot.isReplayEligible());
    receiverReference.clear();
    assertFalse(snapshot.isReceiverAvailable());
    assertFalse(snapshot.isReplayEligible());
    assertEquals("RECEIVER_EXPIRED", snapshot.getReplayDeniedReason());
  }

  @Test
  void deletesOnlyTheExactSnapshot() {
    SnapshotArchive archive = new SnapshotArchive();
    SnapshotArchive.Snapshot snapshot = record(archive, 1L, "", "value");

    assertTrue(archive.delete(snapshot.getId()));
    assertFalse(archive.delete(snapshot.getId()));
    assertEquals(0, archive.size());
  }

  @Test
  void filtersByTaskThreadDurationAndReplayModeInOneBoundedScan() {
    SnapshotArchive archive = new SnapshotArchive();
    recordWithFilterValues(
        archive,
        "task-static",
        "worker-fast",
        2_000_000L,
        "public static",
        null);
    Object receiver = new Object();
    recordWithFilterValues(
        archive,
        "task-instance",
        "worker-orders-7",
        25_000_000L,
        "public",
        new WeakReference<Object>(receiver));

    SnapshotArchive.Page page =
        archive.list(
            new SnapshotArchive.Filter(
                "probe",
                "RETURNED",
                "ROOT",
                "task-instance",
                "orders",
                "INSTANCE",
                20L,
                30L,
                0,
                10));

    assertEquals(1, page.getTotal());
    assertEquals("task-instance", page.getItems().get(0).getTaskId());
    assertEquals("INSTANCE", page.getItems().get(0).getReplayMode());
    assertEquals(Object.class, receiver.getClass());
  }

  @Test
  void rejectsInvertedDurationRange() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            new SnapshotArchive.Filter(
                "", "ALL", "ROOT", "", "", "ALL", 30L, 20L, 0, 10));
  }

  @Test
  void retainsAndSearchesCapturedReceiverScalarState() {
    SnapshotArchive archive = new SnapshotArchive();
    Object receiver = new Object();
    ObservationEvent event =
        ObservationEvent.newBuilder()
            .setSequence(9L)
            .setParentSequence(-1L)
            .setDepth(0)
            .setMethod("increment(I)I")
            .setReturnValue("5")
            .build();
    ReceiverStateSnapshot state =
        ReceiverStateSnapshot.of(
            true,
            2,
            0,
            false,
            Collections.singletonList("example.Probe#sequence"),
            Collections.singletonList("5"));

    SnapshotArchive.Snapshot snapshot =
        archive.record(
            "task-state",
            "example.Probe",
            "loader",
            "increment",
            "int",
            "public",
            event,
            new WeakReference<Object>(receiver),
            receiver.getClass().getName(),
            state);

    assertEquals("5", snapshot.getReceiverState().getFields().get(0).getValue());
    assertEquals(1, archive.list("sequence", "ALL", "ROOT", 0, 10).getTotal());
    assertEquals(Object.class, receiver.getClass());
  }

  @Test
  void retainsAndSearchesStructuredInvocationValues() {
    SnapshotArchive archive = new SnapshotArchive();
    ObservationEvent event =
        ObservationEvent.newBuilder()
            .setSequence(10L)
            .setParentSequence(-1L)
            .setDepth(0)
            .setMethod("inspect(Lexample/Payload;)Ljava/lang/String;")
            .addArguments("<example.Payload>")
            .setReturnValue("accepted")
            .build();
    InvocationValueSnapshot values =
        InvocationValueSnapshot.of(
            true,
            2,
            false,
            Arrays.asList("arg[0]", "arg[0].region"),
            Arrays.asList(-1, 0),
            Arrays.asList(0, 1),
            Arrays.asList("OBJECT", "SCALAR"),
            Arrays.asList("example.Payload", "java.lang.String"),
            Arrays.asList("", "eu-west"),
            Arrays.asList(1, 0),
            Arrays.asList(false, false));

    SnapshotArchive.Snapshot snapshot =
        archive.record(
            "task-values",
            "example.Probe",
            "loader",
            "inspect",
            "example.Payload",
            "public static",
            event,
            null,
            "",
            ReceiverStateSnapshot.empty(),
            values);

    assertEquals(2, snapshot.getInvocationValues().getNodes().size());
    assertEquals(1, archive.list("eu-west", "ALL", "ROOT", 0, 10).getTotal());
  }

  private static SnapshotArchive.Snapshot record(
      SnapshotArchive archive, long sequence, String exceptionType, String returnValue) {
    ObservationEvent event =
        ObservationEvent.newBuilder()
            .setSequence(sequence)
            .setParentSequence(-1L)
            .setDepth(0)
            .setMethod("probe()Ljava/lang/String;")
            .setCapturedAtEpochMillis(sequence)
            .setDurationNanos(sequence)
            .setThreadName("probe-worker")
            .setReturnValue(returnValue)
            .setExceptionType(exceptionType)
            .build();
    return archive.record(
        "task-" + sequence,
        "example.Probe",
        "loader",
        "probe",
        "",
        "public static",
        event);
  }

  private static SnapshotArchive.Snapshot recordWithFilterValues(
      SnapshotArchive archive,
      String taskId,
      String threadName,
      long durationNanos,
      String modifiers,
      WeakReference<Object> receiverReference) {
    ObservationEvent event =
        ObservationEvent.newBuilder()
            .setSequence(durationNanos)
            .setParentSequence(-1L)
            .setDepth(0)
            .setMethod("probe()Ljava/lang/String;")
            .setDurationNanos(durationNanos)
            .setThreadName(threadName)
            .setReturnValue("probe-result")
            .build();
    return archive.record(
        taskId,
        "example.Probe",
        "loader",
        "probe",
        "",
        modifiers,
        event,
        receiverReference,
        receiverReference == null ? "" : Object.class.getName());
  }
}
