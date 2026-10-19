// Adds a link password to an outgoing message. No browser.* calls, so it stays testable in Node.
//
// Thunderbird renders each Filelink as an element with class "cloudAttachmentItem" and
// data-content-location="<link URL>" (messengercompose/cloudAttachmentLinkManager.js). On send it
// only strips the IDs of the surrounding list, so class and data attribute are still there.

export const PASSWORD_LABEL = "Password:";

/** Adds a "Password:" row under each matching link in an HTML message `doc`. Returns false if none was found. */
export function addPasswordToHtml(doc, urls, password) {
  const items = [...doc.querySelectorAll(".cloudAttachmentItem")].filter((el) =>
    urls.includes(el.getAttribute("data-content-location")),
  );
  for (const item of items) {
    // Same layout as Thunderbird's own rows (expiry date, link).
    const row = doc.createElement("span");
    row.style.gridColumn = "2 / span 3";
    row.style.fontSize = "small";
    const label = doc.createElement("span");
    label.style.color = "#595959";
    label.textContent = `${PASSWORD_LABEL} `;
    const value = doc.createElement("span");
    value.style.fontFamily = "monospace";
    value.textContent = password;
    row.append(label, value, doc.createElement("br"));
    // Each item ends with a <br> spacer; keep the password above it.
    const last = item.lastElementChild;
    if (last?.tagName === "BR") item.insertBefore(row, last);
    else item.append(row);
  }
  if (items.length) return true;
  // The link block was edited away or rebuilt: put the password at the end so it is not lost.
  const p = doc.createElement("p");
  p.textContent = `${PASSWORD_LABEL} ${password}`;
  doc.body.append(p);
  return false;
}

/** Adds "Password: …" after each line containing one of `urls`, or at the end if none does. */
export function addPasswordToPlainText(text, urls, password) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(eol);
  const out = [];
  let found = false;
  for (const line of lines) {
    out.push(line);
    if (urls.some((url) => line.includes(url))) {
      out.push(`${PASSWORD_LABEL} ${password}`);
      found = true;
    }
  }
  if (!found) out.push("", `${PASSWORD_LABEL} ${password}`);
  return out.join(eol);
}

/** Details for compose.beginNew: a second message, to the same people, carrying only the password. */
export function passwordMessage({ to, cc, bcc, subject, identityId }, password, linkCount) {
  const links = linkCount === 1 ? "the file link" : "the file links";
  const quoted = subject ? ` "${subject}"` : "";
  return {
    identityId,
    to,
    cc,
    bcc,
    subject: subject ? `Password for: ${subject}` : "Password for the file link",
    isPlainText: true,
    plainTextBody: `Hello,\n\nThe password for ${links} in my previous email${quoted} is:\n\n${password}\n`,
  };
}
