/**
 * CardDAV layer: address books and contacts.
 */

import { NextcloudClient } from "./client.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import {
  applyContactInput,
  buildVCard,
  contactMatches,
  contactSummary,
  parseFieldInputs,
  parseVCard,
  serializeVCard,
  type ContactInput,
  type ParsedContact,
} from "./vcard.ts";
import { parseMime } from "./mime.ts";

export interface AddressbookInfo {
  /** DAV path of the collection, with trailing slash. */
  path: string;
  name: string;
  readOnly: boolean;
}

export class CardDavApi {
  private readonly client: NextcloudClient;

  constructor(client: NextcloudClient) {
    this.client = client;
  }

  async listAddressbooks(): Promise<AddressbookInfo[]> {
    return this.client.listAddressbooks();
  }

  async listContacts(
    opts: { addressbook?: string; search?: string; limit?: number } = {},
  ): Promise<Array<{ addressbook: string; contact: ParsedContact; path: string }>> {
    const books = await this.resolveAddressbooks(opts.addressbook);
    const objects = await this.client.listContacts(books.map((b) => b.path));
    let items: Array<{ addressbook: string; contact: ParsedContact; path: string }> = [];
    for (const obj of objects) {
      try {
        const { contact } = parseVCard(obj.vcf);
        items.push({ addressbook: obj.addressbookPath, contact, path: obj.path });
      } catch {
        // Skip unparseable objects rather than failing the whole listing.
      }
    }
    if (opts.search && opts.search.trim() !== "") {
      items = items.filter((i) => contactMatches(i.contact, opts.search!.trim()));
    }
    items.sort((a, b) => a.contact.fullName.localeCompare(b.contact.fullName));
    if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit);
    return items;
  }

  /** Get one contact by vCard UID or file name. */
  async getContact(addressbook: string, uid: string): Promise<{ contact: ParsedContact; path: string }> {
    const { object } = await this.getObjectByUid(addressbook, uid);
    const { contact } = parseVCard(object.vcf);
    return { contact, path: object.path };
  }

  async createContact(input: {
    addressbook: string;
    fields: ContactInput;
  }): Promise<{ contact: ParsedContact; path: string; uid: string }> {
    const books = await this.resolveAddressbooks(input.addressbook, { writableOnly: true });
    const book = books[0];
    if (!book) throw new NotFoundError("No address book available", 404);
    const { text, uid } = buildVCard(input.fields);
    const path = `${book.path}${safeFilename(uid)}.vcf`;
    await this.client.putObject(path, text, "text/vcard; charset=utf-8");
    const { contact } = parseVCard(text);
    return { contact, path, uid };
  }

  /** Update an existing contact by UID or file name. */
  async updateContact(input: {
    addressbook: string;
    uid: string;
    fields: ContactInput;
  }): Promise<{ contact: ParsedContact; path: string }> {
    const { object, component } = await this.getObjectByUid(input.addressbook, input.uid);
    applyContactInput(component, input.fields);
    const text = serializeVCard(component);
    await this.client.putObject(object.path, text, "text/vcard; charset=utf-8", object.etag);
    const { contact } = parseVCard(text);
    return { contact, path: object.path };
  }

  async deleteContact(addressbook: string, uid: string): Promise<void> {
    const { object } = await this.getObjectByUid(addressbook, uid);
    await this.client.deleteObject(object.path, object.etag);
  }

  /** Convert tool input arrays ("cell:+7..." strings) into ContactField lists. */
  static fieldsFromInput(args: {
    emails?: string[];
    phones?: string[];
    urls?: string[];
  }): { emails?: ContactInput["emails"]; phones?: ContactInput["phones"]; urls?: ContactInput["urls"] } {
    return {
      emails: args.emails ? parseFieldInputs(args.emails) : undefined,
      phones: args.phones ? parseFieldInputs(args.phones) : undefined,
      urls: args.urls ? parseFieldInputs(args.urls) : undefined,
    };
  }

  // -------------------------------------------------------------------------

  private async resolveAddressbooks(
    selector?: string,
    opts: { writableOnly?: boolean } = {},
  ): Promise<AddressbookInfo[]> {
    const all = await this.listAddressbooks();
    let usable = all;
    if (opts.writableOnly) usable = all.filter((b) => !b.readOnly);

    if (selector && selector.trim() !== "") {
      const sel = selector.trim();
      const byName = usable.filter(
        (b) => b.name.toLowerCase() === sel.toLowerCase() || b.path === sel || lastSegment(b.path) === sel,
      );
      const byNameFirst = byName[0];
      if (byNameFirst) return [byNameFirst];
      const bySuffix = usable.filter((b) => lastSegment(b.path) === sel);
      if (bySuffix.length === 1) {
        const only = bySuffix[0];
        if (only) return [only];
      }
      if (bySuffix.length > 1) {
        throw new ValidationError(
          `Address book selector "${selector}" is ambiguous: ${bySuffix.map((b) => b.name).join(", ")}`,
        );
      }
      const available = all.map((b) => b.name).join(", ");
      throw new NotFoundError(`Address book "${sel}" not found. Available: ${available || "none"}`, 404);
    }

    if (usable.length === 0) {
      throw new NotFoundError("No writable address book was found on the server", 404);
    }
    return usable;
  }

  /** Fetch a contact by vCard UID or file name. */
  private async getObjectByUid(
    addressbook: string,
    uid: string,
  ): Promise<{ object: { path: string; etag?: string; vcf: string }; component: import("./mime.ts").MimeComponent }> {
    if (!uid || uid.trim() === "") throw new ValidationError("uid is required");
    const trimmedUid = uid.trim();
    const books = await this.resolveAddressbooks(addressbook);
    const tried: string[] = [];

    // Fast path: contacts are usually stored as <uid-or-filename>.vcf.
    for (const book of books) {
      if (book.readOnly) continue;
      const guess = `${book.path}${safeFilename(trimmedUid)}.vcf`;
      try {
        const { etag, data } = await this.client.getObject(guess);
        const { component } = parseVCard(data);
        if (!component.props.some((p) => p.name === "UID" && p.value && p.value !== trimmedUid)) {
          return { object: { path: guess, etag, vcf: data }, component };
        }
        tried.push(guess);
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        tried.push(guess);
      }
    }

    // Fallback: scan the address books and match by UID.
    const objects = await this.client.listContacts(books.map((b) => b.path));
    for (const obj of objects) {
      try {
        const { contact, component } = parseVCard(obj.vcf);
        if (contact.uid === trimmedUid || safeFilename(trimmedUid) === safeFilename(contact.uid)) {
          return { object: { path: obj.path, etag: obj.etag, vcf: obj.vcf }, component };
        }
      } catch {
        /* skip unparseable */
      }
    }
    throw new NotFoundError(`Contact with uid "${trimmedUid}" not found`, 404);
  }
}

function safeFilename(uid: string): string {
  return uid.replace(/[^A-Za-z0-9._@-]/g, "_");
}

/** URL-decoded last path segment, e.g. the collection URI of an address book. */
function lastSegment(pathOrUrl: string): string {
  const clean = pathOrUrl.replace(/\/+$/, "");
  const seg = clean.slice(clean.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}