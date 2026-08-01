package dev.tanwei.relay;

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

final class RelayProxyService
    extends DiagnosticServiceGrpc.DiagnosticServiceImplBase {
  private final DiagnosticServiceGrpc.DiagnosticServiceStub upstream;

  RelayProxyService(
      DiagnosticServiceGrpc.DiagnosticServiceStub upstream) {
    this.upstream = upstream;
  }

  @Override
  public void getCapabilities(
      CapabilitiesRequest request,
      StreamObserver<CapabilitiesResponse> observer) {
    upstream.getCapabilities(request, observer);
  }

  @Override
  public void getSnapshot(
      SnapshotRequest request,
      StreamObserver<RuntimeSnapshot> observer) {
    upstream.getSnapshot(request, observer);
  }

  @Override
  public void streamMetrics(
      MetricStreamRequest request,
      StreamObserver<RuntimeSnapshot> observer) {
    upstream.streamMetrics(request, observer);
  }

  @Override
  public void listThreads(
      ThreadListRequest request,
      StreamObserver<ThreadListResponse> observer) {
    upstream.listThreads(request, observer);
  }

  @Override
  public void listClasses(
      ClassListRequest request,
      StreamObserver<ClassListResponse> observer) {
    upstream.listClasses(request, observer);
  }

  @Override
  public void getClassDetails(
      ClassDetailsRequest request,
      StreamObserver<ClassDetailsResponse> observer) {
    upstream.getClassDetails(request, observer);
  }

  @Override
  public void executeAction(
      ActionRequest request,
      StreamObserver<ActionResponse> observer) {
    upstream.executeAction(request, observer);
  }

  @Override
  public void downloadArtifact(
      ArtifactDownloadRequest request,
      StreamObserver<ArtifactChunk> observer) {
    upstream.downloadArtifact(request, observer);
  }

  @Override
  public void deleteArtifact(
      RemoteArtifactRequest request,
      StreamObserver<RemoteArtifactResponse> observer) {
    upstream.deleteArtifact(request, observer);
  }

  @Override
  public void getObservationEvents(
      ObservationEventsRequest request,
      StreamObserver<ObservationEventsResponse> observer) {
    upstream.getObservationEvents(request, observer);
  }

  @Override
  public void cancelObservation(
      ObservationTaskRequest request,
      StreamObserver<ObservationTaskResponse> observer) {
    upstream.cancelObservation(request, observer);
  }

  @Override
  public void shutdown(
      ShutdownRequest request,
      StreamObserver<ShutdownResponse> observer) {
    upstream.shutdown(request, observer);
  }
}
