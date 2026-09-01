/**
 * Nextcloud Notes REST API (version 1).
 * https://github.com/nextcloud/notes/blob/main/docs/api/v1.md
 */

import { NextcloudClient } from "./client.ts";
import { NotFoundError, NextcloudError, ValidationError } from "./errors.ts";

const API_BASE = "/index.php/apps/notes/api/v1";

export interface Note {
  id: number;
  etag: string;
  readonly: boolean;
  modified: number; // unix seconds
  title: string;
  category: string;
  favorite: boolean;
  content?: string;
}

export interface NoteInput {
  title?: string;
  content?: string;
  category?: string;
  favorite?: boolean;
}

export class NotesApi {
  private readonly client: NextcloudClient;

  constructor(client: NextcloudClient) {
    this.client = client;
  }

  async list(
    opts: { category?: string; search?: string; limit?: number; includeContent?: boolean } = {},
  ): Promise<Note[]> {
    const params = new URLSearchParams();
    // Full content is only needed for searching or explicit content requests.
    if (!opts.search && !opts.includeContent) params.set("exclude", "content");
    if (opts.category !== undefined && opts.category !== "") params.set("category", opts.category);

    const { data } = await this.client.requestJson<Note[]>("GET", `${API_BASE}/notes?${params.toString()}`);
    let notes = data;
    if (opts.search) {
      const q = opts.search.toLowerCase();
      notes = notes.filter(
        (n) => n.title.toLowerCase().includes(q) || (n.content ?? "").toLowerCase().includes(q),
      );
    }
    notes.sort((a, b) => b.modified - a.modified);
    if (opts.limit && opts.limit > 0) notes = notes.slice(0, opts.limit);
    return notes;
  }

  async get(id: number): Promise<Note> {
    this.assertId(id);
    try {
      const { data } = await this.client.requestJson<Note>("GET", `${API_BASE}/notes/${id}`);
      return data;
    } catch (err) {
      throw remapNotFound(err, `Note ${id}`);
    }
  }

  async create(input: NoteInput): Promise<Note> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.content !== undefined) body.content = input.content;
    if (input.category !== undefined) body.category = input.category;
    if (input.favorite !== undefined) body.favorite = input.favorite;
    const { data } = await this.client.requestJson<Note>("POST", `${API_BASE}/notes`, { body });
    return data;
  }

  /**
   * Update a note. The etag is fetched automatically unless the caller provides
   * one, giving optimistic concurrency control (HTTP 412 -> ConflictError).
   */
  async update(id: number, input: NoteInput, etag?: string): Promise<Note> {
    this.assertId(id);
    if (Object.keys(input).length === 0) {
      throw new ValidationError("No fields to update (use title, content, category or favorite)");
    }
    let ifMatch = etag;
    if (!ifMatch) {
      // Fetch current etag for optimistic locking (cheap, excludes content).
      const { data } = await this.client.requestJson<Note>(
        "GET",
        `${API_BASE}/notes/${id}?exclude=content,title,category,favorite,modified,readonly`,
      );
      ifMatch = data.etag;
    }
    // The Notes API expects an RFC-compliant entity-tag: the etag value in quotes.
    const quoted = ifMatch.startsWith('"') ? ifMatch : `"${ifMatch}"`;
    try {
      const { data } = await this.client.requestJson<Note>("PUT", `${API_BASE}/notes/${id}`, {
        body: input,
        headers: { "If-Match": quoted },
      });
      return data;
    } catch (err) {
      throw remapConflict(err, `Note ${id} was changed on the server in the meantime`);
    }
  }

  async delete(id: number): Promise<void> {
    this.assertId(id);
    try {
      await this.client.requestJson<unknown>("DELETE", `${API_BASE}/notes/${id}`);
    } catch (err) {
      throw remapNotFound(err, `Note ${id}`);
    }
  }

  private assertId(id: number): void {
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError(`Invalid note id: ${id}`);
    }
  }
}

function remapNotFound(err: unknown, what: string): Error {
  if (err instanceof ValidationError) return err as Error;
  if ((err as NextcloudLike).status === 404) return new NotFoundError(`${what} not found`, 404);
  return err as Error;
}

function remapConflict(err: unknown, message: string): Error {
  if ((err as NextcloudLike).status === 412) {
    return new ValidationError(
      `${message} (HTTP 412). Read the note again and retry; server state was not modified.`,
    );
  }
  return err as Error;
}

interface NextcloudLike {
  status?: number;
}