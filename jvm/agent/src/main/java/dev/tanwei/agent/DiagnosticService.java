package dev.tanwei.agent;

import dev.tanwei.protocol.v1.ActionRequest;
import dev.tanwei.protocol.v1.ActionResponse;
import dev.tanwei.protocol.v1.ArtifactChunk;
import dev.tanwei.protocol.v1.ArtifactDownloadRequest;
import dev.tanwei.protocol.v1.CapabilitiesRequest;
import dev.tanwei.protocol.v1.CapabilitiesResponse;
import dev.tanwei.protocol.v1.ClassDetailsRequest;
import dev.tanwei.protocol.v1.ClassDetailsResponse;
import dev.tanwei.protocol.v1.ClassListRequest;
import dev.tanwei.protocol.v1.ClassListResponse;
import dev.tanwei.protocol.v1.DiagnosticServiceGrpc;
import dev.tanwei.protocol.v1.MetricStreamRequest;
import dev.tanwei.protocol.v1.ObservationEventsRequest;
import dev.tanwei.protocol.v1.ObservationEventsResponse;
import dev.tanwei.protocol.v1.ObservationTaskRequest;
import dev.tanwei.protocol.v1.ObservationTaskResponse;
import dev.tanwei.protocol.v1.RemoteArtifactRequest;
import dev.tanwei.protocol.v1.RemoteArtifactResponse;
import dev.tanwei.protocol.v1.RuntimeSnapshot;
import dev.tanwei.protocol.v1.ShutdownRequest;
import dev.tanwei.protocol.v1.ShutdownResponse;
import dev.tanwei.protocol.v1.SnapshotRequest;
import dev.tanwei.protocol.v1.ThreadListRequest;
import dev.tanwei.protocol.v1.ThreadListResponse;
import io.grpc.stub.StreamObserver;
import java.lang.instrument.Instrumentation;
import java.util.Objects;
import java.util.concurrent.ScheduledExecutorService;

/**
 * Thin gRPC Adapter and composition root for the Agent diagnostic application.
 * Transport callbacks stay here; domain orchestration belongs to the delegated
 * implementation and its controllers.
 */
final class DiagnosticService extends DiagnosticServiceGrpc.DiagnosticServiceImplBase
    implements AutoCloseable {
  private final DiagnosticApplicationService application;

  DiagnosticService(
      Instrumentation instrumentation,
      ScheduledExecutorService scheduler,
      Runnable shutdownCallback)
      throws Exception {
    this.application =
        new DiagnosticApplicationService(
            Objects.requireNonNull(instrumentation, "instrumentation"),
            Objects.requireNonNull(scheduler, "scheduler"),
            Objects.requireNonNull(shutdownCallback, "shutdownCallback"));
  }

  @Override
  public void getCapabilities(
      CapabilitiesRequest request,
      StreamObserver<CapabilitiesResponse> responseObserver) {
    application.getCapabilities(request, responseObserver);
  }

  @Override
  public void getSnapshot(
      SnapshotRequest request, StreamObserver<RuntimeSnapshot> responseObserver) {
    application.getSnapshot(request, responseObserver);
  }

  @Override
  public void streamMetrics(
      MetricStreamRequest request,
      StreamObserver<RuntimeSnapshot> responseObserver) {
    application.streamMetrics(request, responseObserver);
  }

  @Override
  public void listThreads(
      ThreadListRequest request,
      StreamObserver<ThreadListResponse> responseObserver) {
    application.listThreads(request, responseObserver);
  }

  @Override
  public void listClasses(
      ClassListRequest request,
      StreamObserver<ClassListResponse> responseObserver) {
    application.listClasses(request, responseObserver);
  }

  @Override
  public void getClassDetails(
      ClassDetailsRequest request,
      StreamObserver<ClassDetailsResponse> responseObserver) {
    application.getClassDetails(request, responseObserver);
  }

  @Override
  public void executeAction(
      ActionRequest request, StreamObserver<ActionResponse> responseObserver) {
    application.executeAction(request, responseObserver);
  }

  @Override
  public void downloadArtifact(
      ArtifactDownloadRequest request,
      StreamObserver<ArtifactChunk> responseObserver) {
    application.downloadArtifact(request, responseObserver);
  }

  @Override
  public void deleteArtifact(
      RemoteArtifactRequest request,
      StreamObserver<RemoteArtifactResponse> responseObserver) {
    application.deleteArtifact(request, responseObserver);
  }

  @Override
  public void getObservationEvents(
      ObservationEventsRequest request,
      StreamObserver<ObservationEventsResponse> responseObserver) {
    application.getObservationEvents(request, responseObserver);
  }

  @Override
  public void cancelObservation(
      ObservationTaskRequest request,
      StreamObserver<ObservationTaskResponse> responseObserver) {
    application.cancelObservation(request, responseObserver);
  }

  @Override
  public void shutdown(
      ShutdownRequest request, StreamObserver<ShutdownResponse> responseObserver) {
    application.shutdown(request, responseObserver);
  }

  @Override
  public void close() {
    application.close();
  }
}
