package dev.tanwei.agent;

import java.lang.reflect.Array;
import java.lang.management.ManagementFactory;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import javax.management.Attribute;
import javax.management.InstanceNotFoundException;
import javax.management.MBeanAttributeInfo;
import javax.management.MBeanException;
import javax.management.MBeanInfo;
import javax.management.MBeanOperationInfo;
import javax.management.MBeanParameterInfo;
import javax.management.MBeanServer;
import javax.management.ObjectName;
import javax.management.RuntimeErrorException;
import javax.management.RuntimeMBeanException;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.OpenMBeanAttributeInfo;
import javax.management.openmbean.OpenMBeanParameterInfo;
import javax.management.openmbean.OpenType;
import javax.management.openmbean.TabularData;

final class MBeanExplorer implements AutoCloseable {
  private static final int MAXIMUM_ATTRIBUTES = 200;
  private static final int MAXIMUM_OPERATIONS = 200;
  private static final int MAXIMUM_ARGUMENTS = 8;
  private static final int MAXIMUM_ARGUMENT_CHARACTERS = 512;
  private static final int MAXIMUM_OPERATION_ARGUMENT_CHARACTERS = 32_768;
  private static final int MAXIMUM_VALUE_CHARACTERS = 4_096;
  private static final int MAXIMUM_VALUE_DEPTH = 3;
  private static final int MAXIMUM_COLLECTION_ENTRIES = 50;
  private static final int MAXIMUM_STRUCTURED_VALUE_NODES = 256;
  private static final int MAXIMUM_STRUCTURED_VALUE_DEPTH = 5;
  private static final int MAXIMUM_STRUCTURED_VALUE_CHARACTERS = 32_768;
  private static final long INVOCATION_TIMEOUT_MILLIS = 3_000L;
  private static final String SCALAR_VALUE_FORMAT = "SCALAR";
  private static final String OPEN_TYPE_JSON_VALUE_FORMAT = "OPEN_TYPE_JSON";

  private final MBeanServer server;
  private final ThreadPoolExecutor invocationExecutor;
  private final Object attributeWriteLock = new Object();

  MBeanExplorer() {
    this(ManagementFactory.getPlatformMBeanServer());
  }

  MBeanExplorer(MBeanServer server) {
    if (server == null) {
      throw new IllegalArgumentException("MBeanServer is required");
    }
    this.server = server;
    this.invocationExecutor =
        new ThreadPoolExecutor(
            0,
            2,
            30L,
            TimeUnit.SECONDS,
            new SynchronousQueue<Runnable>(),
            new MBeanInvocationThreadFactory(),
            new ThreadPoolExecutor.AbortPolicy());
  }

  Map<String, String> list(String rawQuery, int offset, int limit) {
    String query = normalizedQuery(rawQuery);
    List<ObjectName> names = new ArrayList<ObjectName>(server.queryNames(null, null));
    names.removeIf(
        name ->
            !query.isEmpty()
                && !name.getCanonicalName().toLowerCase(Locale.ROOT).contains(query));
    names.sort(Comparator.comparing(ObjectName::getCanonicalName));

    int safeOffset = Math.max(0, offset);
    int toIndex = Math.min(names.size(), safeOffset + limit);
    Map<String, String> values = new TreeMap<String, String>();
    values.put("total", Integer.toString(names.size()));
    values.put("offset", Integer.toString(Math.min(safeOffset, names.size())));
    values.put("count", Integer.toString(Math.max(0, toIndex - safeOffset)));
    if (safeOffset >= names.size()) {
      return values;
    }
    for (int index = safeOffset; index < toIndex; index++) {
      ObjectName name = names.get(index);
      String prefix =
          "bean." + String.format(Locale.ROOT, "%04d", index - safeOffset) + ".";
      values.put(prefix + "objectName", name.getCanonicalName());
      values.put(prefix + "domain", name.getDomain());
      values.put(prefix + "type", stringValue(name.getKeyProperty("type")));
      values.put(prefix + "name", stringValue(name.getKeyProperty("name")));
    }
    return values;
  }

  Map<String, String> describe(String rawObjectName) throws Exception {
    ObjectName objectName = exactRegisteredName(rawObjectName);
    MBeanInfo info = server.getMBeanInfo(objectName);
    Map<String, String> values = new TreeMap<String, String>();
    values.put("objectName", objectName.getCanonicalName());
    values.put("className", bounded(info.getClassName()));
    values.put("description", bounded(info.getDescription()));

    List<MBeanAttributeInfo> attributes = new ArrayList<MBeanAttributeInfo>();
    Collections.addAll(attributes, info.getAttributes());
    attributes.sort(Comparator.comparing(MBeanAttributeInfo::getName));
    int attributeCount = Math.min(attributes.size(), MAXIMUM_ATTRIBUTES);
    values.put("attribute.total", Integer.toString(attributes.size()));
    values.put("attribute.count", Integer.toString(attributeCount));
    for (int index = 0; index < attributeCount; index++) {
      MBeanAttributeInfo attribute = attributes.get(index);
      String prefix =
          "attribute." + String.format(Locale.ROOT, "%04d", index) + ".";
      values.put(prefix + "name", attribute.getName());
      values.put(prefix + "type", attribute.getType());
      values.put(prefix + "readable", Boolean.toString(attribute.isReadable()));
      values.put(prefix + "writeable", Boolean.toString(attribute.isWritable()));
      values.put(prefix + "description", bounded(attribute.getDescription()));
      String writeDeniedReason = attributeWriteDeniedReason(attribute);
      String writeFormat = attributeWriteFormat(attribute);
      values.put(
          prefix + "writeSupported",
          Boolean.toString(writeDeniedReason.isEmpty()));
      values.put(prefix + "writeDeniedReason", writeDeniedReason);
      values.put(prefix + "writeFormat", writeFormat);
      OpenType<?> declaredOpenType = declaredOpenType(attribute);
      values.put(
          prefix + "writeSchema",
          declaredOpenType != null && OpenTypeJsonCodec.isSupported(declaredOpenType)
              ? OpenTypeJsonCodec.schema(declaredOpenType)
              : "");
    }

    List<MBeanOperationInfo> operations = new ArrayList<MBeanOperationInfo>();
    Collections.addAll(operations, info.getOperations());
    operations.sort(
        Comparator.comparing(MBeanOperationInfo::getName)
            .thenComparing(MBeanExplorer::operationSignature));
    int operationCount = Math.min(operations.size(), MAXIMUM_OPERATIONS);
    values.put("operation.total", Integer.toString(operations.size()));
    values.put("operation.count", Integer.toString(operationCount));
    for (int index = 0; index < operationCount; index++) {
      MBeanOperationInfo operation = operations.get(index);
      String prefix =
          "operation." + String.format(Locale.ROOT, "%04d", index) + ".";
      values.put(prefix + "name", operation.getName());
      values.put(prefix + "returnType", operation.getReturnType());
      values.put(prefix + "impact", operationImpact(operation.getImpact()));
      values.put(prefix + "signature", operationSignature(operation));
      values.put(prefix + "parameterTypes", operationParameterTypes(operation));
      values.put(prefix + "description", bounded(operation.getDescription()));
      String deniedReason = invocationDeniedReason(objectName, operation);
      values.put(prefix + "invokable", Boolean.toString(deniedReason.isEmpty()));
      values.put(prefix + "deniedReason", deniedReason);
      MBeanParameterInfo[] parameters = operation.getSignature();
      values.put(prefix + "parameter.count", Integer.toString(parameters.length));
      for (int parameterIndex = 0;
          parameterIndex < parameters.length && parameterIndex < MAXIMUM_ARGUMENTS;
          parameterIndex++) {
        MBeanParameterInfo parameter = parameters[parameterIndex];
        String parameterPrefix =
            prefix
                + "parameter."
                + String.format(Locale.ROOT, "%02d", parameterIndex)
                + ".";
        values.put(parameterPrefix + "name", bounded(parameter.getName()));
        values.put(parameterPrefix + "type", parameter.getType());
        values.put(parameterPrefix + "description", bounded(parameter.getDescription()));
        String parameterFormat = operationParameterFormat(parameter);
        values.put(parameterPrefix + "format", parameterFormat);
        OpenType<?> parameterOpenType = declaredOpenType(parameter);
        values.put(
            parameterPrefix + "schema",
            OPEN_TYPE_JSON_VALUE_FORMAT.equals(parameterFormat)
                    && parameterOpenType != null
                ? OpenTypeJsonCodec.schema(parameterOpenType)
                : "");
      }
    }
    return values;
  }

  Map<String, String> readAttribute(String rawObjectName, String rawAttribute)
      throws Exception {
    ObjectName objectName = exactRegisteredName(rawObjectName);
    String attributeName = required(rawAttribute, "Attribute name", 512);
    MBeanAttributeInfo matched = null;
    for (MBeanAttributeInfo attribute : server.getMBeanInfo(objectName).getAttributes()) {
      if (attribute.getName().equals(attributeName)) {
        matched = attribute;
        break;
      }
    }
    if (matched == null) {
      throw new IllegalArgumentException("MBean attribute was not found");
    }
    if (!matched.isReadable()) {
      throw new IllegalArgumentException("MBean attribute is not readable");
    }

    Object value = server.getAttribute(objectName, attributeName);
    Map<String, String> values = new TreeMap<String, String>();
    values.put("objectName", objectName.getCanonicalName());
    values.put("attribute", matched.getName());
    values.put("type", matched.getType());
    values.put("value", renderValue(value));
    values.put("valueClass", value == null ? "null" : value.getClass().getName());
    StructuredValueEncoder.encode(matched.getName(), value).appendTo(values);
    String writeFormat = attributeWriteFormat(matched);
    if (OPEN_TYPE_JSON_VALUE_FORMAT.equals(writeFormat)) {
      try {
        OpenType<?> openType = resolveOpenType(matched, value);
        values.put("editableFormat", OPEN_TYPE_JSON_VALUE_FORMAT);
        values.put("editableSchema", OpenTypeJsonCodec.schema(openType));
        values.put(
            "editableValue",
            value == null ? "" : OpenTypeJsonCodec.encode(value, openType));
      } catch (IllegalArgumentException exception) {
        values.put("editableFormat", "");
        values.put("editableSchema", "");
        values.put("editableValue", "");
        values.put("editableDeniedReason", bounded(exception.getMessage()));
      }
    } else if (SCALAR_VALUE_FORMAT.equals(writeFormat) && value != null) {
      values.put("editableFormat", SCALAR_VALUE_FORMAT);
      values.put("editableSchema", matched.getType());
      values.put("editableValue", renderScalarValue(value));
    }
    return values;
  }

  AttributeWritePreview previewAttributeWrite(
      String rawObjectName, String rawAttribute, String rawProposedValue)
      throws Exception {
    return previewAttributeWrite(
        rawObjectName, rawAttribute, rawProposedValue, "");
  }

  AttributeWritePreview previewAttributeWrite(
      String rawObjectName,
      String rawAttribute,
      String rawProposedValue,
      String rawValueFormat)
      throws Exception {
    AttributeSelection selection =
        resolveWritableAttribute(rawObjectName, rawAttribute);
    synchronized (attributeWriteLock) {
      Object currentValue =
          server.getAttribute(selection.objectName, selection.attribute.getName());
      AttributeWriteConversion conversion =
          convertAttributeWriteValue(
              selection, currentValue, rawProposedValue, rawValueFormat);
      return new AttributeWritePreview(
          attributeWriteFingerprint(selection, currentValue, conversion),
          selection.objectName.getCanonicalName(),
          selection.attribute.getName(),
          selection.attribute.getType(),
          renderWritableValue(currentValue, conversion),
          conversion.proposedValue,
          currentValue != null,
          conversion.valueFormat,
          conversion.valueSchema);
    }
  }

  AttributeWriteResult writeAttribute(
      String rawObjectName,
      String rawAttribute,
      String rawProposedValue,
      String rawExpectedFingerprint)
      throws Exception {
    return writeAttribute(
        rawObjectName,
        rawAttribute,
        rawProposedValue,
        "",
        rawExpectedFingerprint);
  }

  AttributeWriteResult writeAttribute(
      String rawObjectName,
      String rawAttribute,
      String rawProposedValue,
      String rawValueFormat,
      String rawExpectedFingerprint)
      throws Exception {
    final String objectName =
        required(rawObjectName, "ObjectName", 2_048);
    final String attribute =
        required(rawAttribute, "Attribute name", 512);
    final String proposedValue = rawProposedValue;
    final String valueFormat = rawValueFormat;
    final String expectedFingerprint =
        required(rawExpectedFingerprint, "Expected fingerprint", 64);
    Future<AttributeWriteResult> task =
        invocationExecutor.submit(
            () -> {
              synchronized (attributeWriteLock) {
                AttributeSelection selection =
                    resolveWritableAttribute(objectName, attribute);
                Object currentValue =
                    server.getAttribute(
                        selection.objectName, selection.attribute.getName());
                AttributeWriteConversion conversion =
                    convertAttributeWriteValue(
                        selection, currentValue, proposedValue, valueFormat);
                String actualFingerprint =
                    attributeWriteFingerprint(selection, currentValue, conversion);
                if (!actualFingerprint.equals(expectedFingerprint)) {
                  throw new StaleAttributeWriteException(actualFingerprint);
                }
                long startedAtNanos = System.nanoTime();
                server.setAttribute(
                    selection.objectName,
                    new Attribute(
                        selection.attribute.getName(), conversion.convertedValue));
                Object appliedValue =
                    server.getAttribute(
                        selection.objectName, selection.attribute.getName());
                return new AttributeWriteResult(
                    selection.objectName.getCanonicalName(),
                    selection.attribute.getName(),
                    selection.attribute.getType(),
                    renderWritableValue(currentValue, conversion),
                    renderWritableValue(appliedValue, conversion),
                    currentValue != null,
                    elapsedMillis(startedAtNanos),
                    conversion.valueFormat,
                    conversion.valueSchema);
              }
            });
    try {
      return task.get(INVOCATION_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
    } catch (TimeoutException exception) {
      task.cancel(true);
      throw new AttributeWriteTimeoutException();
    } catch (ExecutionException exception) {
      Throwable cause =
          exception.getCause() == null ? exception : exception.getCause();
      if (cause instanceof StaleAttributeWriteException) {
        throw (StaleAttributeWriteException) cause;
      }
      if (cause instanceof Exception) {
        throw (Exception) cause;
      }
      throw new IllegalStateException("MBean attribute write failed", cause);
    }
  }

  Preview previewOperation(
      String rawObjectName,
      String rawOperation,
      String rawParameterTypes,
      List<String> rawArguments)
      throws Exception {
    return previewOperation(
        rawObjectName,
        rawOperation,
        rawParameterTypes,
        rawArguments,
        Collections.<String>emptyList());
  }

  Preview previewOperation(
      String rawObjectName,
      String rawOperation,
      String rawParameterTypes,
      List<String> rawArguments,
      List<String> rawArgumentFormats)
      throws Exception {
    Selection selection =
        resolveOperation(
            rawObjectName,
            rawOperation,
            rawParameterTypes,
            rawArguments,
            rawArgumentFormats);
    return new Preview(
        fingerprint(selection),
        selection.objectName.getCanonicalName(),
        selection.operation.getName(),
        operationParameterTypes(selection.operation),
        selection.operation.getReturnType(),
        operationImpact(selection.operation.getImpact()),
        renderInvocation(selection),
        selection.arguments.formats,
        selection.arguments.schemas,
        selection.arguments.canonicalValues);
  }

  InvocationResult invokeOperation(
      String rawObjectName,
      String rawOperation,
      String rawParameterTypes,
      List<String> rawArguments,
      String rawExpectedFingerprint)
      throws Exception {
    return invokeOperation(
        rawObjectName,
        rawOperation,
        rawParameterTypes,
        rawArguments,
        Collections.<String>emptyList(),
        rawExpectedFingerprint);
  }

  InvocationResult invokeOperation(
      String rawObjectName,
      String rawOperation,
      String rawParameterTypes,
      List<String> rawArguments,
      List<String> rawArgumentFormats,
      String rawExpectedFingerprint)
      throws Exception {
    final Selection selection =
        resolveOperation(
            rawObjectName,
            rawOperation,
            rawParameterTypes,
            rawArguments,
            rawArgumentFormats);
    String expectedFingerprint =
        required(rawExpectedFingerprint, "Expected fingerprint", 64);
    String actualFingerprint = fingerprint(selection);
    if (!actualFingerprint.equals(expectedFingerprint)) {
      throw new StaleOperationException(actualFingerprint);
    }
    final Object[] arguments = selection.arguments.values.clone();
    final String[] signature =
        operationTypeNames(selection.operation);
    final long startedAtNanos = System.nanoTime();
    Future<InvocationResult> task =
        invocationExecutor.submit(
            () -> invokeSelected(selection, arguments, signature, startedAtNanos));
    try {
      return task.get(INVOCATION_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
    } catch (TimeoutException exception) {
      task.cancel(true);
      throw new OperationTimeoutException();
    }
  }

  @Override
  public void close() {
    invocationExecutor.shutdownNow();
  }

  private InvocationResult invokeSelected(
      Selection selection,
      Object[] arguments,
      String[] signature,
      long startedAtNanos)
      throws Exception {
    Thread thread = Thread.currentThread();
    ClassLoader previousLoader = thread.getContextClassLoader();
    try {
      ClassLoader targetLoader = server.getClassLoaderFor(selection.objectName);
      if (targetLoader != null) {
        thread.setContextClassLoader(targetLoader);
      }
      Object value =
          server.invoke(
              selection.objectName,
              selection.operation.getName(),
              arguments,
              signature);
      return InvocationResult.returned(
          value == null ? "null" : value.getClass().getName(),
          renderValue(value),
          elapsedMillis(startedAtNanos));
    } catch (MBeanException exception) {
      return InvocationResult.threw(
          exception.getTargetException(), elapsedMillis(startedAtNanos));
    } catch (RuntimeMBeanException exception) {
      return InvocationResult.threw(
          exception.getTargetException(), elapsedMillis(startedAtNanos));
    } catch (RuntimeErrorException exception) {
      return InvocationResult.threw(
          exception.getTargetError(), elapsedMillis(startedAtNanos));
    } finally {
      thread.setContextClassLoader(previousLoader);
    }
  }

  private Selection resolveOperation(
      String rawObjectName,
      String rawOperation,
      String rawParameterTypes,
      List<String> rawArguments,
      List<String> rawArgumentFormats)
      throws Exception {
    ObjectName objectName = exactRegisteredName(rawObjectName);
    String operationName = required(rawOperation, "Operation name", 512);
    String parameterTypes =
        rawParameterTypes == null ? "" : rawParameterTypes.trim();
    if (parameterTypes.length() > 4_096
        || parameterTypes.indexOf('\r') >= 0
        || parameterTypes.indexOf('\n') >= 0) {
      throw new IllegalArgumentException("Operation parameter types are invalid");
    }
    if (rawArguments == null || rawArguments.size() > MAXIMUM_ARGUMENTS) {
      throw new IllegalArgumentException(
          "MBean operations support at most 8 controlled arguments");
    }
    if (rawArgumentFormats == null
        || (!rawArgumentFormats.isEmpty()
            && rawArgumentFormats.size() != rawArguments.size())) {
      throw new IllegalArgumentException(
          "MBean operation argument formats are invalid");
    }
    List<String> arguments = new ArrayList<String>(rawArguments.size());
    int totalArgumentCharacters = 0;
    for (String argument : rawArguments) {
      if (argument == null
          || argument.length() > MAXIMUM_OPERATION_ARGUMENT_CHARACTERS
          || argument.indexOf('\0') >= 0) {
        throw new IllegalArgumentException("MBean operation argument is invalid");
      }
      totalArgumentCharacters += argument.length();
      if (totalArgumentCharacters > MAXIMUM_OPERATION_ARGUMENT_CHARACTERS) {
        throw new IllegalArgumentException(
            "MBean operation arguments exceed the 32 KiB aggregate boundary");
      }
      arguments.add(argument);
    }

    MBeanOperationInfo matched = null;
    for (MBeanOperationInfo operation :
        server.getMBeanInfo(objectName).getOperations()) {
      if (operation.getName().equals(operationName)
          && operationParameterTypes(operation).equals(parameterTypes)) {
        matched = operation;
        break;
      }
    }
    if (matched == null) {
      throw new IllegalArgumentException("MBean operation was not found");
    }
    String deniedReason = invocationDeniedReason(objectName, matched);
    if (!deniedReason.isEmpty()) {
      throw new IllegalArgumentException(deniedReason);
    }
    if (matched.getSignature().length != arguments.size()) {
      throw new IllegalArgumentException(
          "MBean operation argument count does not match the selected signature");
    }
    OperationArgumentsConversion conversion =
        convertArguments(matched, arguments, rawArgumentFormats);
    return new Selection(
        objectName,
        matched,
        server.getMBeanInfo(objectName).getClassName(),
        conversion);
  }

  private AttributeSelection resolveWritableAttribute(
      String rawObjectName, String rawAttribute) throws Exception {
    ObjectName objectName = exactRegisteredName(rawObjectName);
    String attributeName = required(rawAttribute, "Attribute name", 512);
    MBeanInfo info = server.getMBeanInfo(objectName);
    MBeanAttributeInfo matched = null;
    for (MBeanAttributeInfo attribute : info.getAttributes()) {
      if (attribute.getName().equals(attributeName)) {
        matched = attribute;
        break;
      }
    }
    if (matched == null) {
      throw new IllegalArgumentException("MBean attribute was not found");
    }
    String deniedReason = attributeWriteDeniedReason(matched);
    if (!deniedReason.isEmpty()) {
      throw new IllegalArgumentException(deniedReason);
    }
    return new AttributeSelection(objectName, matched, info.getClassName());
  }

  private ObjectName exactRegisteredName(String rawObjectName) throws Exception {
    ObjectName objectName = new ObjectName(required(rawObjectName, "ObjectName", 2_048));
    if (objectName.isPattern()) {
      throw new IllegalArgumentException("ObjectName patterns are not allowed");
    }
    if (!server.isRegistered(objectName)) {
      throw new InstanceNotFoundException(objectName.getCanonicalName());
    }
    return objectName;
  }

  private static String normalizedQuery(String rawQuery) {
    if (rawQuery == null) {
      return "";
    }
    if (rawQuery.length() > 256 || rawQuery.indexOf('\r') >= 0 || rawQuery.indexOf('\n') >= 0) {
      throw new IllegalArgumentException("MBean query is invalid");
    }
    return rawQuery.trim().toLowerCase(Locale.ROOT);
  }

  private static String required(String value, String label, int maximumLength) {
    if (value == null
        || value.trim().isEmpty()
        || value.length() > maximumLength
        || value.indexOf('\r') >= 0
        || value.indexOf('\n') >= 0) {
      throw new IllegalArgumentException(label + " is invalid");
    }
    return value.trim();
  }

  private static String operationSignature(MBeanOperationInfo operation) {
    StringBuilder builder = new StringBuilder();
    MBeanParameterInfo[] signature = operation.getSignature();
    for (int index = 0; index < signature.length; index++) {
      if (index > 0) {
        builder.append(", ");
      }
      builder.append(signature[index].getType());
    }
    return builder.toString();
  }

  private static String operationParameterTypes(MBeanOperationInfo operation) {
    StringBuilder builder = new StringBuilder();
    MBeanParameterInfo[] signature = operation.getSignature();
    for (int index = 0; index < signature.length; index++) {
      if (index > 0) {
        builder.append(',');
      }
      builder.append(signature[index].getType());
    }
    return builder.toString();
  }

  private static String[] operationTypeNames(MBeanOperationInfo operation) {
    MBeanParameterInfo[] parameters = operation.getSignature();
    String[] names = new String[parameters.length];
    for (int index = 0; index < parameters.length; index++) {
      names[index] = parameters[index].getType();
    }
    return names;
  }

  private static String invocationDeniedReason(
      ObjectName objectName, MBeanOperationInfo operation) {
    if ("com.sun.management:type=DiagnosticCommand"
        .equals(objectName.getCanonicalName())) {
      return "DiagnosticCommand MBean operations are not available through the controlled invoker";
    }
    if (operation.getSignature().length > MAXIMUM_ARGUMENTS) {
      return "MBean operations with more than 8 arguments are not supported";
    }
    for (MBeanParameterInfo parameter : operation.getSignature()) {
      if (operationParameterFormat(parameter).isEmpty()) {
        return "Only scalar or bounded JMX OpenType arguments are supported";
      }
    }
    String normalizedName = operation.getName().toLowerCase(Locale.ROOT);
    if (normalizedName.contains("shutdown")
        || normalizedName.contains("terminate")
        || normalizedName.equals("halt")
        || normalizedName.contains("restart")
        || normalizedName.contains("reboot")
        || normalizedName.equals("exec")
        || normalizedName.contains("executecommand")
        || normalizedName.contains("loadagent")) {
      return "Process termination, command execution and agent loading operations are denied";
    }
    return "";
  }

  private static String attributeWriteDeniedReason(
      MBeanAttributeInfo attribute) {
    if (!attribute.isWritable()) {
      return "MBean attribute is not writeable";
    }
    if (!attribute.isReadable()) {
      return "Write-only MBean attributes cannot be changed through the controlled editor";
    }
    if (attributeWriteFormat(attribute).isEmpty()) {
      return "Only scalar or bounded JMX OpenType attributes can be changed through the controlled editor";
    }
    return "";
  }

  private static String attributeWriteFormat(MBeanAttributeInfo attribute) {
    if (isSupportedScalarType(attribute.getType())) {
      return SCALAR_VALUE_FORMAT;
    }
    OpenType<?> openType = declaredOpenType(attribute);
    if (openType != null && OpenTypeJsonCodec.isSupported(openType)) {
      return OPEN_TYPE_JSON_VALUE_FORMAT;
    }
    if (CompositeData.class.getName().equals(attribute.getType())
        || TabularData.class.getName().equals(attribute.getType())) {
      return OPEN_TYPE_JSON_VALUE_FORMAT;
    }
    return "";
  }

  private static OpenType<?> declaredOpenType(MBeanAttributeInfo attribute) {
    if (!(attribute instanceof OpenMBeanAttributeInfo)) {
      return null;
    }
    return ((OpenMBeanAttributeInfo) attribute).getOpenType();
  }

  private static OpenType<?> declaredOpenType(MBeanParameterInfo parameter) {
    if (!(parameter instanceof OpenMBeanParameterInfo)) {
      return null;
    }
    return ((OpenMBeanParameterInfo) parameter).getOpenType();
  }

  private static String operationParameterFormat(MBeanParameterInfo parameter) {
    if (isSupportedScalarType(parameter.getType())) {
      return SCALAR_VALUE_FORMAT;
    }
    OpenType<?> openType = declaredOpenType(parameter);
    if (openType != null && OpenTypeJsonCodec.isSupported(openType)) {
      return OPEN_TYPE_JSON_VALUE_FORMAT;
    }
    return "";
  }

  private static OpenType<?> resolveOpenType(
      MBeanAttributeInfo attribute, Object currentValue) {
    OpenType<?> declared = declaredOpenType(attribute);
    if (declared != null) {
      if (!OpenTypeJsonCodec.isSupported(declared)) {
        throw new IllegalArgumentException(
            "The MBean attribute OpenType exceeds the controlled editor boundary");
      }
      return declared;
    }
    OpenType<?> inferred = null;
    if (currentValue instanceof CompositeData) {
      inferred = ((CompositeData) currentValue).getCompositeType();
    } else if (currentValue instanceof TabularData) {
      inferred = ((TabularData) currentValue).getTabularType();
    }
    if (inferred == null || !OpenTypeJsonCodec.isSupported(inferred)) {
      throw new IllegalArgumentException(
          "The MBean attribute OpenType cannot be resolved from its current value");
    }
    return inferred;
  }

  private static AttributeWriteConversion convertAttributeWriteValue(
      AttributeSelection selection,
      Object currentValue,
      String rawProposedValue,
      String rawValueFormat)
      throws Exception {
    String expectedFormat = attributeWriteFormat(selection.attribute);
    String requestedFormat =
        rawValueFormat == null || rawValueFormat.trim().isEmpty()
            ? expectedFormat
            : required(rawValueFormat, "Attribute value format", 32);
    if (!expectedFormat.equals(requestedFormat)) {
      throw new IllegalArgumentException(
          "MBean attribute value format does not match the selected attribute");
    }
    if (SCALAR_VALUE_FORMAT.equals(expectedFormat)) {
      String proposedValue =
          validatedScalarInput(rawProposedValue, "Proposed attribute value");
      Object converted = convertArgument(selection.attribute.getType(), proposedValue);
      return new AttributeWriteConversion(
          SCALAR_VALUE_FORMAT,
          selection.attribute.getType(),
          null,
          converted,
          renderScalarValue(converted));
    }
    if (OPEN_TYPE_JSON_VALUE_FORMAT.equals(expectedFormat)) {
      OpenType<?> openType = resolveOpenType(selection.attribute, currentValue);
      Object converted = OpenTypeJsonCodec.decode(rawProposedValue, openType);
      return new AttributeWriteConversion(
          OPEN_TYPE_JSON_VALUE_FORMAT,
          OpenTypeJsonCodec.schema(openType),
          openType,
          converted,
          OpenTypeJsonCodec.encode(converted, openType));
    }
    throw new IllegalArgumentException("MBean attribute writes are not supported");
  }

  private static String renderWritableValue(
      Object value, AttributeWriteConversion conversion) {
    if (value == null) {
      return "<null>";
    }
    if (SCALAR_VALUE_FORMAT.equals(conversion.valueFormat)) {
      return renderScalarValue(value);
    }
    return OpenTypeJsonCodec.encode(value, conversion.openType);
  }

  private static boolean isSupportedScalarType(String type) {
    switch (type) {
      case "java.lang.String":
      case "boolean":
      case "java.lang.Boolean":
      case "byte":
      case "java.lang.Byte":
      case "short":
      case "java.lang.Short":
      case "int":
      case "java.lang.Integer":
      case "long":
      case "java.lang.Long":
      case "float":
      case "java.lang.Float":
      case "double":
      case "java.lang.Double":
      case "char":
      case "java.lang.Character":
      case "java.math.BigInteger":
      case "java.math.BigDecimal":
      case "javax.management.ObjectName":
        return true;
      default:
        return false;
    }
  }

  private static OperationArgumentsConversion convertArguments(
      MBeanOperationInfo operation,
      List<String> arguments,
      List<String> requestedFormats)
      throws Exception {
    MBeanParameterInfo[] signature = operation.getSignature();
    Object[] converted = new Object[signature.length];
    List<String> formats = new ArrayList<String>(signature.length);
    List<String> schemas = new ArrayList<String>(signature.length);
    List<String> canonicalValues = new ArrayList<String>(signature.length);
    for (int index = 0; index < signature.length; index++) {
      MBeanParameterInfo parameter = signature[index];
      String expectedFormat = operationParameterFormat(parameter);
      if (requestedFormats.isEmpty()
          && OPEN_TYPE_JSON_VALUE_FORMAT.equals(expectedFormat)) {
        throw new IllegalArgumentException(
            "OpenType MBean operation arguments require an explicit value format");
      }
      String requestedFormat =
          requestedFormats.isEmpty()
              ? expectedFormat
              : required(
                  requestedFormats.get(index),
                  "MBean operation argument format",
                  32);
      if (!expectedFormat.equals(requestedFormat)) {
        throw new IllegalArgumentException(
            "MBean operation argument format does not match the selected signature");
      }
      String rawValue = arguments.get(index);
      if (SCALAR_VALUE_FORMAT.equals(expectedFormat)) {
        String scalarValue =
            validatedScalarInput(rawValue, "MBean operation argument");
        Object value = convertArgument(parameter.getType(), scalarValue);
        converted[index] = value;
        formats.add(SCALAR_VALUE_FORMAT);
        schemas.add(parameter.getType());
        canonicalValues.add(renderScalarValue(value));
        continue;
      }
      if (OPEN_TYPE_JSON_VALUE_FORMAT.equals(expectedFormat)) {
        OpenType<?> openType = declaredOpenType(parameter);
        if (openType == null || !OpenTypeJsonCodec.isSupported(openType)) {
          throw new IllegalArgumentException(
              "MBean operation parameter OpenType is unavailable");
        }
        Object value = OpenTypeJsonCodec.decode(rawValue, openType);
        converted[index] = value;
        formats.add(OPEN_TYPE_JSON_VALUE_FORMAT);
        schemas.add(OpenTypeJsonCodec.schema(openType));
        canonicalValues.add(OpenTypeJsonCodec.encode(value, openType));
        continue;
      }
      throw new IllegalArgumentException(
          "Unsupported MBean operation argument type");
    }
    return new OperationArgumentsConversion(
        converted, formats, schemas, canonicalValues);
  }

  private static Object convertArgument(String type, String value)
      throws Exception {
    switch (type) {
      case "java.lang.String":
        return value;
      case "boolean":
      case "java.lang.Boolean":
        if (!"true".equalsIgnoreCase(value)
            && !"false".equalsIgnoreCase(value)) {
          throw new IllegalArgumentException(
              "Boolean MBean arguments must be true or false");
        }
        return Boolean.valueOf(value);
      case "byte":
      case "java.lang.Byte":
        return Byte.valueOf(value);
      case "short":
      case "java.lang.Short":
        return Short.valueOf(value);
      case "int":
      case "java.lang.Integer":
        return Integer.valueOf(value);
      case "long":
      case "java.lang.Long":
        return Long.valueOf(value);
      case "float":
      case "java.lang.Float":
        Float floatValue = Float.valueOf(value);
        if (!Float.isFinite(floatValue.floatValue())) {
          throw new IllegalArgumentException(
              "Float MBean arguments must be finite");
        }
        return floatValue;
      case "double":
      case "java.lang.Double":
        Double doubleValue = Double.valueOf(value);
        if (!Double.isFinite(doubleValue.doubleValue())) {
          throw new IllegalArgumentException(
              "Double MBean arguments must be finite");
        }
        return doubleValue;
      case "char":
      case "java.lang.Character":
        if (value.length() != 1) {
          throw new IllegalArgumentException(
              "Character MBean arguments must contain exactly one character");
        }
        return Character.valueOf(value.charAt(0));
      case "java.math.BigInteger":
        return new BigInteger(value);
      case "java.math.BigDecimal":
        return new BigDecimal(value);
      case "javax.management.ObjectName":
        ObjectName objectName = new ObjectName(value);
        if (objectName.isPattern()) {
          throw new IllegalArgumentException(
              "ObjectName MBean arguments cannot be patterns");
        }
        return objectName;
      default:
        throw new IllegalArgumentException(
            "Unsupported MBean operation argument type");
    }
  }

  private static String validatedScalarInput(String value, String label) {
    if (value == null
        || value.length() > MAXIMUM_ARGUMENT_CHARACTERS
        || value.indexOf('\r') >= 0
        || value.indexOf('\n') >= 0) {
      throw new IllegalArgumentException(label + " is invalid");
    }
    return value;
  }

  private static String renderScalarValue(Object value) {
    if (value == null) {
      return "<null>";
    }
    String rendered;
    if (value instanceof BigDecimal) {
      rendered = ((BigDecimal) value).toPlainString();
    } else if (value instanceof ObjectName) {
      rendered = ((ObjectName) value).getCanonicalName();
    } else if (value instanceof CharSequence
        || value instanceof Number
        || value instanceof Boolean
        || value instanceof Character) {
      rendered = String.valueOf(value);
    } else {
      throw new IllegalArgumentException(
          "MBean attribute value is not a supported scalar");
    }
    if (rendered.length() > MAXIMUM_ARGUMENT_CHARACTERS
        || rendered.indexOf('\r') >= 0
        || rendered.indexOf('\n') >= 0) {
      throw new IllegalArgumentException(
          "MBean attribute value cannot be represented safely");
    }
    return rendered;
  }

  private static String operationImpact(int impact) {
    switch (impact) {
      case MBeanOperationInfo.INFO:
        return "INFO";
      case MBeanOperationInfo.ACTION:
        return "ACTION";
      case MBeanOperationInfo.ACTION_INFO:
        return "ACTION_INFO";
      default:
        return "UNKNOWN";
    }
  }

  private static String renderValue(Object value) {
    StringBuilder output = new StringBuilder();
    Set<Object> visited =
        Collections.newSetFromMap(new IdentityHashMap<Object, Boolean>());
    appendValue(output, value, 0, visited);
    if (output.length() > MAXIMUM_VALUE_CHARACTERS) {
      return output.substring(0, MAXIMUM_VALUE_CHARACTERS - 1) + "…";
    }
    return output.toString();
  }

  private static void appendValue(
      StringBuilder output, Object value, int depth, Set<Object> visited) {
    if (output.length() >= MAXIMUM_VALUE_CHARACTERS) {
      return;
    }
    if (value == null) {
      output.append("null");
      return;
    }
    if (isSafeScalar(value)) {
      appendBounded(output, safeScalarValue(value));
      return;
    }
    if (depth >= MAXIMUM_VALUE_DEPTH) {
      appendBounded(output, "<" + value.getClass().getName() + ">");
      return;
    }
    if (!visited.add(value)) {
      output.append("<cycle>");
      return;
    }
    try {
      if (value.getClass().isArray()) {
        appendArray(output, value, depth, visited);
      } else if (value instanceof CompositeData) {
        appendComposite(output, (CompositeData) value, depth, visited);
      } else if (value instanceof TabularData) {
        appendCollection(output, ((TabularData) value).values(), depth, visited);
      } else if (value instanceof Map) {
        appendMap(output, (Map<?, ?>) value, depth, visited);
      } else if (value instanceof Collection) {
        appendCollection(output, (Collection<?>) value, depth, visited);
      } else {
        appendBounded(output, "<" + value.getClass().getName() + ">");
      }
    } finally {
      visited.remove(value);
    }
  }

  private static void appendArray(
      StringBuilder output, Object value, int depth, Set<Object> visited) {
    output.append('[');
    int length = Math.min(Array.getLength(value), MAXIMUM_COLLECTION_ENTRIES);
    for (int index = 0; index < length; index++) {
      appendSeparator(output, index);
      appendValue(output, Array.get(value, index), depth + 1, visited);
    }
    if (Array.getLength(value) > length) {
      output.append(", …");
    }
    output.append(']');
  }

  private static void appendComposite(
      StringBuilder output, CompositeData value, int depth, Set<Object> visited) {
    output.append('{');
    List<String> keys = new ArrayList<String>(value.getCompositeType().keySet());
    Collections.sort(keys);
    int length = Math.min(keys.size(), MAXIMUM_COLLECTION_ENTRIES);
    for (int index = 0; index < length; index++) {
      appendSeparator(output, index);
      String key = keys.get(index);
      appendBounded(output, key);
      output.append('=');
      appendValue(output, value.get(key), depth + 1, visited);
    }
    if (keys.size() > length) {
      output.append(", …");
    }
    output.append('}');
  }

  private static void appendMap(
      StringBuilder output, Map<?, ?> value, int depth, Set<Object> visited) {
    output.append('{');
    int index = 0;
    for (Map.Entry<?, ?> entry : value.entrySet()) {
      if (index >= MAXIMUM_COLLECTION_ENTRIES) {
        output.append(", …");
        break;
      }
      appendSeparator(output, index++);
      appendValue(output, entry.getKey(), depth + 1, visited);
      output.append('=');
      appendValue(output, entry.getValue(), depth + 1, visited);
    }
    output.append('}');
  }

  private static void appendCollection(
      StringBuilder output, Collection<?> value, int depth, Set<Object> visited) {
    output.append('[');
    int index = 0;
    for (Object item : value) {
      if (index >= MAXIMUM_COLLECTION_ENTRIES) {
        output.append(", …");
        break;
      }
      appendSeparator(output, index++);
      appendValue(output, item, depth + 1, visited);
    }
    output.append(']');
  }

  private static void appendSeparator(StringBuilder output, int index) {
    if (index > 0) {
      output.append(", ");
    }
  }

  private static void appendBounded(StringBuilder output, String value) {
    int remaining = MAXIMUM_VALUE_CHARACTERS - output.length();
    if (remaining <= 0) {
      return;
    }
    String safe = value == null ? "" : value;
    output.append(safe, 0, Math.min(safe.length(), remaining));
  }

  private static boolean isSafeScalar(Object value) {
    return value instanceof String
        || value instanceof Byte
        || value instanceof Short
        || value instanceof Integer
        || value instanceof Long
        || value instanceof Float
        || value instanceof Double
        || value instanceof BigInteger
        || value instanceof BigDecimal
        || value instanceof Boolean
        || value instanceof Character
        || value instanceof Enum
        || value instanceof ObjectName
        || value instanceof Date;
  }

  private static String safeScalarValue(Object value) {
    if (value instanceof BigDecimal) {
      return ((BigDecimal) value).toPlainString();
    }
    if (value instanceof ObjectName) {
      return ((ObjectName) value).getCanonicalName();
    }
    if (value instanceof Enum) {
      return ((Enum<?>) value).name();
    }
    if (value instanceof Date) {
      return Long.toString(((Date) value).getTime());
    }
    return String.valueOf(value);
  }

  private static final class StructuredValueEncoder {
    private final List<StructuredValueNode> nodes =
        new ArrayList<StructuredValueNode>();
    private final Set<Object> active =
        Collections.newSetFromMap(new IdentityHashMap<Object, Boolean>());
    private int remainingCharacters = MAXIMUM_STRUCTURED_VALUE_CHARACTERS;
    private boolean nodeLimitReached;
    private boolean depthLimitReached;
    private boolean entryLimitReached;
    private boolean characterLimitReached;

    static StructuredValueEncoder encode(String rootKey, Object value) {
      StructuredValueEncoder encoder = new StructuredValueEncoder();
      encoder.appendNode(-1, rootKey, value, 0);
      return encoder;
    }

    void appendTo(Map<String, String> values) {
      values.put("structured", "true");
      values.put("node.count", Integer.toString(nodes.size()));
      values.put(
          "node.maximumDepth",
          Integer.toString(MAXIMUM_STRUCTURED_VALUE_DEPTH));
      values.put(
          "node.maximumNodes",
          Integer.toString(MAXIMUM_STRUCTURED_VALUE_NODES));
      values.put(
          "node.maximumEntries",
          Integer.toString(MAXIMUM_COLLECTION_ENTRIES));
      values.put("node.nodeLimitReached", Boolean.toString(nodeLimitReached));
      values.put("node.depthLimitReached", Boolean.toString(depthLimitReached));
      values.put("node.entryLimitReached", Boolean.toString(entryLimitReached));
      values.put(
          "node.characterLimitReached",
          Boolean.toString(characterLimitReached));
      for (StructuredValueNode node : nodes) {
        String prefix =
            "node." + String.format(Locale.ROOT, "%04d", node.index) + ".";
        values.put(prefix + "index", Integer.toString(node.index));
        values.put(prefix + "parentIndex", Integer.toString(node.parentIndex));
        values.put(prefix + "depth", Integer.toString(node.depth));
        values.put(prefix + "key", node.key);
        values.put(prefix + "kind", node.kind);
        values.put(prefix + "type", node.type);
        values.put(prefix + "value", node.value);
        values.put(prefix + "childCount", Integer.toString(node.childCount));
        values.put(
            prefix + "displayedChildren",
            Integer.toString(node.displayedChildren));
        values.put(prefix + "truncated", Boolean.toString(node.truncated));
      }
    }

    private boolean appendNode(
        int parentIndex, String rawKey, Object value, int depth) {
      if (nodes.size() >= MAXIMUM_STRUCTURED_VALUE_NODES) {
        nodeLimitReached = true;
        return false;
      }
      int index = nodes.size();
      String type = value == null ? "null" : value.getClass().getName();
      StructuredValueNode node =
          new StructuredValueNode(
              index,
              parentIndex,
              depth,
              take(rawKey),
              take(type));
      nodes.add(node);

      if (value == null) {
        node.kind = "NULL";
        node.value = take("null");
        return true;
      }
      if (isSafeScalar(value)) {
        node.kind = "SCALAR";
        node.value = take(safeScalarValue(value));
        return true;
      }
      if (active.contains(value)) {
        node.kind = "CYCLE";
        node.value = take("<cycle>");
        return true;
      }

      ContainerView container = containerView(value);
      if (container == null) {
        node.kind = "UNSUPPORTED";
        node.value = take("<" + type + ">");
        return true;
      }
      node.kind = container.kind;
      node.childCount = container.size;
      node.value = take("size=" + container.size);
      if (container.size == 0) {
        return true;
      }
      if (depth >= MAXIMUM_STRUCTURED_VALUE_DEPTH) {
        node.truncated = true;
        depthLimitReached = true;
        return true;
      }

      active.add(value);
      try {
        int maximumEntries =
            Math.min(container.size, MAXIMUM_COLLECTION_ENTRIES);
        if (container.size > maximumEntries) {
          node.truncated = true;
          entryLimitReached = true;
        }
        Iterator<StructuredChild> children = container.children.iterator();
        int childIndex = 0;
        while (childIndex < maximumEntries && children.hasNext()) {
          StructuredChild child = children.next();
          if (!appendNode(index, child.key, child.value, depth + 1)) {
            node.truncated = true;
            break;
          }
          node.displayedChildren++;
          childIndex++;
        }
        if (childIndex < maximumEntries) {
          node.truncated = true;
        }
      } finally {
        active.remove(value);
      }
      return true;
    }

    private ContainerView containerView(Object value) {
      if (value.getClass().isArray()) {
        int length = Array.getLength(value);
        List<StructuredChild> children =
            new ArrayList<StructuredChild>(
                Math.min(length, MAXIMUM_COLLECTION_ENTRIES));
        for (int index = 0;
            index < length && index < MAXIMUM_COLLECTION_ENTRIES;
            index++) {
          children.add(
              new StructuredChild(
                  "[" + index + "]", Array.get(value, index)));
        }
        return new ContainerView("ARRAY", length, children);
      }
      if (value instanceof CompositeData) {
        CompositeData composite = (CompositeData) value;
        List<String> keys =
            new ArrayList<String>(composite.getCompositeType().keySet());
        Collections.sort(keys);
        List<StructuredChild> children =
            new ArrayList<StructuredChild>(
                Math.min(keys.size(), MAXIMUM_COLLECTION_ENTRIES));
        for (int index = 0;
            index < keys.size() && index < MAXIMUM_COLLECTION_ENTRIES;
            index++) {
          String key = keys.get(index);
          children.add(new StructuredChild(key, composite.get(key)));
        }
        return new ContainerView("COMPOSITE", keys.size(), children);
      }
      if (value instanceof TabularData) {
        TabularData table = (TabularData) value;
        return indexedContainer("TABULAR", table.size(), table.values());
      }
      if (value instanceof Map) {
        Map<?, ?> map = (Map<?, ?>) value;
        List<StructuredChild> children =
            new ArrayList<StructuredChild>(
                Math.min(map.size(), MAXIMUM_COLLECTION_ENTRIES));
        int index = 0;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
          if (index >= MAXIMUM_COLLECTION_ENTRIES) {
            break;
          }
          children.add(
              new StructuredChild(
                  safeKey(entry.getKey(), index), entry.getValue()));
          index++;
        }
        return new ContainerView("MAP", map.size(), children);
      }
      if (value instanceof Collection) {
        Collection<?> collection = (Collection<?>) value;
        return indexedContainer("COLLECTION", collection.size(), collection);
      }
      return null;
    }

    private ContainerView indexedContainer(
        String kind, int size, Collection<?> values) {
      List<StructuredChild> children =
          new ArrayList<StructuredChild>(
              Math.min(size, MAXIMUM_COLLECTION_ENTRIES));
      int index = 0;
      for (Object item : values) {
        if (index >= MAXIMUM_COLLECTION_ENTRIES) {
          break;
        }
        children.add(new StructuredChild("[" + index + "]", item));
        index++;
      }
      return new ContainerView(kind, size, children);
    }

    private static String safeKey(Object key, int index) {
      if (key == null) {
        return "null";
      }
      if (isSafeScalar(key)) {
        return safeScalarValue(key);
      }
      return "[" + index + "] <" + key.getClass().getName() + ">";
    }

    private String take(String rawValue) {
      String value =
          rawValue == null
              ? ""
              : rawValue.replace('\r', ' ').replace('\n', ' ');
      if (value.length() <= remainingCharacters) {
        remainingCharacters -= value.length();
        return value;
      }
      characterLimitReached = true;
      if (remainingCharacters <= 0) {
        return "";
      }
      int available = remainingCharacters;
      remainingCharacters = 0;
      if (available == 1) {
        return "…";
      }
      return value.substring(0, available - 1) + "…";
    }
  }

  private static final class StructuredValueNode {
    private final int index;
    private final int parentIndex;
    private final int depth;
    private final String key;
    private final String type;
    private String kind = "UNSUPPORTED";
    private String value = "";
    private int childCount;
    private int displayedChildren;
    private boolean truncated;

    StructuredValueNode(
        int index, int parentIndex, int depth, String key, String type) {
      this.index = index;
      this.parentIndex = parentIndex;
      this.depth = depth;
      this.key = key;
      this.type = type;
    }
  }

  private static final class StructuredChild {
    private final String key;
    private final Object value;

    StructuredChild(String key, Object value) {
      this.key = key;
      this.value = value;
    }
  }

  private static final class ContainerView {
    private final String kind;
    private final int size;
    private final Collection<StructuredChild> children;

    ContainerView(
        String kind, int size, Collection<StructuredChild> children) {
      this.kind = kind;
      this.size = size;
      this.children = children;
    }
  }

  private static String bounded(String value) {
    if (value == null) {
      return "";
    }
    String singleLine = value.replace('\r', ' ').replace('\n', ' ');
    return singleLine.length() <= MAXIMUM_VALUE_CHARACTERS
        ? singleLine
        : singleLine.substring(0, MAXIMUM_VALUE_CHARACTERS - 1) + "…";
  }

  private static String stringValue(String value) {
    return value == null ? "" : bounded(value);
  }

  private static String fingerprint(Selection selection) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    updateDigest(digest, selection.objectName.getCanonicalName());
    updateDigest(digest, selection.className);
    updateDigest(digest, selection.operation.getName());
    updateDigest(digest, selection.operation.getReturnType());
    updateDigest(digest, Integer.toString(selection.operation.getImpact()));
    updateDigest(digest, operationParameterTypes(selection.operation));
    for (int index = 0;
        index < selection.arguments.canonicalValues.size();
        index++) {
      updateDigest(digest, selection.arguments.formats.get(index));
      updateDigest(digest, selection.arguments.schemas.get(index));
      updateDigest(digest, selection.arguments.canonicalValues.get(index));
    }
    byte[] value = digest.digest();
    StringBuilder result = new StringBuilder(value.length * 2);
    for (byte item : value) {
      result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
    }
    return result.toString();
  }

  private static String attributeWriteFingerprint(
      AttributeSelection selection,
      Object currentValue,
      AttributeWriteConversion conversion)
      throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    updateDigest(digest, selection.objectName.getCanonicalName());
    updateDigest(digest, selection.className);
    updateDigest(digest, selection.attribute.getName());
    updateDigest(digest, selection.attribute.getType());
    updateDigest(digest, Boolean.toString(currentValue == null));
    updateDigest(digest, conversion.valueFormat);
    updateDigest(digest, conversion.valueSchema);
    updateDigest(digest, renderWritableValue(currentValue, conversion));
    updateDigest(digest, conversion.proposedValue);
    byte[] value = digest.digest();
    StringBuilder result = new StringBuilder(value.length * 2);
    for (byte item : value) {
      result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
    }
    return result.toString();
  }

  private static void updateDigest(MessageDigest digest, String value) {
    byte[] encoded = value.getBytes(StandardCharsets.UTF_8);
    digest.update((byte) (encoded.length >>> 24));
    digest.update((byte) (encoded.length >>> 16));
    digest.update((byte) (encoded.length >>> 8));
    digest.update((byte) encoded.length);
    digest.update(encoded);
  }

  private static String renderInvocation(Selection selection) {
    StringBuilder result =
        new StringBuilder()
            .append(selection.objectName.getCanonicalName())
            .append(" :: ")
            .append(selection.operation.getName())
            .append('(');
    for (int index = 0;
        index < selection.arguments.canonicalValues.size();
        index++) {
      if (index > 0) {
        result.append(", ");
      }
      String value = selection.arguments.canonicalValues.get(index);
      if (SCALAR_VALUE_FORMAT.equals(selection.arguments.formats.get(index))) {
        result
            .append('"')
            .append(value.replace("\\", "\\\\").replace("\"", "\\\""))
            .append('"');
      } else {
        result.append(value);
      }
    }
    result.append(')');
    if (result.length() > MAXIMUM_VALUE_CHARACTERS) {
      return result.substring(0, MAXIMUM_VALUE_CHARACTERS - 1) + "…";
    }
    return result.toString();
  }

  private static long elapsedMillis(long startedAtNanos) {
    return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAtNanos);
  }

  static final class StaleOperationException extends IllegalStateException {
    private final String actualFingerprint;

    StaleOperationException(String actualFingerprint) {
      super("The MBean operation or its arguments changed after preview");
      this.actualFingerprint = actualFingerprint;
    }

    String getActualFingerprint() {
      return actualFingerprint;
    }
  }

  static final class OperationTimeoutException extends IllegalStateException {
    OperationTimeoutException() {
      super(
          "The MBean operation exceeded 3 seconds; interruption was requested but target code may continue");
    }
  }

  static final class StaleAttributeWriteException
      extends IllegalStateException {
    private final String actualFingerprint;

    StaleAttributeWriteException(String actualFingerprint) {
      super("The MBean attribute changed after preview");
      this.actualFingerprint = actualFingerprint;
    }

    String getActualFingerprint() {
      return actualFingerprint;
    }
  }

  static final class AttributeWriteTimeoutException
      extends IllegalStateException {
    AttributeWriteTimeoutException() {
      super(
          "The MBean attribute setter exceeded 3 seconds; interruption was requested but target code may continue");
    }
  }

  static final class AttributeWritePreview {
    private final String fingerprint;
    private final String objectName;
    private final String attribute;
    private final String type;
    private final String oldValue;
    private final String proposedValue;
    private final boolean restoreSupported;
    private final String valueFormat;
    private final String valueSchema;

    AttributeWritePreview(
        String fingerprint,
        String objectName,
        String attribute,
        String type,
        String oldValue,
        String proposedValue,
        boolean restoreSupported,
        String valueFormat,
        String valueSchema) {
      this.fingerprint = fingerprint;
      this.objectName = objectName;
      this.attribute = attribute;
      this.type = type;
      this.oldValue = oldValue;
      this.proposedValue = proposedValue;
      this.restoreSupported = restoreSupported;
      this.valueFormat = valueFormat;
      this.valueSchema = valueSchema;
    }

    String getFingerprint() {
      return fingerprint;
    }

    String getObjectName() {
      return objectName;
    }

    String getAttribute() {
      return attribute;
    }

    String getType() {
      return type;
    }

    String getOldValue() {
      return oldValue;
    }

    String getProposedValue() {
      return proposedValue;
    }

    boolean isRestoreSupported() {
      return restoreSupported;
    }

    String getValueFormat() {
      return valueFormat;
    }

    String getValueSchema() {
      return valueSchema;
    }
  }

  static final class AttributeWriteResult {
    private final String objectName;
    private final String attribute;
    private final String type;
    private final String oldValue;
    private final String newValue;
    private final boolean restoreSupported;
    private final long durationMillis;
    private final String valueFormat;
    private final String valueSchema;

    AttributeWriteResult(
        String objectName,
        String attribute,
        String type,
        String oldValue,
        String newValue,
        boolean restoreSupported,
        long durationMillis,
        String valueFormat,
        String valueSchema) {
      this.objectName = objectName;
      this.attribute = attribute;
      this.type = type;
      this.oldValue = oldValue;
      this.newValue = newValue;
      this.restoreSupported = restoreSupported;
      this.durationMillis = durationMillis;
      this.valueFormat = valueFormat;
      this.valueSchema = valueSchema;
    }

    String getObjectName() {
      return objectName;
    }

    String getAttribute() {
      return attribute;
    }

    String getType() {
      return type;
    }

    String getOldValue() {
      return oldValue;
    }

    String getNewValue() {
      return newValue;
    }

    boolean isRestoreSupported() {
      return restoreSupported;
    }

    long getDurationMillis() {
      return durationMillis;
    }

    String getValueFormat() {
      return valueFormat;
    }

    String getValueSchema() {
      return valueSchema;
    }
  }

  static final class Preview {
    private final String fingerprint;
    private final String objectName;
    private final String operation;
    private final String parameterTypes;
    private final String returnType;
    private final String impact;
    private final String invocation;
    private final List<String> argumentFormats;
    private final List<String> argumentSchemas;
    private final List<String> argumentValues;

    Preview(
        String fingerprint,
        String objectName,
        String operation,
        String parameterTypes,
        String returnType,
        String impact,
        String invocation,
        List<String> argumentFormats,
        List<String> argumentSchemas,
        List<String> argumentValues) {
      this.fingerprint = fingerprint;
      this.objectName = objectName;
      this.operation = operation;
      this.parameterTypes = parameterTypes;
      this.returnType = returnType;
      this.impact = impact;
      this.invocation = invocation;
      this.argumentFormats =
          Collections.unmodifiableList(
              new ArrayList<String>(argumentFormats));
      this.argumentSchemas =
          Collections.unmodifiableList(
              new ArrayList<String>(argumentSchemas));
      this.argumentValues =
          Collections.unmodifiableList(
              new ArrayList<String>(argumentValues));
    }

    String getFingerprint() {
      return fingerprint;
    }

    String getObjectName() {
      return objectName;
    }

    String getOperation() {
      return operation;
    }

    String getParameterTypes() {
      return parameterTypes;
    }

    String getReturnType() {
      return returnType;
    }

    String getImpact() {
      return impact;
    }

    String getInvocation() {
      return invocation;
    }

    int getArgumentCount() {
      return argumentValues.size();
    }

    String getArgumentFormat(int index) {
      return argumentFormats.get(index);
    }

    String getArgumentSchema(int index) {
      return argumentSchemas.get(index);
    }

    String getArgumentValue(int index) {
      return argumentValues.get(index);
    }
  }

  static final class InvocationResult {
    private final String outcome;
    private final String valueClass;
    private final String returnValue;
    private final String exceptionType;
    private final String exceptionMessage;
    private final long durationMillis;

    private InvocationResult(
        String outcome,
        String valueClass,
        String returnValue,
        String exceptionType,
        String exceptionMessage,
        long durationMillis) {
      this.outcome = outcome;
      this.valueClass = valueClass;
      this.returnValue = returnValue;
      this.exceptionType = exceptionType;
      this.exceptionMessage = exceptionMessage;
      this.durationMillis = durationMillis;
    }

    static InvocationResult returned(
        String valueClass, String returnValue, long durationMillis) {
      return new InvocationResult(
          "RETURNED", valueClass, returnValue, "", "", durationMillis);
    }

    static InvocationResult threw(Throwable throwable, long durationMillis) {
      Throwable safe =
          throwable == null
              ? new IllegalStateException("MBean operation failed without a cause")
              : throwable;
      return new InvocationResult(
          "THREW",
          "",
          "",
          safe.getClass().getName(),
          bounded(safe.getMessage()),
          durationMillis);
    }

    String getOutcome() {
      return outcome;
    }

    String getValueClass() {
      return valueClass;
    }

    String getReturnValue() {
      return returnValue;
    }

    String getExceptionType() {
      return exceptionType;
    }

    String getExceptionMessage() {
      return exceptionMessage;
    }

    long getDurationMillis() {
      return durationMillis;
    }
  }

  private static final class Selection {
    private final ObjectName objectName;
    private final MBeanOperationInfo operation;
    private final String className;
    private final OperationArgumentsConversion arguments;

    private Selection(
        ObjectName objectName,
        MBeanOperationInfo operation,
        String className,
        OperationArgumentsConversion arguments) {
      this.objectName = objectName;
      this.operation = operation;
      this.className = className;
      this.arguments = arguments;
    }
  }

  private static final class OperationArgumentsConversion {
    private final Object[] values;
    private final List<String> formats;
    private final List<String> schemas;
    private final List<String> canonicalValues;

    private OperationArgumentsConversion(
        Object[] values,
        List<String> formats,
        List<String> schemas,
        List<String> canonicalValues) {
      this.values = values.clone();
      this.formats =
          Collections.unmodifiableList(new ArrayList<String>(formats));
      this.schemas =
          Collections.unmodifiableList(new ArrayList<String>(schemas));
      this.canonicalValues =
          Collections.unmodifiableList(
              new ArrayList<String>(canonicalValues));
    }
  }

  private static final class AttributeSelection {
    private final ObjectName objectName;
    private final MBeanAttributeInfo attribute;
    private final String className;

    private AttributeSelection(
        ObjectName objectName,
        MBeanAttributeInfo attribute,
        String className) {
      this.objectName = objectName;
      this.attribute = attribute;
      this.className = className;
    }
  }

  private static final class AttributeWriteConversion {
    private final String valueFormat;
    private final String valueSchema;
    private final OpenType<?> openType;
    private final Object convertedValue;
    private final String proposedValue;

    private AttributeWriteConversion(
        String valueFormat,
        String valueSchema,
        OpenType<?> openType,
        Object convertedValue,
        String proposedValue) {
      this.valueFormat = valueFormat;
      this.valueSchema = valueSchema;
      this.openType = openType;
      this.convertedValue = convertedValue;
      this.proposedValue = proposedValue;
    }
  }

  private static final class MBeanInvocationThreadFactory
      implements ThreadFactory {
    private static final AtomicInteger SEQUENCE = new AtomicInteger();

    @Override
    public Thread newThread(Runnable runnable) {
      Thread thread =
          new Thread(
              runnable,
              "tanwei-mbean-invoke-" + SEQUENCE.incrementAndGet());
      thread.setDaemon(true);
      return thread;
    }
  }
}
