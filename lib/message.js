// Adds link passwords to an outgoing message. No browser.* calls, so it stays testable in Node.
//
// Thunderbird renders each Filelink as an element with class "cloudAttachmentItem" and
// data-content-location="<link URL>" (messengercompose/cloudAttachmentLinkManager.js). On send it
// only strips the IDs of the surrounding list, so class and data attribute are still there.
//
// Links are described as entries: { url, name, password }. A message usually has one password for
// all its links, but a draft reopened later can combine links from different sessions.
//
// Quoted text is never touched or searched: a reply quoting an earlier email with a Filelink block
// must not pick up that link's password.

export const PASSWORD_LABEL = "Password:";

const isQuotedHtml = (el) => !!el.closest('blockquote[type="cite"]');
const isQuotedLine = (line) => /^\s*>/.test(line);

/**
 * Whether `line` contains `url` as a whole link, not as the start of a longer one (".../s/abc" must
 * not match ".../s/abcd"). Punctuation after a link, as in "(see https://...)." still matches.
 */
function lineHasUrl(line, url) {
  for (let i = line.indexOf(url); i !== -1; i = line.indexOf(url, i + 1)) {
    if (!/[A-Za-z0-9_-]/.test(line[i + url.length] ?? "")) return true;
  }
  return false;
}

/** Filelink items in an HTML message `doc` that are not inside quoted text, with their link URL. */
function linkItems(doc) {
  return [...doc.querySelectorAll(".cloudAttachmentItem[data-content-location]")]
    .filter((el) => !isQuotedHtml(el))
    .map((el) => ({ el, url: el.getAttribute("data-content-location") }));
}

/** Which of `urls` appear as Filelinks in the HTML message `doc`, outside quoted text. */
export function findLinksInHtml(doc, urls) {
  const present = new Set(linkItems(doc).map((item) => item.url));
  return urls.filter((url) => present.has(url));
}

/** Which of `urls` appear in the plain-text message, outside quoted lines. */
export function findLinksInPlainText(text, urls) {
  const lines = text.split(/\r?\n/).filter((line) => !isQuotedLine(line));
  return urls.filter((url) => lines.some((line) => lineHasUrl(line, url)));
}

function passwordLines(entries) {
  const distinct = [...new Set(entries.map((e) => e.password))];
  if (distinct.length === 1) return [`${PASSWORD_LABEL} ${distinct[0]}`];
  return entries.map((e) => `${PASSWORD_LABEL} ${e.password} (${e.name})`);
}

/** Adds a "Password:" row under each matching link in an HTML message `doc`. Returns false if none was found. */
export function addPasswordToHtml(doc, entries) {
  const byUrl = new Map(entries.map((e) => [e.url, e]));
  const items = linkItems(doc).filter((item) => byUrl.has(item.url));
  for (const { el, url } of items) {
    // Same layout as Thunderbird's own rows (expiry date, link).
    const row = doc.createElement("span");
    row.style.gridColumn = "2 / span 3";
    row.style.fontSize = "small";
    const label = doc.createElement("span");
    label.style.color = "#595959";
    label.textContent = `${PASSWORD_LABEL} `;
    const value = doc.createElement("span");
    value.style.fontFamily = "monospace";
    value.textContent = byUrl.get(url).password;
    row.append(label, value, doc.createElement("br"));
    // Each item ends with a <br> spacer; keep the password above it.
    const last = el.lastElementChild;
    if (last?.tagName === "BR") el.insertBefore(row, last);
    else el.append(row);
  }
  if (items.length) return true;
  // The link block was edited away or rebuilt: put the passwords at the end so they are not lost.
  for (const line of passwordLines(entries)) {
    const p = doc.createElement("p");
    p.textContent = line;
    doc.body.append(p);
  }
  return false;
}

/** Adds "Password: …" after each unquoted line containing an entry's link, or at the end if none does. */
export function addPasswordToPlainText(text, entries) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out = [];
  let found = false;
  for (const line of text.split(eol)) {
    out.push(line);
    if (isQuotedLine(line)) continue;
    const entry = entries.find((e) => lineHasUrl(line, e.url));
    if (entry) {
      out.push(`${PASSWORD_LABEL} ${entry.password}`);
      found = true;
    }
  }
  if (!found) out.push("", ...passwordLines(entries));
  return out.join(eol);
}

/** Details for compose.beginNew: a second message, to the same people, carrying only the password(s). */
export function passwordMessage({ to, cc, bcc, subject, identityId }, entries) {
  const quoted = subject ? ` "${subject}"` : "";
  const distinct = [...new Set(entries.map((e) => e.password))];
  let body;
  if (distinct.length === 1) {
    const links = entries.length === 1 ? "the file link" : "the file links";
    body = `The password for ${links} in my previous email${quoted} is:\n\n${distinct[0]}\n`;
  } else {
    body = `The passwords for the file links in my previous email${quoted} are:\n\n${entries
      .map((e) => `${e.name}: ${e.password}`)
      .join("\n")}\n`;
  }
  return {
    identityId,
    to,
    cc,
    bcc,
    subject: subject ? `Password for: ${subject}` : "Password for the file link",
    isPlainText: true,
    plainTextBody: `Hello,\n\n${body}`,
  };
}
