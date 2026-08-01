package dev.tanwei.integration;

import javax.management.openmbean.CompositeData;

public interface IntegrationControlMBean {
  String getMode();

  void setMode(String mode);

  CompositeData getSettings();

  void setSettings(CompositeData settings);

  String ping(String value);

  int retainHeapProbes(int count);
}
