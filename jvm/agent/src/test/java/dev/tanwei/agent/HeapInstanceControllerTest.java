package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

final class HeapInstanceControllerTest {
  @Test
  void createsOpaqueHandlesAndTraversesBothDirections() throws Exception {
    Node child = new Node("child");
    Node leaf = new Node("leaf");
    Node root = new Node("root");
    Node alternateRoot = new Node("alternate-root");
    child.child = leaf;
    root.child = child;
    FakeNativeAccess nativeAccess = new FakeNativeAccess(root);
    nativeAccess.addReferrer(child, root, 2, 0);
    nativeAccess.setRootPath(child, root);
    nativeAccess.setRootPaths(
        new Object[] {child, root},
        new Object[] {child, alternateRoot});
    nativeAccess.setRetainedContributors(root, child);
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class), nativeAccess);

    HeapInstanceController.QueryResult query =
        controller.query(
            Node.class.getName(),
            classLoaderName(Node.class),
            5);
    assertEquals(1, query.getInstances().size());
    HeapInstanceController.Instance instance =
        query.getInstances().get(0);
    assertTrue(instance.isNavigable());
    assertFalse(instance.getHandle().contains(instance.getIdentity()));
    assertEquals(Node.class.getName(), instance.getType());

    HeapInstanceController.RelationResult outgoing =
        controller.relations(
            instance.getHandle(), "OUTGOING", 10, 10_000);
    HeapInstanceController.Relation childRelation =
        outgoing.getRelations().stream()
            .filter(
                relation ->
                    Node.class
                        .getName()
                        .equals(relation.getTarget().getType()))
            .findFirst()
            .orElseThrow(
                () -> new AssertionError("Child relation was not found"));
    assertEquals("FIELD", childRelation.getKind());
    assertTrue(childRelation.getTarget().isNavigable());

    HeapInstanceController.RelationResult incoming =
        controller.relations(
            childRelation.getTarget().getHandle(),
            "INCOMING",
            10,
            10_000);
    assertEquals(12, incoming.getScanned());
    assertFalse(incoming.isTruncated());
    assertEquals(1, incoming.getRelations().size());
    assertEquals(
        instance.getHandle(),
        incoming.getRelations().get(0).getTarget().getHandle());

    HeapInstanceController.ObjectGraphResult outgoingGraph =
        controller.objectGraph(
            instance.getHandle(),
            "OUTGOING",
            3,
            10,
            4,
            10_000);
    assertTrue(outgoingGraph.getNodes().size() >= 3);
    assertTrue(outgoingGraph.getEdges().size() >= 2);
    assertTrue(
        outgoingGraph.getNodes().stream()
            .anyMatch(
                node ->
                    node.getDepth() == 2
                        && node.getObject().getIdentity().equals(
                            Integer.toHexString(
                                System.identityHashCode(leaf)))));
    assertFalse(outgoingGraph.isNodeLimitReached());

    HeapInstanceController.ObjectGraphResult incomingGraph =
        controller.objectGraph(
            childRelation.getTarget().getHandle(),
            "INCOMING",
            3,
            10,
            4,
            100_000);
    assertEquals(3, incomingGraph.getNodes().size());
    assertEquals(2, incomingGraph.getEdges().size());
    assertEquals(84L, incomingGraph.getScannedEdges());
    assertTrue(
        incomingGraph.getNodes().stream()
            .anyMatch(
                node ->
                    node.getObject().getIdentity().equals(
                        Integer.toHexString(
                            System.identityHashCode(alternateRoot)))));

    HeapInstanceController.RootPathResult rootPath =
        controller.rootPath(
            childRelation.getTarget().getHandle(),
            8,
            10_000,
            100_000);
    assertEquals(42, rootPath.getScannedEdges());
    assertEquals(1, rootPath.getTaggedObjects());
    assertTrue(rootPath.isRootReached());
    assertFalse(rootPath.isTruncated());
    assertEquals(2, rootPath.getNodes().size());
    assertEquals(
        childRelation.getTarget().getHandle(),
        rootPath.getNodes().get(0).getObject().getHandle());
    assertTrue(rootPath.getNodes().get(1).isRoot());
    assertEquals(
        instance.getHandle(),
        rootPath.getNodes().get(1).getObject().getHandle());

    HeapInstanceController.RootPathsResult rootPaths =
        controller.rootPaths(
            childRelation.getTarget().getHandle(),
            4,
            8,
            10_000,
            100_000);
    assertEquals(84L, rootPaths.getScannedEdges());
    assertEquals(2, rootPaths.getPaths().size());
    assertTrue(
        rootPaths.getPaths().stream()
            .allMatch(HeapInstanceController.RootPath::isRootReached));
    assertTrue(
        rootPaths.getPaths().stream()
            .allMatch(path -> path.getNodes().size() == 2));
    assertFalse(rootPaths.isTruncated());
    assertFalse(rootPaths.isPathLimitReached());

    HeapInstanceController.RetainedSizeResult retained =
        controller.retainedSize(instance.getHandle(), 10_000, 100_000);
    assertTrue(retained.isExact());
    assertEquals(128L, retained.getRetainedBytes());
    assertEquals(2L, retained.getCandidateObjects());
    assertEquals(2, retained.getContributors().size());
    assertEquals(
        instance.getHandle(),
        retained.getContributors().get(0).getObject().getHandle());
    assertTrue(
        retained.getContributors().get(1).getObject().isNavigable());
    assertTrue(retained.isWeakSemanticsComplete());

    HeapInstanceController.RetainedRankingResult ranking =
        controller.retainedRanking(
            Node.class.getName(),
            classLoaderName(Node.class),
            5,
            100_000,
            250_000);
    assertTrue(ranking.isExact());
    assertEquals(1, ranking.getEntries().size());
    assertEquals(128L, ranking.getEntries().get(0).getRetainedBytes());
    assertEquals(1, ranking.getEntries().get(0).getRank());
    assertEquals(128, ranking.getGraphNodes());
    assertEquals(256, ranking.getGraphEdges());

    controller.close();
    assertTrue(nativeAccess.tags.isEmpty());
  }

  @Test
  void replacesTheTransientHandleSessionOnANewInstanceQuery()
      throws Exception {
    Node root = new Node("root");
    FakeNativeAccess nativeAccess = new FakeNativeAccess(root);
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class), nativeAccess);

    String firstHandle =
        controller
            .query(
                Node.class.getName(),
                classLoaderName(Node.class),
                1)
            .getInstances()
            .get(0)
            .getHandle();
    String secondHandle =
        controller
            .query(
                Node.class.getName(),
                classLoaderName(Node.class),
                1)
            .getInstances()
            .get(0)
            .getHandle();

    assertFalse(firstHandle.equals(secondHandle));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.relations(
                firstHandle, "OUTGOING", 10, 10_000));
    assertEquals(
        Node.class.getName(),
        controller
            .relations(
                secondHandle, "OUTGOING", 10, 10_000)
            .getObject()
            .getType());
  }

  @Test
  void rejectsUnboundedRelationRequests() throws Exception {
    Node root = new Node("root");
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class),
            new FakeNativeAccess(root));
    String handle =
        controller
            .query(
                Node.class.getName(),
                classLoaderName(Node.class),
                1)
            .getInstances()
            .get(0)
            .getHandle();

    assertThrows(
        IllegalArgumentException.class,
        () -> controller.relations(handle, "SIDEWAYS", 10, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.relations(handle, "INCOMING", 51, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.relations(handle, "INCOMING", 10, 999));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.objectGraph(
                handle, "SIDEWAYS", 3, 40, 4, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.objectGraph(
                handle, "OUTGOING", 6, 40, 4, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.objectGraph(
                handle, "OUTGOING", 3, 81, 4, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.objectGraph(
                handle, "OUTGOING", 3, 40, 9, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.objectGraph(
                handle, "OUTGOING", 3, 40, 4, 999));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.rootPath(handle, 0, 10_000, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.rootPath(handle, 8, 999, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.rootPath(handle, 8, 10_000, 1_000_001));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.rootPaths(handle, 9, 8, 10_000, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.retainedSize(handle, 999, 10_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.retainedSize(handle, 10_000, 1_000_001));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.retainedRanking(
                Node.class.getName(),
                classLoaderName(Node.class),
                0,
                100_000,
                250_000));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.retainedRanking(
                Node.class.getName(),
                classLoaderName(Node.class),
                5,
                9_999,
                250_000));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            controller.retainedRanking(
                Node.class.getName(),
                classLoaderName(Node.class),
                5,
                100_000,
                2_000_001));
  }

  @Test
  void neverPresentsAnIncompleteRetainedScanAsExact()
      throws Exception {
    Node root = new Node("root");
    FakeNativeAccess nativeAccess = new FakeNativeAccess(root);
    nativeAccess.setRetainedContributors(root);
    nativeAccess.setRetainedExact(false);
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class), nativeAccess);
    String handle =
        controller
            .query(
                Node.class.getName(),
                classLoaderName(Node.class),
                1)
            .getInstances()
            .get(0)
            .getHandle();

    HeapInstanceController.RetainedSizeResult result =
        controller.retainedSize(handle, 10_000, 10_000);

    assertFalse(result.isExact());
    assertFalse(result.isWeakSemanticsComplete());
    assertEquals(-1L, result.getRetainedBytes());
    assertEquals(64L, result.getCandidateBytes());
  }

  @Test
  void neverPresentsAnIncompleteRetainedRankingAsExact()
      throws Exception {
    Node first = new Node("first");
    Node second = new Node("second");
    FakeNativeAccess nativeAccess =
        new FakeNativeAccess(first, second);
    nativeAccess.setRetainedExact(false);
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class), nativeAccess);

    HeapInstanceController.RetainedRankingResult result =
        controller.retainedRanking(
            Node.class.getName(),
            classLoaderName(Node.class),
            2,
            100_000,
            250_000);

    assertFalse(result.isExact());
    assertFalse(result.isWeakSemanticsComplete());
    assertEquals(2, result.getEntries().size());
    assertEquals(-1L, result.getEntries().get(0).getRetainedBytes());
    assertEquals(256L, result.getEntries().get(0).getCandidateBytes());
    assertTrue(
        result.getEntries().get(0).getCandidateBytes()
            >= result.getEntries().get(1).getCandidateBytes());
  }

  @Test
  void aggregatesClassRetainedUnionsAndSortsByRetainedBytes()
      throws Exception {
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class, String.class),
            new FakeNativeAccess());

    HeapInstanceController.ClassRetainedHistogramResult result =
        controller.classRetainedHistogram(
            1, 100_000, 250_000, "");

    assertTrue(result.isExact());
    assertTrue(result.isWeakSemanticsComplete());
    assertTrue(result.isClassSelectionComplete());
    assertEquals(256, result.getGraphNodes());
    assertEquals(512, result.getGraphEdges());
    assertEquals(5L, result.getAccountedObjects());
    assertEquals(272L, result.getAccountedShallowBytes());
    assertEquals(1, result.getRows().size());
    HeapInstanceController.ClassRetainedRow row =
        result.getRows().get(0);
    assertEquals(1, row.getRank());
    assertEquals(Node.class.getName(), row.getClassName());
    assertEquals(3L, row.getInstanceCount());
    assertEquals(192L, row.getShallowBytes());
    assertEquals(6L, row.getCandidateRetainedObjects());
    assertEquals(768L, row.getRetainedBytes());
  }

  @Test
  void validatesClassRetainedBudgetsAndNeverPromotesCandidates()
      throws Exception {
    FakeNativeAccess nativeAccess = new FakeNativeAccess();
    nativeAccess.setRetainedExact(false);
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class, String.class),
            nativeAccess);

    assertThrows(
        IllegalArgumentException.class,
        () -> controller.classRetainedHistogram(
            0, 100_000, 250_000, ""));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.classRetainedHistogram(
            10, 9_999, 250_000, ""));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.classRetainedHistogram(
            10, 100_000, 2_000_001, ""));

    HeapInstanceController.ClassRetainedHistogramResult result =
        controller.classRetainedHistogram(
            10, 100_000, 250_000, "node");
    assertFalse(result.isExact());
    assertEquals(1, result.getRows().size());
    assertEquals(-1L, result.getRows().get(0).getRetainedBytes());
    assertEquals(
        768L,
        result.getRows().get(0).getCandidateRetainedBytes());
  }

  @Test
  void buildsABoundedNavigableDominatorTree() throws Exception {
    Node root = new Node("root");
    Node left = new Node("left");
    Node right = new Node("right");
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class),
            new FakeNativeAccess(root, left, right));

    HeapInstanceController.DominatorTreeResult result =
        controller.dominatorTree(
            3, 40, 5, 4, 100_000, 250_000);

    assertTrue(result.isExact());
    assertEquals(3, result.getNodes().size());
    assertEquals(1, result.getRootChildren());
    assertEquals(-1, result.getNodes().get(0).getParentIndex());
    assertEquals(1, result.getNodes().get(0).getDepth());
    assertEquals(2, result.getNodes().get(0).getDisplayedChildren());
    assertEquals(0, result.getNodes().get(1).getParentIndex());
    assertEquals(2, result.getNodes().get(1).getDepth());
    assertEquals(192L, result.getNodes().get(0).getRetainedBytes());
    assertTrue(result.getNodes().get(0).getObject().isNavigable());
    assertFalse(
        result.getNodes().get(0).getObject().getHandle().isEmpty());

    HeapInstanceController.RelationResult relations =
        controller.relations(
            result.getNodes().get(0).getObject().getHandle(),
            "OUTGOING",
            5,
            10_000);
    assertEquals(
        result.getNodes().get(0).getObject().getHandle(),
        relations.getObject().getHandle());
  }

  @Test
  void validatesDominatorTreeViewAndGraphBudgets()
      throws Exception {
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class),
            new FakeNativeAccess(new Node("root")));

    assertThrows(
        IllegalArgumentException.class,
        () -> controller.dominatorTree(
            0, 40, 5, 4, 100_000, 250_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.dominatorTree(
            3, 201, 5, 4, 100_000, 250_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.dominatorTree(
            3, 40, 21, 4, 100_000, 250_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.dominatorTree(
            3, 40, 5, 4, 9_999, 250_000));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.dominatorTree(
            3, 40, 5, 4, 100_000, 2_000_001));
  }

  @Test
  void aggregatesAndSortsABoundedHeapHistogram() throws Exception {
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(Node.class, String.class),
            new FakeNativeAccess());

    HeapInstanceController.HistogramResult result =
        controller.histogram(1, 100_000, "");

    assertEquals(2, result.getLoadedClasses());
    assertEquals(2, result.getCandidateClasses());
    assertEquals(2, result.getNonEmptyClasses());
    assertEquals(0, result.getSkippedTaggedClasses());
    assertEquals(123, result.getScannedObjects());
    assertFalse(result.isTruncated());
    assertFalse(result.isClassSelectionTruncated());
    assertEquals(5L, result.getAccountedObjects());
    assertEquals(272L, result.getAccountedBytes());
    assertEquals(1, result.getRows().size());
    assertEquals(
        Node.class.getName(),
        result.getRows().get(0).getClassName());
    assertEquals(3L, result.getRows().get(0).getInstanceCount());
    assertEquals(192L, result.getRows().get(0).getShallowBytes());
    assertEquals(
        64L, result.getRows().get(0).getAverageShallowBytes());

    assertThrows(
        IllegalArgumentException.class,
        () -> controller.histogram(0, 100_000, ""));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.histogram(201, 100_000, ""));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.histogram(10, 9_999, ""));
    assertThrows(
        IllegalArgumentException.class,
        () -> controller.histogram(10, 5_000_001, ""));
    assertEquals(
        0,
        controller.histogram(10, 100_000, "missing.Type").getRows().size());
  }

  @Test
  void identifiesExactJdkThreadPoolsAndClearsTemporaryTags()
      throws Exception {
    ThreadPoolExecutor executor =
        new ThreadPoolExecutor(
            1,
            4,
            30L,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<Runnable>(8));
    ScheduledThreadPoolExecutor scheduled =
        new ScheduledThreadPoolExecutor(2);
    ForkJoinPool forkJoin = new ForkJoinPool(3);
    Runnable queuedTask =
        new Runnable() {
          @Override
          public void run() {
            // The queue evidence reads only the task class and never runs it.
          }
        };
    executor.getQueue().add(queuedTask);
    executor.getQueue().add(queuedTask);
    FakeNativeAccess nativeAccess =
        new FakeNativeAccess(executor, scheduled, forkJoin);
    HeapInstanceController controller =
        new HeapInstanceController(
            instrumentation(
                ThreadPoolExecutor.class,
                ScheduledThreadPoolExecutor.class,
                ForkJoinPool.class),
            nativeAccess);
    try {
      HeapInstanceController.ThreadPoolResult result =
          controller.threadPools(12, 100, true, 100);

      assertEquals(3, result.getQueriedTypes());
      assertEquals(3, result.getPools().size());
      assertEquals(100, result.getRequestedMemberLimit());
      assertTrue(result.getScannedThreads() > 0);
      assertFalse(result.isTruncated());
      HeapInstanceController.ThreadPoolRow threadPool =
          result.getPools().stream()
              .filter(pool -> "THREAD_POOL".equals(pool.getKind()))
              .findFirst()
              .orElseThrow(
                  () ->
                      new AssertionError(
                          "ThreadPoolExecutor was not found"));
      assertEquals(1L, threadPool.getConfiguredSize());
      assertEquals(4L, threadPool.getMaximumSize());
      assertEquals(
          ArrayBlockingQueue.class.getName(),
          threadPool.getQueueType());
      assertEquals(6L, threadPool.getRemainingQueueCapacity());
      assertFalse(threadPool.getThreadFactoryType().isEmpty());
      assertEquals(
          ThreadPoolExecutor.AbortPolicy.class.getName(),
          threadPool.getRejectionHandlerType());
      assertTrue(threadPool.isQueueInspectionAvailable());
      assertEquals(2, threadPool.getQueueTasksScanned());
      assertFalse(threadPool.isQueueTasksTruncated());
      assertEquals(1, threadPool.getQueueTaskTypes().size());
      assertEquals(2, threadPool.getQueueTaskTypes().get(0).getCount());
      assertTrue(
          result.getPools().stream()
              .anyMatch(pool -> "SCHEDULED".equals(pool.getKind())));
      assertTrue(
          result.getPools().stream()
              .anyMatch(
                  pool ->
                      "FORK_JOIN".equals(pool.getKind())
                          && pool.getConfiguredSize() == 3L));
      assertTrue(nativeAccess.tags.isEmpty());
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.threadPools(2));
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.threadPools(21));
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.threadPools(12, 9));
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.threadPools(12, 201));
      assertThrows(
          IllegalArgumentException.class,
          () -> controller.threadPools(12, 100, true, 201));
    } finally {
      executor.shutdownNow();
      scheduled.shutdownNow();
      forkJoin.shutdownNow();
      controller.close();
    }
  }

  @Test
  void describesThreadPoolMembersWithoutGuessingOwnership() {
    ThreadGroup group = new ThreadGroup("integration-members");
    Thread member = new Thread(group, () -> {}, "worker-exact-1");
    member.setDaemon(true);
    member.setPriority(7);

    HeapInstanceController.ThreadPoolMember described =
        HeapInstanceController.describeThreadPoolMember(member);

    assertEquals(member.getId(), described.getThreadId());
    assertEquals("worker-exact-1", described.getName());
    assertEquals("integration-members", described.getGroupName());
    assertEquals("NEW", described.getState());
    assertTrue(described.isDaemon());
    assertEquals(7, described.getPriority());
    assertTrue(described.getTopFrame().isEmpty());
    assertTrue(described.getApplicationFrame().isEmpty());
    assertTrue(described.getBlockerType().isEmpty());
  }

  @Test
  void capturesBoundedMemberExecutionEvidenceWithoutInvokingApplicationCode() {
    HeapInstanceController.ThreadPoolMember described =
        HeapInstanceController.describeThreadPoolMember(
            Thread.currentThread(), true);

    assertFalse(described.getTopFrame().isEmpty());
    assertFalse(described.getApplicationFrame().isEmpty());
    assertFalse(described.getApplicationFrame().startsWith("java."));
  }

  private static Instrumentation instrumentation(
      Class<?>... loadedClasses) {
    return (Instrumentation)
        Proxy.newProxyInstance(
            HeapInstanceControllerTest.class.getClassLoader(),
            new Class<?>[] {Instrumentation.class},
            (proxy, method, arguments) -> {
              if ("getAllLoadedClasses".equals(method.getName())) {
                return loadedClasses;
              }
              if ("getObjectSize".equals(method.getName())) {
                return Long.valueOf(64L);
              }
              Class<?> returnType = method.getReturnType();
              if (returnType == boolean.class) {
                return Boolean.FALSE;
              }
              if (returnType == int.class) {
                return Integer.valueOf(0);
              }
              if (returnType == long.class) {
                return Long.valueOf(0L);
              }
              return null;
            });
  }

  private static String classLoaderName(Class<?> type) {
    ClassLoader loader = type.getClassLoader();
    return loader == null ? "bootstrap" : loader.toString();
  }

  private static final class Node {
    private final String name;
    private Node child;

    private Node(String name) {
      this.name = name;
    }
  }

  private static final class FakeNativeAccess
      implements HeapInstanceController.NativeAccess {
    private final Object[] instances;
    private final IdentityHashMap<Object, Long> tags =
        new IdentityHashMap<Object, Long>();
    private final Map<Long, Object> objects = new java.util.HashMap<Long, Object>();
    private final IdentityHashMap<Object, List<FakeEdge>> incoming =
        new IdentityHashMap<Object, List<FakeEdge>>();
    private Object[] rootPath = new Object[0];
    private Object[][] rootPaths = new Object[0][];
    private Object[] retainedContributors = new Object[0];
    private boolean retainedExact = true;

    private FakeNativeAccess(Object... instances) {
      this.instances = instances;
    }

    private void addReferrer(
        Object target, Object referrer, int kind, int index) {
      List<FakeEdge> edges = incoming.get(target);
      if (edges == null) {
        edges = new ArrayList<FakeEdge>();
        incoming.put(target, edges);
      }
      edges.add(new FakeEdge(referrer, kind, index));
    }

    private void setRootPath(Object... objects) {
      rootPath = objects;
    }

    private void setRootPaths(Object[]... paths) {
      rootPaths = paths;
    }

    private void setRetainedContributors(Object... objects) {
      retainedContributors = objects;
    }

    private void setRetainedExact(boolean exact) {
      retainedExact = exact;
    }

    @Override
    public Object[] collectInstances(
        Class<?> target, int limit, long tagBase) {
      List<Object> matches = new ArrayList<Object>();
      for (Object instance : instances) {
        if (instance != null
            && instance.getClass() == target
            && matches.size() < limit) {
          matches.add(instance);
        }
      }
      Object[] result = new Object[matches.size()];
      for (int index = 0; index < matches.size(); index++) {
        Object instance = matches.get(index);
        long tag = tagBase + (long) index;
        tags.put(instance, Long.valueOf(tag));
        objects.put(Long.valueOf(tag), instance);
        result[index] = instance;
      }
      return result;
    }

    @Override
    public long objectTag(Object object) {
      Long tag = tags.get(object);
      return tag == null ? 0L : tag.longValue();
    }

    @Override
    public long tagObjectIfAvailable(
        Object object, long candidateTag) {
      Long existing = tags.get(object);
      if (existing != null) {
        return existing.longValue();
      }
      tags.put(object, Long.valueOf(candidateTag));
      objects.put(Long.valueOf(candidateTag), object);
      return candidateTag;
    }

    @Override
    public Object resolveTaggedObject(long tag) {
      return objects.get(Long.valueOf(tag));
    }

    @Override
    public long[] collectReferrerEdges(
        Object target,
        int limit,
        long scanLimit,
        long tagBase,
        long tagPrefix) {
      List<FakeEdge> edges = incoming.get(target);
      if (edges == null || edges.isEmpty()) {
        return new long[] {12L, 0L};
      }
      int count = Math.min(limit, edges.size());
      long[] encoded = new long[2 + count * 3];
      encoded[0] = 12L;
      encoded[1] = edges.size() > count ? 1L : 0L;
      for (int index = 0; index < count; index++) {
        FakeEdge edge = edges.get(index);
        long tag = objectTag(edge.referrer);
        if (tag == 0L) {
          tag = tagObjectIfAvailable(edge.referrer, tagBase + index);
        }
        int offset = 2 + index * 3;
        encoded[offset] = tag;
        encoded[offset + 1] = edge.kind;
        encoded[offset + 2] = edge.index;
      }
      return encoded;
    }

    @Override
    public Object[] collectRootPath(
        long targetTag,
        int maximumDepth,
        int maximumNodes,
        long maximumEdges,
        long scanPrefix,
        long sessionPrefix) {
      Object target = objects.get(Long.valueOf(targetTag));
      if (rootPath.length == 0 || rootPath[0] != target) {
        return new Object[] {
          new Object[] {target},
          new long[] {42L, 1L, 0L, 0L, 1L, 0L, -1L}
        };
      }
      int count = Math.min(rootPath.length, maximumDepth + 1);
      Object[] path = new Object[count];
      System.arraycopy(rootPath, 0, path, 0, count);
      long[] metadata = new long[5 + count * 2];
      metadata[0] = 42L;
      metadata[1] = count < rootPath.length ? 1L : 0L;
      metadata[2] = count == rootPath.length ? 1L : 0L;
      metadata[3] = Math.max(0, count - 1);
      metadata[4] = count;
      for (int index = 0; index < count; index++) {
        metadata[5 + index * 2] =
            index + 1 == count ? 8L : 2L;
        metadata[6 + index * 2] = index;
      }
      return new Object[] {path, metadata};
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
      Object target = objects.get(Long.valueOf(targetTag));
      Object[][] configured =
          rootPaths.length == 0
              ? new Object[][] {new Object[] {target}}
              : rootPaths;
      int pathCount = Math.min(maximumPaths, configured.length);
      int objectCount = 0;
      int metadataCount = 6;
      for (int index = 0; index < pathCount; index++) {
        int count =
            Math.min(configured[index].length, maximumDepth + 1);
        objectCount += count;
        metadataCount += 2 + count * 2;
      }
      Object[] flattened = new Object[objectCount];
      long[] metadata = new long[metadataCount];
      metadata[0] = 84L;
      metadata[2] = Math.max(0, objectCount - pathCount);
      metadata[4] = configured.length > pathCount ? 1L : 0L;
      metadata[5] = pathCount;
      int objectIndex = 0;
      int metadataIndex = 6;
      for (int pathIndex = 0;
          pathIndex < pathCount;
          pathIndex++) {
        Object[] path = configured[pathIndex];
        int count = Math.min(path.length, maximumDepth + 1);
        metadata[metadataIndex++] = count;
        metadata[metadataIndex++] =
            count == path.length ? 1L : 0L;
        for (int nodeIndex = 0;
            nodeIndex < count;
            nodeIndex++) {
          flattened[objectIndex++] = path[nodeIndex];
          metadata[metadataIndex++] =
              nodeIndex + 1 == count ? 8L : 2L;
          metadata[metadataIndex++] = nodeIndex;
        }
      }
      return new Object[] {flattened, metadata};
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
      Object[] contributors =
          retainedContributors.length == 0
              ? new Object[] {target}
              : retainedContributors;
      long candidateBytes = contributors.length * 64L;
      long[] metadata = new long[15 + contributors.length];
      metadata[0] = 40L;
      metadata[1] = 80L;
      metadata[2] = Math.max(0, contributors.length - 1);
      metadata[6] = referenceClasses.length;
      boolean exact = referenceClassesComplete && retainedExact;
      metadata[7] = exact ? 1L : 0L;
      metadata[8] = exact ? 1L : 0L;
      metadata[9] = contributors.length + 1L;
      metadata[10] = candidateBytes + 64L;
      metadata[11] = contributors.length;
      metadata[12] = candidateBytes;
      metadata[13] = exact ? candidateBytes : -1L;
      metadata[14] = contributors.length;
      for (int index = 0; index < contributors.length; index++) {
        metadata[15 + index] = 64L;
      }
      return new Object[] {contributors, metadata};
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
      long[] metadata = new long[12 + targetTags.length * 5];
      metadata[0] = Math.min(maximumNodes, 128);
      metadata[1] = Math.min(maximumEdges, 256);
      metadata[6] = referenceClasses.length;
      boolean exact = referenceClassesComplete && retainedExact;
      metadata[7] = exact ? 1L : 0L;
      metadata[8] = exact ? 1L : 0L;
      metadata[9] = metadata[0];
      metadata[10] = 8_192L;
      metadata[11] = targetTags.length;
      for (int index = 0; index < targetTags.length; index++) {
        int offset = 12 + index * 5;
        long candidateBytes =
            (long) (targetTags.length - index) * 128L;
        metadata[offset] = objects.containsKey(
            Long.valueOf(targetTags[index])) ? 1L : 0L;
        metadata[offset + 1] = 64L;
        metadata[offset + 2] = targetTags.length - index;
        metadata[offset + 3] = candidateBytes;
        metadata[offset + 4] = exact ? candidateBytes : -1L;
      }
      return metadata;
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
      long[] metadata = new long[14 + classes.length * 5];
      metadata[0] = Math.min(maximumNodes, 256);
      metadata[1] = Math.min(maximumEdges, 512);
      metadata[6] = classes.length;
      metadata[8] = referenceSelectionComplete ? 1L : 0L;
      metadata[9] = classSelectionComplete ? 1L : 0L;
      boolean exact =
          retainedExact
              && classSelectionComplete
              && referenceSelectionComplete;
      metadata[10] = exact ? 1L : 0L;
      metadata[11] = metadata[0];
      metadata[12] = 16_384L;
      metadata[13] = classes.length;
      for (int index = 0; index < classes.length; index++) {
        Class<?> type = classes[index];
        int offset = 14 + index * 5;
        if (type == Node.class) {
          metadata[offset] = 3L;
          metadata[offset + 1] = 192L;
          metadata[offset + 2] = 6L;
          metadata[offset + 3] = 768L;
          metadata[offset + 4] = exact ? 768L : -1L;
        } else if (type == String.class) {
          metadata[offset] = 2L;
          metadata[offset + 1] = 80L;
          metadata[offset + 2] = 2L;
          metadata[offset + 3] = 80L;
          metadata[offset + 4] = exact ? 80L : -1L;
        } else {
          metadata[offset + 4] = exact ? 0L : -1L;
        }
      }
      return metadata;
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
      int count = Math.min(3, instances.length);
      Object[] selected = new Object[count];
      long[] metadata = new long[20 + count * 10];
      metadata[0] = Math.min(maximumNodes, 256);
      metadata[1] = Math.min(maximumEdges, 512);
      metadata[6] = classes.length;
      metadata[8] = referenceSelectionComplete ? 1L : 0L;
      metadata[9] = classSelectionComplete ? 1L : 0L;
      boolean exact =
          retainedExact
              && classSelectionComplete
              && referenceSelectionComplete;
      metadata[10] = exact ? 1L : 0L;
      metadata[11] = metadata[0];
      metadata[12] = 16_384L;
      metadata[13] = count;
      metadata[14] = maximumDepth;
      metadata[15] = maximumViewNodes;
      metadata[16] = rootLimit;
      metadata[17] = branchLimit;
      metadata[18] = count < instances.length ? 1L : 0L;
      metadata[19] = count > 0 ? 1L : 0L;
      for (int index = 0; index < count; index++) {
        Object object = instances[index];
        long tag = outputTagBase + index;
        tags.put(object, Long.valueOf(tag));
        objects.put(Long.valueOf(tag), object);
        selected[index] = object;
        int offset = 20 + index * 10;
        metadata[offset] = index == 0 ? -1L : 0L;
        metadata[offset + 1] = index == 0 ? 1L : 2L;
        metadata[offset + 2] = 64L;
        metadata[offset + 3] = index == 0 ? count : 1L;
        long candidateBytes =
            index == 0 ? count * 64L : 64L;
        metadata[offset + 4] = candidateBytes;
        metadata[offset + 5] = exact ? candidateBytes : -1L;
        metadata[offset + 6] = index == 0 ? count - 1L : 0L;
        metadata[offset + 7] = index == 0 ? count - 1L : 0L;
        metadata[offset + 8] = tag;
        metadata[offset + 9] = 1L;
      }
      return new Object[] {selected, metadata};
    }

    @Override
    public long[] collectHeapHistogram(
        Class<?>[] classes,
        long scanLimit,
        long tagPrefix,
        long sessionPrefix) {
      long[] encoded = new long[3 + classes.length * 2];
      encoded[0] = 123L;
      for (int index = 0; index < classes.length; index++) {
        Class<?> type = classes[index];
        int offset = 3 + index * 2;
        if (type == Node.class) {
          encoded[offset] = 3L;
          encoded[offset + 1] = 192L;
        } else if (type == String.class) {
          encoded[offset] = 2L;
          encoded[offset + 1] = 80L;
        }
      }
      return encoded;
    }

    @Override
    public void clearObjectTag(long tag) {
      Object object = objects.remove(Long.valueOf(tag));
      if (object != null) {
        tags.remove(object);
      }
    }
  }

  private static final class FakeEdge {
    private final Object referrer;
    private final int kind;
    private final int index;

    private FakeEdge(Object referrer, int kind, int index) {
      this.referrer = referrer;
      this.kind = kind;
      this.index = index;
    }
  }
}
