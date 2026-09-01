/**
 * Tool registration for the Nextcloud extension.
 * Each tool talks to exactly one API: Notes (REST), Calendar/Tasks (CalDAV)
 * and Contacts (CardDAV).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { configMissingHint, loadConfig } from "./config.ts";
import { NextcloudClient } from "./client.ts";
import { NotesApi, type Note } from "./notes.ts";
import { CalDavApi, type CalendarInfo } from "./caldav.ts";
import { CardDavApi } from "./carddav.ts";
import { formatIcsDateTime, parseUserDateTime, type IcsDateTime } from "./ics.ts";
import { contactSummary } from "./vcard.ts";
import { ValidationError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Client plumbing
// ---------------------------------------------------------------------------

let cachedClient: NextcloudClient | undefined;
let cachedKey = "";

/** Build (and cache) the API client from configuration. */
export function getNextcloudClient(): NextcloudClient {
  const loaded = loadConfig();
  if (!loaded) throw new Error(configMissingHint());
  const key = `${loaded.config.baseUrl}|${loaded.config.username}|${loaded.config.password}`;
  if (!cachedClient || cachedKey !== key) {
    cachedClient = new NextcloudClient(loaded.config);
    cachedKey = key;
  }
  return cachedClient;
}

/** Test hook: inject a client (used by unit tests against a local server). */
export function setNextcloudClientForTests(client: NextcloudClient | undefined): void {
  cachedClient = client;
  cachedKey = client ? `test-${Date.now()}` : "";
}

function notesApi(): NotesApi {
  return new NotesApi(getNextcloudClient());
}
function caldavApi(): CalDavApi {
  return new CalDavApi(getNextcloudClient());
}
function carddavApi(): CardDavApi {
  return new CardDavApi(getNextcloudClient());
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

interface ToolOutput {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function ok(text: string, details: Record<string, unknown> = {}): ToolOutput {
  return { content: [{ type: "text", text }], details };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function formatUnixTime(seconds: number | undefined): string | undefined {
  if (!seconds) return undefined;
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function parseOptionalDt(value: string | undefined, field: string): IcsDateTime | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    return parseUserDateTime(value);
  } catch (err) {
    throw new ValidationError(`${field}: ${(err as Error).message}`);
  }
}

function noteLine(note: Note): string {
  const bits = [
    `#${note.id}`,
    `"${note.title}"`,
    note.category ? `category: ${note.category}` : "",
    note.favorite ? "★ favorite" : "",
    `modified: ${formatUnixTime(note.modified)}`,
    note.content !== undefined ? ` — ${truncate(note.content, 160)}` : "",
  ].filter(Boolean);
  return bits.join(" · ");
}

function calendarSummary(cal: CalendarInfo): string {
  const comps = cal.components.filter((c) => c === "VEVENT" || c === "VTODO");
  const kind = comps.includes("VEVENT") && comps.includes("VTODO")
    ? "events+tasks"
    : comps.includes("VTODO")
      ? "tasks"
      : "events";
  return `${cal.name} [${kind}]${cal.readOnly ? " (read-only)" : ""}${cal.color ? ` color: ${cal.color}` : ""}`;
}

const TASK_STATUSES = ["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"] as const;

// ---------------------------------------------------------------------------
// Notes tools
// ---------------------------------------------------------------------------

export function registerNotesTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nc_notes_list",
    label: "Nextcloud Notes: List",
    description:
      "List notes from the configured Nextcloud Notes app. Returns id, title, category, favorite and modification time; full content only when include_content is true. Use before reading or editing notes.",
    promptSnippet: "List Nextcloud notes (metadata; full content only with include_content)",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Substring to match against note titles and content" })),
      category: Type.Optional(
        Type.String({ description: 'Only notes in this category (folder). Empty string "" = uncategorized.' }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of notes to return (default 50)" })),
      include_content: Type.Optional(
        Type.Boolean({ description: "Include full note content in the list (default: false)" }),
      ),
    }),
    async execute(_id, params) {
      const notes = await notesApi().list({
        search: params.query,
        category: params.category,
        limit: params.limit ?? 50,
        includeContent: params.include_content,
      });
      const lines = notes.length
        ? notes.map(noteLine)
        : ["No notes found."];
      return ok(lines.join("\n"), { count: notes.length, notes: notes.map((n) => ({ id: n.id, title: n.title, category: n.category, modified: n.modified, favorite: n.favorite })) });
    },
  });

  pi.registerTool({
    name: "nc_notes_get",
    label: "Nextcloud Notes: Get",
    description: "Read a single note by id, including its full content.",
    promptSnippet: "Read one Nextcloud note by id",
    parameters: Type.Object({
      id: Type.Number({ description: "Note id (from nc_notes_list)" }),
    }),
    async execute(_id, params) {
      const note = await notesApi().get(params.id);
      return ok(
        `# ${note.title}\ncategory: ${note.category || "(none)"}\nfavorite: ${note.favorite}\nmodified: ${formatUnixTime(note.modified)}\n\n${note.content ?? ""}`,
        { note },
      );
    },
  });

  pi.registerTool({
    name: "nc_notes_create",
    label: "Nextcloud Notes: Create",
    description:
      "Create a new note. Content is Markdown text. Category maps to a folder; sub-categories use slashes like 'Projects/Nextcloud'.",
    promptSnippet: "Create a Nextcloud note (title, markdown content, category)",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Note title (used as file name)" })),
      content: Type.Optional(Type.String({ description: "Note content, Markdown" })),
      category: Type.Optional(Type.String({ description: "Category/folder; sub-folders with '/'" })),
      favorite: Type.Optional(Type.Boolean({ description: "Mark as favorite" })),
    }),
    async execute(_id, params) {
      if (params.title === undefined && params.content === undefined) {
        throw new ValidationError("Provide at least a title or content");
      }
      const note = await notesApi().create(params);
      return ok(`Created note #${note.id}: "${note.title}"${note.category ? ` (category: ${note.category})` : ""}`, { note });
    },
  });

  pi.registerTool({
    name: "nc_notes_update",
    label: "Nextcloud Notes: Update",
    description:
      "Update an existing note. Only provided fields change. Use nc_notes_get first to avoid overwriting content unintentionally.",
    promptSnippet: "Update a Nextcloud note by id (title, content, category, favorite)",
    parameters: Type.Object({
      id: Type.Number({ description: "Note id" }),
      title: Type.Optional(Type.String()),
      content: Type.Optional(Type.String({ description: "Full replacement content" })),
      category: Type.Optional(Type.String()),
      favorite: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      const { id, ...fields } = params;
      const note = await notesApi().update(id, fields);
      return ok(`Updated note #${note.id}: "${note.title}"`, { note });
    },
  });

  pi.registerTool({
    name: "nc_notes_delete",
    label: "Nextcloud Notes: Delete",
    description: "Permanently delete a note by id. This cannot be undone.",
    promptSnippet: "Delete a Nextcloud note by id",
    parameters: Type.Object({
      id: Type.Number({ description: "Note id to delete" }),
    }),
    async execute(_id, params) {
      await notesApi().delete(params.id);
      return ok(`Deleted note #${params.id}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Calendar tools
// ---------------------------------------------------------------------------

export function registerCalendarTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nc_calendars_list",
    label: "Nextcloud Calendars: List",
    description:
      "List CalDAV calendars with their supported components (events and/or tasks), colors and read-only state. Use this to discover valid calendar names.",
    promptSnippet: "List Nextcloud CalDAV calendars (names, colors, event/task support)",
    parameters: Type.Object({}),
    async execute() {
      const calendars = await caldavApi().listCalendars();
      const lines = calendars.length
        ? calendars.map((c) => `${c.name}${c.readOnly ? " (read-only)" : ""} [${c.components.join(", ") || "any"}]${c.color ? ` ${c.color}` : ""}`)
        : ["No calendars found."];
      return ok(lines.join("\n"), { calendars });
    },
  });

  pi.registerTool({
    name: "nc_events_list",
    label: "Nextcloud Events: List",
    description:
      "List calendar events (VEVENT) via CalDAV. Optionally filter by calendar name, time range (ISO 8601 instants) and a search string. Recurring events are returned as their master event with an rrule field.",
    promptSnippet: "List Nextcloud calendar events with optional calendar/time-range/search filters",
    parameters: Type.Object({
      calendar: Type.Optional(Type.String({ description: "Calendar name (from nc_calendars_list). Omit to search all event calendars." })),
      from: Type.Optional(Type.String({ description: "Range start, ISO 8601, e.g. 2025-06-01T00:00:00Z" })),
      to: Type.Optional(Type.String({ description: "Range end, ISO 8601" })),
      query: Type.Optional(Type.String({ description: "Search in summary, description, location" })),
      limit: Type.Optional(Type.Number({ description: "Max events to return (default 50)" })),
    }),
    async execute(_id, params) {
      if ((params.from && !params.to) || (!params.from && params.to)) {
        throw new ValidationError("Provide both from and to for a time range, or neither");
      }
      const items = await caldavApi().listEvents({
        calendar: params.calendar,
        from: params.from,
        to: params.to,
        search: params.query,
        limit: params.limit ?? 100,
      });
      const lines = items.length
        ? items.map(
            (i) =>
              `${i.event.start ? formatIcsDateTime(i.event.start) : "(no start)"} — "${i.event.summary}"${i.event.location ? ` @ ${i.event.location}` : ""} · uid: ${i.event.uid}${i.event.rrule ? " · recurring" : ""}${i.event.allDay ? " · all-day" : ""}`,
          )
        : ["No events found."];
      return ok(lines.join("\n"), {
        count: items.length,
        events: items.map((i) => ({ ...i.event, calendar: i.calendarPath, path: i.path })),
      });
    },
  });

  pi.registerTool({
    name: "nc_events_get",
    label: "Nextcloud Events: Get",
    description: "Get full details of a single event by uid, including the raw iCalendar data.",
    promptSnippet: "Read one Nextcloud calendar event (parsed fields + raw ICS)",
    parameters: Type.Object({
      calendar: Type.String({ description: "Calendar name (from nc_calendars_list)" }),
      uid: Type.String({ description: "Event uid (from nc_events_list)" }),
    }),
    async execute(_id, params) {
      const item = await caldavApi().getEvent(params.calendar, params.uid);
      const e = item.event;
      return ok(
        [
          `Summary: ${e.summary}`,
          `Start: ${formatIcsDateTime(e.start)}${e.allDay ? " (all-day)" : ""}`,
          `End: ${formatIcsDateTime(e.end) ?? e.duration ?? "(not set)"}`,
          e.location ? `Location: ${e.location}` : "",
          e.description ? `Description:\n${e.description}` : "",
          e.status ? `Status: ${e.status}` : "",
          e.categories.length ? `Categories: ${e.categories.join(", ")}` : "",
          e.rrule ? `Recurrence: ${e.rrule}` : "",
          `Path: ${item.path}`,
          "",
          "Raw ICS:",
          item.ics,
        ]
          .filter((s) => s !== "")
          .join("\n"),
        { event: e, path: item.path },
      );
    },
  });

  pi.registerTool({
    name: "nc_events_create",
    label: "Nextcloud Events: Create",
    description:
      'Create a calendar event. start/end accept "YYYY-MM-DD" (all-day), "YYYY-MM-DDTHH:MM:SS" (floating local time) or ISO instants with Z/offset. For all-day events end date is exclusive (the day the event ends on + 1 day if you want a single day: omit end).',
    promptSnippet: "Create a Nextcloud calendar event (summary, start, optional end/description/location)",
    parameters: Type.Object({
      calendar: Type.String({ description: "Calendar name (from nc_calendars_list)" }),
      summary: Type.String({ description: "Event title" }),
      start: Type.String({ description: "Start date/time (ISO 8601; plain date = all-day)" }),
      end: Type.Optional(Type.String({ description: "End date/time; for all-day events an exclusive date" })),
      all_day: Type.Optional(
        Type.Boolean({ description: "Force all-day (date-only) event; truncates start/end to dates" }),
      ),
      description: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      let start = parseOptionalDt(params.start, "start");
      let end = parseOptionalDt(params.end, "end");
      if (params.all_day) {
        start = start ? { kind: "date", iso: start.iso.slice(0, 10) } : undefined;
        end = end ? { kind: "date", iso: end.iso.slice(0, 10) } : undefined;
      }
      if (!start) throw new ValidationError("start is required");
      if (end && start.kind === "utc" && end.kind === "utc") {
        const startDate = new Date(start.iso);
        const endDate = new Date(end.iso);
        if (endDate.getTime() < startDate.getTime()) {
          throw new ValidationError("end must not be before start");
        }
      }
      const { event, path } = await caldavApi().createEvent({
        calendar: params.calendar,
        summary: params.summary,
        start,
        end,
        description: params.description,
        location: params.location,
        categories: params.category ? [params.category] : undefined,
      });
      return ok(
        `Created event "${event.summary}" on ${formatIcsDateTime(event.start)} (uid: ${event.uid})`,
        { event, path },
      );
    },
  });

  pi.registerTool({
    name: "nc_events_update",
    label: "Nextcloud Events: Update",
    description:
      "Update an existing event. Only provided fields change. Pass description or location as empty string to clear them.",
    promptSnippet: "Update a Nextcloud calendar event by uid",
    parameters: Type.Object({
      calendar: Type.String({ description: "Calendar name" }),
      uid: Type.String({ description: "Event uid" }),
      summary: Type.Optional(Type.String()),
      start: Type.Optional(Type.String({ description: "Start date/time (ISO 8601)" })),
      end: Type.Optional(Type.String({ description: "End date/time (ISO 8601)" })),
      all_day: Type.Optional(Type.Boolean({ description: "Convert to all-day (truncates start/end to dates)" })),
      description: Type.Optional(Type.String({ description: "New description; empty string clears" })),
      location: Type.Optional(Type.String({ description: "New location; empty string clears" })),
      category: Type.Optional(Type.String({ description: "Replaces categories with this one" })),
    }),
    async execute(_id, params) {
      let start = parseOptionalDt(params.start, "start");
      let end = parseOptionalDt(params.end, "end");
      if (params.all_day) {
        start = start ? { kind: "date", iso: start.iso.slice(0, 10) } : start;
        end = end ? { kind: "date", iso: end.iso.slice(0, 10) } : end;
      }
      const { event, path } = await caldavApi().updateEvent(params.calendar, params.uid, {
        summary: params.summary,
        start,
        end,
        description: params.description,
        location: params.location,
        categories: params.category ? [params.category] : undefined,
      });
      return ok(`Updated event "${event.summary}" (uid: ${event.uid})`, { event, path });
    },
  });

  pi.registerTool({
    name: "nc_events_delete",
    label: "Nextcloud Events: Delete",
    description: "Delete a calendar event by uid. The server moves it to the calendar trashbin.",
    promptSnippet: "Delete a Nextcloud calendar event by uid",
    parameters: Type.Object({
      calendar: Type.String({ description: "Calendar name" }),
      uid: Type.String({ description: "Event uid" }),
    }),
    async execute(_id, params) {
      await caldavApi().deleteObject(params.calendar, params.uid, "VEVENT");
      return ok(`Deleted event ${params.uid}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Task tools
// ---------------------------------------------------------------------------

const TASK_STATUS_ENUM = ["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"];

export function registerTaskTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nc_tasks_list",
    label: "Nextcloud Tasks: List",
    description:
      "List tasks (CalDAV VTODO) sorted by due date. Completed tasks are hidden unless include_completed is true. Use nc_calendars_list to see task calendars.",
    promptSnippet: "List Nextcloud tasks (VTODO) with optional calendar/search filters",
    parameters: Type.Object({
      calendar: Type.Optional(Type.String({ description: "Calendar name (from nc_calendars_list); omit for all task calendars" })),
      include_completed: Type.Optional(Type.Boolean({ description: "Include completed tasks (default false)" })),
      query: Type.Optional(Type.String({ description: "Search in summary and description" })),
      limit: Type.Optional(Type.Number({ description: "Max tasks to return (default 100)" })),
    }),
    async execute(_id, params) {
      const items = await caldavApi().listTasks({
        calendar: params.calendar,
        includeCompleted: params.include_completed,
        search: params.query,
        limit: params.limit ?? 100,
      });
      const lines = items.length
        ? items.map((i) => {
            const t = i.todo;
            const due = t.due ? `due: ${formatIcsDateTime(t.due)}` : "no due date";
            const status = t.completed ? "done" : t.status;
            const prio = t.priority !== undefined && t.priority > 0 ? ` · priority ${t.priority}` : "";
            return `[${status}] "${t.summary}" · ${due}${prio} · uid: ${t.uid}`;
          })
        : ["No tasks found."];
      return ok(lines.join("\n"), {
        count: items.length,
        tasks: items.map((i) => ({ ...i.todo, calendar: i.calendarPath, path: i.path })),
      });
    },
  });

  pi.registerTool({
    name: "nc_tasks_get",
    label: "Nextcloud Tasks: Get",
    description: "Get full details of a task by uid, including the raw iCalendar data.",
    promptSnippet: "Read one Nextcloud task (parsed fields + raw ICS)",
    parameters: Type.Object({
      calendar: Type.String({ description: "Calendar name" }),
      uid: Type.String({ description: "Task uid" }),
    }),
    async execute(_id, params) {
      const item = await caldavApi().getTask(params.calendar, params.uid);
      const t = item.todo;
      return ok(
        [
          `Summary: ${t.summary}`,
          `Status: ${t.status}${t.completed ? " (completed)" : ""}`,
          t.due ? `Due: ${formatIcsDateTime(t.due)}` : "",
          t.start ? `Start: ${formatIcsDateTime(t.start)}` : "",
          t.percentComplete !== undefined ? `Percent complete: ${t.percentComplete}%` : "",
          t.priority !== undefined && t.priority > 0 ? `Priority: ${t.priority}` : "",
          t.description ? `Description:\n${t.description}` : "",
          t.parentUid ? `Parent: ${t.parentUid}` : "",
          `Path: ${item.path}`,
          "",
          "Raw ICS:",
          item.ics,
        ]
          .filter((s) => s !== "")
          .join("\n"),
        { task: t, path: item.path },
      );
    },
  });

  pi.registerTool({
    name: "nc_tasks_create",
    label: "Nextcloud Tasks: Create",
    description:
      'Create a task (VTODO). due/start accept "YYYY-MM-DD" (all-day), "YYYY-MM-DDTHH:MM:SS" (floating) or ISO instants with Z/offset. priority: 0 none, 1 highest .. 9 lowest.',
    promptSnippet: "Create a Nextcloud task (summary, due date, description, priority)",
    parameters: Type.Object({
      calendar: Type.String({ description: "Calendar name (from nc_calendars_list)" }),
      summary: Type.String({ description: "Task title" }),
      due: Type.Optional(Type.String({ description: "Due date/time" })),
      start: Type.Optional(Type.String({ description: "Start date/time" })),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Number({ description: "0 (none) .. 1 (highest) .. 9 (lowest)" })),
      status: Type.Optional(
        Type.String({ description: `Initial status: ${TASK_STATUS_ENUM.join(" | ")} (default NEEDS-ACTION)` }),
      ),
      percent_complete: Type.Optional(Type.Number({ description: "0-100" })),
    }),
    async execute(_id, params) {
      if (params.status && !TASK_STATUS_ENUM.includes(params.status)) {
        throw new ValidationError(`status must be one of ${TASK_STATUS_ENUM.join(", ")}`);
      }
      const { todo, path } = await caldavApi().createTask({
        calendar: params.calendar,
        summary: params.summary,
        due: parseOptionalDt(params.due, "due"),
        start: parseOptionalDt(params.start, "start"),
        description: params.description,
        priority: params.priority,
        status: params.status,
        percentComplete: params.percent_complete,
      });
      return ok(
        `Created task "${todo.summary}"${todo.due ? ` (due ${formatIcsDateTime(todo.due)})` : ""} (uid: ${todo.uid})`,
        { todo, path },
      );
    },
  });

  pi.registerTool({
    name: "nc_tasks_update",
    label: "Nextcloud Tasks: Update",
    description:
      'Update a task. completed: true marks done (sets STATUS/COMPLETED), false reopens. Pass due as empty string "" to remove the due date.',
    promptSnippet: "Update a Nextcloud task (summary, due, status, completed flag, priority)",
    parameters: Type.Object({
      calendar: Type.String({ description: "Calendar name" }),
      uid: Type.String({ description: "Task uid" }),
      summary: Type.Optional(Type.String()),
      due: Type.Optional(Type.String({ description: 'New due date/time, or "" to clear' })),
      start: Type.Optional(Type.String()),
      description: Type.Optional(Type.String({ description: "New description; empty string clears" })),
      priority: Type.Optional(Type.Number({ description: "0-9" })),
      status: Type.Optional(Type.String({ description: TASK_STATUS_ENUM.join(" | ") })),
      percent_complete: Type.Optional(Type.Number({ description: "0-100" })),
      completed: Type.Optional(Type.Boolean({ description: "Mark task completed (true) or reopen (false)" })),
    }),
    async execute(_id, params) {
      if (params.status && !TASK_STATUS_ENUM.includes(params.status)) {
        throw new ValidationError(`status must be one of ${TASK_STATUS_ENUM.join(", ")}`);
      }
      const { todo, path } = await caldavApi().updateTask(params.calendar, params.uid, {
        summary: params.summary,
        due: params.due !== undefined ? (params.due === "" ? undefined : parseOptionalDt(params.due, "due")) : undefined,
        clearDue: params.due === "",
        start: parseOptionalDt(params.start, "start"),
        description: params.description,
        priority: params.priority,
        status: params.status,
        percentComplete: params.percent_complete,
        completed: params.completed,
      });
      return ok(`Updated task "${todo.summary}" (uid: ${todo.uid}, status: ${todo.status})`, { todo, path });
    },
  });

  pi.registerTool({
    name: "nc_tasks_delete",
    label: "Nextcloud Tasks: Delete",
    description: "Delete a task by uid. The server moves it to the calendar trashbin.",
    promptSnippet: "Delete a Nextcloud task by uid",
    parameters: Type.Object({
      calendar: Type.String({ description: "Calendar name" }),
      uid: Type.String({ description: "Task uid" }),
    }),
    async execute(_id, params) {
      await caldavApi().deleteObject(params.calendar, params.uid, "VTODO");
      return ok(`Deleted task ${params.uid}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Contact tools
// ---------------------------------------------------------------------------

const CONTACT_FIELD_PARAMS = {
  emails: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Emails, each "value" or "label:value" with label like home/work, e.g. "work:jane@example.com"',
    }),
  ),
  phones: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Phones, each "value" or "label:value" with label like cell/home/work/fax',
    }),
  ),
  urls: Type.Optional(Type.Array(Type.String(), { description: 'URLs, each "value" or "label:value"' })),
};

export function registerContactTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nc_addressbooks_list",
    label: "Nextcloud Address Books: List",
    description: "List CardDAV address books with names and read-only state.",
    promptSnippet: "List Nextcloud address books (CardDAV)",
    parameters: Type.Object({}),
    async execute() {
      const books = await carddavApi().listAddressbooks();
      const lines = books.length
        ? books.map((b) => `${b.name}${b.readOnly ? " (read-only)" : ""}`)
        : ["No address books found."];
      return ok(lines.join("\n"), { addressbooks: books });
    },
  });

  pi.registerTool({
    name: "nc_contacts_list",
    label: "Nextcloud Contacts: List",
    description:
      "List contacts from one or all address books. The search matches name, nickname, organization, emails and phones.",
    promptSnippet: "List/search Nextcloud contacts (name, emails, phones)",
    parameters: Type.Object({
      addressbook: Type.Optional(Type.String({ description: "Address book name (from nc_addressbooks_list); omit for all" })),
      query: Type.Optional(Type.String({ description: "Search string" })),
      limit: Type.Optional(Type.Number({ description: "Max contacts to return (default 100)" })),
    }),
    async execute(_id, params) {
      const items = await carddavApi().listContacts({
        addressbook: params.addressbook,
        search: params.query,
        limit: params.limit ?? 100,
      });
      const lines = items.length
        ? items.map((i) => {
            const c = i.contact;
            const email = c.emails[0]?.value ? ` · ${c.emails[0].value}` : "";
            const phone = c.phones[0]?.value ? ` · ${c.phones[0].value}` : "";
            const org = c.organization ? ` · ${c.organization}` : "";
            return `${c.fullName || "(no name)"}${org}${email}${phone} · uid: ${c.uid}`;
          })
        : ["No contacts found."];
      return ok(lines.join("\n"), { count: items.length, contacts: items.map((i) => ({ ...contactSummary(i.contact), path: i.path })) });
    },
  });

  pi.registerTool({
    name: "nc_contacts_get",
    label: "Nextcloud Contacts: Get",
    description: "Get all fields of a contact by uid, including the raw vCard.",
    promptSnippet: "Read one Nextcloud contact (all fields + raw vCard)",
    parameters: Type.Object({
      addressbook: Type.String({ description: "Address book name" }),
      uid: Type.String({ description: "Contact uid (from nc_contacts_list)" }),
    }),
    async execute(_id, params) {
      const { contact, path } = await carddavApi().getContact(params.addressbook, params.uid);
      return ok(
        [
          `Name: ${contact.fullName || "(none)"}`,
          contact.nickname ? `Nickname: ${contact.nickname}` : "",
          contact.organization ? `Organization: ${contact.organization}` : "",
          contact.title ? `Title: ${contact.title}` : "",
          contact.emails.length
            ? `Emails:\n${contact.emails.map((e) => `  ${e.type ? `[${e.type}] ` : ""}${e.value}`).join("\n")}`
            : "",
          contact.phones.length
            ? `Phones:\n${contact.phones.map((p) => `  ${p.type ? `[${p.type}] ` : ""}${p.value}`).join("\n")}`
            : "",
          contact.urls.length ? `URLs: ${contact.urls.map((u) => u.value).join(", ")}` : "",
          contact.note ? `Note: ${contact.note}` : "",
          `Path: ${path}`,
          "",
          "Raw vCard:",
          contact.raw,
        ]
          .filter((s) => s !== "")
          .join("\n"),
        { contact },
      );
    },
  });

  pi.registerTool({
    name: "nc_contacts_create",
    label: "Nextcloud Contacts: Create",
    description:
      "Create a contact. Name fields and at least one contact field should be provided; FN is derived automatically if omitted.",
    promptSnippet: "Create a Nextcloud contact (name, emails, phones, organization)",
    parameters: Type.Object({
      addressbook: Type.String({ description: "Address book name (from nc_addressbooks_list)" }),
      first_name: Type.Optional(Type.String()),
      last_name: Type.Optional(Type.String()),
      full_name: Type.Optional(Type.String({ description: "Override for the display name (FN)" })),
      nickname: Type.Optional(Type.String()),
      organization: Type.Optional(Type.String()),
      title: Type.Optional(Type.String({ description: "Job title" })),
      note: Type.Optional(Type.String()),
      ...CONTACT_FIELD_PARAMS,
      categories: Type.Optional(Type.Array(Type.String(), { description: "Group labels" })),
    }),
    async execute(_id, params) {
      const fields = contactInputFromParams(params);
      if (Object.keys(fields).length === 0) {
        throw new ValidationError("Provide at least one contact field");
      }
      const created = await carddavApi().createContact({ addressbook: params.addressbook, fields });
      return ok(
        `Created contact "${created.contact.fullName}" (uid: ${created.uid})`,
        { contact: contactSummary(created.contact), path: created.path },
      );
    },
  });

  pi.registerTool({
    name: "nc_contacts_update",
    label: "Nextcloud Contacts: Update",
    description:
      "Update an existing contact. Name parts merge; emails/phones/urls lists REPLACE all existing entries when provided. Pass an empty array to remove them.",
    promptSnippet: "Update a Nextcloud contact by uid",
    parameters: Type.Object({
      addressbook: Type.String({ description: "Address book name" }),
      uid: Type.String({ description: "Contact uid" }),
      first_name: Type.Optional(Type.String()),
      last_name: Type.Optional(Type.String()),
      full_name: Type.Optional(Type.String()),
      nickname: Type.Optional(Type.String()),
      organization: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      note: Type.Optional(Type.String({ description: "New note; empty string clears" })),
      ...CONTACT_FIELD_PARAMS,
      categories: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      const fields = contactInputFromParams(params);
      if (Object.keys(fields).length === 0) {
        throw new ValidationError("Provide at least one field to update");
      }
      const updated = await carddavApi().updateContact({ addressbook: params.addressbook, uid: params.uid, fields });
      return ok(
        `Updated contact "${updated.contact.fullName}" (uid: ${updated.contact.uid})`,
        { contact: contactSummary(updated.contact), path: updated.path },
      );
    },
  });

  pi.registerTool({
    name: "nc_contacts_delete",
    label: "Nextcloud Contacts: Delete",
    description: "Delete a contact by uid. This cannot be undone.",
    promptSnippet: "Delete a Nextcloud contact by uid",
    parameters: Type.Object({
      addressbook: Type.String({ description: "Address book name" }),
      uid: Type.String({ description: "Contact uid" }),
    }),
    async execute(_id, params) {
      await carddavApi().deleteContact(params.addressbook, params.uid);
      return ok(`Deleted contact ${params.uid}`);
    },
  });
}

function contactInputFromParams(params: {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  nickname?: string;
  organization?: string;
  title?: string;
  note?: string;
  emails?: string[];
  phones?: string[];
  urls?: string[];
  categories?: string[];
}): Record<string, unknown> {
  const fields = CardDavApi.fieldsFromInput({
    emails: params.emails,
    phones: params.phones,
    urls: params.urls,
  });
  const out: Record<string, unknown> = { ...fields };
  if (params.first_name !== undefined) out.firstName = params.first_name;
  if (params.last_name !== undefined) out.lastName = params.last_name;
  if (params.full_name !== undefined) out.fullName = params.full_name;
  if (params.nickname !== undefined) out.nickname = params.nickname;
  if (params.organization !== undefined) out.organization = params.organization;
  if (params.title !== undefined) out.title = params.title;
  if (params.note !== undefined) out.note = params.note;
  if (params.categories !== undefined) out.categories = params.categories;
  return out;
}

// ---------------------------------------------------------------------------

export function registerAllTools(pi: ExtensionAPI): void {
  registerNotesTools(pi);
  registerCalendarTools(pi);
  registerTaskTools(pi);
  registerContactTools(pi);
}