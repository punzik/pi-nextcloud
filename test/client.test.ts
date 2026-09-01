/**
 * Offline end-to-end test: a fake Nextcloud server on 127.0.0.1 exercises
 * NextcloudClient, CalDavApi, CardDavApi and NotesApi.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

import { NextcloudClient } from "../src/client.ts";
import { CalDavApi } from "../src/caldav.ts";
import { CardDavApi } from "../src/carddav.ts";
import { NotesApi } from "../src/notes.ts";

const USER = "tester";
const PASS = "app-password-123";

const EVENT_UID = "event-abc123@fake";
const EVENT_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:event-abc123@fake",
  "DTSTAMP:20250601T000000Z",
  "DTSTART:20250610T090000Z",
  "DTEND:20250610T100000Z",
  "SUMMARY:Standup",
  "LOCATION:Room 1",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const TODO_UID = "todo-xyz@fake";
const TODO_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTODO",
  `UID:${TODO_UID}`,
  "DTSTAMP:20250601T000000Z",
  "DUE;VALUE=DATE:20250615",
  "SUMMARY:Buy milk",
  "STATUS:NEEDS-ACTION",
  "END:VTODO",
  "END:VCALENDAR",
].join("\r\n");

const CONTACT_UID = "contact-001@fake";
const CONTACT_VCF = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  `UID:${CONTACT_UID}`,
  "N:Ivanov;Ivan;;;",
  "FN:Ivan Ivanov",
  "TEL;TYPE=CELL:+7 900 111-22-33",
  "EMAIL;TYPE=WORK:ivan@example.com",
  "REV:20250101T000000Z",
  "END:VCARD",
].join("\r\n");

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

let captured: CapturedRequest[] = [];
let server: Server | undefined;
let port = 0;

function xmlResponse(res: ServerResponse, body: string, status = 207): void {
  res.writeHead(status, { "Content-Type": "application/xml; charset=utf-8", DAV: "1, 3" });
  res.end(body);
}

function jsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startFakeServer(): Promise<number> {
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
      if (auth !== expected) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="nextcloud"' });
        res.end("unauthorized");
        return;
      }
      captured.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } as Record<string, string | undefined>, body });
      route(req, res, body);
    });
  };

  const route = (req: IncomingMessage, res: ServerResponse, body: string): void => {
    const url = req.url ?? "";
    const method = (req.method ?? "").toUpperCase();

    if (url === "/remote.php/dav/" && method === "PROPFIND") {
      return xmlResponse(res, `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/${USER}/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    }

    if (url === `/remote.php/dav/principals/users/${USER}/` && method === "PROPFIND") {
      return xmlResponse(res, `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/remote.php/dav/principals/users/${USER}/</d:href><d:propstat><d:prop>
<cal:calendar-home-set><d:href>/remote.php/dav/calendars/${USER}/</d:href></cal:calendar-home-set>
<card:addressbook-home-set><d:href>/remote.php/dav/addressbooks/users/${USER}/</d:href></card:addressbook-home-set>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    }

    if (url === `/remote.php/dav/calendars/${USER}/` && method === "PROPFIND") {
      return xmlResponse(res, `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/">
<d:response><d:href>/remote.php/dav/calendars/${USER}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/calendars/${USER}/personal/</d:href><d:propstat><d:prop>
<d:displayname>Personal</d:displayname>
<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
<cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
<ical:calendar-color>#00679e</ical:calendar-color>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/calendars/${USER}/tasks-only/</d:href><d:propstat><d:prop>
<d:displayname>Todo</d:displayname>
<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
<cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`);
    }

    if (url.startsWith(`/remote.php/dav/calendars/${USER}/personal/`) && method === "REPORT") {
      if (body.includes("VEVENT")) {
        return xmlResponse(res, `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
<d:response><d:href>/remote.php/dav/calendars/${USER}/personal/${encodeURIComponent(EVENT_UID)}.ics</d:href><d:propstat><d:prop><d:getetag>&quot;etag-event-1&quot;</d:getetag><cal:calendar-data>${EVENT_ICS.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`);
      }
      if (body.includes("VTODO")) {
        return xmlResponse(res, `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
<d:response><d:href>/remote.php/dav/calendars/${USER}/personal/${encodeURIComponent(TODO_UID)}.ics</d:href><d:propstat><d:prop><d:getetag>&quot;etag-todo-1&quot;</d:getetag><cal:calendar-data>${TODO_ICS.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`);
      }
      return xmlResponse(res, `<d:multistatus xmlns:d="DAV:"/>`);
    }

    if (url.startsWith(`/remote.php/dav/calendars/${USER}/tasks-only/`) && method === "REPORT" && body.includes("VTODO")) {
      return xmlResponse(res, `<d:multistatus xmlns:d="DAV:"/>`);
    }

    if (method === "GET" && url.endsWith(`/${encodeURIComponent(EVENT_UID)}.ics`)) {
      res.writeHead(200, { "Content-Type": "text/calendar", Etag: '"etag-event-1"' });
      res.end(EVENT_ICS);
      return;
    }
    if (method === "GET" && url.endsWith(`/${encodeURIComponent(TODO_UID)}.ics`)) {
      res.writeHead(200, { "Content-Type": "text/calendar", Etag: '"etag-todo-1"' });
      res.end(TODO_ICS);
      return;
    }

    if (method === "PUT" && url.startsWith(`/remote.php/dav/calendars/${USER}/personal/`)) {
      if (req.headers["if-match"] === '"stale-etag"') {
        res.writeHead(412);
        res.end("precondition failed");
        return;
      }
      jsonResponse(res, {}, 201);
      return;
    }
    if (method === "DELETE" && url.startsWith(`/remote.php/dav/calendars/${USER}/personal/`)) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === `/remote.php/dav/addressbooks/users/${USER}/` && method === "PROPFIND") {
      return xmlResponse(res, `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/remote.php/dav/addressbooks/users/${USER}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/addressbooks/users/${USER}/contacts/</d:href><d:propstat><d:prop>
<d:displayname>Contacts</d:displayname>
<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`);
    }

    if (url.startsWith(`/remote.php/dav/addressbooks/users/${USER}/contacts/`) && method === "REPORT") {
      return xmlResponse(res, `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
<d:response><d:href>/remote.php/dav/addressbooks/users/${USER}/contacts/${encodeURIComponent(CONTACT_UID)}.vcf</d:href><d:propstat><d:prop><d:getetag>&quot;etag-card-1&quot;</d:getetag><card:address-data>${CONTACT_VCF.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`);
    }
    if (method === "GET" && url.endsWith(`/${encodeURIComponent(CONTACT_UID)}.vcf`)) {
      res.writeHead(200, { "Content-Type": "text/vcard", Etag: '"etag-card-1"' });
      res.end(CONTACT_VCF);
      return;
    }
    if (method === "PUT" && url.startsWith(`/remote.php/dav/addressbooks/users/${USER}/contacts/`)) {
      jsonResponse(res, {}, 201);
      return;
    }
    if (method === "DELETE" && url.startsWith(`/remote.php/dav/addressbooks/users/${USER}/contacts/`)) {
      res.writeHead(204);
      res.end();
      return;
    }

    // Notes REST API
    if (url.startsWith("/index.php/apps/notes/api/v1/notes")) {
      const idMatch = /\/notes\/(\d+)/.exec(url);
      if (method === "GET" && !idMatch) {
        return jsonResponse(res, [
          {
            id: 42,
            etag: "note-etag-1",
            readonly: false,
            modified: 1750000000,
            title: "Shopping list",
            category: "Home",
            favorite: false,
            ...(url.includes("exclude=content") ? {} : { content: "milk\neggs" }),
          },
        ]);
      }
      if (method === "GET" && idMatch) {
        return jsonResponse(res, {
          id: 42,
          etag: "note-etag-1",
          readonly: false,
          modified: 1750000000,
          title: "Shopping list",
          category: "Home",
          favorite: false,
          content: "milk\neggs",
        });
      }
      if (method === "POST") {
        const parsed = JSON.parse(body);
        return jsonResponse(res, { id: 43, etag: "note-etag-2", readonly: false, modified: 1750000001, title: parsed.title ?? "New note", category: parsed.category ?? "", favorite: false, content: parsed.content ?? "" });
      }
      if (method === "PUT" && idMatch) {
        if (req.headers["if-match"] === '"stale-etag"') {
          return jsonResponse(res, { message: "note was modified" }, 412);
        }
        if (req.headers["if-match"] !== '"note-etag-1"') {
          res.writeHead(400);
          res.end(JSON.stringify({ message: "bad etag" }));
          return;
        }
        const parsed = JSON.parse(body);
        return jsonResponse(res, { id: 42, etag: "note-etag-3", readonly: false, modified: 1750000002, title: parsed.title ?? "Shopping list", category: parsed.category ?? "Home", favorite: parsed.favorite ?? false, content: parsed.content ?? "milk\neggs" });
      }
      if (method === "DELETE" && idMatch) {
        return jsonResponse(res, {});
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`no route: ${method} ${url}`);
  };

  return new Promise((resolve) => {
    server = createServer((req, res) => handle(req, res));
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      port = typeof address === "object" && address ? address.port : 0;
      resolve(port);
    });
  });
}


beforeEach(async () => {
  captured = [];
  await startFakeServer();
});

afterEach(() => {
  server?.close();
  server = undefined;
});

function makeClient(): NextcloudClient {
  return new NextcloudClient({ baseUrl: `http://127.0.0.1:${port}`, username: USER, password: PASS });
}

test("client authenticates with Basic auth", async () => {
  const client = makeClient();
  await client.listCalendars();
  const auth = captured[0]?.headers["authorization"];
  assert.equal(auth, `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`);
});

test("calendar discovery and listing", async () => {
  const client = makeClient();
  const calendars = await client.listCalendars();
  assert.equal(calendars.length, 2);
  const personal = calendars.find((c) => c.name === "Personal");
  assert.ok(personal);
  assert.deepEqual(personal.components, ["VEVENT", "VTODO"]);
  assert.equal(personal.color, "#00679e");
  // Discovery happened exactly once for principal + home set.
  assert.ok(captured.some((r) => r.url === "/remote.php/dav/"));
  const secondList = await client.listCalendars();
  assert.equal(secondList.length, 2);
  // No additional principal propfind after caching.
  const davRootCalls = captured.filter((r) => r.url === "/remote.php/dav/").length;
  assert.equal(davRootCalls, 1);
});

test("listEvents parses calendar objects", async () => {
  const caldav = new CalDavApi(makeClient());
  const events = await caldav.listEvents({ calendar: "Personal" });
  assert.equal(events.length, 1);
  const first = events[0];
  assert.ok(first);
  assert.equal(first.event.summary, "Standup");
  assert.equal(first.event.uid, EVENT_UID);
  assert.ok(first.etag);
});

test("create event PUTs generated ICS", async () => {
  const caldav = new CalDavApi(makeClient());
  const { event, path } = await caldav.createEvent({
    calendar: "Personal",
    summary: "Lunch; with Anna",
    start: { kind: "utc", iso: "2025-06-11T11:00:00Z" },
    end: { kind: "utc", iso: "2025-06-11T12:00:00Z" },
    location: "Cafe, 5th ave",
  });
  const put = captured.find((r) => r.method === "PUT");
  assert.ok(put);
  assert.ok(put.url.startsWith(`/remote.php/dav/calendars/${USER}/personal/`));
  assert.ok(put.url.endsWith(".ics"));
  assert.equal(put.headers["content-type"], "text/calendar; charset=utf-8");
  assert.ok(put.body.includes("BEGIN:VCALENDAR"));
  assert.ok(put.body.includes("SUMMARY:Lunch\\; with Anna"));
  assert.ok(put.body.includes("DTSTART:20250611T110000Z"));
  assert.ok(path.endsWith(".ics"));
  assert.equal(event.summary, "Lunch; with Anna");
});

test("getEvent uses direct GET by uid", async () => {
  const caldav = new CalDavApi(makeClient());
  const item = await caldav.getEvent("Personal", EVENT_UID);
  assert.equal(item.event.summary, "Standup");
  assert.equal(item.event.location, "Room 1");
  const get = captured.find((r) => r.method === "GET" && r.url.includes(".ics"));
  assert.ok(get);
});

test("update event sends If-Match and modified ICS", async () => {
  const caldav = new CalDavApi(makeClient());
  const { event } = await caldav.updateEvent("Personal", EVENT_UID, { summary: "Renamed standup" });
  const put = captured.find((r) => r.method === "PUT");
  assert.ok(put);
  assert.equal(put.headers["if-match"], '"etag-event-1"');
  assert.ok(put.body.includes("SUMMARY:Renamed standup"));
  assert.ok(put.body.includes("UID:event-abc123@fake"));
  assert.equal(event.summary, "Renamed standup");
});

test("delete event uses etag", async () => {
  const caldav = new CalDavApi(makeClient());
  await caldav.deleteObject("Personal", EVENT_UID, "VEVENT");
  const del = captured.find((r) => r.method === "DELETE");
  assert.ok(del);
  assert.equal(del.headers["if-match"], '"etag-event-1"');
});

test("listTasks skips completed and filters by search", async () => {
  const caldav = new CalDavApi(makeClient());
  const tasks = await caldav.listTasks({ includeCompleted: false });
  assert.equal(tasks.length, 1);
  const firstTask = tasks[0];
  assert.ok(firstTask);
  assert.equal(firstTask.todo.summary, "Buy milk");
  assert.equal(firstTask.todo.due?.kind, "date");

  const searched = await caldav.listTasks({ search: "no match" });
  assert.equal(searched.length, 0);
});

test("task complete flow sends STATUS COMPLETED", async () => {
  const caldav = new CalDavApi(makeClient());
  const { todo } = await caldav.updateTask("Personal", TODO_UID, { completed: true });
  const put = captured.find((r) => r.method === "PUT");
  assert.ok(put);
  assert.ok(put.body.includes("STATUS:COMPLETED"));
  assert.ok(put.body.includes("COMPLETED:"));
  assert.equal(todo.status, "COMPLETED");
  assert.equal(todo.percentComplete, 100);
});

test("contacts listing and creation", async () => {
  const carddav = new CardDavApi(makeClient());
  const books = await carddav.listAddressbooks();
  assert.equal(books.length, 1);
  assert.equal(books[0]?.name, "Contacts");

  const contacts = await carddav.listContacts({ search: "ivan" });
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0]?.contact.firstName, "Ivan");
  assert.equal(contacts[0]?.contact.phones[0]?.value, "+7 900 111-22-33");

  const created = await carddav.createContact({
    addressbook: "Contacts",
    fields: { firstName: "New", lastName: "Person", emails: [{ type: "WORK", value: "new@example.com" }] },
  });
  const put = captured.find((r) => r.method === "PUT" && r.url.endsWith(".vcf"));
  assert.ok(put);
  assert.ok(put.body.includes("BEGIN:VCARD"));
  assert.ok(put.body.includes("N:Person;New;;;"));
  assert.ok(put.body.includes("EMAIL;TYPE=WORK:new@example.com"));
  assert.ok(created.contact.fullName.includes("New"));
});

test("contact update merges fields and sends If-Match", async () => {
  const carddav = new CardDavApi(makeClient());
  const { contact } = await carddav.updateContact({
    addressbook: "Contacts",
    uid: CONTACT_UID,
    fields: { lastName: "Ivanov-New", phones: [{ type: "HOME", value: "+7 000 000-00-00" }] },
  });
  const put = captured.find((r) => r.method === "PUT" && r.url.endsWith(".vcf"));
  assert.ok(put);
  assert.equal(put.headers["if-match"], '"etag-card-1"');
  assert.ok(put.body.includes("N:Ivanov-New;Ivan;;;"));
  assert.ok(put.body.includes("TEL;TYPE=HOME:+7 000 000-00-00"));
  assert.ok(!put.body.includes("+7 900 111-22-33"));
  assert.equal(contact.lastName, "Ivanov-New");
});

test("delete contact", async () => {
  const carddav = new CardDavApi(makeClient());
  await carddav.deleteContact("Contacts", CONTACT_UID);
  const del = captured.find((r) => r.method === "DELETE");
  assert.ok(del);
  assert.ok(del.url.endsWith(".vcf"));
});

test("notes: list excludes content, get returns full", async () => {
  const notes = new NotesApi(makeClient());
  const list = await notes.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.title, "Shopping list");
  assert.equal(list[0]?.content, undefined);

  const note = await notes.get(42);
  assert.equal(note.content, "milk\neggs");
  assert.equal(note.category, "Home");
});

test("notes: search includes content", async () => {
  const notes = new NotesApi(makeClient());
  const hit = await notes.list({ search: "eggs" });
  assert.equal(hit.length, 1);
  const miss = await notes.list({ search: "unicorn" });
  assert.equal(miss.length, 0);
});

test("notes: create/update/delete lifecycle", async () => {
  const notes = new NotesApi(makeClient());
  const created = await notes.create({ title: "New", content: "hello" });
  assert.equal(created.id, 43);

  const updated = await notes.update(42, { title: "Renamed" });
  assert.equal(updated.title, "Renamed");
  const put = captured.find((r) => r.method === "PUT");
  assert.ok(put);
  // Notes API expects an RFC-compliant quoted entity-tag.
  assert.equal(put.headers["if-match"], '"note-etag-1"');
});

test("notes: 412 maps to validation error", async () => {
  const notes = new NotesApi(makeClient());
  await assert.rejects(
    () => notes.update(42, { title: "X" }, "stale-etag"),
    /412/,
  );
});

test("notes: delete", async () => {
  const notes = new NotesApi(makeClient());
  await notes.delete(42);
  assert.ok(captured.some((r) => r.method === "DELETE"));
});

test("bad credentials produce auth error", async () => {
  const bad = new NextcloudClient({ baseUrl: `http://127.0.0.1:${port}`, username: USER, password: "wrong" });
  await assert.rejects(() => bad.listCalendars(), /Authentication failed|401/);
});