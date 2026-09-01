/**
 * vCard 3.0 parsing and building for CardDAV contacts.
 */

import {
  escapeTextValue,
  firstProp,
  type MimeComponent,
  parseMime,
  removeProps,
  serializeMime,
  setProp,
  structuredValue,
  textValue,
  unescapeTextValue,
} from "./mime.ts";

export interface ContactField {
  /** Normalized TYPE parameter, e.g. "CELL", "HOME", "WORK" ("" when unset). */
  type: string;
  value: string;
}

export interface ParsedContact {
  uid: string;
  fullName: string;
  firstName: string;
  lastName: string;
  middleName: string;
  prefix: string;
  suffix: string;
  nickname: string;
  organization: string;
  title: string;
  note: string;
  emails: ContactField[];
  phones: ContactField[];
  urls: ContactField[];
  categories: string[];
  revision?: string;
  raw: string;
}

function splitTypes(params: Record<string, string>): string[] {
  if (!params.TYPE) return [];
  return params.TYPE.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
}

function fields(comp: MimeComponent, name: string): ContactField[] {
  return comp.props
    .filter((p) => p.name === name)
    .map((p) => ({
      type: splitTypes(p.params)[0] ?? "",
      value: unescapeTextValue(p.value),
    }))
    .filter((f) => f.value !== "");
}

/** Parse a vCard document into a contact model plus its component tree. */
export function parseVCard(text: string): { contact: ParsedContact; component: MimeComponent } {
  const components = parseMime(text);
  const card = components.find((c) => c.type === "VCARD");
  if (!card) throw new Error("Not a valid vCard: no VCARD component found");

  const nProp = firstProp(card, "N");
  const n = nProp ? structuredValue(nProp.value, 5) : [];
  const orgProp = firstProp(card, "ORG");
  const categoriesProp = firstProp(card, "CATEGORIES");

  const contact: ParsedContact = {
    uid: textValue(card, "UID"),
    fullName: textValue(card, "FN"),
    lastName: n[0] ?? "",
    firstName: n[1] ?? "",
    middleName: n[2] ?? "",
    prefix: n[3] ?? "",
    suffix: n[4] ?? "",
    nickname: textValue(card, "NICKNAME"),
    organization: orgProp ? structuredValue(orgProp.value).filter(Boolean).join(" · ") : "",
    title: textValue(card, "TITLE"),
    note: textValue(card, "NOTE"),
    emails: fields(card, "EMAIL"),
    phones: fields(card, "TEL"),
    urls: fields(card, "URL"),
    categories: categoriesProp ? structuredValue(categoriesProp.value).filter(Boolean) : [],
    revision: textValue(card, "REV") || undefined,
    raw: text,
  };
  return { contact, component: card };
}

export interface ContactInput {
  firstName?: string;
  lastName?: string;
  middleName?: string;
  prefix?: string;
  suffix?: string;
  fullName?: string;
  nickname?: string;
  organization?: string;
  title?: string;
  note?: string;
  emails?: ContactField[];
  phones?: ContactField[];
  urls?: ContactField[];
  categories?: string[];
}

/** Normalize a user-supplied label: "cell", "Cell", "WORK" -> "CELL". */
export function normalizeFieldLabel(label: string): string {
  return label.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

/**
 * Parse tool input entries: "value" or "label:value", e.g.
 *   "+7 900 000-00-00", "cell:+7 900 000-00-00", "work:john@example.com"
 */
export function parseFieldInputs(inputs: string[]): ContactField[] {
  const out: ContactField[] = [];
  for (const input of inputs) {
    const s = input.trim();
    if (!s) continue;
    const m = /^([A-Za-z][A-Za-z0-9-]*):(.+)$/.exec(s);
    const label = m?.[1];
    const rest = m?.[2];
    if (label && rest) out.push({ type: normalizeFieldLabel(label), value: rest.trim() });
    else out.push({ type: "", value: s });
  }
  return out;
}

/** Derive FN from the input, falling back to name parts, org, or first field. */
function derivedFullName(input: ContactInput): string {
  if (input.fullName && input.fullName.trim()) return input.fullName.trim();
  const name = [input.prefix, input.firstName, input.middleName, input.lastName, input.suffix]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (name) return name;
  if (input.organization && input.organization.trim()) return input.organization.trim();
  const firstField = input.emails?.[0]?.value ?? input.phones?.[0]?.value;
  if (firstField) return firstField;
  return "Unnamed";
}

function setOrRemove(comp: MimeComponent, name: string, value: string | undefined): void {
  if (value === undefined || value === "") removeProps(comp, name);
  else setProp(comp, name, value);
}

function nowUtcBasic(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function replaceFields(card: MimeComponent, name: string, list: ContactField[]): void {
  removeProps(card, name);
  for (const f of list) {
    if (!f.value) continue;
    const params: Record<string, string> = {};
    if (f.type) params.TYPE = f.type;
    card.props.push({ name, params, value: escapeTextValue(f.value) });
  }
}

/**
 * Apply contact fields to a vCard component in place.
 * - Name parts merge with the existing N property; FN is re-derived.
 * - emails/phones/urls, when provided, replace all existing entries.
 * - Bumps REV.
 */
export function applyContactInput(card: MimeComponent, input: ContactInput): void {
  const wantsName =
    input.firstName !== undefined ||
    input.lastName !== undefined ||
    input.middleName !== undefined ||
    input.prefix !== undefined ||
    input.suffix !== undefined ||
    input.fullName !== undefined;

  if (wantsName) {
    const existing = firstProp(card, "N");
    const current = existing ? structuredValue(existing.value, 5) : ["", "", "", "", ""];
    const merged = {
      lastName: input.lastName ?? current[0] ?? "",
      firstName: input.firstName ?? current[1] ?? "",
      middleName: input.middleName ?? current[2] ?? "",
      prefix: input.prefix ?? current[3] ?? "",
      suffix: input.suffix ?? current[4] ?? "",
    };
    setProp(
      card,
      "N",
      [merged.lastName, merged.firstName, merged.middleName, merged.prefix, merged.suffix]
        .map(escapeTextValue)
        .join(";"),
    );
    setProp(card, "FN", escapeTextValue(derivedFullName({ ...input, ...merged, fullName: input.fullName })));
  }

  if (input.nickname !== undefined) setOrRemove(card, "NICKNAME", escapeTextValue(input.nickname));
  if (input.title !== undefined) setOrRemove(card, "TITLE", escapeTextValue(input.title));
  if (input.organization !== undefined) {
    if (input.organization === "") removeProps(card, "ORG");
    else setProp(card, "ORG", escapeTextValue(input.organization));
  }
  if (input.note !== undefined) setOrRemove(card, "NOTE", escapeTextValue(input.note));
  if (input.categories !== undefined) {
    if (input.categories.length === 0) removeProps(card, "CATEGORIES");
    else setProp(card, "CATEGORIES", input.categories.map(escapeTextValue).join(","));
  }
  if (input.emails) replaceFields(card, "EMAIL", input.emails);
  if (input.phones) replaceFields(card, "TEL", input.phones);
  if (input.urls) replaceFields(card, "URL", input.urls);

  setProp(card, "REV", nowUtcBasic());
}

/** Build a complete vCard 3.0 document for a new contact. */
export function buildVCard(input: ContactInput): { text: string; uid: string } {
  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}@pi-nextcloud`;
  const card: MimeComponent = { type: "VCARD", props: [], children: [] };
  card.props.push({ name: "VERSION", params: {}, value: "3.0" });
  card.props.push({ name: "PRODID", params: {}, value: "-//pi-nextcloud//Pi Nextcloud Extension//EN" });
  card.props.push({ name: "UID", params: {}, value: uid });
  // Force N/FN on new cards even when name parts are empty (FN falls back
  // to organization or the first email/phone).
  applyContactInput(card, { ...input, firstName: input.firstName ?? "", lastName: input.lastName ?? "" });
  return { text: serializeMime([card]), uid };
}

/** Re-serialize a (modified) vCard component tree. */
export function serializeVCard(card: MimeComponent): string {
  return serializeMime([card]);
}

/** True when any of the contact's searchable fields contains the query. */
export function contactMatches(contact: ParsedContact, query: string): boolean {
  const q = query.toLowerCase();
  const haystacks = [
    contact.fullName,
    contact.firstName,
    contact.lastName,
    contact.nickname,
    contact.organization,
    contact.title,
    contact.note,
    ...contact.emails.map((e) => e.value),
    ...contact.phones.map((p) => p.value),
  ];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

/** Compact summary of a contact for list output. */
export function contactSummary(contact: ParsedContact): Record<string, unknown> {
  return {
    uid: contact.uid,
    name: contact.fullName,
    firstName: contact.firstName || undefined,
    lastName: contact.lastName || undefined,
    organization: contact.organization || undefined,
    emails: contact.emails.map((e) => (e.type ? `${e.type.toLowerCase()}:${e.value}` : e.value)),
    phones: contact.phones.map((p) => (p.type ? `${p.type.toLowerCase()}:${p.value}` : p.value)),
  };
}