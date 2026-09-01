import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addressbookQueryBody,
  calendarComponentSet,
  calendarQueryBody,
  privileges,
  propfindBody,
  parseMultiStatus,
  propHref,
  resourceTypes,
  toIcsUtc,
} from "../src/xml.ts";

const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/calendars/tester/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/tester/personal/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Личное</d:displayname>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <cal:supported-calendar-component-set>
          <cal:comp name="VEVENT"/>
        </cal:supported-calendar-component-set>
        <ical:calendar-color>#0a53a1</ical:calendar-color>
        <cs:getctag>3145</cs:getctag>
        <d:current-user-privilege-set>
          <d:privilege><d:read/></d:privilege>
          <d:privilege><d:write/></d:privilege>
          <d:privilege><d:write-content/></d:privilege>
        </d:current-user-privilege-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/tester/shared-read-only/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>From Alice</d:displayname>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <cal:supported-calendar-component-set>
          <cal:comp name="VEVENT"/>
          <cal:comp name="VTODO"/>
        </cal:supported-calendar-component-set>
        <d:current-user-privilege-set>
          <d:privilege><d:read/></d:privilege>
        </d:current-user-privilege-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

test("parseMultiStatus extracts resources and props", () => {
  const parsed = parseMultiStatus(MULTISTATUS);
  assert.equal(parsed.length, 3);

  assert.equal(parsed[0]?.href, "/remote.php/dav/calendars/tester/");
  assert.deepEqual(resourceTypes(parsed[0]?.props["resourcetype"]), ["collection"]);

  const personal = parsed[1];
  assert.ok(personal);
  assert.equal(personal.props["displayname"], "Личное");
  assert.deepEqual(resourceTypes(personal.props["resourcetype"]), ["collection", "calendar"]);
  assert.deepEqual(calendarComponentSet(personal.props["supported-calendar-component-set"]), ["VEVENT"]);
  assert.equal(personal.props["calendar-color"], "#0a53a1");

  const shared = parsed[2];
  assert.ok(shared);
  assert.deepEqual(calendarComponentSet(shared.props["supported-calendar-component-set"]), ["VEVENT", "VTODO"]);
});

test("principal and home-set href extraction", () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/remote.php/dav/principals/users/tester/</d:href>
    <d:propstat>
      <d:prop>
        <cal:calendar-home-set>
          <d:href>/remote.php/dav/calendars/tester/</d:href>
        </cal:calendar-home-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
  const parsed = parseMultiStatus(xml);
  const home = propHref(parsed[0]?.props["calendar-home-set"]);
  assert.equal(home, "/remote.php/dav/calendars/tester/");
});

test("current-user-principal", () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/</d:href>
    <d:propstat>
      <d:prop>
        <d:current-user-principal>
          <d:href>/remote.php/dav/principals/users/tester/</d:href>
        </d:current-user-principal>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
  const parsed = parseMultiStatus(xml);
  assert.equal(propHref(parsed[0]?.props["current-user-principal"]), "/remote.php/dav/principals/users/tester/");
});

test("privileges extraction", () => {
  const parsed = parseMultiStatus(MULTISTATUS);
  const personal = privileges(parsed[1]?.props["current-user-privilege-set"]);
  assert.ok(personal.includes("read"));
  assert.ok(personal.includes("write-content"));
  const shared = privileges(parsed[2]?.props["current-user-privilege-set"]);
  assert.deepEqual(shared, ["read"]);
});

test("request bodies contain filters and utc ranges", () => {
  const body = calendarQueryBody("VEVENT", "2025-06-01T00:00:00Z", "2025-07-01T00:00:00Z");
  assert.ok(body.includes('name="VEVENT"'));
  assert.ok(body.includes('start="20250601T000000Z"'));
  assert.ok(body.includes('end="20250701T000000Z"'));

  const noRange = calendarQueryBody("VTODO");
  assert.ok(noRange.includes('name="VTODO"'));
  assert.ok(!noRange.includes("time-range"));

  const abq = addressbookQueryBody();
  assert.ok(abq.includes("addressbook-query"));
  assert.ok(abq.includes("address-data"));

  const pf = propfindBody(["<d:displayname/>"]);
  assert.ok(pf.includes("propfind"));
});

test("numeric entities in embedded vCard data are decoded", () => {
  // Nextcloud wraps vCard/iCalendar data in XML with &#13; (CR) line endings.
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response>
    <d:href>/remote.php/dav/addressbooks/users/u/-/x.vcf</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>&quot;abc&quot;</d:getetag>
        <card:address-data>BEGIN:VCARD&#13;\nVERSION:3.0&#13;\nFN:Test&#13;\nEND:VCARD&#13;\n</card:address-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
  const parsed = parseMultiStatus(xml);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.props["getetag"], '"abc"');
  const data = parsed[0]?.props["address-data"];
  assert.equal(typeof data, "string");
  assert.ok(String(data).startsWith("BEGIN:VCARD\r"), `unexpected address-data: ${JSON.stringify(data)}`);
});

test("toIcsUtc formats instants", () => {
  assert.equal(toIcsUtc("2025-06-01T12:00:00Z"), "20250601T120000Z");
  assert.equal(toIcsUtc("2025-06-01T15:00:00+03:00"), "20250601T120000Z");
  assert.throws(() => toIcsUtc("bogus"));
});