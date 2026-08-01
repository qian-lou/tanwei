package dev.tanwei.agent;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Owns persistent class retransformation leases for diagnostic probes.
 *
 * <p>All mutation and rollback operations are serialized. A class remains claimed when rollback
 * fails, preventing another probe or class replacement from building on bytecode whose lifecycle is
 * uncertain. Activating and rolling back a lease are O(C), where C is the bounded number of classes
 * owned by that diagnostic task.
 */
final class RetransformLifecycle implements AutoCloseable {
  private final Instrumentation instrumentation;
  private final Object lock = new Object();
  private final IdentityHashMap<Class<?>, Lease> owners = new IdentityHashMap<Class<?>, Lease>();
  private final Map<String, Lease> leases = new LinkedHashMap<String, Lease>();
  private final AtomicBoolean closed = new AtomicBoolean();

  RetransformLifecycle(Instrumentation instrumentation) {
    if (instrumentation == null) {
      throw new IllegalArgumentException("Instrumentation is required");
    }
    this.instrumentation = instrumentation;
  }

  Lease activate(
      String ownerId,
      String kind,
      ClassFileTransformer transformer,
      Class<?>... requestedClasses)
      throws Exception {
    if (closed.get()) {
      throw new IllegalStateException("Retransformation lifecycle is closed");
    }
    if (ownerId == null || ownerId.isEmpty() || kind == null || kind.isEmpty()) {
      throw new IllegalArgumentException("Retransformation owner identity and kind are required");
    }
    if (transformer == null) {
      throw new IllegalArgumentException("Retransformation transformer is required");
    }
    Class<?>[] classes = normalizeClasses(requestedClasses);
    synchronized (lock) {
      if (closed.get()) {
        throw new IllegalStateException("Retransformation lifecycle is closed");
      }
      if (leases.containsKey(ownerId)) {
        throw new IllegalStateException("Retransformation owner identity is already active");
      }
      for (Class<?> target : classes) {
        if (!instrumentation.isModifiableClass(target)) {
          throw new IllegalStateException("Class is not modifiable: " + target.getName());
        }
        Lease current = owners.get(target);
        if (current != null) {
          throw new IllegalStateException(
              "Class is owned by active " + current.kind + " task " + current.ownerId + ": "
                  + target.getName());
        }
      }

      Lease lease = new Lease(ownerId, kind, transformer, classes);
      leases.put(ownerId, lease);
      for (Class<?> target : classes) {
        owners.put(target, lease);
      }
      boolean transformerAdded = false;
      try {
        instrumentation.addTransformer(transformer, true);
        transformerAdded = true;
        instrumentation.retransformClasses(classes);
        lease.state = "ACTIVE";
        return lease;
      } catch (Exception activationFailure) {
        lease.state = "ACTIVATION_FAILED";
        lease.error = failureMessage(activationFailure);
        if (transformerAdded) {
          if (!instrumentation.removeTransformer(transformer)) {
            lease.state = "ROLLBACK_FAILED";
            lease.error = "Transformer removal could not be verified after activation failure";
            activationFailure.addSuppressed(new IllegalStateException(lease.error));
            throw activationFailure;
          }
          lease.transformerRemoved = true;
          try {
            instrumentation.retransformClasses(classes);
            release(lease, "ROLLED_BACK");
          } catch (Exception rollbackFailure) {
            lease.state = "ROLLBACK_FAILED";
            lease.error = failureMessage(rollbackFailure);
            activationFailure.addSuppressed(rollbackFailure);
          }
        } else {
          release(lease, "ROLLED_BACK");
        }
        throw activationFailure;
      }
    }
  }

  boolean hasClaim(Class<?> target) {
    if (target == null) {
      return false;
    }
    synchronized (lock) {
      return owners.containsKey(target);
    }
  }

  List<Snapshot> snapshots() {
    synchronized (lock) {
      List<Snapshot> result = new ArrayList<Snapshot>(leases.size());
      for (Lease lease : leases.values()) {
        result.add(lease.snapshot());
      }
      return Collections.unmodifiableList(result);
    }
  }

  List<Snapshot> failedRollbacks() {
    synchronized (lock) {
      List<Snapshot> result = new ArrayList<Snapshot>();
      for (Lease lease : leases.values()) {
        if ("ROLLBACK_FAILED".equals(lease.state)) {
          result.add(lease.snapshot());
        }
      }
      return Collections.unmodifiableList(result);
    }
  }

  boolean retry(String ownerId) throws Exception {
    synchronized (lock) {
      Lease lease = leases.get(ownerId);
      if (lease == null) {
        return false;
      }
      if (!"ROLLBACK_FAILED".equals(lease.state)) {
        throw new IllegalStateException("Only a failed rollback can be retried");
      }
      rollbackLocked(lease);
      return true;
    }
  }

  private void rollback(Lease lease) throws Exception {
    synchronized (lock) {
      if (leases.get(lease.ownerId) != lease) {
        return;
      }
      rollbackLocked(lease);
    }
  }

  private void rollbackLocked(Lease lease) throws Exception {
    if (!lease.transformerRemoved) {
      if (!instrumentation.removeTransformer(lease.transformer)) {
        lease.state = "ROLLBACK_FAILED";
        lease.error = "Transformer was not registered";
        throw new IllegalStateException(lease.error);
      }
      lease.transformerRemoved = true;
    }
    try {
      instrumentation.retransformClasses(lease.classes);
      release(lease, "ROLLED_BACK");
    } catch (Exception failure) {
      lease.state = "ROLLBACK_FAILED";
      lease.error = failureMessage(failure);
      throw failure;
    }
  }

  private void release(Lease lease, String terminalState) {
    lease.state = terminalState;
    lease.error = "";
    leases.remove(lease.ownerId, lease);
    for (Class<?> target : lease.classes) {
      owners.remove(target, lease);
    }
  }

  private static Class<?>[] normalizeClasses(Class<?>[] requestedClasses) {
    if (requestedClasses == null || requestedClasses.length == 0) {
      throw new IllegalArgumentException("At least one retransformation class is required");
    }
    IdentityHashMap<Class<?>, Boolean> unique = new IdentityHashMap<Class<?>, Boolean>();
    List<Class<?>> normalized = new ArrayList<Class<?>>(requestedClasses.length);
    for (Class<?> target : requestedClasses) {
      if (target == null) {
        throw new IllegalArgumentException("Retransformation class cannot be null");
      }
      if (unique.put(target, Boolean.TRUE) == null) {
        normalized.add(target);
      }
    }
    return normalized.toArray(new Class<?>[normalized.size()]);
  }

  private static String failureMessage(Throwable failure) {
    String message = failure.getMessage();
    return message == null || message.isEmpty() ? failure.getClass().getSimpleName() : message;
  }

  @Override
  public void close() {
    if (!closed.compareAndSet(false, true)) {
      return;
    }
    List<Lease> current;
    synchronized (lock) {
      current = new ArrayList<Lease>(leases.values());
    }
    for (Lease lease : current) {
      try {
        lease.rollback();
      } catch (Exception ignored) {
        // A failed rollback remains claimed and visible until process exit.
      }
    }
  }

  final class Lease {
    private final String ownerId;
    private final String kind;
    private final ClassFileTransformer transformer;
    private final Class<?>[] classes;
    private volatile String state = "ACTIVATING";
    private volatile String error = "";
    private boolean transformerRemoved;

    private Lease(
        String ownerId,
        String kind,
        ClassFileTransformer transformer,
        Class<?>[] classes) {
      this.ownerId = ownerId;
      this.kind = kind;
      this.transformer = transformer;
      this.classes = classes.clone();
    }

    void rollback() throws Exception {
      RetransformLifecycle.this.rollback(this);
    }

    Snapshot snapshot() {
      List<String> classNames = new ArrayList<String>(classes.length);
      for (Class<?> target : classes) {
        classNames.add(target.getName());
      }
      return new Snapshot(ownerId, kind, state, error, classNames);
    }
  }

  static final class Snapshot {
    private final String ownerId;
    private final String kind;
    private final String state;
    private final String error;
    private final List<String> classNames;

    private Snapshot(
        String ownerId,
        String kind,
        String state,
        String error,
        List<String> classNames) {
      this.ownerId = ownerId;
      this.kind = kind;
      this.state = state;
      this.error = error;
      this.classNames = Collections.unmodifiableList(classNames);
    }

    String getOwnerId() {
      return ownerId;
    }

    String getKind() {
      return kind;
    }

    String getState() {
      return state;
    }

    String getError() {
      return error;
    }

    List<String> getClassNames() {
      return classNames;
    }
  }
}
