package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.management.ManagementFactory;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.management.Attribute;
import javax.management.AttributeList;
import javax.management.AttributeNotFoundException;
import javax.management.DynamicMBean;
import javax.management.InvalidAttributeValueException;
import javax.management.MBeanAttributeInfo;
import javax.management.MBeanConstructorInfo;
import javax.management.MBeanException;
import javax.management.MBeanInfo;
import javax.management.MBeanNotificationInfo;
import javax.management.MBeanOperationInfo;
import javax.management.MBeanServer;
import javax.management.ObjectName;
import javax.management.ReflectionException;
import javax.management.openmbean.ArrayType;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.CompositeDataSupport;
import javax.management.openmbean.CompositeType;
import javax.management.openmbean.OpenDataException;
import javax.management.openmbean.OpenMBeanOperationInfoSupport;
import javax.management.openmbean.OpenMBeanParameterInfoSupport;
import javax.management.openmbean.SimpleType;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

final class MBeanExplorerTest {
  private final MBeanServer server = ManagementFactory.getPlatformMBeanServer();
  private final ObjectName objectName = objectName("dev.tanwei.test:type=Probe,name=Primary");
  private final Probe probe = new Probe();

  @BeforeEach
  void registerProbe() throws Exception {
    if (server.isRegistered(objectName)) {
      server.unregisterMBean(objectName);
    }
    server.registerMBean(probe, objectName);
  }

  @AfterEach
  void unregisterProbe() throws Exception {
    if (server.isRegistered(objectName)) {
      server.unregisterMBean(objectName);
    }
  }

  @Test
  void listsAndFiltersRegisteredMBeansWithBoundedPagination() {
    Map<String, String> result =
        new MBeanExplorer(server).list("dev.tanwei.test", 0, 10);

    assertEquals("1", result.get("total"));
    assertEquals(objectName.getCanonicalName(), result.get("bean.0000.objectName"));
    assertEquals("Probe", result.get("bean.0000.type"));
    assertEquals("Primary", result.get("bean.0000.name"));
  }

  @Test
  void describesAttributesAndOperationsWithoutReadingValues() throws Exception {
    Map<String, String> result =
        new MBeanExplorer(server).describe(objectName.getCanonicalName());

    assertEquals(Probe.class.getName(), result.get("className"));
    assertEquals("Message", result.get("attribute.0000.name"));
    assertEquals("true", result.get("attribute.0000.readable"));
    assertEquals("false", result.get("attribute.0000.writeable"));
    assertEquals("ping", result.get("operation.0000.name"));
    assertEquals("java.lang.String", result.get("operation.0000.returnType"));
    assertEquals(
        "java.lang.String", result.get("operation.0000.parameterTypes"));
    assertEquals("true", result.get("operation.0000.invokable"));
    assertEquals(
        "java.lang.String", result.get("operation.0000.parameter.00.type"));
    assertEquals("Mode", result.get("attribute.0001.name"));
    assertEquals("true", result.get("attribute.0001.writeSupported"));
    assertEquals("Settings", result.get("attribute.0002.name"));
    assertEquals("true", result.get("attribute.0002.writeSupported"));
    assertEquals("OPEN_TYPE_JSON", result.get("attribute.0002.writeFormat"));
  }

  @Test
  void readsOneExactReadableAttribute() throws Exception {
    Map<String, String> result =
        new MBeanExplorer(server)
            .readAttribute(objectName.getCanonicalName(), "Message");

    assertEquals("ready", result.get("value"));
    assertEquals("java.lang.String", result.get("type"));
    assertEquals("true", result.get("structured"));
    assertEquals("1", result.get("node.count"));
    assertEquals("SCALAR", result.get("node.0000.kind"));
  }

  @Test
  void rejectsPatternsAndUnknownAttributes() {
    MBeanExplorer explorer = new MBeanExplorer(server);

    assertThrows(
        IllegalArgumentException.class,
        () -> explorer.describe("dev.tanwei.test:type=*"));
    assertThrows(
        IllegalArgumentException.class,
        () -> explorer.readAttribute(objectName.getCanonicalName(), "Missing"));
  }

  @Test
  void rendersCompositePlatformValuesWithinTheHardLimit() throws Exception {
    Map<String, String> result =
        new MBeanExplorer(server)
            .readAttribute("java.lang:type=Memory", "HeapMemoryUsage");

    assertTrue(result.get("value").contains("used="));
    assertTrue(result.get("value").length() <= 4_096);
    assertEquals("true", result.get("structured"));
    assertEquals("COMPOSITE", result.get("node.0000.kind"));
    assertEquals("-1", result.get("node.0000.parentIndex"));
    assertEquals("4", result.get("node.0000.displayedChildren"));
    assertTrue(
        result.values().stream().anyMatch(value -> "used".equals(value)));
  }

  @Test
  void boundsStructuredValuesAndDetectsCyclesWithoutBusinessToString()
      throws Exception {
    Map<String, String> result =
        new MBeanExplorer(server)
            .readAttribute(objectName.getCanonicalName(), "Structure");

    assertEquals("MAP", result.get("node.0000.kind"));
    assertEquals("4", result.get("node.0000.childCount"));
    assertTrue(
        result.values().stream().anyMatch(value -> "CYCLE".equals(value)));
    assertTrue(Integer.parseInt(result.get("node.count")) <= 256);
    assertEquals("false", result.get("node.nodeLimitReached"));
  }

  @Test
  void previewsAndInvokesOneExactScalarOperationWithFingerprintProtection()
      throws Exception {
    MBeanExplorer explorer = new MBeanExplorer(server);
    try {
      MBeanExplorer.Preview preview =
          explorer.previewOperation(
              objectName.getCanonicalName(),
              "ping",
              "java.lang.String",
              java.util.Collections.singletonList("desktop"));

      assertEquals("ping", preview.getOperation());
      assertEquals("java.lang.String", preview.getParameterTypes());
      assertTrue(preview.getInvocation().contains("\"desktop\""));

      MBeanExplorer.InvocationResult result =
          explorer.invokeOperation(
              objectName.getCanonicalName(),
              "ping",
              "java.lang.String",
              java.util.Collections.singletonList("desktop"),
              preview.getFingerprint());

      assertEquals("RETURNED", result.getOutcome());
      assertEquals("pong:desktop", result.getReturnValue());
      assertThrows(
          MBeanExplorer.StaleOperationException.class,
          () ->
              explorer.invokeOperation(
                  objectName.getCanonicalName(),
                  "ping",
                  "java.lang.String",
                  java.util.Collections.singletonList("changed"),
                  preview.getFingerprint()));
    } finally {
      explorer.close();
    }
  }

  @Test
  void previewsAndInvokesOneBoundedOpenTypeOperationArgument()
      throws Exception {
    ObjectName openObjectName =
        objectName("dev.tanwei.test:type=OpenOperation,name=Primary");
    if (server.isRegistered(openObjectName)) {
      server.unregisterMBean(openObjectName);
    }
    server.registerMBean(new OpenOperationProbe(), openObjectName);
    MBeanExplorer explorer = new MBeanExplorer(server);
    try {
      Map<String, String> description =
          explorer.describe(openObjectName.getCanonicalName());
      assertEquals(
          "OPEN_TYPE_JSON",
          description.get("operation.0000.parameter.00.format"));
      assertTrue(
          description
              .get("operation.0000.parameter.00.schema")
              .contains("labels:array<string>"));

      String proposed =
          "{\n"
              + "  \"threshold\": 42,\n"
              + "  \"labels\": [\"desktop\", \"safe\"],\n"
              + "  \"enabled\": false\n"
              + "}";
      MBeanExplorer.Preview preview =
          explorer.previewOperation(
              openObjectName.getCanonicalName(),
              "applySettings",
              CompositeData.class.getName(),
              java.util.Collections.singletonList(proposed),
              java.util.Collections.singletonList("OPEN_TYPE_JSON"));

      assertEquals(1, preview.getArgumentCount());
      assertEquals("OPEN_TYPE_JSON", preview.getArgumentFormat(0));
      assertEquals(
          "{\"enabled\":false,\"labels\":[\"desktop\",\"safe\"],\"threshold\":42}",
          preview.getArgumentValue(0));

      MBeanExplorer.InvocationResult result =
          explorer.invokeOperation(
              openObjectName.getCanonicalName(),
              "applySettings",
              CompositeData.class.getName(),
              java.util.Collections.singletonList(proposed),
              java.util.Collections.singletonList("OPEN_TYPE_JSON"),
              preview.getFingerprint());
      assertEquals("RETURNED", result.getOutcome());
      assertEquals("accepted:false:42:2", result.getReturnValue());

      assertThrows(
          MBeanExplorer.StaleOperationException.class,
          () ->
              explorer.invokeOperation(
                  openObjectName.getCanonicalName(),
                  "applySettings",
                  CompositeData.class.getName(),
                  java.util.Collections.singletonList(
                      "{\"enabled\":true,\"labels\":[],\"threshold\":1}"),
                  java.util.Collections.singletonList("OPEN_TYPE_JSON"),
                  preview.getFingerprint()));
      assertThrows(
          IllegalArgumentException.class,
          () ->
              explorer.previewOperation(
                  openObjectName.getCanonicalName(),
                  "applySettings",
                  CompositeData.class.getName(),
                  java.util.Collections.singletonList(proposed),
                  java.util.Collections.singletonList("SCALAR")));
      assertThrows(
          IllegalArgumentException.class,
          () ->
              explorer.previewOperation(
                  openObjectName.getCanonicalName(),
                  "applySettings",
                  CompositeData.class.getName(),
                  java.util.Collections.singletonList(proposed)));
    } finally {
      explorer.close();
      server.unregisterMBean(openObjectName);
    }
  }

  @Test
  void previewsWritesAndRestoresOneExactScalarAttribute() throws Exception {
    MBeanExplorer explorer = new MBeanExplorer(server);
    try {
      MBeanExplorer.AttributeWritePreview preview =
          explorer.previewAttributeWrite(
              objectName.getCanonicalName(), "Mode", "desktop");

      assertEquals("before", preview.getOldValue());
      assertEquals("desktop", preview.getProposedValue());
      assertTrue(preview.isRestoreSupported());

      MBeanExplorer.AttributeWriteResult result =
          explorer.writeAttribute(
              objectName.getCanonicalName(),
              "Mode",
              "desktop",
              preview.getFingerprint());

      assertEquals("before", result.getOldValue());
      assertEquals("desktop", result.getNewValue());
      assertThrows(
          MBeanExplorer.StaleAttributeWriteException.class,
          () ->
              explorer.writeAttribute(
                  objectName.getCanonicalName(),
                  "Mode",
                  "desktop",
                  preview.getFingerprint()));

      MBeanExplorer.AttributeWritePreview restorePreview =
          explorer.previewAttributeWrite(
              objectName.getCanonicalName(), "Mode", "before");
      MBeanExplorer.AttributeWriteResult restored =
          explorer.writeAttribute(
              objectName.getCanonicalName(),
              "Mode",
              "before",
              restorePreview.getFingerprint());
      assertEquals("before", restored.getNewValue());
    } finally {
      explorer.close();
    }
  }

  @Test
  void previewsWritesAndRestoresOneBoundedCompositeAttribute() throws Exception {
    MBeanExplorer explorer = new MBeanExplorer(server);
    try {
      Map<String, String> read =
          explorer.readAttribute(objectName.getCanonicalName(), "Settings");
      assertEquals("OPEN_TYPE_JSON", read.get("editableFormat"));
      assertEquals(
          "{\"enabled\":true,\"labels\":[\"before\"],\"threshold\":7}",
          read.get("editableValue"));

      String proposed =
          "{\n"
              + "  \"threshold\": 42,\n"
              + "  \"labels\": [\"desktop\", \"safe\"],\n"
              + "  \"enabled\": false\n"
              + "}";
      MBeanExplorer.AttributeWritePreview preview =
          explorer.previewAttributeWrite(
              objectName.getCanonicalName(),
              "Settings",
              proposed,
              "OPEN_TYPE_JSON");

      assertEquals("OPEN_TYPE_JSON", preview.getValueFormat());
      assertEquals(
          "{\"enabled\":false,\"labels\":[\"desktop\",\"safe\"],\"threshold\":42}",
          preview.getProposedValue());
      assertTrue(preview.getValueSchema().contains("enabled:boolean"));

      MBeanExplorer.AttributeWriteResult result =
          explorer.writeAttribute(
              objectName.getCanonicalName(),
              "Settings",
              proposed,
              "OPEN_TYPE_JSON",
              preview.getFingerprint());
      assertEquals("OPEN_TYPE_JSON", result.getValueFormat());
      assertEquals(preview.getProposedValue(), result.getNewValue());
      assertThrows(
          MBeanExplorer.StaleAttributeWriteException.class,
          () ->
              explorer.writeAttribute(
                  objectName.getCanonicalName(),
                  "Settings",
                  proposed,
                  "OPEN_TYPE_JSON",
                  preview.getFingerprint()));

      MBeanExplorer.AttributeWritePreview restorePreview =
          explorer.previewAttributeWrite(
              objectName.getCanonicalName(),
              "Settings",
              result.getOldValue(),
              "OPEN_TYPE_JSON");
      MBeanExplorer.AttributeWriteResult restored =
          explorer.writeAttribute(
              objectName.getCanonicalName(),
              "Settings",
              result.getOldValue(),
              "OPEN_TYPE_JSON",
              restorePreview.getFingerprint());
      assertEquals(
          "{\"enabled\":true,\"labels\":[\"before\"],\"threshold\":7}",
          restored.getNewValue());
    } finally {
      explorer.close();
    }
  }

  @Test
  void rejectsIncompleteOrMismatchedCompositeAttributeValues() throws Exception {
    MBeanExplorer explorer = new MBeanExplorer(server);
    try {
      assertThrows(
          IllegalArgumentException.class,
          () ->
              explorer.previewAttributeWrite(
                  objectName.getCanonicalName(),
                  "Settings",
                  "{\"enabled\":true}",
                  "OPEN_TYPE_JSON"));
      assertThrows(
          IllegalArgumentException.class,
          () ->
              explorer.previewAttributeWrite(
                  objectName.getCanonicalName(),
                  "Settings",
                  "{\"enabled\":true,\"labels\":[],\"threshold\":\"42\"}",
                  "OPEN_TYPE_JSON"));
      assertThrows(
          IllegalArgumentException.class,
          () ->
              explorer.previewAttributeWrite(
                  objectName.getCanonicalName(),
                  "Settings",
                  "{\"enabled\":true,\"labels\":[],\"threshold\":42}",
                  "SCALAR"));
    } finally {
      explorer.close();
    }
  }

  @Test
  void keepsOversizedCompositeValuesReadableButNotEditable() throws Exception {
    String[] labels = new String[51];
    java.util.Arrays.fill(labels, "bounded");
    probe.setSettings(Probe.settings(true, labels, 9L));

    Map<String, String> result =
        new MBeanExplorer(server)
            .readAttribute(objectName.getCanonicalName(), "Settings");

    assertEquals("true", result.get("structured"));
    assertEquals("", result.get("editableFormat"));
    assertTrue(result.get("editableDeniedReason").contains("50 item"));
  }

  private static ObjectName objectName(String value) {
    try {
      return new ObjectName(value);
    } catch (Exception exception) {
      throw new IllegalArgumentException(exception);
    }
  }

  public interface ProbeMBean {
    String getMessage();

    String getMode();

    void setMode(String mode);

    CompositeData getSettings();

    void setSettings(CompositeData settings);

    Map<String, Object> getStructure();

    String ping(String value);
  }

  public static final class Probe implements ProbeMBean {
    private static final CompositeType SETTINGS_TYPE = settingsType();
    private volatile String mode = "before";
    private volatile CompositeData settings =
        settings(true, new String[] {"before"}, 7L);

    @Override
    public String getMessage() {
      return "ready";
    }

    @Override
    public String getMode() {
      return mode;
    }

    @Override
    public void setMode(String mode) {
      this.mode = mode;
    }

    @Override
    public CompositeData getSettings() {
      return settings;
    }

    @Override
    public void setSettings(CompositeData settings) {
      if (settings == null || !SETTINGS_TYPE.isValue(settings)) {
        throw new IllegalArgumentException("settings must match the declared OpenType");
      }
      this.settings = settings;
    }

    @Override
    public Map<String, Object> getStructure() {
      Map<String, Object> value = new LinkedHashMap<String, Object>();
      value.put("state", "ready");
      value.put("attempts", Integer.valueOf(3));
      value.put("opaque", new PoisonToString());
      value.put("self", value);
      return value;
    }

    @Override
    public String ping(String value) {
      return "pong:" + value;
    }

    private static CompositeType settingsType() {
      try {
        return new CompositeType(
            "dev.tanwei.test.Settings",
            "Bounded integration settings",
            new String[] {"enabled", "labels", "threshold"},
            new String[] {"Enabled", "Labels", "Threshold"},
            new javax.management.openmbean.OpenType<?>[] {
              SimpleType.BOOLEAN,
              new ArrayType<String[]>(1, SimpleType.STRING),
              SimpleType.LONG
            });
      } catch (OpenDataException exception) {
        throw new ExceptionInInitializerError(exception);
      }
    }

    private static CompositeData settings(
        boolean enabled, String[] labels, long threshold) {
      try {
        return new CompositeDataSupport(
            SETTINGS_TYPE,
            new String[] {"enabled", "labels", "threshold"},
            new Object[] {
              Boolean.valueOf(enabled), labels, Long.valueOf(threshold)
            });
      } catch (OpenDataException exception) {
        throw new IllegalArgumentException(exception);
      }
    }
  }

  private static final class PoisonToString {
    @Override
    public String toString() {
      throw new AssertionError("Unknown business toString must not be called");
    }
  }

  private static final class OpenOperationProbe implements DynamicMBean {
    private static final CompositeType SETTINGS_TYPE = settingsType();

    @Override
    public Object getAttribute(String attribute)
        throws AttributeNotFoundException {
      throw new AttributeNotFoundException(attribute);
    }

    @Override
    public void setAttribute(Attribute attribute)
        throws AttributeNotFoundException, InvalidAttributeValueException {
      throw new AttributeNotFoundException(
          attribute == null ? "" : attribute.getName());
    }

    @Override
    public AttributeList getAttributes(String[] attributes) {
      return new AttributeList();
    }

    @Override
    public AttributeList setAttributes(AttributeList attributes) {
      return new AttributeList();
    }

    @Override
    public Object invoke(
        String actionName, Object[] parameters, String[] signature)
        throws MBeanException, ReflectionException {
      if (!"applySettings".equals(actionName)
          || parameters == null
          || parameters.length != 1
          || !(parameters[0] instanceof CompositeData)) {
        throw new ReflectionException(
            new NoSuchMethodException(String.valueOf(actionName)));
      }
      CompositeData settings = (CompositeData) parameters[0];
      String[] labels = (String[]) settings.get("labels");
      return "accepted:"
          + settings.get("enabled")
          + ":"
          + settings.get("threshold")
          + ":"
          + labels.length;
    }

    @Override
    public MBeanInfo getMBeanInfo() {
      OpenMBeanParameterInfoSupport settings =
          new OpenMBeanParameterInfoSupport(
              "settings", "Settings to apply", SETTINGS_TYPE);
      MBeanOperationInfo operation =
          new OpenMBeanOperationInfoSupport(
              "applySettings",
              "Apply bounded settings",
              new OpenMBeanParameterInfoSupport[] {settings},
              SimpleType.STRING,
              MBeanOperationInfo.ACTION);
      return new MBeanInfo(
          OpenOperationProbe.class.getName(),
          "OpenType operation probe",
          new MBeanAttributeInfo[0],
          new MBeanConstructorInfo[0],
          new MBeanOperationInfo[] {operation},
          new MBeanNotificationInfo[0]);
    }

    private static CompositeType settingsType() {
      try {
        return new CompositeType(
            "dev.tanwei.test.OperationSettings",
            "Bounded operation settings",
            new String[] {"enabled", "labels", "threshold"},
            new String[] {"Enabled", "Labels", "Threshold"},
            new javax.management.openmbean.OpenType<?>[] {
              SimpleType.BOOLEAN,
              new ArrayType<String[]>(1, SimpleType.STRING),
              SimpleType.LONG
            });
      } catch (OpenDataException exception) {
        throw new ExceptionInInitializerError(exception);
      }
    }
  }
}
