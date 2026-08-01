package dev.tanwei.integration;

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
import javax.management.ReflectionException;
import javax.management.openmbean.ArrayType;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.CompositeType;
import javax.management.openmbean.OpenDataException;
import javax.management.openmbean.OpenMBeanOperationInfoSupport;
import javax.management.openmbean.OpenMBeanParameterInfoSupport;
import javax.management.openmbean.OpenType;
import javax.management.openmbean.SimpleType;

/** Real target OpenMBean used by Attach and packaged desktop tests. */
public final class IntegrationOpenControl implements DynamicMBean {
  private static final CompositeType SETTINGS_TYPE = settingsType();

  @Override
  public Object getAttribute(String attribute) throws AttributeNotFoundException {
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
        IntegrationOpenControl.class.getName(),
        "Integration OpenType operation control",
        new MBeanAttributeInfo[0],
        new MBeanConstructorInfo[0],
        new MBeanOperationInfo[] {operation},
        new MBeanNotificationInfo[0]);
  }

  private static CompositeType settingsType() {
    try {
      return new CompositeType(
          "dev.tanwei.integration.OperationSettings",
          "Bounded operation settings",
          new String[] {"enabled", "labels", "threshold"},
          new String[] {"Enabled", "Labels", "Threshold"},
          new OpenType<?>[] {
            SimpleType.BOOLEAN,
            new ArrayType<String[]>(1, SimpleType.STRING),
            SimpleType.LONG
          });
    } catch (OpenDataException exception) {
      throw new ExceptionInInitializerError(exception);
    }
  }
}
