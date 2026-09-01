/**
 * Shared helpers for the MIME directory format used by both iCalendar (RFC 5545)
 * and vCard (RFC 6350): line unfolding, property parsing, escaping, folding.
 */

export interface MimeProperty {
  /** Uppercased property name, e.g. "DTSTART", "TEL". */
  name: string;
  /** Parameters, uppercased keys; comma-joined when repeated. */
  params: Record<string, string>;
  /** Raw value exactly as on the wire (still escaped, still folded-back). */
  value: string;
}

export interface MimeComponent {
  /** Uppercased component type, e.g. "VCALENDAR", "VEVENT", "VCARD". */
  type: string;
  props: MimeProperty[];
  children: MimeComponent[];
}

/** Remove RFC 5545/6350 line continuations (CRLF or LF followed by space/tab). */
export function unfoldLines(text: string): string[] {
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
  return unfolded.split(/\r\n|\n|\r/).filter((l) => l.length > 0);
}

/** Split a string on `sep`, ignoring separators inside double quotes. */
export function splitUnquoted(s: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === sep && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** Parse one content line into name/params/value. Returns null for BEGIN/END-less junk. */
export function parseContentLine(line: string): MimeProperty | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = splitUnquoted(head, ";");
  const name = (parts.shift() ?? "").trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const part of parts) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) {
      // vCard 2.1 style bare token, e.g. "TEL;CELL:+1..." — treat as TYPE
      params.TYPE = params.TYPE ? `${params.TYPE},${part.trim()}` : part.trim();
    } else {
      const key = part.slice(0, eq).trim().toUpperCase();
      let v = part.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
      params[key] = params[key] ? `${params[key]},${v}` : v;
    }
  }
  return { name, params, value };
}

/** Parse a full MIME document into a tree of components. */
export function parseMime(text: string): MimeComponent[] {
  const roots: MimeComponent[] = [];
  const stack: MimeComponent[] = [];

  for (const line of unfoldLines(text)) {
    const prop = parseContentLine(line);
    if (!prop) continue;

    if (prop.name === "BEGIN") {
      const comp: MimeComponent = { type: prop.value.trim().toUpperCase(), props: [], children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(comp);
      else roots.push(comp);
      stack.push(comp);
    } else if (prop.name === "END") {
      // Pop back to the matching BEGIN (tolerate malformed nesting).
      const type = prop.value.trim().toUpperCase();
      const idx = stack.map((c) => c.type).lastIndexOf(type);
      if (idx >= 0) stack.length = idx;
    } else if (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top) top.props.push(prop);
    }
  }
  return roots;
}

/** Escape a TEXT property value (RFC 5545 3.3.11 / RFC 6350 3.4). */
export function escapeTextValue(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Un-escape a TEXT property value in a single pass. */
export function unescapeTextValue(s: string): string {
  return s.replace(/\\([,;\\nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function propToLine(prop: MimeProperty): string {
  let line = prop.name;
  for (const [key, raw] of Object.entries(prop.params)) {
    const value = raw ?? "";
    const needsQuotes = /[,;:]/.test(value);
    line += `;${key}=${needsQuotes ? `"${value}"` : value}`;
  }
  line += `:${prop.value}`;
  return line;
}

/** Fold content lines to at most 75 octets (continuation = CRLF + single space). */
export function foldLine(line: string): string {
  const max = 75;
  if (Buffer.byteLength(line, "utf8") <= max) return line;

  // First line may use the full width; continuation lines include a leading
  // space, so their content is limited to max - 1 octets.
  const parts: string[] = [];
  let current = "";
  let limit = max;
  let currentBytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8");
    if (currentBytes + b > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
      limit = max - 1;
    }
    current += ch;
    currentBytes += b;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

export function serializeProps(props: MimeProperty[]): string[] {
  return props.map((p) => foldLine(propToLine(p)));
}

/** Serialize a component tree back to wire format. */
export function serializeMime(components: MimeComponent[]): string {
  const lines: string[] = [];
  const walk = (comp: MimeComponent) => {
    lines.push(`BEGIN:${comp.type}`);
    lines.push(...serializeProps(comp.props));
    for (const child of comp.children) walk(child);
    lines.push(`END:${comp.type}`);
  };
  for (const comp of components) walk(comp);
  return lines.join("\r\n") + "\r\n";
}

/** First property with the given name (searches only the component itself). */
export function firstProp(comp: MimeComponent, name: string): MimeProperty | undefined {
  return comp.props.find((p) => p.name === name);
}

/** All property values with the given name. */
export function propValues(comp: MimeComponent, name: string): MimeProperty[] {
  return comp.props.filter((p) => p.name === name);
}

/** Un-escaped TEXT value of the first matching property ("" when absent). */
export function textValue(comp: MimeComponent, name: string): string {
  const prop = firstProp(comp, name);
  return prop ? unescapeTextValue(prop.value) : "";
}

/**
 * Set (replace or add) a property on a component.
 * The value must already be in wire format (use escapeTextValue for TEXT props).
 */
export function setProp(comp: MimeComponent, name: string, value: string, params?: Record<string, string>): void {
  const idx = comp.props.findIndex((p) => p.name === name);
  const prop: MimeProperty = { name, params: params ?? {}, value };
  if (idx >= 0) comp.props[idx] = prop;
  else comp.props.push(prop);
}

/** Remove all properties with the given name (optionally matching a value). */
export function removeProps(comp: MimeComponent, name: string, value?: string): void {
  comp.props = comp.props.filter((p) => p.name !== name || (value !== undefined && p.value !== value));
}

/** Parse a structured value ("a;b;c") into un-escaped parts. */
export function structuredValue(value: string, maxParts?: number): string[] {
  const parts = splitUnquoted(value, ";");
  const unescaped = parts.map((p) => unescapeTextValue(p));
  if (maxParts && unescaped.length > maxParts) {
    const head = unescaped.slice(0, maxParts - 1);
    head.push(unescaped.slice(maxParts - 1).join(";"));
    return head;
  }
  return unescaped;
}