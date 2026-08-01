package dev.tanwei.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

final class TracePathFilter {
  static final int MAXIMUM_RULES = 16;
  private static final int MAXIMUM_RULE_LENGTH = 512;
  private static final int MAXIMUM_TEXT_LENGTH = 8_192;

  private final List<Rule> includeRules;
  private final List<Rule> excludeRules;
  private final String includeRulesText;
  private final String excludeRulesText;

  private TracePathFilter(List<Rule> includeRules, List<Rule> excludeRules) {
    this.includeRules = Collections.unmodifiableList(includeRules);
    this.excludeRules = Collections.unmodifiableList(excludeRules);
    this.includeRulesText = canonicalText(includeRules);
    this.excludeRulesText = canonicalText(excludeRules);
  }

  static TracePathFilter parse(
      String includeRulesText, String excludeRulesText, String scopePrefix) {
    List<Rule> includes = parseRules(includeRulesText, "includeRules");
    List<Rule> excludes = parseRules(excludeRulesText, "excludeRules");
    validateScope(includes, scopePrefix, "includeRules");
    validateScope(excludes, scopePrefix, "excludeRules");
    return new TracePathFilter(includes, excludes);
  }

  boolean matches(String className, String methodName) {
    boolean included =
        includeRules.isEmpty() || matchesAny(includeRules, className, methodName);
    return included && !matchesAny(excludeRules, className, methodName);
  }

  String getIncludeRulesText() {
    return includeRulesText;
  }

  String getExcludeRulesText() {
    return excludeRulesText;
  }

  private static List<Rule> parseRules(String text, String fieldName) {
    String safeText = text == null ? "" : text;
    if (safeText.length() > MAXIMUM_TEXT_LENGTH || safeText.indexOf('\r') >= 0) {
      throw new IllegalArgumentException(
          fieldName + " must be at most " + MAXIMUM_TEXT_LENGTH + " characters");
    }
    Set<String> canonicalRules = new LinkedHashSet<String>();
    List<Rule> rules = new ArrayList<Rule>();
    for (String line : safeText.split("\\n", -1)) {
      String trimmed = line.trim();
      if (trimmed.isEmpty()) {
        continue;
      }
      Rule rule = Rule.parse(trimmed, fieldName);
      if (!canonicalRules.add(rule.canonical)) {
        continue;
      }
      if (rules.size() >= MAXIMUM_RULES) {
        throw new IllegalArgumentException(
            fieldName + " supports at most " + MAXIMUM_RULES + " rules");
      }
      rules.add(rule);
    }
    return rules;
  }

  private static void validateScope(
      List<Rule> rules, String scopePrefix, String fieldName) {
    if (scopePrefix == null || scopePrefix.isEmpty()) {
      throw new IllegalArgumentException("Trace scope is required");
    }
    for (Rule rule : rules) {
      if (!rule.target.equals(scopePrefix)
          && !rule.target.startsWith(scopePrefix + ".")) {
        throw new IllegalArgumentException(
            fieldName + " contains a path outside the Trace package scope");
      }
    }
  }

  private static boolean matchesAny(
      List<Rule> rules, String className, String methodName) {
    for (Rule rule : rules) {
      if (rule.matches(className, methodName)) {
        return true;
      }
    }
    return false;
  }

  private static String canonicalText(List<Rule> rules) {
    List<String> values = new ArrayList<String>(rules.size());
    for (Rule rule : rules) {
      values.add(rule.canonical);
    }
    return String.join("\n", values);
  }

  private static boolean isQualifiedName(String value) {
    if (value.indexOf('.') < 1) {
      return false;
    }
    String[] segments = value.split("\\.", -1);
    for (String segment : segments) {
      if (segment.isEmpty()
          || !Character.isJavaIdentifierStart(segment.charAt(0))) {
        return false;
      }
      for (int index = 1; index < segment.length(); index++) {
        if (!Character.isJavaIdentifierPart(segment.charAt(index))) {
          return false;
        }
      }
    }
    return true;
  }

  private static boolean isIdentifier(String value) {
    if (value.isEmpty() || !Character.isJavaIdentifierStart(value.charAt(0))) {
      return false;
    }
    for (int index = 1; index < value.length(); index++) {
      if (!Character.isJavaIdentifierPart(value.charAt(index))) {
        return false;
      }
    }
    return true;
  }

  private static final class Rule {
    private final String target;
    private final boolean packagePrefix;
    private final String methodName;
    private final String canonical;

    private Rule(
        String target,
        boolean packagePrefix,
        String methodName,
        String canonical) {
      this.target = target;
      this.packagePrefix = packagePrefix;
      this.methodName = methodName;
      this.canonical = canonical;
    }

    private static Rule parse(String value, String fieldName) {
      if (value.length() > MAXIMUM_RULE_LENGTH) {
        throw new IllegalArgumentException(
            fieldName
                + " rules must be at most "
                + MAXIMUM_RULE_LENGTH
                + " characters");
      }
      int separator = value.indexOf('#');
      if (separator != value.lastIndexOf('#')) {
        throw invalidRule(fieldName);
      }
      String path = separator < 0 ? value : value.substring(0, separator);
      String method = separator < 0 ? "" : value.substring(separator + 1);
      boolean packagePrefix = path.endsWith(".*");
      String target =
          packagePrefix ? path.substring(0, path.length() - 2) : path;
      if (!isQualifiedName(target)
          || path.indexOf('*') != (packagePrefix ? path.length() - 1 : -1)
          || (separator >= 0 && (packagePrefix || !isIdentifier(method)))) {
        throw invalidRule(fieldName);
      }
      String canonical =
          target
              + (packagePrefix ? ".*" : "")
              + (method.isEmpty() ? "" : "#" + method);
      return new Rule(target, packagePrefix, method, canonical);
    }

    private boolean matches(String className, String method) {
      boolean classMatches =
          packagePrefix
              ? className.startsWith(target + ".")
              : className.equals(target);
      return classMatches
          && (methodName.isEmpty() || methodName.equals(method));
    }

    private static IllegalArgumentException invalidRule(String fieldName) {
      return new IllegalArgumentException(
          fieldName
              + " rules must use package.*, fully.qualified.Class or fully.qualified.Class#method");
    }
  }
}
