package dev.tanwei.integration;

import javax.management.openmbean.ArrayType;
import javax.management.openmbean.CompositeData;
import javax.management.openmbean.CompositeDataSupport;
import javax.management.openmbean.CompositeType;
import javax.management.openmbean.OpenDataException;
import javax.management.openmbean.OpenType;
import javax.management.openmbean.SimpleType;

public final class IntegrationControl implements IntegrationControlMBean {
  private static final CompositeType SETTINGS_TYPE = settingsType();
  private volatile String mode = "before";
  private volatile CompositeData settings =
      settings(true, new String[] {"baseline"}, 7L);

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
  public String ping(String value) {
    return "pong:" + value;
  }

  @Override
  public int retainHeapProbes(int count) {
    return HeapProbe.retainGrowth(count);
  }

  private static CompositeType settingsType() {
    try {
      return new CompositeType(
          "dev.tanwei.integration.Settings",
          "Bounded integration settings",
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
