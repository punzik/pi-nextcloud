import { test } from "node:test";
import assert from "node:assert/strict";

import {
  escapeTextValue,
  foldLine,
  parseContentLine,
  parseMime,
  serializeMime,
  structuredValue,
  unescapeTextValue,
  setProp,
  removeProps,
  textValue,
} from "../src/mime.ts";

test("parseContentLine handles plain property", () => {
  const p = parseContentLine("SUMMARY:Hello world");
  assert.ok(p);
  assert.equal(p.name, "SUMMARY");
  assert.equal(p.value, "Hello world".replace("world", "world"));
  assert.equal(p.value, "Hello world");
  assert.deepEqual(p.params, {});
});

test("parseContentLine handles parameters with quotes", () => {
  const p = parseContentLine('DTSTART;TZID=Europe/Berlin:20250601T120000');
  assert.ok(p);
  assert.equal(p.params.TZID, "Europe/Berlin");
  assert.equal(p.value, "20250601T120000");
});

test("parseContentLine ignores colon inside quoted params", () => {
  const p = parseContentLine('ATTENDEE;CN="Doe; John":mailto:john@example.com');
  assert.ok(p);
  assert.equal(p.value, "mailto:john@example.com");
  assert.equal(p.params.CN, "Doe; John");
});

test("unfold and parse iCalendar tree", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "SUMMARY:Line one",
    "  continued",
    "DESCRIPTION:a\\nb",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const comps = parseMime(ics);
  assert.equal(comps.length, 1);
  assert.equal(comps[0]?.type, "VCALENDAR");
  const event = comps[0]?.children[0];
  assert.ok(event);
  assert.equal(event.type, "VEVENT");
  assert.equal(textValue(event, "SUMMARY"), "Line one continued");
  assert.equal(textValue(event, "DESCRIPTION"), "a\nb");
});

test("escape and unescape text values", () => {
  const raw = "back\\slash, comma; semi\nnewline";
  const escaped = escapeTextValue(raw);
  assert.equal(escaped, "back\\\\slash\\, comma\\; semi\\nnewline");
  assert.equal(unescapeTextValue(escaped), raw);
});

test("foldLine folds long lines at 75 octets and round-trips", () => {
  const long = "DESCRIPTION:" + "x".repeat(200);
  const folded = foldLine(long);
  for (const line of folded.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  }
  const refolded = folded.replace(/\r\n[ \t]/g, "");
  assert.equal(refolded, long);
});

test("foldLine keeps multibyte characters intact", () => {
  const text = "SUMMARY:" + "ёжик".repeat(40);
  const folded = foldLine(text);
  for (const line of folded.split("\r\n")) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 75);
  }
  const unfolded = folded.replace(/\r\n[ \t]/g, "");
  assert.equal(unfolded, text);
});

test("serialize and re-parse preserves components", () => {
  const doc = [
    {
      type: "VCALENDAR",
      props: [
        { name: "VERSION", params: {}, value: "2.0" },
        { name: "PRODID", params: {}, value: "-//test//EN" },
      ],
      children: [
        {
          type: "VEVENT",
          props: [
            { name: "UID", params: {}, value: "abc-123" },
            { name: "SUMMARY", params: {}, value: "Test; with, special\\chars" },
            { name: "DTSTART", params: { VALUE: "DATE" }, value: "20250601" },
          ],
          children: [],
        },
      ],
    },
  ];
  const wire = serializeMime(doc as any);
  assert.ok(wire.includes("BEGIN:VCALENDAR"));
  const reparsed = parseMime(wire);
  const reparsedEvent = reparsed[0]?.children[0];
  assert.ok(reparsedEvent);
  assert.equal(reparsedEvent.props.length, 3);
  const summary = reparsedEvent.props.find((p) => p.name === "SUMMARY");
  assert.ok(summary);
  assert.equal(unescapeTextValue(summary.value), "Test; with, special\\chars");
});

test("setProp replaces existing property", () => {
  const comp = parseMime("BEGIN:V\r\nSUMMARY:old\r\nEND:V\r\n")[0];
  assert.ok(comp);
  setProp(comp, "SUMMARY", "new");
  assert.equal(textValue(comp, "SUMMARY"), "new");
  assert.equal(comp.props.length, 1);
  removeProps(comp, "SUMMARY");
  assert.equal(textValue(comp, "SUMMARY"), "");
});

test("structuredValue splits unescaped semicolons", () => {
  assert.deepEqual(structuredValue("Doe;John;;;", 5), ["Doe", "John", "", "", ""]);
  // "\;" is an escaped semicolon: it stays inside its part, then un-escapes.
  assert.deepEqual(structuredValue("Company;Unit\\;Branch"), ["Company", "Unit;Branch"]);
});