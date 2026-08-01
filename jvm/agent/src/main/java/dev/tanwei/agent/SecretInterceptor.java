package dev.tanwei.agent;

import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class SecretInterceptor implements ServerInterceptor {
  private static final Metadata.Key<String> SECRET_HEADER =
      Metadata.Key.of("x-tanwei-secret", Metadata.ASCII_STRING_MARSHALLER);

  private final byte[] expectedSecret;
  private final Runnable authenticatedActivity;

  SecretInterceptor(String expectedSecret, Runnable authenticatedActivity) {
    this.expectedSecret = expectedSecret.getBytes(StandardCharsets.UTF_8);
    this.authenticatedActivity = authenticatedActivity;
  }

  @Override
  public <RequestT, ResponseT> ServerCall.Listener<RequestT> interceptCall(
      ServerCall<RequestT, ResponseT> call,
      Metadata headers,
      ServerCallHandler<RequestT, ResponseT> next) {
    String providedSecret = headers.get(SECRET_HEADER);
    if (providedSecret == null
        || !MessageDigest.isEqual(
            expectedSecret, providedSecret.getBytes(StandardCharsets.UTF_8))) {
      call.close(Status.UNAUTHENTICATED.withDescription("invalid session secret"), new Metadata());
      return new ServerCall.Listener<RequestT>() {};
    }
    authenticatedActivity.run();
    return Contexts.interceptCall(Context.current(), call, headers, next);
  }
}
