import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEventIcs,
  buildTodoIcs,
  formatIcsDateTime,
  parseIcsDateTime,
  parseUserDateTime,
  parseVEvent,
  parseVTodo,
  serializeCalendar,
  updateEventComponent,
  updateTodoComponent,
} from "../src/ics.ts";
import { parseMime } from "../src/mime.ts";

test("parseUserDateTime: date only", () => {
  const dt = parseUserDateTime("2025-06-01");
  assert.equal(dt.kind, "date");
  assert.equal(dt.iso, "2025-06-01");
});

test("parseUserDateTime: instant with Z is normalized to UTC", () => {
  const dt = parseUserDateTime("2025-06-01T15:00:00+03:00");
  assert.equal(dt.kind, "utc");
  assert.equal(dt.iso, "2025-06-01T12:00:00Z");
});

test("parseUserDateTime: space separator", () => {
  const dt = parseUserDateTime("2025-06-01 15:00");
  assert.equal(dt.kind, "floating");
  assert.equal(dt.iso, "2025-06-01T15:00:00");
});

test("parseUserDateTime: floating naive time", () => {
  const dt = parseUserDateTime("2025-06-01T15:00:00");
  assert.equal(dt.kind, "floating");
});

test("parseUserDateTime: rejects garbage", () => {
  assert.throws(() => parseUserDateTime("not-a-date"));
});

test("parseIcsDateTime handles wire formats", () => {
  assert.deepEqual(parseIcsDateTime("20250601T120000Z"), { kind: "utc", iso: "2025-06-01T12:00:00Z" });
  assert.deepEqual(parseIcsDateTime("20250601"), { kind: "date", iso: "2025-06-01" });
  const floating = parseIcsDateTime("20250601T120000", { TZID: "Europe/Berlin" });
  assert.equal(floating?.kind, "floating");
  assert.equal(floating?.tzid, "Europe/Berlin");
  assert.equal(parseIcsDateTime("weird"), null);
});

test("buildEventIcs produces valid structure with UTC times", () => {
  const ics = buildEventIcs({
    summary: "Team sync; part 2, of 3",
    start: parseUserDateTime("2025-06-01T15:00:00+03:00"),
    end: parseUserDateTime("2025-06-01T16:00:00+03:00"),
    description: "Agenda:\n- item one",
    location: "Office, room 4",
  });
  assert.ok(ics.includes("BEGIN:VCALENDAR"));
  assert.ok(ics.includes("DTSTART:20250601T120000Z"));
  assert.ok(ics.includes("DTEND:20250601T130000Z"));
  assert.ok(ics.includes("SUMMARY:Team sync\\; part 2\\, of 3"));
  assert.ok(ics.includes("DESCRIPTION:Agenda:\\n- item one"));

  const event = parseVEvent(parseMime(ics));
  assert.ok(event);
  assert.equal(event.summary, "Team sync; part 2, of 3");
  assert.equal(event.description, "Agenda:\n- item one");
  assert.equal(event.location, "Office, room 4");
  assert.equal(event.allDay, false);
  assert.equal(event.start?.iso, "2025-06-01T12:00:00Z");
});

test("buildEventIcs all-day event uses VALUE=DATE", () => {
  const ics = buildEventIcs({
    summary: "Vacation",
    start: parseUserDateTime("2025-07-01"),
    end: parseUserDateTime("2025-07-05"),
  });
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20250701"));
  assert.ok(ics.includes("DTEND;VALUE=DATE:20250705"));
  const event = parseVEvent(parseMime(ics));
  assert.ok(event);
  assert.equal(event.allDay, true);
  assert.equal(event.start?.iso, "2025-07-01");
});

test("buildTodoIcs with due date and priority", () => {
  const ics = buildTodoIcs({
    summary: "Pay rent",
    due: parseUserDateTime("2025-06-10"),
    priority: 5,
    description: "Transfer to landlord",
  });
  assert.ok(ics.includes("DUE;VALUE=DATE:20250610"));
  assert.ok(ics.includes("PRIORITY:5"));
  assert.ok(ics.includes("STATUS:NEEDS-ACTION"));
  const todo = parseVTodo(parseMime(ics));
  assert.ok(todo);
  assert.equal(todo.due?.kind, "date");
  assert.equal(todo.priority, 5);
  assert.equal(todo.completed, false);
});

test("updateEventComponent preserves unknown props and bumps SEQUENCE", () => {
  const original = buildEventIcs({
    summary: "Original",
    start: parseUserDateTime("2025-06-01T10:00:00Z"),
    end: parseUserDateTime("2025-06-01T11:00:00Z"),
    location: "Old place",
  });
  // Inject properties a real client would have: RRULE and VALARM.
  const withExtras = original.replace(
    "END:VEVENT",
    "RRULE:FREQ=WEEKLY;BYDAY=MO\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT",
  );
  const components = parseMime(withExtras);
  updateEventComponent(components, { summary: "Renamed", location: "" });
  const ics = serializeCalendar(components);

  assert.ok(ics.includes("RRULE:FREQ=WEEKLY;BYDAY=MO"));
  assert.ok(ics.includes("BEGIN:VALARM"));
  assert.ok(ics.includes("SUMMARY:Renamed"));
  assert.ok(!ics.includes("LOCATION:"));
  assert.ok(!ics.includes("Old place"));

  const event = parseVEvent(parseMime(ics));
  assert.equal(event?.summary, "Renamed");
  assert.equal(event?.location, "");
  assert.equal(event?.rrule, "FREQ=WEEKLY;BYDAY=MO");
  const rootComp = parseMime(ics)[0];
  const seqProp = rootComp?.children[0]?.props.find((p) => p.name === "SEQUENCE");
  assert.equal(seqProp?.value, "1");
});

test("updateTodoComponent marks completed and reopens", () => {
  const original = buildTodoIcs({ summary: "Task", due: parseUserDateTime("2025-06-10") });
  const components = parseMime(original);

  updateTodoComponent(components, { completed: true });
  let ics = serializeCalendar(components);
  let todo = parseVTodo(parseMime(ics));
  assert.equal(todo?.status, "COMPLETED");
  assert.equal(todo?.completed, true);
  assert.ok(todo?.completedAt);
  assert.equal(todo?.percentComplete, 100);

  // Reopen the same (persisted) tree.
  const reopened = parseMime(ics);
  updateTodoComponent(reopened, { completed: false });
  ics = serializeCalendar(reopened);
  todo = parseVTodo(parseMime(ics));
  assert.equal(todo?.status, "NEEDS-ACTION");
  assert.equal(todo?.completed, false);
  assert.ok(!todo?.percentComplete);
});

test("updateTodoComponent clears due date", () => {
  const original = buildTodoIcs({ summary: "Task", due: parseUserDateTime("2025-06-10") });
  const components = parseMime(original);
  updateTodoComponent(components, { clearDue: true });
  const ics = serializeCalendar(components);
  assert.ok(!ics.includes("DUE:"));
  assert.ok(!ics.includes("DUE;"));
  const todo = parseVTodo(parseMime(ics));
  assert.equal(todo?.due, undefined);
});

test("formatIcsDateTime output", () => {
  assert.equal(formatIcsDateTime({ kind: "date", iso: "2025-06-01" }), "2025-06-01");
  assert.equal(formatIcsDateTime({ kind: "utc", iso: "2025-06-01T12:00:00Z" }), "2025-06-01T12:00:00Z");
  assert.equal(
    formatIcsDateTime({ kind: "floating", iso: "2025-06-01T12:00:00", tzid: "Europe/Berlin" }),
    "2025-06-01T12:00:00 (Europe/Berlin)",
  );
  assert.equal(formatIcsDateTime(undefined), undefined);
});