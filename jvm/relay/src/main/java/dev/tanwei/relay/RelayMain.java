package dev.tanwei.relay;

import dev.tanwei.protocol.BuildMetadata;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.netty.shaded.io.netty.handler.ssl.ClientAuth;
import io.grpc.stub.MetadataUtils;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

public final class RelayMain {
  private RelayMain() {}

  public static void main(String[] args) throws Exception {
    if (args != null && args.length == 1 && "--version".equals(args[0])) {
      System.out.println(
          "tanwei-relay "
              + BuildMetadata.PRODUCT_VERSION
              + " protocol "
              + BuildMetadata.PROTOCOL_VERSION);
      return;
    }
    if (args == null
        || args.length != 2
        || !"--descriptor".equals(args[0])) {
      System.err.println(
          "Usage: tanwei-relay --descriptor <0600-properties-file>");
      System.exit(2);
      return;
    }

    RelayConfiguration configuration =
        RelayConfiguration.readAndDelete(Paths.get(args[1]));
    ManagedChannel upstream =
        NettyChannelBuilder.forAddress(
                InetAddress.getLoopbackAddress().getHostAddress(),
                configuration.upstreamPort)
            .usePlaintext()
            .build();
    Metadata upstreamMetadata = new Metadata();
    upstreamMetadata.put(
        Metadata.Key.of(
            "x-tanwei-secret",
            Metadata.ASCII_STRING_MARSHALLER),
        configuration.upstreamSecret);
    dev.tanwei.protocol.v1.DiagnosticServiceGrpc.DiagnosticServiceStub stub =
        dev.tanwei.protocol.v1.DiagnosticServiceGrpc.newStub(upstream)
            .withInterceptors(
                MetadataUtils.newAttachHeadersInterceptor(upstreamMetadata));

    NettyServerBuilder serverBuilder =
        NettyServerBuilder.forAddress(
                new InetSocketAddress(
                    configuration.listenAddress,
                    configuration.listenPort))
            .addService(
                io.grpc.ServerInterceptors.intercept(
                    new RelayProxyService(stub),
                    new RelaySecretInterceptor(configuration.sessionSecret)));
    if (configuration.tlsEnabled) {
      serverBuilder.sslContext(
          GrpcSslContexts.forServer(
                  configuration.tlsCertificate.toFile(),
                  configuration.tlsPrivateKey.toFile())
              .trustManager(configuration.tlsClientCa.toFile())
              .clientAuth(ClientAuth.REQUIRE)
              .build());
    }
    Server server = serverBuilder.build().start();
    Runtime.getRuntime()
        .addShutdownHook(
            new Thread(
                () -> {
                  server.shutdownNow();
                  upstream.shutdownNow();
                },
                "tanwei-relay-shutdown"));
    System.out.println(
        "TANWEI_RELAY_READY port="
            + server.getPort()
            + " tls="
            + configuration.tlsEnabled
            + " protocol="
            + BuildMetadata.PROTOCOL_VERSION);
    try {
      server.awaitTermination();
    } finally {
      server.shutdownNow();
      upstream.shutdownNow();
      upstream.awaitTermination(5L, TimeUnit.SECONDS);
    }
  }

  static final class RelayConfiguration {
    private final int listenPort;
    private final InetAddress listenAddress;
    private final int upstreamPort;
    private final String sessionSecret;
    private final String upstreamSecret;
    private final boolean tlsEnabled;
    private final Path tlsCertificate;
    private final Path tlsPrivateKey;
    private final Path tlsClientCa;

    private RelayConfiguration(
        int listenPort,
        InetAddress listenAddress,
        int upstreamPort,
        String sessionSecret,
        String upstreamSecret,
        boolean tlsEnabled,
        Path tlsCertificate,
        Path tlsPrivateKey,
        Path tlsClientCa) {
      this.listenPort = listenPort;
      this.listenAddress = listenAddress;
      this.upstreamPort = upstreamPort;
      this.sessionSecret = sessionSecret;
      this.upstreamSecret = upstreamSecret;
      this.tlsEnabled = tlsEnabled;
      this.tlsCertificate = tlsCertificate;
      this.tlsPrivateKey = tlsPrivateKey;
      this.tlsClientCa = tlsClientCa;
    }

    private static RelayConfiguration readAndDelete(Path descriptor)
        throws Exception {
      if (!Files.isRegularFile(descriptor)) {
        throw new IllegalArgumentException("Relay descriptor is not a file");
      }
      Properties properties = new Properties();
      try (InputStream input = Files.newInputStream(descriptor)) {
        properties.load(input);
      } finally {
        Files.deleteIfExists(descriptor);
      }
      int listenPort = port(properties.getProperty("listen.port"));
      boolean tlsEnabled =
          booleanValue(properties.getProperty("tls.enabled", "false"));
      InetAddress listenAddress =
          InetAddress.getByName(
              properties.getProperty(
                  "listen.address",
                  InetAddress.getLoopbackAddress().getHostAddress()));
      if (!tlsEnabled && !listenAddress.isLoopbackAddress()) {
        throw new IllegalArgumentException(
            "Plaintext Relay must bind to a loopback address");
      }
      int upstreamPort = port(properties.getProperty("upstream.port"));
      String sessionSecret =
          secret(properties.getProperty("session.secret"), "session.secret");
      String upstreamSecret =
          secret(
              properties.getProperty("upstream.secret"),
              "upstream.secret");
      Path tlsCertificate =
          tlsEnabled
              ? regularFile(
                  properties.getProperty("tls.certificate"),
                  "tls.certificate")
              : null;
      Path tlsPrivateKey =
          tlsEnabled
              ? regularFile(
                  properties.getProperty("tls.privateKey"),
                  "tls.privateKey")
              : null;
      Path tlsClientCa =
          tlsEnabled
              ? regularFile(
                  properties.getProperty("tls.clientCa"),
                  "tls.clientCa")
              : null;
      return new RelayConfiguration(
          listenPort,
          listenAddress,
          upstreamPort,
          sessionSecret,
          upstreamSecret,
          tlsEnabled,
          tlsCertificate,
          tlsPrivateKey,
          tlsClientCa);
    }

    private static int port(String value) {
      try {
        int port = Integer.parseInt(value);
        if (port < 1 || port > 65_535) {
          throw new IllegalArgumentException("Relay port is outside range");
        }
        return port;
      } catch (NumberFormatException exception) {
        throw new IllegalArgumentException("Relay port must be an integer");
      }
    }

    private static String secret(String value, String name) {
      if (value == null || !value.matches("[a-f0-9]{64}")) {
        throw new IllegalArgumentException(name + " must be 256-bit hex");
      }
      return value;
    }

    private static boolean booleanValue(String value) {
      if ("true".equals(value)) {
        return true;
      }
      if ("false".equals(value)) {
        return false;
      }
      throw new IllegalArgumentException(
          "tls.enabled must be true or false");
    }

    private static Path regularFile(String value, String name) {
      if (value == null || value.trim().isEmpty()) {
        throw new IllegalArgumentException(name + " is required");
      }
      Path path = Paths.get(value).toAbsolutePath().normalize();
      if (!Files.isRegularFile(path)) {
        throw new IllegalArgumentException(name + " is not a regular file");
      }
      return path;
    }
  }
}
