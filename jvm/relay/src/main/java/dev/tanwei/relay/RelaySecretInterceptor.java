package dev.tanwei.relay;

import io.grpc.Context;
import io.grpc.Contexts;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class RelaySecretInterceptor implements ServerInterceptor {
  private static final Metadata.Key<String> SECRET_HEADER =
      Metadata.Key.of(
          "x-tanwei-secret",
          Metadata.ASCII_STRING_MARSHALLER);
  private final byte[] expected;

  RelaySecretInterceptor(String expected) {
    this.expected = expected.getBytes(StandardCharsets.US_ASCII);
  }

  @Override
  public <RequestT, ResponseT> ServerCall.Listener<RequestT> interceptCall(
      ServerCall<RequestT, ResponseT> call,
      Metadata headers,
      ServerCallHandler<RequestT, ResponseT> next) {
    String supplied = headers.get(SECRET_HEADER);
    byte[] suppliedBytes =
        supplied == null
            ? new byte[0]
            : supplied.getBytes(StandardCharsets.US_ASCII);
    if (!MessageDigest.isEqual(expected, suppliedBytes)) {
      call.close(
          Status.UNAUTHENTICATED.withDescription(
              "Relay session secret is missing or invalid"),
          new Metadata());
      return new ServerCall.Listener<RequestT>() {};
    }
    return Contexts.interceptCall(Context.current(), call, headers, next);
  }
}
