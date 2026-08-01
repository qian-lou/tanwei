#include <jni.h>
#include <jvmti.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define TANWEI_MAXIMUM_RELATIONS 50
#define TANWEI_MAXIMUM_ROOT_DEPTH 32
#define TANWEI_MAXIMUM_ROOT_NODES 100000
#define TANWEI_MAXIMUM_ROOT_EDGES 1000000
#define TANWEI_MAXIMUM_ROOT_PATHS 8
#define TANWEI_MAXIMUM_ROOT_ENUMERATION_STEPS 100000
#define TANWEI_MAXIMUM_SESSION_HANDLES 256
#define TANWEI_MAXIMUM_REFERENCE_CLASSES 256
#define TANWEI_MAXIMUM_RETAINED_CONTRIBUTORS 20
#define TANWEI_MAXIMUM_DOMINATOR_NODES 500000
#define TANWEI_MAXIMUM_DOMINATOR_EDGES 2000000
#define TANWEI_MAXIMUM_RETAINED_TARGETS 20
#define TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES 200
#define TANWEI_MAXIMUM_DOMINATOR_VIEW_DEPTH 8
#define TANWEI_MAXIMUM_DOMINATOR_VIEW_BRANCHES 20
#define TANWEI_MAXIMUM_HISTOGRAM_CLASSES 50000
#define TANWEI_MAXIMUM_HISTOGRAM_OBJECTS 5000000
#define TANWEI_TAG_PREFIX_MASK ((jlong)INT64_C(0x7FFF000000000000))
#define TANWEI_TAG_COUNTER_MASK ((jlong)INT64_C(0x0000FFFFFFFFFFFF))

static JavaVM *tanwei_vm = NULL;
static jvmtiEnv *tanwei_jvmti = NULL;

typedef struct {
  jlong tag_base;
  jint limit;
  jint tagged;
} tanwei_heap_query;

typedef struct {
  jlong target_tag;
  jlong tag_base;
  jlong tag_prefix;
  jint limit;
  jlong scan_limit;
  jlong visited;
  jint new_tags;
  jint found;
  jint truncated;
  jlong tags[TANWEI_MAXIMUM_RELATIONS];
  jint kinds[TANWEI_MAXIMUM_RELATIONS];
  jint indices[TANWEI_MAXIMUM_RELATIONS];
} tanwei_referrer_query;

typedef struct {
  jlong target_tag;
  jlong session_prefix;
  jlong scan_prefix;
  jint maximum_nodes;
  jlong maximum_edges;
  jlong visited;
  jint tagged;
  jint truncated;
  jint node_limit_reached;
  jint found;
  jlong target_parent;
  jint target_kind;
  jint target_index;
  jint tag_conflicts;
  jlong *parents;
  jint *kinds;
  jint *indices;
  unsigned char *parent_known;
  jint session_count;
  jlong session_tags[TANWEI_MAXIMUM_SESSION_HANDLES];
  jlong session_parents[TANWEI_MAXIMUM_SESSION_HANDLES];
  jint session_kinds[TANWEI_MAXIMUM_SESSION_HANDLES];
  jint session_indices[TANWEI_MAXIMUM_SESSION_HANDLES];
  unsigned char session_parent_known[TANWEI_MAXIMUM_SESSION_HANDLES];
  jint maximum_paths;
  jlong target_parents[TANWEI_MAXIMUM_ROOT_PATHS];
  jint target_kinds[TANWEI_MAXIMUM_ROOT_PATHS];
  jint target_indices[TANWEI_MAXIMUM_ROOT_PATHS];
  unsigned char target_parent_count;
  unsigned char target_parent_overflow;
  jlong *multi_parents;
  jint *multi_kinds;
  jint *multi_indices;
  unsigned char *multi_parent_counts;
  unsigned char *multi_parent_overflow;
  jlong
      session_multi_parents[
          TANWEI_MAXIMUM_SESSION_HANDLES
          * TANWEI_MAXIMUM_ROOT_PATHS];
  jint
      session_multi_kinds[
          TANWEI_MAXIMUM_SESSION_HANDLES
          * TANWEI_MAXIMUM_ROOT_PATHS];
  jint
      session_multi_indices[
          TANWEI_MAXIMUM_SESSION_HANDLES
          * TANWEI_MAXIMUM_ROOT_PATHS];
  unsigned char
      session_multi_parent_counts[TANWEI_MAXIMUM_SESSION_HANDLES];
  unsigned char
      session_multi_parent_overflow[TANWEI_MAXIMUM_SESSION_HANDLES];
} tanwei_root_path_query;

typedef struct {
  jint count;
  jint root_reached;
  jlong tags[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
  jint kinds[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
  jint indices[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
} tanwei_root_path_result;

typedef struct {
  tanwei_root_path_query *query;
  jint maximum_depth;
  jint roots_only;
  jint result_count;
  jint path_limit_reached;
  jint enumeration_truncated;
  jlong enumeration_steps;
  tanwei_root_path_result results[TANWEI_MAXIMUM_ROOT_PATHS];
} tanwei_root_paths_enumerator;

typedef struct {
  jlong tag_prefix;
  jint class_count;
  jlong scan_limit;
  jlong scanned;
  jint truncated;
  jlong *counts;
  jlong *bytes;
} tanwei_heap_histogram;

typedef struct {
  jlong target_tag;
  jlong target_size;
  jlong session_prefix;
  jlong scan_prefix;
  jlong reference_prefix;
  jint maximum_nodes;
  jlong maximum_edges;
  jlong closure_edges;
  jlong root_edges;
  jint tagged;
  jint tag_conflicts;
  jint closure_truncated;
  jint root_truncated;
  jlong *sizes;
  unsigned char *externally_reachable;
  jint session_count;
  jlong session_tags[TANWEI_MAXIMUM_SESSION_HANDLES];
  jlong session_sizes[TANWEI_MAXIMUM_SESSION_HANDLES];
  unsigned char
      session_externally_reachable[TANWEI_MAXIMUM_SESSION_HANDLES];
  jint reference_class_count;
  jint *referent_field_indices;
  jint weak_semantics_complete;
} tanwei_retained_query;

typedef struct {
  jlong session_prefix;
  jlong scan_prefix;
  jlong reference_prefix;
  jint class_count;
  jint maximum_nodes;
  jint maximum_edges;
  jint node_count;
  jint edge_count;
  jint tag_conflicts;
  jint truncated;
  jint node_limit_reached;
  jint edge_limit_reached;
  jlong *sizes;
  jint *class_ids;
  jint *edge_sources;
  jint *edge_targets;
  jint session_count;
  jlong session_tags[TANWEI_MAXIMUM_SESSION_HANDLES];
  jint session_nodes[TANWEI_MAXIMUM_SESSION_HANDLES];
  jint target_count;
  jint reference_class_count;
  jint *referent_field_indices;
  jint weak_semantics_complete;
} tanwei_dominator_query;

static void throw_illegal_state(JNIEnv *jni, const char *message) {
  jclass type = (*jni)->FindClass(jni, "java/lang/IllegalStateException");
  if (type != NULL) {
    (*jni)->ThrowNew(jni, type, message);
  }
}

static int tag_range_available(jlong tag_base, jint count) {
  jlong *tags;
  jobject *objects = NULL;
  jint found = 0;
  jint index;
  jvmtiError error;
  int available;

  if (tanwei_jvmti == NULL || tag_base <= 0 || count < 1) {
    return 0;
  }
  tags = (jlong *)malloc(sizeof(jlong) * (size_t)count);
  if (tags == NULL) {
    return 0;
  }
  for (index = 0; index < count; index += 1) {
    tags[index] = tag_base + (jlong)index;
  }
  error = (*tanwei_jvmti)->GetObjectsWithTags(
      tanwei_jvmti,
      count,
      tags,
      &found,
      &objects,
      NULL);
  free(tags);
  available = error == JVMTI_ERROR_NONE && found == 0;
  if (objects != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)objects);
  }
  return available;
}

static jlong saturating_add(jlong left, jlong right) {
  if (right <= 0) {
    return left;
  }
  return left > INT64_MAX - right ? INT64_MAX : left + right;
}

static jint JNICALL tag_instance(
    jlong class_tag,
    jlong size,
    jlong *tag_ptr,
    jint length,
    void *user_data) {
  tanwei_heap_query *query = (tanwei_heap_query *)user_data;
  (void)class_tag;
  (void)size;
  (void)length;
  if (tag_ptr == NULL || query->tagged >= query->limit) {
    return JVMTI_VISIT_ABORT;
  }
  *tag_ptr = query->tag_base + (jlong)query->tagged;
  query->tagged += 1;
  return query->tagged >= query->limit
      ? JVMTI_VISIT_ABORT
      : JVMTI_VISIT_OBJECTS;
}

static jint JNICALL collect_heap_histogram(
    jlong class_tag,
    jlong size,
    jlong *tag_ptr,
    jint length,
    void *user_data) {
  tanwei_heap_histogram *histogram =
      (tanwei_heap_histogram *)user_data;
  jlong class_id;
  (void)tag_ptr;
  (void)length;
  if (histogram == NULL) {
    return JVMTI_VISIT_ABORT;
  }
  histogram->scanned += 1;
  if ((class_tag & TANWEI_TAG_PREFIX_MASK)
      == histogram->tag_prefix) {
    class_id = class_tag & TANWEI_TAG_COUNTER_MASK;
    if (class_id > 0 && class_id <= histogram->class_count) {
      histogram->counts[class_id] += 1;
      if (size > 0
          && histogram->bytes[class_id] <= INT64_MAX - size) {
        histogram->bytes[class_id] += size;
      } else if (size > 0) {
        histogram->bytes[class_id] = INT64_MAX;
      }
    }
  }
  if (histogram->scanned >= histogram->scan_limit) {
    histogram->truncated = 1;
    return JVMTI_VISIT_ABORT;
  }
  return JVMTI_VISIT_OBJECTS;
}

static jint reference_index(
    jvmtiHeapReferenceKind kind,
    const jvmtiHeapReferenceInfo *info) {
  if (info == NULL) {
    return -1;
  }
  switch (kind) {
    case JVMTI_HEAP_REFERENCE_FIELD:
    case JVMTI_HEAP_REFERENCE_STATIC_FIELD:
      return info->field.index;
    case JVMTI_HEAP_REFERENCE_ARRAY_ELEMENT:
      return info->array.index;
    case JVMTI_HEAP_REFERENCE_CONSTANT_POOL:
      return info->constant_pool.index;
    case JVMTI_HEAP_REFERENCE_STACK_LOCAL:
      return info->stack_local.slot;
    default:
      return -1;
  }
}

static jint JNICALL collect_referrer(
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info,
    jlong class_tag,
    jlong referrer_class_tag,
    jlong size,
    jlong *tag_ptr,
    jlong *referrer_tag_ptr,
    jint length,
    void *user_data) {
  tanwei_referrer_query *query = (tanwei_referrer_query *)user_data;
  jlong referrer_tag;
  (void)class_tag;
  (void)referrer_class_tag;
  (void)size;
  (void)length;

  query->visited += 1;
  if (tag_ptr != NULL
      && *tag_ptr == query->target_tag
      && referrer_tag_ptr != NULL
      && query->found < query->limit) {
    referrer_tag = *referrer_tag_ptr;
    if (referrer_tag == 0) {
      referrer_tag = query->tag_base + (jlong)query->new_tags;
      query->new_tags += 1;
      *referrer_tag_ptr = referrer_tag;
    } else if ((referrer_tag & TANWEI_TAG_PREFIX_MASK)
        != query->tag_prefix) {
      referrer_tag = 0;
    }
    if (referrer_tag != 0) {
      query->tags[query->found] = referrer_tag;
      query->kinds[query->found] = (jint)reference_kind;
      query->indices[query->found] =
          reference_index(reference_kind, reference_info);
      query->found += 1;
    }
  }

  if (query->found >= query->limit
      || query->visited >= query->scan_limit) {
    query->truncated = 1;
    return JVMTI_VISIT_ABORT;
  }
  return JVMTI_VISIT_OBJECTS;
}

static jint root_path_node_id(
    const tanwei_root_path_query *query,
    jlong tag) {
  jlong node_id;
  if (query == NULL
      || tag <= 0
      || (tag & TANWEI_TAG_PREFIX_MASK) != query->scan_prefix) {
    return 0;
  }
  node_id = tag & TANWEI_TAG_COUNTER_MASK;
  if (node_id <= 0
      || node_id > query->tagged
      || node_id > query->maximum_nodes) {
    return 0;
  }
  return (jint)node_id;
}

static jint root_path_session_index(
    const tanwei_root_path_query *query,
    jlong tag) {
  jint index;
  if (query == NULL
      || tag <= 0
      || (tag & TANWEI_TAG_PREFIX_MASK) != query->session_prefix) {
    return -1;
  }
  for (index = 0; index < query->session_count; index += 1) {
    if (query->session_tags[index] == tag) {
      return index;
    }
  }
  return -1;
}

static jint root_path_register_session_tag(
    tanwei_root_path_query *query,
    jlong tag) {
  jint index = root_path_session_index(query, tag);
  if (index >= 0) {
    return index;
  }
  if (query == NULL
      || tag <= 0
      || (tag & TANWEI_TAG_PREFIX_MASK) != query->session_prefix
      || query->session_count >= TANWEI_MAXIMUM_SESSION_HANDLES) {
    return -1;
  }
  index = query->session_count++;
  query->session_tags[index] = tag;
  query->session_indices[index] = -1;
  return index;
}

static jlong root_path_tag_object(
    tanwei_root_path_query *query,
    jlong *tag_ptr) {
  jint node_id;
  if (query == NULL || tag_ptr == NULL) {
    return 0;
  }
  if (*tag_ptr != 0) {
    if (root_path_node_id(query, *tag_ptr) > 0) {
      return *tag_ptr;
    }
    if (root_path_register_session_tag(query, *tag_ptr) >= 0) {
      return *tag_ptr;
    }
    query->tag_conflicts += 1;
    query->truncated = 1;
    return 0;
  }
  if (query->tagged >= query->maximum_nodes) {
    query->truncated = 1;
    query->node_limit_reached = 1;
    return 0;
  }
  node_id = ++query->tagged;
  *tag_ptr = query->scan_prefix | (jlong)node_id;
  return *tag_ptr;
}

static int root_path_parent_is_known(
    const tanwei_root_path_query *query,
    jlong parent_tag) {
  jint parent_id;
  if (parent_tag == 0) {
    return 1;
  }
  parent_id = root_path_node_id(query, parent_tag);
  if (parent_id > 0) {
    return query->parent_known[parent_id] != 0;
  }
  parent_id = root_path_session_index(query, parent_tag);
  return parent_id >= 0
      && query->session_parent_known[parent_id] != 0;
}

static void root_path_record_parent(
    tanwei_root_path_query *query,
    jlong child_tag,
    jlong parent_tag,
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info) {
  jint child_id;
  jint session_index;
  if (query == NULL
      || !root_path_parent_is_known(query, parent_tag)) {
    return;
  }
  if (child_tag == query->target_tag) {
    if (!query->found) {
      query->target_parent = parent_tag;
      query->target_kind = (jint)reference_kind;
      query->target_index =
          reference_index(reference_kind, reference_info);
      query->found = 1;
    }
    return;
  }
  child_id = root_path_node_id(query, child_tag);
  if (child_id > 0) {
    if (query->parent_known[child_id] != 0) {
      return;
    }
    query->parents[child_id] = parent_tag;
    query->kinds[child_id] = (jint)reference_kind;
    query->indices[child_id] =
        reference_index(reference_kind, reference_info);
    query->parent_known[child_id] = 1;
    return;
  }
  session_index = root_path_session_index(query, child_tag);
  if (session_index < 0
      || query->session_parent_known[session_index] != 0) {
    return;
  }
  query->session_parents[session_index] = parent_tag;
  query->session_kinds[session_index] = (jint)reference_kind;
  query->session_indices[session_index] =
      reference_index(reference_kind, reference_info);
  query->session_parent_known[session_index] = 1;
}

static jint JNICALL collect_root_path(
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info,
    jlong class_tag,
    jlong referrer_class_tag,
    jlong size,
    jlong *tag_ptr,
    jlong *referrer_tag_ptr,
    jint length,
    void *user_data) {
  tanwei_root_path_query *query =
      (tanwei_root_path_query *)user_data;
  jlong child_tag;
  jlong parent_tag = 0;
  (void)class_tag;
  (void)referrer_class_tag;
  (void)size;
  (void)length;

  if (query == NULL) {
    return JVMTI_VISIT_ABORT;
  }
  query->visited += 1;
  if (tag_ptr == NULL) {
    if (query->visited >= query->maximum_edges) {
      query->truncated = 1;
      return JVMTI_VISIT_ABORT;
    }
    return JVMTI_VISIT_OBJECTS;
  }

  if (*tag_ptr == query->target_tag) {
    child_tag = query->target_tag;
  } else {
    child_tag = root_path_tag_object(query, tag_ptr);
  }

  if (referrer_tag_ptr != NULL) {
    parent_tag = root_path_tag_object(query, referrer_tag_ptr);
  }
  if (child_tag != 0
      && (referrer_tag_ptr == NULL || parent_tag != 0)) {
    root_path_record_parent(
        query,
        child_tag,
        parent_tag,
        reference_kind,
        reference_info);
  }

  if (query->found) {
    return JVMTI_VISIT_ABORT;
  }
  if (query->node_limit_reached
      || query->visited >= query->maximum_edges) {
    query->truncated = 1;
    return JVMTI_VISIT_ABORT;
  }
  return JVMTI_VISIT_OBJECTS;
}

static int root_paths_parent_is_known(
    const tanwei_root_path_query *query,
    jlong parent_tag) {
  jint index;
  if (parent_tag == 0) {
    return 1;
  }
  index = root_path_node_id(query, parent_tag);
  if (index > 0) {
    return query->multi_parent_counts[index] > 0;
  }
  index = root_path_session_index(query, parent_tag);
  return index >= 0
      && query->session_multi_parent_counts[index] > 0;
}

static void root_paths_add_parent(
    tanwei_root_path_query *query,
    jlong child_tag,
    jlong parent_tag,
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info) {
  jlong *parents = NULL;
  jint *kinds = NULL;
  jint *indices = NULL;
  unsigned char *count = NULL;
  unsigned char *overflow = NULL;
  jint child_id;
  jint session_index;
  jint index;
  jint reference_index_value;

  if (query == NULL
      || !root_paths_parent_is_known(query, parent_tag)) {
    return;
  }
  reference_index_value =
      reference_index(reference_kind, reference_info);
  if (child_tag == query->target_tag) {
    parents = query->target_parents;
    kinds = query->target_kinds;
    indices = query->target_indices;
    count = &query->target_parent_count;
    overflow = &query->target_parent_overflow;
  } else {
    child_id = root_path_node_id(query, child_tag);
    if (child_id > 0) {
      size_t offset =
          (size_t)child_id * TANWEI_MAXIMUM_ROOT_PATHS;
      parents = query->multi_parents + offset;
      kinds = query->multi_kinds + offset;
      indices = query->multi_indices + offset;
      count = &query->multi_parent_counts[child_id];
      overflow = &query->multi_parent_overflow[child_id];
    } else {
      session_index =
          root_path_session_index(query, child_tag);
      if (session_index < 0) {
        return;
      }
      index = session_index * TANWEI_MAXIMUM_ROOT_PATHS;
      parents = query->session_multi_parents + index;
      kinds = query->session_multi_kinds + index;
      indices = query->session_multi_indices + index;
      count =
          &query->session_multi_parent_counts[session_index];
      overflow =
          &query->session_multi_parent_overflow[session_index];
    }
  }
  for (index = 0; index < (jint)*count; index += 1) {
    if (parents[index] == parent_tag
        && kinds[index] == (jint)reference_kind
        && indices[index] == reference_index_value) {
      return;
    }
  }
  if (parent_tag == 0) {
    jint last =
        *count < TANWEI_MAXIMUM_ROOT_PATHS
            ? (jint)(*count)
            : TANWEI_MAXIMUM_ROOT_PATHS - 1;
    if (*count >= TANWEI_MAXIMUM_ROOT_PATHS) {
      *overflow = 1;
    } else {
      *count += 1;
    }
    for (index = last; index > 0; index -= 1) {
      parents[index] = parents[index - 1];
      kinds[index] = kinds[index - 1];
      indices[index] = indices[index - 1];
    }
    parents[0] = parent_tag;
    kinds[0] = (jint)reference_kind;
    indices[0] = reference_index_value;
    return;
  }
  if (*count >= TANWEI_MAXIMUM_ROOT_PATHS) {
    *overflow = 1;
    return;
  }
  index = (jint)(*count);
  parents[index] = parent_tag;
  kinds[index] = (jint)reference_kind;
  indices[index] = reference_index_value;
  *count += 1;
}

static jint JNICALL collect_root_paths(
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info,
    jlong class_tag,
    jlong referrer_class_tag,
    jlong size,
    jlong *tag_ptr,
    jlong *referrer_tag_ptr,
    jint length,
    void *user_data) {
  tanwei_root_path_query *query =
      (tanwei_root_path_query *)user_data;
  jlong child_tag;
  jlong parent_tag = 0;
  int target_edge;
  (void)class_tag;
  (void)referrer_class_tag;
  (void)size;
  (void)length;

  if (query == NULL) {
    return JVMTI_VISIT_ABORT;
  }
  query->visited += 1;
  if (query->visited >= query->maximum_edges) {
    query->truncated = 1;
  }
  if (tag_ptr == NULL) {
    return query->visited >= query->maximum_edges
        ? JVMTI_VISIT_ABORT
        : JVMTI_VISIT_OBJECTS;
  }

  target_edge = *tag_ptr == query->target_tag;
  child_tag =
      target_edge
          ? query->target_tag
          : root_path_tag_object(query, tag_ptr);
  if (referrer_tag_ptr != NULL) {
    parent_tag = root_path_tag_object(query, referrer_tag_ptr);
  }
  if (child_tag != 0
      && (referrer_tag_ptr == NULL || parent_tag != 0)) {
    root_paths_add_parent(
        query,
        child_tag,
        parent_tag,
        reference_kind,
        reference_info);
  }

  if (query->node_limit_reached
      || query->visited >= query->maximum_edges) {
    query->truncated = 1;
    return JVMTI_VISIT_ABORT;
  }
  if (target_edge) {
    /* The target's descendants do not lead to additional root paths. */
    return 0;
  }
  return JVMTI_VISIT_OBJECTS;
}

static int root_paths_contains(
    const jlong *tags, jint count, jlong tag) {
  jint index;
  for (index = 0; index < count; index += 1) {
    if (tags[index] == tag) {
      return 1;
    }
  }
  return 0;
}

static void root_paths_store_result(
    tanwei_root_paths_enumerator *enumerator,
    const jlong *tags,
    const jint *kinds,
    const jint *indices,
    jint count,
    jint root_reached) {
  tanwei_root_path_result *result;
  jint result_index;
  if (enumerator == NULL
      || tags == NULL
      || kinds == NULL
      || indices == NULL
      || count < 1) {
    return;
  }
  for (result_index = 0;
      result_index < enumerator->result_count;
      result_index += 1) {
    result = &enumerator->results[result_index];
    if (result->count == count
        && result->root_reached == root_reached
        && memcmp(
                result->tags,
                tags,
                (size_t)count * sizeof(jlong))
            == 0
        && memcmp(
                result->kinds,
                kinds,
                (size_t)count * sizeof(jint))
            == 0
        && memcmp(
                result->indices,
                indices,
                (size_t)count * sizeof(jint))
            == 0) {
      return;
    }
  }
  if (enumerator->result_count
      >= enumerator->query->maximum_paths) {
    enumerator->path_limit_reached = 1;
    return;
  }
  result = &enumerator->results[enumerator->result_count++];
  result->count = count;
  result->root_reached = root_reached;
  memcpy(result->tags, tags, (size_t)count * sizeof(jlong));
  memcpy(result->kinds, kinds, (size_t)count * sizeof(jint));
  memcpy(
      result->indices,
      indices,
      (size_t)count * sizeof(jint));
}

static void root_paths_enumerate(
    tanwei_root_paths_enumerator *enumerator,
    jlong current_tag,
    jint depth,
    jlong *path_tags,
    jint *path_kinds,
    jint *path_indices) {
  tanwei_root_path_query *query;
  const jlong *parents = NULL;
  const jint *kinds = NULL;
  const jint *indices = NULL;
  jint count = 0;
  jint overflow = 0;
  jint node_id;
  jint session_index;
  jint index;
  jint usable_edges = 0;

  if (enumerator == NULL
      || enumerator->path_limit_reached
      || current_tag <= 0
      || depth < 0
      || depth > enumerator->maximum_depth) {
    return;
  }
  enumerator->enumeration_steps += 1;
  if (enumerator->enumeration_steps
      > TANWEI_MAXIMUM_ROOT_ENUMERATION_STEPS) {
    enumerator->enumeration_truncated = 1;
    return;
  }
  query = enumerator->query;
  if (current_tag == query->target_tag) {
    parents = query->target_parents;
    kinds = query->target_kinds;
    indices = query->target_indices;
    count = (jint)query->target_parent_count;
    overflow = query->target_parent_overflow != 0;
  } else {
    node_id = root_path_node_id(query, current_tag);
    if (node_id > 0) {
      size_t offset =
          (size_t)node_id * TANWEI_MAXIMUM_ROOT_PATHS;
      parents = query->multi_parents + offset;
      kinds = query->multi_kinds + offset;
      indices = query->multi_indices + offset;
      count = (jint)query->multi_parent_counts[node_id];
      overflow = query->multi_parent_overflow[node_id] != 0;
    } else {
      session_index =
          root_path_session_index(query, current_tag);
      if (session_index >= 0) {
        index = session_index * TANWEI_MAXIMUM_ROOT_PATHS;
        parents = query->session_multi_parents + index;
        kinds = query->session_multi_kinds + index;
        indices = query->session_multi_indices + index;
        count =
            (jint)query
                ->session_multi_parent_counts[session_index];
        overflow =
            query->session_multi_parent_overflow[session_index]
                != 0;
      }
    }
  }
  if (overflow) {
    enumerator->enumeration_truncated = 1;
  }
  if (parents == NULL || count < 1) {
    if (enumerator->roots_only) {
      enumerator->enumeration_truncated = 1;
      return;
    }
    path_tags[depth] = current_tag;
    path_kinds[depth] = 0;
    path_indices[depth] = -1;
    enumerator->enumeration_truncated = 1;
    root_paths_store_result(
        enumerator,
        path_tags,
        path_kinds,
        path_indices,
        depth + 1,
        0);
    return;
  }

  path_tags[depth] = current_tag;
  for (index = 0; index < count; index += 1) {
    jlong parent_tag = parents[index];
    if (parent_tag != 0
        && root_paths_contains(
            path_tags, depth + 1, parent_tag)) {
      enumerator->enumeration_truncated = 1;
      continue;
    }
    usable_edges += 1;
    path_kinds[depth] = kinds[index];
    path_indices[depth] = indices[index];
    if (parent_tag == 0) {
      if (!enumerator->roots_only
          || depth == enumerator->maximum_depth) {
        root_paths_store_result(
            enumerator,
            path_tags,
            path_kinds,
            path_indices,
            depth + 1,
            1);
      }
    } else if (depth >= enumerator->maximum_depth) {
      if (!enumerator->roots_only) {
        enumerator->enumeration_truncated = 1;
        root_paths_store_result(
            enumerator,
            path_tags,
            path_kinds,
            path_indices,
            depth + 1,
            0);
      }
    } else {
      root_paths_enumerate(
          enumerator,
          parent_tag,
          depth + 1,
          path_tags,
          path_kinds,
          path_indices);
    }
    if (enumerator->path_limit_reached) {
      return;
    }
  }
  if (usable_edges == 0 && !enumerator->roots_only) {
    path_tags[depth] = current_tag;
    path_kinds[depth] = 0;
    path_indices[depth] = -1;
    root_paths_store_result(
        enumerator,
        path_tags,
        path_kinds,
        path_indices,
        depth + 1,
        0);
  }
}

static jint retained_node_id(
    const tanwei_retained_query *query,
    jlong tag) {
  jlong node_id;
  if (query == NULL
      || tag <= 0
      || (tag & TANWEI_TAG_PREFIX_MASK) != query->scan_prefix) {
    return 0;
  }
  node_id = tag & TANWEI_TAG_COUNTER_MASK;
  if (node_id <= 0
      || node_id > query->tagged
      || node_id > query->maximum_nodes) {
    return 0;
  }
  return (jint)node_id;
}

static jint retained_session_index(
    const tanwei_retained_query *query,
    jlong tag) {
  jint index;
  if (query == NULL
      || tag <= 0
      || (tag & TANWEI_TAG_PREFIX_MASK) != query->session_prefix) {
    return -1;
  }
  for (index = 0; index < query->session_count; index += 1) {
    if (query->session_tags[index] == tag) {
      return index;
    }
  }
  return -1;
}

static jint retained_register_session_tag(
    tanwei_retained_query *query,
    jlong tag,
    jlong size) {
  jint index = retained_session_index(query, tag);
  if (index >= 0) {
    return index;
  }
  if (query == NULL
      || tag <= 0
      || (tag & TANWEI_TAG_PREFIX_MASK) != query->session_prefix
      || query->session_count >= TANWEI_MAXIMUM_SESSION_HANDLES) {
    return -1;
  }
  index = query->session_count++;
  query->session_tags[index] = tag;
  query->session_sizes[index] = size > 0 ? size : 0;
  return index;
}

static int retained_is_weak_reference(
    const tanwei_retained_query *query,
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info,
    jlong referrer_class_tag) {
  jlong class_id;
  if (query == NULL
      || reference_kind != JVMTI_HEAP_REFERENCE_FIELD
      || reference_info == NULL
      || referrer_class_tag <= 0
      || (referrer_class_tag & TANWEI_TAG_PREFIX_MASK)
          != query->reference_prefix) {
    return 0;
  }
  class_id = referrer_class_tag & TANWEI_TAG_COUNTER_MASK;
  return class_id > 0
      && class_id <= query->reference_class_count
      && query->referent_field_indices[class_id - 1]
          == reference_info->field.index;
}

static jint JNICALL collect_retained_closure(
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info,
    jlong class_tag,
    jlong referrer_class_tag,
    jlong size,
    jlong *tag_ptr,
    jlong *referrer_tag_ptr,
    jint length,
    void *user_data) {
  tanwei_retained_query *query =
      (tanwei_retained_query *)user_data;
  jlong tag;
  jint node_id;
  (void)class_tag;
  (void)referrer_tag_ptr;
  (void)length;

  if (query == NULL) {
    return JVMTI_VISIT_ABORT;
  }
  query->closure_edges += 1;
  if (query->closure_edges >= query->maximum_edges) {
    query->closure_truncated = 1;
  }
  if (retained_is_weak_reference(
      query,
      reference_kind,
      reference_info,
      referrer_class_tag)) {
    return query->closure_edges >= query->maximum_edges
        ? JVMTI_VISIT_ABORT
        : 0;
  }
  if (reference_kind == JVMTI_HEAP_REFERENCE_CLASS) {
    return query->closure_edges >= query->maximum_edges
        ? JVMTI_VISIT_ABORT
        : 0;
  }
  if (tag_ptr == NULL) {
    return query->closure_edges >= query->maximum_edges
        ? JVMTI_VISIT_ABORT
        : JVMTI_VISIT_OBJECTS;
  }

  tag = *tag_ptr;
  if (tag == 0) {
    if (query->tagged >= query->maximum_nodes) {
      query->closure_truncated = 1;
      return JVMTI_VISIT_ABORT;
    }
    node_id = ++query->tagged;
    tag = query->scan_prefix | (jlong)node_id;
    *tag_ptr = tag;
    query->sizes[node_id] = size > 0 ? size : 0;
  } else if (tag == query->target_tag) {
    /* The target is already counted through its JNI local reference. */
  } else if (retained_node_id(query, tag) > 0) {
    /* Already part of the selected object's reachable closure. */
  } else if ((tag & TANWEI_TAG_PREFIX_MASK)
      == query->session_prefix) {
    if (retained_register_session_tag(query, tag, size) < 0) {
      query->tag_conflicts += 1;
    }
  } else {
    query->tag_conflicts += 1;
  }

  if (query->closure_edges >= query->maximum_edges) {
    query->closure_truncated = 1;
    return JVMTI_VISIT_ABORT;
  }
  return JVMTI_VISIT_OBJECTS;
}

static jint JNICALL collect_retained_external_reachability(
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info,
    jlong class_tag,
    jlong referrer_class_tag,
    jlong size,
    jlong *tag_ptr,
    jlong *referrer_tag_ptr,
    jint length,
    void *user_data) {
  tanwei_retained_query *query =
      (tanwei_retained_query *)user_data;
  jint index;
  (void)class_tag;
  (void)size;
  (void)referrer_tag_ptr;
  (void)length;

  if (query == NULL) {
    return JVMTI_VISIT_ABORT;
  }
  query->root_edges += 1;
  if (query->root_edges >= query->maximum_edges) {
    query->root_truncated = 1;
  }
  if (retained_is_weak_reference(
      query,
      reference_kind,
      reference_info,
      referrer_class_tag)) {
    return query->root_edges >= query->maximum_edges
        ? JVMTI_VISIT_ABORT
        : 0;
  }
  if (tag_ptr != NULL) {
    if (*tag_ptr == query->target_tag) {
      return query->root_edges >= query->maximum_edges
          ? JVMTI_VISIT_ABORT
          : 0;
    }
    index = retained_node_id(query, *tag_ptr);
    if (index > 0) {
      query->externally_reachable[index] = 1;
    } else {
      index = retained_session_index(query, *tag_ptr);
      if (index >= 0) {
        query->session_externally_reachable[index] = 1;
      }
    }
  }
  if (query->root_edges >= query->maximum_edges) {
    query->root_truncated = 1;
    return JVMTI_VISIT_ABORT;
  }
  return JVMTI_VISIT_OBJECTS;
}

static jint dominator_node_id(
    const tanwei_dominator_query *query,
    jlong tag) {
  jlong node_id;
  if (query == NULL
      || tag <= 0
      || (tag & TANWEI_TAG_PREFIX_MASK) != query->scan_prefix) {
    return 0;
  }
  node_id = tag & TANWEI_TAG_COUNTER_MASK;
  if (node_id <= 0
      || node_id > query->node_count
      || node_id > query->maximum_nodes) {
    return 0;
  }
  return (jint)node_id;
}

static jint dominator_session_index(
    const tanwei_dominator_query *query,
    jlong tag) {
  jint index;
  if (query == NULL
      || tag <= 0
      || (tag & TANWEI_TAG_PREFIX_MASK) != query->session_prefix) {
    return -1;
  }
  for (index = 0; index < query->session_count; index += 1) {
    if (query->session_tags[index] == tag) {
      return index;
    }
  }
  return -1;
}

static void dominator_mark_conflict(
    tanwei_dominator_query *query) {
  if (query == NULL) {
    return;
  }
  if (query->tag_conflicts < INT32_MAX) {
    query->tag_conflicts += 1;
  }
  query->truncated = 1;
}

static jint dominator_create_node(
    tanwei_dominator_query *query,
    jlong size,
    jint class_id) {
  jint node_id;
  if (query == NULL) {
    return -1;
  }
  if (query->node_count >= query->maximum_nodes) {
    query->truncated = 1;
    query->node_limit_reached = 1;
    return -1;
  }
  node_id = ++query->node_count;
  query->sizes[node_id] = size > 0 ? size : 0;
  if (query->class_ids != NULL) {
    query->class_ids[node_id] =
        class_id > 0 && class_id <= query->class_count
            ? class_id
            : 0;
  }
  return node_id;
}

static jint dominator_node_for_tag(
    tanwei_dominator_query *query,
    jlong *tag_ptr,
    jlong size,
    jlong class_tag) {
  jint index;
  jint node_id;
  jint class_id = 0;
  jlong tag;
  if (query == NULL || tag_ptr == NULL) {
    return 0;
  }
  if (class_tag > 0
      && (class_tag & TANWEI_TAG_PREFIX_MASK)
          == query->reference_prefix) {
    jlong encoded_class_id =
        class_tag & TANWEI_TAG_COUNTER_MASK;
    if (encoded_class_id > 0
        && encoded_class_id <= query->class_count) {
      class_id = (jint)encoded_class_id;
    }
  }
  tag = *tag_ptr;
  if (tag == 0) {
    node_id = dominator_create_node(query, size, class_id);
    if (node_id > 0) {
      *tag_ptr = query->scan_prefix | (jlong)node_id;
    }
    return node_id;
  }
  node_id = dominator_node_id(query, tag);
  if (node_id > 0) {
    if (size > 0 && query->sizes[node_id] == 0) {
      query->sizes[node_id] = size;
    }
    if (query->class_ids != NULL
        && query->class_ids[node_id] == 0
        && class_id > 0) {
      query->class_ids[node_id] = class_id;
    }
    return node_id;
  }
  index = dominator_session_index(query, tag);
  if (index >= 0) {
    node_id = query->session_nodes[index];
    if (node_id <= 0) {
      node_id = dominator_create_node(
          query, size, class_id);
      if (node_id > 0) {
        query->session_nodes[index] = node_id;
      }
    } else if (size > 0 && query->sizes[node_id] == 0) {
      query->sizes[node_id] = size;
    }
    if (query->class_ids != NULL
        && node_id > 0
        && query->class_ids[node_id] == 0
        && class_id > 0) {
      query->class_ids[node_id] = class_id;
    }
    return node_id;
  }
  if ((tag & TANWEI_TAG_PREFIX_MASK) == query->session_prefix
      && query->session_count < TANWEI_MAXIMUM_SESSION_HANDLES) {
    index = query->session_count++;
    query->session_tags[index] = tag;
    node_id = dominator_create_node(
        query, size, class_id);
    query->session_nodes[index] = node_id;
    return node_id;
  }
  if ((tag & TANWEI_TAG_PREFIX_MASK) == query->reference_prefix) {
    return 0;
  }
  dominator_mark_conflict(query);
  return -1;
}

static int dominator_is_weak_reference(
    const tanwei_dominator_query *query,
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info,
    jlong referrer_class_tag) {
  jlong class_id;
  if (query == NULL
      || reference_kind != JVMTI_HEAP_REFERENCE_FIELD
      || reference_info == NULL
      || referrer_class_tag <= 0
      || (referrer_class_tag & TANWEI_TAG_PREFIX_MASK)
          != query->reference_prefix) {
    return 0;
  }
  class_id = referrer_class_tag & TANWEI_TAG_COUNTER_MASK;
  return class_id > 0
      && class_id <= query->reference_class_count
      && query->referent_field_indices[class_id - 1]
          == reference_info->field.index;
}

static int dominator_reference_is_root(
    jvmtiHeapReferenceKind reference_kind,
    jlong *referrer_tag_ptr) {
  if (referrer_tag_ptr == NULL) {
    return 1;
  }
  switch (reference_kind) {
    case JVMTI_HEAP_REFERENCE_JNI_GLOBAL:
    case JVMTI_HEAP_REFERENCE_SYSTEM_CLASS:
    case JVMTI_HEAP_REFERENCE_MONITOR:
    case JVMTI_HEAP_REFERENCE_STACK_LOCAL:
    case JVMTI_HEAP_REFERENCE_JNI_LOCAL:
    case JVMTI_HEAP_REFERENCE_THREAD:
    case JVMTI_HEAP_REFERENCE_OTHER:
    case JVMTI_HEAP_REFERENCE_STATIC_FIELD:
    case JVMTI_HEAP_REFERENCE_CONSTANT_POOL:
    case JVMTI_HEAP_REFERENCE_PROTECTION_DOMAIN:
    case JVMTI_HEAP_REFERENCE_INTERFACE:
    case JVMTI_HEAP_REFERENCE_CLASS_LOADER:
    case JVMTI_HEAP_REFERENCE_SIGNERS:
      return 1;
    default:
      return 0;
  }
}

static jint JNICALL collect_dominator_graph(
    jvmtiHeapReferenceKind reference_kind,
    const jvmtiHeapReferenceInfo *reference_info,
    jlong class_tag,
    jlong referrer_class_tag,
    jlong size,
    jlong *tag_ptr,
    jlong *referrer_tag_ptr,
    jint length,
    void *user_data) {
  tanwei_dominator_query *query =
      (tanwei_dominator_query *)user_data;
  jint source;
  jint target;
  (void)class_tag;
  (void)length;

  if (query == NULL) {
    return JVMTI_VISIT_ABORT;
  }
  if (dominator_is_weak_reference(
      query,
      reference_kind,
      reference_info,
      referrer_class_tag)
      || reference_kind == JVMTI_HEAP_REFERENCE_CLASS) {
    return 0;
  }
  target =
      dominator_node_for_tag(
          query, tag_ptr, size, class_tag);
  if (target < 0) {
    return query->node_limit_reached
        ? JVMTI_VISIT_ABORT
        : JVMTI_VISIT_OBJECTS;
  }
  if (target == 0) {
    return JVMTI_VISIT_OBJECTS;
  }
  source =
      dominator_reference_is_root(
          reference_kind,
          referrer_tag_ptr)
          ? 0
          : dominator_node_for_tag(
              query,
              referrer_tag_ptr,
              0,
              referrer_class_tag);
  if (source < 0) {
    if (query->node_limit_reached) {
      return JVMTI_VISIT_ABORT;
    }
    source = 0;
  }
  if (query->edge_count >= query->maximum_edges) {
    query->truncated = 1;
    query->edge_limit_reached = 1;
    return JVMTI_VISIT_ABORT;
  }
  query->edge_sources[query->edge_count] = source;
  query->edge_targets[query->edge_count] = target;
  query->edge_count += 1;
  return JVMTI_VISIT_OBJECTS;
}

static jint dominator_eval(
    jint node,
    jint *ancestor,
    jint *label,
    const jint *semi,
    jint *work) {
  jint current;
  jint parent;
  jint count = 0;
  if (ancestor[node] < 0) {
    return label[node];
  }
  current = node;
  while (ancestor[current] >= 0
      && ancestor[ancestor[current]] >= 0) {
    work[count++] = current;
    current = ancestor[current];
  }
  while (count > 0) {
    current = work[--count];
    parent = ancestor[current];
    if (semi[label[parent]] < semi[label[current]]) {
      label[current] = label[parent];
    }
    ancestor[current] = ancestor[parent];
  }
  return label[node];
}

static int dominator_compute(
    const tanwei_dominator_query *query,
    jlong *retained_bytes,
    jlong *retained_objects,
    jint *immediate_dominators,
    jint *reachable_nodes,
    jlong *reachable_bytes) {
  jint node_count;
  jint edge_count;
  jint *out_offsets = NULL;
  jint *pred_offsets = NULL;
  jint *out_cursor = NULL;
  jint *pred_cursor = NULL;
  jint *out_targets = NULL;
  jint *pred_sources = NULL;
  jint *dfs_number = NULL;
  jint *vertex = NULL;
  jint *parent = NULL;
  jint *stack_nodes = NULL;
  jint *stack_next = NULL;
  jint *semi = NULL;
  jint *ancestor = NULL;
  jint *label = NULL;
  jint *idom = NULL;
  jint *bucket_head = NULL;
  jint *bucket_next = NULL;
  jint *eval_work = NULL;
  jint dfs_count = 0;
  jint stack_top;
  jint index;
  jint source;
  jint target;
  jint node;
  jint candidate;
  jint result = 0;
  size_t node_slots;

  if (query == NULL
      || retained_bytes == NULL
      || retained_objects == NULL
      || reachable_nodes == NULL
      || reachable_bytes == NULL) {
    return 0;
  }
  node_count = query->node_count;
  edge_count = query->edge_count;
  node_slots = (size_t)node_count + 2U;
  out_offsets = (jint *)calloc(node_slots, sizeof(jint));
  pred_offsets = (jint *)calloc(node_slots, sizeof(jint));
  out_cursor = (jint *)malloc(node_slots * sizeof(jint));
  pred_cursor = (jint *)malloc(node_slots * sizeof(jint));
  out_targets =
      (jint *)malloc(
          (size_t)(edge_count > 0 ? edge_count : 1)
              * sizeof(jint));
  pred_sources =
      (jint *)malloc(
          (size_t)(edge_count > 0 ? edge_count : 1)
              * sizeof(jint));
  dfs_number = (jint *)calloc(node_slots, sizeof(jint));
  vertex = (jint *)malloc(node_slots * sizeof(jint));
  parent = (jint *)malloc(node_slots * sizeof(jint));
  stack_nodes = (jint *)malloc(node_slots * sizeof(jint));
  stack_next = (jint *)malloc(node_slots * sizeof(jint));
  semi = (jint *)malloc(node_slots * sizeof(jint));
  ancestor = (jint *)malloc(node_slots * sizeof(jint));
  label = (jint *)malloc(node_slots * sizeof(jint));
  idom = (jint *)malloc(node_slots * sizeof(jint));
  bucket_head = (jint *)malloc(node_slots * sizeof(jint));
  bucket_next = (jint *)malloc(node_slots * sizeof(jint));
  eval_work = (jint *)malloc(node_slots * sizeof(jint));
  if (out_offsets == NULL
      || pred_offsets == NULL
      || out_cursor == NULL
      || pred_cursor == NULL
      || out_targets == NULL
      || pred_sources == NULL
      || dfs_number == NULL
      || vertex == NULL
      || parent == NULL
      || stack_nodes == NULL
      || stack_next == NULL
      || semi == NULL
      || ancestor == NULL
      || label == NULL
      || idom == NULL
      || bucket_head == NULL
      || bucket_next == NULL
      || eval_work == NULL) {
    goto dominator_compute_cleanup;
  }
  for (index = 0; index < edge_count; index += 1) {
    source = query->edge_sources[index];
    target = query->edge_targets[index];
    if (source < 0
        || source > node_count
        || target <= 0
        || target > node_count) {
      goto dominator_compute_cleanup;
    }
    out_offsets[source + 1] += 1;
    pred_offsets[target + 1] += 1;
  }
  for (index = 1; index <= node_count + 1; index += 1) {
    out_offsets[index] += out_offsets[index - 1];
    pred_offsets[index] += pred_offsets[index - 1];
  }
  memcpy(
      out_cursor,
      out_offsets,
      node_slots * sizeof(jint));
  memcpy(
      pred_cursor,
      pred_offsets,
      node_slots * sizeof(jint));
  for (index = 0; index < edge_count; index += 1) {
    source = query->edge_sources[index];
    target = query->edge_targets[index];
    out_targets[out_cursor[source]++] = target;
    pred_sources[pred_cursor[target]++] = source;
  }

  for (index = 0; index <= node_count; index += 1) {
    parent[index] = -1;
  }
  dfs_count = 1;
  dfs_number[0] = 1;
  vertex[1] = 0;
  parent[0] = 0;
  stack_top = 0;
  stack_nodes[0] = 0;
  stack_next[0] = out_offsets[0];
  while (stack_top >= 0) {
    node = stack_nodes[stack_top];
    if (stack_next[stack_top] < out_offsets[node + 1]) {
      target =
          out_targets[stack_next[stack_top]++];
      if (dfs_number[target] == 0) {
        parent[target] = node;
        dfs_number[target] = ++dfs_count;
        vertex[dfs_count] = target;
        stack_top += 1;
        stack_nodes[stack_top] = target;
        stack_next[stack_top] = out_offsets[target];
      }
    } else {
      stack_top -= 1;
    }
  }

  for (index = 0; index <= node_count; index += 1) {
    semi[index] = 0;
    ancestor[index] = -1;
    label[index] = index;
    idom[index] = -1;
    bucket_head[index] = -1;
    bucket_next[index] = -1;
    retained_bytes[index] =
        index == 0 ? 0 : query->sizes[index];
    retained_objects[index] = index == 0 ? 0 : 1;
  }
  for (index = 1; index <= dfs_count; index += 1) {
    node = vertex[index];
    semi[node] = index;
  }

  for (index = dfs_count; index >= 2; index -= 1) {
    node = vertex[index];
    for (source = pred_offsets[node];
        source < pred_offsets[node + 1];
        source += 1) {
      target = pred_sources[source];
      if (dfs_number[target] == 0) {
        continue;
      }
      candidate =
          dominator_eval(
              target,
              ancestor,
              label,
              semi,
              eval_work);
      if (semi[candidate] < semi[node]) {
        semi[node] = semi[candidate];
      }
    }
    target = vertex[semi[node]];
    bucket_next[node] = bucket_head[target];
    bucket_head[target] = node;
    ancestor[node] = parent[node];
    candidate = bucket_head[parent[node]];
    while (candidate >= 0) {
      target =
          dominator_eval(
              candidate,
              ancestor,
              label,
              semi,
              eval_work);
      idom[candidate] =
          semi[target] < semi[candidate]
              ? target
              : parent[node];
      candidate = bucket_next[candidate];
    }
    bucket_head[parent[node]] = -1;
  }
  for (index = 2; index <= dfs_count; index += 1) {
    node = vertex[index];
    target = vertex[semi[node]];
    if (idom[node] != target) {
      idom[node] = idom[idom[node]];
    }
  }
  idom[0] = 0;
  for (index = dfs_count; index >= 2; index -= 1) {
    node = vertex[index];
    target = idom[node];
    if (target < 0 || target > node_count) {
      goto dominator_compute_cleanup;
    }
    retained_bytes[target] =
        saturating_add(
            retained_bytes[target],
            retained_bytes[node]);
    retained_objects[target] =
        saturating_add(
            retained_objects[target],
            retained_objects[node]);
  }
  *reachable_nodes = dfs_count - 1;
  *reachable_bytes = retained_bytes[0];
  if (immediate_dominators != NULL) {
    memcpy(
        immediate_dominators,
        idom,
        ((size_t)node_count + 1U) * sizeof(jint));
  }
  result = 1;

dominator_compute_cleanup:
  free(out_offsets);
  free(pred_offsets);
  free(out_cursor);
  free(pred_cursor);
  free(out_targets);
  free(pred_sources);
  free(dfs_number);
  free(vertex);
  free(parent);
  free(stack_nodes);
  free(stack_next);
  free(semi);
  free(ancestor);
  free(label);
  free(idom);
  free(bucket_head);
  free(bucket_next);
  free(eval_work);
  return result;
}

static jint dominator_top_children(
    const jint *child_offsets,
    const jint *children,
    const jlong *retained_bytes,
    jint parent,
    jint limit,
    jint *selected) {
  jint count = 0;
  jint cursor;
  jint insert_at;
  jint move;
  jint child;
  if (child_offsets == NULL
      || children == NULL
      || retained_bytes == NULL
      || selected == NULL
      || parent < 0
      || limit < 1) {
    return 0;
  }
  for (cursor = child_offsets[parent];
      cursor < child_offsets[parent + 1];
      cursor += 1) {
    child = children[cursor];
    insert_at = count;
    for (move = 0; move < count; move += 1) {
      if (retained_bytes[child] > retained_bytes[selected[move]]
          || (retained_bytes[child] == retained_bytes[selected[move]]
              && child < selected[move])) {
        insert_at = move;
        break;
      }
    }
    if (insert_at >= limit) {
      continue;
    }
    if (count < limit) {
      count += 1;
    }
    for (move = count - 1; move > insert_at; move -= 1) {
      selected[move] = selected[move - 1];
    }
    selected[insert_at] = child;
  }
  return count;
}

static jint retained_referent_field_index(
    JNIEnv *jni,
    jclass type) {
  jclass hierarchy[64];
  jint hierarchy_count = 0;
  jint absolute_index = 0;
  jint result = -1;
  jclass current = type;
  jint hierarchy_index;

  while (current != NULL && hierarchy_count < 64) {
    hierarchy[hierarchy_count++] = current;
    current = (*jni)->GetSuperclass(jni, current);
    if ((*jni)->ExceptionCheck(jni)) {
      result = -1;
      break;
    }
  }
  if (current != NULL) {
    result = -1;
  } else if (!(*jni)->ExceptionCheck(jni)) {
    for (hierarchy_index = hierarchy_count - 1;
        hierarchy_index >= 0;
        hierarchy_index -= 1) {
      jint field_count = 0;
      jfieldID *fields = NULL;
      jint field_index;
      jvmtiError error =
          (*tanwei_jvmti)->GetClassFields(
              tanwei_jvmti,
              hierarchy[hierarchy_index],
              &field_count,
              &fields);
      if (error != JVMTI_ERROR_NONE) {
        result = -1;
        break;
      }
      for (field_index = 0; field_index < field_count; field_index += 1) {
        char *name = NULL;
        char *signature = NULL;
        char *generic = NULL;
        error =
            (*tanwei_jvmti)->GetFieldName(
                tanwei_jvmti,
                hierarchy[hierarchy_index],
                fields[field_index],
                &name,
                &signature,
                &generic);
        if (error == JVMTI_ERROR_NONE
            && name != NULL
            && signature != NULL
            && strcmp(name, "referent") == 0
            && strcmp(signature, "Ljava/lang/Object;") == 0) {
          result = absolute_index + field_index;
        }
        if (name != NULL) {
          (*tanwei_jvmti)->Deallocate(
              tanwei_jvmti, (unsigned char *)name);
        }
        if (signature != NULL) {
          (*tanwei_jvmti)->Deallocate(
              tanwei_jvmti, (unsigned char *)signature);
        }
        if (generic != NULL) {
          (*tanwei_jvmti)->Deallocate(
              tanwei_jvmti, (unsigned char *)generic);
        }
        if (error != JVMTI_ERROR_NONE || result >= 0) {
          break;
        }
      }
      absolute_index += field_count;
      if (fields != NULL) {
        (*tanwei_jvmti)->Deallocate(
            tanwei_jvmti, (unsigned char *)fields);
      }
      if (error != JVMTI_ERROR_NONE || result >= 0) {
        break;
      }
    }
  }
  for (hierarchy_index = 1;
      hierarchy_index < hierarchy_count;
      hierarchy_index += 1) {
    (*jni)->DeleteLocalRef(jni, hierarchy[hierarchy_index]);
  }
  return result;
}

static void retained_restore_reference_class_tags(
    JNIEnv *jni,
    jobjectArray reference_classes,
    const unsigned char *tagged,
    const jlong *original_tags,
    jint class_count) {
  jint index;
  if (reference_classes == NULL
      || tagged == NULL
      || original_tags == NULL) {
    return;
  }
  for (index = 0; index < class_count; index += 1) {
    jobject type;
    if (tagged[index] == 0) {
      continue;
    }
    type = (*jni)->GetObjectArrayElement(jni, reference_classes, index);
    if (type != NULL) {
      (*tanwei_jvmti)->SetTag(
          tanwei_jvmti, type, original_tags[index]);
      (*jni)->DeleteLocalRef(jni, type);
    }
    if ((*jni)->ExceptionCheck(jni)) {
      return;
    }
  }
}

static void retained_insert_contributor(
    jlong tag,
    jlong size,
    jlong *tags,
    jlong *sizes,
    jint *count) {
  jint index;
  jint insert_at;
  if (tag <= 0 || size < 0 || tags == NULL || sizes == NULL || count == NULL) {
    return;
  }
  insert_at = *count;
  for (index = 0; index < *count; index += 1) {
    if (size > sizes[index]) {
      insert_at = index;
      break;
    }
  }
  if (insert_at >= TANWEI_MAXIMUM_RETAINED_CONTRIBUTORS) {
    return;
  }
  if (*count < TANWEI_MAXIMUM_RETAINED_CONTRIBUTORS) {
    *count += 1;
  }
  for (index = *count - 1; index > insert_at; index -= 1) {
    tags[index] = tags[index - 1];
    sizes[index] = sizes[index - 1];
  }
  tags[insert_at] = tag;
  sizes[insert_at] = size;
}

static jint JNICALL clear_root_path_tag(
    jlong class_tag,
    jlong size,
    jlong *tag_ptr,
    jint length,
    void *user_data) {
  jlong scan_prefix = *((jlong *)user_data);
  (void)class_tag;
  (void)size;
  (void)length;
  if (tag_ptr != NULL
      && (*tag_ptr & TANWEI_TAG_PREFIX_MASK) == scan_prefix) {
    *tag_ptr = 0;
  }
  return JVMTI_VISIT_OBJECTS;
}

static void clear_root_path_tags(jlong scan_prefix) {
  jvmtiHeapCallbacks callbacks;
  if (tanwei_jvmti == NULL || scan_prefix <= 0) {
    return;
  }
  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_iteration_callback = &clear_root_path_tag;
  (*tanwei_jvmti)->IterateThroughHeap(
      tanwei_jvmti,
      0,
      NULL,
      &callbacks,
      &scan_prefix);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
  jvmtiCapabilities capabilities;
  jvmtiError error;
  (void)reserved;
  tanwei_vm = vm;
  if ((*vm)->GetEnv(vm, (void **)&tanwei_jvmti, JVMTI_VERSION_1_2) != JNI_OK
      || tanwei_jvmti == NULL) {
    tanwei_jvmti = NULL;
    return JNI_VERSION_1_8;
  }
  memset(&capabilities, 0, sizeof(capabilities));
  capabilities.can_tag_objects = 1;
  error = (*tanwei_jvmti)->AddCapabilities(tanwei_jvmti, &capabilities);
  if (error != JVMTI_ERROR_NONE) {
    tanwei_jvmti = NULL;
  }
  return JNI_VERSION_1_8;
}

JNIEXPORT void JNICALL JNI_OnUnload(JavaVM *vm, void *reserved) {
  (void)vm;
  (void)reserved;
  tanwei_jvmti = NULL;
  tanwei_vm = NULL;
}

JNIEXPORT jobjectArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectInstances(
    JNIEnv *jni,
    jclass controller,
    jclass target,
    jint limit,
    jlong tag_base) {
  jvmtiHeapCallbacks callbacks;
  tanwei_heap_query query;
  jvmtiError error;
  jlong *tags;
  jint found = 0;
  jobject *objects = NULL;
  jobjectArray result = NULL;
  jclass object_type;
  jint index;
  (void)controller;

  if (tanwei_jvmti == NULL) {
    throw_illegal_state(jni, "JVMTI object tagging is unavailable");
    return NULL;
  }
  if (target == NULL
      || limit < 1
      || limit > 20
      || tag_base <= 0
      || !tag_range_available(tag_base, limit)) {
    throw_illegal_state(jni, "Invalid or colliding heap instance query");
    return NULL;
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_iteration_callback = &tag_instance;

  query.tag_base = tag_base;
  query.limit = limit;
  query.tagged = 0;
  error = (*tanwei_jvmti)->IterateThroughHeap(
      tanwei_jvmti,
      JVMTI_HEAP_FILTER_TAGGED,
      target,
      &callbacks,
      &query);
  if (error != JVMTI_ERROR_NONE) {
    throw_illegal_state(jni, "JVMTI heap iteration failed");
    return NULL;
  }

  object_type = (*jni)->FindClass(jni, "java/lang/Object");
  if (query.tagged == 0) {
    return object_type == NULL
        ? NULL
        : (*jni)->NewObjectArray(jni, 0, object_type, NULL);
  }

  tags = (jlong *)malloc(sizeof(jlong) * (size_t)query.tagged);
  if (tags == NULL) {
    throw_illegal_state(jni, "Unable to allocate heap query tag buffer");
    return NULL;
  }
  for (index = 0; index < query.tagged; index += 1) {
    tags[index] = tag_base + (jlong)index;
  }
  error = (*tanwei_jvmti)->GetObjectsWithTags(
      tanwei_jvmti,
      query.tagged,
      tags,
      &found,
      &objects,
      NULL);
  free(tags);
  if (error != JVMTI_ERROR_NONE) {
    throw_illegal_state(jni, "JVMTI tagged-object lookup failed");
    return NULL;
  }

  if (object_type != NULL) {
    result = (*jni)->NewObjectArray(jni, found, object_type, NULL);
  }
  for (index = 0; index < found; index += 1) {
    if (result != NULL && !(*jni)->ExceptionCheck(jni)) {
      (*jni)->SetObjectArrayElement(jni, result, index, objects[index]);
    }
  }
  if (objects != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)objects);
  }
  return result;
}

static void clear_histogram_class_tags(
    JNIEnv *jni,
    jobjectArray classes,
    const unsigned char *tagged,
    const jlong *original_tags,
    jint class_count) {
  jint index;
  jobject class_object;
  if (tanwei_jvmti == NULL
      || classes == NULL
      || tagged == NULL
      || original_tags == NULL) {
    return;
  }
  for (index = 0; index < class_count; index += 1) {
    if (tagged[index] == 0) {
      continue;
    }
    class_object =
        (*jni)->GetObjectArrayElement(jni, classes, index);
    if (class_object != NULL) {
      (*tanwei_jvmti)->SetTag(
          tanwei_jvmti, class_object, original_tags[index]);
      (*jni)->DeleteLocalRef(jni, class_object);
    }
    if ((*jni)->ExceptionCheck(jni)) {
      return;
    }
  }
}

JNIEXPORT jlongArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectHeapHistogram(
    JNIEnv *jni,
    jclass controller,
    jobjectArray classes,
    jlong scan_limit,
    jlong tag_prefix,
    jlong session_prefix) {
  tanwei_heap_histogram histogram;
  jvmtiHeapCallbacks callbacks;
  jvmtiError error;
  unsigned char *tagged = NULL;
  jlong *original_tags = NULL;
  jlong *encoded = NULL;
  jlongArray result = NULL;
  jobject class_object;
  jlong existing_tag;
  jint class_count;
  jint skipped = 0;
  jint index;
  jint encoded_length;
  int failed = 0;
  jthrowable pending_exception = NULL;
  (void)controller;

  if (tanwei_jvmti == NULL) {
    throw_illegal_state(jni, "JVMTI heap histogram is unavailable");
    return NULL;
  }
  if (classes == NULL) {
    throw_illegal_state(jni, "Heap histogram classes are required");
    return NULL;
  }
  class_count = (*jni)->GetArrayLength(jni, classes);
  if (class_count < 1
      || class_count > TANWEI_MAXIMUM_HISTOGRAM_CLASSES
      || scan_limit < 10000
      || scan_limit > TANWEI_MAXIMUM_HISTOGRAM_OBJECTS
      || tag_prefix <= 0
      || (tag_prefix & TANWEI_TAG_PREFIX_MASK) != tag_prefix
      || session_prefix <= 0
      || (session_prefix & TANWEI_TAG_PREFIX_MASK) != session_prefix
      || tag_prefix == session_prefix
      || !tag_range_available(tag_prefix | 1, class_count)) {
    throw_illegal_state(jni, "Invalid or colliding heap histogram query");
    return NULL;
  }

  memset(&histogram, 0, sizeof(histogram));
  histogram.tag_prefix = tag_prefix;
  histogram.class_count = class_count;
  histogram.scan_limit = scan_limit;
  histogram.counts =
      (jlong *)calloc((size_t)class_count + 1, sizeof(jlong));
  histogram.bytes =
      (jlong *)calloc((size_t)class_count + 1, sizeof(jlong));
  tagged =
      (unsigned char *)calloc(
          (size_t)class_count,
          sizeof(unsigned char));
  original_tags =
      (jlong *)calloc((size_t)class_count, sizeof(jlong));
  if (histogram.counts == NULL
      || histogram.bytes == NULL
      || tagged == NULL
      || original_tags == NULL) {
    free(histogram.counts);
    free(histogram.bytes);
    free(tagged);
    free(original_tags);
    throw_illegal_state(jni, "Unable to allocate heap histogram state");
    return NULL;
  }

  for (index = 0; index < class_count; index += 1) {
    class_object =
        (*jni)->GetObjectArrayElement(jni, classes, index);
    if ((*jni)->ExceptionCheck(jni)) {
      pending_exception = (*jni)->ExceptionOccurred(jni);
      (*jni)->ExceptionClear(jni);
      failed = 1;
      break;
    }
    if (class_object == NULL) {
      skipped += 1;
      continue;
    }
    existing_tag = 0;
    error = (*tanwei_jvmti)->GetTag(
        tanwei_jvmti, class_object, &existing_tag);
    if (error != JVMTI_ERROR_NONE) {
      (*jni)->DeleteLocalRef(jni, class_object);
      failed = 1;
      break;
    }
    if (existing_tag != 0
        && (existing_tag & TANWEI_TAG_PREFIX_MASK)
            != session_prefix) {
      skipped += 1;
      (*jni)->DeleteLocalRef(jni, class_object);
      continue;
    }
    original_tags[index] = existing_tag;
    error = (*tanwei_jvmti)->SetTag(
        tanwei_jvmti,
        class_object,
        tag_prefix | (jlong)(index + 1));
    if (error != JVMTI_ERROR_NONE) {
      (*jni)->DeleteLocalRef(jni, class_object);
      failed = 1;
      break;
    }
    tagged[index] = 1;
    (*jni)->DeleteLocalRef(jni, class_object);
  }
  if (failed) {
    clear_histogram_class_tags(
        jni, classes, tagged, original_tags, class_count);
    free(histogram.counts);
    free(histogram.bytes);
    free(tagged);
    free(original_tags);
    if (pending_exception != NULL) {
      (*jni)->Throw(jni, pending_exception);
    } else if (!(*jni)->ExceptionCheck(jni)) {
      throw_illegal_state(jni, "Unable to tag heap histogram classes");
    }
    return NULL;
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_iteration_callback = &collect_heap_histogram;
  error = (*tanwei_jvmti)->IterateThroughHeap(
      tanwei_jvmti,
      0,
      NULL,
      &callbacks,
      &histogram);
  clear_histogram_class_tags(
      jni, classes, tagged, original_tags, class_count);
  free(tagged);
  free(original_tags);
  if (error != JVMTI_ERROR_NONE) {
    free(histogram.counts);
    free(histogram.bytes);
    throw_illegal_state(jni, "JVMTI heap histogram iteration failed");
    return NULL;
  }

  encoded_length = 3 + class_count * 2;
  encoded =
      (jlong *)calloc((size_t)encoded_length, sizeof(jlong));
  if (encoded == NULL) {
    free(histogram.counts);
    free(histogram.bytes);
    throw_illegal_state(jni, "Unable to allocate heap histogram result");
    return NULL;
  }
  encoded[0] = histogram.scanned;
  encoded[1] = (jlong)histogram.truncated;
  encoded[2] = (jlong)skipped;
  for (index = 0; index < class_count; index += 1) {
    encoded[3 + index * 2] = histogram.counts[index + 1];
    encoded[4 + index * 2] = histogram.bytes[index + 1];
  }
  result = (*jni)->NewLongArray(jni, encoded_length);
  if (result != NULL) {
    (*jni)->SetLongArrayRegion(
        jni, result, 0, encoded_length, encoded);
  }
  free(encoded);
  free(histogram.counts);
  free(histogram.bytes);
  return result;
}

JNIEXPORT jlong JNICALL
Java_dev_tanwei_agent_HeapInstanceController_objectTag(
    JNIEnv *jni,
    jclass controller,
    jobject object) {
  jlong tag = 0;
  jvmtiError error;
  (void)controller;
  if (tanwei_jvmti == NULL || object == NULL) {
    return 0;
  }
  error = (*tanwei_jvmti)->GetTag(tanwei_jvmti, object, &tag);
  if (error != JVMTI_ERROR_NONE) {
    throw_illegal_state(jni, "JVMTI object tag lookup failed");
    return 0;
  }
  return tag;
}

JNIEXPORT jlong JNICALL
Java_dev_tanwei_agent_HeapInstanceController_tagObjectIfAvailable(
    JNIEnv *jni,
    jclass controller,
    jobject object,
    jlong candidate_tag) {
  jlong current_tag = 0;
  jvmtiError error;
  (void)controller;
  if (tanwei_jvmti == NULL
      || object == NULL
      || candidate_tag <= 0) {
    return 0;
  }
  error = (*tanwei_jvmti)->GetTag(
      tanwei_jvmti, object, &current_tag);
  if (error != JVMTI_ERROR_NONE) {
    throw_illegal_state(jni, "JVMTI object tag lookup failed");
    return 0;
  }
  if (current_tag != 0) {
    return current_tag;
  }
  if (!tag_range_available(candidate_tag, 1)) {
    return 0;
  }
  error = (*tanwei_jvmti)->SetTag(
      tanwei_jvmti, object, candidate_tag);
  if (error != JVMTI_ERROR_NONE) {
    throw_illegal_state(jni, "JVMTI object tagging failed");
    return 0;
  }
  return candidate_tag;
}

JNIEXPORT jobject JNICALL
Java_dev_tanwei_agent_HeapInstanceController_resolveTaggedObject(
    JNIEnv *jni,
    jclass controller,
    jlong tag) {
  jlong tags[1];
  jint found = 0;
  jobject *objects = NULL;
  jobject result = NULL;
  jvmtiError error;
  (void)controller;
  if (tanwei_jvmti == NULL || tag <= 0) {
    return NULL;
  }
  tags[0] = tag;
  error = (*tanwei_jvmti)->GetObjectsWithTags(
      tanwei_jvmti,
      1,
      tags,
      &found,
      &objects,
      NULL);
  if (error != JVMTI_ERROR_NONE) {
    throw_illegal_state(jni, "JVMTI tagged-object resolution failed");
    return NULL;
  }
  if (found > 0 && objects != NULL) {
    result = objects[0];
  }
  if (objects != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)objects);
  }
  return result;
}

JNIEXPORT jlongArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectReferrerEdges(
    JNIEnv *jni,
    jclass controller,
    jobject target,
    jint limit,
    jlong scan_limit,
    jlong tag_base,
    jlong tag_prefix) {
  jvmtiHeapCallbacks callbacks;
  tanwei_referrer_query query;
  jvmtiError error;
  jlong *encoded;
  jlongArray result;
  jint index;
  jint length;
  (void)controller;

  if (tanwei_jvmti == NULL) {
    throw_illegal_state(jni, "JVMTI reference traversal is unavailable");
    return NULL;
  }
  if (target == NULL
      || limit < 1
      || limit > TANWEI_MAXIMUM_RELATIONS
      || scan_limit < 1
      || tag_base <= 0
      || tag_prefix <= 0
      || !tag_range_available(tag_base, limit)) {
    throw_illegal_state(jni, "Invalid or colliding referrer query");
    return NULL;
  }

  memset(&query, 0, sizeof(query));
  query.target_tag =
      Java_dev_tanwei_agent_HeapInstanceController_objectTag(
          jni, controller, target);
  if ((*jni)->ExceptionCheck(jni)) {
    return NULL;
  }
  if (query.target_tag <= 0) {
    throw_illegal_state(jni, "The selected object no longer has a session tag");
    return NULL;
  }
  query.tag_base = tag_base;
  query.tag_prefix = tag_prefix;
  query.limit = limit;
  query.scan_limit = scan_limit;

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_reference_callback = &collect_referrer;
  error = (*tanwei_jvmti)->FollowReferences(
      tanwei_jvmti,
      0,
      NULL,
      NULL,
      &callbacks,
      &query);
  if (error != JVMTI_ERROR_NONE) {
    throw_illegal_state(jni, "JVMTI reference traversal failed");
    return NULL;
  }

  length = 2 + query.found * 3;
  encoded = (jlong *)calloc((size_t)length, sizeof(jlong));
  if (encoded == NULL) {
    throw_illegal_state(jni, "Unable to allocate referrer result buffer");
    return NULL;
  }
  encoded[0] = query.visited;
  encoded[1] = query.truncated;
  for (index = 0; index < query.found; index += 1) {
    jint offset = 2 + index * 3;
    encoded[offset] = query.tags[index];
    encoded[offset + 1] = (jlong)query.kinds[index];
    encoded[offset + 2] = (jlong)query.indices[index];
  }
  result = (*jni)->NewLongArray(jni, length);
  if (result != NULL) {
    (*jni)->SetLongArrayRegion(jni, result, 0, length, encoded);
  }
  free(encoded);
  return result;
}

JNIEXPORT jobjectArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectRootPath(
    JNIEnv *jni,
    jclass controller,
    jlong target_tag,
    jint maximum_depth,
    jint maximum_nodes,
    jlong maximum_edges,
    jlong scan_prefix,
    jlong session_prefix) {
  tanwei_root_path_query query;
  jvmtiHeapCallbacks callbacks;
  jvmtiError error;
  jlong path_tags[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
  jint path_kinds[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
  jint path_indices[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
  jlong metadata[5 + (TANWEI_MAXIMUM_ROOT_DEPTH + 1) * 2];
  jint path_count = 1;
  jint root_reached = 0;
  jlong parent_tag;
  jint parent_id;
  jint session_index;
  jint found_objects = 0;
  jobject *objects = NULL;
  jlong *object_tags = NULL;
  jclass object_type;
  jobjectArray path_objects = NULL;
  jlongArray path_metadata = NULL;
  jobjectArray result = NULL;
  jint index;
  jint object_index;
  jint metadata_length;
  (void)controller;

  if (tanwei_jvmti == NULL) {
    throw_illegal_state(jni, "JVMTI root-path traversal is unavailable");
    return NULL;
  }
  if (target_tag <= 0
      || maximum_depth < 1
      || maximum_depth > TANWEI_MAXIMUM_ROOT_DEPTH
      || maximum_nodes < 1
      || maximum_nodes > TANWEI_MAXIMUM_ROOT_NODES
      || maximum_edges < 1000
      || maximum_edges > TANWEI_MAXIMUM_ROOT_EDGES
      || scan_prefix <= 0
      || (scan_prefix & TANWEI_TAG_PREFIX_MASK) != scan_prefix
      || session_prefix <= 0
      || (session_prefix & TANWEI_TAG_PREFIX_MASK) != session_prefix
      || scan_prefix == session_prefix
      || (target_tag & TANWEI_TAG_PREFIX_MASK) != session_prefix
      || !tag_range_available(scan_prefix | 1, maximum_nodes)) {
    throw_illegal_state(jni, "Invalid or colliding root-path query");
    return NULL;
  }

  memset(&query, 0, sizeof(query));
  query.target_tag = target_tag;
  query.session_prefix = session_prefix;
  query.scan_prefix = scan_prefix;
  query.maximum_nodes = maximum_nodes;
  query.maximum_edges = maximum_edges;
  query.parents =
      (jlong *)calloc((size_t)maximum_nodes + 1, sizeof(jlong));
  query.kinds =
      (jint *)calloc((size_t)maximum_nodes + 1, sizeof(jint));
  query.indices =
      (jint *)malloc(((size_t)maximum_nodes + 1) * sizeof(jint));
  query.parent_known =
      (unsigned char *)calloc(
          (size_t)maximum_nodes + 1,
          sizeof(unsigned char));
  if (query.parents == NULL
      || query.kinds == NULL
      || query.indices == NULL
      || query.parent_known == NULL) {
    free(query.parents);
    free(query.kinds);
    free(query.indices);
    free(query.parent_known);
    throw_illegal_state(jni, "Unable to allocate root-path traversal state");
    return NULL;
  }
  for (index = 0; index <= maximum_nodes; index += 1) {
    query.indices[index] = -1;
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_reference_callback = &collect_root_path;
  error = (*tanwei_jvmti)->FollowReferences(
      tanwei_jvmti,
      0,
      NULL,
      NULL,
      &callbacks,
      &query);
  if (error != JVMTI_ERROR_NONE) {
    clear_root_path_tags(scan_prefix);
    free(query.parents);
    free(query.kinds);
    free(query.indices);
    free(query.parent_known);
    throw_illegal_state(jni, "JVMTI root-path traversal failed");
    return NULL;
  }

  path_tags[0] = target_tag;
  path_kinds[0] = query.found ? query.target_kind : 0;
  path_indices[0] = query.found ? query.target_index : -1;
  if (query.found) {
    parent_tag = query.target_parent;
    while (parent_tag != 0
        && path_count < maximum_depth + 1) {
      parent_id = root_path_node_id(&query, parent_tag);
      session_index = root_path_session_index(&query, parent_tag);
      if (parent_id > 0 && query.parent_known[parent_id] != 0) {
        path_tags[path_count] = parent_tag;
        path_kinds[path_count] = query.kinds[parent_id];
        path_indices[path_count] = query.indices[parent_id];
        path_count += 1;
        parent_tag = query.parents[parent_id];
        continue;
      }
      if (session_index >= 0
          && query.session_parent_known[session_index] != 0) {
        path_tags[path_count] = parent_tag;
        path_kinds[path_count] = query.session_kinds[session_index];
        path_indices[path_count] =
            query.session_indices[session_index];
        path_count += 1;
        parent_tag = query.session_parents[session_index];
        continue;
      }
      query.truncated = 1;
      parent_tag = -1;
      break;
    }
    if (parent_tag == 0) {
      root_reached = 1;
    } else {
      query.truncated = 1;
    }
  } else {
    query.truncated = 1;
  }

  error = (*tanwei_jvmti)->GetObjectsWithTags(
      tanwei_jvmti,
      path_count,
      path_tags,
      &found_objects,
      &objects,
      &object_tags);
  if (error != JVMTI_ERROR_NONE) {
    clear_root_path_tags(scan_prefix);
    free(query.parents);
    free(query.kinds);
    free(query.indices);
    free(query.parent_known);
    throw_illegal_state(jni, "JVMTI root-path object resolution failed");
    return NULL;
  }

  object_type = (*jni)->FindClass(jni, "java/lang/Object");
  if (object_type != NULL) {
    path_objects =
        (*jni)->NewObjectArray(jni, path_count, object_type, NULL);
  }
  if (path_objects != NULL) {
    for (object_index = 0;
        object_index < found_objects;
        object_index += 1) {
      for (index = 0; index < path_count; index += 1) {
        if (object_tags != NULL
            && object_tags[object_index] == path_tags[index]) {
          (*jni)->SetObjectArrayElement(
              jni,
              path_objects,
              index,
              objects[object_index]);
          break;
        }
      }
    }
  }

  metadata_length = 5 + path_count * 2;
  metadata[0] = query.visited;
  metadata[1] = (jlong)query.truncated;
  metadata[2] = (jlong)root_reached;
  metadata[3] = (jlong)query.tagged;
  metadata[4] = (jlong)path_count;
  for (index = 0; index < path_count; index += 1) {
    metadata[5 + index * 2] = (jlong)path_kinds[index];
    metadata[6 + index * 2] = (jlong)path_indices[index];
  }
  path_metadata = (*jni)->NewLongArray(jni, metadata_length);
  if (path_metadata != NULL) {
    (*jni)->SetLongArrayRegion(
        jni,
        path_metadata,
        0,
        metadata_length,
        metadata);
  }
  if (object_type != NULL) {
    result = (*jni)->NewObjectArray(jni, 2, object_type, NULL);
  }
  if (result != NULL && path_objects != NULL && path_metadata != NULL) {
    (*jni)->SetObjectArrayElement(jni, result, 0, path_objects);
    (*jni)->SetObjectArrayElement(jni, result, 1, path_metadata);
  }

  clear_root_path_tags(scan_prefix);
  if (objects != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)objects);
  }
  if (object_tags != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)object_tags);
  }
  free(query.parents);
  free(query.kinds);
  free(query.indices);
  free(query.parent_known);
  return result;
}

JNIEXPORT jobjectArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectRootPaths(
    JNIEnv *jni,
    jclass controller,
    jlong target_tag,
    jint maximum_paths,
    jint maximum_depth,
    jint maximum_nodes,
    jlong maximum_edges,
    jlong scan_prefix,
    jlong session_prefix) {
  tanwei_root_path_query query;
  tanwei_root_paths_enumerator enumerator;
  jvmtiHeapCallbacks callbacks;
  jvmtiError error;
  jlong path_tags[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
  jint path_kinds[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
  jint path_indices[TANWEI_MAXIMUM_ROOT_DEPTH + 1];
  jlong flat_tags[
      TANWEI_MAXIMUM_ROOT_PATHS
      * (TANWEI_MAXIMUM_ROOT_DEPTH + 1)];
  jlong metadata[
      6
      + TANWEI_MAXIMUM_ROOT_PATHS * 2
      + TANWEI_MAXIMUM_ROOT_PATHS
          * (TANWEI_MAXIMUM_ROOT_DEPTH + 1) * 2];
  jint flat_count = 0;
  jint metadata_length = 6;
  jint depth_limit;
  jint found_objects = 0;
  jobject *objects = NULL;
  jlong *object_tags = NULL;
  jclass object_type = NULL;
  jobjectArray path_objects = NULL;
  jlongArray path_metadata = NULL;
  jobjectArray result = NULL;
  size_t multi_capacity;
  jint path_index;
  jint node_index;
  jint object_index;
  const char *failure_message = NULL;
  (void)controller;

  if (tanwei_jvmti == NULL) {
    throw_illegal_state(jni, "JVMTI root-path traversal is unavailable");
    return NULL;
  }
  if (target_tag <= 0
      || maximum_paths < 1
      || maximum_paths > TANWEI_MAXIMUM_ROOT_PATHS
      || maximum_depth < 1
      || maximum_depth > TANWEI_MAXIMUM_ROOT_DEPTH
      || maximum_nodes < 1000
      || maximum_nodes > TANWEI_MAXIMUM_ROOT_NODES
      || maximum_edges < 1000
      || maximum_edges > TANWEI_MAXIMUM_ROOT_EDGES
      || scan_prefix <= 0
      || (scan_prefix & TANWEI_TAG_PREFIX_MASK) != scan_prefix
      || session_prefix <= 0
      || (session_prefix & TANWEI_TAG_PREFIX_MASK) != session_prefix
      || scan_prefix == session_prefix
      || (target_tag & TANWEI_TAG_PREFIX_MASK) != session_prefix
      || !tag_range_available(scan_prefix | 1, maximum_nodes)) {
    throw_illegal_state(jni, "Invalid or colliding multi-root-path query");
    return NULL;
  }

  memset(&query, 0, sizeof(query));
  memset(&enumerator, 0, sizeof(enumerator));
  memset(path_tags, 0, sizeof(path_tags));
  memset(path_kinds, 0, sizeof(path_kinds));
  memset(path_indices, 0, sizeof(path_indices));
  memset(flat_tags, 0, sizeof(flat_tags));
  memset(metadata, 0, sizeof(metadata));
  query.target_tag = target_tag;
  query.session_prefix = session_prefix;
  query.scan_prefix = scan_prefix;
  query.maximum_nodes = maximum_nodes;
  query.maximum_edges = maximum_edges;
  query.maximum_paths = maximum_paths;
  multi_capacity =
      ((size_t)maximum_nodes + 1)
      * TANWEI_MAXIMUM_ROOT_PATHS;
  query.multi_parents =
      (jlong *)calloc(multi_capacity, sizeof(jlong));
  query.multi_kinds =
      (jint *)calloc(multi_capacity, sizeof(jint));
  query.multi_indices =
      (jint *)malloc(multi_capacity * sizeof(jint));
  query.multi_parent_counts =
      (unsigned char *)calloc(
          (size_t)maximum_nodes + 1,
          sizeof(unsigned char));
  query.multi_parent_overflow =
      (unsigned char *)calloc(
          (size_t)maximum_nodes + 1,
          sizeof(unsigned char));
  if (query.multi_parents == NULL
      || query.multi_kinds == NULL
      || query.multi_indices == NULL
      || query.multi_parent_counts == NULL
      || query.multi_parent_overflow == NULL) {
    failure_message =
        "Unable to allocate multi-root-path traversal state";
    goto root_paths_cleanup;
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_reference_callback = &collect_root_paths;
  error =
      (*tanwei_jvmti)->FollowReferences(
          tanwei_jvmti,
          0,
          NULL,
          NULL,
          &callbacks,
          &query);
  if (error != JVMTI_ERROR_NONE) {
    failure_message = "JVMTI multi-root-path traversal failed";
    goto root_paths_cleanup;
  }

  enumerator.query = &query;
  enumerator.roots_only = 1;
  for (depth_limit = 0;
      depth_limit <= maximum_depth
          && !enumerator.path_limit_reached
          && enumerator.enumeration_steps
              <= TANWEI_MAXIMUM_ROOT_ENUMERATION_STEPS;
      depth_limit += 1) {
    enumerator.maximum_depth = depth_limit;
    root_paths_enumerate(
        &enumerator,
        target_tag,
        0,
        path_tags,
        path_kinds,
        path_indices);
  }
  if (enumerator.result_count < maximum_paths
      && !enumerator.path_limit_reached
      && enumerator.enumeration_steps
          <= TANWEI_MAXIMUM_ROOT_ENUMERATION_STEPS) {
    enumerator.roots_only = 0;
    enumerator.maximum_depth = maximum_depth;
    root_paths_enumerate(
        &enumerator,
        target_tag,
        0,
        path_tags,
        path_kinds,
        path_indices);
  }
  if (enumerator.result_count < 1) {
    failure_message =
        "No bounded GC Root path could be reconstructed";
    goto root_paths_cleanup;
  }
  if (enumerator.path_limit_reached
      || enumerator.enumeration_truncated) {
    query.truncated = 1;
  }
  for (path_index = 0;
      path_index < enumerator.result_count;
      path_index += 1) {
    tanwei_root_path_result *path =
        &enumerator.results[path_index];
    for (node_index = 0;
        node_index < path->count;
        node_index += 1) {
      flat_tags[flat_count++] = path->tags[node_index];
    }
  }
  error =
      (*tanwei_jvmti)->GetObjectsWithTags(
          tanwei_jvmti,
          flat_count,
          flat_tags,
          &found_objects,
          &objects,
          &object_tags);
  if (error != JVMTI_ERROR_NONE) {
    failure_message =
        "JVMTI multi-root-path object resolution failed";
    goto root_paths_cleanup;
  }

  object_type = (*jni)->FindClass(jni, "java/lang/Object");
  if (object_type == NULL) {
    goto root_paths_cleanup;
  }
  path_objects =
      (*jni)->NewObjectArray(jni, flat_count, object_type, NULL);
  if (path_objects == NULL) {
    goto root_paths_cleanup;
  }
  for (object_index = 0;
      object_index < found_objects;
      object_index += 1) {
    for (node_index = 0;
        node_index < flat_count;
        node_index += 1) {
      if (object_tags != NULL
          && object_tags[object_index] == flat_tags[node_index]) {
        (*jni)->SetObjectArrayElement(
            jni,
            path_objects,
            node_index,
            objects[object_index]);
      }
    }
  }

  metadata[0] = query.visited;
  metadata[1] = (jlong)query.truncated;
  metadata[2] = (jlong)query.tagged;
  metadata[3] = (jlong)query.tag_conflicts;
  metadata[4] = (jlong)enumerator.path_limit_reached;
  metadata[5] = (jlong)enumerator.result_count;
  for (path_index = 0;
      path_index < enumerator.result_count;
      path_index += 1) {
    tanwei_root_path_result *path =
        &enumerator.results[path_index];
    metadata[metadata_length++] = (jlong)path->count;
    metadata[metadata_length++] = (jlong)path->root_reached;
    for (node_index = 0;
        node_index < path->count;
        node_index += 1) {
      metadata[metadata_length++] =
          (jlong)path->kinds[node_index];
      metadata[metadata_length++] =
          (jlong)path->indices[node_index];
    }
  }
  path_metadata =
      (*jni)->NewLongArray(jni, metadata_length);
  if (path_metadata == NULL) {
    goto root_paths_cleanup;
  }
  (*jni)->SetLongArrayRegion(
      jni,
      path_metadata,
      0,
      metadata_length,
      metadata);
  result = (*jni)->NewObjectArray(jni, 2, object_type, NULL);
  if (result != NULL && !(*jni)->ExceptionCheck(jni)) {
    (*jni)->SetObjectArrayElement(jni, result, 0, path_objects);
    (*jni)->SetObjectArrayElement(jni, result, 1, path_metadata);
  }

root_paths_cleanup:
  clear_root_path_tags(scan_prefix);
  if (objects != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)objects);
  }
  if (object_tags != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)object_tags);
  }
  free(query.multi_parents);
  free(query.multi_kinds);
  free(query.multi_indices);
  free(query.multi_parent_counts);
  free(query.multi_parent_overflow);
  if (failure_message != NULL && !(*jni)->ExceptionCheck(jni)) {
    throw_illegal_state(jni, failure_message);
    return NULL;
  }
  return result;
}

JNIEXPORT jobjectArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectRetainedSize(
    JNIEnv *jni,
    jclass controller,
    jobject target,
    jint maximum_nodes,
    jlong maximum_edges,
    jlong scan_prefix,
    jlong reference_prefix,
    jlong session_prefix,
    jobjectArray reference_classes,
    jboolean reference_classes_complete) {
  tanwei_retained_query query;
  jvmtiHeapCallbacks callbacks;
  jvmtiError error;
  unsigned char *reference_tagged = NULL;
  jlong *reference_original_tags = NULL;
  jlong top_tags[TANWEI_MAXIMUM_RETAINED_CONTRIBUTORS];
  jlong top_sizes[TANWEI_MAXIMUM_RETAINED_CONTRIBUTORS];
  jlong metadata[15 + TANWEI_MAXIMUM_RETAINED_CONTRIBUTORS];
  jint reference_count;
  jint reference_tagged_count = 0;
  jint top_count = 0;
  jint found_objects = 0;
  jobject *objects = NULL;
  jlong *object_tags = NULL;
  jobjectArray contributor_objects = NULL;
  jlongArray result_metadata = NULL;
  jobjectArray result = NULL;
  jclass object_type = NULL;
  jlong reachable_objects = 1;
  jlong reachable_bytes = 0;
  jlong candidate_objects = 1;
  jlong candidate_bytes = 0;
  jlong retained_bytes;
  jint exact;
  jint index;
  jint object_index;
  const char *failure_message = NULL;
  (void)controller;

  memset(&query, 0, sizeof(query));
  memset(top_tags, 0, sizeof(top_tags));
  memset(top_sizes, 0, sizeof(top_sizes));
  memset(metadata, 0, sizeof(metadata));
  if (tanwei_jvmti == NULL) {
    throw_illegal_state(jni, "JVMTI retained-size traversal is unavailable");
    return NULL;
  }
  if (target == NULL || reference_classes == NULL) {
    throw_illegal_state(jni, "Retained-size target and reference classes are required");
    return NULL;
  }
  reference_count = (*jni)->GetArrayLength(jni, reference_classes);
  if (maximum_nodes < 1000
      || maximum_nodes > TANWEI_MAXIMUM_ROOT_NODES
      || maximum_edges < 1000
      || maximum_edges > TANWEI_MAXIMUM_ROOT_EDGES
      || reference_count < 1
      || reference_count > TANWEI_MAXIMUM_REFERENCE_CLASSES
      || scan_prefix <= 0
      || reference_prefix <= 0
      || session_prefix <= 0
      || (scan_prefix & TANWEI_TAG_PREFIX_MASK) != scan_prefix
      || (reference_prefix & TANWEI_TAG_PREFIX_MASK) != reference_prefix
      || (session_prefix & TANWEI_TAG_PREFIX_MASK) != session_prefix
      || scan_prefix == reference_prefix
      || scan_prefix == session_prefix
      || reference_prefix == session_prefix
      || !tag_range_available(scan_prefix | 1, maximum_nodes)
      || !tag_range_available(reference_prefix | 1, reference_count)) {
    throw_illegal_state(jni, "Invalid or colliding retained-size query");
    return NULL;
  }

  query.target_tag =
      Java_dev_tanwei_agent_HeapInstanceController_objectTag(
          jni, controller, target);
  if ((*jni)->ExceptionCheck(jni)) {
    return NULL;
  }
  if (query.target_tag <= 0
      || (query.target_tag & TANWEI_TAG_PREFIX_MASK) != session_prefix) {
    throw_illegal_state(jni, "The selected object no longer has a session tag");
    return NULL;
  }
  error =
      (*tanwei_jvmti)->GetObjectSize(
          tanwei_jvmti, target, &query.target_size);
  if (error != JVMTI_ERROR_NONE || query.target_size < 0) {
    throw_illegal_state(jni, "Unable to read the selected object's shallow size");
    return NULL;
  }

  query.session_prefix = session_prefix;
  query.scan_prefix = scan_prefix;
  query.reference_prefix = reference_prefix;
  query.maximum_nodes = maximum_nodes;
  query.maximum_edges = maximum_edges;
  query.reference_class_count = reference_count;
  query.weak_semantics_complete =
      reference_classes_complete == JNI_TRUE ? 1 : 0;
  query.sizes =
      (jlong *)calloc((size_t)maximum_nodes + 1, sizeof(jlong));
  query.externally_reachable =
      (unsigned char *)calloc(
          (size_t)maximum_nodes + 1,
          sizeof(unsigned char));
  query.referent_field_indices =
      (jint *)malloc((size_t)reference_count * sizeof(jint));
  reference_tagged =
      (unsigned char *)calloc(
          (size_t)reference_count,
          sizeof(unsigned char));
  reference_original_tags =
      (jlong *)calloc((size_t)reference_count, sizeof(jlong));
  if (query.sizes == NULL
      || query.externally_reachable == NULL
      || query.referent_field_indices == NULL
      || reference_tagged == NULL
      || reference_original_tags == NULL) {
    failure_message = "Unable to allocate retained-size traversal state";
    goto retained_cleanup;
  }
  for (index = 0; index < reference_count; index += 1) {
    query.referent_field_indices[index] = -1;
  }

  for (index = 0; index < reference_count; index += 1) {
    jclass type =
        (jclass)(*jni)->GetObjectArrayElement(
            jni, reference_classes, index);
    jlong existing_tag = 0;
    jint referent_index;
    if ((*jni)->ExceptionCheck(jni)) {
      goto retained_cleanup;
    }
    if (type == NULL) {
      query.weak_semantics_complete = 0;
      continue;
    }
    referent_index = retained_referent_field_index(jni, type);
    if ((*jni)->ExceptionCheck(jni)) {
      (*jni)->DeleteLocalRef(jni, type);
      goto retained_cleanup;
    }
    query.referent_field_indices[index] = referent_index;
    error =
        (*tanwei_jvmti)->GetTag(
            tanwei_jvmti, type, &existing_tag);
    if (error != JVMTI_ERROR_NONE
        || referent_index < 0
        || existing_tag == query.target_tag
        || (existing_tag != 0
            && (existing_tag & TANWEI_TAG_PREFIX_MASK)
                != session_prefix)) {
      query.weak_semantics_complete = 0;
      (*jni)->DeleteLocalRef(jni, type);
      continue;
    }
    reference_original_tags[index] = existing_tag;
    error =
        (*tanwei_jvmti)->SetTag(
            tanwei_jvmti,
            type,
            reference_prefix | (jlong)(index + 1));
    if (error != JVMTI_ERROR_NONE) {
      query.weak_semantics_complete = 0;
      (*jni)->DeleteLocalRef(jni, type);
      continue;
    }
    reference_tagged[index] = 1;
    reference_tagged_count += 1;
    (*jni)->DeleteLocalRef(jni, type);
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_reference_callback = &collect_retained_closure;
  error =
      (*tanwei_jvmti)->FollowReferences(
          tanwei_jvmti,
          0,
          NULL,
          target,
          &callbacks,
          &query);
  if (error != JVMTI_ERROR_NONE) {
    failure_message = "JVMTI retained closure traversal failed";
    goto retained_cleanup;
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_reference_callback =
      &collect_retained_external_reachability;
  error =
      (*tanwei_jvmti)->FollowReferences(
          tanwei_jvmti,
          0,
          NULL,
          NULL,
          &callbacks,
          &query);
  if (error != JVMTI_ERROR_NONE) {
    failure_message = "JVMTI retained root traversal failed";
    goto retained_cleanup;
  }

  reachable_bytes = query.target_size;
  candidate_bytes = query.target_size;
  retained_insert_contributor(
      query.target_tag,
      query.target_size,
      top_tags,
      top_sizes,
      &top_count);
  for (index = 1; index <= query.tagged; index += 1) {
    reachable_objects += 1;
    reachable_bytes =
        saturating_add(reachable_bytes, query.sizes[index]);
    if (query.externally_reachable[index] == 0) {
      candidate_objects += 1;
      candidate_bytes =
          saturating_add(candidate_bytes, query.sizes[index]);
      retained_insert_contributor(
          scan_prefix | (jlong)index,
          query.sizes[index],
          top_tags,
          top_sizes,
          &top_count);
    }
  }
  for (index = 0; index < query.session_count; index += 1) {
    reachable_objects += 1;
    reachable_bytes =
        saturating_add(
            reachable_bytes, query.session_sizes[index]);
    if (query.session_externally_reachable[index] == 0) {
      candidate_objects += 1;
      candidate_bytes =
          saturating_add(
              candidate_bytes, query.session_sizes[index]);
      retained_insert_contributor(
          query.session_tags[index],
          query.session_sizes[index],
          top_tags,
          top_sizes,
          &top_count);
    }
  }
  exact =
      query.closure_truncated == 0
      && query.root_truncated == 0
      && query.tag_conflicts == 0
      && query.weak_semantics_complete != 0;
  retained_bytes = exact ? candidate_bytes : -1;

  error =
      (*tanwei_jvmti)->GetObjectsWithTags(
          tanwei_jvmti,
          top_count,
          top_tags,
          &found_objects,
          &objects,
          &object_tags);
  if (error != JVMTI_ERROR_NONE || found_objects < top_count) {
    failure_message = "JVMTI retained contributor resolution failed";
    goto retained_cleanup;
  }
  object_type = (*jni)->FindClass(jni, "java/lang/Object");
  if (object_type == NULL) {
    goto retained_cleanup;
  }
  contributor_objects =
      (*jni)->NewObjectArray(jni, top_count, object_type, NULL);
  if (contributor_objects == NULL) {
    goto retained_cleanup;
  }
  for (object_index = 0;
      object_index < found_objects;
      object_index += 1) {
    for (index = 0; index < top_count; index += 1) {
      if (object_tags != NULL
          && object_tags[object_index] == top_tags[index]) {
        (*jni)->SetObjectArrayElement(
            jni,
            contributor_objects,
            index,
            objects[object_index]);
        break;
      }
    }
  }

  metadata[0] = query.closure_edges;
  metadata[1] = query.root_edges;
  metadata[2] = (jlong)query.tagged;
  metadata[3] = (jlong)query.tag_conflicts;
  metadata[4] = (jlong)query.closure_truncated;
  metadata[5] = (jlong)query.root_truncated;
  metadata[6] = (jlong)reference_tagged_count;
  metadata[7] = (jlong)query.weak_semantics_complete;
  metadata[8] = (jlong)exact;
  metadata[9] = reachable_objects;
  metadata[10] = reachable_bytes;
  metadata[11] = candidate_objects;
  metadata[12] = candidate_bytes;
  metadata[13] = retained_bytes;
  metadata[14] = (jlong)top_count;
  for (index = 0; index < top_count; index += 1) {
    metadata[15 + index] = top_sizes[index];
  }
  result_metadata =
      (*jni)->NewLongArray(jni, 15 + top_count);
  if (result_metadata == NULL) {
    goto retained_cleanup;
  }
  (*jni)->SetLongArrayRegion(
      jni,
      result_metadata,
      0,
      15 + top_count,
      metadata);
  result = (*jni)->NewObjectArray(jni, 2, object_type, NULL);
  if (result != NULL && !(*jni)->ExceptionCheck(jni)) {
    (*jni)->SetObjectArrayElement(jni, result, 0, contributor_objects);
    (*jni)->SetObjectArrayElement(jni, result, 1, result_metadata);
  }

retained_cleanup:
  retained_restore_reference_class_tags(
      jni,
      reference_classes,
      reference_tagged,
      reference_original_tags,
      reference_count);
  clear_root_path_tags(scan_prefix);
  if (objects != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)objects);
  }
  if (object_tags != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)object_tags);
  }
  free(query.sizes);
  free(query.externally_reachable);
  free(query.referent_field_indices);
  free(reference_tagged);
  free(reference_original_tags);
  if (failure_message != NULL && !(*jni)->ExceptionCheck(jni)) {
    throw_illegal_state(jni, failure_message);
    return NULL;
  }
  return result;
}

JNIEXPORT jlongArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectRetainedRanking(
    JNIEnv *jni,
    jclass controller,
    jlongArray target_tags,
    jint maximum_nodes,
    jint maximum_edges,
    jlong scan_prefix,
    jlong reference_prefix,
    jlong session_prefix,
    jobjectArray reference_classes,
    jboolean reference_classes_complete) {
  tanwei_dominator_query query;
  jvmtiHeapCallbacks callbacks;
  jvmtiError error;
  jlong targets[TANWEI_MAXIMUM_RETAINED_TARGETS];
  unsigned char *reference_tagged = NULL;
  jlong *reference_original_tags = NULL;
  jlong *retained_bytes = NULL;
  jlong *retained_objects = NULL;
  jlong *metadata = NULL;
  jlongArray result = NULL;
  jint reference_count;
  jint reference_tagged_count = 0;
  jint target_count;
  jint reachable_nodes = 0;
  jlong reachable_bytes = 0;
  jint exact = 0;
  jint targets_found = 1;
  jint index;
  jint other;
  jint node;
  jint metadata_length;
  const char *failure_message = NULL;
  (void)controller;

  memset(&query, 0, sizeof(query));
  memset(targets, 0, sizeof(targets));
  if (tanwei_jvmti == NULL) {
    throw_illegal_state(
        jni, "JVMTI retained-ranking traversal is unavailable");
    return NULL;
  }
  if (target_tags == NULL || reference_classes == NULL) {
    throw_illegal_state(
        jni, "Retained-ranking targets and reference classes are required");
    return NULL;
  }
  target_count = (*jni)->GetArrayLength(jni, target_tags);
  reference_count = (*jni)->GetArrayLength(jni, reference_classes);
  if (target_count < 1
      || target_count > TANWEI_MAXIMUM_RETAINED_TARGETS
      || maximum_nodes < 10000
      || maximum_nodes > TANWEI_MAXIMUM_DOMINATOR_NODES
      || maximum_edges < 10000
      || maximum_edges > TANWEI_MAXIMUM_DOMINATOR_EDGES
      || reference_count < 1
      || reference_count > TANWEI_MAXIMUM_REFERENCE_CLASSES
      || scan_prefix <= 0
      || reference_prefix <= 0
      || session_prefix <= 0
      || (scan_prefix & TANWEI_TAG_PREFIX_MASK) != scan_prefix
      || (reference_prefix & TANWEI_TAG_PREFIX_MASK)
          != reference_prefix
      || (session_prefix & TANWEI_TAG_PREFIX_MASK)
          != session_prefix
      || scan_prefix == reference_prefix
      || scan_prefix == session_prefix
      || reference_prefix == session_prefix
      || !tag_range_available(scan_prefix | 1, maximum_nodes)
      || !tag_range_available(
          reference_prefix | 1, reference_count)) {
    throw_illegal_state(
        jni, "Invalid or colliding retained-ranking query");
    return NULL;
  }
  (*jni)->GetLongArrayRegion(
      jni, target_tags, 0, target_count, targets);
  if ((*jni)->ExceptionCheck(jni)) {
    return NULL;
  }
  for (index = 0; index < target_count; index += 1) {
    if (targets[index] <= 0
        || (targets[index] & TANWEI_TAG_PREFIX_MASK)
            != session_prefix) {
      throw_illegal_state(
          jni, "A retained-ranking target handle has expired");
      return NULL;
    }
    for (other = 0; other < index; other += 1) {
      if (targets[index] == targets[other]) {
        throw_illegal_state(
            jni, "Retained-ranking targets must be unique");
        return NULL;
      }
    }
    query.session_tags[index] = targets[index];
    query.session_nodes[index] = -1;
  }

  query.session_prefix = session_prefix;
  query.scan_prefix = scan_prefix;
  query.reference_prefix = reference_prefix;
  query.class_count = reference_count;
  query.maximum_nodes = maximum_nodes;
  query.maximum_edges = maximum_edges;
  query.session_count = target_count;
  query.target_count = target_count;
  query.reference_class_count = reference_count;
  query.weak_semantics_complete =
      reference_classes_complete == JNI_TRUE ? 1 : 0;
  query.sizes =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  query.edge_sources =
      (jint *)malloc(
          (size_t)maximum_edges * sizeof(jint));
  query.edge_targets =
      (jint *)malloc(
          (size_t)maximum_edges * sizeof(jint));
  query.referent_field_indices =
      (jint *)malloc(
          (size_t)reference_count * sizeof(jint));
  reference_tagged =
      (unsigned char *)calloc(
          (size_t)reference_count,
          sizeof(unsigned char));
  reference_original_tags =
      (jlong *)calloc(
          (size_t)reference_count,
          sizeof(jlong));
  retained_bytes =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  retained_objects =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  if (query.sizes == NULL
      || query.edge_sources == NULL
      || query.edge_targets == NULL
      || query.referent_field_indices == NULL
      || reference_tagged == NULL
      || reference_original_tags == NULL
      || retained_bytes == NULL
      || retained_objects == NULL) {
    failure_message =
        "Unable to allocate retained-ranking graph state";
    goto retained_ranking_cleanup;
  }
  for (index = 0; index < reference_count; index += 1) {
    query.referent_field_indices[index] = -1;
  }
  for (index = 0; index < reference_count; index += 1) {
    jclass type =
        (jclass)(*jni)->GetObjectArrayElement(
            jni, reference_classes, index);
    jlong existing_tag = 0;
    jint referent_index;
    if ((*jni)->ExceptionCheck(jni)) {
      goto retained_ranking_cleanup;
    }
    if (type == NULL) {
      query.weak_semantics_complete = 0;
      continue;
    }
    referent_index =
        retained_referent_field_index(jni, type);
    if ((*jni)->ExceptionCheck(jni)) {
      (*jni)->DeleteLocalRef(jni, type);
      goto retained_ranking_cleanup;
    }
    query.referent_field_indices[index] = referent_index;
    error =
        (*tanwei_jvmti)->GetTag(
            tanwei_jvmti, type, &existing_tag);
    if (error != JVMTI_ERROR_NONE
        || referent_index < 0
        || (existing_tag != 0
            && (existing_tag & TANWEI_TAG_PREFIX_MASK)
                != session_prefix)) {
      query.weak_semantics_complete = 0;
      (*jni)->DeleteLocalRef(jni, type);
      continue;
    }
    reference_original_tags[index] = existing_tag;
    error =
        (*tanwei_jvmti)->SetTag(
            tanwei_jvmti,
            type,
            reference_prefix | (jlong)(index + 1));
    if (error != JVMTI_ERROR_NONE) {
      query.weak_semantics_complete = 0;
      (*jni)->DeleteLocalRef(jni, type);
      continue;
    }
    reference_tagged[index] = 1;
    reference_tagged_count += 1;
    (*jni)->DeleteLocalRef(jni, type);
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_reference_callback =
      &collect_dominator_graph;
  error =
      (*tanwei_jvmti)->FollowReferences(
          tanwei_jvmti,
          0,
          NULL,
          NULL,
          &callbacks,
          &query);
  if (error != JVMTI_ERROR_NONE) {
    failure_message =
        "JVMTI retained-ranking graph traversal failed";
    goto retained_ranking_cleanup;
  }
  for (index = 0; index < target_count; index += 1) {
    if (query.session_nodes[index] <= 0) {
      targets_found = 0;
      query.truncated = 1;
    }
  }
  if (!dominator_compute(
      &query,
      retained_bytes,
      retained_objects,
      NULL,
      &reachable_nodes,
      &reachable_bytes)) {
    failure_message =
        "Unable to compute the retained-ranking dominator tree";
    goto retained_ranking_cleanup;
  }
  exact =
      query.truncated == 0
      && query.tag_conflicts == 0
      && query.weak_semantics_complete != 0
      && targets_found != 0
      && reachable_nodes == query.node_count;
  metadata_length = 12 + target_count * 5;
  metadata =
      (jlong *)calloc(
          (size_t)metadata_length,
          sizeof(jlong));
  if (metadata == NULL) {
    failure_message =
        "Unable to allocate retained-ranking metadata";
    goto retained_ranking_cleanup;
  }
  metadata[0] = query.node_count;
  metadata[1] = query.edge_count;
  metadata[2] = query.tag_conflicts;
  metadata[3] = query.truncated;
  metadata[4] = query.node_limit_reached;
  metadata[5] = query.edge_limit_reached;
  metadata[6] = reference_tagged_count;
  metadata[7] = query.weak_semantics_complete;
  metadata[8] = exact;
  metadata[9] = reachable_nodes;
  metadata[10] = reachable_bytes;
  metadata[11] = target_count;
  for (index = 0; index < target_count; index += 1) {
    jint offset = 12 + index * 5;
    node = query.session_nodes[index];
    metadata[offset] = node > 0 ? 1 : 0;
    if (node > 0 && node <= query.node_count) {
      metadata[offset + 1] = query.sizes[node];
      metadata[offset + 2] = retained_objects[node];
      metadata[offset + 3] = retained_bytes[node];
      metadata[offset + 4] =
          exact ? retained_bytes[node] : -1;
    } else {
      metadata[offset + 4] = -1;
    }
  }
  result = (*jni)->NewLongArray(jni, metadata_length);
  if (result == NULL) {
    goto retained_ranking_cleanup;
  }
  (*jni)->SetLongArrayRegion(
      jni,
      result,
      0,
      metadata_length,
      metadata);

retained_ranking_cleanup:
  retained_restore_reference_class_tags(
      jni,
      reference_classes,
      reference_tagged,
      reference_original_tags,
      reference_count);
  clear_root_path_tags(scan_prefix);
  free(query.sizes);
  free(query.edge_sources);
  free(query.edge_targets);
  free(query.referent_field_indices);
  free(reference_tagged);
  free(reference_original_tags);
  free(retained_bytes);
  free(retained_objects);
  free(metadata);
  if (failure_message != NULL && !(*jni)->ExceptionCheck(jni)) {
    throw_illegal_state(jni, failure_message);
    return NULL;
  }
  return result;
}

JNIEXPORT jlongArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectClassRetainedHistogram(
    JNIEnv *jni,
    jclass controller,
    jobjectArray classes,
    jint reference_class_count,
    jint maximum_nodes,
    jint maximum_edges,
    jlong scan_prefix,
    jlong class_prefix,
    jlong session_prefix,
    jboolean class_selection_complete,
    jboolean reference_selection_complete) {
  tanwei_dominator_query query;
  jvmtiHeapCallbacks callbacks;
  jvmtiError error;
  unsigned char *class_tagged = NULL;
  jlong *class_original_tags = NULL;
  jlong *retained_bytes = NULL;
  jlong *retained_objects = NULL;
  jint *immediate_dominators = NULL;
  jlong *instance_counts = NULL;
  jlong *shallow_bytes = NULL;
  jlong *class_retained_objects = NULL;
  jlong *class_retained_bytes = NULL;
  jint *active_classes = NULL;
  jint *child_offsets = NULL;
  jint *child_cursor = NULL;
  jint *children = NULL;
  jint *stack_nodes = NULL;
  jint *stack_next = NULL;
  unsigned char *stack_entered = NULL;
  jlong *metadata = NULL;
  jlongArray result = NULL;
  jint class_count;
  jint tagged_classes = 0;
  jint skipped_classes = 0;
  jint reachable_nodes = 0;
  jlong reachable_bytes = 0;
  jint exact = 0;
  jint index;
  jint node;
  jint parent;
  jint class_id;
  jint stack_top;
  jint metadata_length;
  const char *failure_message = NULL;
  (void)controller;

  memset(&query, 0, sizeof(query));
  if (tanwei_jvmti == NULL) {
    throw_illegal_state(
        jni, "JVMTI class-retained traversal is unavailable");
    return NULL;
  }
  if (classes == NULL) {
    throw_illegal_state(
        jni, "Class-retained types are required");
    return NULL;
  }
  class_count = (*jni)->GetArrayLength(jni, classes);
  if (class_count < 1
      || class_count > TANWEI_MAXIMUM_HISTOGRAM_CLASSES
      || reference_class_count < 1
      || reference_class_count > class_count
      || maximum_nodes < 10000
      || maximum_nodes > TANWEI_MAXIMUM_DOMINATOR_NODES
      || maximum_edges < 10000
      || maximum_edges > TANWEI_MAXIMUM_DOMINATOR_EDGES
      || scan_prefix <= 0
      || class_prefix <= 0
      || session_prefix <= 0
      || (scan_prefix & TANWEI_TAG_PREFIX_MASK) != scan_prefix
      || (class_prefix & TANWEI_TAG_PREFIX_MASK) != class_prefix
      || (session_prefix & TANWEI_TAG_PREFIX_MASK)
          != session_prefix
      || scan_prefix == class_prefix
      || scan_prefix == session_prefix
      || class_prefix == session_prefix
      || !tag_range_available(scan_prefix | 1, maximum_nodes)
      || !tag_range_available(class_prefix | 1, class_count)) {
    throw_illegal_state(
        jni, "Invalid or colliding class-retained query");
    return NULL;
  }

  query.session_prefix = session_prefix;
  query.scan_prefix = scan_prefix;
  query.reference_prefix = class_prefix;
  query.class_count = class_count;
  query.reference_class_count = reference_class_count;
  query.maximum_nodes = maximum_nodes;
  query.maximum_edges = maximum_edges;
  query.weak_semantics_complete =
      reference_selection_complete == JNI_TRUE ? 1 : 0;
  query.sizes =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  query.class_ids =
      (jint *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jint));
  query.edge_sources =
      (jint *)malloc(
          (size_t)maximum_edges * sizeof(jint));
  query.edge_targets =
      (jint *)malloc(
          (size_t)maximum_edges * sizeof(jint));
  query.referent_field_indices =
      (jint *)malloc(
          (size_t)class_count * sizeof(jint));
  class_tagged =
      (unsigned char *)calloc(
          (size_t)class_count,
          sizeof(unsigned char));
  class_original_tags =
      (jlong *)calloc(
          (size_t)class_count,
          sizeof(jlong));
  retained_bytes =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  retained_objects =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  immediate_dominators =
      (jint *)malloc(
          ((size_t)maximum_nodes + 1U) * sizeof(jint));
  instance_counts =
      (jlong *)calloc(
          (size_t)class_count + 1U,
          sizeof(jlong));
  shallow_bytes =
      (jlong *)calloc(
          (size_t)class_count + 1U,
          sizeof(jlong));
  class_retained_objects =
      (jlong *)calloc(
          (size_t)class_count + 1U,
          sizeof(jlong));
  class_retained_bytes =
      (jlong *)calloc(
          (size_t)class_count + 1U,
          sizeof(jlong));
  active_classes =
      (jint *)calloc(
          (size_t)class_count + 1U,
          sizeof(jint));
  child_offsets =
      (jint *)calloc(
          (size_t)maximum_nodes + 2U,
          sizeof(jint));
  child_cursor =
      (jint *)malloc(
          ((size_t)maximum_nodes + 2U) * sizeof(jint));
  children =
      (jint *)malloc(
          ((size_t)maximum_nodes + 1U) * sizeof(jint));
  stack_nodes =
      (jint *)malloc(
          ((size_t)maximum_nodes + 1U) * sizeof(jint));
  stack_next =
      (jint *)malloc(
          ((size_t)maximum_nodes + 1U) * sizeof(jint));
  stack_entered =
      (unsigned char *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(unsigned char));
  if (query.sizes == NULL
      || query.class_ids == NULL
      || query.edge_sources == NULL
      || query.edge_targets == NULL
      || query.referent_field_indices == NULL
      || class_tagged == NULL
      || class_original_tags == NULL
      || retained_bytes == NULL
      || retained_objects == NULL
      || immediate_dominators == NULL
      || instance_counts == NULL
      || shallow_bytes == NULL
      || class_retained_objects == NULL
      || class_retained_bytes == NULL
      || active_classes == NULL
      || child_offsets == NULL
      || child_cursor == NULL
      || children == NULL
      || stack_nodes == NULL
      || stack_next == NULL
      || stack_entered == NULL) {
    failure_message =
        "Unable to allocate class-retained graph state";
    goto class_retained_cleanup;
  }
  for (index = 0; index < class_count; index += 1) {
    query.referent_field_indices[index] = -1;
  }
  for (index = 0; index < class_count; index += 1) {
    jclass type =
        (jclass)(*jni)->GetObjectArrayElement(
            jni, classes, index);
    jlong existing_tag = 0;
    jint referent_index = -1;
    if ((*jni)->ExceptionCheck(jni)) {
      goto class_retained_cleanup;
    }
    if (type == NULL) {
      skipped_classes += 1;
      if (index < reference_class_count) {
        query.weak_semantics_complete = 0;
      }
      continue;
    }
    if (index < reference_class_count) {
      referent_index =
          retained_referent_field_index(jni, type);
      if ((*jni)->ExceptionCheck(jni)) {
        (*jni)->DeleteLocalRef(jni, type);
        goto class_retained_cleanup;
      }
      query.referent_field_indices[index] = referent_index;
    }
    error =
        (*tanwei_jvmti)->GetTag(
            tanwei_jvmti, type, &existing_tag);
    if (error != JVMTI_ERROR_NONE
        || (existing_tag != 0
            && (existing_tag & TANWEI_TAG_PREFIX_MASK)
                != session_prefix)
        || (index < reference_class_count
            && referent_index < 0)) {
      skipped_classes += 1;
      if (index < reference_class_count) {
        query.weak_semantics_complete = 0;
      }
      (*jni)->DeleteLocalRef(jni, type);
      continue;
    }
    class_original_tags[index] = existing_tag;
    error =
        (*tanwei_jvmti)->SetTag(
            tanwei_jvmti,
            type,
            class_prefix | (jlong)(index + 1));
    if (error != JVMTI_ERROR_NONE) {
      skipped_classes += 1;
      if (index < reference_class_count) {
        query.weak_semantics_complete = 0;
      }
      (*jni)->DeleteLocalRef(jni, type);
      continue;
    }
    class_tagged[index] = 1;
    tagged_classes += 1;
    (*jni)->DeleteLocalRef(jni, type);
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_reference_callback =
      &collect_dominator_graph;
  error =
      (*tanwei_jvmti)->FollowReferences(
          tanwei_jvmti,
          0,
          NULL,
          NULL,
          &callbacks,
          &query);
  if (error != JVMTI_ERROR_NONE) {
    failure_message =
        "JVMTI class-retained graph traversal failed";
    goto class_retained_cleanup;
  }
  if (!dominator_compute(
      &query,
      retained_bytes,
      retained_objects,
      immediate_dominators,
      &reachable_nodes,
      &reachable_bytes)) {
    failure_message =
        "Unable to compute the class-retained dominator tree";
    goto class_retained_cleanup;
  }

  for (node = 1; node <= query.node_count; node += 1) {
    parent = immediate_dominators[node];
    if (parent >= 0 && parent <= query.node_count) {
      child_offsets[parent + 1] += 1;
    }
  }
  for (index = 1;
      index <= query.node_count + 1;
      index += 1) {
    child_offsets[index] += child_offsets[index - 1];
  }
  memcpy(
      child_cursor,
      child_offsets,
      ((size_t)query.node_count + 2U) * sizeof(jint));
  for (node = 1; node <= query.node_count; node += 1) {
    parent = immediate_dominators[node];
    if (parent >= 0 && parent <= query.node_count) {
      children[child_cursor[parent]++] = node;
    }
  }

  stack_top = 0;
  stack_nodes[0] = 0;
  stack_next[0] = child_offsets[0];
  stack_entered[0] = 1;
  while (stack_top >= 0) {
    node = stack_nodes[stack_top];
    if (stack_entered[stack_top] == 0) {
      class_id = query.class_ids[node];
      if (class_id > 0 && class_id <= class_count) {
        instance_counts[class_id] =
            saturating_add(instance_counts[class_id], 1);
        shallow_bytes[class_id] =
            saturating_add(
                shallow_bytes[class_id],
                query.sizes[node]);
        if (active_classes[class_id] == 0) {
          class_retained_objects[class_id] =
              saturating_add(
                  class_retained_objects[class_id],
                  retained_objects[node]);
          class_retained_bytes[class_id] =
              saturating_add(
                  class_retained_bytes[class_id],
                  retained_bytes[node]);
        }
        if (active_classes[class_id] < INT32_MAX) {
          active_classes[class_id] += 1;
        }
      }
      stack_entered[stack_top] = 1;
      stack_next[stack_top] = child_offsets[node];
    }
    if (stack_next[stack_top] < child_offsets[node + 1]) {
      jint child =
          children[stack_next[stack_top]++];
      stack_top += 1;
      stack_nodes[stack_top] = child;
      stack_entered[stack_top] = 0;
    } else {
      class_id = node == 0 ? 0 : query.class_ids[node];
      if (class_id > 0
          && class_id <= class_count
          && active_classes[class_id] > 0) {
        active_classes[class_id] -= 1;
      }
      stack_top -= 1;
    }
  }

  exact =
      query.truncated == 0
      && query.tag_conflicts == 0
      && query.weak_semantics_complete != 0
      && class_selection_complete == JNI_TRUE
      && skipped_classes == 0
      && tagged_classes == class_count
      && reachable_nodes == query.node_count;
  metadata_length = 14 + class_count * 5;
  metadata =
      (jlong *)calloc(
          (size_t)metadata_length,
          sizeof(jlong));
  if (metadata == NULL) {
    failure_message =
        "Unable to allocate class-retained metadata";
    goto class_retained_cleanup;
  }
  metadata[0] = query.node_count;
  metadata[1] = query.edge_count;
  metadata[2] = query.tag_conflicts;
  metadata[3] = query.truncated;
  metadata[4] = query.node_limit_reached;
  metadata[5] = query.edge_limit_reached;
  metadata[6] = tagged_classes;
  metadata[7] = skipped_classes;
  metadata[8] = query.weak_semantics_complete;
  metadata[9] =
      class_selection_complete == JNI_TRUE ? 1 : 0;
  metadata[10] = exact;
  metadata[11] = reachable_nodes;
  metadata[12] = reachable_bytes;
  metadata[13] = class_count;
  for (index = 0; index < class_count; index += 1) {
    jint offset = 14 + index * 5;
    class_id = index + 1;
    metadata[offset] = instance_counts[class_id];
    metadata[offset + 1] = shallow_bytes[class_id];
    metadata[offset + 2] =
        class_retained_objects[class_id];
    metadata[offset + 3] =
        class_retained_bytes[class_id];
    metadata[offset + 4] =
        exact ? class_retained_bytes[class_id] : -1;
  }
  result = (*jni)->NewLongArray(jni, metadata_length);
  if (result == NULL) {
    goto class_retained_cleanup;
  }
  (*jni)->SetLongArrayRegion(
      jni,
      result,
      0,
      metadata_length,
      metadata);

class_retained_cleanup:
  retained_restore_reference_class_tags(
      jni,
      classes,
      class_tagged,
      class_original_tags,
      class_count);
  clear_root_path_tags(scan_prefix);
  free(query.sizes);
  free(query.class_ids);
  free(query.edge_sources);
  free(query.edge_targets);
  free(query.referent_field_indices);
  free(class_tagged);
  free(class_original_tags);
  free(retained_bytes);
  free(retained_objects);
  free(immediate_dominators);
  free(instance_counts);
  free(shallow_bytes);
  free(class_retained_objects);
  free(class_retained_bytes);
  free(active_classes);
  free(child_offsets);
  free(child_cursor);
  free(children);
  free(stack_nodes);
  free(stack_next);
  free(stack_entered);
  free(metadata);
  if (failure_message != NULL && !(*jni)->ExceptionCheck(jni)) {
    throw_illegal_state(jni, failure_message);
    return NULL;
  }
  return result;
}

JNIEXPORT jobjectArray JNICALL
Java_dev_tanwei_agent_HeapInstanceController_collectDominatorTree(
    JNIEnv *jni,
    jclass controller,
    jobjectArray classes,
    jint reference_class_count,
    jint maximum_nodes,
    jint maximum_edges,
    jint maximum_depth,
    jint maximum_view_nodes,
    jint root_limit,
    jint branch_limit,
    jlong scan_prefix,
    jlong class_prefix,
    jlong session_prefix,
    jlong output_tag_base,
    jboolean class_selection_complete,
    jboolean reference_selection_complete) {
  tanwei_dominator_query query;
  jvmtiHeapCallbacks callbacks;
  jvmtiError error;
  unsigned char *class_tagged = NULL;
  jlong *class_original_tags = NULL;
  jlong *retained_bytes = NULL;
  jlong *retained_objects = NULL;
  jint *immediate_dominators = NULL;
  jint *child_offsets = NULL;
  jint *child_cursor = NULL;
  jint *children = NULL;
  jint top_children[TANWEI_MAXIMUM_DOMINATOR_VIEW_BRANCHES];
  jint view_nodes[TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES];
  jint view_parents[TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES];
  jint view_depths[TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES];
  jint view_direct_children[TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES];
  jint view_displayed_children[TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES];
  jlong old_tags[TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES];
  jlong output_tags[TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES];
  jlong *metadata = NULL;
  jobject *objects = NULL;
  jlong *object_tags = NULL;
  jobjectArray ordered_objects = NULL;
  jlongArray result_metadata = NULL;
  jobjectArray result = NULL;
  jclass object_type = NULL;
  jint class_count;
  jint tagged_classes = 0;
  jint skipped_classes = 0;
  jint reachable_nodes = 0;
  jlong reachable_bytes = 0;
  jint exact = 0;
  jint view_truncated = 0;
  jint root_children = 0;
  jint view_count = 0;
  jint found_objects = 0;
  jint index;
  jint node;
  jint parent;
  jint direct_children;
  jint selected_children;
  jint cursor;
  jint object_index;
  jint metadata_length;
  const char *failure_message = NULL;
  (void)controller;

  memset(&query, 0, sizeof(query));
  memset(top_children, 0, sizeof(top_children));
  memset(view_nodes, 0, sizeof(view_nodes));
  memset(view_parents, 0, sizeof(view_parents));
  memset(view_depths, 0, sizeof(view_depths));
  memset(view_direct_children, 0, sizeof(view_direct_children));
  memset(view_displayed_children, 0, sizeof(view_displayed_children));
  memset(old_tags, 0, sizeof(old_tags));
  memset(output_tags, 0, sizeof(output_tags));
  if (tanwei_jvmti == NULL) {
    throw_illegal_state(
        jni, "JVMTI dominator-tree traversal is unavailable");
    return NULL;
  }
  if (classes == NULL) {
    throw_illegal_state(
        jni, "Dominator-tree classes are required");
    return NULL;
  }
  class_count = (*jni)->GetArrayLength(jni, classes);
  if (class_count < 1
      || class_count > TANWEI_MAXIMUM_HISTOGRAM_CLASSES
      || reference_class_count < 1
      || reference_class_count > class_count
      || maximum_nodes < 10000
      || maximum_nodes > TANWEI_MAXIMUM_DOMINATOR_NODES
      || maximum_edges < 10000
      || maximum_edges > TANWEI_MAXIMUM_DOMINATOR_EDGES
      || maximum_depth < 1
      || maximum_depth > TANWEI_MAXIMUM_DOMINATOR_VIEW_DEPTH
      || maximum_view_nodes < 10
      || maximum_view_nodes > TANWEI_MAXIMUM_DOMINATOR_VIEW_NODES
      || root_limit < 1
      || root_limit > TANWEI_MAXIMUM_DOMINATOR_VIEW_BRANCHES
      || branch_limit < 1
      || branch_limit > TANWEI_MAXIMUM_DOMINATOR_VIEW_BRANCHES
      || scan_prefix <= 0
      || class_prefix <= 0
      || session_prefix <= 0
      || output_tag_base <= 0
      || (scan_prefix & TANWEI_TAG_PREFIX_MASK) != scan_prefix
      || (class_prefix & TANWEI_TAG_PREFIX_MASK) != class_prefix
      || (session_prefix & TANWEI_TAG_PREFIX_MASK)
          != session_prefix
      || (output_tag_base & TANWEI_TAG_PREFIX_MASK)
          != session_prefix
      || scan_prefix == class_prefix
      || scan_prefix == session_prefix
      || class_prefix == session_prefix
      || !tag_range_available(scan_prefix | 1, maximum_nodes)
      || !tag_range_available(class_prefix | 1, class_count)
      || !tag_range_available(output_tag_base, maximum_view_nodes)) {
    throw_illegal_state(
        jni, "Invalid or colliding dominator-tree query");
    return NULL;
  }

  query.session_prefix = session_prefix;
  query.scan_prefix = scan_prefix;
  query.reference_prefix = class_prefix;
  query.class_count = class_count;
  query.reference_class_count = reference_class_count;
  query.maximum_nodes = maximum_nodes;
  query.maximum_edges = maximum_edges;
  query.weak_semantics_complete =
      reference_selection_complete == JNI_TRUE ? 1 : 0;
  query.sizes =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  query.class_ids =
      (jint *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jint));
  query.edge_sources =
      (jint *)malloc(
          (size_t)maximum_edges * sizeof(jint));
  query.edge_targets =
      (jint *)malloc(
          (size_t)maximum_edges * sizeof(jint));
  query.referent_field_indices =
      (jint *)malloc(
          (size_t)class_count * sizeof(jint));
  class_tagged =
      (unsigned char *)calloc(
          (size_t)class_count,
          sizeof(unsigned char));
  class_original_tags =
      (jlong *)calloc(
          (size_t)class_count,
          sizeof(jlong));
  retained_bytes =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  retained_objects =
      (jlong *)calloc(
          (size_t)maximum_nodes + 1U,
          sizeof(jlong));
  immediate_dominators =
      (jint *)malloc(
          ((size_t)maximum_nodes + 1U) * sizeof(jint));
  child_offsets =
      (jint *)calloc(
          (size_t)maximum_nodes + 2U,
          sizeof(jint));
  child_cursor =
      (jint *)malloc(
          ((size_t)maximum_nodes + 2U) * sizeof(jint));
  children =
      (jint *)malloc(
          ((size_t)maximum_nodes + 1U) * sizeof(jint));
  if (query.sizes == NULL
      || query.class_ids == NULL
      || query.edge_sources == NULL
      || query.edge_targets == NULL
      || query.referent_field_indices == NULL
      || class_tagged == NULL
      || class_original_tags == NULL
      || retained_bytes == NULL
      || retained_objects == NULL
      || immediate_dominators == NULL
      || child_offsets == NULL
      || child_cursor == NULL
      || children == NULL) {
    failure_message =
        "Unable to allocate dominator-tree graph state";
    goto dominator_tree_cleanup;
  }
  for (index = 0; index < class_count; index += 1) {
    query.referent_field_indices[index] = -1;
  }
  for (index = 0; index < class_count; index += 1) {
    jclass type =
        (jclass)(*jni)->GetObjectArrayElement(
            jni, classes, index);
    jlong existing_tag = 0;
    jint referent_index = -1;
    if ((*jni)->ExceptionCheck(jni)) {
      goto dominator_tree_cleanup;
    }
    if (type == NULL) {
      skipped_classes += 1;
      if (index < reference_class_count) {
        query.weak_semantics_complete = 0;
      }
      continue;
    }
    if (index < reference_class_count) {
      referent_index =
          retained_referent_field_index(jni, type);
      if ((*jni)->ExceptionCheck(jni)) {
        (*jni)->DeleteLocalRef(jni, type);
        goto dominator_tree_cleanup;
      }
      query.referent_field_indices[index] = referent_index;
    }
    error =
        (*tanwei_jvmti)->GetTag(
            tanwei_jvmti, type, &existing_tag);
    if (error != JVMTI_ERROR_NONE
        || existing_tag != 0
        || (index < reference_class_count
            && referent_index < 0)) {
      skipped_classes += 1;
      if (index < reference_class_count) {
        query.weak_semantics_complete = 0;
      }
      (*jni)->DeleteLocalRef(jni, type);
      continue;
    }
    class_original_tags[index] = existing_tag;
    error =
        (*tanwei_jvmti)->SetTag(
            tanwei_jvmti,
            type,
            class_prefix | (jlong)(index + 1));
    if (error != JVMTI_ERROR_NONE) {
      skipped_classes += 1;
      if (index < reference_class_count) {
        query.weak_semantics_complete = 0;
      }
      (*jni)->DeleteLocalRef(jni, type);
      continue;
    }
    class_tagged[index] = 1;
    tagged_classes += 1;
    (*jni)->DeleteLocalRef(jni, type);
  }

  memset(&callbacks, 0, sizeof(callbacks));
  callbacks.heap_reference_callback =
      &collect_dominator_graph;
  error =
      (*tanwei_jvmti)->FollowReferences(
          tanwei_jvmti,
          0,
          NULL,
          NULL,
          &callbacks,
          &query);
  if (error != JVMTI_ERROR_NONE) {
    failure_message =
        "JVMTI dominator-tree graph traversal failed";
    goto dominator_tree_cleanup;
  }
  if (!dominator_compute(
      &query,
      retained_bytes,
      retained_objects,
      immediate_dominators,
      &reachable_nodes,
      &reachable_bytes)) {
    failure_message =
        "Unable to compute the dominator tree";
    goto dominator_tree_cleanup;
  }
  for (node = 1; node <= query.node_count; node += 1) {
    parent = immediate_dominators[node];
    if (parent >= 0 && parent <= query.node_count) {
      child_offsets[parent + 1] += 1;
    }
  }
  for (index = 1;
      index <= query.node_count + 1;
      index += 1) {
    child_offsets[index] += child_offsets[index - 1];
  }
  memcpy(
      child_cursor,
      child_offsets,
      ((size_t)query.node_count + 2U) * sizeof(jint));
  for (node = 1; node <= query.node_count; node += 1) {
    parent = immediate_dominators[node];
    if (parent >= 0 && parent <= query.node_count) {
      children[child_cursor[parent]++] = node;
    }
  }

  root_children = child_offsets[1] - child_offsets[0];
  selected_children =
      dominator_top_children(
          child_offsets,
          children,
          retained_bytes,
          0,
          root_limit,
          top_children);
  if (selected_children < root_children) {
    view_truncated = 1;
  }
  for (index = 0;
      index < selected_children
          && view_count < maximum_view_nodes;
      index += 1) {
    node = top_children[index];
    view_nodes[view_count] = node;
    view_parents[view_count] = -1;
    view_depths[view_count] = 1;
    view_direct_children[view_count] =
        child_offsets[node + 1] - child_offsets[node];
    view_count += 1;
  }
  if (selected_children > view_count) {
    view_truncated = 1;
  }
  for (cursor = 0; cursor < view_count; cursor += 1) {
    node = view_nodes[cursor];
    direct_children =
        child_offsets[node + 1] - child_offsets[node];
    view_direct_children[cursor] = direct_children;
    if (direct_children == 0) {
      continue;
    }
    if (view_depths[cursor] >= maximum_depth) {
      view_truncated = 1;
      continue;
    }
    selected_children =
        dominator_top_children(
            child_offsets,
            children,
            retained_bytes,
            node,
            branch_limit,
            top_children);
    if (selected_children < direct_children) {
      view_truncated = 1;
    }
    for (index = 0;
        index < selected_children;
        index += 1) {
      if (view_count >= maximum_view_nodes) {
        view_truncated = 1;
        break;
      }
      parent = view_count;
      view_nodes[parent] = top_children[index];
      view_parents[parent] = cursor;
      view_depths[parent] = view_depths[cursor] + 1;
      view_direct_children[parent] =
          child_offsets[top_children[index] + 1]
          - child_offsets[top_children[index]];
      view_displayed_children[cursor] += 1;
      view_count += 1;
    }
  }

  exact =
      query.truncated == 0
      && query.tag_conflicts == 0
      && query.weak_semantics_complete != 0
      && class_selection_complete == JNI_TRUE
      && skipped_classes == 0
      && tagged_classes == class_count
      && reachable_nodes == query.node_count;
  object_type = (*jni)->FindClass(jni, "java/lang/Object");
  if (object_type == NULL) {
    goto dominator_tree_cleanup;
  }
  ordered_objects =
      (*jni)->NewObjectArray(
          jni, view_count, object_type, NULL);
  if (ordered_objects == NULL) {
    goto dominator_tree_cleanup;
  }
  for (index = 0; index < view_count; index += 1) {
    old_tags[index] =
        scan_prefix | (jlong)view_nodes[index];
    output_tags[index] =
        output_tag_base + (jlong)index;
  }
  if (view_count > 0) {
    error =
        (*tanwei_jvmti)->GetObjectsWithTags(
            tanwei_jvmti,
            view_count,
            old_tags,
            &found_objects,
            &objects,
            &object_tags);
    if (error != JVMTI_ERROR_NONE
        || found_objects != view_count) {
      failure_message =
          "Unable to resolve dominator-tree objects";
      goto dominator_tree_cleanup;
    }
    for (object_index = 0;
        object_index < found_objects;
        object_index += 1) {
      jint view_index = -1;
      for (index = 0; index < view_count; index += 1) {
        if (object_tags[object_index] == old_tags[index]) {
          view_index = index;
          break;
        }
      }
      if (view_index < 0) {
        failure_message =
            "Dominator-tree object tags are inconsistent";
        goto dominator_tree_cleanup;
      }
      error =
          (*tanwei_jvmti)->SetTag(
              tanwei_jvmti,
              objects[object_index],
              output_tags[view_index]);
      if (error != JVMTI_ERROR_NONE) {
        failure_message =
            "Unable to create dominator-tree object handles";
        goto dominator_tree_cleanup;
      }
      (*jni)->SetObjectArrayElement(
          jni,
          ordered_objects,
          view_index,
          objects[object_index]);
      if ((*jni)->ExceptionCheck(jni)) {
        goto dominator_tree_cleanup;
      }
    }
  }

  metadata_length = 20 + view_count * 10;
  metadata =
      (jlong *)calloc(
          (size_t)metadata_length,
          sizeof(jlong));
  if (metadata == NULL) {
    failure_message =
        "Unable to allocate dominator-tree metadata";
    goto dominator_tree_cleanup;
  }
  metadata[0] = query.node_count;
  metadata[1] = query.edge_count;
  metadata[2] = query.tag_conflicts;
  metadata[3] = query.truncated;
  metadata[4] = query.node_limit_reached;
  metadata[5] = query.edge_limit_reached;
  metadata[6] = tagged_classes;
  metadata[7] = skipped_classes;
  metadata[8] = query.weak_semantics_complete;
  metadata[9] =
      class_selection_complete == JNI_TRUE ? 1 : 0;
  metadata[10] = exact;
  metadata[11] = reachable_nodes;
  metadata[12] = reachable_bytes;
  metadata[13] = view_count;
  metadata[14] = maximum_depth;
  metadata[15] = maximum_view_nodes;
  metadata[16] = root_limit;
  metadata[17] = branch_limit;
  metadata[18] = view_truncated;
  metadata[19] = root_children;
  for (index = 0; index < view_count; index += 1) {
    jint offset = 20 + index * 10;
    node = view_nodes[index];
    metadata[offset] = view_parents[index];
    metadata[offset + 1] = view_depths[index];
    metadata[offset + 2] = query.sizes[node];
    metadata[offset + 3] = retained_objects[node];
    metadata[offset + 4] = retained_bytes[node];
    metadata[offset + 5] =
        exact ? retained_bytes[node] : -1;
    metadata[offset + 6] = view_direct_children[index];
    metadata[offset + 7] = view_displayed_children[index];
    metadata[offset + 8] = output_tags[index];
    metadata[offset + 9] = query.class_ids[node];
  }
  result_metadata =
      (*jni)->NewLongArray(jni, metadata_length);
  if (result_metadata == NULL) {
    goto dominator_tree_cleanup;
  }
  (*jni)->SetLongArrayRegion(
      jni,
      result_metadata,
      0,
      metadata_length,
      metadata);
  result =
      (*jni)->NewObjectArray(
          jni, 2, object_type, NULL);
  if (result != NULL && !(*jni)->ExceptionCheck(jni)) {
    (*jni)->SetObjectArrayElement(
        jni, result, 0, ordered_objects);
    (*jni)->SetObjectArrayElement(
        jni, result, 1, result_metadata);
  }

dominator_tree_cleanup:
  if ((result == NULL || (*jni)->ExceptionCheck(jni))
      && objects != NULL) {
    for (object_index = 0;
        object_index < found_objects;
        object_index += 1) {
      jlong current_tag = 0;
      if ((*tanwei_jvmti)->GetTag(
          tanwei_jvmti,
          objects[object_index],
          &current_tag) == JVMTI_ERROR_NONE
          && current_tag >= output_tag_base
          && current_tag
              < output_tag_base + maximum_view_nodes) {
        (*tanwei_jvmti)->SetTag(
            tanwei_jvmti,
            objects[object_index],
            0);
      }
    }
  }
  retained_restore_reference_class_tags(
      jni,
      classes,
      class_tagged,
      class_original_tags,
      class_count);
  clear_root_path_tags(scan_prefix);
  if (objects != NULL) {
    for (object_index = 0;
        object_index < found_objects;
        object_index += 1) {
      if (objects[object_index] != NULL) {
        (*jni)->DeleteLocalRef(
            jni, objects[object_index]);
      }
    }
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)objects);
  }
  if (object_tags != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)object_tags);
  }
  free(query.sizes);
  free(query.class_ids);
  free(query.edge_sources);
  free(query.edge_targets);
  free(query.referent_field_indices);
  free(class_tagged);
  free(class_original_tags);
  free(retained_bytes);
  free(retained_objects);
  free(immediate_dominators);
  free(child_offsets);
  free(child_cursor);
  free(children);
  free(metadata);
  if (failure_message != NULL && !(*jni)->ExceptionCheck(jni)) {
    throw_illegal_state(jni, failure_message);
    return NULL;
  }
  return result;
}

JNIEXPORT void JNICALL
Java_dev_tanwei_agent_HeapInstanceController_clearObjectTag(
    JNIEnv *jni,
    jclass controller,
    jlong tag) {
  jlong tags[1];
  jint found = 0;
  jint index;
  jobject *objects = NULL;
  jvmtiError error;
  (void)controller;
  if (tanwei_jvmti == NULL || tag <= 0) {
    return;
  }
  tags[0] = tag;
  error = (*tanwei_jvmti)->GetObjectsWithTags(
      tanwei_jvmti,
      1,
      tags,
      &found,
      &objects,
      NULL);
  if (error != JVMTI_ERROR_NONE) {
    throw_illegal_state(jni, "JVMTI tagged-object cleanup failed");
    return;
  }
  for (index = 0; index < found; index += 1) {
    (*tanwei_jvmti)->SetTag(tanwei_jvmti, objects[index], 0);
  }
  if (objects != NULL) {
    (*tanwei_jvmti)->Deallocate(
        tanwei_jvmti, (unsigned char *)objects);
  }
}
