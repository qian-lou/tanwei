package dev.tanwei.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Machine-readable mapping from Arthas command concepts to Tanwei actions. */
final class ArthasEcosystemManifest {
  static final String BASELINE_VERSION = "4.3.2";
  static final String COMMAND_SCOPE = "COMMAND";
  static final String ECOSYSTEM_SCOPE = "ECOSYSTEM";

  private static final List<Entry> COMMAND_ENTRIES = entries(
      command("dashboard", "DESKTOP_NATIVE", "runtime", "jvm.info,memory.pools,gc.collectors", "Desktop dashboards replace terminal refresh output"),
      command("getstatic", "SAFE_SUBSET", "classes", "class.static.fields,class.static.read.preview,class.static.read", "Exact static-field reads without OGNL evaluation"),
      command("heapdump", "FUNCTIONAL_EQUIVALENT", "heap-dump", "heap.dump", "Explicit confirmation and local artifact hashing"),
      command("jvm", "FUNCTIONAL_EQUIVALENT", "runtime", "jvm.info,jvm.arguments", "Structured JVM and runtime facts"),
      command("logger", "SAFE_SUBSET", "loggers", "logger.list,logger.describe,logger.level.preview,logger.level.set", "JUL and loaded Logback, Log4j 1.x and Log4j2 with guarded level changes"),
      command("mbean", "SAFE_SUBSET", "mbeans", "mbean.list,mbean.describe,mbean.attribute.read,mbean.attribute.write.preview,mbean.attribute.write,mbean.operation.preview,mbean.operation.invoke", "Bounded OpenType reads and guarded mutation; dangerous platform operations are rejected"),
      command("memory", "FUNCTIONAL_EQUIVALENT", "runtime", "memory.pools,gc.collectors", "Structured memory-pool and garbage-collector facts"),
      command("ognl", "NOT_EXPOSED", "", "", "Arbitrary expression execution is intentionally outside the trust boundary"),
      command("perfcounter", "FUNCTIONAL_EQUIVALENT", "perfcounters", "perfcounter.list,perfcounter.snapshot", "Bounded HotSpot counters and exact multi-counter snapshots"),
      command("sysenv", "FUNCTIONAL_EQUIVALENT", "runtime", "environment.list", "Read-only bounded search with sensitive-value masking"),
      command("sysprop", "SAFE_SUBSET", "runtime", "system.property.list,system.property.set", "Search plus guarded writes to existing non-sensitive properties"),
      command("thread", "FUNCTIONAL_EQUIVALENT", "threads", "thread.locks,thread.dump,thread.interrupt.preview,thread.interrupt", "Bounded structured thread inspection; list and details use typed RPCs"),
      command("vmoption", "SAFE_SUBSET", "runtime", "vm.option.list,vm.option.set", "Only writeable HotSpot options can be changed and require policy authorization"),
      command("vmtool", "SAFE_SUBSET", "heap-instances", "heap.instances,heap.relations,heap.object.graph,heap.root.paths,heap.retained,heap.retained.ranking,gc.run,thread.interrupt.preview,thread.interrupt", "Bounded object handles and graph analysis without arbitrary OGNL or reflective invocation"),
      command("classloader", "FUNCTIONAL_EQUIVALENT", "classes", "classloaders.summary,classloader.metaspace,classloader.resources", "Exact ClassLoader identity is preserved"),
      command("classloader-metaspace", "FUNCTIONAL_EQUIVALENT", "classes", "classloader.metaspace", "Bounded per-ClassLoader metaspace evidence"),
      command("dump", "FUNCTIONAL_EQUIVALENT", "class-dump", "class.dump", "Exact loaded-class bytecode artifact"),
      command("jad", "DESKTOP_NATIVE", "classes", "", "CFR-backed decompilation is performed by the desktop artifact workflow"),
      command("mc", "NOT_EXPOSED", "", "", "In-target source compilation is intentionally not exposed; guarded host compilation backs class change sets"),
      command("redefine", "SAFE_SUBSET", "class-redefine", "class.redefine.preview,class.redefine,class.redefine.restore,class.change-set.preview,class.change-set.apply,class.change-set.restore", "Method-body-only replacement with schema checks, drift detection and bounded rollback"),
      command("retransform", "SAFE_SUBSET", "retransform", "retransform.status,retransform.retry", "Probe ownership and rollback recovery; Arthas class-file entry management is not implemented"),
      command("sc", "FUNCTIONAL_EQUIVALENT", "classes", "", "Loaded-class search and detail use typed RPCs"),
      command("sm", "FUNCTIONAL_EQUIVALENT", "classes", "", "Declared-method search uses typed class-detail RPCs"),
      command("monitor", "SAFE_SUBSET", "monitor", "monitor.preview,monitor.start,monitor.windows,monitor.threshold.update,tasks.cancel", "Exact method signatures, bounded windows and thresholds; no OGNL conditions or pattern fan-out"),
      command("line", "SAFE_SUBSET", "line-probe", "line.preview,line.start,line.events,tasks.cancel", "Exact source line and bounded local values without arbitrary expressions"),
      command("stack", "SAFE_SUBSET", "line-probe", "line.preview,line.start,line.events,tasks.cancel", "Exact source-line caller stacks instead of pattern-wide OGNL conditions"),
      command("trace", "SAFE_SUBSET", "trace", "trace.preview,trace.start,trace.events,trace.threshold.update,tasks.cancel", "Bounded cross-class trees and path filters for an exact root signature; no OGNL or dynamic command stacking"),
      command("tt", "SAFE_SUBSET", "snapshots", "snapshot.list,snapshot.describe,snapshot.delete,invoke.replay.preview,invoke.replay", "Bounded rendered snapshots; replay is limited to validated scalar signatures and live receivers"),
      command("watch", "SAFE_SUBSET", "observe", "observe.preview,observe.start,tasks.cancel", "BEFORE, RETURN, THROW and FINISH phases with bounded structured conditions instead of OGNL"),
      command("profiler", "SAFE_SUBSET", "profiler", "profile.start,profile.status,profile.dump,profile.stop", "CPU, wall, allocation and lock profiling with live snapshots; broader async-profiler actions and events are not exposed"),
      command("jfr", "SAFE_SUBSET", "jfr", "jfr.start,jfr.status,jfr.dump,jfr.stop", "One named profile/default recording with max age, max size and live dump"),
      command("auth", "DESKTOP_NATIVE", "target", "", "Per-connection credentials and Host policy replace Arthas session authentication"),
      command("options", "SAFE_SUBSET", "settings", "", "Desktop settings and policy replace a subset of Arthas global switches"),
      command("grep", "NOT_EXPOSED", "", "", "Structured result filters replace shell text pipelines"),
      command("plaintext", "NOT_EXPOSED", "", "", "Structured results do not contain ANSI terminal formatting"),
      command("wc", "NOT_EXPOSED", "", "", "Structured responses publish explicit counts instead of shell line counting"),
      command("jobs", "DESKTOP_NATIVE", "tasks", "tasks.list,tasks.cancel", "Structured task lifecycle replaces shell jobs"),
      command("kill", "SAFE_SUBSET", "tasks", "tasks.cancel", "Only exact Tanwei-owned task cancellation is allowed"),
      command("fg", "NOT_EXPOSED", "", "", "Desktop tasks have no foreground shell process"),
      command("bg", "NOT_EXPOSED", "", "", "Desktop tasks already run independently of the active page"),
      command("base64", "NOT_EXPOSED", "", "", "Terminal utility commands are outside the diagnostic API"),
      command("cat", "NOT_EXPOSED", "", "", "Arbitrary target-file reads are outside the trust boundary"),
      command("cls", "NOT_EXPOSED", "", "", "The desktop has no terminal screen buffer"),
      command("echo", "NOT_EXPOSED", "", "", "Terminal utility commands are outside the diagnostic API"),
      command("exit", "DESKTOP_NATIVE", "target", "", "Disconnecting a desktop target replaces exiting one shell client"),
      command("help", "DESKTOP_NATIVE", "capabilities", "arthas.compatibility,arthas.resolve", "The capability launcher and compatibility discovery replace shell help"),
      command("history", "DESKTOP_NATIVE", "audit", "", "Structured diagnostic audit replaces command-line history"),
      command("july", "NOT_EXPOSED", "", "", "Hidden terminal novelty commands are outside the diagnostic API"),
      command("keymap", "NOT_EXPOSED", "", "", "Desktop accessibility shortcuts are not an Arthas keymap endpoint"),
      command("pwd", "NOT_EXPOSED", "", "", "The Agent does not expose an arbitrary working-directory shell"),
      command("quit", "DESKTOP_NATIVE", "target", "", "Disconnecting a desktop target replaces quitting one shell client"),
      command("reset", "FUNCTIONAL_EQUIVALENT", "tasks", "session.reset.preview,session.reset", "Fingerprint-protected cleanup of Tanwei-owned tasks and class state"),
      command("session", "DESKTOP_NATIVE", "target", "", "The target connection model replaces Arthas shell sessions"),
      command("stop", "DESKTOP_NATIVE", "target", "", "Safe disconnect and Agent shutdown replace the shell server stop command"),
      command("tee", "NOT_EXPOSED", "", "", "Validated artifacts replace arbitrary target-side output redirection"),
      command("thanks", "NOT_EXPOSED", "", "", "Hidden terminal credit output is outside the diagnostic API"),
      command("version", "DESKTOP_NATIVE", "target", "", "Agent and protocol versions are published in connection capabilities"));

  private static final List<Entry> ECOSYSTEM_ENTRIES = entries(
      ecosystem("telnet", "NOT_WIRE_COMPATIBLE", "arthas-ecosystem", "arthas.compatibility,arthas.resolve", "Authenticated Tanwei gRPC actions do not emulate the Arthas Telnet protocol"),
      ecosystem("websocket", "NOT_WIRE_COMPATIBLE", "arthas-ecosystem", "arthas.compatibility,arthas.resolve", "The Arthas WebSocket terminal protocol is not emulated"),
      ecosystem("http-api", "NOT_WIRE_COMPATIBLE", "arthas-ecosystem", "arthas.compatibility,arthas.resolve", "The Arthas command/session HTTP API is not emulated"),
      ecosystem("web-console", "NOT_WIRE_COMPATIBLE", "workbench", "", "Tanwei is a native desktop workbench, not the Arthas browser terminal"),
      ecosystem("mcp-server", "NOT_EXPOSED", "", "", "The Arthas MCP JSON-RPC and Streamable HTTP endpoint is not implemented"),
      ecosystem("tunnel", "NOT_WIRE_COMPATIBLE", "target", "", "Tanwei SSH, Kubernetes and mTLS Relay workflows do not implement the Arthas agent-id tunnel protocol"),
      ecosystem("spring-boot-starter", "NOT_EXPOSED", "", "", "Tanwei currently attaches externally and does not publish an Arthas-compatible starter"),
      ecosystem("external-command", "NOT_WIRE_COMPATIBLE", "governance", "", "Signed declarative Tanwei templates do not implement the Arthas CommandResolver SPI"),
      ecosystem("batch", "SAFE_SUBSET", "governance", "", "Signed typed diagnostic templates replace arbitrary command-text batch scripts"));

  private static final List<Entry> ENTRIES = combine(COMMAND_ENTRIES, ECOSYSTEM_ENTRIES);

  private static final Map<String, Entry> BY_COMMAND = index(ENTRIES);

  private ArthasEcosystemManifest() {}

  static List<Entry> all() {
    return ENTRIES;
  }

  static List<Entry> commands() {
    return COMMAND_ENTRIES;
  }

  static List<Entry> ecosystem() {
    return ECOSYSTEM_ENTRIES;
  }

  static Entry resolve(String command) {
    if (command == null) {
      return null;
    }
    return BY_COMMAND.get(command.trim().toLowerCase(Locale.ROOT));
  }

  private static Entry command(
      String command,
      String compatibility,
      String capability,
      String actionIds,
      String boundary) {
    return new Entry(
        COMMAND_SCOPE, command, compatibility, capability, actionIds, boundary);
  }

  private static Entry ecosystem(
      String command,
      String compatibility,
      String capability,
      String actionIds,
      String boundary) {
    return new Entry(
        ECOSYSTEM_SCOPE, command, compatibility, capability, actionIds, boundary);
  }

  private static List<Entry> entries(Entry... values) {
    List<Entry> result = new ArrayList<Entry>(values.length);
    Collections.addAll(result, values);
    return Collections.unmodifiableList(result);
  }

  private static List<Entry> combine(List<Entry> first, List<Entry> second) {
    List<Entry> result = new ArrayList<Entry>(first.size() + second.size());
    result.addAll(first);
    result.addAll(second);
    return Collections.unmodifiableList(result);
  }

  private static Map<String, Entry> index(List<Entry> entries) {
    Map<String, Entry> result = new LinkedHashMap<String, Entry>();
    for (Entry entry : entries) {
      if (result.put(entry.command, entry) != null) {
        throw new IllegalStateException("Duplicate Arthas ecosystem command: " + entry.command);
      }
    }
    result.put("telnet/http-api", result.get("http-api"));
    return Collections.unmodifiableMap(result);
  }

  static final class Entry {
    private final String scope;
    private final String command;
    private final String compatibility;
    private final String capability;
    private final String actionIds;
    private final String boundary;

    private Entry(
        String scope,
        String command,
        String compatibility,
        String capability,
        String actionIds,
        String boundary) {
      this.scope = scope;
      this.command = command;
      this.compatibility = compatibility;
      this.capability = capability;
      this.actionIds = actionIds;
      this.boundary = boundary;
    }

    String getScope() {
      return scope;
    }

    String getCommand() {
      return command;
    }

    String getCompatibility() {
      return compatibility;
    }

    String getCapability() {
      return capability;
    }

    String getActionIds() {
      return actionIds;
    }

    String getBoundary() {
      return boundary;
    }
  }
}
