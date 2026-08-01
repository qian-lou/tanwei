package dev.tanwei.agent;

import java.lang.instrument.ClassDefinition;
import java.lang.instrument.Instrumentation;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.FieldVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

final class ClassRedefinitionController implements AutoCloseable {
  private static final int MAXIMUM_CLASS_BYTES = 2 * 1024 * 1024;
  private static final int MAXIMUM_CHANGE_SET_BYTES = 2 * 1024 * 1024;
  private static final int MAXIMUM_CHANGE_SET_CLASSES = 8;
  private static final int MAXIMUM_ROLLBACKS = 8;
  private static final int CLASS_ACCESS_MASK =
      Opcodes.ACC_PUBLIC
          | Opcodes.ACC_FINAL
          | Opcodes.ACC_INTERFACE
          | Opcodes.ACC_ABSTRACT
          | Opcodes.ACC_ANNOTATION
          | Opcodes.ACC_ENUM
          | Opcodes.ACC_RECORD;
  private static final int MEMBER_ACCESS_MASK =
      Opcodes.ACC_PUBLIC
          | Opcodes.ACC_PRIVATE
          | Opcodes.ACC_PROTECTED
          | Opcodes.ACC_STATIC
          | Opcodes.ACC_FINAL
          | Opcodes.ACC_SYNCHRONIZED
          | Opcodes.ACC_VOLATILE
          | Opcodes.ACC_TRANSIENT
          | Opcodes.ACC_NATIVE
          | Opcodes.ACC_ABSTRACT
          | Opcodes.ACC_STRICT
          | Opcodes.ACC_SYNTHETIC;

  private final Instrumentation instrumentation;
  private final ClassDumpController classDump;
  private final LinkedHashMap<String, RollbackSet> rollbacks =
      new LinkedHashMap<String, RollbackSet>();

  ClassRedefinitionController(
      Instrumentation instrumentation, ClassDumpController classDump) {
    this.instrumentation = instrumentation;
    this.classDump = classDump;
  }

  boolean isAvailable() {
    return instrumentation.isRedefineClassesSupported()
        && classDump.isAvailable();
  }

  synchronized Preview preview(Class<?> target, String encodedBytecode)
      throws Exception {
    requireTarget(target);
    byte[] current = currentDefinition(target);
    byte[] proposed = decode(encodedBytecode);
    validateShape(target, current, proposed);
    return new Preview(
        sha256(current),
        sha256(proposed),
        current.length,
        proposed.length);
  }

  synchronized Result redefine(
      Class<?> target,
      String encodedBytecode,
      String expectedCurrentSha256)
      throws Exception {
    requireTarget(target);
    byte[] current = currentDefinition(target);
    String currentHash = sha256(current);
    if (!currentHash.equals(expectedCurrentSha256)) {
      throw new StaleDefinitionException(currentHash);
    }
    byte[] proposed = decode(encodedBytecode);
    validateShape(target, current, proposed);
    instrumentation.redefineClasses(new ClassDefinition(target, proposed));
    byte[] applied = currentDefinition(target);
    String appliedHash = sha256(applied);
    String rollbackToken = UUID.randomUUID().toString();
    while (rollbacks.size() >= MAXIMUM_ROLLBACKS) {
      String oldest = rollbacks.keySet().iterator().next();
      rollbacks.remove(oldest);
    }
    rollbacks.put(
        rollbackToken,
        new RollbackSet(
            Collections.singletonList(
                new Rollback(target, current, appliedHash))));
    return new Result(
        currentHash,
        appliedHash,
        rollbackToken,
        current.length,
        applied.length);
  }

  synchronized Result restore(
      String rollbackToken, String expectedCurrentSha256) throws Exception {
    RollbackSet rollbackSet = rollbacks.get(rollbackToken);
    if (rollbackSet == null || rollbackSet.items.size() != 1) {
      throw new IllegalArgumentException(
          "The class rollback token is missing, expired, or already used");
    }
    Rollback rollback = rollbackSet.items.get(0);
    byte[] current = currentDefinition(rollback.target);
    String currentHash = sha256(current);
    if (!rollback.expectedCurrentSha256.equals(expectedCurrentSha256)
        || !currentHash.equals(expectedCurrentSha256)) {
      throw new StaleDefinitionException(currentHash);
    }
    validateShape(rollback.target, current, rollback.bytecode);
    instrumentation.redefineClasses(
        new ClassDefinition(rollback.target, rollback.bytecode));
    byte[] restored = currentDefinition(rollback.target);
    String restoredHash = sha256(restored);
    rollbacks.remove(rollbackToken);
    return new Result(
        currentHash,
        restoredHash,
        "",
        current.length,
        restored.length);
  }

  synchronized BatchPreview previewBatch(
      List<Class<?>> targets, List<String> encodedBytecodes)
      throws Exception {
    List<Candidate> candidates =
        prepareCandidates(targets, encodedBytecodes);
    List<BatchPreviewItem> items =
        new ArrayList<BatchPreviewItem>(candidates.size());
    for (Candidate candidate : candidates) {
      items.add(
          new BatchPreviewItem(
              candidate.target,
              candidate.currentSha256,
              candidate.proposedSha256,
              candidate.current.length,
              candidate.proposed.length));
    }
    return new BatchPreview(changeSetFingerprint(candidates), items);
  }

  synchronized BatchResult redefineBatch(
      List<Class<?>> targets,
      List<String> encodedBytecodes,
      String expectedPreviewFingerprint)
      throws Exception {
    List<Candidate> candidates =
        prepareCandidates(targets, encodedBytecodes);
    String actualPreviewFingerprint =
        changeSetFingerprint(candidates);
    if (!actualPreviewFingerprint.equals(expectedPreviewFingerprint)) {
      throw new StaleChangeSetException(actualPreviewFingerprint);
    }

    ClassDefinition[] definitions =
        new ClassDefinition[candidates.size()];
    for (int index = 0; index < candidates.size(); index++) {
      Candidate candidate = candidates.get(index);
      definitions[index] =
          new ClassDefinition(candidate.target, candidate.proposed);
    }
    instrumentation.redefineClasses(definitions);

    List<BatchResultItem> results =
        new ArrayList<BatchResultItem>(candidates.size());
    List<Rollback> rollbackItems =
        new ArrayList<Rollback>(candidates.size());
    try {
      for (Candidate candidate : candidates) {
        byte[] applied = currentDefinition(candidate.target);
        String appliedSha256 = sha256(applied);
        results.add(
            new BatchResultItem(
                candidate.target,
                candidate.currentSha256,
                appliedSha256,
                candidate.current.length,
                applied.length));
        rollbackItems.add(
            new Rollback(
                candidate.target,
                candidate.current,
                appliedSha256));
      }
    } catch (Exception verificationFailure) {
      restoreCandidatesAfterVerificationFailure(
          candidates, verificationFailure);
      throw verificationFailure;
    }

    String rollbackToken = UUID.randomUUID().toString();
    while (rollbacks.size() >= MAXIMUM_ROLLBACKS) {
      String oldest = rollbacks.keySet().iterator().next();
      rollbacks.remove(oldest);
    }
    RollbackSet rollbackSet = new RollbackSet(rollbackItems);
    rollbacks.put(rollbackToken, rollbackSet);
    return new BatchResult(
        rollbackToken,
        rollbackSet.expectedCurrentFingerprint,
        results);
  }

  synchronized BatchResult restoreBatch(
      String rollbackToken,
      String expectedCurrentFingerprint)
      throws Exception {
    RollbackSet rollbackSet = rollbacks.get(rollbackToken);
    if (rollbackSet == null || rollbackSet.items.size() < 2) {
      throw new IllegalArgumentException(
          "The change-set rollback token is missing, expired, or already used");
    }
    List<BatchResultItem> results =
        new ArrayList<BatchResultItem>(rollbackSet.items.size());
    List<byte[]> currentDefinitions =
        new ArrayList<byte[]>(rollbackSet.items.size());
    List<String> currentHashes =
        new ArrayList<String>(rollbackSet.items.size());
    for (Rollback rollback : rollbackSet.items) {
      byte[] current = currentDefinition(rollback.target);
      String currentHash = sha256(current);
      currentDefinitions.add(current);
      currentHashes.add(currentHash);
    }
    String actualFingerprint =
        currentDefinitionFingerprint(
            rollbackSet.items, currentHashes);
    if (!rollbackSet.expectedCurrentFingerprint.equals(
            expectedCurrentFingerprint)
        || !actualFingerprint.equals(expectedCurrentFingerprint)) {
      throw new StaleChangeSetException(actualFingerprint);
    }

    ClassDefinition[] definitions =
        new ClassDefinition[rollbackSet.items.size()];
    for (int index = 0; index < rollbackSet.items.size(); index++) {
      Rollback rollback = rollbackSet.items.get(index);
      validateShape(
          rollback.target,
          currentDefinitions.get(index),
          rollback.bytecode);
      definitions[index] =
          new ClassDefinition(rollback.target, rollback.bytecode);
    }
    instrumentation.redefineClasses(definitions);
    for (int index = 0; index < rollbackSet.items.size(); index++) {
      Rollback rollback = rollbackSet.items.get(index);
      byte[] restored = currentDefinition(rollback.target);
      results.add(
          new BatchResultItem(
              rollback.target,
              currentHashes.get(index),
              sha256(restored),
              currentDefinitions.get(index).length,
              restored.length));
    }
    rollbacks.remove(rollbackToken);
    return new BatchResult("", "", results);
  }

  synchronized List<ResetSnapshot> resetSnapshots() throws Exception {
    Map<Class<?>, ResetSnapshot> snapshots =
        new IdentityHashMap<Class<?>, ResetSnapshot>();
    List<Class<?>> order = new ArrayList<Class<?>>();
    for (RollbackSet rollbackSet : rollbacks.values()) {
      for (Rollback rollback : rollbackSet.items) {
        ResetSnapshot snapshot = snapshots.get(rollback.target);
        if (snapshot == null) {
          snapshot =
              new ResetSnapshot(
                  rollback.target,
                  rollback.bytecode,
                  rollback.expectedCurrentSha256,
                  1);
          snapshots.put(rollback.target, snapshot);
          order.add(rollback.target);
        } else {
          snapshot =
              new ResetSnapshot(
                  rollback.target,
                  snapshot.baselineBytecode,
                  rollback.expectedCurrentSha256,
                  snapshot.rollbackCount + 1);
          snapshots.put(rollback.target, snapshot);
        }
      }
    }
    List<ResetSnapshot> result =
        new ArrayList<ResetSnapshot>(order.size());
    for (Class<?> target : order) {
      result.add(snapshots.get(target));
    }
    return result;
  }

  synchronized ResetResult restoreAll() {
    List<ResetItem> items = new ArrayList<ResetItem>();
    try {
      for (ResetSnapshot snapshot : resetSnapshots()) {
        try {
          byte[] current = currentDefinition(snapshot.target);
          String currentHash = sha256(current);
          if (!currentHash.equals(snapshot.expectedCurrentSha256)) {
            throw new StaleDefinitionException(currentHash);
          }
          validateShape(snapshot.target, current, snapshot.baselineBytecode);
          instrumentation.redefineClasses(
              new ClassDefinition(
                  snapshot.target, snapshot.baselineBytecode));
          byte[] restored = currentDefinition(snapshot.target);
          String restoredHash = sha256(restored);
          removeRollbacks(snapshot.target);
          items.add(
              ResetItem.succeeded(
                  snapshot, currentHash, restoredHash));
        } catch (Exception exception) {
          String actualSha256 =
              exception instanceof StaleDefinitionException
                  ? ((StaleDefinitionException) exception).getActualSha256()
                  : "";
          items.add(
              ResetItem.failed(
                  snapshot,
                  actualSha256,
                  exception.getMessage() == null
                      ? exception.getClass().getSimpleName()
                      : exception.getMessage()));
        }
      }
    } catch (Exception exception) {
      items.add(
          ResetItem.failed(
              null,
              "",
              exception.getMessage() == null
                  ? exception.getClass().getSimpleName()
                  : exception.getMessage()));
    }
    return new ResetResult(items);
  }

  @Override
  public synchronized void close() {
    restoreAll();
    rollbacks.clear();
  }

  private byte[] currentDefinition(Class<?> target) throws Exception {
    return classDump.capture(target);
  }

  private void removeRollbacks(Class<?> target) {
    List<String> emptyTokens = new ArrayList<String>();
    for (Map.Entry<String, RollbackSet> entry : rollbacks.entrySet()) {
      List<Rollback> retained =
          new ArrayList<Rollback>(entry.getValue().items.size());
      for (Rollback rollback : entry.getValue().items) {
        if (rollback.target != target) {
          retained.add(rollback);
        }
      }
      if (retained.isEmpty()) {
        emptyTokens.add(entry.getKey());
      } else if (retained.size() != entry.getValue().items.size()) {
        entry.setValue(new RollbackSet(retained));
      }
    }
    for (String token : emptyTokens) {
      rollbacks.remove(token);
    }
  }

  private List<Candidate> prepareCandidates(
      List<Class<?>> targets, List<String> encodedBytecodes)
      throws Exception {
    if (targets == null
        || encodedBytecodes == null
        || targets.size() < 2
        || targets.size() > MAXIMUM_CHANGE_SET_CLASSES
        || targets.size() != encodedBytecodes.size()) {
      throw new IllegalArgumentException(
          "A class change set requires 2 to 8 exact classes");
    }
    IdentityHashMap<Class<?>, Boolean> uniqueTargets =
        new IdentityHashMap<Class<?>, Boolean>();
    List<Candidate> candidates =
        new ArrayList<Candidate>(targets.size());
    ClassLoader expectedClassLoader = null;
    boolean firstTarget = true;
    long totalBytes = 0L;
    for (int index = 0; index < targets.size(); index++) {
      Class<?> target = targets.get(index);
      if (target == null || uniqueTargets.put(target, Boolean.TRUE) != null) {
        throw new IllegalArgumentException(
            "A class change set cannot contain duplicate classes");
      }
      if (firstTarget) {
        expectedClassLoader = target.getClassLoader();
        firstTarget = false;
      } else if (target.getClassLoader() != expectedClassLoader) {
        throw new IllegalArgumentException(
            "All classes in a change set must use the same exact ClassLoader");
      }
      requireTarget(target);
      byte[] current = currentDefinition(target);
      byte[] proposed = decode(encodedBytecodes.get(index));
      totalBytes += proposed.length;
      if (totalBytes > MAXIMUM_CHANGE_SET_BYTES) {
        throw new IllegalArgumentException(
            "Compiled change-set bytecode exceeds the 2 MiB limit");
      }
      validateShape(target, current, proposed);
      candidates.add(
          new Candidate(
              target,
              current,
              proposed,
              sha256(current),
              sha256(proposed)));
    }
    Collections.sort(
        candidates,
        Comparator.comparing(
                (Candidate candidate) -> candidate.target.getName())
            .thenComparing(
                candidate -> classLoaderName(candidate.target)));
    return candidates;
  }

  private void restoreCandidatesAfterVerificationFailure(
      List<Candidate> candidates, Exception verificationFailure) {
    ClassDefinition[] baselines =
        new ClassDefinition[candidates.size()];
    for (int index = 0; index < candidates.size(); index++) {
      Candidate candidate = candidates.get(index);
      baselines[index] =
          new ClassDefinition(candidate.target, candidate.current);
    }
    try {
      instrumentation.redefineClasses(baselines);
    } catch (Exception rollbackFailure) {
      verificationFailure.addSuppressed(rollbackFailure);
    }
  }

  private static String classLoaderName(Class<?> target) {
    ClassLoader loader = target.getClassLoader();
    return loader == null ? "bootstrap" : loader.toString();
  }

  private void requireTarget(Class<?> target) {
    if (!isAvailable()) {
      throw new UnsupportedOperationException(
          "The target JVM does not support class redefinition");
    }
    if (!instrumentation.isModifiableClass(target)) {
      throw new IllegalArgumentException("The selected class is not modifiable");
    }
  }

  private static byte[] decode(String encoded) {
    if (encoded == null
        || encoded.isEmpty()
        || encoded.length() > ((MAXIMUM_CLASS_BYTES * 4 / 3) + 8)) {
      throw new IllegalArgumentException("Compiled class payload is empty or too large");
    }
    byte[] decoded;
    try {
      decoded = Base64.getDecoder().decode(encoded);
    } catch (IllegalArgumentException exception) {
      throw new IllegalArgumentException("Compiled class payload is not valid Base64", exception);
    }
    if (decoded.length < 8 || decoded.length > MAXIMUM_CLASS_BYTES) {
      throw new IllegalArgumentException("Compiled class payload is outside the size limit");
    }
    return decoded;
  }

  private static void validateShape(
      Class<?> target, byte[] current, byte[] proposed) {
    ClassShape before = ClassShape.read(current);
    ClassShape after = ClassShape.read(proposed);
    String expectedName = target.getName().replace('.', '/');
    if (!expectedName.equals(after.name)) {
      throw new IllegalArgumentException(
          "Compiled class identity does not match the selected class");
    }
    if (!before.compatibleWith(after)) {
      throw new IllegalArgumentException(
          "Class schema changed; only method bodies may be replaced");
    }
  }

  private static String sha256(byte[] value) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(value);
    StringBuilder result = new StringBuilder(digest.length * 2);
    for (byte item : digest) {
      result.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
    }
    return result.toString();
  }

  private static String changeSetFingerprint(
      List<Candidate> candidates) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    updateFingerprint(digest, "tanwei-class-change-set-preview-v1");
    for (Candidate candidate : candidates) {
      updateFingerprint(digest, candidate.target.getName());
      updateFingerprint(digest, classLoaderName(candidate.target));
      updateFingerprint(digest, candidate.currentSha256);
      updateFingerprint(digest, candidate.proposedSha256);
    }
    return hexadecimal(digest.digest());
  }

  private static String currentDefinitionFingerprint(
      List<Rollback> items, List<String> currentHashes)
      throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    updateFingerprint(digest, "tanwei-class-change-set-current-v1");
    for (int index = 0; index < items.size(); index++) {
      Rollback item = items.get(index);
      updateFingerprint(digest, item.target.getName());
      updateFingerprint(digest, classLoaderName(item.target));
      updateFingerprint(digest, currentHashes.get(index));
    }
    return hexadecimal(digest.digest());
  }

  private static void updateFingerprint(
      MessageDigest digest, String value) {
    byte[] encoded = value.getBytes(StandardCharsets.UTF_8);
    digest.update((byte) ((encoded.length >>> 24) & 0xff));
    digest.update((byte) ((encoded.length >>> 16) & 0xff));
    digest.update((byte) ((encoded.length >>> 8) & 0xff));
    digest.update((byte) (encoded.length & 0xff));
    digest.update(encoded);
  }

  private static String hexadecimal(byte[] value) {
    StringBuilder result = new StringBuilder(value.length * 2);
    for (byte item : value) {
      result.append(
          String.format(
              java.util.Locale.ROOT, "%02x", item & 0xff));
    }
    return result.toString();
  }

  static final class StaleDefinitionException extends IllegalStateException {
    private final String actualSha256;

    StaleDefinitionException(String actualSha256) {
      super("The class definition changed after preview");
      this.actualSha256 = actualSha256;
    }

    String getActualSha256() {
      return actualSha256;
    }
  }

  static final class StaleChangeSetException extends IllegalStateException {
    private final String actualFingerprint;

    StaleChangeSetException(String actualFingerprint) {
      super("One or more class definitions changed after preview");
      this.actualFingerprint = actualFingerprint;
    }

    String getActualFingerprint() {
      return actualFingerprint;
    }
  }

  static final class Preview {
    private final String currentSha256;
    private final String proposedSha256;
    private final int currentSize;
    private final int proposedSize;

    Preview(
        String currentSha256,
        String proposedSha256,
        int currentSize,
        int proposedSize) {
      this.currentSha256 = currentSha256;
      this.proposedSha256 = proposedSha256;
      this.currentSize = currentSize;
      this.proposedSize = proposedSize;
    }

    String getCurrentSha256() {
      return currentSha256;
    }

    String getProposedSha256() {
      return proposedSha256;
    }

    int getCurrentSize() {
      return currentSize;
    }

    int getProposedSize() {
      return proposedSize;
    }
  }

  static final class Result {
    private final String previousSha256;
    private final String currentSha256;
    private final String rollbackToken;
    private final int previousSize;
    private final int currentSize;

    Result(
        String previousSha256,
        String currentSha256,
        String rollbackToken,
        int previousSize,
        int currentSize) {
      this.previousSha256 = previousSha256;
      this.currentSha256 = currentSha256;
      this.rollbackToken = rollbackToken;
      this.previousSize = previousSize;
      this.currentSize = currentSize;
    }

    String getPreviousSha256() {
      return previousSha256;
    }

    String getCurrentSha256() {
      return currentSha256;
    }

    String getRollbackToken() {
      return rollbackToken;
    }

    int getPreviousSize() {
      return previousSize;
    }

    int getCurrentSize() {
      return currentSize;
    }
  }

  static final class BatchPreview {
    private final String fingerprint;
    private final List<BatchPreviewItem> items;

    private BatchPreview(
        String fingerprint, List<BatchPreviewItem> items) {
      this.fingerprint = fingerprint;
      this.items =
          Collections.unmodifiableList(
              new ArrayList<BatchPreviewItem>(items));
    }

    String getFingerprint() {
      return fingerprint;
    }

    List<BatchPreviewItem> getItems() {
      return items;
    }
  }

  static final class BatchPreviewItem {
    private final Class<?> target;
    private final String currentSha256;
    private final String proposedSha256;
    private final int currentSize;
    private final int proposedSize;

    private BatchPreviewItem(
        Class<?> target,
        String currentSha256,
        String proposedSha256,
        int currentSize,
        int proposedSize) {
      this.target = target;
      this.currentSha256 = currentSha256;
      this.proposedSha256 = proposedSha256;
      this.currentSize = currentSize;
      this.proposedSize = proposedSize;
    }

    String getClassName() {
      return target.getName();
    }

    String getClassLoader() {
      return classLoaderName(target);
    }

    String getCurrentSha256() {
      return currentSha256;
    }

    String getProposedSha256() {
      return proposedSha256;
    }

    int getCurrentSize() {
      return currentSize;
    }

    int getProposedSize() {
      return proposedSize;
    }
  }

  static final class BatchResult {
    private final String rollbackToken;
    private final String expectedCurrentFingerprint;
    private final List<BatchResultItem> items;

    private BatchResult(
        String rollbackToken,
        String expectedCurrentFingerprint,
        List<BatchResultItem> items) {
      this.rollbackToken = rollbackToken;
      this.expectedCurrentFingerprint = expectedCurrentFingerprint;
      this.items =
          Collections.unmodifiableList(
              new ArrayList<BatchResultItem>(items));
    }

    String getRollbackToken() {
      return rollbackToken;
    }

    String getExpectedCurrentFingerprint() {
      return expectedCurrentFingerprint;
    }

    List<BatchResultItem> getItems() {
      return items;
    }
  }

  static final class BatchResultItem {
    private final Class<?> target;
    private final String previousSha256;
    private final String currentSha256;
    private final int previousSize;
    private final int currentSize;

    private BatchResultItem(
        Class<?> target,
        String previousSha256,
        String currentSha256,
        int previousSize,
        int currentSize) {
      this.target = target;
      this.previousSha256 = previousSha256;
      this.currentSha256 = currentSha256;
      this.previousSize = previousSize;
      this.currentSize = currentSize;
    }

    String getClassName() {
      return target.getName();
    }

    String getClassLoader() {
      return classLoaderName(target);
    }

    String getPreviousSha256() {
      return previousSha256;
    }

    String getCurrentSha256() {
      return currentSha256;
    }

    int getPreviousSize() {
      return previousSize;
    }

    int getCurrentSize() {
      return currentSize;
    }
  }

  static final class ResetSnapshot {
    private final Class<?> target;
    private final byte[] baselineBytecode;
    private final String expectedCurrentSha256;
    private final int rollbackCount;

    private ResetSnapshot(
        Class<?> target,
        byte[] baselineBytecode,
        String expectedCurrentSha256,
        int rollbackCount) {
      this.target = target;
      this.baselineBytecode = baselineBytecode.clone();
      this.expectedCurrentSha256 = expectedCurrentSha256;
      this.rollbackCount = rollbackCount;
    }

    String getClassName() {
      return target.getName();
    }

    String getClassLoader() {
      return classLoaderName(target);
    }

    String getBaselineSha256() throws Exception {
      return sha256(baselineBytecode);
    }

    String getExpectedCurrentSha256() {
      return expectedCurrentSha256;
    }

    int getRollbackCount() {
      return rollbackCount;
    }
  }

  static final class ResetResult {
    private final List<ResetItem> items;

    private ResetResult(List<ResetItem> items) {
      this.items =
          Collections.unmodifiableList(
              new ArrayList<ResetItem>(items));
    }

    List<ResetItem> getItems() {
      return items;
    }
  }

  static final class ResetItem {
    private final String className;
    private final String classLoader;
    private final String state;
    private final String previousSha256;
    private final String currentSha256;
    private final int rollbackCount;
    private final String error;

    private ResetItem(
        String className,
        String classLoader,
        String state,
        String previousSha256,
        String currentSha256,
        int rollbackCount,
        String error) {
      this.className = className;
      this.classLoader = classLoader;
      this.state = state;
      this.previousSha256 = previousSha256;
      this.currentSha256 = currentSha256;
      this.rollbackCount = rollbackCount;
      this.error = error;
    }

    private static ResetItem succeeded(
        ResetSnapshot snapshot,
        String previousSha256,
        String currentSha256) {
      return new ResetItem(
          snapshot.getClassName(),
          snapshot.getClassLoader(),
          "RESTORED",
          previousSha256,
          currentSha256,
          snapshot.getRollbackCount(),
          "");
    }

    private static ResetItem failed(
        ResetSnapshot snapshot,
        String actualSha256,
        String error) {
      return new ResetItem(
          snapshot == null ? "" : snapshot.getClassName(),
          snapshot == null ? "" : snapshot.getClassLoader(),
          "CONFLICT",
          actualSha256,
          snapshot == null
              ? ""
              : snapshot.expectedCurrentSha256,
          snapshot == null ? 0 : snapshot.getRollbackCount(),
          error);
    }

    String getClassName() {
      return className;
    }

    String getClassLoader() {
      return classLoader;
    }

    String getState() {
      return state;
    }

    String getPreviousSha256() {
      return previousSha256;
    }

    String getCurrentSha256() {
      return currentSha256;
    }

    int getRollbackCount() {
      return rollbackCount;
    }

    String getError() {
      return error;
    }
  }

  private static final class Candidate {
    private final Class<?> target;
    private final byte[] current;
    private final byte[] proposed;
    private final String currentSha256;
    private final String proposedSha256;

    private Candidate(
        Class<?> target,
        byte[] current,
        byte[] proposed,
        String currentSha256,
        String proposedSha256) {
      this.target = target;
      this.current = current.clone();
      this.proposed = proposed.clone();
      this.currentSha256 = currentSha256;
      this.proposedSha256 = proposedSha256;
    }
  }

  private static final class RollbackSet {
    private final List<Rollback> items;
    private final String expectedCurrentFingerprint;

    private RollbackSet(List<Rollback> items) {
      this.items =
          Collections.unmodifiableList(
              new ArrayList<Rollback>(items));
      try {
        List<String> hashes =
            new ArrayList<String>(items.size());
        for (Rollback item : items) {
          hashes.add(item.expectedCurrentSha256);
        }
        this.expectedCurrentFingerprint =
            currentDefinitionFingerprint(this.items, hashes);
      } catch (Exception exception) {
        throw new IllegalStateException(
            "Unable to fingerprint the class rollback set",
            exception);
      }
    }
  }

  private static final class Rollback {
    private final Class<?> target;
    private final byte[] bytecode;
    private final String expectedCurrentSha256;

    private Rollback(
        Class<?> target, byte[] bytecode, String expectedCurrentSha256) {
      this.target = target;
      this.bytecode = bytecode;
      this.expectedCurrentSha256 = expectedCurrentSha256;
    }
  }

  private static final class ClassShape {
    private String name = "";
    private String superName = "";
    private int access;
    private List<String> interfaces = Collections.emptyList();
    private final List<String> fields = new ArrayList<String>();
    private final List<String> methods = new ArrayList<String>();

    private static ClassShape read(byte[] bytecode) {
      final ClassShape shape = new ClassShape();
      new ClassReader(bytecode)
          .accept(
              new ClassVisitor(Opcodes.ASM9) {
                @Override
                public void visit(
                    int version,
                    int access,
                    String name,
                    String signature,
                    String superName,
                    String[] interfaces) {
                  shape.name = name;
                  shape.superName = superName == null ? "" : superName;
                  shape.access = access & CLASS_ACCESS_MASK;
                  shape.interfaces =
                      new ArrayList<String>(Arrays.asList(interfaces));
                  Collections.sort(shape.interfaces);
                }

                @Override
                public FieldVisitor visitField(
                    int access,
                    String name,
                    String descriptor,
                    String signature,
                    Object value) {
                  shape.fields.add(
                      name + "\0" + descriptor + "\0" + (access & MEMBER_ACCESS_MASK));
                  return null;
                }

                @Override
                public MethodVisitor visitMethod(
                    int access,
                    String name,
                    String descriptor,
                    String signature,
                    String[] exceptions) {
                  shape.methods.add(
                      name + "\0" + descriptor + "\0" + (access & MEMBER_ACCESS_MASK));
                  return null;
                }
              },
              ClassReader.SKIP_CODE
                  | ClassReader.SKIP_DEBUG
                  | ClassReader.SKIP_FRAMES);
      Collections.sort(shape.fields);
      Collections.sort(shape.methods);
      return shape;
    }

    private boolean compatibleWith(ClassShape other) {
      return name.equals(other.name)
          && superName.equals(other.superName)
          && access == other.access
          && interfaces.equals(other.interfaces)
          && fields.equals(other.fields)
          && methods.equals(other.methods);
    }
  }
}
