package dev.tanwei.agent;

import java.io.InputStream;
import java.lang.instrument.Instrumentation;
import java.lang.ref.Reference;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.ForkJoinWorkerThread;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.locks.LockSupport;
import java.util.concurrent.locks.ReentrantLock;

final class HeapInstanceController implements AutoCloseable {
  private static final int MAXIMUM_INSTANCES = 20;
  private static final int MAXIMUM_FIELDS = 32;
  private static final int MAXIMUM_ARRAY_ELEMENTS = 16;
  private static final int MAXIMUM_VALUE_LENGTH = 512;
  private static final int MAXIMUM_RELATIONS = 50;
  private static final int MAXIMUM_RELATION_SCAN = 1_000_000;
  private static final int MAXIMUM_GRAPH_DEPTH = 5;
  private static final int MAXIMUM_GRAPH_NODES = 80;
  private static final int MAXIMUM_GRAPH_EDGES_PER_NODE = 8;
  private static final int MAXIMUM_ROOT_DEPTH = 32;
  private static final int MAXIMUM_ROOT_NODES = 100_000;
  private static final int MAXIMUM_ROOT_PATHS = 8;
  private static final int MAXIMUM_REFERENCE_CLASSES = 256;
  private static final int MAXIMUM_RETAINED_CONTRIBUTORS = 20;
  private static final int MAXIMUM_DOMINATOR_NODES = 500_000;
  private static final int MAXIMUM_DOMINATOR_EDGES = 2_000_000;
  private static final int MAXIMUM_DOMINATOR_VIEW_DEPTH = 8;
  private static final int MAXIMUM_DOMINATOR_VIEW_NODES = 200;
  private static final int MAXIMUM_DOMINATOR_VIEW_BRANCHES = 20;
  private static final int MAXIMUM_HISTOGRAM_CLASSES = 50_000;
  private static final int MAXIMUM_HISTOGRAM_ROWS = 200;
  private static final int MAXIMUM_HISTOGRAM_OBJECTS = 5_000_000;
  private static final int MINIMUM_THREAD_POOLS = 3;
  private static final int MAXIMUM_THREAD_POOLS = 20;
  private static final int MINIMUM_THREAD_POOL_MEMBERS = 10;
  private static final int MAXIMUM_THREAD_POOL_MEMBERS = 200;
  private static final int MINIMUM_THREAD_POOL_QUEUE_TASKS = 10;
  private static final int MAXIMUM_THREAD_POOL_QUEUE_TASKS = 200;
  private static final int MAXIMUM_THREAD_ENUMERATION = 10_000;
  private static final int MAXIMUM_SESSION_HANDLES = 256;
  private static final int TAG_PREFIX_SHIFT = 48;
  private static final long TAG_PREFIX_MASK = 0x7FFF000000000000L;
  private static final long TAG_COUNTER_MASK = 0x0000FFFFFFFFFFFFL;

  private final Instrumentation instrumentation;
  private final NativeAccess nativeAccess;
  private final SecureRandom secureRandom = new SecureRandom();
  private final long tagPrefix;
  private final LinkedHashMap<String, Long> handles =
      new LinkedHashMap<String, Long>();
  private final Map<Long, String> handlesByTag = new HashMap<Long, String>();
  private long nextTagCounter = 1_024L;
  private volatile boolean loaded;
  private volatile String unavailableReason = "";
  private boolean threadPoolPackageOpened;
  private Path extractedLibrary;

  HeapInstanceController(Instrumentation instrumentation) {
    this(instrumentation, new JniNativeAccess(), false);
  }

  HeapInstanceController(
      Instrumentation instrumentation, NativeAccess nativeAccess) {
    this(instrumentation, nativeAccess, true);
  }

  private HeapInstanceController(
      Instrumentation instrumentation,
      NativeAccess nativeAccess,
      boolean nativeAccessReady) {
    if (instrumentation == null || nativeAccess == null) {
      throw new IllegalArgumentException(
          "Instrumentation and native access are required");
    }
    this.instrumentation = instrumentation;
    this.nativeAccess = nativeAccess;
    this.loaded = nativeAccessReady;
    this.tagPrefix =
        ((long) (secureRandom.nextInt(0x7FFE) + 1))
            << TAG_PREFIX_SHIFT;
  }

  boolean isPotentiallyAvailable() {
    String resource = resourcePath();
    return resource != null
        && HeapInstanceController.class.getResource(resource) != null
        && unavailableReason.isEmpty();
  }

  String unavailableReason() {
    if (!unavailableReason.isEmpty()) {
      return unavailableReason;
    }
    String resource = resourcePath();
    return resource == null
        ? "No JVMTI heap query library is packaged for this OS and architecture"
        : HeapInstanceController.class.getResource(resource) == null
            ? "The JVMTI heap query library is missing from the Agent package"
            : "";
  }

  synchronized QueryResult query(
      String className, String classLoader, int limit) throws Exception {
    if (limit < 1 || limit > MAXIMUM_INSTANCES) {
      throw new IllegalArgumentException(
          "Heap query limit must be between 1 and 20");
    }
    Class<?> target = findClass(className, classLoader);
    if (target == null) {
      throw new IllegalArgumentException(
          "The selected heap class is no longer loaded");
    }
    ensureLoaded();
    clearHandles();
    long tagBase = allocateTagBlock(limit);
    Object[] objects =
        nativeAccess.collectInstances(target, limit, tagBase);
    List<Instance> instances =
        new ArrayList<Instance>(objects == null ? 0 : objects.length);
    if (objects != null) {
      for (Object object : objects) {
        if (object == null || object.getClass() != target) {
          continue;
        }
        long tag = nativeAccess.objectTag(object);
        String handle = registerTaggedObject(tag);
        if (!handle.isEmpty()) {
          instances.add(describe(object, handle));
        }
      }
    }
    return new QueryResult(
        target.getName(),
        classLoaderName(target),
        limit,
        instances);
  }

  synchronized RelationResult relations(
      String objectHandle,
      String direction,
      int limit,
      int scanLimit)
      throws Exception {
    if (objectHandle == null || objectHandle.trim().isEmpty()) {
      throw new IllegalArgumentException("Object handle is required");
    }
    if (limit < 1 || limit > MAXIMUM_RELATIONS) {
      throw new IllegalArgumentException(
          "Relation limit must be between 1 and 50");
    }
    if (scanLimit < 1_000 || scanLimit > MAXIMUM_RELATION_SCAN) {
      throw new IllegalArgumentException(
          "Relation scan limit must be between 1000 and 1000000");
    }
    String normalizedDirection =
        direction == null ? "" : direction.trim().toUpperCase(Locale.ROOT);
    if (!"OUTGOING".equals(normalizedDirection)
        && !"INCOMING".equals(normalizedDirection)) {
      throw new IllegalArgumentException(
          "Relation direction must be OUTGOING or INCOMING");
    }
    ensureLoaded();
    Object target = resolveHandle(objectHandle);
    RelationCollection collection =
        "OUTGOING".equals(normalizedDirection)
            ? collectOutgoing(target, limit, scanLimit)
            : collectIncoming(target, limit, scanLimit);
    return new RelationResult(
        describe(target, objectHandle),
        normalizedDirection,
        collection.scanned,
        collection.truncated,
        collection.relations);
  }

  synchronized ObjectGraphResult objectGraph(
      String objectHandle,
      String direction,
      int maximumDepth,
      int maximumNodes,
      int maximumEdgesPerNode,
      int scanLimit)
      throws Exception {
    if (objectHandle == null || objectHandle.trim().isEmpty()) {
      throw new IllegalArgumentException("Object handle is required");
    }
    String normalizedDirection =
        direction == null ? "" : direction.trim().toUpperCase(Locale.ROOT);
    if (!"OUTGOING".equals(normalizedDirection)
        && !"INCOMING".equals(normalizedDirection)) {
      throw new IllegalArgumentException(
          "Graph direction must be OUTGOING or INCOMING");
    }
    if (maximumDepth < 1 || maximumDepth > MAXIMUM_GRAPH_DEPTH) {
      throw new IllegalArgumentException(
          "Graph depth must be between 1 and 5");
    }
    if (maximumNodes < 2 || maximumNodes > MAXIMUM_GRAPH_NODES) {
      throw new IllegalArgumentException(
          "Graph node limit must be between 2 and 80");
    }
    if (maximumEdgesPerNode < 1
        || maximumEdgesPerNode > MAXIMUM_GRAPH_EDGES_PER_NODE) {
      throw new IllegalArgumentException(
          "Graph branch limit must be between 1 and 8");
    }
    if (scanLimit < 1_000 || scanLimit > MAXIMUM_RELATION_SCAN) {
      throw new IllegalArgumentException(
          "Graph scan limit must be between 1000 and 1000000");
    }
    ensureLoaded();
    if ("INCOMING".equals(normalizedDirection)) {
      return collectIncomingGraph(
            objectHandle,
            maximumDepth,
            maximumNodes,
            maximumEdgesPerNode,
            scanLimit);
    }
    Object target = resolveHandle(objectHandle);
    return collectOutgoingGraph(
        target,
        objectHandle,
        maximumDepth,
        maximumNodes,
        maximumEdgesPerNode,
        scanLimit);
  }

  synchronized RootPathResult rootPath(
      String objectHandle,
      int maximumDepth,
      int maximumNodes,
      int maximumEdges)
      throws Exception {
    if (objectHandle == null || objectHandle.trim().isEmpty()) {
      throw new IllegalArgumentException("Object handle is required");
    }
    if (maximumDepth < 1 || maximumDepth > MAXIMUM_ROOT_DEPTH) {
      throw new IllegalArgumentException(
          "Root path depth must be between 1 and 32");
    }
    if (maximumNodes < 1_000 || maximumNodes > MAXIMUM_ROOT_NODES) {
      throw new IllegalArgumentException(
          "Root path node limit must be between 1000 and 100000");
    }
    if (maximumEdges < 1_000
        || maximumEdges > MAXIMUM_RELATION_SCAN) {
      throw new IllegalArgumentException(
          "Root path edge limit must be between 1000 and 1000000");
    }
    ensureLoaded();
    Long targetTag = handles.get(objectHandle);
    if (targetTag == null) {
      throw new IllegalArgumentException(
          "The selected object handle is unknown or expired");
    }
    Object[] packed =
        nativeAccess.collectRootPath(
            targetTag.longValue(),
            maximumDepth,
            maximumNodes,
            maximumEdges,
            temporaryTagPrefix(),
            tagPrefix);
    if (packed == null
        || packed.length < 2
        || !(packed[0] instanceof Object[])
        || !(packed[1] instanceof long[])) {
      throw new IllegalStateException(
          "The native root-path result is invalid");
    }
    Object[] objects = (Object[]) packed[0];
    long[] metadata = (long[]) packed[1];
    if (metadata.length < 7) {
      throw new IllegalStateException(
          "The native root-path metadata is incomplete");
    }
    int pathCount =
        Math.min(
            maximumDepth + 1,
            Math.min(
                objects.length,
                Math.max(0, safeInt(metadata[4]))));
    if (pathCount < 1
        || metadata.length < 5 + pathCount * 2
        || objects[0] == null) {
      handles.remove(objectHandle);
      handlesByTag.remove(targetTag);
      throw new IllegalStateException(
          "The selected object was garbage collected");
    }
    boolean rootReached = metadata[2] != 0;
    List<RootPathNode> nodes =
        new ArrayList<RootPathNode>(pathCount);
    for (int index = 0; index < pathCount; index++) {
      Object object = objects[index];
      if (object == null) {
        throw new IllegalStateException(
            "The native root-path contains a missing object");
      }
      String handle =
          index == 0 ? objectHandle : handleForObject(object);
      int kind = safeInt(metadata[5 + index * 2]);
      int referenceIndex = safeInt(metadata[6 + index * 2]);
      nodes.add(
          new RootPathNode(
              describe(object, handle),
              referenceLabel(kind, referenceIndex),
              referenceKind(kind),
              referenceIndex,
              rootReached && index == pathCount - 1));
    }
    return new RootPathResult(
        safeInt(metadata[0]),
        safeInt(metadata[3]),
        metadata[1] != 0,
        rootReached,
        nodes);
  }

  synchronized RootPathsResult rootPaths(
      String objectHandle,
      int maximumPaths,
      int maximumDepth,
      int maximumNodes,
      int maximumEdges)
      throws Exception {
    if (objectHandle == null || objectHandle.trim().isEmpty()) {
      throw new IllegalArgumentException("Object handle is required");
    }
    if (maximumPaths < 1 || maximumPaths > MAXIMUM_ROOT_PATHS) {
      throw new IllegalArgumentException(
          "GC Root path count must be between 1 and 8");
    }
    if (maximumDepth < 1 || maximumDepth > MAXIMUM_ROOT_DEPTH) {
      throw new IllegalArgumentException(
          "Root path depth must be between 1 and 32");
    }
    if (maximumNodes < 1_000 || maximumNodes > MAXIMUM_ROOT_NODES) {
      throw new IllegalArgumentException(
          "Root path node limit must be between 1000 and 100000");
    }
    if (maximumEdges < 1_000
        || maximumEdges > MAXIMUM_RELATION_SCAN) {
      throw new IllegalArgumentException(
          "Root path edge limit must be between 1000 and 1000000");
    }
    ensureLoaded();
    Long targetTag = handles.get(objectHandle);
    if (targetTag == null) {
      throw new IllegalArgumentException(
          "The selected object handle is unknown or expired");
    }
    Object[] packed =
        nativeAccess.collectRootPaths(
            targetTag.longValue(),
            maximumPaths,
            maximumDepth,
            maximumNodes,
            maximumEdges,
            temporaryTagPrefix(),
            tagPrefix);
    if (packed == null
        || packed.length < 2
        || !(packed[0] instanceof Object[])
        || !(packed[1] instanceof long[])) {
      throw new IllegalStateException(
          "The native multi-root-path result is invalid");
    }
    Object[] objects = (Object[]) packed[0];
    long[] metadata = (long[]) packed[1];
    if (metadata.length < 6) {
      throw new IllegalStateException(
          "The native multi-root-path metadata is incomplete");
    }
    int pathCount =
        Math.min(
            maximumPaths,
            Math.max(0, safeInt(metadata[5])));
    if (pathCount < 1) {
      throw new IllegalStateException(
          "No bounded GC Root path was returned");
    }
    int metadataIndex = 6;
    int objectIndex = 0;
    List<RootPath> paths =
        new ArrayList<RootPath>(pathCount);
    for (int pathIndex = 0;
        pathIndex < pathCount;
        pathIndex++) {
      if (metadataIndex + 2 > metadata.length) {
        throw new IllegalStateException(
            "The native GC Root path header is incomplete");
      }
      int nodeCount =
          Math.min(
              maximumDepth + 1,
              Math.max(0, safeInt(metadata[metadataIndex++])));
      boolean rootReached = metadata[metadataIndex++] != 0;
      if (nodeCount < 1
          || objectIndex + nodeCount > objects.length
          || metadataIndex + nodeCount * 2 > metadata.length) {
        throw new IllegalStateException(
            "The native GC Root path nodes are incomplete");
      }
      List<RootPathNode> nodes =
          new ArrayList<RootPathNode>(nodeCount);
      for (int nodeIndex = 0;
          nodeIndex < nodeCount;
          nodeIndex++) {
        Object object = objects[objectIndex++];
        if (object == null) {
          throw new IllegalStateException(
              "The native GC Root paths contain a missing object");
        }
        String handle =
            nodeIndex == 0
                ? objectHandle
                : handleForObject(object);
        int kind = safeInt(metadata[metadataIndex++]);
        int referenceIndex =
            safeInt(metadata[metadataIndex++]);
        nodes.add(
            new RootPathNode(
                describe(object, handle),
                referenceLabel(kind, referenceIndex),
                referenceKind(kind),
                referenceIndex,
                rootReached && nodeIndex == nodeCount - 1));
      }
      paths.add(new RootPath(rootReached, nodes));
    }
    return new RootPathsResult(
        Math.max(0L, metadata[0]),
        Math.max(0, safeInt(metadata[2])),
        Math.max(0L, metadata[3]),
        metadata[1] != 0,
        metadata[4] != 0,
        paths);
  }

  synchronized RetainedSizeResult retainedSize(
      String objectHandle, int maximumNodes, int maximumEdges)
      throws Exception {
    if (objectHandle == null || objectHandle.trim().isEmpty()) {
      throw new IllegalArgumentException("Object handle is required");
    }
    if (maximumNodes < 1_000 || maximumNodes > MAXIMUM_ROOT_NODES) {
      throw new IllegalArgumentException(
          "Retained-size node limit must be between 1000 and 100000");
    }
    if (maximumEdges < 1_000
        || maximumEdges > MAXIMUM_RELATION_SCAN) {
      throw new IllegalArgumentException(
          "Retained-size edge limit must be between 1000 and 1000000");
    }
    ensureLoaded();
    Object target = resolveHandle(objectHandle);
    ReferenceClassSelection referenceSelection =
        selectReferenceClasses();
    long scanPrefix = temporaryTagPrefix();
    long referencePrefix;
    do {
      referencePrefix = temporaryTagPrefix();
    } while (referencePrefix == scanPrefix);
    Object[] packed =
        nativeAccess.collectRetainedSize(
            target,
            maximumNodes,
            maximumEdges,
            scanPrefix,
            referencePrefix,
            tagPrefix,
            referenceSelection.classes,
            referenceSelection.complete);
    if (packed == null
        || packed.length < 2
        || !(packed[0] instanceof Object[])
        || !(packed[1] instanceof long[])) {
      throw new IllegalStateException(
          "The native retained-size result is invalid");
    }
    Object[] objects = (Object[]) packed[0];
    long[] metadata = (long[]) packed[1];
    if (metadata.length < 15) {
      throw new IllegalStateException(
          "The native retained-size metadata is incomplete");
    }
    int contributorCount =
        Math.min(
            MAXIMUM_RETAINED_CONTRIBUTORS,
            Math.max(0, safeInt(metadata[14])));
    if (objects.length < contributorCount
        || metadata.length < 15 + contributorCount) {
      throw new IllegalStateException(
          "The native retained-size contributors are incomplete");
    }
    List<RetainedContributor> contributors =
        new ArrayList<RetainedContributor>(contributorCount);
    for (int index = 0; index < contributorCount; index++) {
      Object object = objects[index];
      if (object == null) {
        throw new IllegalStateException(
            "The native retained-size contributors contain a missing object");
      }
      String handle =
          object == target ? objectHandle : handleForObject(object);
      contributors.add(
          new RetainedContributor(
              index + 1,
              Math.max(0L, metadata[15 + index]),
              describe(object, handle)));
    }
    boolean exact = metadata[8] != 0;
    long retainedBytes = exact ? Math.max(0L, metadata[13]) : -1L;
    return new RetainedSizeResult(
        describe(target, objectHandle),
        Math.max(0L, metadata[0]),
        Math.max(0L, metadata[1]),
        Math.max(0, safeInt(metadata[2])),
        Math.max(0L, metadata[3]),
        metadata[4] != 0,
        metadata[5] != 0,
        Math.max(0, safeInt(metadata[6])),
        metadata[7] != 0,
        exact,
        Math.max(0L, metadata[9]),
        Math.max(0L, metadata[10]),
        Math.max(0L, metadata[11]),
        Math.max(0L, metadata[12]),
        retainedBytes,
        contributors);
  }

  synchronized RetainedRankingResult retainedRanking(
      String className,
      String classLoader,
      int instanceLimit,
      int maximumNodes,
      int maximumEdges)
      throws Exception {
    if (instanceLimit < 1 || instanceLimit > MAXIMUM_INSTANCES) {
      throw new IllegalArgumentException(
          "Retained-ranking instance limit must be between 1 and 20");
    }
    if (maximumNodes < 10_000
        || maximumNodes > MAXIMUM_DOMINATOR_NODES) {
      throw new IllegalArgumentException(
          "Retained-ranking node limit must be between 10000 and 500000");
    }
    if (maximumEdges < 10_000
        || maximumEdges > MAXIMUM_DOMINATOR_EDGES) {
      throw new IllegalArgumentException(
          "Retained-ranking edge limit must be between 10000 and 2000000");
    }
    QueryResult queryResult =
        query(className, classLoader, instanceLimit);
    List<Instance> instances = queryResult.getInstances();
    if (instances.isEmpty()) {
      return RetainedRankingResult.empty(
          queryResult.getClassName(),
          queryResult.getClassLoader(),
          instanceLimit);
    }
    long[] targetTags = new long[instances.size()];
    for (int index = 0; index < instances.size(); index++) {
      Long tag = handles.get(instances.get(index).getHandle());
      if (tag == null
          || tag.longValue() <= 0
          || (tag.longValue() & TAG_PREFIX_MASK) != tagPrefix) {
        throw new IllegalStateException(
            "A retained-ranking object handle expired before analysis");
      }
      targetTags[index] = tag.longValue();
    }
    ReferenceClassSelection referenceSelection =
        selectReferenceClasses();
    long scanPrefix = temporaryTagPrefix();
    long referencePrefix;
    do {
      referencePrefix = temporaryTagPrefix();
    } while (referencePrefix == scanPrefix);
    long[] metadata =
        nativeAccess.collectRetainedRanking(
            targetTags,
            maximumNodes,
            maximumEdges,
            scanPrefix,
            referencePrefix,
            tagPrefix,
            referenceSelection.classes,
            referenceSelection.complete);
    if (metadata == null
        || metadata.length < 12
        || safeInt(metadata[11]) != instances.size()
        || metadata.length < 12 + instances.size() * 5) {
      throw new IllegalStateException(
          "The native retained-ranking result is invalid");
    }
    boolean exact = metadata[8] != 0;
    List<RetainedRankingEntry> unsorted =
        new ArrayList<RetainedRankingEntry>(instances.size());
    for (int index = 0; index < instances.size(); index++) {
      int offset = 12 + index * 5;
      if (metadata[offset] == 0) {
        continue;
      }
      long candidateObjects = Math.max(0L, metadata[offset + 2]);
      long candidateBytes = Math.max(0L, metadata[offset + 3]);
      long retainedBytes =
          exact ? Math.max(0L, metadata[offset + 4]) : -1L;
      if (candidateObjects < 1
          || candidateBytes < instances.get(index).getShallowSize()
          || (exact && retainedBytes != candidateBytes)) {
        throw new IllegalStateException(
            "The native retained-ranking entry is inconsistent");
      }
      unsorted.add(
          new RetainedRankingEntry(
              0,
              candidateObjects,
              candidateBytes,
              retainedBytes,
              instances.get(index)));
    }
    Collections.sort(
        unsorted,
        new Comparator<RetainedRankingEntry>() {
          @Override
          public int compare(
              RetainedRankingEntry left,
              RetainedRankingEntry right) {
            int bytes =
                Long.compare(
                    right.getCandidateBytes(),
                    left.getCandidateBytes());
            if (bytes != 0) {
              return bytes;
            }
            int objects =
                Long.compare(
                    right.getCandidateObjects(),
                    left.getCandidateObjects());
            if (objects != 0) {
              return objects;
            }
            return left
                .getObject()
                .getIdentity()
                .compareTo(right.getObject().getIdentity());
          }
        });
    List<RetainedRankingEntry> ranked =
        new ArrayList<RetainedRankingEntry>(unsorted.size());
    for (int index = 0; index < unsorted.size(); index++) {
      RetainedRankingEntry entry = unsorted.get(index);
      ranked.add(
          new RetainedRankingEntry(
              index + 1,
              entry.getCandidateObjects(),
              entry.getCandidateBytes(),
              entry.getRetainedBytes(),
              entry.getObject()));
    }
    return new RetainedRankingResult(
        queryResult.getClassName(),
        queryResult.getClassLoader(),
        instanceLimit,
        safeInt(metadata[0]),
        safeInt(metadata[1]),
        Math.max(0L, metadata[2]),
        metadata[3] != 0,
        metadata[4] != 0,
        metadata[5] != 0,
        safeInt(metadata[6]),
        metadata[7] != 0,
        exact,
        safeInt(metadata[9]),
        Math.max(0L, metadata[10]),
        ranked);
  }

  synchronized ClassRetainedHistogramResult classRetainedHistogram(
      int limit,
      int maximumNodes,
      int maximumEdges,
      String classNameQuery)
      throws Exception {
    if (limit < 1 || limit > MAXIMUM_HISTOGRAM_ROWS) {
      throw new IllegalArgumentException(
          "Class-retained row limit must be between 1 and 200");
    }
    if (maximumNodes < 10_000
        || maximumNodes > MAXIMUM_DOMINATOR_NODES) {
      throw new IllegalArgumentException(
          "Class-retained node limit must be between 10000 and 500000");
    }
    if (maximumEdges < 10_000
        || maximumEdges > MAXIMUM_DOMINATOR_EDGES) {
      throw new IllegalArgumentException(
          "Class-retained edge limit must be between 10000 and 2000000");
    }
    String normalizedQuery =
        classNameQuery == null ? "" : classNameQuery.trim();
    if (normalizedQuery.length() > 256
        || normalizedQuery.indexOf('\r') >= 0
        || normalizedQuery.indexOf('\n') >= 0) {
      throw new IllegalArgumentException(
          "Class-retained query is invalid");
    }
    normalizedQuery = normalizedQuery.toLowerCase(Locale.ROOT);
    ensureLoaded();
    DominatorClassSelection selection =
        selectDominatorClasses();
    long scanPrefix = temporaryTagPrefix();
    long classPrefix;
    do {
      classPrefix = temporaryTagPrefix();
    } while (classPrefix == scanPrefix);
    long[] metadata =
        nativeAccess.collectClassRetainedHistogram(
            selection.classes,
            selection.referenceClassCount,
            maximumNodes,
            maximumEdges,
            scanPrefix,
            classPrefix,
            tagPrefix,
            selection.classSelectionComplete,
            selection.referenceSelectionComplete);
    int expectedLength = 14 + selection.classes.length * 5;
    if (metadata == null
        || metadata.length != expectedLength
        || safeInt(metadata[13]) != selection.classes.length) {
      throw new IllegalStateException(
          "The native class-retained result is invalid");
    }
    boolean exact = metadata[10] != 0;
    List<ClassRetainedRow> rows =
        new ArrayList<ClassRetainedRow>(
            Math.min(
                selection.classes.length,
                MAXIMUM_HISTOGRAM_ROWS));
    long accountedObjects = 0L;
    long accountedShallowBytes = 0L;
    for (int index = 0;
        index < selection.classes.length;
        index++) {
      int offset = 14 + index * 5;
      long instanceCount = Math.max(0L, metadata[offset]);
      long shallowBytes = Math.max(0L, metadata[offset + 1]);
      long candidateRetainedObjects =
          Math.max(0L, metadata[offset + 2]);
      long candidateRetainedBytes =
          Math.max(0L, metadata[offset + 3]);
      long retainedBytes =
          exact ? Math.max(0L, metadata[offset + 4]) : -1L;
      accountedObjects =
          saturatingAdd(accountedObjects, instanceCount);
      accountedShallowBytes =
          saturatingAdd(accountedShallowBytes, shallowBytes);
      if (instanceCount == 0L) {
        continue;
      }
      if (candidateRetainedObjects < instanceCount
          || candidateRetainedBytes < shallowBytes
          || (exact && retainedBytes != candidateRetainedBytes)
          || (!exact && metadata[offset + 4] != -1L)) {
        throw new IllegalStateException(
            "The native class-retained row is inconsistent");
      }
      Class<?> type = selection.classes[index];
      String classLoader = classLoaderName(type);
      if (!normalizedQuery.isEmpty()
          && !type
              .getName()
              .toLowerCase(Locale.ROOT)
              .contains(normalizedQuery)
          && !classLoader
              .toLowerCase(Locale.ROOT)
              .contains(normalizedQuery)) {
        continue;
      }
      rows.add(
          new ClassRetainedRow(
              0,
              type.getName(),
              classLoader,
              instanceCount,
              shallowBytes,
              candidateRetainedObjects,
              candidateRetainedBytes,
              retainedBytes));
    }
    Collections.sort(
        rows,
        new Comparator<ClassRetainedRow>() {
          @Override
          public int compare(
              ClassRetainedRow left,
              ClassRetainedRow right) {
            int retained =
                Long.compare(
                    right.getCandidateRetainedBytes(),
                    left.getCandidateRetainedBytes());
            if (retained != 0) {
              return retained;
            }
            int shallow =
                Long.compare(
                    right.getShallowBytes(),
                    left.getShallowBytes());
            if (shallow != 0) {
              return shallow;
            }
            int count =
                Long.compare(
                    right.getInstanceCount(),
                    left.getInstanceCount());
            if (count != 0) {
              return count;
            }
            return left.getClassName().compareTo(right.getClassName());
          }
        });
    int resultSize = Math.min(limit, rows.size());
    List<ClassRetainedRow> ranked =
        new ArrayList<ClassRetainedRow>(resultSize);
    for (int index = 0; index < resultSize; index++) {
      ClassRetainedRow row = rows.get(index);
      ranked.add(
          new ClassRetainedRow(
              index + 1,
              row.getClassName(),
              row.getClassLoader(),
              row.getInstanceCount(),
              row.getShallowBytes(),
              row.getCandidateRetainedObjects(),
              row.getCandidateRetainedBytes(),
              row.getRetainedBytes()));
    }
    return new ClassRetainedHistogramResult(
        selection.loadedClasses,
        selection.classes.length,
        safeInt(metadata[6]),
        safeInt(metadata[7]),
        safeInt(metadata[0]),
        safeInt(metadata[1]),
        Math.max(0L, metadata[2]),
        metadata[3] != 0,
        metadata[4] != 0,
        metadata[5] != 0,
        metadata[8] != 0,
        metadata[9] != 0,
        exact,
        safeInt(metadata[11]),
        Math.max(0L, metadata[12]),
        accountedObjects,
        accountedShallowBytes,
        ranked);
  }

  synchronized DominatorTreeResult dominatorTree(
      int maximumDepth,
      int maximumViewNodes,
      int rootLimit,
      int branchLimit,
      int maximumNodes,
      int maximumEdges)
      throws Exception {
    if (maximumDepth < 1
        || maximumDepth > MAXIMUM_DOMINATOR_VIEW_DEPTH) {
      throw new IllegalArgumentException(
          "Dominator-tree depth must be between 1 and 8");
    }
    if (maximumViewNodes < 10
        || maximumViewNodes > MAXIMUM_DOMINATOR_VIEW_NODES) {
      throw new IllegalArgumentException(
          "Dominator-tree view nodes must be between 10 and 200");
    }
    if (rootLimit < 1
        || rootLimit > MAXIMUM_DOMINATOR_VIEW_BRANCHES) {
      throw new IllegalArgumentException(
          "Dominator-tree root limit must be between 1 and 20");
    }
    if (branchLimit < 1
        || branchLimit > MAXIMUM_DOMINATOR_VIEW_BRANCHES) {
      throw new IllegalArgumentException(
          "Dominator-tree branch limit must be between 1 and 20");
    }
    if (maximumNodes < 10_000
        || maximumNodes > MAXIMUM_DOMINATOR_NODES) {
      throw new IllegalArgumentException(
          "Dominator-tree graph nodes must be between 10000 and 500000");
    }
    if (maximumEdges < 10_000
        || maximumEdges > MAXIMUM_DOMINATOR_EDGES) {
      throw new IllegalArgumentException(
          "Dominator-tree graph edges must be between 10000 and 2000000");
    }
    ensureLoaded();
    clearHandles();
    DominatorClassSelection selection =
        selectDominatorClasses();
    long scanPrefix = temporaryTagPrefix();
    long classPrefix;
    do {
      classPrefix = temporaryTagPrefix();
    } while (classPrefix == scanPrefix);
    long outputTagBase = allocateTagBlock(maximumViewNodes);
    Object[] packed =
        nativeAccess.collectDominatorTree(
            selection.classes,
            selection.referenceClassCount,
            maximumNodes,
            maximumEdges,
            maximumDepth,
            maximumViewNodes,
            rootLimit,
            branchLimit,
            scanPrefix,
            classPrefix,
            tagPrefix,
            outputTagBase,
            selection.classSelectionComplete,
            selection.referenceSelectionComplete);
    if (packed == null
        || packed.length != 2
        || !(packed[0] instanceof Object[])
        || !(packed[1] instanceof long[])) {
      clearHandles();
      throw new IllegalStateException(
          "The native dominator-tree result is invalid");
    }
    Object[] objects = (Object[]) packed[0];
    long[] metadata = (long[]) packed[1];
    int nodeCount =
        metadata.length >= 14 ? safeInt(metadata[13]) : -1;
    if (metadata.length < 20
        || nodeCount < 0
        || nodeCount > maximumViewNodes
        || objects.length != nodeCount
        || metadata.length != 20 + nodeCount * 10) {
      clearDominatorOutputTags(metadata, outputTagBase, maximumViewNodes);
      clearHandles();
      throw new IllegalStateException(
          "The native dominator-tree metadata is invalid");
    }
    boolean exact = metadata[10] != 0;
    List<DominatorTreeNode> nodes =
        new ArrayList<DominatorTreeNode>(nodeCount);
    try {
      for (int index = 0; index < nodeCount; index++) {
        int offset = 20 + index * 10;
        Object object = objects[index];
        int parentIndex = safeInt(metadata[offset]);
        int depth = safeInt(metadata[offset + 1]);
        long shallowBytes = Math.max(0L, metadata[offset + 2]);
        long retainedObjects = Math.max(0L, metadata[offset + 3]);
        long candidateRetainedBytes =
            Math.max(0L, metadata[offset + 4]);
        long retainedBytes =
            exact ? Math.max(0L, metadata[offset + 5]) : -1L;
        int directChildren = safeInt(metadata[offset + 6]);
        int displayedChildren = safeInt(metadata[offset + 7]);
        long tag = metadata[offset + 8];
        if (object == null
            || parentIndex < -1
            || parentIndex >= index
            || depth < 1
            || depth > maximumDepth
            || (parentIndex == -1
                ? depth != 1
                : depth != nodes.get(parentIndex).getDepth() + 1)
            || shallowBytes < 0L
            || retainedObjects < 1L
            || candidateRetainedBytes < shallowBytes
            || (exact
                ? retainedBytes != candidateRetainedBytes
                : metadata[offset + 5] != -1L)
            || directChildren < displayedChildren
            || displayedChildren < 0
            || !isSessionTag(tag)) {
          throw new IllegalStateException(
              "A native dominator-tree node is inconsistent");
        }
        String handle = registerTaggedObject(tag);
        if (handle.isEmpty()) {
          throw new IllegalStateException(
              "A dominator-tree object handle could not be registered");
        }
        nodes.add(
            new DominatorTreeNode(
                index,
                parentIndex,
                depth,
                shallowBytes,
                retainedObjects,
                candidateRetainedBytes,
                retainedBytes,
                directChildren,
                displayedChildren,
                classLoaderName(object.getClass()),
                describe(object, handle)));
      }
      return new DominatorTreeResult(
          safeInt(metadata[0]),
          safeInt(metadata[1]),
          Math.max(0L, metadata[2]),
          metadata[3] != 0,
          metadata[4] != 0,
          metadata[5] != 0,
          safeInt(metadata[6]),
          safeInt(metadata[7]),
          metadata[8] != 0,
          metadata[9] != 0,
          exact,
          safeInt(metadata[11]),
          Math.max(0L, metadata[12]),
          metadata[18] != 0,
          safeInt(metadata[19]),
          maximumDepth,
          maximumViewNodes,
          rootLimit,
          branchLimit,
          nodes);
    } catch (Exception exception) {
      clearDominatorOutputTags(
          metadata, outputTagBase, maximumViewNodes);
      clearHandles();
      throw exception;
    }
  }

  synchronized HistogramResult histogram(
      int limit, int scanLimit, String classNameQuery) throws Exception {
    if (limit < 1 || limit > MAXIMUM_HISTOGRAM_ROWS) {
      throw new IllegalArgumentException(
          "Heap histogram limit must be between 1 and 200");
    }
    if (scanLimit < 10_000
        || scanLimit > MAXIMUM_HISTOGRAM_OBJECTS) {
      throw new IllegalArgumentException(
          "Heap histogram scan limit must be between 10000 and 5000000");
    }
    ensureLoaded();
    Class<?>[] loadedClasses = instrumentation.getAllLoadedClasses();
    if (loadedClasses == null || loadedClasses.length == 0) {
      throw new IllegalStateException("No loaded classes are available");
    }
    String normalizedQuery =
        classNameQuery == null ? "" : classNameQuery.trim();
    if (normalizedQuery.length() > 256
        || normalizedQuery.indexOf('\r') >= 0
        || normalizedQuery.indexOf('\n') >= 0) {
      throw new IllegalArgumentException(
          "Heap histogram class query is invalid");
    }
    normalizedQuery = normalizedQuery.toLowerCase(Locale.ROOT);
    List<Class<?>> selectedClasses =
        new ArrayList<Class<?>>(
            Math.min(loadedClasses.length, MAXIMUM_HISTOGRAM_CLASSES));
    int matchedClasses = 0;
    for (Class<?> type : loadedClasses) {
      if (type == null
          || (!normalizedQuery.isEmpty()
              && !type
                  .getName()
                  .toLowerCase(Locale.ROOT)
                  .contains(normalizedQuery))) {
        continue;
      }
      matchedClasses++;
      if (selectedClasses.size() < MAXIMUM_HISTOGRAM_CLASSES) {
        selectedClasses.add(type);
      }
    }
    int candidateCount = selectedClasses.size();
    if (candidateCount == 0) {
      return new HistogramResult(
          loadedClasses.length,
          0,
          0,
          0,
          0,
          false,
          false,
          0L,
          0L,
          Collections.<HistogramRow>emptyList());
    }
    Class<?>[] candidates =
        selectedClasses.toArray(new Class<?>[candidateCount]);
    long[] encoded =
        nativeAccess.collectHeapHistogram(
            candidates, scanLimit, temporaryTagPrefix(), tagPrefix);
    int expectedLength = 3 + candidateCount * 2;
    if (encoded == null || encoded.length != expectedLength) {
      throw new IllegalStateException(
          "The native heap histogram result is invalid");
    }
    List<HistogramRow> rows =
        new ArrayList<HistogramRow>(
            Math.min(candidateCount, MAXIMUM_HISTOGRAM_ROWS));
    long accountedObjects = 0L;
    long accountedBytes = 0L;
    for (int index = 0; index < candidateCount; index++) {
      long count = Math.max(0L, encoded[3 + index * 2]);
      long shallowBytes = Math.max(0L, encoded[4 + index * 2]);
      accountedObjects = saturatingAdd(accountedObjects, count);
      accountedBytes = saturatingAdd(accountedBytes, shallowBytes);
      if (count == 0L) {
        continue;
      }
      Class<?> type = candidates[index];
      rows.add(
          new HistogramRow(
              type.getName(),
              classLoaderName(type),
              count,
              shallowBytes));
    }
    Collections.sort(
        rows,
        new Comparator<HistogramRow>() {
          @Override
          public int compare(HistogramRow left, HistogramRow right) {
            int bytes =
                Long.compare(
                    right.getShallowBytes(),
                    left.getShallowBytes());
            if (bytes != 0) {
              return bytes;
            }
            int count =
                Long.compare(
                    right.getInstanceCount(),
                    left.getInstanceCount());
            return count != 0
                ? count
                : left.getClassName().compareTo(right.getClassName());
          }
        });
    List<HistogramRow> limitedRows =
        rows.size() <= limit
            ? rows
            : new ArrayList<HistogramRow>(rows.subList(0, limit));
    return new HistogramResult(
        loadedClasses.length,
        candidateCount,
        rows.size(),
        Math.max(0, safeInt(encoded[2])),
        Math.max(0, safeInt(encoded[0])),
        encoded[1] != 0,
        matchedClasses > candidateCount,
        accountedObjects,
        accountedBytes,
        limitedRows);
  }

  synchronized ThreadPoolResult threadPools(int limit) throws Exception {
    return threadPools(limit, 100);
  }

  synchronized ThreadPoolResult threadPools(int limit, int memberLimit)
      throws Exception {
    return threadPools(limit, memberLimit, false, 100);
  }

  synchronized ThreadPoolResult threadPools(
      int limit,
      int memberLimit,
      boolean includeEvidence,
      int queueTaskLimit)
      throws Exception {
    if (limit < MINIMUM_THREAD_POOLS || limit > MAXIMUM_THREAD_POOLS) {
      throw new IllegalArgumentException(
          "Thread pool limit must be between 3 and 20");
    }
    if (memberLimit < MINIMUM_THREAD_POOL_MEMBERS
        || memberLimit > MAXIMUM_THREAD_POOL_MEMBERS) {
      throw new IllegalArgumentException(
          "Thread pool member limit must be between 10 and 200");
    }
    if (queueTaskLimit < MINIMUM_THREAD_POOL_QUEUE_TASKS
        || queueTaskLimit > MAXIMUM_THREAD_POOL_QUEUE_TASKS) {
      throw new IllegalArgumentException(
          "Thread pool queue-task limit must be between 10 and 200");
    }
    ensureLoaded();
    Class<?>[] supportedTypes = {
      ThreadPoolExecutor.class,
      java.util.concurrent.ScheduledThreadPoolExecutor.class,
      ForkJoinPool.class
    };
    List<List<Object>> poolsByType =
        new ArrayList<List<Object>>(supportedTypes.length);
    Set<Object> seen =
        Collections.newSetFromMap(
            new IdentityHashMap<Object, Boolean>());
    boolean truncated = false;
    int queriedTypes = 0;
    for (int typeIndex = 0;
        typeIndex < supportedTypes.length;
        typeIndex++) {
      Class<?> type = supportedTypes[typeIndex];
      List<Object> typeObjects = new ArrayList<Object>(limit);
      poolsByType.add(typeObjects);
      long temporaryPrefix = temporaryTagPrefix();
      long tagBase = temporaryPrefix | 1_024L;
      Object[] objects = null;
      try {
        objects =
            nativeAccess.collectInstances(type, limit, tagBase);
        queriedTypes++;
        if (objects == null) {
          continue;
        }
        if (objects.length >= limit) {
          truncated = true;
        }
        for (Object object : objects) {
          if (object == null
              || object.getClass() != type
              || !seen.add(object)) {
            continue;
          }
          typeObjects.add(object);
        }
      } finally {
        clearTemporaryTags(objects, temporaryPrefix);
      }
    }
    List<Object> poolObjects = new ArrayList<Object>(limit);
    for (int typeOffset = 0;
        poolObjects.size() < limit;
        typeOffset++) {
      boolean added = false;
      for (List<Object> typeObjects : poolsByType) {
        if (typeOffset < typeObjects.size()) {
          poolObjects.add(typeObjects.get(typeOffset));
          added = true;
          if (poolObjects.size() >= limit) {
            break;
          }
        }
      }
      if (!added) {
        break;
      }
    }
    ThreadEnumeration threadEnumeration = enumerateThreads();
    List<ThreadPoolRow> pools =
        new ArrayList<ThreadPoolRow>(poolObjects.size());
    int discoveredMembers = 0;
    int returnedMembers = 0;
    for (int index = 0; index < poolObjects.size(); index++) {
      int baseQuota =
          poolObjects.isEmpty() ? 0 : memberLimit / poolObjects.size();
      int extraQuota =
          poolObjects.isEmpty() ? 0 : memberLimit % poolObjects.size();
      int poolMemberLimit = baseQuota + (index < extraQuota ? 1 : 0);
      ThreadPoolMembership membership =
          inspectThreadPoolMembership(
              poolObjects.get(index),
              threadEnumeration,
              poolMemberLimit,
              includeEvidence);
      int queueBaseQuota =
          poolObjects.isEmpty() ? 0 : queueTaskLimit / poolObjects.size();
      int queueExtraQuota =
          poolObjects.isEmpty() ? 0 : queueTaskLimit % poolObjects.size();
      int poolQueueTaskLimit =
          queueBaseQuota + (index < queueExtraQuota ? 1 : 0);
      discoveredMembers =
          safeInt(saturatingAdd(discoveredMembers, membership.memberCount));
      returnedMembers =
          safeInt(
              saturatingAdd(returnedMembers, membership.members.size()));
      pools.add(
          describeThreadPool(
              poolObjects.get(index),
              membership,
              includeEvidence,
              poolQueueTaskLimit));
    }
    return new ThreadPoolResult(
        queriedTypes,
        limit,
        memberLimit,
        truncated,
        threadEnumeration.scanned,
        threadEnumeration.truncated,
        discoveredMembers,
        returnedMembers,
        pools);
  }

  synchronized Object resolveExactThreadPool(
      String identity, String className) throws Exception {
    if (identity == null || identity.isEmpty() || className == null) {
      throw new IllegalArgumentException(
          "Thread-pool identity and class are required");
    }
    Class<?> poolType;
    if (ThreadPoolExecutor.class.getName().equals(className)) {
      poolType = ThreadPoolExecutor.class;
    } else if (ScheduledThreadPoolExecutor.class.getName().equals(className)) {
      poolType = ScheduledThreadPoolExecutor.class;
    } else if (ForkJoinPool.class.getName().equals(className)) {
      poolType = ForkJoinPool.class;
    } else {
      throw new IllegalArgumentException(
          "Execution attribution supports exact ThreadPoolExecutor, ScheduledThreadPoolExecutor, and ForkJoinPool instances only");
    }
    String identityPrefix = poolType.getSimpleName() + "@";
    if (!identity.matches("^" + identityPrefix + "[0-9a-f]+$")) {
      throw new IllegalArgumentException(
          "Thread-pool identity is invalid");
    }
    ensureLoaded();
    long temporaryPrefix = temporaryTagPrefix();
    long tagBase = temporaryPrefix | 1_024L;
    Object[] objects = null;
    try {
      objects =
          nativeAccess.collectInstances(
              poolType,
              MAXIMUM_THREAD_POOLS,
              tagBase);
      if (objects == null) {
        throw new IllegalStateException(
            "Thread-pool instance scan returned no result");
      }
      for (Object object : objects) {
        if (object == null || object.getClass() != poolType) {
          continue;
        }
        String candidateIdentity =
            identityPrefix
                + Integer.toHexString(System.identityHashCode(object));
        if (identity.equals(candidateIdentity)) {
          return object;
        }
      }
      throw new IllegalStateException(
          "The exact thread pool is no longer available or exceeds the scan limit");
    } finally {
      clearTemporaryTags(objects, temporaryPrefix);
    }
  }

  private void clearTemporaryTags(
      Object[] objects, long temporaryPrefix) {
    if (objects == null) {
      return;
    }
    for (Object object : objects) {
      if (object == null) {
        continue;
      }
      try {
        long tag = nativeAccess.objectTag(object);
        if (tag > 0
            && (tag & TAG_PREFIX_MASK) == temporaryPrefix) {
          clearTagBestEffort(tag);
        }
      } catch (Exception ignored) {
        // Best-effort cleanup continues for all other returned objects.
      }
    }
  }

  private ThreadPoolMembership inspectThreadPoolMembership(
      Object object,
      ThreadEnumeration enumeration,
      int limit,
      boolean includeEvidence) {
    if (object.getClass() == ForkJoinPool.class) {
      List<Thread> matching = new ArrayList<Thread>();
      for (Thread thread : enumeration.threads) {
        if (thread instanceof ForkJoinWorkerThread
            && ((ForkJoinWorkerThread) thread).getPool() == object) {
          matching.add(thread);
        }
      }
      return membership(
          matching,
          limit,
          true,
          enumeration.truncated,
          enumeration.issue,
          includeEvidence);
    }
    try {
      ensureThreadPoolPackageOpen();
      Field mainLockField =
          ThreadPoolExecutor.class.getDeclaredField("mainLock");
      Field workersField =
          ThreadPoolExecutor.class.getDeclaredField("workers");
      mainLockField.setAccessible(true);
      workersField.setAccessible(true);
      ReentrantLock mainLock = (ReentrantLock) mainLockField.get(object);
      if (mainLock == null) {
        return membershipUnavailable("MAIN_LOCK_UNAVAILABLE");
      }
      List<Thread> matching = new ArrayList<Thread>();
      mainLock.lock();
      try {
        Object workersObject = workersField.get(object);
        if (!(workersObject instanceof Collection<?>)) {
          return membershipUnavailable("WORKER_SET_UNAVAILABLE");
        }
        for (Object worker : (Collection<?>) workersObject) {
          if (worker == null) {
            continue;
          }
          Field threadField = worker.getClass().getDeclaredField("thread");
          threadField.setAccessible(true);
          Object thread = threadField.get(worker);
          if (thread instanceof Thread) {
            matching.add((Thread) thread);
          }
        }
      } finally {
        mainLock.unlock();
      }
      return membership(
          matching, limit, true, false, "", includeEvidence);
    } catch (ReflectiveOperationException | RuntimeException exception) {
      return membershipUnavailable("JDK_WORKER_ACCESS_UNAVAILABLE");
    }
  }

  private static ThreadPoolMembership membership(
      List<Thread> matching,
      int limit,
      boolean available,
      boolean sourceTruncated,
      String issue,
      boolean includeEvidence) {
    matching.sort(
        new Comparator<Thread>() {
          @Override
          public int compare(Thread left, Thread right) {
            int byId = Long.compare(left.getId(), right.getId());
            return byId != 0 ? byId : left.getName().compareTo(right.getName());
          }
        });
    int returned = Math.min(Math.max(0, limit), matching.size());
    List<ThreadPoolMember> members =
        new ArrayList<ThreadPoolMember>(returned);
    for (int index = 0; index < returned; index++) {
      members.add(
          describeThreadPoolMember(
              matching.get(index), includeEvidence));
    }
    return new ThreadPoolMembership(
        available,
        issue,
        matching.size(),
        sourceTruncated || matching.size() > returned,
        members);
  }

  private static ThreadPoolMembership membershipUnavailable(String issue) {
    return new ThreadPoolMembership(
        false,
        issue,
        0,
        false,
        Collections.<ThreadPoolMember>emptyList());
  }

  static ThreadPoolMember describeThreadPoolMember(Thread thread) {
    return describeThreadPoolMember(thread, false);
  }

  static ThreadPoolMember describeThreadPoolMember(
      Thread thread, boolean includeEvidence) {
    ThreadGroup group = thread.getThreadGroup();
    Thread.State state = thread.getState();
    String topFrame = "";
    String applicationFrame = "";
    String blockerType = "";
    if (includeEvidence) {
      StackTraceElement[] stack = thread.getStackTrace();
      for (StackTraceElement frame : stack) {
        if (topFrame.isEmpty()
            && !(Thread.class.getName().equals(frame.getClassName())
                && "getStackTrace".equals(frame.getMethodName()))) {
          topFrame = boundedStackFrame(frame);
        }
        if (applicationFrame.isEmpty()
            && !isPlatformOrAgentFrame(frame.getClassName())) {
          applicationFrame = boundedStackFrame(frame);
        }
        if (!topFrame.isEmpty() && !applicationFrame.isEmpty()) {
          break;
        }
      }
      Object blocker = LockSupport.getBlocker(thread);
      blockerType =
          blocker == null
              ? ""
              : boundedEvidenceText(blocker.getClass().getName());
    }
    return new ThreadPoolMember(
        thread.getId(),
        thread.getName(),
        group == null ? "" : group.getName(),
        state == null ? "UNKNOWN" : state.name(),
        thread.isDaemon(),
        thread.getPriority(),
        topFrame,
        applicationFrame,
        blockerType);
  }

  private static String boundedStackFrame(StackTraceElement frame) {
    String value =
        frame.getClassName()
            + "#"
            + frame.getMethodName()
            + "("
            + (frame.getFileName() == null ? "Unknown Source" : frame.getFileName())
            + (frame.getLineNumber() >= 0 ? ":" + frame.getLineNumber() : "")
            + ")";
    return boundedEvidenceText(value);
  }

  private static String boundedEvidenceText(String value) {
    return value.length() <= MAXIMUM_VALUE_LENGTH
        ? value
        : value.substring(0, MAXIMUM_VALUE_LENGTH);
  }

  private static boolean isPlatformOrAgentFrame(String className) {
    return className.startsWith("java.")
        || className.startsWith("javax.")
        || className.startsWith("jdk.")
        || className.startsWith("sun.")
        || className.startsWith("com.sun.")
        || className.startsWith("dev.tanwei.agent.")
        || className.startsWith("dev.tanwei.bootstrap.");
  }

  private static ThreadEnumeration enumerateThreads() {
    try {
      ThreadGroup root = Thread.currentThread().getThreadGroup();
      while (root != null && root.getParent() != null) {
        root = root.getParent();
      }
      if (root == null) {
        return new ThreadEnumeration(
            Collections.<Thread>emptyList(), 0, false, "THREAD_GROUP_UNAVAILABLE");
      }
      int estimate = Math.max(0, root.activeCount());
      int capacity =
          Math.min(
              MAXIMUM_THREAD_ENUMERATION,
              Math.max(64, estimate + estimate / 2 + 16));
      Thread[] candidates = new Thread[capacity];
      int discovered = root.enumerate(candidates, true);
      int scanned = Math.min(discovered, candidates.length);
      List<Thread> threads = new ArrayList<Thread>(scanned);
      for (int index = 0; index < scanned; index++) {
        Thread thread = candidates[index];
        if (thread != null) {
          threads.add(thread);
        }
      }
      boolean truncated = discovered >= candidates.length;
      return new ThreadEnumeration(
          threads,
          threads.size(),
          truncated,
          truncated ? "THREAD_ENUMERATION_TRUNCATED" : "");
    } catch (RuntimeException exception) {
      return new ThreadEnumeration(
          Collections.<Thread>emptyList(),
          0,
          false,
          "THREAD_ENUMERATION_UNAVAILABLE");
    }
  }

  private void ensureThreadPoolPackageOpen()
      throws ReflectiveOperationException {
    if (threadPoolPackageOpened) {
      return;
    }
    Method getModule;
    try {
      getModule = Class.class.getMethod("getModule");
    } catch (NoSuchMethodException javaEight) {
      threadPoolPackageOpened = true;
      return;
    }
    Object sourceModule = getModule.invoke(ThreadPoolExecutor.class);
    Object targetModule = getModule.invoke(HeapInstanceController.class);
    Method redefineModule = null;
    for (Method candidate : Instrumentation.class.getMethods()) {
      if ("redefineModule".equals(candidate.getName())
          && candidate.getParameterTypes().length == 6) {
        redefineModule = candidate;
        break;
      }
    }
    if (redefineModule == null) {
      throw new IllegalStateException("Instrumentation cannot open JDK modules");
    }
    Set<Object> target = Collections.singleton(targetModule);
    Map<String, Set<Object>> exports =
        new HashMap<String, Set<Object>>();
    exports.put("java.util.concurrent", target);
    Map<String, Set<Object>> opens =
        new HashMap<String, Set<Object>>();
    opens.put("java.util.concurrent", target);
    redefineModule.invoke(
        instrumentation,
        sourceModule,
        Collections.emptySet(),
        exports,
        opens,
        Collections.emptySet(),
        Collections.emptyMap());
    threadPoolPackageOpened = true;
  }

  private static ThreadPoolRow describeThreadPool(
      Object object,
      ThreadPoolMembership membership,
      boolean includeEvidence,
      int queueTaskLimit) {
    String identity =
        object.getClass().getSimpleName()
            + "@"
            + Integer.toHexString(System.identityHashCode(object));
    if (object.getClass() == ForkJoinPool.class) {
      ForkJoinPool pool = (ForkJoinPool) object;
      return new ThreadPoolRow(
          "FORK_JOIN",
          object.getClass().getName(),
          identity,
          poolState(pool),
          pool.getParallelism(),
          pool.getPoolSize(),
          pool.getActiveThreadCount(),
          -1L,
          -1L,
          -1L,
          pool.getQueuedTaskCount(),
          -1L,
          "",
          pool.getQueuedSubmissionCount(),
          pool.getRunningThreadCount(),
          pool.getStealCount(),
          threadFactoryType(object),
          "",
          queueEvidenceUnavailable(
              includeEvidence
                  ? "FORK_JOIN_TASK_TYPES_UNAVAILABLE"
                  : "NOT_REQUESTED"),
          membership);
    }
    ThreadPoolExecutor pool = (ThreadPoolExecutor) object;
    BlockingQueue<Runnable> queue = pool.getQueue();
    long queuedTasks = -1L;
    long remainingQueueCapacity = -1L;
    String queueType = queue == null ? "" : queue.getClass().getName();
    if (isSafeJdkQueue(queueType)) {
      try {
        queuedTasks = Math.max(0, queue.size());
        remainingQueueCapacity =
            Math.max(0, queue.remainingCapacity());
      } catch (RuntimeException ignored) {
        queuedTasks = -1L;
        remainingQueueCapacity = -1L;
      }
    }
    Object rejectionHandler = pool.getRejectedExecutionHandler();
    String rejectionHandlerType =
        rejectionHandler == null
            ? ""
            : boundedEvidenceText(rejectionHandler.getClass().getName());
    ThreadPoolQueueEvidence queueEvidence =
        inspectThreadPoolQueue(
            queue,
            queueType,
            queuedTasks,
            includeEvidence,
            queueTaskLimit);
    return new ThreadPoolRow(
        object.getClass()
                == java.util.concurrent.ScheduledThreadPoolExecutor.class
            ? "SCHEDULED"
            : "THREAD_POOL",
        object.getClass().getName(),
        identity,
        poolState(pool),
        pool.getCorePoolSize(),
        pool.getPoolSize(),
        pool.getActiveCount(),
        pool.getMaximumPoolSize(),
        pool.getLargestPoolSize(),
        pool.getCompletedTaskCount(),
        queuedTasks,
        remainingQueueCapacity,
        queueType,
        -1L,
        -1L,
        -1L,
        threadFactoryType(object),
        rejectionHandlerType,
        queueEvidence,
        membership);
  }

  private static ThreadPoolQueueEvidence inspectThreadPoolQueue(
      BlockingQueue<Runnable> queue,
      String queueType,
      long knownQueueSize,
      boolean includeEvidence,
      int limit) {
    if (!includeEvidence) {
      return queueEvidenceUnavailable("NOT_REQUESTED");
    }
    if (limit <= 0) {
      return queueEvidenceUnavailable("EVIDENCE_BUDGET_EXHAUSTED");
    }
    if (queue == null) {
      return queueEvidenceUnavailable("QUEUE_UNAVAILABLE");
    }
    if (!isSafeJdkQueue(queueType)) {
      return queueEvidenceUnavailable("CUSTOM_QUEUE_NOT_INSPECTED");
    }
    try {
      Map<String, Integer> counts = new TreeMap<String, Integer>();
      Iterator<Runnable> iterator = queue.iterator();
      int scanned = 0;
      while (iterator.hasNext() && scanned < limit) {
        Runnable task = iterator.next();
        scanned++;
        String taskType =
            task == null
                ? "<null>"
                : boundedEvidenceText(task.getClass().getName());
        Integer previous = counts.get(taskType);
        counts.put(taskType, previous == null ? 1 : previous + 1);
      }
      boolean truncated =
          iterator.hasNext()
              || (knownQueueSize >= 0L && knownQueueSize > scanned);
      List<ThreadPoolTaskType> taskTypes =
          new ArrayList<ThreadPoolTaskType>(counts.size());
      for (Map.Entry<String, Integer> entry : counts.entrySet()) {
        taskTypes.add(
            new ThreadPoolTaskType(entry.getKey(), entry.getValue()));
      }
      return new ThreadPoolQueueEvidence(
          true, "", scanned, truncated, taskTypes);
    } catch (RuntimeException exception) {
      return queueEvidenceUnavailable("QUEUE_ITERATION_FAILED");
    }
  }

  private static ThreadPoolQueueEvidence queueEvidenceUnavailable(
      String issue) {
    return new ThreadPoolQueueEvidence(
        false,
        issue,
        0,
        false,
        Collections.<ThreadPoolTaskType>emptyList());
  }

  private static String threadFactoryType(Object object) {
    Object factory =
        object.getClass() == ForkJoinPool.class
            ? ((ForkJoinPool) object).getFactory()
            : ((ThreadPoolExecutor) object).getThreadFactory();
    return factory == null ? "" : factory.getClass().getName();
  }

  private static boolean isSafeJdkQueue(String className) {
    return "java.util.concurrent.ArrayBlockingQueue".equals(className)
        || "java.util.concurrent.DelayQueue".equals(className)
        || "java.util.concurrent.LinkedBlockingQueue".equals(className)
        || "java.util.concurrent.LinkedTransferQueue".equals(className)
        || "java.util.concurrent.PriorityBlockingQueue".equals(className)
        || "java.util.concurrent.SynchronousQueue".equals(className)
        || "java.util.concurrent.ScheduledThreadPoolExecutor$DelayedWorkQueue"
            .equals(className);
  }

  private static String poolState(ThreadPoolExecutor pool) {
    if (pool.isTerminated()) {
      return "TERMINATED";
    }
    if (pool.isTerminating()) {
      return "TERMINATING";
    }
    return pool.isShutdown() ? "SHUTDOWN" : "RUNNING";
  }

  private static String poolState(ForkJoinPool pool) {
    if (pool.isTerminated()) {
      return "TERMINATED";
    }
    if (pool.isTerminating()) {
      return "TERMINATING";
    }
    if (pool.isShutdown()) {
      return "SHUTDOWN";
    }
    return pool.isQuiescent() ? "QUIESCENT" : "RUNNING";
  }

  private static long saturatingAdd(long left, long right) {
    if (right <= 0L) {
      return left;
    }
    return left > Long.MAX_VALUE - right
        ? Long.MAX_VALUE
        : left + right;
  }

  private long temporaryTagPrefix() {
    long prefix;
    do {
      prefix =
          ((long) (secureRandom.nextInt(0x7FFE) + 1))
              << TAG_PREFIX_SHIFT;
    } while (prefix == tagPrefix);
    return prefix;
  }

  private ReferenceClassSelection selectReferenceClasses() {
    List<Class<?>> classes =
        new ArrayList<Class<?>>(MAXIMUM_REFERENCE_CLASSES);
    Set<Class<?>> seen =
        Collections.newSetFromMap(
            new IdentityHashMap<Class<?>, Boolean>());
    classes.add(Reference.class);
    seen.add(Reference.class);
    boolean complete = true;
    Class<?>[] loadedClasses = instrumentation.getAllLoadedClasses();
    if (loadedClasses == null) {
      complete = false;
    } else {
      for (Class<?> type : loadedClasses) {
        if (type == null
            || !Reference.class.isAssignableFrom(type)
            || !seen.add(type)) {
          continue;
        }
        if (classes.size() >= MAXIMUM_REFERENCE_CLASSES) {
          complete = false;
          continue;
        }
        classes.add(type);
      }
    }
    return new ReferenceClassSelection(
        classes.toArray(new Class<?>[classes.size()]), complete);
  }

  private DominatorClassSelection selectDominatorClasses() {
    Class<?>[] loadedClasses = instrumentation.getAllLoadedClasses();
    if (loadedClasses == null || loadedClasses.length == 0) {
      throw new IllegalStateException(
          "No loaded classes are available for retained analysis");
    }
    Set<Class<?>> seen =
        Collections.newSetFromMap(
            new IdentityHashMap<Class<?>, Boolean>());
    List<Class<?>> referenceClasses =
        new ArrayList<Class<?>>();
    List<Class<?>> otherClasses =
        new ArrayList<Class<?>>(
            Math.min(
                loadedClasses.length,
                MAXIMUM_HISTOGRAM_CLASSES));
    referenceClasses.add(Reference.class);
    seen.add(Reference.class);
    for (Class<?> type : loadedClasses) {
      if (type == null || !seen.add(type)) {
        continue;
      }
      if (Reference.class.isAssignableFrom(type)) {
        referenceClasses.add(type);
      } else {
        otherClasses.add(type);
      }
    }
    List<Class<?>> selected =
        new ArrayList<Class<?>>(
            Math.min(
                seen.size(),
                MAXIMUM_HISTOGRAM_CLASSES));
    for (Class<?> type : referenceClasses) {
      if (selected.size() >= MAXIMUM_HISTOGRAM_CLASSES) {
        break;
      }
      selected.add(type);
    }
    int referenceClassCount = selected.size();
    for (Class<?> type : otherClasses) {
      if (selected.size() >= MAXIMUM_HISTOGRAM_CLASSES) {
        break;
      }
      selected.add(type);
    }
    boolean referenceSelectionComplete =
        referenceClassCount == referenceClasses.size();
    boolean classSelectionComplete =
        referenceSelectionComplete
            && selected.size() == seen.size();
    return new DominatorClassSelection(
        loadedClasses.length,
        selected.toArray(new Class<?>[selected.size()]),
        referenceClassCount,
        classSelectionComplete,
        referenceSelectionComplete);
  }

  private void ensureLoaded() throws Exception {
    if (loaded) {
      return;
    }
    if (!unavailableReason.isEmpty()) {
      throw new UnsupportedOperationException(unavailableReason);
    }
    String resource = resourcePath();
    if (resource == null) {
      unavailableReason =
          "No JVMTI heap query library is packaged for this OS and architecture";
      throw new UnsupportedOperationException(unavailableReason);
    }
    String suffix =
        resource.endsWith(".dll")
            ? ".dll"
            : resource.endsWith(".dylib") ? ".dylib" : ".so";
    Path library = Files.createTempFile("tanwei-heap-query-", suffix);
    try (InputStream input =
        HeapInstanceController.class.getResourceAsStream(resource)) {
      if (input == null) {
        throw new IllegalStateException(
            "Packaged JVMTI heap query library is missing");
      }
      Files.copy(input, library, StandardCopyOption.REPLACE_EXISTING);
      restrictPermissions(library);
      System.load(library.toAbsolutePath().normalize().toString());
      extractedLibrary = library;
      library.toFile().deleteOnExit();
      loaded = true;
    } catch (Throwable failure) {
      try {
        Files.deleteIfExists(library);
      } catch (Exception ignored) {
        // The load error remains authoritative.
      }
      unavailableReason =
          failure.getMessage() == null
              ? failure.getClass().getName()
              : failure.getMessage();
      if (failure instanceof Exception) {
        throw (Exception) failure;
      }
      throw new IllegalStateException(unavailableReason, failure);
    }
  }

  private Class<?> findClass(String name, String classLoader) {
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals(name)
          && classLoaderName(type).equals(classLoader)) {
        return type;
      }
    }
    return null;
  }

  private static String classLoaderName(Class<?> type) {
    ClassLoader loader = type.getClassLoader();
    return loader == null ? "bootstrap" : loader.toString();
  }

  private RelationCollection collectOutgoing(
      Object target, int limit, int scanLimit) {
    List<Relation> relations = new ArrayList<Relation>(limit);
    int scanned = 0;
    boolean truncated = false;
    Class<?> type = target.getClass();
    if (type.isArray()) {
      if (type.getComponentType().isPrimitive()) {
        return new RelationCollection(0, false, relations);
      }
      int length = Array.getLength(target);
      int maximum = Math.min(length, scanLimit);
      for (int index = 0; index < maximum; index++) {
        scanned++;
        Object value = Array.get(target, index);
        if (value != null) {
          relations.add(
              relation(
                  "[" + index + "]",
                  "ARRAY_ELEMENT",
                  index,
                  value));
          if (relations.size() >= limit) {
            truncated = index + 1 < length;
            break;
          }
        }
      }
      truncated = truncated || length > maximum;
      return new RelationCollection(scanned, truncated, relations);
    }

    Class<?> current = type;
    outer:
    while (current != null && current != Object.class) {
      for (Field field : current.getDeclaredFields()) {
        if (Modifier.isStatic(field.getModifiers())
            || field.getType().isPrimitive()) {
          continue;
        }
        if (scanned >= scanLimit) {
          truncated = true;
          break outer;
        }
        scanned++;
        boolean accessible = field.isAccessible();
        try {
          if (!accessible) {
            field.setAccessible(true);
          }
          Object value = field.get(target);
          if (value != null) {
            relations.add(
                relation(
                    current.getSimpleName() + "." + field.getName(),
                    "FIELD",
                    -1,
                    value));
            if (relations.size() >= limit) {
              truncated = true;
              break outer;
            }
          }
        } catch (Throwable ignored) {
          // Strongly encapsulated or racing fields are omitted safely.
        } finally {
          if (!accessible) {
            try {
              field.setAccessible(false);
            } catch (Throwable ignored) {
              // Access restoration is best-effort.
            }
          }
        }
      }
      current = current.getSuperclass();
    }
    return new RelationCollection(scanned, truncated, relations);
  }

  private RelationCollection collectIncoming(
      Object target, int limit, int scanLimit) throws Exception {
    long tagBase = allocateTagBlock(limit);
    long[] encoded =
        nativeAccess.collectReferrerEdges(
            target,
            limit,
            scanLimit,
            tagBase,
            tagPrefix);
    if (encoded == null || encoded.length < 2) {
      return new RelationCollection(0, false, Collections.<Relation>emptyList());
    }
    long scanned = Math.max(0L, encoded[0]);
    boolean truncated = encoded[1] != 0;
    int count = Math.min(limit, (encoded.length - 2) / 3);
    List<Relation> relations = new ArrayList<Relation>(count);
    for (int index = 0; index < count; index++) {
      int offset = 2 + index * 3;
      long tag = encoded[offset];
      if (!isSessionTag(tag)) {
        continue;
      }
      Object referrer = nativeAccess.resolveTaggedObject(tag);
      if (referrer == null) {
        continue;
      }
      String handle = registerTaggedObject(tag);
      if (handle.isEmpty()) {
        continue;
      }
      int kind = safeInt(encoded[offset + 1]);
      int referenceIndex = safeInt(encoded[offset + 2]);
      relations.add(
          new Relation(
              referenceLabel(kind, referenceIndex),
              referenceKind(kind),
              referenceIndex,
              describe(referrer, handle)));
    }
    return new RelationCollection(
        (int) Math.min((long) Integer.MAX_VALUE, scanned),
        truncated,
        relations);
  }

  private ObjectGraphResult collectOutgoingGraph(
      Object target,
      String objectHandle,
      int maximumDepth,
      int maximumNodes,
      int maximumEdgesPerNode,
      int scanLimit) {
    List<GraphNode> nodes = new ArrayList<GraphNode>(maximumNodes);
    List<Object> objects = new ArrayList<Object>(maximumNodes);
    List<GraphEdge> edges =
        new ArrayList<GraphEdge>(
            Math.min(
                maximumNodes * maximumEdgesPerNode,
                MAXIMUM_GRAPH_NODES
                    * MAXIMUM_GRAPH_EDGES_PER_NODE));
    Map<String, Integer> nodeIndexes =
        new HashMap<String, Integer>(maximumNodes * 2);
    Set<String> edgeKeys =
        new HashSet<String>(
            Math.min(
                maximumNodes * maximumEdgesPerNode * 2,
                MAXIMUM_GRAPH_NODES
                    * MAXIMUM_GRAPH_EDGES_PER_NODE
                    * 2));
    Instance root = describe(target, objectHandle);
    nodes.add(new GraphNode(0, 0, root));
    objects.add(target);
    nodeIndexes.put(graphNodeKey(root), Integer.valueOf(0));

    int scannedEdges = 0;
    boolean scanLimitReached = false;
    boolean nodeLimitReached = false;
    boolean depthLimitReached = false;
    boolean branchLimitReached = false;
    for (int cursor = 0; cursor < nodes.size(); cursor++) {
      GraphNode sourceNode = nodes.get(cursor);
      Object source = objects.get(cursor);
      if (source == null || !sourceNode.getObject().isNavigable()) {
        continue;
      }
      if (sourceNode.getDepth() >= maximumDepth) {
        depthLimitReached = true;
        continue;
      }
      int remainingScan = scanLimit - scannedEdges;
      if (remainingScan <= 0) {
        scanLimitReached = true;
        break;
      }
      RelationCollection collection =
          collectOutgoing(
              source,
              maximumEdgesPerNode,
              remainingScan);
      scannedEdges =
          Math.min(
              scanLimit,
              scannedEdges + Math.max(0, collection.scanned));
      if (collection.truncated) {
        if (scannedEdges >= scanLimit) {
          scanLimitReached = true;
        } else {
          branchLimitReached = true;
        }
      }
      for (Relation relation : collection.relations) {
        Instance relatedObject = relation.getTarget();
        String nodeKey = graphNodeKey(relatedObject);
        Integer targetIndex = nodeIndexes.get(nodeKey);
        if (targetIndex == null) {
          if (nodes.size() >= maximumNodes) {
            nodeLimitReached = true;
            continue;
          }
          int nextIndex = nodes.size();
          targetIndex = Integer.valueOf(nextIndex);
          nodes.add(
              new GraphNode(
                  nextIndex,
                  sourceNode.getDepth() + 1,
                  relatedObject));
          objects.add(resolveGraphObjectBestEffort(relatedObject));
          nodeIndexes.put(nodeKey, targetIndex);
        }
        String edgeKey =
            cursor
                + ":"
                + targetIndex.intValue()
                + ":"
                + relation.getKind()
                + ":"
                + relation.getIndex()
                + ":"
                + relation.getLabel();
        if (edgeKeys.add(edgeKey)) {
          edges.add(
              new GraphEdge(
                  cursor,
                  targetIndex.intValue(),
                  relation.getLabel(),
                  relation.getKind(),
                  relation.getIndex()));
        }
      }
      if (scanLimitReached) {
        break;
      }
    }
    boolean truncated =
        scanLimitReached
            || nodeLimitReached
            || depthLimitReached
            || branchLimitReached;
    return new ObjectGraphResult(
        root,
        "OUTGOING",
        scannedEdges,
        0,
        0L,
        truncated,
        nodeLimitReached,
        depthLimitReached,
        branchLimitReached,
        nodes,
        edges);
  }

  private ObjectGraphResult collectIncomingGraph(
      String objectHandle,
      int maximumDepth,
      int maximumNodes,
      int maximumEdgesPerNode,
      int scanLimit)
      throws Exception {
    RootPathsResult rootPaths =
        rootPaths(
            objectHandle,
            maximumEdgesPerNode,
            maximumDepth,
            MAXIMUM_ROOT_NODES,
            scanLimit);
    RootPath firstPath = rootPaths.getPaths().get(0);
    if (firstPath.getNodes().isEmpty()) {
      throw new IllegalStateException(
          "The incoming object graph has no root node");
    }
    Instance root = firstPath.getNodes().get(0).getObject();
    List<GraphNode> nodes = new ArrayList<GraphNode>(maximumNodes);
    List<GraphEdge> edges =
        new ArrayList<GraphEdge>(
            maximumEdgesPerNode * (maximumDepth + 1));
    Map<String, Integer> nodeIndexes =
        new HashMap<String, Integer>(maximumNodes * 2);
    Set<String> edgeKeys =
        new HashSet<String>(
            maximumEdgesPerNode * (maximumDepth + 1) * 2);
    nodes.add(new GraphNode(0, 0, root));
    nodeIndexes.put(graphNodeKey(root), Integer.valueOf(0));

    boolean nodeLimitReached = false;
    boolean depthLimitReached = false;
    for (RootPath path : rootPaths.getPaths()) {
      List<RootPathNode> pathNodes = path.getNodes();
      if (!path.isRootReached()
          && pathNodes.size() >= maximumDepth + 1) {
        depthLimitReached = true;
      }
      for (int nodeIndex = 0;
          nodeIndex + 1 < pathNodes.size();
          nodeIndex++) {
        RootPathNode sourcePathNode = pathNodes.get(nodeIndex);
        RootPathNode targetPathNode = pathNodes.get(nodeIndex + 1);
        Integer sourceIndex =
            nodeIndexes.get(
                graphNodeKey(sourcePathNode.getObject()));
        if (sourceIndex == null) {
          continue;
        }
        String targetKey = graphNodeKey(targetPathNode.getObject());
        Integer targetIndex = nodeIndexes.get(targetKey);
        if (targetIndex == null) {
          if (nodes.size() >= maximumNodes) {
            nodeLimitReached = true;
            continue;
          }
          int nextIndex = nodes.size();
          targetIndex = Integer.valueOf(nextIndex);
          nodes.add(
              new GraphNode(
                  nextIndex,
                  nodeIndex + 1,
                  targetPathNode.getObject()));
          nodeIndexes.put(targetKey, targetIndex);
        }
        String edgeKey =
            sourceIndex.intValue()
                + ":"
                + targetIndex.intValue()
                + ":"
                + sourcePathNode.getRelationKind()
                + ":"
                + sourcePathNode.getRelationIndex()
                + ":"
                + sourcePathNode.getRelationLabel();
        if (edgeKeys.add(edgeKey)) {
          edges.add(
              new GraphEdge(
                  sourceIndex.intValue(),
                  targetIndex.intValue(),
                  sourcePathNode.getRelationLabel(),
                  sourcePathNode.getRelationKind(),
                  sourcePathNode.getRelationIndex()));
        }
      }
    }
    boolean branchLimitReached = rootPaths.isPathLimitReached();
    boolean truncated =
        rootPaths.isTruncated()
            || nodeLimitReached
            || depthLimitReached
            || branchLimitReached;
    return new ObjectGraphResult(
        root,
        "INCOMING",
        rootPaths.getScannedEdges(),
        rootPaths.getTaggedObjects(),
        rootPaths.getTagConflicts(),
        truncated,
        nodeLimitReached,
        depthLimitReached,
        branchLimitReached,
        nodes,
        edges);
  }

  private Object resolveGraphObjectBestEffort(Instance instance) {
    if (instance == null || !instance.isNavigable()) {
      return null;
    }
    try {
      return resolveHandle(instance.getHandle());
    } catch (Exception ignored) {
      return null;
    }
  }

  private static String graphNodeKey(Instance instance) {
    if (instance == null) {
      return "missing";
    }
    if (instance.isNavigable()) {
      return "handle:" + instance.getHandle();
    }
    return "identity:"
        + instance.getType()
        + "@"
        + instance.getIdentity();
  }

  private Relation relation(
      String label, String kind, int index, Object target) {
    String handle = handleForObject(target);
    return new Relation(
        label,
        kind,
        index,
        describe(target, handle));
  }

  private String handleForObject(Object object) {
    try {
      long currentTag = nativeAccess.objectTag(object);
      String existing = handlesByTag.get(Long.valueOf(currentTag));
      if (existing != null) {
        return existing;
      }
      if (currentTag != 0) {
        return "";
      }
      long candidate = allocateTagBlock(1);
      long assigned =
          nativeAccess.tagObjectIfAvailable(object, candidate);
      return assigned == candidate ? registerTaggedObject(assigned) : "";
    } catch (Exception ignored) {
      return "";
    }
  }

  private Object resolveHandle(String objectHandle) throws Exception {
    Long tag = handles.get(objectHandle);
    if (tag == null) {
      throw new IllegalArgumentException(
          "The selected object handle is unknown or expired");
    }
    Object object = nativeAccess.resolveTaggedObject(tag.longValue());
    if (object != null) {
      return object;
    }
    handles.remove(objectHandle);
    handlesByTag.remove(tag);
    throw new IllegalStateException(
        "The selected object was garbage collected");
  }

  private String registerTaggedObject(long tag) {
    if (!isSessionTag(tag)) {
      return "";
    }
    String existing = handlesByTag.get(Long.valueOf(tag));
    if (existing != null) {
      return existing;
    }
    while (handles.size() >= MAXIMUM_SESSION_HANDLES) {
      Iterator<Map.Entry<String, Long>> iterator =
          handles.entrySet().iterator();
      if (!iterator.hasNext()) {
        break;
      }
      Map.Entry<String, Long> eldest = iterator.next();
      iterator.remove();
      handlesByTag.remove(eldest.getValue());
      clearTagBestEffort(eldest.getValue().longValue());
    }
    String handle = UUID.randomUUID().toString();
    handles.put(handle, Long.valueOf(tag));
    handlesByTag.put(Long.valueOf(tag), handle);
    return handle;
  }

  private long allocateTagBlock(int count) {
    if (count < 1 || count > MAXIMUM_SESSION_HANDLES) {
      throw new IllegalArgumentException("Invalid JVMTI tag block size");
    }
    if (nextTagCounter + count >= TAG_COUNTER_MASK) {
      nextTagCounter = 1_024L;
    }
    long base = tagPrefix | nextTagCounter;
    nextTagCounter += count + 1L;
    return base;
  }

  private void clearDominatorOutputTags(
      long[] metadata,
      long outputTagBase,
      int maximumViewNodes) {
    if (metadata == null || metadata.length < 20) {
      return;
    }
    int count =
        Math.min(
            maximumViewNodes,
            Math.max(0, safeInt(metadata[13])));
    for (int index = 0; index < count; index++) {
      int offset = 20 + index * 10;
      if (offset + 8 >= metadata.length) {
        break;
      }
      long tag = metadata[offset + 8];
      if (tag >= outputTagBase
          && tag < outputTagBase + maximumViewNodes) {
        clearTagBestEffort(tag);
      }
    }
  }

  private boolean isSessionTag(long tag) {
    return tag > 0 && (tag & TAG_PREFIX_MASK) == tagPrefix;
  }

  private Instance describe(Object object, String handle) {
    TreeMap<String, String> fields = describeFields(object);
    return new Instance(
        handle,
        object.getClass().getName(),
        Integer.toHexString(System.identityHashCode(object)),
        instrumentation.getObjectSize(object),
        fields);
  }

  private static TreeMap<String, String> describeFields(Object object) {
    TreeMap<String, String> fields = new TreeMap<String, String>();
    Class<?> type = object.getClass();
    if (type.isArray()) {
      int length = Array.getLength(object);
      fields.put("length", Integer.toString(length));
      int limit = Math.min(length, MAXIMUM_ARRAY_ELEMENTS);
      for (int index = 0; index < limit; index++) {
        fields.put("[" + index + "]", safeValue(Array.get(object, index)));
      }
      if (length > limit) {
        fields.put("truncated", Integer.toString(length - limit));
      }
      return fields;
    }

    Class<?> current = type;
    while (current != null
        && current != Object.class
        && fields.size() < MAXIMUM_FIELDS) {
      for (Field field : current.getDeclaredFields()) {
        if (Modifier.isStatic(field.getModifiers())
            || fields.size() >= MAXIMUM_FIELDS) {
          continue;
        }
        String name = current.getSimpleName() + "." + field.getName();
        boolean accessible = field.isAccessible();
        try {
          if (!accessible) {
            field.setAccessible(true);
          }
          fields.put(name, safeValue(field.get(object)));
        } catch (Throwable ignored) {
          fields.put(name, "<inaccessible>");
        } finally {
          if (!accessible) {
            try {
              field.setAccessible(false);
            } catch (Throwable ignored) {
              // Access restoration is best-effort.
            }
          }
        }
      }
      current = current.getSuperclass();
    }
    return fields;
  }

  private static String safeValue(Object value) {
    if (value == null) {
      return "null";
    }
    try {
      boolean scalar =
          value instanceof CharSequence
              || value instanceof Number
              || value instanceof Boolean
              || value instanceof Character
              || value instanceof Enum;
      String rendered =
          scalar
              ? String.valueOf(value)
              : "<"
                  + value.getClass().getName()
                  + "@"
                  + Integer.toHexString(System.identityHashCode(value))
                  + ">";
      return rendered.length() <= MAXIMUM_VALUE_LENGTH
          ? rendered
          : rendered.substring(0, MAXIMUM_VALUE_LENGTH) + "…";
    } catch (Throwable ignored) {
      return "<unavailable>";
    }
  }

  private static int safeInt(long value) {
    if (value < Integer.MIN_VALUE) {
      return Integer.MIN_VALUE;
    }
    if (value > Integer.MAX_VALUE) {
      return Integer.MAX_VALUE;
    }
    return (int) value;
  }

  private static String referenceKind(int kind) {
    switch (kind) {
      case 1:
        return "CLASS";
      case 2:
        return "FIELD";
      case 3:
        return "ARRAY_ELEMENT";
      case 4:
        return "CLASS_LOADER";
      case 5:
        return "SIGNERS";
      case 6:
        return "PROTECTION_DOMAIN";
      case 7:
        return "INTERFACE";
      case 8:
        return "STATIC_FIELD";
      case 9:
        return "CONSTANT_POOL";
      case 10:
        return "SUPERCLASS";
      case 21:
        return "JNI_GLOBAL";
      case 22:
        return "SYSTEM_CLASS";
      case 23:
        return "MONITOR";
      case 24:
        return "STACK_LOCAL";
      case 25:
        return "JNI_LOCAL";
      case 26:
        return "THREAD";
      default:
        return "OTHER";
    }
  }

  private static String referenceLabel(int kind, int index) {
    String label = referenceKind(kind);
    return index >= 0 ? label + " #" + index : label;
  }

  private static String resourcePath() {
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    String architecture =
        System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
    String arch =
        "amd64".equals(architecture) || "x86_64".equals(architecture)
            ? "x64"
            : "aarch64".equals(architecture) || "arm64".equals(architecture)
                ? "arm64"
                : null;
    if (arch == null) {
      return null;
    }
    if (os.contains("mac")) {
      return "/META-INF/tanwei-native/macos-"
          + arch
          + "/libtanwei_heap.dylib";
    }
    if (os.contains("linux")) {
      return "/META-INF/tanwei-native/linux-" + arch + "/libtanwei_heap.so";
    }
    if (os.contains("win") && "x64".equals(arch)) {
      return "/META-INF/tanwei-native/windows-x64/tanwei_heap.dll";
    }
    return null;
  }

  private static void restrictPermissions(Path path) {
    try {
      Set<PosixFilePermission> permissions =
          EnumSet.of(
              PosixFilePermission.OWNER_READ,
              PosixFilePermission.OWNER_WRITE,
              PosixFilePermission.OWNER_EXECUTE);
      Files.setPosixFilePermissions(path, permissions);
    } catch (UnsupportedOperationException ignored) {
      // Windows permissions are inherited from the private temp directory.
    } catch (Exception ignored) {
      // Loading still relies on the OS and JVM access checks.
    }
  }

  private void clearHandles() {
    for (Long tag : new ArrayList<Long>(handlesByTag.keySet())) {
      clearTagBestEffort(tag.longValue());
    }
    handles.clear();
    handlesByTag.clear();
  }

  private void clearTagBestEffort(long tag) {
    try {
      nativeAccess.clearObjectTag(tag);
    } catch (Exception ignored) {
      // Session cleanup must continue for all other tags.
    }
  }

  @Override
  public synchronized void close() {
    clearHandles();
    Path library = extractedLibrary;
    extractedLibrary = null;
    if (library != null) {
      try {
        Files.deleteIfExists(library);
      } catch (Exception ignored) {
        // Windows keeps loaded DLLs locked; deleteOnExit remains registered.
      }
    }
  }

  private static native Object[] collectInstances(
      Class<?> target, int limit, long tagBase);

  private static native long objectTag(Object object);

  private static native long tagObjectIfAvailable(
      Object object, long candidateTag);

  private static native Object resolveTaggedObject(long tag);

  private static native long[] collectReferrerEdges(
      Object target,
      int limit,
      long scanLimit,
      long tagBase,
      long tagPrefix);

  private static native Object[] collectRootPath(
      long targetTag,
      int maximumDepth,
      int maximumNodes,
      long maximumEdges,
      long scanPrefix,
      long sessionPrefix);

  private static native Object[] collectRootPaths(
      long targetTag,
      int maximumPaths,
      int maximumDepth,
      int maximumNodes,
      long maximumEdges,
      long scanPrefix,
      long sessionPrefix);

  private static native Object[] collectRetainedSize(
      Object target,
      int maximumNodes,
      long maximumEdges,
      long scanPrefix,
      long referencePrefix,
      long sessionPrefix,
      Class<?>[] referenceClasses,
      boolean referenceClassesComplete);

  private static native long[] collectRetainedRanking(
      long[] targetTags,
      int maximumNodes,
      int maximumEdges,
      long scanPrefix,
      long referencePrefix,
      long sessionPrefix,
      Class<?>[] referenceClasses,
      boolean referenceClassesComplete);

  private static native long[] collectClassRetainedHistogram(
      Class<?>[] classes,
      int referenceClassCount,
      int maximumNodes,
      int maximumEdges,
      long scanPrefix,
      long classPrefix,
      long sessionPrefix,
      boolean classSelectionComplete,
      boolean referenceSelectionComplete);

  private static native Object[] collectDominatorTree(
      Class<?>[] classes,
      int referenceClassCount,
      int maximumNodes,
      int maximumEdges,
      int maximumDepth,
      int maximumViewNodes,
      int rootLimit,
      int branchLimit,
      long scanPrefix,
      long classPrefix,
      long sessionPrefix,
      long outputTagBase,
      boolean classSelectionComplete,
      boolean referenceSelectionComplete);

  private static native long[] collectHeapHistogram(
      Class<?>[] classes,
      long scanLimit,
      long tagPrefix,
      long sessionPrefix);

  private static native void clearObjectTag(long tag);

  interface NativeAccess {
    Object[] collectInstances(Class<?> target, int limit, long tagBase)
        throws Exception;

    long objectTag(Object object) throws Exception;

    long tagObjectIfAvailable(Object object, long candidateTag)
        throws Exception;

    Object resolveTaggedObject(long tag) throws Exception;

    long[] collectReferrerEdges(
        Object target,
        int limit,
        long scanLimit,
        long tagBase,
        long tagPrefix)
        throws Exception;

    Object[] collectRootPath(
        long targetTag,
        int maximumDepth,
        int maximumNodes,
        long maximumEdges,
        long scanPrefix,
        long sessionPrefix)
        throws Exception;

    Object[] collectRootPaths(
        long targetTag,
        int maximumPaths,
        int maximumDepth,
        int maximumNodes,
        long maximumEdges,
        long scanPrefix,
        long sessionPrefix)
        throws Exception;

    Object[] collectRetainedSize(
        Object target,
        int maximumNodes,
        long maximumEdges,
        long scanPrefix,
        long referencePrefix,
        long sessionPrefix,
        Class<?>[] referenceClasses,
        boolean referenceClassesComplete)
        throws Exception;

    long[] collectRetainedRanking(
        long[] targetTags,
        int maximumNodes,
        int maximumEdges,
        long scanPrefix,
        long referencePrefix,
        long sessionPrefix,
        Class<?>[] referenceClasses,
        boolean referenceClassesComplete)
        throws Exception;

    long[] collectClassRetainedHistogram(
        Class<?>[] classes,
        int referenceClassCount,
        int maximumNodes,
        int maximumEdges,
        long scanPrefix,
        long classPrefix,
        long sessionPrefix,
        boolean classSelectionComplete,
        boolean referenceSelectionComplete)
        throws Exception;

    Object[] collectDominatorTree(
        Class<?>[] classes,
        int referenceClassCount,
        int maximumNodes,
        int maximumEdges,
        int maximumDepth,
        int maximumViewNodes,
        int rootLimit,
        int branchLimit,
        long scanPrefix,
        long classPrefix,
        long sessionPrefix,
        long outputTagBase,
        boolean classSelectionComplete,
        boolean referenceSelectionComplete)
        throws Exception;

    long[] collectHeapHistogram(
        Class<?>[] classes,
        long scanLimit,
        long tagPrefix,
        long sessionPrefix)
        throws Exception;

    void clearObjectTag(long tag) throws Exception;
  }

  private static final class JniNativeAccess implements NativeAccess {
    @Override
    public Object[] collectInstances(
        Class<?> target, int limit, long tagBase) {
      return HeapInstanceController.collectInstances(
          target, limit, tagBase);
    }

    @Override
    public long objectTag(Object object) {
      return HeapInstanceController.objectTag(object);
    }

    @Override
    public long tagObjectIfAvailable(
        Object object, long candidateTag) {
      return HeapInstanceController.tagObjectIfAvailable(
          object, candidateTag);
    }

    @Override
    public Object resolveTaggedObject(long tag) {
      return HeapInstanceController.resolveTaggedObject(tag);
    }

    @Override
    public long[] collectReferrerEdges(
        Object target,
        int limit,
        long scanLimit,
        long tagBase,
        long tagPrefix) {
      return HeapInstanceController.collectReferrerEdges(
          target,
          limit,
          scanLimit,
          tagBase,
          tagPrefix);
    }

    @Override
    public Object[] collectRootPath(
        long targetTag,
        int maximumDepth,
        int maximumNodes,
        long maximumEdges,
        long scanPrefix,
        long sessionPrefix) {
      return HeapInstanceController.collectRootPath(
          targetTag,
          maximumDepth,
          maximumNodes,
          maximumEdges,
          scanPrefix,
          sessionPrefix);
    }

    @Override
    public Object[] collectRootPaths(
        long targetTag,
        int maximumPaths,
        int maximumDepth,
        int maximumNodes,
        long maximumEdges,
        long scanPrefix,
        long sessionPrefix) {
      return HeapInstanceController.collectRootPaths(
          targetTag,
          maximumPaths,
          maximumDepth,
          maximumNodes,
          maximumEdges,
          scanPrefix,
          sessionPrefix);
    }

    @Override
    public Object[] collectRetainedSize(
        Object target,
        int maximumNodes,
        long maximumEdges,
        long scanPrefix,
        long referencePrefix,
        long sessionPrefix,
        Class<?>[] referenceClasses,
        boolean referenceClassesComplete) {
      return HeapInstanceController.collectRetainedSize(
          target,
          maximumNodes,
          maximumEdges,
          scanPrefix,
          referencePrefix,
          sessionPrefix,
          referenceClasses,
          referenceClassesComplete);
    }

    @Override
    public long[] collectRetainedRanking(
        long[] targetTags,
        int maximumNodes,
        int maximumEdges,
        long scanPrefix,
        long referencePrefix,
        long sessionPrefix,
        Class<?>[] referenceClasses,
        boolean referenceClassesComplete) {
      return HeapInstanceController.collectRetainedRanking(
          targetTags,
          maximumNodes,
          maximumEdges,
          scanPrefix,
          referencePrefix,
          sessionPrefix,
          referenceClasses,
          referenceClassesComplete);
    }

    @Override
    public long[] collectClassRetainedHistogram(
        Class<?>[] classes,
        int referenceClassCount,
        int maximumNodes,
        int maximumEdges,
        long scanPrefix,
        long classPrefix,
        long sessionPrefix,
        boolean classSelectionComplete,
        boolean referenceSelectionComplete) {
      return HeapInstanceController.collectClassRetainedHistogram(
          classes,
          referenceClassCount,
          maximumNodes,
          maximumEdges,
          scanPrefix,
          classPrefix,
          sessionPrefix,
          classSelectionComplete,
          referenceSelectionComplete);
    }

    @Override
    public Object[] collectDominatorTree(
        Class<?>[] classes,
        int referenceClassCount,
        int maximumNodes,
        int maximumEdges,
        int maximumDepth,
        int maximumViewNodes,
        int rootLimit,
        int branchLimit,
        long scanPrefix,
        long classPrefix,
        long sessionPrefix,
        long outputTagBase,
        boolean classSelectionComplete,
        boolean referenceSelectionComplete) {
      return HeapInstanceController.collectDominatorTree(
          classes,
          referenceClassCount,
          maximumNodes,
          maximumEdges,
          maximumDepth,
          maximumViewNodes,
          rootLimit,
          branchLimit,
          scanPrefix,
          classPrefix,
          sessionPrefix,
          outputTagBase,
          classSelectionComplete,
          referenceSelectionComplete);
    }

    @Override
    public long[] collectHeapHistogram(
        Class<?>[] classes,
        long scanLimit,
        long tagPrefix,
        long sessionPrefix) {
      return HeapInstanceController.collectHeapHistogram(
          classes, scanLimit, tagPrefix, sessionPrefix);
    }

    @Override
    public void clearObjectTag(long tag) {
      HeapInstanceController.clearObjectTag(tag);
    }
  }

  static final class QueryResult {
    private final String className;
    private final String classLoader;
    private final int requestedLimit;
    private final List<Instance> instances;

    QueryResult(
        String className,
        String classLoader,
        int requestedLimit,
        List<Instance> instances) {
      this.className = className;
      this.classLoader = classLoader;
      this.requestedLimit = requestedLimit;
      this.instances =
          Collections.unmodifiableList(
              new ArrayList<Instance>(instances));
    }

    String getClassName() {
      return className;
    }

    String getClassLoader() {
      return classLoader;
    }

    int getRequestedLimit() {
      return requestedLimit;
    }

    List<Instance> getInstances() {
      return instances;
    }
  }

  static final class ThreadPoolResult {
    private final int queriedTypes;
    private final int requestedLimit;
    private final int requestedMemberLimit;
    private final boolean truncated;
    private final int scannedThreads;
    private final boolean threadEnumerationTruncated;
    private final int discoveredMembers;
    private final int returnedMembers;
    private final List<ThreadPoolRow> pools;

    ThreadPoolResult(
        int queriedTypes,
        int requestedLimit,
        int requestedMemberLimit,
        boolean truncated,
        int scannedThreads,
        boolean threadEnumerationTruncated,
        int discoveredMembers,
        int returnedMembers,
        List<ThreadPoolRow> pools) {
      if (queriedTypes < 0
          || requestedLimit < MINIMUM_THREAD_POOLS
          || requestedMemberLimit < MINIMUM_THREAD_POOL_MEMBERS
          || scannedThreads < 0
          || discoveredMembers < 0
          || returnedMembers < 0
          || returnedMembers > requestedMemberLimit
          || pools == null) {
        throw new IllegalArgumentException(
            "Thread-pool result fields are invalid");
      }
      this.queriedTypes = queriedTypes;
      this.requestedLimit = requestedLimit;
      this.requestedMemberLimit = requestedMemberLimit;
      this.truncated = truncated;
      this.scannedThreads = scannedThreads;
      this.threadEnumerationTruncated = threadEnumerationTruncated;
      this.discoveredMembers = discoveredMembers;
      this.returnedMembers = returnedMembers;
      this.pools =
          Collections.unmodifiableList(
              new ArrayList<ThreadPoolRow>(pools));
    }

    int getQueriedTypes() {
      return queriedTypes;
    }

    int getRequestedLimit() {
      return requestedLimit;
    }

    int getRequestedMemberLimit() {
      return requestedMemberLimit;
    }

    boolean isTruncated() {
      return truncated;
    }

    int getScannedThreads() {
      return scannedThreads;
    }

    boolean isThreadEnumerationTruncated() {
      return threadEnumerationTruncated;
    }

    int getDiscoveredMembers() {
      return discoveredMembers;
    }

    int getReturnedMembers() {
      return returnedMembers;
    }

    List<ThreadPoolRow> getPools() {
      return pools;
    }
  }

  static final class ThreadPoolRow {
    private final String kind;
    private final String className;
    private final String identity;
    private final String state;
    private final long configuredSize;
    private final long poolSize;
    private final long activeCount;
    private final long maximumSize;
    private final long largestSize;
    private final long completedTasks;
    private final long queuedTasks;
    private final long remainingQueueCapacity;
    private final String queueType;
    private final long queuedSubmissions;
    private final long runningCount;
    private final long stealCount;
    private final String threadFactoryType;
    private final String rejectionHandlerType;
    private final boolean queueInspectionAvailable;
    private final String queueInspectionIssue;
    private final int queueTasksScanned;
    private final boolean queueTasksTruncated;
    private final List<ThreadPoolTaskType> queueTaskTypes;
    private final boolean membershipAvailable;
    private final String membershipIssue;
    private final int memberCount;
    private final boolean membersTruncated;
    private final List<ThreadPoolMember> members;

    ThreadPoolRow(
        String kind,
        String className,
        String identity,
        String state,
        long configuredSize,
        long poolSize,
        long activeCount,
        long maximumSize,
        long largestSize,
        long completedTasks,
        long queuedTasks,
        long remainingQueueCapacity,
        String queueType,
        long queuedSubmissions,
        long runningCount,
        long stealCount,
        String threadFactoryType,
        String rejectionHandlerType,
        ThreadPoolQueueEvidence queueEvidence,
        ThreadPoolMembership membership) {
      if (kind == null
          || className == null
          || identity == null
          || state == null
          || queueType == null
          || threadFactoryType == null
          || rejectionHandlerType == null
          || queueEvidence == null
          || membership == null) {
        throw new IllegalArgumentException(
            "Thread-pool row fields are required");
      }
      this.kind = kind;
      this.className = className;
      this.identity = identity;
      this.state = state;
      this.configuredSize = configuredSize;
      this.poolSize = poolSize;
      this.activeCount = activeCount;
      this.maximumSize = maximumSize;
      this.largestSize = largestSize;
      this.completedTasks = completedTasks;
      this.queuedTasks = queuedTasks;
      this.remainingQueueCapacity = remainingQueueCapacity;
      this.queueType = queueType;
      this.queuedSubmissions = queuedSubmissions;
      this.runningCount = runningCount;
      this.stealCount = stealCount;
      this.threadFactoryType = threadFactoryType;
      this.rejectionHandlerType = rejectionHandlerType;
      this.queueInspectionAvailable = queueEvidence.available;
      this.queueInspectionIssue = queueEvidence.issue;
      this.queueTasksScanned = queueEvidence.scanned;
      this.queueTasksTruncated = queueEvidence.truncated;
      this.queueTaskTypes =
          Collections.unmodifiableList(
              new ArrayList<ThreadPoolTaskType>(queueEvidence.taskTypes));
      this.membershipAvailable = membership.available;
      this.membershipIssue = membership.issue;
      this.memberCount = membership.memberCount;
      this.membersTruncated = membership.truncated;
      this.members =
          Collections.unmodifiableList(
              new ArrayList<ThreadPoolMember>(membership.members));
    }

    String getKind() {
      return kind;
    }

    String getClassName() {
      return className;
    }

    String getIdentity() {
      return identity;
    }

    String getState() {
      return state;
    }

    long getConfiguredSize() {
      return configuredSize;
    }

    long getPoolSize() {
      return poolSize;
    }

    long getActiveCount() {
      return activeCount;
    }

    long getMaximumSize() {
      return maximumSize;
    }

    long getLargestSize() {
      return largestSize;
    }

    long getCompletedTasks() {
      return completedTasks;
    }

    long getQueuedTasks() {
      return queuedTasks;
    }

    long getRemainingQueueCapacity() {
      return remainingQueueCapacity;
    }

    String getQueueType() {
      return queueType;
    }

    long getQueuedSubmissions() {
      return queuedSubmissions;
    }

    long getRunningCount() {
      return runningCount;
    }

    long getStealCount() {
      return stealCount;
    }

    String getThreadFactoryType() {
      return threadFactoryType;
    }

    String getRejectionHandlerType() {
      return rejectionHandlerType;
    }

    boolean isQueueInspectionAvailable() {
      return queueInspectionAvailable;
    }

    String getQueueInspectionIssue() {
      return queueInspectionIssue;
    }

    int getQueueTasksScanned() {
      return queueTasksScanned;
    }

    boolean isQueueTasksTruncated() {
      return queueTasksTruncated;
    }

    List<ThreadPoolTaskType> getQueueTaskTypes() {
      return queueTaskTypes;
    }

    boolean isMembershipAvailable() {
      return membershipAvailable;
    }

    String getMembershipIssue() {
      return membershipIssue;
    }

    int getMemberCount() {
      return memberCount;
    }

    boolean isMembersTruncated() {
      return membersTruncated;
    }

    List<ThreadPoolMember> getMembers() {
      return members;
    }
  }

  static final class ThreadPoolMember {
    private final long threadId;
    private final String name;
    private final String groupName;
    private final String state;
    private final boolean daemon;
    private final int priority;
    private final String topFrame;
    private final String applicationFrame;
    private final String blockerType;

    ThreadPoolMember(
        long threadId,
        String name,
        String groupName,
        String state,
        boolean daemon,
        int priority,
        String topFrame,
        String applicationFrame,
        String blockerType) {
      if (threadId < 0L
          || name == null
          || groupName == null
          || state == null
          || topFrame == null
          || applicationFrame == null
          || blockerType == null
          || priority < Thread.MIN_PRIORITY
          || priority > Thread.MAX_PRIORITY) {
        throw new IllegalArgumentException(
            "Thread-pool member fields are invalid");
      }
      this.threadId = threadId;
      this.name = name;
      this.groupName = groupName;
      this.state = state;
      this.daemon = daemon;
      this.priority = priority;
      this.topFrame = topFrame;
      this.applicationFrame = applicationFrame;
      this.blockerType = blockerType;
    }

    long getThreadId() {
      return threadId;
    }

    String getName() {
      return name;
    }

    String getGroupName() {
      return groupName;
    }

    String getState() {
      return state;
    }

    boolean isDaemon() {
      return daemon;
    }

    int getPriority() {
      return priority;
    }

    String getTopFrame() {
      return topFrame;
    }

    String getApplicationFrame() {
      return applicationFrame;
    }

    String getBlockerType() {
      return blockerType;
    }
  }

  static final class ThreadPoolTaskType {
    private final String className;
    private final int count;

    ThreadPoolTaskType(String className, int count) {
      if (className == null || className.isEmpty() || count <= 0) {
        throw new IllegalArgumentException(
            "Thread-pool task-type fields are invalid");
      }
      this.className = className;
      this.count = count;
    }

    String getClassName() {
      return className;
    }

    int getCount() {
      return count;
    }
  }

  private static final class ThreadPoolQueueEvidence {
    private final boolean available;
    private final String issue;
    private final int scanned;
    private final boolean truncated;
    private final List<ThreadPoolTaskType> taskTypes;

    ThreadPoolQueueEvidence(
        boolean available,
        String issue,
        int scanned,
        boolean truncated,
        List<ThreadPoolTaskType> taskTypes) {
      int countedTasks = 0;
      if (taskTypes != null) {
        for (ThreadPoolTaskType taskType : taskTypes) {
          if (taskType == null) {
            throw new IllegalArgumentException(
                "Thread-pool queue-evidence task type is required");
          }
          countedTasks += taskType.count;
        }
      }
      if (issue == null
          || scanned < 0
          || taskTypes == null
          || taskTypes.size() > scanned
          || countedTasks > scanned
          || (available && !issue.isEmpty())
          || (!available && (scanned != 0 || !taskTypes.isEmpty()))) {
        throw new IllegalArgumentException(
            "Thread-pool queue-evidence fields are invalid");
      }
      this.available = available;
      this.issue = issue;
      this.scanned = scanned;
      this.truncated = truncated;
      this.taskTypes =
          Collections.unmodifiableList(
              new ArrayList<ThreadPoolTaskType>(taskTypes));
    }
  }

  private static final class ThreadPoolMembership {
    private final boolean available;
    private final String issue;
    private final int memberCount;
    private final boolean truncated;
    private final List<ThreadPoolMember> members;

    ThreadPoolMembership(
        boolean available,
        String issue,
        int memberCount,
        boolean truncated,
        List<ThreadPoolMember> members) {
      if (issue == null
          || memberCount < 0
          || members == null
          || members.size() > memberCount) {
        throw new IllegalArgumentException(
            "Thread-pool membership fields are invalid");
      }
      this.available = available;
      this.issue = issue;
      this.memberCount = memberCount;
      this.truncated = truncated;
      this.members =
          Collections.unmodifiableList(
              new ArrayList<ThreadPoolMember>(members));
    }
  }

  private static final class ThreadEnumeration {
    private final List<Thread> threads;
    private final int scanned;
    private final boolean truncated;
    private final String issue;

    ThreadEnumeration(
        List<Thread> threads,
        int scanned,
        boolean truncated,
        String issue) {
      if (threads == null
          || scanned < 0
          || issue == null
          || scanned != threads.size()) {
        throw new IllegalArgumentException(
            "Thread enumeration fields are invalid");
      }
      this.threads =
          Collections.unmodifiableList(new ArrayList<Thread>(threads));
      this.scanned = scanned;
      this.truncated = truncated;
      this.issue = issue;
    }
  }

  static final class DominatorTreeResult {
    private final int graphNodes;
    private final int graphEdges;
    private final long tagConflicts;
    private final boolean truncated;
    private final boolean nodeLimitReached;
    private final boolean edgeLimitReached;
    private final int taggedClasses;
    private final int skippedTaggedClasses;
    private final boolean weakSemanticsComplete;
    private final boolean classSelectionComplete;
    private final boolean exact;
    private final int reachableNodes;
    private final long reachableBytes;
    private final boolean viewTruncated;
    private final int rootChildren;
    private final int maximumDepth;
    private final int maximumViewNodes;
    private final int rootLimit;
    private final int branchLimit;
    private final List<DominatorTreeNode> nodes;

    DominatorTreeResult(
        int graphNodes,
        int graphEdges,
        long tagConflicts,
        boolean truncated,
        boolean nodeLimitReached,
        boolean edgeLimitReached,
        int taggedClasses,
        int skippedTaggedClasses,
        boolean weakSemanticsComplete,
        boolean classSelectionComplete,
        boolean exact,
        int reachableNodes,
        long reachableBytes,
        boolean viewTruncated,
        int rootChildren,
        int maximumDepth,
        int maximumViewNodes,
        int rootLimit,
        int branchLimit,
        List<DominatorTreeNode> nodes) {
      if (graphNodes < 0
          || graphEdges < 0
          || tagConflicts < 0L
          || taggedClasses < 0
          || skippedTaggedClasses < 0
          || reachableNodes < 0
          || reachableBytes < 0L
          || rootChildren < 0
          || maximumDepth < 1
          || maximumViewNodes < 10
          || rootLimit < 1
          || branchLimit < 1
          || nodes == null) {
        throw new IllegalArgumentException(
            "Dominator-tree result fields are invalid");
      }
      this.graphNodes = graphNodes;
      this.graphEdges = graphEdges;
      this.tagConflicts = tagConflicts;
      this.truncated = truncated;
      this.nodeLimitReached = nodeLimitReached;
      this.edgeLimitReached = edgeLimitReached;
      this.taggedClasses = taggedClasses;
      this.skippedTaggedClasses = skippedTaggedClasses;
      this.weakSemanticsComplete = weakSemanticsComplete;
      this.classSelectionComplete = classSelectionComplete;
      this.exact = exact;
      this.reachableNodes = reachableNodes;
      this.reachableBytes = reachableBytes;
      this.viewTruncated = viewTruncated;
      this.rootChildren = rootChildren;
      this.maximumDepth = maximumDepth;
      this.maximumViewNodes = maximumViewNodes;
      this.rootLimit = rootLimit;
      this.branchLimit = branchLimit;
      this.nodes =
          Collections.unmodifiableList(
              new ArrayList<DominatorTreeNode>(nodes));
    }

    int getGraphNodes() {
      return graphNodes;
    }

    int getGraphEdges() {
      return graphEdges;
    }

    long getTagConflicts() {
      return tagConflicts;
    }

    boolean isTruncated() {
      return truncated;
    }

    boolean isNodeLimitReached() {
      return nodeLimitReached;
    }

    boolean isEdgeLimitReached() {
      return edgeLimitReached;
    }

    int getTaggedClasses() {
      return taggedClasses;
    }

    int getSkippedTaggedClasses() {
      return skippedTaggedClasses;
    }

    boolean isWeakSemanticsComplete() {
      return weakSemanticsComplete;
    }

    boolean isClassSelectionComplete() {
      return classSelectionComplete;
    }

    boolean isExact() {
      return exact;
    }

    int getReachableNodes() {
      return reachableNodes;
    }

    long getReachableBytes() {
      return reachableBytes;
    }

    boolean isViewTruncated() {
      return viewTruncated;
    }

    int getRootChildren() {
      return rootChildren;
    }

    int getMaximumDepth() {
      return maximumDepth;
    }

    int getMaximumViewNodes() {
      return maximumViewNodes;
    }

    int getRootLimit() {
      return rootLimit;
    }

    int getBranchLimit() {
      return branchLimit;
    }

    List<DominatorTreeNode> getNodes() {
      return nodes;
    }
  }

  static final class DominatorTreeNode {
    private final int index;
    private final int parentIndex;
    private final int depth;
    private final long shallowBytes;
    private final long retainedObjects;
    private final long candidateRetainedBytes;
    private final long retainedBytes;
    private final int directChildren;
    private final int displayedChildren;
    private final String classLoader;
    private final Instance object;

    DominatorTreeNode(
        int index,
        int parentIndex,
        int depth,
        long shallowBytes,
        long retainedObjects,
        long candidateRetainedBytes,
        long retainedBytes,
        int directChildren,
        int displayedChildren,
        String classLoader,
        Instance object) {
      if (index < 0
          || parentIndex < -1
          || parentIndex >= index
          || depth < 1
          || shallowBytes < 0L
          || retainedObjects < 1L
          || candidateRetainedBytes < shallowBytes
          || retainedBytes < -1L
          || directChildren < 0
          || displayedChildren < 0
          || displayedChildren > directChildren
          || classLoader == null
          || object == null) {
        throw new IllegalArgumentException(
            "Dominator-tree node fields are invalid");
      }
      this.index = index;
      this.parentIndex = parentIndex;
      this.depth = depth;
      this.shallowBytes = shallowBytes;
      this.retainedObjects = retainedObjects;
      this.candidateRetainedBytes = candidateRetainedBytes;
      this.retainedBytes = retainedBytes;
      this.directChildren = directChildren;
      this.displayedChildren = displayedChildren;
      this.classLoader = classLoader;
      this.object = object;
    }

    int getIndex() {
      return index;
    }

    int getParentIndex() {
      return parentIndex;
    }

    int getDepth() {
      return depth;
    }

    long getShallowBytes() {
      return shallowBytes;
    }

    long getRetainedObjects() {
      return retainedObjects;
    }

    long getCandidateRetainedBytes() {
      return candidateRetainedBytes;
    }

    long getRetainedBytes() {
      return retainedBytes;
    }

    int getDirectChildren() {
      return directChildren;
    }

    int getDisplayedChildren() {
      return displayedChildren;
    }

    String getClassLoader() {
      return classLoader;
    }

    Instance getObject() {
      return object;
    }
  }

  static final class ClassRetainedHistogramResult {
    private final int loadedClasses;
    private final int selectedClasses;
    private final int taggedClasses;
    private final int skippedTaggedClasses;
    private final int graphNodes;
    private final int graphEdges;
    private final long tagConflicts;
    private final boolean truncated;
    private final boolean nodeLimitReached;
    private final boolean edgeLimitReached;
    private final boolean weakSemanticsComplete;
    private final boolean classSelectionComplete;
    private final boolean exact;
    private final int reachableNodes;
    private final long reachableBytes;
    private final long accountedObjects;
    private final long accountedShallowBytes;
    private final List<ClassRetainedRow> rows;

    ClassRetainedHistogramResult(
        int loadedClasses,
        int selectedClasses,
        int taggedClasses,
        int skippedTaggedClasses,
        int graphNodes,
        int graphEdges,
        long tagConflicts,
        boolean truncated,
        boolean nodeLimitReached,
        boolean edgeLimitReached,
        boolean weakSemanticsComplete,
        boolean classSelectionComplete,
        boolean exact,
        int reachableNodes,
        long reachableBytes,
        long accountedObjects,
        long accountedShallowBytes,
        List<ClassRetainedRow> rows) {
      if (loadedClasses < 0
          || selectedClasses < 0
          || taggedClasses < 0
          || skippedTaggedClasses < 0
          || graphNodes < 0
          || graphEdges < 0
          || tagConflicts < 0L
          || reachableNodes < 0
          || reachableBytes < 0L
          || accountedObjects < 0L
          || accountedShallowBytes < 0L
          || rows == null) {
        throw new IllegalArgumentException(
            "Class-retained result fields are invalid");
      }
      this.loadedClasses = loadedClasses;
      this.selectedClasses = selectedClasses;
      this.taggedClasses = taggedClasses;
      this.skippedTaggedClasses = skippedTaggedClasses;
      this.graphNodes = graphNodes;
      this.graphEdges = graphEdges;
      this.tagConflicts = tagConflicts;
      this.truncated = truncated;
      this.nodeLimitReached = nodeLimitReached;
      this.edgeLimitReached = edgeLimitReached;
      this.weakSemanticsComplete = weakSemanticsComplete;
      this.classSelectionComplete = classSelectionComplete;
      this.exact = exact;
      this.reachableNodes = reachableNodes;
      this.reachableBytes = reachableBytes;
      this.accountedObjects = accountedObjects;
      this.accountedShallowBytes = accountedShallowBytes;
      this.rows =
          Collections.unmodifiableList(
              new ArrayList<ClassRetainedRow>(rows));
    }

    int getLoadedClasses() {
      return loadedClasses;
    }

    int getSelectedClasses() {
      return selectedClasses;
    }

    int getTaggedClasses() {
      return taggedClasses;
    }

    int getSkippedTaggedClasses() {
      return skippedTaggedClasses;
    }

    int getGraphNodes() {
      return graphNodes;
    }

    int getGraphEdges() {
      return graphEdges;
    }

    long getTagConflicts() {
      return tagConflicts;
    }

    boolean isTruncated() {
      return truncated;
    }

    boolean isNodeLimitReached() {
      return nodeLimitReached;
    }

    boolean isEdgeLimitReached() {
      return edgeLimitReached;
    }

    boolean isWeakSemanticsComplete() {
      return weakSemanticsComplete;
    }

    boolean isClassSelectionComplete() {
      return classSelectionComplete;
    }

    boolean isExact() {
      return exact;
    }

    int getReachableNodes() {
      return reachableNodes;
    }

    long getReachableBytes() {
      return reachableBytes;
    }

    long getAccountedObjects() {
      return accountedObjects;
    }

    long getAccountedShallowBytes() {
      return accountedShallowBytes;
    }

    List<ClassRetainedRow> getRows() {
      return rows;
    }
  }

  static final class ClassRetainedRow {
    private final int rank;
    private final String className;
    private final String classLoader;
    private final long instanceCount;
    private final long shallowBytes;
    private final long candidateRetainedObjects;
    private final long candidateRetainedBytes;
    private final long retainedBytes;

    ClassRetainedRow(
        int rank,
        String className,
        String classLoader,
        long instanceCount,
        long shallowBytes,
        long candidateRetainedObjects,
        long candidateRetainedBytes,
        long retainedBytes) {
      if (rank < 0
          || className == null
          || classLoader == null
          || instanceCount < 1L
          || shallowBytes < 0L
          || candidateRetainedObjects < instanceCount
          || candidateRetainedBytes < shallowBytes
          || retainedBytes < -1L) {
        throw new IllegalArgumentException(
            "Class-retained row fields are invalid");
      }
      this.rank = rank;
      this.className = className;
      this.classLoader = classLoader;
      this.instanceCount = instanceCount;
      this.shallowBytes = shallowBytes;
      this.candidateRetainedObjects = candidateRetainedObjects;
      this.candidateRetainedBytes = candidateRetainedBytes;
      this.retainedBytes = retainedBytes;
    }

    int getRank() {
      return rank;
    }

    String getClassName() {
      return className;
    }

    String getClassLoader() {
      return classLoader;
    }

    long getInstanceCount() {
      return instanceCount;
    }

    long getShallowBytes() {
      return shallowBytes;
    }

    long getCandidateRetainedObjects() {
      return candidateRetainedObjects;
    }

    long getCandidateRetainedBytes() {
      return candidateRetainedBytes;
    }

    long getRetainedBytes() {
      return retainedBytes;
    }
  }

  static final class HistogramResult {
    private final int loadedClasses;
    private final int candidateClasses;
    private final int nonEmptyClasses;
    private final int skippedTaggedClasses;
    private final int scannedObjects;
    private final boolean truncated;
    private final boolean classSelectionTruncated;
    private final long accountedObjects;
    private final long accountedBytes;
    private final List<HistogramRow> rows;

    HistogramResult(
        int loadedClasses,
        int candidateClasses,
        int nonEmptyClasses,
        int skippedTaggedClasses,
        int scannedObjects,
        boolean truncated,
        boolean classSelectionTruncated,
        long accountedObjects,
        long accountedBytes,
        List<HistogramRow> rows) {
      this.loadedClasses = loadedClasses;
      this.candidateClasses = candidateClasses;
      this.nonEmptyClasses = nonEmptyClasses;
      this.skippedTaggedClasses = skippedTaggedClasses;
      this.scannedObjects = scannedObjects;
      this.truncated = truncated;
      this.classSelectionTruncated = classSelectionTruncated;
      this.accountedObjects = accountedObjects;
      this.accountedBytes = accountedBytes;
      this.rows =
          Collections.unmodifiableList(
              new ArrayList<HistogramRow>(rows));
    }

    int getLoadedClasses() {
      return loadedClasses;
    }

    int getCandidateClasses() {
      return candidateClasses;
    }

    int getNonEmptyClasses() {
      return nonEmptyClasses;
    }

    int getSkippedTaggedClasses() {
      return skippedTaggedClasses;
    }

    int getScannedObjects() {
      return scannedObjects;
    }

    boolean isTruncated() {
      return truncated;
    }

    boolean isClassSelectionTruncated() {
      return classSelectionTruncated;
    }

    long getAccountedObjects() {
      return accountedObjects;
    }

    long getAccountedBytes() {
      return accountedBytes;
    }

    List<HistogramRow> getRows() {
      return rows;
    }
  }

  static final class HistogramRow {
    private final String className;
    private final String classLoader;
    private final long instanceCount;
    private final long shallowBytes;

    HistogramRow(
        String className,
        String classLoader,
        long instanceCount,
        long shallowBytes) {
      this.className = className;
      this.classLoader = classLoader;
      this.instanceCount = instanceCount;
      this.shallowBytes = shallowBytes;
    }

    String getClassName() {
      return className;
    }

    String getClassLoader() {
      return classLoader;
    }

    long getInstanceCount() {
      return instanceCount;
    }

    long getShallowBytes() {
      return shallowBytes;
    }

    long getAverageShallowBytes() {
      return instanceCount <= 0L ? 0L : shallowBytes / instanceCount;
    }
  }

  static final class RelationResult {
    private final Instance object;
    private final String direction;
    private final int scanned;
    private final boolean truncated;
    private final List<Relation> relations;

    RelationResult(
        Instance object,
        String direction,
        int scanned,
        boolean truncated,
        List<Relation> relations) {
      this.object = object;
      this.direction = direction;
      this.scanned = scanned;
      this.truncated = truncated;
      this.relations =
          Collections.unmodifiableList(
              new ArrayList<Relation>(relations));
    }

    Instance getObject() {
      return object;
    }

    String getDirection() {
      return direction;
    }

    int getScanned() {
      return scanned;
    }

    boolean isTruncated() {
      return truncated;
    }

    List<Relation> getRelations() {
      return relations;
    }
  }

  static final class ObjectGraphResult {
    private final Instance object;
    private final String direction;
    private final long scannedEdges;
    private final int taggedObjects;
    private final long tagConflicts;
    private final boolean truncated;
    private final boolean nodeLimitReached;
    private final boolean depthLimitReached;
    private final boolean branchLimitReached;
    private final List<GraphNode> nodes;
    private final List<GraphEdge> edges;

    ObjectGraphResult(
        Instance object,
        String direction,
        long scannedEdges,
        int taggedObjects,
        long tagConflicts,
        boolean truncated,
        boolean nodeLimitReached,
        boolean depthLimitReached,
        boolean branchLimitReached,
        List<GraphNode> nodes,
        List<GraphEdge> edges) {
      if (object == null
          || direction == null
          || nodes == null
          || edges == null) {
        throw new IllegalArgumentException(
            "Object graph result fields are required");
      }
      this.object = object;
      this.direction = direction;
      this.scannedEdges = Math.max(0L, scannedEdges);
      this.taggedObjects = Math.max(0, taggedObjects);
      this.tagConflicts = Math.max(0L, tagConflicts);
      this.truncated = truncated;
      this.nodeLimitReached = nodeLimitReached;
      this.depthLimitReached = depthLimitReached;
      this.branchLimitReached = branchLimitReached;
      this.nodes =
          Collections.unmodifiableList(
              new ArrayList<GraphNode>(nodes));
      this.edges =
          Collections.unmodifiableList(
              new ArrayList<GraphEdge>(edges));
    }

    Instance getObject() {
      return object;
    }

    String getDirection() {
      return direction;
    }

    long getScannedEdges() {
      return scannedEdges;
    }

    int getTaggedObjects() {
      return taggedObjects;
    }

    long getTagConflicts() {
      return tagConflicts;
    }

    boolean isTruncated() {
      return truncated;
    }

    boolean isNodeLimitReached() {
      return nodeLimitReached;
    }

    boolean isDepthLimitReached() {
      return depthLimitReached;
    }

    boolean isBranchLimitReached() {
      return branchLimitReached;
    }

    List<GraphNode> getNodes() {
      return nodes;
    }

    List<GraphEdge> getEdges() {
      return edges;
    }
  }

  static final class GraphNode {
    private final int index;
    private final int depth;
    private final Instance object;

    GraphNode(int index, int depth, Instance object) {
      if (index < 0 || depth < 0 || object == null) {
        throw new IllegalArgumentException(
            "Graph node index, depth and object are required");
      }
      this.index = index;
      this.depth = depth;
      this.object = object;
    }

    int getIndex() {
      return index;
    }

    int getDepth() {
      return depth;
    }

    Instance getObject() {
      return object;
    }
  }

  static final class GraphEdge {
    private final int source;
    private final int target;
    private final String label;
    private final String kind;
    private final int index;

    GraphEdge(
        int source,
        int target,
        String label,
        String kind,
        int index) {
      if (source < 0
          || target < 0
          || label == null
          || kind == null) {
        throw new IllegalArgumentException(
            "Graph edge endpoints and labels are required");
      }
      this.source = source;
      this.target = target;
      this.label = label;
      this.kind = kind;
      this.index = index;
    }

    int getSource() {
      return source;
    }

    int getTarget() {
      return target;
    }

    String getLabel() {
      return label;
    }

    String getKind() {
      return kind;
    }

    int getIndex() {
      return index;
    }
  }

  static final class RetainedSizeResult {
    private final Instance object;
    private final long closureEdges;
    private final long rootEdges;
    private final int taggedObjects;
    private final long tagConflicts;
    private final boolean closureTruncated;
    private final boolean rootTruncated;
    private final int referenceClasses;
    private final boolean weakSemanticsComplete;
    private final boolean exact;
    private final long reachableObjects;
    private final long reachableBytes;
    private final long candidateObjects;
    private final long candidateBytes;
    private final long retainedBytes;
    private final List<RetainedContributor> contributors;

    RetainedSizeResult(
        Instance object,
        long closureEdges,
        long rootEdges,
        int taggedObjects,
        long tagConflicts,
        boolean closureTruncated,
        boolean rootTruncated,
        int referenceClasses,
        boolean weakSemanticsComplete,
        boolean exact,
        long reachableObjects,
        long reachableBytes,
        long candidateObjects,
        long candidateBytes,
        long retainedBytes,
        List<RetainedContributor> contributors) {
      this.object = object;
      this.closureEdges = closureEdges;
      this.rootEdges = rootEdges;
      this.taggedObjects = taggedObjects;
      this.tagConflicts = tagConflicts;
      this.closureTruncated = closureTruncated;
      this.rootTruncated = rootTruncated;
      this.referenceClasses = referenceClasses;
      this.weakSemanticsComplete = weakSemanticsComplete;
      this.exact = exact;
      this.reachableObjects = reachableObjects;
      this.reachableBytes = reachableBytes;
      this.candidateObjects = candidateObjects;
      this.candidateBytes = candidateBytes;
      this.retainedBytes = retainedBytes;
      this.contributors =
          Collections.unmodifiableList(
              new ArrayList<RetainedContributor>(contributors));
    }

    Instance getObject() {
      return object;
    }

    long getClosureEdges() {
      return closureEdges;
    }

    long getRootEdges() {
      return rootEdges;
    }

    int getTaggedObjects() {
      return taggedObjects;
    }

    long getTagConflicts() {
      return tagConflicts;
    }

    boolean isClosureTruncated() {
      return closureTruncated;
    }

    boolean isRootTruncated() {
      return rootTruncated;
    }

    int getReferenceClasses() {
      return referenceClasses;
    }

    boolean isWeakSemanticsComplete() {
      return weakSemanticsComplete;
    }

    boolean isExact() {
      return exact;
    }

    long getReachableObjects() {
      return reachableObjects;
    }

    long getReachableBytes() {
      return reachableBytes;
    }

    long getCandidateObjects() {
      return candidateObjects;
    }

    long getCandidateBytes() {
      return candidateBytes;
    }

    long getRetainedBytes() {
      return retainedBytes;
    }

    List<RetainedContributor> getContributors() {
      return contributors;
    }
  }

  static final class RetainedContributor {
    private final int rank;
    private final long shallowBytes;
    private final Instance object;

    RetainedContributor(int rank, long shallowBytes, Instance object) {
      this.rank = rank;
      this.shallowBytes = shallowBytes;
      this.object = object;
    }

    int getRank() {
      return rank;
    }

    long getShallowBytes() {
      return shallowBytes;
    }

    Instance getObject() {
      return object;
    }
  }

  static final class RetainedRankingResult {
    private final String className;
    private final String classLoader;
    private final int requestedInstances;
    private final int graphNodes;
    private final int graphEdges;
    private final long tagConflicts;
    private final boolean truncated;
    private final boolean nodeLimitReached;
    private final boolean edgeLimitReached;
    private final int referenceClasses;
    private final boolean weakSemanticsComplete;
    private final boolean exact;
    private final int reachableNodes;
    private final long reachableBytes;
    private final List<RetainedRankingEntry> entries;

    RetainedRankingResult(
        String className,
        String classLoader,
        int requestedInstances,
        int graphNodes,
        int graphEdges,
        long tagConflicts,
        boolean truncated,
        boolean nodeLimitReached,
        boolean edgeLimitReached,
        int referenceClasses,
        boolean weakSemanticsComplete,
        boolean exact,
        int reachableNodes,
        long reachableBytes,
        List<RetainedRankingEntry> entries) {
      if (className == null
          || classLoader == null
          || requestedInstances < 1
          || graphNodes < 0
          || graphEdges < 0
          || tagConflicts < 0
          || referenceClasses < 0
          || reachableNodes < 0
          || reachableBytes < 0
          || entries == null) {
        throw new IllegalArgumentException(
            "Retained-ranking result fields are invalid");
      }
      this.className = className;
      this.classLoader = classLoader;
      this.requestedInstances = requestedInstances;
      this.graphNodes = graphNodes;
      this.graphEdges = graphEdges;
      this.tagConflicts = tagConflicts;
      this.truncated = truncated;
      this.nodeLimitReached = nodeLimitReached;
      this.edgeLimitReached = edgeLimitReached;
      this.referenceClasses = referenceClasses;
      this.weakSemanticsComplete = weakSemanticsComplete;
      this.exact = exact;
      this.reachableNodes = reachableNodes;
      this.reachableBytes = reachableBytes;
      this.entries =
          Collections.unmodifiableList(
              new ArrayList<RetainedRankingEntry>(entries));
    }

    static RetainedRankingResult empty(
        String className,
        String classLoader,
        int requestedInstances) {
      return new RetainedRankingResult(
          className,
          classLoader,
          requestedInstances,
          0,
          0,
          0L,
          false,
          false,
          false,
          0,
          true,
          true,
          0,
          0L,
          Collections.<RetainedRankingEntry>emptyList());
    }

    String getClassName() {
      return className;
    }

    String getClassLoader() {
      return classLoader;
    }

    int getRequestedInstances() {
      return requestedInstances;
    }

    int getGraphNodes() {
      return graphNodes;
    }

    int getGraphEdges() {
      return graphEdges;
    }

    long getTagConflicts() {
      return tagConflicts;
    }

    boolean isTruncated() {
      return truncated;
    }

    boolean isNodeLimitReached() {
      return nodeLimitReached;
    }

    boolean isEdgeLimitReached() {
      return edgeLimitReached;
    }

    int getReferenceClasses() {
      return referenceClasses;
    }

    boolean isWeakSemanticsComplete() {
      return weakSemanticsComplete;
    }

    boolean isExact() {
      return exact;
    }

    int getReachableNodes() {
      return reachableNodes;
    }

    long getReachableBytes() {
      return reachableBytes;
    }

    List<RetainedRankingEntry> getEntries() {
      return entries;
    }
  }

  static final class RetainedRankingEntry {
    private final int rank;
    private final long candidateObjects;
    private final long candidateBytes;
    private final long retainedBytes;
    private final Instance object;

    RetainedRankingEntry(
        int rank,
        long candidateObjects,
        long candidateBytes,
        long retainedBytes,
        Instance object) {
      if (rank < 0
          || candidateObjects < 1
          || candidateBytes < 0
          || retainedBytes < -1
          || object == null) {
        throw new IllegalArgumentException(
            "Retained-ranking entry fields are invalid");
      }
      this.rank = rank;
      this.candidateObjects = candidateObjects;
      this.candidateBytes = candidateBytes;
      this.retainedBytes = retainedBytes;
      this.object = object;
    }

    int getRank() {
      return rank;
    }

    long getCandidateObjects() {
      return candidateObjects;
    }

    long getCandidateBytes() {
      return candidateBytes;
    }

    long getRetainedBytes() {
      return retainedBytes;
    }

    Instance getObject() {
      return object;
    }
  }

  static final class RootPathResult {
    private final int scannedEdges;
    private final int taggedObjects;
    private final boolean truncated;
    private final boolean rootReached;
    private final List<RootPathNode> nodes;

    RootPathResult(
        int scannedEdges,
        int taggedObjects,
        boolean truncated,
        boolean rootReached,
        List<RootPathNode> nodes) {
      this.scannedEdges = scannedEdges;
      this.taggedObjects = taggedObjects;
      this.truncated = truncated;
      this.rootReached = rootReached;
      this.nodes =
          Collections.unmodifiableList(
              new ArrayList<RootPathNode>(nodes));
    }

    int getScannedEdges() {
      return scannedEdges;
    }

    int getTaggedObjects() {
      return taggedObjects;
    }

    boolean isTruncated() {
      return truncated;
    }

    boolean isRootReached() {
      return rootReached;
    }

    List<RootPathNode> getNodes() {
      return nodes;
    }
  }

  static final class RootPathsResult {
    private final long scannedEdges;
    private final int taggedObjects;
    private final long tagConflicts;
    private final boolean truncated;
    private final boolean pathLimitReached;
    private final List<RootPath> paths;

    RootPathsResult(
        long scannedEdges,
        int taggedObjects,
        long tagConflicts,
        boolean truncated,
        boolean pathLimitReached,
        List<RootPath> paths) {
      this.scannedEdges = scannedEdges;
      this.taggedObjects = taggedObjects;
      this.tagConflicts = tagConflicts;
      this.truncated = truncated;
      this.pathLimitReached = pathLimitReached;
      this.paths =
          Collections.unmodifiableList(
              new ArrayList<RootPath>(paths));
    }

    long getScannedEdges() {
      return scannedEdges;
    }

    int getTaggedObjects() {
      return taggedObjects;
    }

    long getTagConflicts() {
      return tagConflicts;
    }

    boolean isTruncated() {
      return truncated;
    }

    boolean isPathLimitReached() {
      return pathLimitReached;
    }

    List<RootPath> getPaths() {
      return paths;
    }
  }

  static final class RootPath {
    private final boolean rootReached;
    private final List<RootPathNode> nodes;

    RootPath(boolean rootReached, List<RootPathNode> nodes) {
      this.rootReached = rootReached;
      this.nodes =
          Collections.unmodifiableList(
              new ArrayList<RootPathNode>(nodes));
    }

    boolean isRootReached() {
      return rootReached;
    }

    List<RootPathNode> getNodes() {
      return nodes;
    }
  }

  static final class RootPathNode {
    private final Instance object;
    private final String relationLabel;
    private final String relationKind;
    private final int relationIndex;
    private final boolean root;

    RootPathNode(
        Instance object,
        String relationLabel,
        String relationKind,
        int relationIndex,
        boolean root) {
      this.object = object;
      this.relationLabel = relationLabel;
      this.relationKind = relationKind;
      this.relationIndex = relationIndex;
      this.root = root;
    }

    Instance getObject() {
      return object;
    }

    String getRelationLabel() {
      return relationLabel;
    }

    String getRelationKind() {
      return relationKind;
    }

    int getRelationIndex() {
      return relationIndex;
    }

    boolean isRoot() {
      return root;
    }
  }

  static final class Relation {
    private final String label;
    private final String kind;
    private final int index;
    private final Instance target;

    Relation(String label, String kind, int index, Instance target) {
      this.label = label;
      this.kind = kind;
      this.index = index;
      this.target = target;
    }

    String getLabel() {
      return label;
    }

    String getKind() {
      return kind;
    }

    int getIndex() {
      return index;
    }

    Instance getTarget() {
      return target;
    }
  }

  static final class Instance {
    private final String handle;
    private final String type;
    private final String identity;
    private final long shallowSize;
    private final TreeMap<String, String> fields;

    Instance(
        String handle,
        String type,
        String identity,
        long shallowSize,
        TreeMap<String, String> fields) {
      this.handle = handle;
      this.type = type;
      this.identity = identity;
      this.shallowSize = shallowSize;
      this.fields = new TreeMap<String, String>(fields);
    }

    String getHandle() {
      return handle;
    }

    String getType() {
      return type;
    }

    String getIdentity() {
      return identity;
    }

    long getShallowSize() {
      return shallowSize;
    }

    TreeMap<String, String> getFields() {
      return new TreeMap<String, String>(fields);
    }

    boolean isNavigable() {
      return !handle.isEmpty();
    }
  }

  private static final class RelationCollection {
    private final int scanned;
    private final boolean truncated;
    private final List<Relation> relations;

    private RelationCollection(
        int scanned, boolean truncated, List<Relation> relations) {
      this.scanned = scanned;
      this.truncated = truncated;
      this.relations = relations;
    }
  }

  private static final class ReferenceClassSelection {
    private final Class<?>[] classes;
    private final boolean complete;

    private ReferenceClassSelection(
        Class<?>[] classes, boolean complete) {
      this.classes = classes;
      this.complete = complete;
    }
  }

  private static final class DominatorClassSelection {
    private final int loadedClasses;
    private final Class<?>[] classes;
    private final int referenceClassCount;
    private final boolean classSelectionComplete;
    private final boolean referenceSelectionComplete;

    private DominatorClassSelection(
        int loadedClasses,
        Class<?>[] classes,
        int referenceClassCount,
        boolean classSelectionComplete,
        boolean referenceSelectionComplete) {
      if (loadedClasses < 1
          || classes == null
          || classes.length < 1
          || referenceClassCount < 1
          || referenceClassCount > classes.length) {
        throw new IllegalArgumentException(
            "Dominator class selection is invalid");
      }
      this.loadedClasses = loadedClasses;
      this.classes = classes;
      this.referenceClassCount = referenceClassCount;
      this.classSelectionComplete = classSelectionComplete;
      this.referenceSelectionComplete = referenceSelectionComplete;
    }
  }
}
