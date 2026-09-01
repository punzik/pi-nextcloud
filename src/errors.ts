/**
 * Error types used across the Nextcloud extension.
 */

export class NextcloudError extends Error {
  status: number | undefined;
  url: string | undefined;
  body: string | undefined;

  constructor(message: string, status?: number, url?: string, body?: string) {
    super(message);
    this.name = "NextcloudError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** HTTP 401/403 — bad or missing credentials. */
export class AuthError extends NextcloudError {
  constructor(message: string, status?: number, url?: string, body?: string) {
    super(message, status, url, body);
    this.name = "AuthError";
  }
}

/** HTTP 404 — resource does not exist. */
export class NotFoundError extends NextcloudError {
  constructor(message: string, status?: number, url?: string, body?: string) {
    super(message, status, url, body);
    this.name = "NotFoundError";
  }
}

/** HTTP 412 — optimistic concurrency conflict (etag mismatch). */
export class ConflictError extends NextcloudError {
  constructor(message: string, status?: number, url?: string, body?: string) {
    super(message, status, url, body);
    this.name = "ConflictError";
  }
}

/** User input is invalid (bad date, bad enum value, ...). */
export class ValidationError extends NextcloudError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}