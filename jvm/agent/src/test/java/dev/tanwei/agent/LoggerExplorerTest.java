package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.util.Map;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

final class LoggerExplorerTest {
  private static final String LOGGER_NAME = "dev.tanwei.test.logger.explorer";
  private static final String LOGBACK_LOGGER_NAME =
      "dev.tanwei.test.logger.logback";
  private static final String LOG4J_LOGGER_NAME =
      "dev.tanwei.test.logger.log4j";
  private static final String LOG4J2_LOGGER_NAME =
      "dev.tanwei.test.logger.log4j2";

  private Logger logger;
  private Handler handler;

  @BeforeEach
  void setUp() {
    logger = Logger.getLogger(LOGGER_NAME);
    logger.setLevel(Level.FINE);
    logger.setUseParentHandlers(false);
    handler =
        new Handler() {
          @Override
          public void publish(LogRecord record) {}

          @Override
          public void flush() {}

          @Override
          public void close() {}
        };
    handler.setLevel(Level.WARNING);
    logger.addHandler(handler);
  }

  @AfterEach
  void tearDown() {
    logger.removeHandler(handler);
    logger.setLevel(null);
    logger.setUseParentHandlers(true);
  }

  @Test
  void listsAndDescribesJulLoggerWithoutFrameworkDependencies() {
    LoggerExplorer explorer = new LoggerExplorer(null);
    Map<String, String> listed =
        explorer.list("tanwei.test.logger", "JUL", 0, 50);
    String loggerPrefix = findLoggerPrefix(listed, LOGGER_NAME);

    assertEquals("AVAILABLE", listed.get("framework.jul.state"));
    assertEquals("JUL", listed.get(loggerPrefix + "framework"));
    assertEquals("FINE", listed.get(loggerPrefix + "level"));
    assertEquals("FINE", listed.get(loggerPrefix + "effectiveLevel"));
    assertEquals("false", listed.get(loggerPrefix + "additive"));
    assertEquals("1", listed.get(loggerPrefix + "handlerCount"));

    Map<String, String> described =
        explorer.describe(
            "JUL",
            listed.get(loggerPrefix + "contextId"),
            LOGGER_NAME);
    assertEquals(LOGGER_NAME, described.get("name"));
    assertEquals("1", described.get("handler.count"));
    assertEquals("WARNING", described.get("handler.0000.level"));
    assertTrue(
        described.get("handler.0000.type").contains("LoggerExplorerTest"));
  }

  @Test
  void reportsOptionalFrameworksAsNotLoaded() {
    LoggerExplorer explorer = new LoggerExplorer(null);
    Map<String, String> listed = explorer.list("", "ALL", 0, 10);

    assertEquals("NOT_LOADED", listed.get("framework.logback.state"));
    assertEquals("NOT_LOADED", listed.get("framework.log4j.state"));
    assertEquals("NOT_LOADED", listed.get("framework.log4j2.state"));
  }

  @Test
  void previewsAppliesRejectsDriftAndRestoresJulLevel() {
    LoggerExplorer explorer = new LoggerExplorer(null);
    Map<String, String> preview =
        explorer.previewLevelChange(
            "JUL", "jul:platform", LOGGER_NAME, "WARNING");

    assertEquals("FINE", preview.get("currentLevel"));
    assertEquals("WARNING", preview.get("newLevel"));
    assertEquals("true", preview.get("changed"));
    assertEquals(64, preview.get("fingerprint").length());

    Map<String, String> applied =
        explorer.setLevel(
            "JUL",
            "jul:platform",
            LOGGER_NAME,
            "WARNING",
            preview.get("fingerprint"));
    assertEquals(Level.WARNING, logger.getLevel());
    assertEquals("FINE", applied.get("oldValue"));
    assertEquals("WARNING", applied.get("newValue"));
    assertEquals(64, applied.get("rollbackFingerprint").length());
    assertThrows(
        LoggerExplorer.StaleLoggerLevelException.class,
        () ->
            explorer.setLevel(
                "JUL",
                "jul:platform",
                LOGGER_NAME,
                "INFO",
                preview.get("fingerprint")));

    Map<String, String> restorePreview =
        explorer.previewLevelChange(
            "JUL", "jul:platform", LOGGER_NAME, "FINE");
    explorer.setLevel(
        "JUL",
        "jul:platform",
        LOGGER_NAME,
        "FINE",
        restorePreview.get("fingerprint"));
    assertEquals(Level.FINE, logger.getLevel());
  }

  @Test
  void changesLogbackLog4jAndLog4j2ThroughTheirLoadedFrameworkApis() {
    ch.qos.logback.classic.LoggerContext logbackContext =
        (ch.qos.logback.classic.LoggerContext)
            org.slf4j.LoggerFactory.getILoggerFactory();
    ch.qos.logback.classic.Logger logbackLogger =
        logbackContext.getLogger(LOGBACK_LOGGER_NAME);
    logbackLogger.setLevel(ch.qos.logback.classic.Level.INFO);

    org.apache.log4j.Logger log4jLogger =
        org.apache.log4j.Logger.getLogger(LOG4J_LOGGER_NAME);
    log4jLogger.setLevel(org.apache.log4j.Level.INFO);

    org.apache.logging.log4j.core.LoggerContext log4j2Context =
        (org.apache.logging.log4j.core.LoggerContext)
            org.apache.logging.log4j.LogManager.getContext(false);
    org.apache.logging.log4j.core.config.Configuration configuration =
        log4j2Context.getConfiguration();
    org.apache.logging.log4j.core.config.LoggerConfig log4j2Logger =
        new org.apache.logging.log4j.core.config.LoggerConfig(
            LOG4J2_LOGGER_NAME,
            org.apache.logging.log4j.Level.INFO,
            false);
    configuration.addLogger(LOG4J2_LOGGER_NAME, log4j2Logger);
    log4j2Context.updateLoggers();

    try {
      LoggerExplorer explorer =
          new LoggerExplorer(
              instrumentationWith(
                  ch.qos.logback.classic.LoggerContext.class,
                  org.apache.log4j.Logger.class,
                  org.apache.logging.log4j.core.LoggerContext.class));

      Map<String, String> logbackList =
          explorer.list(LOGBACK_LOGGER_NAME, "LOGBACK", 0, 10);
      String logbackPrefix =
          findLoggerPrefix(logbackList, LOGBACK_LOGGER_NAME);
      Map<String, String> logbackPreview =
          explorer.previewLevelChange(
              "LOGBACK",
              logbackList.get(logbackPrefix + "contextId"),
              LOGBACK_LOGGER_NAME,
              "DEBUG");
      explorer.setLevel(
          "LOGBACK",
          logbackList.get(logbackPrefix + "contextId"),
          LOGBACK_LOGGER_NAME,
          "DEBUG",
          logbackPreview.get("fingerprint"));
      assertEquals(
          ch.qos.logback.classic.Level.DEBUG,
          logbackLogger.getLevel());

      Map<String, String> log4jList =
          explorer.list(LOG4J_LOGGER_NAME, "LOG4J", 0, 10);
      String log4jPrefix =
          findLoggerPrefix(log4jList, LOG4J_LOGGER_NAME);
      Map<String, String> staleLog4jPreview =
          explorer.previewLevelChange(
              "LOG4J",
              log4jList.get(log4jPrefix + "contextId"),
              LOG4J_LOGGER_NAME,
              "TRACE");
      log4jLogger.setLevel(org.apache.log4j.Level.WARN);
      assertThrows(
          LoggerExplorer.StaleLoggerLevelException.class,
          () ->
              explorer.setLevel(
                  "LOG4J",
                  log4jList.get(log4jPrefix + "contextId"),
                  LOG4J_LOGGER_NAME,
                  "TRACE",
                  staleLog4jPreview.get("fingerprint")));
      log4jLogger.setLevel(org.apache.log4j.Level.INFO);
      Map<String, String> log4jPreview =
          explorer.previewLevelChange(
              "LOG4J",
              log4jList.get(log4jPrefix + "contextId"),
              LOG4J_LOGGER_NAME,
              "TRACE");
      explorer.setLevel(
          "LOG4J",
          log4jList.get(log4jPrefix + "contextId"),
          LOG4J_LOGGER_NAME,
          "TRACE",
          log4jPreview.get("fingerprint"));
      assertEquals(org.apache.log4j.Level.TRACE, log4jLogger.getLevel());

      Map<String, String> log4j2List =
          explorer.list(LOG4J2_LOGGER_NAME, "LOG4J2", 0, 10);
      String log4j2Prefix =
          findLoggerPrefix(log4j2List, LOG4J2_LOGGER_NAME);
      Map<String, String> log4j2Preview =
          explorer.previewLevelChange(
              "LOG4J2",
              log4j2List.get(log4j2Prefix + "contextId"),
              LOG4J2_LOGGER_NAME,
              "ERROR");
      explorer.setLevel(
          "LOG4J2",
          log4j2List.get(log4j2Prefix + "contextId"),
          LOG4J2_LOGGER_NAME,
          "ERROR",
          log4j2Preview.get("fingerprint"));
      assertEquals(
          org.apache.logging.log4j.Level.ERROR,
          log4j2Logger.getLevel());
    } finally {
      logbackLogger.setLevel(null);
      log4jLogger.setLevel(null);
      configuration.removeLogger(LOG4J2_LOGGER_NAME);
      log4j2Context.updateLoggers();
    }
  }

  private static Instrumentation instrumentationWith(
      Class<?>... loadedClasses) {
    return (Instrumentation)
        Proxy.newProxyInstance(
            LoggerExplorerTest.class.getClassLoader(),
            new Class<?>[] {Instrumentation.class},
            (proxy, method, arguments) -> {
              if ("getAllLoadedClasses".equals(method.getName())) {
                return loadedClasses;
              }
              throw new UnsupportedOperationException(method.getName());
            });
  }

  private static String findLoggerPrefix(
      Map<String, String> values,
      String expectedName) {
    int count = Integer.parseInt(values.get("count"));
    for (int index = 0; index < count; index++) {
      String prefix = String.format("logger.%04d.", index);
      if (expectedName.equals(values.get(prefix + "name"))) {
        return prefix;
      }
    }
    throw new AssertionError("Logger not found: " + expectedName);
  }
}
