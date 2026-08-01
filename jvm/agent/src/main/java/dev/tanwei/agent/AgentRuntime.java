package dev.tanwei.agent;

import io.grpc.Server;
import io.grpc.ServerInterceptors;
import io.grpc.netty.shaded.io.grpc.netty.NettyServerBuilder;
import io.grpc.netty.shaded.io.netty.channel.EventLoopGroup;
import io.grpc.netty.shaded.io.netty.channel.nio.NioEventLoopGroup;
import io.grpc.netty.shaded.io.netty.channel.socket.nio.NioServerSocketChannel;
import io.grpc.netty.shaded.io.netty.util.concurrent.DefaultThreadFactory;
import java.lang.instrument.Instrumentation;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

final class AgentRuntime implements AutoCloseable {
  private static final int RPC_CORE_THREADS = 2;
  private static final int RPC_MAX_THREADS = 8;
  private static final int RPC_QUEUE_CAPACITY = 1_024;
  private static final long HOST_ACTIVITY_TIMEOUT_MILLIS = 30_000L;

  private final AtomicBoolean closed = new AtomicBoolean();
  private final AtomicLong lastAuthenticatedActivity =
      new AtomicLong(System.currentTimeMillis());
  private final ThreadPoolExecutor rpcExecutor;
  private final ScheduledThreadPoolExecutor scheduler;
  private final EventLoopGroup bossGroup;
  private final EventLoopGroup workerGroup;
  private final DiagnosticService service;
  private final Server server;

  AgentRuntime(
      Instrumentation instrumentation,
      AgentConfiguration configuration,
      Runnable shutdownCallback)
      throws Exception {
    rpcExecutor =
        new ThreadPoolExecutor(
            RPC_CORE_THREADS,
            RPC_MAX_THREADS,
            60L,
            TimeUnit.SECONDS,
            new LinkedBlockingQueue<Runnable>(RPC_QUEUE_CAPACITY),
            new AgentThreadFactory("tanwei-agent-rpc"),
            new ThreadPoolExecutor.AbortPolicy());
    rpcExecutor.allowCoreThreadTimeOut(true);
    scheduler =
        new ScheduledThreadPoolExecutor(2, new AgentThreadFactory("tanwei-agent-scheduler"));
    scheduler.setRemoveOnCancelPolicy(true);
    bossGroup =
        new NioEventLoopGroup(
            1, new DefaultThreadFactory("tanwei-agent-netty-boss", true));
    workerGroup =
        new NioEventLoopGroup(
            2, new DefaultThreadFactory("tanwei-agent-netty-worker", true));

    service = new DiagnosticService(instrumentation, scheduler, shutdownCallback);
    server =
        NettyServerBuilder.forAddress(
                new InetSocketAddress(
                    InetAddress.getLoopbackAddress(), configuration.getPort()))
            .bossEventLoopGroup(bossGroup)
            .workerEventLoopGroup(workerGroup)
            .channelType(NioServerSocketChannel.class)
            .executor(rpcExecutor)
            .addService(
                ServerInterceptors.intercept(
                    service,
                    new SecretInterceptor(
                        configuration.getSecret(),
                        () ->
                            lastAuthenticatedActivity.set(
                                System.currentTimeMillis()))))
            .build()
            .start();
    scheduler.scheduleWithFixedDelay(
        () -> {
          if (System.currentTimeMillis() - lastAuthenticatedActivity.get()
              > HOST_ACTIVITY_TIMEOUT_MILLIS) {
            shutdownCallback.run();
          }
        },
        HOST_ACTIVITY_TIMEOUT_MILLIS,
        5_000L,
        TimeUnit.MILLISECONDS);
  }

  int getPort() {
    return server.getPort();
  }

  @Override
  public void close() {
    if (!closed.compareAndSet(false, true)) {
      return;
    }
    server.shutdown();
    try {
      if (!server.awaitTermination(2L, TimeUnit.SECONDS)) {
        server.shutdownNow();
      }
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
      server.shutdownNow();
    } finally {
      service.close();
      scheduler.shutdownNow();
      rpcExecutor.shutdownNow();
      bossGroup.shutdownGracefully(0L, 1L, TimeUnit.SECONDS);
      workerGroup.shutdownGracefully(0L, 1L, TimeUnit.SECONDS);
    }
  }
}
