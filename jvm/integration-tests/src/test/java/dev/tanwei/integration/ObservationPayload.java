package dev.tanwei.integration;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class ObservationPayload {
  private String apiToken = "never-return-this-secret";
  private final Map<String, Object> attributes =
      new LinkedHashMap<String, Object>();
  private final ObservationDetail detail = new ObservationDetail();
  private String displayName = "checkout-worker";
  private final int[] samples = new int[] {3, 5, 8};
  private final ObservationPayload self = this;
  private final List<String> tags = Arrays.asList("checkout", "priority");
  int sequence;

  ObservationPayload() {
    attributes.put("region", "us-west");
    attributes.put("apiToken", "never-return-this-secret");
    attributes.put("sequence", Integer.valueOf(0));
  }

  void update(long value) {
    sequence = (int) (value & 0x7fffffffL);
    attributes.put("sequence", Integer.valueOf(sequence));
    detail.healthy = value % 2L == 0L;
    samples[0] = sequence;
  }
}

final class ObservationDetail {
  boolean healthy = true;
  private String region = "us-west";
}

final class ObservationResult {
  int lastSequence;
  private final ObservationPayload payload;
  private String status = "accepted";

  ObservationResult(ObservationPayload payload) {
    this.payload = payload;
  }
}
