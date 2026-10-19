import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addPasswordToPlainText, findLinksInPlainText, passwordMessage } from "../lib/message.js";

const url = "https://cloud.example.com/s/AbC123";
const other = "https://cloud.example.com/s/XyZ789";
const link = (u, password, name = "report.pdf") => ({ url: u, name, password });

describe("addPasswordToPlainText", () => {
  it("adds the password under the line with the link", () => {
    const text = ["Hi,", "", "* report.pdf", "  Password Protected Link: " + url, "", "Thanks"].join("\n");
    assert.equal(
      addPasswordToPlainText(text, [link(url, "s3cret")]),
      ["Hi,", "", "* report.pdf", "  Password Protected Link: " + url, "Password: s3cret", "", "Thanks"].join("\n"),
    );
  });

  it("handles several links, each with its own password, and keeps CRLF line endings", () => {
    const text = `Link: ${url}\r\nLink: ${other}\r\n`;
    assert.equal(
      addPasswordToPlainText(text, [link(url, "pw1"), link(other, "pw2")]),
      `Link: ${url}\r\nPassword: pw1\r\nLink: ${other}\r\nPassword: pw2\r\n`,
    );
  });

  it("never adds a password inside quoted text", () => {
    const text = `My reply\n\n> Earlier mail\n> Link: ${url}`;
    const result = addPasswordToPlainText(text, [link(url, "pw")]);
    assert.ok(result.startsWith(text), "quoted lines are left as they were");
    assert.equal(result.slice(text.length), "\n\nPassword: pw"); // appended after the quote, not inside it
  });

  it("appends the password when the link is not in the text", () => {
    assert.equal(addPasswordToPlainText("Hi", [link(url, "pw")]), "Hi\n\nPassword: pw");
  });

  it("lists each password with its file name when appending different ones", () => {
    assert.equal(
      addPasswordToPlainText("Hi", [link(url, "pw1", "a.pdf"), link(other, "pw2", "b.zip")]),
      "Hi\n\nPassword: pw1 (a.pdf)\nPassword: pw2 (b.zip)",
    );
  });
});

describe("findLinksInPlainText", () => {
  it("finds links outside quoted lines only", () => {
    const text = `Link: ${url}\n> Link: ${other}\n`;
    assert.deepEqual(findLinksInPlainText(text, [url, other]), [url]);
    assert.deepEqual(findLinksInPlainText(`> ${url}`, [url]), []);
  });
});

describe("passwordMessage", () => {
  it("addresses the same people from the same identity with only the password", () => {
    const details = passwordMessage(
      { to: ["a@example.com"], cc: ["b@example.com"], bcc: [], subject: "Q3 report", identityId: "id1" },
      [link(url, "s3cret")],
    );
    assert.deepEqual(
      { ...details, plainTextBody: undefined },
      {
        identityId: "id1",
        to: ["a@example.com"],
        cc: ["b@example.com"],
        bcc: [],
        subject: "Password for: Q3 report",
        isPlainText: true,
        plainTextBody: undefined,
      },
    );
    assert.match(details.plainTextBody, /the file link in my previous email "Q3 report" is:\n\ns3cret\n$/);
    assert.doesNotMatch(details.plainTextBody, /https?:/);
  });

  it("copes with no subject and several links sharing a password", () => {
    const details = passwordMessage({ to: ["a@example.com"], subject: "" }, [link(url, "pw"), link(other, "pw")]);
    assert.equal(details.subject, "Password for the file link");
    assert.match(details.plainTextBody, /the file links in my previous email is:\n\npw\n$/);
  });

  it("lists each file's password when they differ (a draft combining sessions)", () => {
    const details = passwordMessage({ to: ["a@example.com"], subject: "Files" }, [
      link(url, "pw1", "a.pdf"),
      link(other, "pw2", "b.zip"),
    ]);
    assert.match(details.plainTextBody, /The passwords for the file links in my previous email "Files" are:\n\na\.pdf: pw1\nb\.zip: pw2\n$/);
  });
});
