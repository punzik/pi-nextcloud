import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyContactInput,
  buildVCard,
  contactMatches,
  contactSummary,
  normalizeFieldLabel,
  parseFieldInputs,
  parseVCard,
  serializeVCard,
} from "../src/vcard.ts";

test("parseFieldInputs: plain and labeled values", () => {
  const fields = parseFieldInputs(["+7 900 000-00-00", "cell:+7 911 111-11-11", "work:john@example.com"]);
  assert.deepEqual(fields, [
    { type: "", value: "+7 900 000-00-00" },
    { type: "CELL", value: "+7 911 111-11-11" },
    { type: "WORK", value: "john@example.com" },
  ]);
});

test("normalizeFieldLabel uppercases and strips junk", () => {
  assert.equal(normalizeFieldLabel("cell"), "CELL");
  assert.equal(normalizeFieldLabel("home-town"), "HOME-TOWN");
});

test("buildVCard creates valid vCard 3.0", () => {
  const { text, uid } = buildVCard({
    firstName: "Иван",
    lastName: "Иванов",
    organization: "ACME",
    title: "Developer",
    emails: parseFieldInputs(["home:ivan@example.com", "work:ivanov@acme.io"]),
    phones: parseFieldInputs(["cell:+7 900 000-00-00"]),
    note: "Met at conference, 2025",
  });
  assert.ok(text.startsWith("BEGIN:VCARD\r\n"));
  assert.ok(text.includes("VERSION:3.0"));
  assert.ok(text.includes("N:Иванов;Иван;;;"));
  assert.ok(text.includes("FN:Иван Иванов"));
  assert.ok(text.includes("EMAIL;TYPE=HOME:ivan@example.com"));
  assert.ok(text.includes("TEL;TYPE=CELL:+7 900 000-00-00"));
  assert.ok(text.includes(`UID:${uid}`));
  assert.ok(text.includes("REV:"));

  const { contact } = parseVCard(text);
  assert.equal(contact.firstName, "Иван");
  assert.equal(contact.lastName, "Иванов");
  assert.equal(contact.fullName, "Иван Иванов");
  assert.equal(contact.emails.length, 2);
  assert.equal(contact.phones[0]?.type, "CELL");
  assert.equal(contact.organization, "ACME");
  assert.equal(contact.note, "Met at conference, 2025");
  assert.equal(contact.uid, uid);
});

test("applyContactInput merges name parts and replaces arrays", () => {
  const { text } = buildVCard({
    firstName: "John",
    lastName: "Doe",
    emails: parseFieldInputs(["john@old.example"]),
    phones: parseFieldInputs(["+1 555 000"]),
  });
  const { component } = parseVCard(text);
  applyContactInput(component, {
    lastName: "Doe-Smith",
    emails: parseFieldInputs(["work:john@new.example"]),
    phones: [],
  });
  const vcf = serializeVCard(component);
  const { contact } = parseVCard(vcf);

  assert.equal(contact.lastName, "Doe-Smith");
  assert.equal(contact.firstName, "John");
  assert.equal(contact.fullName, "John Doe-Smith");
  assert.deepEqual(contact.emails, [{ type: "WORK", value: "john@new.example" }]);
  assert.deepEqual(contact.phones, []);
  assert.ok(contact.revision);
});

test("applyContactInput clears optional scalars with empty strings", () => {
  const { text } = buildVCard({ firstName: "A", nickname: "Nicky", title: "Boss", note: "hello" });
  const { component } = parseVCard(text);
  applyContactInput(component, { nickname: "", title: "", note: "" });
  const { contact } = parseVCard(serializeVCard(component));
  assert.equal(contact.nickname, "");
  assert.equal(contact.title, "");
  assert.equal(contact.note, "");
});

test("contactMatches searches across fields", () => {
  const { text } = buildVCard({
    firstName: "Мария",
    lastName: "Петрова",
    emails: parseFieldInputs(["maria@example.org"]),
  });
  const { contact } = parseVCard(text);
  assert.ok(contactMatches(contact, "maria@"));
  assert.ok(contactMatches(contact, "петрова"));
  assert.ok(!contactMatches(contact, "ivan"));
});

test("contactSummary shape", () => {
  const { text } = buildVCard({
    firstName: "X",
    emails: parseFieldInputs(["cell:x@y.z"]),
  });
  const { contact } = parseVCard(text);
  const summary = contactSummary(contact);
  assert.equal(summary.name, "X");
  assert.deepEqual(summary.emails, ["cell:x@y.z"]);
  assert.equal(summary.uid, contact.uid);
});