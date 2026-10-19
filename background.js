// Background script: implements the Thunderbird cloudFile provider.
import {
  clampExpiryDays,
  createPublicShare,
  deleteFile,
  deleteShare,
  ensureFolder,
  localDateFromNow,
  originPattern,
  parseShareDate,
  randomPassword,
  revokeAppPassword,
  setDownloadLimit,
  uploadFile,
} from "./lib/nextcloud.js";
import { addPasswordToHtml, addPasswordToPlainText, passwordMessage } from "./lib/message.js";

const DEFAULTS = {
  folder: "Thunderbird attachments",
  expiryDays: 7, // 0 = no expiry requested (server policy may still apply)
  oneTime: false,
  generatePassword: false,
  passwordDelivery: "ask", // ask | separate | same | self
};

const aborters = new Map(); // fileId -> AbortController
// Per compose tab: one password shared by all its links, the links that use it (fileId -> url),
// and how the user wants the password delivered. Kept in memory only.
const drafts = new Map(); // tabId -> { tabId, accountId, password, links, delivery, recipients }

// ---- storage helpers -------------------------------------------------------
// One key per upload: parallel uploads would lose records if they shared one object.

const uploadKey = (accountId, fileId) => `upload:${accountId}:${fileId}`;
const PENDING_PREFIX = "pendingDelete:";

async function getAccount(accountId) {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  const account = accounts[accountId];
  if (!account?.appPassword) throw new Error("This Nextcloud account is not connected. Open its settings and click Connect.");
  return { ...DEFAULTS, ...account };
}

/** Gives up the host permission once no connected account uses that server. */
async function releaseOrigin(baseUrl, accounts) {
  const origin = new URL(baseUrl).origin;
  const inUse = Object.values(accounts).some((a) => a.appPassword && a.baseUrl && new URL(a.baseUrl).origin === origin);
  if (!inUse) await browser.permissions.remove({ origins: [originPattern(baseUrl)] }).catch(() => {});
}

// ---- small utilities -------------------------------------------------------

function randomId(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const parentFolder = (davPath) => davPath.split("/").slice(0, -1).join("/");

/** Deleting the per-upload folder also removes any share on the file inside it. */
async function removeUpload(settings, { shareId, folder }) {
  if (shareId != null) await deleteShare(settings, shareId).catch(() => {}); // may already be gone
  await deleteFile(settings, folder);
}

function draftFor(accountId, tab) {
  if (tab?.id == null) return null;
  let draft = drafts.get(tab.id);
  if (!draft) {
    draft = { tabId: tab.id, accountId, password: randomPassword(), links: new Map(), delivery: null };
    drafts.set(tab.id, draft);
  }
  return draft;
}

function notify(title, message) {
  browser.notifications.create({ type: "basic", title, message });
}

const DELIVERY_NOTES = {
  separate: "After you send this message, a second email with the password opens for you to send.",
  same: "The password will be added below the link when you send this message.",
  self: "Send it to the recipient separately, not in this email.",
};

/**
 * Copies the password, then asks once per message how to deliver it (or applies the saved choice).
 * The password is only shown in a notification if neither the clipboard nor a compose tab is available.
 */
async function announcePassword(fileName, password, draft, preference) {
  const copied = await navigator.clipboard.writeText(password).then(
    () => true,
    () => false,
  );
  if (!draft) {
    if (copied) notify("Link password copied", `${fileName}: the password is on your clipboard. ${DELIVERY_NOTES.self}`);
    else notify("Link password", `${fileName}: ${password}\n${DELIVERY_NOTES.self}`);
    return;
  }
  if (draft.delivery) return; // already decided for this message
  if (preference !== "ask" && DELIVERY_NOTES[preference]) {
    draft.delivery = preference;
    if (copied) notify("Link password copied", `${fileName}: ${DELIVERY_NOTES[preference]}`);
    else notify("Link password", `${fileName}: ${password}\n${DELIVERY_NOTES[preference]}`);
    return;
  }
  draft.delivery = "self"; // until the user picks something else
  await browser.windows.create({
    url: `/password/password.html?tabId=${draft.tabId}`,
    type: "popup",
    width: 480,
    height: 460,
  });
}

// ---- cloudFile listeners ---------------------------------------------------

browser.cloudFile.onFileUpload.addListener(async (account, fileInfo, tab) => {
  const controller = new AbortController();
  aborters.set(fileInfo.id, controller);

  let settings;
  let folder; // set once we may have created something on the server
  let share;
  try {
    settings = await getAccount(account.id);
    // One random sub-folder per upload avoids name collisions without renaming the file.
    folder = `${settings.folder.replace(/^\/+|\/+$/g, "")}/${randomId()}`;
    const davPath = `${folder}/${fileInfo.name}`;
    await ensureFolder(settings, folder);
    await uploadFile(settings, davPath, fileInfo.data, { signal: controller.signal });

    const wantsPassword = settings.generatePassword || settings.policy?.passwordEnforced;
    const draft = wantsPassword ? draftFor(account.id, tab) : null;
    const password = wantsPassword ? (draft?.password ?? randomPassword()) : undefined;
    const expiryDays = clampExpiryDays(settings.expiryDays, settings.policy);
    const expireDate = expiryDays > 0 ? localDateFromNow(expiryDays) : undefined;
    share = await createPublicShare(settings, {
      path: "/" + davPath,
      password,
      expireDate,
      label: "Thunderbird",
      signal: controller.signal,
    });

    if (settings.oneTime) {
      try {
        await setDownloadLimit(settings, share.token, 1);
      } catch (e) {
        // Never hand out an unlimited link when the user asked for one-time. The catch below cleans up.
        throw new Error(`One-time download could not be applied: ${e.message}. Is the Download Limit app installed?`);
      }
    }

    await browser.storage.local.set({ [uploadKey(account.id, fileInfo.id)]: { shareId: share.id, davPath } });

    if (password) {
      draft?.links.set(fileInfo.id, share.url);
      announcePassword(fileInfo.name, password, draft, settings.passwordDelivery);
    }

    const templateInfo = {};
    const expiresAt = parseShareDate(share.expiration);
    if (expiresAt != null) templateInfo.download_expiry_date = { timestamp: expiresAt, format: { dateStyle: "long" } };
    if (settings.oneTime) templateInfo.download_limit = 1;
    if (password) templateInfo.download_password_protected = true;

    return { url: share.url, templateInfo };
  } catch (error) {
    // Do not leave an unshared or half-configured file behind on the server.
    if (folder) await removeUpload(settings, { shareId: share?.id, folder }).catch(() => {});
    if (controller.signal.aborted) return { aborted: true };
    return { error: error.message };
  } finally {
    aborters.delete(fileInfo.id);
  }
});

browser.cloudFile.onFileUploadAbort.addListener((account, fileId) => {
  aborters.get(fileId)?.abort();
});

browser.cloudFile.onFileDeleted.addListener(async (account, fileId, tab) => {
  if (tab?.id != null) drafts.get(tab.id)?.links.delete(fileId);
  const key = uploadKey(account.id, fileId);
  const { [key]: info } = await browser.storage.local.get(key);
  if (!info) return;
  const job = { accountId: account.id, shareId: info.shareId, folder: parentFolder(info.davPath) };
  try {
    await removeUpload(await getAccount(account.id), job);
    await browser.storage.local.remove(key);
  } catch (e) {
    // Keep it under a key that a new upload with a reused fileId cannot overwrite; retried at startup.
    console.warn("Cleanup failed, will retry on next start:", e.message);
    await browser.storage.local.set({ [PENDING_PREFIX + randomId()]: job });
    await browser.storage.local.remove(key);
  }
});

browser.cloudFile.onAccountDeleted.addListener(async (accountId) => {
  const all = await browser.storage.local.get(null);
  const accounts = all.accounts || {};
  const account = accounts[accountId];
  // Links already sent keep working; only the credential is revoked.
  if (account?.appPassword) {
    await revokeAppPassword(account).catch((e) => console.warn("Could not revoke app password:", e.message));
  }
  delete accounts[accountId];
  await browser.storage.local.set({ accounts });
  const stale = Object.keys(all).filter(
    (k) => k.startsWith(`upload:${accountId}:`) || (k.startsWith(PENDING_PREFIX) && all[k].accountId === accountId),
  );
  await browser.storage.local.remove(stale);
  if (account?.baseUrl) await releaseOrigin(account.baseUrl, accounts);
});

browser.tabs.onRemoved.addListener((tabId) => drafts.delete(tabId));

// ---- password delivery -----------------------------------------------------

// The password window (password/password.js) reads the password and reports the user's choice.
browser.runtime.onMessage.addListener(async (message) => {
  const draft = drafts.get(message?.tabId);
  if (!draft) return null;
  if (message.type === "password:get") {
    return { password: draft.password, links: draft.links.size, delivery: draft.delivery };
  }
  if (message.type === "password:set" && DELIVERY_NOTES[message.delivery]) {
    draft.delivery = message.delivery;
    if (message.remember) {
      const { accounts = {} } = await browser.storage.local.get("accounts");
      if (accounts[draft.accountId]) {
        accounts[draft.accountId].passwordDelivery = message.delivery;
        await browser.storage.local.set({ accounts });
      }
    }
    return true;
  }
  return null;
});

browser.compose.onBeforeSend.addListener(async (tab, details) => {
  const draft = drafts.get(tab.id);
  if (!draft?.links.size) return {};
  if (draft.delivery === "separate") {
    const { to, cc, bcc, subject, identityId } = details;
    draft.recipients = { to, cc, bcc, subject, identityId };
    return {};
  }
  if (draft.delivery !== "same") return {};
  const urls = [...draft.links.values()];
  if (details.isPlainText) {
    return { details: { plainTextBody: addPasswordToPlainText(details.plainTextBody, urls, draft.password) } };
  }
  const doc = new DOMParser().parseFromString(details.body, "text/html");
  addPasswordToHtml(doc, urls, draft.password);
  return { details: { body: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}` } };
});

browser.compose.onAfterSend.addListener(async (tab, sendInfo) => {
  if (sendInfo.error) return; // keep the draft state; the user may try sending again
  const draft = drafts.get(tab.id);
  drafts.delete(tab.id);
  if (draft?.delivery !== "separate" || !draft.recipients || !draft.links.size) return;
  // Opened as a draft, not sent: the user checks the recipients and sends it themselves.
  await browser.compose.beginNew(passwordMessage(draft.recipients, draft.password, draft.links.size));
});

async function retryPendingDeletes() {
  const all = await browser.storage.local.get(null);
  for (const [key, job] of Object.entries(all)) {
    if (!key.startsWith(PENDING_PREFIX)) continue;
    try {
      await removeUpload(await getAccount(job.accountId), job);
      await browser.storage.local.remove(key);
    } catch {
      // Offline or disconnected: try again next start.
    }
  }
}

retryPendingDeletes();
