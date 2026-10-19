import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addPasswordToPlainText, passwordMessage } from "../lib/message.js";

const url = "https://cloud.example.com/s/AbC123";

describe("addPasswordToPlainText", () => {
  it("adds the password under the line with the link", () => {
    const text = ["Hi,", "", "* report.pdf", "  Password Protected Link: " + url, "", "Thanks"].join("\n");
    assert.equal(
      addPasswordToPlainText(text, [url], "s3cret"),
      ["Hi,", "", "* report.pdf", "  Password Protected Link: " + url, "Password: s3cret", "", "Thanks"].join("\n"),
    );
  });

  it("handles several links and keeps CRLF line endings", () => {
    const other = "https://cloud.example.com/s/XyZ789";
    const text = `Link: ${url}\r\nLink: ${other}\r\n`;
    assert.equal(
      addPasswordToPlainText(text, [url, other], "pw"),
      `Link: ${url}\r\nPassword: pw\r\nLink: ${other}\r\nPassword: pw\r\n`,
    );
  });

  it("appends the password when the link is not in the text", () => {
    assert.equal(addPasswordToPlainText("Hi", [url], "pw"), "Hi\n\nPassword: pw");
  });
});

describe("passwordMessage", () => {
  it("addresses the same people from the same identity with only the password", () => {
    const details = passwordMessage(
      { to: ["a@example.com"], cc: ["b@example.com"], bcc: [], subject: "Q3 report", identityId: "id1" },
      "s3cret",
      1,
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

  it("copes with no subject and several links", () => {
    const details = passwordMessage({ to: ["a@example.com"], subject: "" }, "pw", 3);
    assert.equal(details.subject, "Password for the file link");
    assert.match(details.plainTextBody, /the file links in my previous email is:/);
  });
});
