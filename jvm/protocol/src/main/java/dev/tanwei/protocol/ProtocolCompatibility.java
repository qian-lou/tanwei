package dev.tanwei.protocol;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class ProtocolCompatibility {
  public static final String CURRENT_VERSION = BuildMetadata.PROTOCOL_VERSION;

  private static final Pattern VERSION_PATTERN =
      Pattern.compile("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");

  private ProtocolCompatibility() {}

  public static boolean isCompatible(String clientVersion, String agentVersion) {
    return compatibilityError(clientVersion, agentVersion) == null;
  }

  public static String compatibilityError(String clientVersion, String agentVersion) {
    if (clientVersion == null
        || clientVersion.trim().isEmpty()
        || agentVersion == null
        || agentVersion.trim().isEmpty()) {
      return "PROTOCOL_VERSION_MISSING";
    }
    Integer clientMajor = major(clientVersion);
    Integer agentMajor = major(agentVersion);
    if (clientMajor == null || agentMajor == null) {
      return "PROTOCOL_VERSION_INVALID";
    }
    return clientMajor.equals(agentMajor) ? null : "PROTOCOL_INCOMPATIBLE";
  }

  private static Integer major(String version) {
    if (version == null) {
      return null;
    }
    Matcher matcher = VERSION_PATTERN.matcher(version);
    if (!matcher.matches()) {
      return null;
    }
    try {
      return Integer.valueOf(matcher.group(1));
    } catch (NumberFormatException ignored) {
      return null;
    }
  }
}
