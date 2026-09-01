/**
 * iCalendar helpers: date/time conversion and VEVENT / VTODO models.
 */

import {
  escapeTextValue,
  firstProp,
  type MimeComponent,
  removeProps,
  serializeMime,
  setProp,
  structuredValue,
  textValue,
} from "./mime.ts";

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

export type IcsDateKind = "date" | "utc" | "floating";

export interface IcsDateTime {
  kind: IcsDateKind;
  /** "date": "YYYY-MM-DD"; "utc": ISO instant ending in Z; "floating": naive local time. */
  iso: string;
  /** TZID parameter (floating times only). */
  tzid?: string;
}

/** "20250601T120000Z" -> "2025-06-01T12:00:00Z" */
function basicToIsoInstant(v: string): string {
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`;
}

/** "20250601" -> "2025-06-01" */
function basicToIsoDate(v: string): string {
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

/** Parse an ICS date or date-time value; null when the format is unknown. */
export function parseIcsDateTime(value: string, params?: Record<string, string>): IcsDateTime | null {
  const v = value.trim();
  if (/^\d{8}T\d{6}Z$/.test(v)) return { kind: "utc", iso: basicToIsoInstant(v) };
  if (/^\d{8}T\d{6}$/.test(v)) {
    const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}`;
    return { kind: "floating", iso, tzid: params?.TZID };
  }
  if (/^\d{8}$/.test(v)) return { kind: "date", iso: basicToIsoDate(v) };
  return null;
}


/** Serialize an IcsDateTime to ICS value + params. */
export function icsDateTimeToProps(dt: IcsDateTime): { value: string; params?: Record<string, string> } {
  if (dt.kind === "date") return { value: dt.iso.replace(/-/g, ""), params: { VALUE: "DATE" } };
  if (dt.kind === "utc") return { value: dt.iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "") };
  const value = dt.iso.replace(/[-:]/g, "");
  return dt.tzid ? { value, params: { TZID: dt.tzid } } : { value };
}

/**
 * Parse a user-supplied date/time string:
 *   "2025-06-01"              -> all-day date
 *   "2025-06-01T12:00:00Z"    -> absolute instant (normalized to UTC)
 *   "2025-06-01T12:00:00+03"  -> absolute instant (normalized to UTC)
 *   "2025-06-01T12:00:00"     -> floating (kept as local wall time)
 */
export function parseUserDateTime(input: string): IcsDateTime {
  let s = input.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { kind: "date", iso: s };
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) throw new Error(`Invalid date/time: "${input}"`);
    return { kind: "utc", iso: d.toISOString().replace(/\.\d{3}/, "") };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    if (s.length === 16) s += ":00";
    return { kind: "floating", iso: s };
  }
  throw new Error(
    `Invalid date/time: "${input}". Use "YYYY-MM-DD", "YYYY-MM-DDTHH:MM:SS", or an ISO instant with Z/offset.`,
  );
}

/** Human-friendly representation for tool output. */
export function formatIcsDateTime(dt: IcsDateTime | undefined | null): string | undefined {
  if (!dt) return undefined;
  if (dt.kind === "date") return dt.iso;
  if (dt.kind === "utc") return dt.iso;
  return dt.tzid ? `${dt.iso} (${dt.tzid})` : `${dt.iso} (floating)`;
}

function nowUtcBasic(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ---------------------------------------------------------------------------
// Parsing VEVENT / VTODO
// ---------------------------------------------------------------------------

export interface ParsedEvent {
  uid: string;
  summary: string;
  allDay: boolean;
  start?: IcsDateTime;
  end?: IcsDateTime;
  duration?: string;
  location: string;
  description: string;
  status: string;
  categories: string[];
  organizer: string;
  rrule?: string;
  lastModified?: IcsDateTime;
}

export interface ParsedTodo {
  uid: string;
  summary: string;
  status: string;
  completed: boolean;
  due?: IcsDateTime;
  start?: IcsDateTime;
  completedAt?: IcsDateTime;
  percentComplete?: number;
  priority?: number;
  description: string;
  location: string;
  categories: string[];
  parentUid?: string;
  rrule?: string;
  lastModified?: IcsDateTime;
}

function findComponent(components: MimeComponent[], type: string): MimeComponent | undefined {
  for (const c of components) {
    if (c.type === type) return c;
    const nested = findComponent(c.children, type);
    if (nested) return nested;
  }
  return undefined;
}


export function parseVEvent(components: MimeComponent[]): ParsedEvent | null {
  const comp = findComponent(components, "VEVENT");
  if (!comp) return null;
  const startDate = optionalProp(firstProp(comp, "DTSTART"));
  const organizerProp = firstProp(comp, "ORGANIZER");
  const categoriesProp = firstProp(comp, "CATEGORIES");
  return {
    uid: textValue(comp, "UID"),
    summary: textValue(comp, "SUMMARY"),
    allDay: startDate?.kind === "date",
    start: startDate,
    end: optionalProp(firstProp(comp, "DTEND")),
    duration: firstProp(comp, "DURATION")?.value,
    location: textValue(comp, "LOCATION"),
    description: textValue(comp, "DESCRIPTION"),
    status: textValue(comp, "STATUS") || "CONFIRMED",
    categories: categoriesProp ? structuredValue(categoriesProp.value).filter(Boolean) : [],
    organizer: organizerProp?.value ?? "",
    rrule: firstProp(comp, "RRULE")?.value,
    lastModified: optionalProp(firstProp(comp, "LAST-MODIFIED")),
  };
}

function optionalProp(
  prop: { value: string; params: Record<string, string> } | undefined,
): IcsDateTime | undefined {
  return prop ? (parseIcsDateTime(prop.value, prop.params) ?? undefined) : undefined;
}

export function parseVTodo(components: MimeComponent[]): ParsedTodo | null {
  const comp = findComponent(components, "VTODO");
  if (!comp) return null;
  const status = textValue(comp, "STATUS") || "NEEDS-ACTION";
  const completedProp = firstProp(comp, "COMPLETED");
  const percentProp = firstProp(comp, "PERCENT-COMPLETE");
  const priorityProp = firstProp(comp, "PRIORITY");
  const categoriesProp = firstProp(comp, "CATEGORIES");
  return {
    uid: textValue(comp, "UID"),
    summary: textValue(comp, "SUMMARY"),
    status,
    completed: status === "COMPLETED" || Boolean(completedProp),
    due: optionalProp(firstProp(comp, "DUE")),
    start: optionalProp(firstProp(comp, "DTSTART")),
    completedAt: optionalProp(completedProp),
    percentComplete: percentProp ? (parseInt(percentProp.value, 10) || 0) : undefined,
    priority: priorityProp ? parseInt(priorityProp.value, 10) || 0 : undefined,
    description: textValue(comp, "DESCRIPTION"),
    location: textValue(comp, "LOCATION"),
    categories: categoriesProp ? structuredValue(categoriesProp.value).filter(Boolean) : [],
    parentUid: textValue(comp, "RELATED-TO") || undefined,
    rrule: firstProp(comp, "RRULE")?.value,
    lastModified: optionalProp(firstProp(comp, "LAST-MODIFIED")),
  };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function newCalendar(children: MimeComponent[]): MimeComponent {
  return {
    type: "VCALENDAR",
    props: [
      { name: "VERSION", params: {}, value: "2.0" },
      { name: "PRODID", params: {}, value: "-//pi-nextcloud//Pi Nextcloud Extension//EN" },
      { name: "CALSCALE", params: {}, value: "GREGORIAN" },
    ],
    children,
  };
}

function generateUid(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}@pi-nextcloud`;
}

/** Wire-format value for a user-supplied date/time. */
function userDtToPropValue(dt: IcsDateTime): { value: string; params?: Record<string, string> } {
  return icsDateTimeToProps(dt);
}

export interface EventInput {
  summary: string;
  start: IcsDateTime;
  end?: IcsDateTime;
  description?: string;
  location?: string;
  categories?: string[];
  uid?: string;
}

export function buildEventIcs(input: EventInput): string {
  const event: MimeComponent = { type: "VEVENT", props: [], children: [] };
  const uid = input.uid ?? generateUid();
  const startProp = userDtToPropValue(input.start);
  setProp(event, "UID", uid);
  setProp(event, "DTSTAMP", nowUtcBasic());
  setProp(event, "CREATED", nowUtcBasic());
  setProp(event, "DTSTART", startProp.value, startProp.params);
  if (input.end) {
    const endProp = userDtToPropValue(input.end);
    setProp(event, "DTEND", endProp.value, endProp.params);
  }
  setProp(event, "SUMMARY", escapeTextValue(input.summary));
  if (input.description) setProp(event, "DESCRIPTION", escapeTextValue(input.description));
  if (input.location) setProp(event, "LOCATION", escapeTextValue(input.location));
  if (input.categories && input.categories.length > 0) {
    setProp(event, "CATEGORIES", input.categories.map(escapeTextValue).join(","));
  }
  setProp(event, "SEQUENCE", "0");
  return serializeMime([newCalendar([event])]);
}

export interface TodoInput {
  summary: string;
  due?: IcsDateTime;
  start?: IcsDateTime;
  description?: string;
  priority?: number;
  status?: string;
  percentComplete?: number;
  uid?: string;
}

export function buildTodoIcs(input: TodoInput): string {
  const todo: MimeComponent = { type: "VTODO", props: [], children: [] };
  const uid = input.uid ?? generateUid();
  setProp(todo, "UID", uid);
  setProp(todo, "DTSTAMP", nowUtcBasic());
  setProp(todo, "CREATED", nowUtcBasic());
  setProp(todo, "SUMMARY", escapeTextValue(input.summary));
  if (input.due) {
    const dueProp = userDtToPropValue(input.due);
    setProp(todo, "DUE", dueProp.value, dueProp.params);
  }
  if (input.start) {
    const startProp = userDtToPropValue(input.start);
    setProp(todo, "DTSTART", startProp.value, startProp.params);
  }
  if (input.description) setProp(todo, "DESCRIPTION", escapeTextValue(input.description));
  if (input.priority !== undefined) setProp(todo, "PRIORITY", String(input.priority));
  if (input.percentComplete !== undefined) setProp(todo, "PERCENT-COMPLETE", String(input.percentComplete));
  setProp(todo, "STATUS", input.status ?? "NEEDS-ACTION");
  return serializeMime([newCalendar([todo])]);
}

/**
 * Apply partial updates to the first VEVENT of a parsed calendar.
 * The tree is modified in place, so unknown properties (RRULE, VALARM, ...)
 * survive the round-trip.
 */
export function updateEventComponent(components: MimeComponent[], changes: Partial<EventInput>): void {
  const comp = findComponent(components, "VEVENT");
  if (!comp) throw new Error("No VEVENT component found in calendar object");

  if (changes.summary !== undefined) setProp(comp, "SUMMARY", escapeTextValue(changes.summary));
  if (changes.description !== undefined) {
    if (changes.description === "") removeProps(comp, "DESCRIPTION");
    else setProp(comp, "DESCRIPTION", escapeTextValue(changes.description));
  }
  if (changes.location !== undefined) {
    if (changes.location === "") removeProps(comp, "LOCATION");
    else setProp(comp, "LOCATION", escapeTextValue(changes.location));
  }
  if (changes.categories !== undefined) {
    if (changes.categories.length === 0) removeProps(comp, "CATEGORIES");
    else setProp(comp, "CATEGORIES", changes.categories.map(escapeTextValue).join(","));
  }
  if (changes.start) {
    const p = userDtToPropValue(changes.start);
    setProp(comp, "DTSTART", p.value, p.params);
  }
  if (changes.end) {
    const p = userDtToPropValue(changes.end);
    setProp(comp, "DTEND", p.value, p.params);
  }

  setProp(comp, "DTSTAMP", nowUtcBasic());
  setProp(comp, "LAST-MODIFIED", nowUtcBasic());
  const seq = firstProp(comp, "SEQUENCE");
  const seqNum = seq ? parseInt(seq.value, 10) || 0 : 0;
  setProp(comp, "SEQUENCE", String(seqNum + 1));
}

/** Apply partial updates to the first VTODO of a parsed calendar. */
export function updateTodoComponent(
  components: MimeComponent[],
  changes: Partial<TodoInput> & { completed?: boolean; clearDue?: boolean },
): void {
  const comp = findComponent(components, "VTODO");
  if (!comp) throw new Error("No VTODO component found in calendar object");

  if (changes.summary !== undefined) setProp(comp, "SUMMARY", escapeTextValue(changes.summary));
  if (changes.description !== undefined) {
    if (changes.description === "") removeProps(comp, "DESCRIPTION");
    else setProp(comp, "DESCRIPTION", escapeTextValue(changes.description));
  }
  if (changes.clearDue) {
    removeProps(comp, "DUE");
  } else if (changes.due) {
    const p = userDtToPropValue(changes.due);
    setProp(comp, "DUE", p.value, p.params);
  }
  if (changes.start) {
    const p = userDtToPropValue(changes.start);
    setProp(comp, "DTSTART", p.value, p.params);
  }
  if (changes.priority !== undefined) setProp(comp, "PRIORITY", String(changes.priority));
  if (changes.percentComplete !== undefined) setProp(comp, "PERCENT-COMPLETE", String(changes.percentComplete));
  if (changes.status !== undefined) setProp(comp, "STATUS", changes.status);
  if (changes.completed === true) {
    setProp(comp, "STATUS", "COMPLETED");
    setProp(comp, "COMPLETED", nowUtcBasic());
    if (!firstProp(comp, "PERCENT-COMPLETE")) setProp(comp, "PERCENT-COMPLETE", "100");
  } else if (changes.completed === false) {
    setProp(comp, "STATUS", "NEEDS-ACTION");
    removeProps(comp, "COMPLETED");
    removeProps(comp, "PERCENT-COMPLETE");
  }

  setProp(comp, "DTSTAMP", nowUtcBasic());
  setProp(comp, "LAST-MODIFIED", nowUtcBasic());
}

/** Re-serialize a parsed calendar back to ICS text. */
export function serializeCalendar(components: MimeComponent[]): string {
  return serializeMime(components);
}