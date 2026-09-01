/**
 * Minimal WebDAV helpers: multistatus parsing and request bodies,
 * built on fast-xml-parser. Namespace prefixes are stripped so lookups
 * work regardless of the prefixes the server chose.
 */

import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  trimValues: true,
  // Nextcloud DAV responses embed vCard/iCalendar data with numeric entities
  // (e.g. &#13; for CR). fast-xml-parser v5 only decodes numeric character
  // references when htmlEntities is enabled.
  processEntities: true,
  htmlEntities: true,
});

export type XmlNode = any;

function toArray(value: unknown): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Coerce an XML text/number node to a plain string. */
export function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? asText(value[0]) : "";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"] as string;
  }
  return "";
}

export interface DavResponse {
  /** URL-decoded path of the resource. */
  href: string;
  /** HTTP status of the response as a whole (non-propstat responses). */
  status?: string;
  /** Properties that came back with a 200 (or unspecified) propstat. */
  props: Record<string, any>;
  /** Names of properties that were reported as 404 for this resource. */
  missingProps: string[];
}

/** Parse a 207 Multi-Status body into a flat list of resources. */
export function parseMultiStatus(xml: string): DavResponse[] {
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new Error(`Failed to parse DAV XML response: ${(err as Error).message}`);
  }
  const ms = doc?.multistatus ?? doc?.["DAV:multistatus"];
  if (!ms) return [];

  const out: DavResponse[] = [];
  for (const r of toArray(ms.response)) {
    let href = asText(r.href);
    try {
      href = decodeURIComponent(href);
    } catch {
      /* keep raw href */
    }
    const props: Record<string, any> = {};
    const missingProps: string[] = [];
    let status: string | undefined = typeof r.status === "string" ? r.status : undefined;

    for (const ps of toArray(r.propstat)) {
      const st = asText(ps.status);
      const good = !st || /\b200\b/.test(st);
      const prop = ps.prop ?? {};
      for (const [key, value] of Object.entries(prop)) {
        if (good) props[key] = value;
        else missingProps.push(key);
      }
    }
    out.push({ href, status, props, missingProps });
  }
  return out;
}

/** Names inside a resourcetype property, e.g. ["collection", "calendar"]. */
export function resourceTypes(prop: unknown): string[] {
  if (!prop || typeof prop !== "object") return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(prop as Record<string, unknown>)) {
    if (key.startsWith("@")) continue;
    // e.g. resourcetype: { collection: "", calendar: "" }
    if (value !== undefined) names.push(key);
  }
  return names;
}

/** comp/@name values of a supported-calendar-component-set property. */
export function calendarComponentSet(prop: unknown): string[] {
  if (!prop || typeof prop !== "object") return [];
  const comps = toArray((prop as any).comp);
  const names: string[] = [];
  for (const c of comps) {
    const n = (c as any)?.["@name"];
    if (typeof n === "string") names.push(n.toUpperCase());
  }
  return names;
}

/** href(s) inside properties like current-user-principal or calendar-home-set. */
export function propHref(prop: unknown): string | undefined {
  if (prop === undefined || prop === null) return undefined;
  if (typeof prop === "string") return prop;
  if (Array.isArray(prop)) return propHref(prop[0]);
  const obj = prop as Record<string, unknown>;
  const href = obj.href ?? obj["DAV:href"];
  return href === undefined ? undefined : asText(href);
}

/** Privilege names granted to the current user (current-user-privilege-set). */
export function privileges(prop: unknown): string[] {
  if (!prop || typeof prop !== "object") return [];
  const privs = toArray((prop as any).privilege);
  const names: string[] = [];
  for (const p of privs) {
    if (p && typeof p === "object") {
      for (const key of Object.keys(p as Record<string, unknown>)) {
        if (!key.startsWith("@")) names.push(key);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

export function propfindBody(props: string[]): string {
  return `${XML_DECL}<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">\n  <d:prop>\n${props
    .map((p) => `    ${p}`)
    .join("\n")}\n  </d:prop>\n</d:propfind>\n`;
}

export const CALENDAR_PROPS = [
  "<d:displayname/>",
  "<d:resourcetype/>",
  "<d:getetag/>",
  "<cal:supported-calendar-component-set/>",
  "<ical:calendar-color/>",
  "<cs:getctag/>",
  "<d:current-user-privilege-set/>",
  "<oc:calendar-enabled/>",
];

export const ADDRESSBOOK_PROPS = [
  "<d:displayname/>",
  "<d:resourcetype/>",
  "<d:getetag/>",
  "<cs:getctag/>",
  "<d:current-user-privilege-set/>",
];

export const CURRENT_USER_PRINCIPAL_BODY = propfindBody(["<d:current-user-principal/>"]);

export const HOME_SETS_BODY = propfindBody([
  "<cal:calendar-home-set/>",
  "<card:addressbook-home-set/>",
]);

/**
 * calendar-query REPORT listing VEVENT or VTODO objects of a calendar.
 * from/to are ISO-8601 instants; both must be provided to filter by time.
 */
export function calendarQueryBody(component: "VEVENT" | "VTODO", from?: string, to?: string): string {
  let compFilter = `<cal:comp-filter name="${component}"/>`;
  if (from && to) {
    const start = toIcsUtc(from);
    const end = toIcsUtc(to);
    compFilter = `<cal:comp-filter name="${component}">\n          <cal:time-range start="${start}" end="${end}"/>\n        </cal:comp-filter>`;
  }
  return `${XML_DECL}<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">\n  <d:prop>\n    <d:getetag/>\n    <cal:calendar-data/>\n  </d:prop>\n  <cal:filter>\n    <cal:comp-filter name="VCALENDAR">\n        ${compFilter}\n    </cal:comp-filter>\n  </cal:filter>\n</cal:calendar-query>\n`;
}

/** addressbook-query REPORT listing vCards of an address book. */
export function addressbookQueryBody(): string {
  return `${XML_DECL}<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">\n  <d:prop>\n    <d:getetag/>\n    <card:address-data/>\n  </d:prop>\n</card:addressbook-query>\n`;
}

/** Convert an ISO-8601 datetime to the "20250101T120000Z" form used by DAV filters. */
export function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`Invalid date/time: "${iso}"`);
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}