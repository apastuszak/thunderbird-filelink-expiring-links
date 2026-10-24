// Shared-files page: lists this add-on's link shares from the server and revokes them.
// Opened from the provider's settings page with ?accountId=<id>. The list always comes from
// Nextcloud, so it reflects changes made there and needs no local records.
import { addOnShares, deleteUploadedFile, listShares, revokeShare } from "../lib/nextcloud.js";

const accountId = new URLSearchParams(location.search).get("accountId");
const $ = (id) => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function loadAccount() {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  const account = accounts[accountId];
  return account?.appPassword ? account : null;
}

/** A share expires at the end of its expiry date (in the user's Nextcloud time zone). */
function expiryText(expiresAt) {
  if (expiresAt == null) return { text: "Never", expired: false };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return expiresAt < today.getTime()
    ? { text: `Expired ${dateFormat.format(expiresAt)}`, expired: true }
    : { text: dateFormat.format(expiresAt), expired: false };
}

function renderRow(account, share) {
  const row = $("row").content.firstElementChild.cloneNode(true);
  row.querySelector(".name").textContent = share.name;
  row.querySelector(".folder").textContent = share.folder;
  row.querySelector(".shared").textContent = share.sharedAt ? dateFormat.format(share.sharedAt) : "";
  const expiry = expiryText(share.expiresAt);
  const expires = row.querySelector(".expires");
  expires.textContent = expiry.text;
  expires.classList.toggle("expired", expiry.expired);
  row.querySelector(".password").textContent = share.hasPassword ? "Yes" : "No";

  const result = row.querySelector(".result");
  const copy = row.querySelector(".copy-btn");
  const revoke = row.querySelector(".revoke-btn");
  const remove = row.querySelector(".delete-btn");
  const buttons = () => row.querySelectorAll("button");
  const setBusy = (busy) => {
    for (const b of buttons()) b.disabled = busy || (b === copy && !share.url);
  };

  copy.disabled = !share.url;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(share.url);
      result.textContent = "Link copied.";
    } catch {
      result.textContent = "Could not copy the link.";
    }
  });

  revoke.addEventListener("click", async () => {
    const ok = confirm(
      `Revoke the link for "${share.name}"?\n\nAnyone with the link will no longer be able to download the file. ` +
        "Copies already downloaded are not affected, and the file stays on your server.",
    );
    if (!ok) return;
    setBusy(true);
    result.textContent = "Revoking…";
    try {
      const outcome = await revokeShare(account, share.id);
      row.classList.add("revoked");
      result.textContent = outcome === "gone" ? "Link already removed on the server." : "Link revoked. The file is still on your server.";
      revoke.remove();
      copy.remove();
    } catch (e) {
      result.textContent = `Not revoked: ${e.message}`;
    }
    setBusy(false); // Delete file stays available: a revoked link no longer appears after a refresh
  });

  remove.addEventListener("click", async () => {
    const ok = confirm(
      `Delete "${share.name}" from your server?\n\nThe file and its link are removed; anyone with the link ` +
        "will no longer be able to download it. With Nextcloud's trash bin (on by default) the file goes to " +
        "Deleted files, where it can be restored for a while. Copies already downloaded are not affected.",
    );
    if (!ok) return;
    setBusy(true);
    result.textContent = "Deleting…";
    try {
      const outcome = await deleteUploadedFile(account, share.path);
      row.classList.add("revoked");
      result.textContent = outcome === "gone" ? "The file was already gone from the server." : "File deleted.";
      for (const b of buttons()) b.remove();
    } catch (e) {
      result.textContent = `Not deleted: ${e.message}`;
      setBusy(false);
    }
  });
  return row;
}

async function load() {
  const button = $("refresh-btn");
  button.disabled = true;
  setStatus("Loading…");
  try {
    const account = await loadAccount();
    if (!account) {
      $("shares").hidden = true;
      setStatus("This account is not connected. Open its settings and click Connect.", true);
      return;
    }
    $("who").textContent = `${account.displayName || account.userId} @ ${account.baseUrl}`;
    const shares = addOnShares(await listShares(account));
    const body = $("shares").tBodies[0];
    body.replaceChildren(...shares.map((share) => renderRow(account, share)));
    $("shares").hidden = shares.length === 0;
    setStatus(
      shares.length === 0
        ? "No links created by this add-on are currently shared."
        : `${shares.length} ${shares.length === 1 ? "link" : "links"}.`,
    );
  } catch (e) {
    setStatus(`Could not load the shared files: ${e.message}`, true);
  } finally {
    button.disabled = false;
  }
}

$("refresh-btn").addEventListener("click", load);
load();
