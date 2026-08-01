package dev.tanwei.agent;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

final class AgentArtifactRegistry implements AutoCloseable {
  private final Path root;
  private final Map<String, Path> artifacts = new ConcurrentHashMap<String, Path>();

  AgentArtifactRegistry() throws IOException {
    root = Files.createTempDirectory("tanwei-agent-");
  }

  Path allocatePath(String suffix) {
    if (suffix == null || !suffix.matches("\\.[a-zA-Z0-9]{1,16}")) {
      throw new IllegalArgumentException("artifact suffix is invalid");
    }
    return root.resolve(UUID.randomUUID().toString() + suffix);
  }

  String register(Path artifactPath) throws IOException {
    Path normalized = artifactPath.toAbsolutePath().normalize();
    if (!normalized.startsWith(root.toAbsolutePath().normalize())
        || !Files.isRegularFile(normalized)) {
      throw new IOException("artifact is outside the Agent registry");
    }
    String token = UUID.randomUUID().toString();
    artifacts.put(token, normalized);
    return token;
  }

  Path resolve(String token) {
    return artifacts.get(token);
  }

  boolean delete(String token) throws IOException {
    Path artifactPath = artifacts.remove(token);
    return artifactPath != null && Files.deleteIfExists(artifactPath);
  }

  @Override
  public void close() {
    artifacts.clear();
    if (!Files.exists(root)) {
      return;
    }
    try (Stream<Path> paths = Files.walk(root)) {
      paths.sorted(Comparator.reverseOrder())
          .forEach(
              path -> {
                try {
                  Files.deleteIfExists(path);
                } catch (IOException ignored) {
                  // Target shutdown proceeds even when the OS retains a temporary file.
                }
              });
    } catch (IOException ignored) {
      // The registry is best-effort cleanup during target shutdown.
    }
  }
}
