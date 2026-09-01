/**
 * CalDAV layer: calendars, events (VEVENT) and tasks (VTODO).
 */

import { NextcloudClient } from "./client.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import {
  buildEventIcs,
  buildTodoIcs,
  parseVEvent,
  parseVTodo,
  serializeCalendar,
  updateEventComponent,
  updateTodoComponent,
  type EventInput,
  type IcsDateTime,
  type ParsedEvent,
  type ParsedTodo,
  type TodoInput,
} from "./ics.ts";
import { parseMime, type MimeComponent } from "./mime.ts";

export interface CalendarInfo {
  /** DAV path of the collection, with trailing slash. */
  path: string;
  name: string;
  color?: string;
  /** Components this calendar accepts, e.g. ["VEVENT", "VTODO"]. */
  components: string[];
  readOnly: boolean;
}

export interface DavObject {
  /** DAV path of the object. */
  path: string;
  etag?: string;
  ics: string;
  calendarPath: string;
}

function safeFilename(uid: string): string {
  return uid.replace(/[^A-Za-z0-9._@-]/g, "_");
}

/** URL-decoded last path segment of a DAV collection path. */
function lastSegment(pathOrUrl: string): string {
  const clean = pathOrUrl.replace(/\/+$/, "");
  const seg = clean.slice(clean.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function extractUid(ics: string): string {
  const m = /(?:^|\r?\n)UID:([^\r\n]+)/.exec(ics);
  const uid = m?.[1];
  if (!uid) throw new Error("Internal error: generated ICS has no UID");
  return uid.trim();
}

export class CalDavApi {
  private readonly client: NextcloudClient;

  constructor(client: NextcloudClient) {
    this.client = client;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return this.client.listCalendars();
  }

  async listEvents(
    opts: { calendar?: string; from?: string; to?: string; search?: string; limit?: number } = {},
  ): Promise<Array<DavObject & { event: ParsedEvent }>> {
    const calendars = await this.resolveCalendars("VEVENT", opts.calendar);
    const objects = await this.client.listCalendarObjects(
      calendars.map((c) => c.path),
      "VEVENT",
      { from: opts.from, to: opts.to },
    );
    let items: Array<DavObject & { event: ParsedEvent }> = [];
    for (const obj of objects) {
      const event = parseVEvent(parseMime(obj.ics));
      if (!event) continue;
      items.push({ ...obj, event });
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      items = items.filter(
        (i) =>
          i.event.summary.toLowerCase().includes(q) ||
          i.event.description.toLowerCase().includes(q) ||
          i.event.location.toLowerCase().includes(q),
      );
    }
    items.sort((a, b) => (a.event.start?.iso ?? "9999").localeCompare(b.event.start?.iso ?? "9999"));
    if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit);
    return items;
  }

  async listTasks(
    opts: { calendar?: string; includeCompleted?: boolean; search?: string; limit?: number } = {},
  ): Promise<Array<DavObject & { todo: ParsedTodo }>> {
    const calendars = await this.resolveCalendars("VTODO", opts.calendar);
    const objects = await this.client.listCalendarObjects(
      calendars.map((c) => c.path),
      "VTODO",
    );
    let items: Array<DavObject & { todo: ParsedTodo }> = [];
    for (const obj of objects) {
      const todo = parseVTodo(parseMime(obj.ics));
      if (!todo) continue;
      items.push({ ...obj, todo });
    }
    if (!opts.includeCompleted) items = items.filter((i) => !i.todo.completed);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      items = items.filter(
        (i) => i.todo.summary.toLowerCase().includes(q) || i.todo.description.toLowerCase().includes(q),
      );
    }
    items.sort((a, b) => {
      const ad = a.todo.due?.iso ?? "9999";
      const bd = b.todo.due?.iso ?? "9999";
      return ad.localeCompare(bd);
    });
    if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit);
    return items;
  }

  async getEvent(calendar: string, uid: string): Promise<DavObject & { event: ParsedEvent }> {
    const { object, components } = await this.getObjectByUid(calendar, uid, "VEVENT");
    const event = parseVEvent(components);
    if (!event) throw new Error(`Object ${uid} does not contain a VEVENT`);
    return { ...object, event };
  }

  async getTask(calendar: string, uid: string): Promise<DavObject & { todo: ParsedTodo }> {
    const { object, components } = await this.getObjectByUid(calendar, uid, "VTODO");
    const todo = parseVTodo(components);
    if (!todo) throw new Error(`Object ${uid} does not contain a VTODO`);
    return { ...object, todo };
  }

  async createEvent(input: {
    calendar: string;
    summary: string;
    start: IcsDateTime;
    end?: IcsDateTime;
    description?: string;
    location?: string;
    categories?: string[];
  }): Promise<{ event: ParsedEvent; path: string }> {
    const calendars = await this.resolveCalendars("VEVENT", input.calendar, { writableOnly: true });
    const calendar = calendars[0];
    if (!calendar) throw new NotFoundError("No event calendar available", 404);
    const calendarPath = calendar.path;
    const ics = buildEventIcs({
      summary: input.summary,
      start: input.start,
      end: input.end,
      description: input.description,
      location: input.location,
      categories: input.categories,
    });
    const uid = extractUid(ics);
    const path = `${calendarPath}${safeFilename(uid)}.ics`;
    await this.client.putObject(path, ics, "text/calendar; charset=utf-8");
    const event = parseVEvent(parseMime(ics));
    if (!event) throw new Error("Internal error: created ICS does not parse");
    return { event, path };
  }

  async createTask(input: {
    calendar: string;
  } & TodoInput): Promise<{ todo: ParsedTodo; path: string }> {
    const calendars = await this.resolveCalendars("VTODO", input.calendar, { writableOnly: true });
    const calendar = calendars[0];
    if (!calendar) throw new NotFoundError("No task calendar available", 404);
    const calendarPath = calendar.path;
    const ics = buildTodoIcs({
      summary: input.summary,
      due: input.due,
      start: input.start,
      description: input.description,
      priority: input.priority,
      status: input.status,
      percentComplete: input.percentComplete,
    });
    const uid = extractUid(ics);
    const path = `${calendarPath}${safeFilename(uid)}.ics`;
    await this.client.putObject(path, ics, "text/calendar; charset=utf-8");
    const todo = parseVTodo(parseMime(ics));
    if (!todo) throw new Error("Internal error: generated ICS has no VTODO");
    return { todo, path };
  }

  async updateEvent(
    calendar: string,
    uid: string,
    changes: Partial<EventInput>,
  ): Promise<{ event: ParsedEvent; path: string }> {
    const { object, components } = await this.getObjectByUid(calendar, uid, "VEVENT");
    updateEventComponent(components, changes);
    const ics = serializeCalendar(components);
    await this.client.putObject(object.path, ics, "text/calendar; charset=utf-8", object.etag);
    const event = parseVEvent(parseMime(ics));
    if (!event) throw new Error("Internal error: updated object has no VEVENT");
    return { event, path: object.path };
  }

  async updateTask(
    calendar: string,
    uid: string,
    changes: Partial<TodoInput> & { completed?: boolean; clearDue?: boolean },
  ): Promise<{ todo: ParsedTodo; path: string }> {
    const { object, components } = await this.getObjectByUid(calendar, uid, "VTODO");
    updateTodoComponent(components, changes);
    const ics = serializeCalendar(components);
    await this.client.putObject(object.path, ics, "text/calendar; charset=utf-8", object.etag);
    const todo = parseVTodo(parseMime(ics));
    if (!todo) throw new Error("Internal error: updated object has no VTODO");
    return { todo, path: object.path };
  }

  async deleteObject(calendar: string, uid: string, component: "VEVENT" | "VTODO"): Promise<void> {
    const { object } = await this.getObjectByUid(calendar, uid, component);
    await this.client.deleteObject(object.path, object.etag);
  }

  // -------------------------------------------------------------------------

  private async resolveCalendars(
    component: "VEVENT" | "VTODO",
    selector?: string,
    opts: { writableOnly?: boolean } = {},
  ): Promise<CalendarInfo[]> {
    const all = await this.listCalendars();
    let matching = all.filter((c) => c.components.length === 0 || c.components.includes(component));
    if (opts.writableOnly) matching = matching.filter((c) => !c.readOnly);

    if (selector && selector.trim() !== "") {
      const sel = selector.trim();
      const byName = matching.filter(
        (c) => c.name.toLowerCase() === sel.toLowerCase() || c.path === sel || lastSegment(c.path) === sel,
      );
      const byNameFirst = byName[0];
      if (byNameFirst) return [byNameFirst];
      const bySuffix = matching.filter((c) => lastSegment(c.path) === sel);
      if (bySuffix.length === 1) {
        const only = bySuffix[0];
        if (only) return [only];
      }
      if (bySuffix.length > 1) {
        throw new ValidationError(
          `Calendar selector "${selector}" is ambiguous: ${bySuffix.map((c) => c.name).join(", ")}`,
        );
      }
      const available = all.map((c) => `${c.name} (${c.components.join("/")})`).join(", ");
      throw new NotFoundError(
        `Calendar "${sel}" not found (needs a calendar accepting ${component}). Available: ${available || "none"}`,
        404,
      );
    }

    if (matching.length === 0) {
      throw new NotFoundError(`No writable calendar accepting ${component} was found on the server`, 404);
    }
    return matching;
  }

  /** Fetch a calendar object by UID: try <uid>.ics first, then scan. */
  private async getObjectByUid(
    calendar: string,
    uid: string,
    component: "VEVENT" | "VTODO",
  ): Promise<{ object: DavObject; components: MimeComponent[] }> {
    if (!uid || uid.trim() === "") throw new ValidationError("uid is required");
    const trimmedUid = uid.trim();
    const calendars = await this.resolveCalendars(component, calendar);
    const tried: string[] = [];

    // Fast path: Nextcloud stores objects it created as <uid>.ics.
    for (const cal of calendars) {
      if (cal.readOnly) continue;
      const guess = `${cal.path}${safeFilename(trimmedUid)}.ics`;
      try {
        const { etag, data } = await this.client.getObject(guess);
        const components = parseMime(data);
        const prop = component === "VEVENT" ? parseVEvent(components) : parseVTodo(components);
        if (prop && (!prop.uid || prop.uid === trimmedUid)) {
          return { object: { path: guess, etag, ics: data, calendarPath: cal.path }, components };
        }
        tried.push(guess);
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        tried.push(guess);
      }
    }

    // Fallback: scan and match by UID.
    const objects = await this.client.listCalendarObjects(calendars.map((c) => c.path), component);
    for (const obj of objects) {
      const components = parseMime(obj.ics);
      const prop = component === "VEVENT" ? parseVEvent(components) : parseVTodo(components);
      if (prop?.uid === trimmedUid) {
        return {
          object: { path: obj.path, etag: obj.etag, ics: obj.ics, calendarPath: obj.calendarPath },
          components,
        };
      }
    }
    throw new NotFoundError(
      `${component} with uid "${trimmedUid}" not found${tried.length ? ` (tried: ${tried.join(", ")})` : ""}`,
      404,
    );
  }
}