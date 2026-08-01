package dev.tanwei.agent;

import java.util.HashMap;
import java.util.Map;

final class AgentConfiguration {
  private static final int MINIMUM_SECRET_LENGTH = 32;
  private final int port;
  private final String secret;

  private AgentConfiguration(int port, String secret) {
    this.port = port;
    this.secret = secret;
  }

  static AgentConfiguration parse(String arguments) {
    if (arguments == null || arguments.trim().isEmpty()) {
      throw new IllegalArgumentException("Agent arguments are required");
    }
    Map<String, String> values = new HashMap<String, String>(4);
    for (String token : arguments.split(";")) {
      int separator = token.indexOf('=');
      if (separator <= 0 || separator == token.length() - 1) {
        continue;
      }
      values.put(token.substring(0, separator).trim(), token.substring(separator + 1).trim());
    }

    String portValue = values.get("port");
    String secret = values.get("secret");
    if (portValue == null || secret == null) {
      throw new IllegalArgumentException("port and secret are required");
    }

    int port;
    try {
      port = Integer.parseInt(portValue);
    } catch (NumberFormatException exception) {
      throw new IllegalArgumentException("port must be an integer", exception);
    }
    if (port <= 0 || port > 65_535) {
      throw new IllegalArgumentException("port is out of range");
    }
    if (secret.length() < MINIMUM_SECRET_LENGTH) {
      throw new IllegalArgumentException("secret is too short");
    }
    return new AgentConfiguration(port, secret);
  }

  int getPort() {
    return port;
  }

  String getSecret() {
    return secret;
  }
}
