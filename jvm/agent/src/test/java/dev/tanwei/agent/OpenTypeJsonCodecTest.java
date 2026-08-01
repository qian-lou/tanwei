package dev.tanwei.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import javax.management.openmbean.CompositeData;
import javax.management.openmbean.CompositeType;
import javax.management.openmbean.OpenDataException;
import javax.management.openmbean.OpenType;
import javax.management.openmbean.SimpleType;
import javax.management.openmbean.TabularData;
import javax.management.openmbean.TabularType;
import org.junit.jupiter.api.Test;

final class OpenTypeJsonCodecTest {
  private static final CompositeType ROW_TYPE = rowType();
  private static final TabularType TABLE_TYPE = tableType();

  @Test
  void roundTripsTabularRowsInStableIndexOrder() throws Exception {
    String input =
        "[{\"name\":\"beta\",\"weight\":2},"
            + "{\"name\":\"alpha\",\"weight\":1}]";

    Object decoded = OpenTypeJsonCodec.decode(input, TABLE_TYPE);

    assertTrue(decoded instanceof TabularData);
    assertEquals(
        "[{\"name\":\"alpha\",\"weight\":1},"
            + "{\"name\":\"beta\",\"weight\":2}]",
        OpenTypeJsonCodec.encode(decoded, TABLE_TYPE));
    assertTrue(OpenTypeJsonCodec.schema(TABLE_TYPE).startsWith("table<object{"));
  }

  @Test
  void rejectsDuplicateTabularIndexesAndUnknownCompositeItems() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            OpenTypeJsonCodec.decode(
                "[{\"name\":\"same\",\"weight\":1},"
                    + "{\"name\":\"same\",\"weight\":2}]",
                TABLE_TYPE));
    assertThrows(
        IllegalArgumentException.class,
        () ->
            OpenTypeJsonCodec.decode(
                "{\"name\":\"alpha\",\"weight\":1,\"extra\":true}",
                ROW_TYPE));
  }

  @Test
  void rejectsExcessiveJsonNestingBeforeMaterializingValues() {
    assertThrows(
        IllegalArgumentException.class,
        () ->
            OpenTypeJsonCodec.decode(
                "[[[[[[[[[\"value\"]]]]]]]]]", SimpleType.STRING));
  }

  @Test
  void decodesExactCompositeSimpleTypes() throws Exception {
    CompositeData value =
        (CompositeData)
            OpenTypeJsonCodec.decode(
                "{\"name\":\"alpha\",\"weight\":7}", ROW_TYPE);

    assertEquals("alpha", value.get("name"));
    assertEquals(Integer.valueOf(7), value.get("weight"));
  }

  private static CompositeType rowType() {
    try {
      return new CompositeType(
          "dev.tanwei.test.Row",
          "Tabular row",
          new String[] {"name", "weight"},
          new String[] {"Name", "Weight"},
          new OpenType<?>[] {SimpleType.STRING, SimpleType.INTEGER});
    } catch (OpenDataException exception) {
      throw new ExceptionInInitializerError(exception);
    }
  }

  private static TabularType tableType() {
    try {
      return new TabularType(
          "dev.tanwei.test.Table", "Bounded table", ROW_TYPE, new String[] {"name"});
    } catch (OpenDataException exception) {
      throw new ExceptionInInitializerError(exception);
    }
  }
}
