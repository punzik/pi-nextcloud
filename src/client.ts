/**
 * Nextcloud HTTP client: Basic-auth requests, OCS helpers, WebDAV plumbing
 * and DAV endpoint discovery (current-user-principal -> home sets).
 */

import {
  ADDRESSBOOK_PROPS,
  CALENDAR_PROPS,
  CURRENT_USER_PRINCIPAL_BODY,
  HOME_SETS_BODY,
  addressbookQueryBody,
  calendarComponentSet,
  calendarQueryBody,
  parseMultiStatus,
  privileges,
  propfindBody,
  propHref,
  resourceTypes,
  type DavResponse,
} from "./xml.ts";
import { AuthError, ConflictError, NextcloudError, NotFoundError } from "./errors.ts";
import type { NextcloudConfig } from "./config.ts";

const USER_AGENT = "pi-nextcloud/0.1 (Pi extension)";

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  url: string;
}

export class NextcloudClient {
  readonly baseUrl: string;
  readonly username: string;
  private readonly password: string;

  private principalPath?: string;
  private calendarHomePath?: string;
  private addressbookHomePath?: string;

  constructor(config: NextcloudConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
  }

  /** Full URL for a path (absolute path or already-full URL). */
  urlFor(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return this.baseUrl + (pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`);
  }

  /** Raw authenticated request. Never throws for HTTP error statuses. */
  async request(
    method: string,
    pathOrUrl: string,
    options: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<HttpResponse> {
    const url = this.urlFor(pathOrUrl);
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      "User-Agent": USER_AGENT,
      ...(options.body !== undefined ? { "Content-Type": options.headers?.["Content-Type"] ?? "application/xml; charset=utf-8" } : {}),
      ...options.headers,
    };
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: options.body });
    } catch (err) {
      throw new NextcloudError(`Network error talking to ${url}: ${(err as Error).message}`);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, url };
  }

  /** Normalize a DAV href returned by the server into a request path/URL. */
  davPath(href: string): string {
    if (/^https?:\/\//i.test(href)) return href;
    // Hrefs are paths from the domain root; the base URL may include a path prefix.
    const base = new URL(this.baseUrl);
    if (href.startsWith(base.pathname) && base.pathname !== "/") return href;
    return `${base.pathname.replace(/\/+$/, "")}${href}`;
  }

  /**
   * JSON request against an app REST API (Notes). Throws NextcloudError on
   * non-2xx with the server's error message when available.
   */
  async requestJson<T>(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ data: T; headers: Headers; status: number }> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    };
    const res = await this.request(method, path, {
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (res.status >= 400) throw httpError(res, `Nextcloud API request failed`);
    let data: T;
    try {
      data = res.text ? (JSON.parse(res.text) as T) : ({} as T);
    } catch {
      throw new NextcloudError(`Nextcloud API returned invalid JSON (HTTP ${res.status})`, res.status, res.url, res.text);
    }
    return { data, headers: res.headers, status: res.status };
  }

  /** PROPFIND with parsing; returns the parsed multistatus responses. */
  async propfind(path: string, body: string, depth: 0 | 1): Promise<DavResponse[]> {
    const res = await this.request("PROPFIND", path, { headers: { Depth: String(depth) }, body });
    if (res.status === 401 || res.status === 403) throw authError(res);
    if (res.status === 404) throw new NotFoundError(`DAV resource not found: ${path}`, res.status, res.url);
    if (res.status !== 207) {
      throw new NextcloudError(`PROPFIND failed (HTTP ${res.status})`, res.status, res.url, res.text.slice(0, 500));
    }
    return parseMultiStatus(res.text);
  }

  /** Generic DAV request with friendly error mapping. */
  async dav(
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: string; okStatuses?: number[] } = {},
  ): Promise<HttpResponse> {
    const res = await this.request(method, path, options);
    const ok = options.okStatuses ?? [200, 201, 204];
    if (!ok.includes(res.status)) {
      if (res.status === 401 || res.status === 403) throw authError(res);
      if (res.status === 404) throw new NotFoundError(`Not found: ${path}`, res.status, res.url);
      if (res.status === 412) {
        throw new ConflictError(
          "The object changed on the server since it was read (etag mismatch). Re-read it and try again.",
          res.status,
          res.url,
        );
      }
      if (res.status === 415) {
        throw new NextcloudError(`Server rejected the request body (HTTP 415)`, res.status, res.url, res.text.slice(0, 500));
      }
      throw new NextcloudError(
        `${method} ${path} failed (HTTP ${res.status})`,
        res.status,
        res.url,
        res.text.slice(0, 500),
      );
    }
    return res;
  }

  /**
   * REPORT for calendar/addressbook queries. Returns parsed multistatus.
   */
  async report(path: string, body: string, depth = 1): Promise<DavResponse[]> {
    const res = await this.request("REPORT", path, { headers: { Depth: String(depth) }, body });
    if (res.status === 401 || res.status === 403) throw authError(res);
    if (res.status === 404) throw new NotFoundError(`DAV collection not found: ${path}`, res.status, res.url);
    if (res.status !== 207) {
      throw new NextcloudError(`REPORT failed (HTTP ${res.status})`, res.status, res.url, res.text.slice(0, 500));
    }
    return parseMultiStatus(res.text);
  }

  /** GET a DAV object (event, task, contact). */
  async getObject(path: string): Promise<{ etag?: string; data: string }> {
    const res = await this.request("GET", path);
    if (res.status === 404) throw new NotFoundError(`Not found: ${path}`, res.status, res.url);
    if (res.status === 401 || res.status === 403) throw authError(res);
    if (res.status !== 200) {
      throw new NextcloudError(`GET ${path} failed (HTTP ${res.status})`, res.status, res.url, res.text.slice(0, 500));
    }
    return { etag: res.headers.get("etag") ?? undefined, data: res.text };
  }

  /** PUT a DAV object (text/calendar or text/vcard). */
  async putObject(path: string, data: string, contentType: string, ifMatch?: string): Promise<{ etag?: string; created: boolean }> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (ifMatch) headers["If-Match"] = strongEtag(ifMatch);
    const res = await this.dav("PUT", path, { headers, body: data, okStatuses: [200, 201, 204] });
    return { etag: res.headers.get("etag") ?? undefined, created: res.status === 201 };
  }

  /** DELETE a DAV object. */
  async deleteObject(path: string, ifMatch?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (ifMatch) headers["If-Match"] = strongEtag(ifMatch);
    await this.dav("DELETE", path, { headers, okStatuses: [200, 204] });
  }

  /** MKCOL to create an address book. */
  async mkcol(path: string, displayName: string): Promise<void> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<d:mkcol xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:nc="http://nextcloud.org/ns">\n  <d:set>\n    <d:prop>\n      <d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>\n      <d:displayname>${escapeXml(displayName)}</d:displayname>\n    </d:prop>\n  </d:set>\n</d:mkcol>`;
    await this.dav("MKCOL", path, { body, okStatuses: [201] });
  }

  /** Discover (and cache) the DAV paths for the current user. */
  async ensureDiscovered(): Promise<void> {
    if (this.principalPath && this.calendarHomePath && this.addressbookHomePath) return;

    // 1. current-user-principal
    let principal = this.principalPath;
    if (!principal) {
      const responses = await this.propfind("/remote.php/dav/", CURRENT_USER_PRINCIPAL_BODY, 0);
      const root = responses[0];
      principal = root ? propHref(root.props["current-user-principal"]) : undefined;
      if (!principal) {
        throw new NextcloudError("Could not resolve the DAV current-user-principal for this account");
      }
      principal = this.davPath(principal);
      this.principalPath = principal;
    }

    // 2. home sets from the principal
    const responses = await this.propfind(principal, HOME_SETS_BODY, 0);
    const props = responses[0]?.props ?? {};
    const calHome = propHref(props["calendar-home-set"]);
    const cardHome = propHref(props["addressbook-home-set"]);

    if (calHome) this.calendarHomePath = this.davPath(calHome);
    if (cardHome) this.addressbookHomePath = this.davPath(cardHome);

    // Fallbacks in case the server did not advertise home sets.
    if (!this.calendarHomePath) {
      this.calendarHomePath = `/remote.php/dav/calendars/${encodeURIComponent(this.username)}/`;
    }
    if (!this.addressbookHomePath) {
      this.addressbookHomePath = `/remote.php/dav/addressbooks/users/${encodeURIComponent(this.username)}/`;
    }
  }

  async calendarHome(): Promise<string> {
    await this.ensureDiscovered();
    return this.calendarHomePath!;
  }

  async addressbookHome(): Promise<string> {
    await this.ensureDiscovered();
    return this.addressbookHomePath!;
  }

  /** List the user's calendars (collections with resourcetype calendar). */
  async listCalendars() {
    const home = await this.calendarHome();
    const responses = await this.propfind(home, propfindBody(CALENDAR_PROPS), 1);
    const calendars = [];
    for (const r of responses) {
      const types = resourceTypes(r.props["resourcetype"]);
      if (!types.includes("calendar")) continue;
      const privs = privileges(r.props["current-user-privilege-set"]);
      const readOnly = privs.length > 0 && !privs.some((p) => p === "write" || p === "write-content" || p === "all" || p === "write-all");
      calendars.push({
        path: withTrailingSlash(this.davPath(r.href)),
        name: asDisplayString(r.props["displayname"]) || lastSegment(r.href),
        color: asDisplayString(r.props["calendar-color"]) || undefined,
        components: calendarComponentSet(r.props["supported-calendar-component-set"]),
        readOnly,
      });
    }
    return calendars;
  }

  /** REPORT calendar-query over one or more calendars. */
  async listCalendarObjects(
    calendarPaths: string[],
    component: "VEVENT" | "VTODO",
    opts: { from?: string; to?: string } = {},
  ) {
    const body = calendarQueryBody(component, opts.from, opts.to);
    const results = [];
    for (const calPath of calendarPaths) {
      const responses = await this.report(calPath, body, 1);
      for (const r of responses) {
        const data = r.props["calendar-data"];
        const ics = typeof data === "string" ? data : (data && typeof data === "object" ? String((data as any)["#text"] ?? "") : "");
        if (!ics || r.href.endsWith("/")) continue;
        results.push({
          calendarPath: withTrailingSlash(calPath),
          path: this.davPath(r.href),
          etag: asDisplayString(r.props["getetag"]) || undefined,
          ics,
        });
      }
    }
    return results;
  }

  /** REPORT addressbook-query over one or more address books. */
  async listContacts(addressbookPaths: string[]) {
    const body = addressbookQueryBody();
    const results = [];
    for (const abPath of addressbookPaths) {
      const responses = await this.report(abPath, body, 1);
      for (const r of responses) {
        const data = r.props["address-data"];
        const vcf = typeof data === "string" ? data : (data && typeof data === "object" ? String((data as any)["#text"] ?? "") : "");
        if (!vcf || r.href.endsWith("/")) continue;
        results.push({
          addressbookPath: withTrailingSlash(abPath),
          path: this.davPath(r.href),
          etag: asDisplayString(r.props["getetag"]) || undefined,
          vcf,
        });
      }
    }
    return results;
  }

  /** List the user's address books. */
  async listAddressbooks() {
    const home = await this.addressbookHome();
    const responses = await this.propfind(home, propfindBody(ADDRESSBOOK_PROPS), 1);
    const books = [];
    for (const r of responses) {
      const types = resourceTypes(r.props["resourcetype"]);
      if (!types.includes("addressbook")) continue;
      const privs = privileges(r.props["current-user-privilege-set"]);
      const readOnly = privs.length > 0 && !privs.some((p) => p === "write" || p === "write-content" || p === "all" || p === "write-all");
      books.push({
        path: withTrailingSlash(this.davPath(r.href)),
        name: asDisplayString(r.props["displayname"]) || lastSegment(r.href),
        readOnly,
      });
    }
    return books;
  }
}

function asDisplayString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"];
  }
  return "";
}

function lastSegment(href: string): string {
  const clean = href.replace(/\/+$/, "");
  const seg = clean.slice(clean.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function withTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

/**
 * Sabre/DAV compares If-Match only against strong entity-tags: a weak etag
 * (W/"...") from a GET response is rejected with 412. Strip the prefix and
 * keep the quoted form the server itself uses.
 */
function strongEtag(etag: string): string {
  const withoutWeak = etag.trim().replace(/^W\//i, "");
  return withoutWeak.startsWith('"') ? withoutWeak : `"${withoutWeak}"`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function authError(res: HttpResponse): AuthError {
  const hint =
    res.status === 401
      ? "Authentication failed. Check the username and app password (/nextcloud-setup). App passwords are required when 2FA is enabled."
      : "Access denied. The account may not have permission for this resource.";
  return new AuthError(`${hint} (HTTP ${res.status})`, res.status, res.url, res.text.slice(0, 500));
}

function httpError(res: HttpResponse, message: string): NextcloudError {
  if (res.status === 401 || res.status === 403) return authError(res);
  if (res.status === 404) return new NotFoundError(`${message}: not found (HTTP 404)`, res.status, res.url, res.text.slice(0, 500));
  if (res.status === 412) {
    return new ConflictError(
      `${message}: the object changed on the server since it was read (HTTP 412). Re-read it and try again.`,
      res.status,
      res.url,
    );
  }
  let serverMessage = "";
  try {
    const parsed = JSON.parse(res.text) as Record<string, any>;
    serverMessage = parsed?.message ?? parsed?.error ?? "";
  } catch {
    /* not JSON */
  }
  return new NextcloudError(
    `${message} (HTTP ${res.status})${serverMessage ? `: ${serverMessage}` : ""}`,
    res.status,
    res.url,
    res.text.slice(0, 500),
  );
}