package dev.tanwei.agent;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogManager;
import java.util.logging.Logger;

final class LoggerExplorer {
  private static final int MAXIMUM_LOGGERS = 20_000;
  private static final int MAXIMUM_HANDLERS = 100;
  private static final int MAXIMUM_VALUE_LENGTH = 4_096;
  private static final Set<String> JUL_LEVELS =
      immutableSet(
          "<inherited>",
          "OFF",
          "SEVERE",
          "WARNING",
          "INFO",
          "CONFIG",
          "FINE",
          "FINER",
          "FINEST",
          "ALL");
  private static final Set<String> LOGBACK_LEVELS =
      immutableSet(
          "<inherited>",
          "OFF",
          "ERROR",
          "WARN",
          "INFO",
          "DEBUG",
          "TRACE",
          "ALL");
  private static final Set<String> LOG4J_LEVELS =
      immutableSet(
          "<inherited>",
          "OFF",
          "FATAL",
          "ERROR",
          "WARN",
          "INFO",
          "DEBUG",
          "TRACE",
          "ALL");
  private static final Set<String> LOG4J2_LEVELS =
      immutableSet(
          "OFF",
          "FATAL",
          "ERROR",
          "WARN",
          "INFO",
          "DEBUG",
          "TRACE",
          "ALL");

  private final Instrumentation instrumentation;

  LoggerExplorer(Instrumentation instrumentation) {
    this.instrumentation = instrumentation;
  }

  Map<String, String> list(
      String query,
      String requestedFramework,
      int offset,
      int limit) {
    String framework = normalizeFramework(requestedFramework);
    String normalizedQuery =
        query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
    CollectionResult collected = collect(framework);
    List<LoggerSummary> matched = new ArrayList<LoggerSummary>();
    for (LoggerSummary logger : collected.loggers) {
      if (normalizedQuery.isEmpty()
          || logger.name.toLowerCase(Locale.ROOT).contains(normalizedQuery)
          || logger.context.toLowerCase(Locale.ROOT).contains(normalizedQuery)) {
        matched.add(logger);
      }
    }
    matched.sort(
        Comparator.comparing((LoggerSummary logger) -> logger.framework)
            .thenComparing(logger -> logger.contextId)
            .thenComparing(logger -> logger.name));

    int safeOffset = Math.min(offset, matched.size());
    int end = Math.min(matched.size(), safeOffset + limit);
    Map<String, String> values = frameworkValues(collected);
    values.put("total", Integer.toString(matched.size()));
    values.put("offset", Integer.toString(safeOffset));
    values.put("count", Integer.toString(end - safeOffset));
    values.put("truncated", Boolean.toString(collected.truncated));
    for (int index = safeOffset; index < end; index++) {
      LoggerSummary logger = matched.get(index);
      String prefix =
          String.format(Locale.ROOT, "logger.%04d.", index - safeOffset);
      addLoggerValues(values, prefix, logger);
    }
    return values;
  }

  Map<String, String> describe(
      String requestedFramework,
      String contextId,
      String name) {
    String framework = normalizeFramework(requestedFramework);
    CollectionResult collected = collect(framework);
    for (LoggerSummary logger : collected.loggers) {
      if (logger.framework.equals(framework)
          && logger.contextId.equals(contextId)
          && logger.name.equals(name)) {
        Map<String, String> values = frameworkValues(collected);
        addLoggerValues(values, "", logger);
        values.put("handler.count", Integer.toString(logger.handlers.size()));
        for (int index = 0; index < logger.handlers.size(); index++) {
          HandlerSummary handler = logger.handlers.get(index);
          String prefix =
              String.format(Locale.ROOT, "handler.%04d.", index);
          values.put(prefix + "name", trim(handler.name));
          values.put(prefix + "type", trim(handler.type));
          values.put(prefix + "level", trim(handler.level));
          values.put(prefix + "detail", trim(handler.detail));
        }
        return values;
      }
    }
    throw new IllegalArgumentException(
        "The selected logger no longer exists in its original context");
  }

  synchronized Map<String, String> previewLevelChange(
      String requestedFramework,
      String contextId,
      String name,
      String requestedLevel) {
    String framework = normalizeFramework(requestedFramework);
    if ("ALL".equals(framework)) {
      throw new IllegalArgumentException(
          "A concrete logger framework is required");
    }
    LoggerSelection selection =
        resolveLogger(framework, contextId, name);
    String newLevel = normalizeLevel(framework, requestedLevel);
    return levelChangeValues(selection, newLevel, false);
  }

  synchronized Map<String, String> setLevel(
      String requestedFramework,
      String contextId,
      String name,
      String requestedLevel,
      String expectedFingerprint) {
    String framework = normalizeFramework(requestedFramework);
    if ("ALL".equals(framework)) {
      throw new IllegalArgumentException(
          "A concrete logger framework is required");
    }
    LoggerSelection selection =
        resolveLogger(framework, contextId, name);
    String newLevel = normalizeLevel(framework, requestedLevel);
    String actualFingerprint = levelFingerprint(selection);
    if (!actualFingerprint.equals(expectedFingerprint)) {
      throw new StaleLoggerLevelException(
          "Logger level changed after preview");
    }

    String oldLevel = selection.explicitLevel();
    if (!oldLevel.equals(newLevel)) {
      try {
        applyLevel(selection, newLevel);
        String appliedLevel = selection.explicitLevel();
        if (!newLevel.equals(appliedLevel)) {
          throw new IllegalStateException(
              "The logging framework did not apply the requested level");
        }
      } catch (Throwable failure) {
        try {
          applyLevel(selection, oldLevel);
        } catch (Throwable rollbackFailure) {
          failure.addSuppressed(rollbackFailure);
        }
        throw new IllegalStateException(
            "Unable to change the selected logger level",
            rootCause(failure));
      }
    }
    return levelChangeValues(selection, oldLevel, true);
  }

  private Map<String, String> levelChangeValues(
      LoggerSelection selection,
      String proposedOrOldLevel,
      boolean applied) {
    Map<String, String> values = new TreeMap<String, String>();
    String currentLevel = selection.explicitLevel();
    values.put("framework", selection.framework);
    values.put("contextId", selection.contextId);
    values.put("name", trim(selection.name));
    values.put("currentLevel", currentLevel);
    values.put("effectiveLevel", selection.effectiveLevel());
    values.put(
        applied ? "oldValue" : "newLevel",
        proposedOrOldLevel);
    values.put(
        applied ? "newValue" : "changed",
        applied
            ? currentLevel
            : Boolean.toString(
                !currentLevel.equals(proposedOrOldLevel)));
    values.put(
        applied ? "rollbackFingerprint" : "fingerprint",
        levelFingerprint(selection));
    values.put(
        "boundary",
        "Exact framework, context and logger identity; fingerprint rejects concurrent level drift");
    return values;
  }

  private LoggerSelection resolveLogger(
      String framework,
      String rawContextId,
      String rawName) {
    String contextId =
        requiredValue(rawContextId, "Logger context", MAXIMUM_VALUE_LENGTH);
    String name =
        requiredValue(rawName, "Logger name", MAXIMUM_VALUE_LENGTH);
    if ("JUL".equals(framework)) {
      if (!"jul:platform".equals(contextId)) {
        throw new IllegalArgumentException(
            "The selected JUL context no longer exists");
      }
      String loggerName = "<root>".equals(name) ? "" : name;
      Logger logger = LogManager.getLogManager().getLogger(loggerName);
      if (logger == null) {
        throw new IllegalArgumentException(
            "The selected JUL logger no longer exists");
      }
      return new LoggerSelection(
          framework, contextId, name, logger, null);
    }
    if ("LOGBACK".equals(framework)) {
      return resolveLogbackLogger(contextId, name);
    }
    if ("LOG4J".equals(framework)) {
      return resolveLog4jLogger(contextId, name);
    }
    if ("LOG4J2".equals(framework)) {
      return resolveLog4j2Logger(contextId, name);
    }
    throw new IllegalArgumentException(
        "Unsupported logger framework");
  }

  private LoggerSelection resolveLogbackLogger(
      String contextId,
      String name) {
    for (Class<?> contextType :
        loadedClasses("ch.qos.logback.classic.LoggerContext")) {
      ClassLoader loader = contextType.getClassLoader();
      if (!contextId.equals("logback:" + loaderIdentity(loader))) {
        continue;
      }
      try {
        Class<?> factoryType =
            Class.forName("org.slf4j.LoggerFactory", false, loader);
        Object context =
            factoryType.getMethod("getILoggerFactory").invoke(null);
        if (!contextType.isInstance(context)) {
          continue;
        }
        Object rawLoggers =
            contextType.getMethod("getLoggerList").invoke(context);
        if (!(rawLoggers instanceof Iterable<?>)) {
          continue;
        }
        for (Object logger : (Iterable<?>) rawLoggers) {
          if (name.equals(optionalString(logger, "getName", ""))) {
            return new LoggerSelection(
                "LOGBACK", contextId, name, logger, context);
          }
        }
      } catch (Throwable failure) {
        throw new IllegalStateException(
            "Unable to resolve the selected Logback context",
            rootCause(failure));
      }
    }
    throw new IllegalArgumentException(
        "The selected Logback logger no longer exists");
  }

  private LoggerSelection resolveLog4j2Logger(
      String contextId,
      String name) {
    for (Class<?> contextType :
        loadedClasses("org.apache.logging.log4j.core.LoggerContext")) {
      ClassLoader loader = contextType.getClassLoader();
      if (!contextId.equals("log4j2:" + loaderIdentity(loader))) {
        continue;
      }
      Thread currentThread = Thread.currentThread();
      ClassLoader previousLoader = currentThread.getContextClassLoader();
      try {
        currentThread.setContextClassLoader(loader);
        Class<?> managerType =
            Class.forName(
                "org.apache.logging.log4j.LogManager", false, loader);
        Object context =
            managerType
                .getMethod("getContext", boolean.class)
                .invoke(null, false);
        if (!contextType.isInstance(context)) {
          continue;
        }
        Object configuration =
            contextType.getMethod("getConfiguration").invoke(context);
        Object logger = null;
        if ("<root>".equals(name)) {
          logger =
              configuration
                  .getClass()
                  .getMethod("getRootLogger")
                  .invoke(configuration);
        } else {
          Object rawLoggers =
              configuration.getClass().getMethod("getLoggers").invoke(configuration);
          if (rawLoggers instanceof Map<?, ?>) {
            logger = ((Map<?, ?>) rawLoggers).get(name);
          }
        }
        if (logger != null) {
          return new LoggerSelection(
              "LOG4J2", contextId, name, logger, context);
        }
      } catch (Throwable failure) {
        throw new IllegalStateException(
            "Unable to resolve the selected Log4j2 context",
            rootCause(failure));
      } finally {
        currentThread.setContextClassLoader(previousLoader);
      }
    }
    throw new IllegalArgumentException(
        "The selected Log4j2 logger no longer exists");
  }

  private LoggerSelection resolveLog4jLogger(
      String contextId,
      String name) {
    for (Class<?> loggerType : loadedClasses("org.apache.log4j.Logger")) {
      ClassLoader loader = loggerType.getClassLoader();
      if (!contextId.equals("log4j:" + loaderIdentity(loader))) {
        continue;
      }
      try {
        Class<?> managerType =
            Class.forName("org.apache.log4j.LogManager", false, loader);
        Object repository =
            managerType.getMethod("getLoggerRepository").invoke(null);
        Object logger =
            "<root>".equals(name)
                ? managerType.getMethod("getRootLogger").invoke(null)
                : repository
                    .getClass()
                    .getMethod("exists", String.class)
                    .invoke(repository, name);
        if (loggerType.isInstance(logger)) {
          return new LoggerSelection(
              "LOG4J", contextId, name, logger, repository);
        }
      } catch (Throwable failure) {
        throw new IllegalStateException(
            "Unable to resolve the selected Log4j context",
            rootCause(failure));
      }
    }
    throw new IllegalArgumentException(
        "The selected Log4j logger no longer exists");
  }

  private static void applyLevel(
      LoggerSelection selection,
      String level)
      throws Exception {
    if ("JUL".equals(selection.framework)) {
      Logger logger = (Logger) selection.logger;
      logger.setLevel(
          "<inherited>".equals(level) ? null : Level.parse(level));
      return;
    }
    ClassLoader loader = selection.logger.getClass().getClassLoader();
    if ("LOGBACK".equals(selection.framework)) {
      Class<?> levelType =
          Class.forName(
              "ch.qos.logback.classic.Level", false, loader);
      Object frameworkLevel =
          "<inherited>".equals(level)
              ? null
              : levelType
                  .getMethod("toLevel", String.class)
                  .invoke(null, level);
      selection.logger
          .getClass()
          .getMethod("setLevel", levelType)
          .invoke(selection.logger, frameworkLevel);
      return;
    }
    if ("LOG4J".equals(selection.framework)) {
      Class<?> levelType =
          Class.forName("org.apache.log4j.Level", false, loader);
      Object frameworkLevel =
          "<inherited>".equals(level)
              ? null
              : levelType
                  .getMethod("toLevel", String.class)
                  .invoke(null, level);
      selection.logger
          .getClass()
          .getMethod("setLevel", levelType)
          .invoke(selection.logger, frameworkLevel);
      return;
    }
    if ("LOG4J2".equals(selection.framework)) {
      Class<?> levelType =
          Class.forName(
              "org.apache.logging.log4j.Level", false, loader);
      Object frameworkLevel =
          levelType
              .getMethod("valueOf", String.class)
              .invoke(null, level);
      selection.logger
          .getClass()
          .getMethod("setLevel", levelType)
          .invoke(selection.logger, frameworkLevel);
      selection.context
          .getClass()
          .getMethod("updateLoggers")
          .invoke(selection.context);
      return;
    }
    throw new IllegalArgumentException(
        "Unsupported logger framework");
  }

  private static String normalizeLevel(
      String framework,
      String requestedLevel) {
    String normalized =
        requestedLevel == null
            ? ""
            : requestedLevel.trim().toUpperCase(Locale.ROOT);
    if ("<INHERITED>".equals(normalized)) {
      normalized = "<inherited>";
    }
    Set<String> allowed =
        "JUL".equals(framework)
            ? JUL_LEVELS
            : "LOGBACK".equals(framework)
                ? LOGBACK_LEVELS
                : "LOG4J".equals(framework)
                    ? LOG4J_LEVELS
                    : LOG4J2_LEVELS;
    if (!allowed.contains(normalized)) {
      throw new IllegalArgumentException(
          "The requested level is invalid for " + framework);
    }
    return normalized;
  }

  private static String levelFingerprint(
      LoggerSelection selection) {
    String material =
        selection.framework
            + "\u0000"
            + selection.contextId
            + "\u0000"
            + selection.name
            + "\u0000"
            + selection.explicitLevel()
            + "\u0000"
            + selection.effectiveLevel();
    try {
      byte[] digest =
          MessageDigest.getInstance("SHA-256")
              .digest(material.getBytes(StandardCharsets.UTF_8));
      StringBuilder value = new StringBuilder(digest.length * 2);
      for (byte current : digest) {
        value.append(
            String.format(Locale.ROOT, "%02x", current & 0xff));
      }
      return value.toString();
    } catch (NoSuchAlgorithmException exception) {
      throw new IllegalStateException(
          "SHA-256 is unavailable", exception);
    }
  }

  private static String requiredValue(
      String value,
      String label,
      int maximumLength) {
    if (value == null
        || value.trim().isEmpty()
        || value.length() > maximumLength
        || value.indexOf('\r') >= 0
        || value.indexOf('\n') >= 0
        || value.indexOf('\u0000') >= 0) {
      throw new IllegalArgumentException(label + " is invalid");
    }
    return value;
  }

  private static Set<String> immutableSet(
      String... values) {
    return Collections.unmodifiableSet(
        new HashSet<String>(Arrays.asList(values)));
  }

  private CollectionResult collect(String framework) {
    CollectionResult result = new CollectionResult();
    if ("ALL".equals(framework) || "JUL".equals(framework)) {
      collectJul(result);
    }
    if ("ALL".equals(framework) || "LOGBACK".equals(framework)) {
      collectLogback(result);
    }
    if ("ALL".equals(framework) || "LOG4J".equals(framework)) {
      collectLog4j(result);
    }
    if ("ALL".equals(framework) || "LOG4J2".equals(framework)) {
      collectLog4j2(result);
    }
    return result;
  }

  private void collectJul(CollectionResult result) {
    result.frameworkStates.put("JUL", "AVAILABLE");
    LogManager manager = LogManager.getLogManager();
    Enumeration<String> names = manager.getLoggerNames();
    while (names.hasMoreElements()) {
      if (result.loggers.size() >= MAXIMUM_LOGGERS) {
        result.truncated = true;
        return;
      }
      String rawName = names.nextElement();
      Logger logger = manager.getLogger(rawName);
      if (logger == null) {
        continue;
      }
      List<HandlerSummary> handlers = new ArrayList<HandlerSummary>();
      Handler[] directHandlers = logger.getHandlers();
      int handlerLimit = Math.min(directHandlers.length, MAXIMUM_HANDLERS);
      for (int index = 0; index < handlerLimit; index++) {
        Handler handler = directHandlers[index];
        handlers.add(
            new HandlerSummary(
                handler.getClass().getSimpleName(),
                handler.getClass().getName(),
                handler.getLevel() == null
                    ? "<inherited>"
                    : handler.getLevel().getName(),
                handler.getFormatter() == null
                    ? ""
                    : handler.getFormatter().getClass().getName()));
      }
      result.loggers.add(
          new LoggerSummary(
              "JUL",
              "jul:platform",
              "Platform LogManager",
              rawName.isEmpty() ? "<root>" : rawName,
              logger.getLevel() == null
                  ? "<inherited>"
                  : logger.getLevel().getName(),
              effectiveJulLevel(logger),
              logger.getUseParentHandlers(),
              handlers));
    }
  }

  private void collectLogback(CollectionResult result) {
    List<Class<?>> contexts = loadedClasses("ch.qos.logback.classic.LoggerContext");
    if (contexts.isEmpty()) {
      result.frameworkStates.put("LOGBACK", "NOT_LOADED");
      return;
    }
    result.frameworkStates.put("LOGBACK", "AVAILABLE");
    for (Class<?> contextType : contexts) {
      try {
        ClassLoader loader = contextType.getClassLoader();
        Class<?> factoryType =
            Class.forName("org.slf4j.LoggerFactory", false, loader);
        Object context = factoryType.getMethod("getILoggerFactory").invoke(null);
        if (!contextType.isInstance(context)) {
          continue;
        }
        String contextId = "logback:" + loaderIdentity(loader);
        String contextName =
            optionalString(context, "getName", contextId)
                + " · "
                + loaderIdentity(loader);
        Object rawLoggers = contextType.getMethod("getLoggerList").invoke(context);
        if (!(rawLoggers instanceof Iterable<?>)) {
          continue;
        }
        for (Object logger : (Iterable<?>) rawLoggers) {
          if (result.loggers.size() >= MAXIMUM_LOGGERS) {
            result.truncated = true;
            return;
          }
          List<HandlerSummary> appenders = logbackAppenders(logger);
          result.loggers.add(
              new LoggerSummary(
                  "LOGBACK",
                  contextId,
                  contextName,
                  optionalString(logger, "getName", "<unknown>"),
                  optionalString(logger, "getLevel", "<inherited>"),
                  optionalString(logger, "getEffectiveLevel", "<unknown>"),
                  optionalBoolean(logger, "isAdditive", true),
                  appenders));
        }
      } catch (Throwable failure) {
        result.frameworkErrors.put("LOGBACK", failureMessage(failure));
      }
    }
  }

  private void collectLog4j(CollectionResult result) {
    List<Class<?>> loggerTypes = loadedClasses("org.apache.log4j.Logger");
    if (loggerTypes.isEmpty()) {
      result.frameworkStates.put("LOG4J", "NOT_LOADED");
      return;
    }
    result.frameworkStates.put("LOG4J", "AVAILABLE");
    for (Class<?> loggerType : loggerTypes) {
      try {
        ClassLoader loader = loggerType.getClassLoader();
        Class<?> managerType =
            Class.forName("org.apache.log4j.LogManager", false, loader);
        Object repository =
            managerType.getMethod("getLoggerRepository").invoke(null);
        String contextId = "log4j:" + loaderIdentity(loader);
        String contextName =
            repository.getClass().getName()
                + " · "
                + loaderIdentity(loader);
        Object root = managerType.getMethod("getRootLogger").invoke(null);
        addLog4jLogger(
            result, root, "<root>", contextId, contextName);
        Object rawLoggers =
            managerType.getMethod("getCurrentLoggers").invoke(null);
        if (!(rawLoggers instanceof Enumeration<?>)) {
          continue;
        }
        Enumeration<?> loggers = (Enumeration<?>) rawLoggers;
        while (loggers.hasMoreElements()) {
          if (result.loggers.size() >= MAXIMUM_LOGGERS) {
            result.truncated = true;
            return;
          }
          Object logger = loggers.nextElement();
          addLog4jLogger(
              result,
              logger,
              optionalString(logger, "getName", "<unknown>"),
              contextId,
              contextName);
        }
      } catch (Throwable failure) {
        result.frameworkErrors.put("LOG4J", failureMessage(failure));
      }
    }
  }

  private static void addLog4jLogger(
      CollectionResult result,
      Object logger,
      String name,
      String contextId,
      String contextName) {
    if (logger == null || result.loggers.size() >= MAXIMUM_LOGGERS) {
      return;
    }
    result.loggers.add(
        new LoggerSummary(
            "LOG4J",
            contextId,
            contextName,
            name,
            optionalString(logger, "getLevel", "<inherited>"),
            optionalString(logger, "getEffectiveLevel", "<unknown>"),
            optionalBoolean(logger, "getAdditivity", true),
            log4jAppenders(logger)));
  }

  private static List<HandlerSummary> log4jAppenders(Object logger) {
    List<HandlerSummary> appenders = new ArrayList<HandlerSummary>();
    try {
      Object raw = logger.getClass().getMethod("getAllAppenders").invoke(logger);
      if (!(raw instanceof Enumeration<?>)) {
        return appenders;
      }
      Enumeration<?> values = (Enumeration<?>) raw;
      while (values.hasMoreElements() && appenders.size() < MAXIMUM_HANDLERS) {
        Object appender = values.nextElement();
        appenders.add(
            new HandlerSummary(
                optionalString(appender, "getName", "<unnamed>"),
                appender.getClass().getName(),
                "",
                optionalTypeName(appender, "getLayout", "")));
      }
    } catch (Throwable ignored) {
      // A logger remains inspectable even when a custom appender blocks reflection.
    }
    return appenders;
  }

  private static List<HandlerSummary> logbackAppenders(Object logger) {
    List<HandlerSummary> appenders = new ArrayList<HandlerSummary>();
    try {
      Object value =
          logger.getClass().getMethod("iteratorForAppenders").invoke(logger);
      if (!(value instanceof Iterator<?>)) {
        return appenders;
      }
      Iterator<?> iterator = (Iterator<?>) value;
      while (iterator.hasNext() && appenders.size() < MAXIMUM_HANDLERS) {
        Object appender = iterator.next();
        appenders.add(
            new HandlerSummary(
                optionalString(appender, "getName", "<unnamed>"),
                appender.getClass().getName(),
                "",
                optionalBoolean(appender, "isStarted", false)
                    ? "STARTED"
                    : "STOPPED"));
      }
    } catch (Throwable ignored) {
      // A logger remains inspectable even when a custom appender blocks reflection.
    }
    return appenders;
  }

  private void collectLog4j2(CollectionResult result) {
    List<Class<?>> contexts =
        loadedClasses("org.apache.logging.log4j.core.LoggerContext");
    if (contexts.isEmpty()) {
      result.frameworkStates.put("LOG4J2", "NOT_LOADED");
      return;
    }
    result.frameworkStates.put("LOG4J2", "AVAILABLE");
    for (Class<?> contextType : contexts) {
      Thread currentThread = Thread.currentThread();
      ClassLoader previousLoader = currentThread.getContextClassLoader();
      try {
        ClassLoader loader = contextType.getClassLoader();
        currentThread.setContextClassLoader(loader);
        Class<?> managerType =
            Class.forName("org.apache.logging.log4j.LogManager", false, loader);
        Object context =
            managerType.getMethod("getContext", boolean.class).invoke(null, false);
        if (!contextType.isInstance(context)) {
          continue;
        }
        String contextId = "log4j2:" + loaderIdentity(loader);
        String contextName =
            optionalString(context, "getName", contextId)
                + " · "
                + loaderIdentity(loader);
        Object configuration =
            contextType.getMethod("getConfiguration").invoke(context);
        collectLog4j2Configuration(
            result,
            configuration,
            contextId,
            contextName);
      } catch (Throwable failure) {
        result.frameworkErrors.put("LOG4J2", failureMessage(failure));
      } finally {
        currentThread.setContextClassLoader(previousLoader);
      }
    }
  }

  private static void collectLog4j2Configuration(
      CollectionResult result,
      Object configuration,
      String contextId,
      String contextName)
      throws Exception {
    Map<String, Object> configurations =
        new LinkedHashMap<String, Object>();
    Object root =
        configuration.getClass().getMethod("getRootLogger").invoke(configuration);
    configurations.put("<root>", root);
    Object rawLoggers =
        configuration.getClass().getMethod("getLoggers").invoke(configuration);
    if (rawLoggers instanceof Map<?, ?>) {
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) rawLoggers).entrySet()) {
        configurations.put(String.valueOf(entry.getKey()), entry.getValue());
      }
    }
    for (Map.Entry<String, Object> entry : configurations.entrySet()) {
      if (result.loggers.size() >= MAXIMUM_LOGGERS) {
        result.truncated = true;
        return;
      }
      Object logger = entry.getValue();
      result.loggers.add(
          new LoggerSummary(
              "LOG4J2",
              contextId,
              contextName,
              entry.getKey().isEmpty() ? "<root>" : entry.getKey(),
              optionalString(logger, "getLevel", "<inherited>"),
              optionalString(logger, "getLevel", "<unknown>"),
              optionalBoolean(logger, "isAdditive", true),
              log4j2Appenders(logger)));
    }
  }

  private static List<HandlerSummary> log4j2Appenders(Object logger) {
    List<HandlerSummary> appenders = new ArrayList<HandlerSummary>();
    try {
      Object raw =
          logger.getClass().getMethod("getAppenders").invoke(logger);
      if (!(raw instanceof Map<?, ?>)) {
        return appenders;
      }
      for (Map.Entry<?, ?> entry : ((Map<?, ?>) raw).entrySet()) {
        if (appenders.size() >= MAXIMUM_HANDLERS) {
          break;
        }
        Object appender = entry.getValue();
        appenders.add(
            new HandlerSummary(
                String.valueOf(entry.getKey()),
                appender == null ? "<unknown>" : appender.getClass().getName(),
                "",
                appender == null
                    ? ""
                    : optionalString(appender, "getState", "")));
      }
    } catch (Throwable ignored) {
      // A custom LoggerConfig remains inspectable without appender metadata.
    }
    return appenders;
  }

  private List<Class<?>> loadedClasses(String name) {
    if (instrumentation == null) {
      return Collections.emptyList();
    }
    List<Class<?>> matches = new ArrayList<Class<?>>();
    for (Class<?> type : instrumentation.getAllLoadedClasses()) {
      if (type.getName().equals(name)) {
        matches.add(type);
      }
    }
    return matches;
  }

  private static Map<String, String> frameworkValues(
      CollectionResult result) {
    Map<String, String> values = new TreeMap<String, String>();
    for (String framework :
        new String[] {"JUL", "LOGBACK", "LOG4J", "LOG4J2"}) {
      values.put(
          "framework." + framework.toLowerCase(Locale.ROOT) + ".state",
          result.frameworkStates.getOrDefault(framework, "NOT_REQUESTED"));
      String error = result.frameworkErrors.get(framework);
      if (error != null && !error.isEmpty()) {
        values.put(
            "framework." + framework.toLowerCase(Locale.ROOT) + ".error",
            trim(error));
      }
    }
    return values;
  }

  private static void addLoggerValues(
      Map<String, String> values,
      String prefix,
      LoggerSummary logger) {
    values.put(prefix + "framework", logger.framework);
    values.put(prefix + "contextId", logger.contextId);
    values.put(prefix + "context", trim(logger.context));
    values.put(prefix + "name", trim(logger.name));
    values.put(prefix + "level", trim(logger.level));
    values.put(prefix + "effectiveLevel", trim(logger.effectiveLevel));
    values.put(prefix + "additive", Boolean.toString(logger.additive));
    values.put(prefix + "handlerCount", Integer.toString(logger.handlers.size()));
  }

  private static String normalizeFramework(String value) {
    String normalized =
        value == null ? "ALL" : value.trim().toUpperCase(Locale.ROOT);
    if (!"ALL".equals(normalized)
        && !"JUL".equals(normalized)
        && !"LOGBACK".equals(normalized)
        && !"LOG4J".equals(normalized)
        && !"LOG4J2".equals(normalized)) {
      throw new IllegalArgumentException(
          "Framework must be ALL, JUL, LOGBACK, LOG4J or LOG4J2");
    }
    return normalized;
  }

  private static String effectiveJulLevel(Logger logger) {
    Logger current = logger;
    while (current != null) {
      if (current.getLevel() != null) {
        return current.getLevel().getName();
      }
      current = current.getParent();
    }
    return "<unknown>";
  }

  private static String optionalString(
      Object target,
      String methodName,
      String fallback) {
    try {
      Method method = target.getClass().getMethod(methodName);
      Object value = method.invoke(target);
      return value == null ? fallback : String.valueOf(value);
    } catch (Throwable ignored) {
      return fallback;
    }
  }

  private static boolean optionalBoolean(
      Object target,
      String methodName,
      boolean fallback) {
    try {
      Method method = target.getClass().getMethod(methodName);
      Object value = method.invoke(target);
      return value instanceof Boolean
          ? ((Boolean) value).booleanValue()
          : fallback;
    } catch (Throwable ignored) {
      return fallback;
    }
  }

  private static String optionalTypeName(
      Object target,
      String methodName,
      String fallback) {
    try {
      Method method = target.getClass().getMethod(methodName);
      Object value = method.invoke(target);
      return value == null ? fallback : value.getClass().getName();
    } catch (Throwable ignored) {
      return fallback;
    }
  }

  private static String loaderIdentity(ClassLoader loader) {
    return loader == null
        ? "bootstrap"
        : loader.getClass().getName()
            + "@"
            + Integer.toHexString(System.identityHashCode(loader));
  }

  private static String failureMessage(Throwable failure) {
    Throwable cause = rootCause(failure);
    String message = cause.getMessage();
    return cause.getClass().getSimpleName()
        + (message == null || message.isEmpty() ? "" : ": " + message);
  }

  private static String trim(String value) {
    return value.length() <= MAXIMUM_VALUE_LENGTH
        ? value
        : value.substring(0, MAXIMUM_VALUE_LENGTH) + "…";
  }

  private static Throwable rootCause(Throwable failure) {
    Throwable cause = Objects.requireNonNull(failure, "failure");
    while (cause.getCause() != null && cause.getCause() != cause) {
      cause = cause.getCause();
    }
    return cause;
  }

  private static final class CollectionResult {
    private final List<LoggerSummary> loggers =
        new ArrayList<LoggerSummary>();
    private final Map<String, String> frameworkStates =
        new TreeMap<String, String>();
    private final Map<String, String> frameworkErrors =
        new TreeMap<String, String>();
    private boolean truncated;
  }

  private static final class LoggerSummary {
    private final String framework;
    private final String contextId;
    private final String context;
    private final String name;
    private final String level;
    private final String effectiveLevel;
    private final boolean additive;
    private final List<HandlerSummary> handlers;

    private LoggerSummary(
        String framework,
        String contextId,
        String context,
        String name,
        String level,
        String effectiveLevel,
        boolean additive,
        List<HandlerSummary> handlers) {
      this.framework = framework;
      this.contextId = contextId;
      this.context = context;
      this.name = name;
      this.level = level;
      this.effectiveLevel = effectiveLevel;
      this.additive = additive;
      this.handlers = handlers;
    }
  }

  private static final class HandlerSummary {
    private final String name;
    private final String type;
    private final String level;
    private final String detail;

    private HandlerSummary(
        String name,
        String type,
        String level,
        String detail) {
      this.name = name;
      this.type = type;
      this.level = level;
      this.detail = detail;
    }
  }

  private static final class LoggerSelection {
    private final String framework;
    private final String contextId;
    private final String name;
    private final Object logger;
    private final Object context;

    private LoggerSelection(
        String framework,
        String contextId,
        String name,
        Object logger,
        Object context) {
      this.framework = framework;
      this.contextId = contextId;
      this.name = name;
      this.logger = logger;
      this.context = context;
    }

    private String explicitLevel() {
      if ("JUL".equals(framework)) {
        Level level = ((Logger) logger).getLevel();
        return level == null ? "<inherited>" : level.getName();
      }
      return optionalString(logger, "getLevel", "<inherited>");
    }

    private String effectiveLevel() {
      if ("JUL".equals(framework)) {
        return effectiveJulLevel((Logger) logger);
      }
      if ("LOG4J".equals(framework)) {
        return optionalString(logger, "getEffectiveLevel", "<unknown>");
      }
      return "LOGBACK".equals(framework)
          ? optionalString(logger, "getEffectiveLevel", "<unknown>")
          : optionalString(logger, "getLevel", "<unknown>");
    }
  }

  static final class StaleLoggerLevelException
      extends IllegalStateException {
    private StaleLoggerLevelException(String message) {
      super(message);
    }
  }
}
