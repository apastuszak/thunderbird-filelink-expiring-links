// Background script: implements the Thunderbird cloudFile provider.
import {
  clampExpiryDays,
  createPublicShare,
  deleteFile,
  deleteShare,
  ensureFolder,
  getCapabilities,
  localDateFromNow,
  originPattern,
  parseShareDate,
  randomPassword,
  revokeAppPassword,
  serverInfo,
  setDownloadLimit,
  uploadFile,
} from "./lib/nextcloud.js";
import {
  addPasswordToHtml,
  addPasswordToPlainText,
  findLinksInHtml,
  findLinksInPlainText,
  passwordMessage,
} from "./lib/message.js";

const DEFAULTS = {
  folder: "Thunderbird attachments",
  expiryDays: 7, // 0 = no expiry requested (server policy may still apply)
  oneTime: false,
  generatePassword: false,
  passwordDelivery: "ask", // ask | separate | same | self
};

const aborters = new Map(); // fileId -> AbortController
// Per compose tab: one password shared by its new links, the links (fileId -> { url, name, password,
// key }), and how the user wants the password delivered. Mirrored in the upload records, so a draft
// reopened in a later session can be recovered at send time (see recoverDraft).
const drafts = new Map(); // tabId -> { tabId, accountId, password, links, delivery, recipients }

// ---- storage helpers -------------------------------------------------------
// One key per upload: parallel uploads would lose records if they shared one object.

// Thunderbird numbers both fileIds and tab IDs from 1 again in every session (parent/ext-cloudFile.js,
// parent/ext-mail.js), while records of unsent drafts outlive the session. So keys and the
// "sent from this window" match include an ID for this run of the add-on.
const SESSION = randomId();
const uploadKey = (accountId, fileId) => `upload:${accountId}:${SESSION}:${fileId}`;
const UPLOAD_PREFIX = "upload:";
const PENDING_PREFIX = "pendingDelete:";
const PASSWORD_EMAIL_PREFIX = "pendingPasswordEmail:";
const openingPasswordEmails = new Set();
// Records hold the link's password until the message is sent (then they are deleted), so drafts
// survive a restart. Drop leftovers, e.g. drafts kept for months or never sent.
const UPLOAD_RECORD_MAX_AGE = 90 * 24 * 60 * 60 * 1000;

async function getAccount(accountId) {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  const account = accounts[accountId];
  if (!account?.appPassword) throw new Error("This Nextcloud account is not connected. Open its settings and click Connect.");
  return { ...DEFAULTS, ...account };
}

/** Gives up the host permission once no connected account needs it (the pattern covers all ports). */
async function releaseOrigin(baseUrl, accounts) {
  const pattern = originPattern(baseUrl);
  const inUse = Object.values(accounts).some((a) => a.appPassword && a.baseUrl && originPattern(a.baseUrl) === pattern);
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

/**
 * Whether a saved upload or cleanup job was made on the server and user the account is connected
 * to now. After Disconnect and Connect to another server or user, a saved share ID names a
 * different, unrelated share there (IDs are sequential), so it must not be deleted. Saves from
 * before the server was recorded cannot be checked and are skipped: at worst a file is left to expire.
 */
const madeHere = (settings, job) => !!job.server && job.server === settings.baseUrl && job.userId === settings.userId;

/** Removes a saved upload if it belongs to the current connection. Returns false if it was skipped. */
async function removeSavedUpload(settings, job) {
  if (!madeHere(settings, job)) {
    console.warn("Skipping cleanup of an upload made on another server or account.");
    return false;
  }
  await removeUpload(settings, job);
  return true;
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

/** Saves the message's delivery choice with its upload records, for recovery after a restart. */
async function persistDelivery(draft) {
  const keys = [...draft.links.values()].map((link) => link.key);
  const stored = await browser.storage.local.get(keys);
  for (const record of Object.values(stored)) record.delivery = draft.delivery;
  await browser.storage.local.set(stored);
}

/**
 * For when the user sends the password themselves: copy it, and only if that fails show it in a
 * notification (which may linger in the notification centre).
 */
async function handOverPasswords(entries) {
  const groups = new Map();
  for (const { name, password } of entries) {
    if (!groups.has(password)) groups.set(password, new Set());
    groups.get(password).add(name);
  }
  // One clipboard write: copying each password in turn would leave only the last one available.
  // Preserve the bare password for a single group so it can still be pasted straight into Nextcloud.
  const multiple = groups.size > 1;
  const fileNames = [...new Set(entries.map(({ name }) => name))].join(", ");
  const text = multiple
    ? [...groups].map(([password, names]) => `${[...names].join(", ")}: ${password}`).join("\n")
    : groups.keys().next().value;
  const copied = await navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
  if (copied) {
    notify(multiple ? "Link passwords copied" : "Link password copied",
      multiple
        ? `The passwords for all links are on your clipboard, labeled by file name. ${DELIVERY_NOTES.self}`
        : `${fileNames}: the password is on your clipboard. ${DELIVERY_NOTES.self}`);
  } else {
    notify(multiple ? "Link passwords" : "Link password",
      `${multiple ? text : `${fileNames}: ${text}`}\n${DELIVERY_NOTES.self}`);
  }
}

/**
 * Asks once per message how to deliver the password, or applies the saved choice. The clipboard is
 * only used when the user sends the password themselves: elsewhere it would linger, and on a Mac
 * Universal Clipboard would copy it to the user's other devices.
 */
async function announcePassword(fileName, password, draft, preference) {
  if (!draft) return handOverPasswords([{ name: fileName, password }]); // no compose tab to work with
  if (draft.delivery) return; // already decided for this message
  if (preference !== "ask" && DELIVERY_NOTES[preference]) {
    draft.delivery = preference;
    await persistDelivery(draft);
    if (preference === "self") return handOverPasswords([{ name: fileName, password }]);
    notify("Link password", `${fileName}: ${DELIVERY_NOTES[preference]}`);
    return;
  }
  // Matches the option the window shows selected, so closing it does what it showed.
  draft.delivery = "separate";
  await persistDelivery(draft);
  try {
    await browser.windows.create({
      url: `/password/password.html?tabId=${draft.tabId}`,
      type: "popup",
      width: 480,
      height: 480,
    });
  } catch (e) {
    console.warn("Could not open the password window:", e.message);
    draft.delivery = "self";
    await persistDelivery(draft);
    await handOverPasswords([{ name: fileName, password }]);
  }
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
    if (settings.oneTime && settings.downloadLimit === false) {
      throw new Error("One-time download needs the Download Limit app on the Nextcloud server. Turn the option off in this account's settings, or ask the admin to install the app.");
    }
    // One random sub-folder per upload avoids name collisions without renaming the file.
    folder = `${settings.folder.replace(/^\/+|\/+$/g, "")}/${randomId()}`;
    const davPath = `${folder}/${fileInfo.name}`;
    await ensureFolder(settings, folder);
    await uploadFile(settings, davPath, fileInfo.data, { signal: controller.signal });

    const wantsPassword = settings.generatePassword || settings.policy?.passwordEnforced;
    const draft = wantsPassword ? draftFor(account.id, tab) : null;
    const password = wantsPassword ? (draft?.password ?? randomPassword()) : undefined;
    const expiryDays = clampExpiryDays(settings.expiryDays, settings.policy);
    const createShare = (days) =>
      createPublicShare(settings, {
        path: "/" + davPath,
        password,
        expireDate: days > 0 ? localDateFromNow(days) : undefined,
        label: "Thunderbird",
        signal: controller.signal,
      });
    try {
      share = await createShare(expiryDays);
    } catch (e) {
      // Nextcloud checks an enforced maximum against the date in the user's Nextcloud time zone,
      // which can be a day behind this computer's; it then rejects the request rather than
      // shortening it. Retry one day shorter, but only if Nextcloud answered (e.ocsStatus): after
      // a network error the first share may exist, and a retry would add a second public link.
      const max = Number(settings.policy?.expireDays);
      const atMax = settings.policy?.expireEnforced && max > 1 && expiryDays >= max;
      if (!atMax || e.ocsStatus == null || e.ocsStatus === 401 || controller.signal.aborted) throw e;
      share = await createShare(expiryDays - 1);
    }

    if (settings.oneTime) {
      try {
        await setDownloadLimit(settings, share.token, 1);
      } catch (e) {
        // Never hand out an unlimited link when the user asked for one-time. The catch below cleans up.
        throw new Error(`One-time download could not be applied: ${e.message}. Is the Download Limit app installed?`);
      }
    }

    const key = uploadKey(account.id, fileInfo.id);
    await browser.storage.local.set({
      [key]: {
        shareId: share.id,
        davPath,
        accountId: account.id,
        server: settings.baseUrl,
        userId: settings.userId,
        session: SESSION,
        tabId: tab?.id,
        createdAt: Date.now(),
        url: share.url,
        name: fileInfo.name,
        password,
        delivery: draft?.delivery ?? null,
      },
    });

    if (password) {
      draft?.links.set(fileInfo.id, { url: share.url, name: fileInfo.name, password, key });
      announcePassword(fileInfo.name, password, draft, settings.passwordDelivery).catch((e) =>
        console.warn("Could not record how to deliver the link password:", e.message),
      );
    }

    const templateInfo = {};
    const expiresAt = parseShareDate(share.expiration);
    if (expiresAt != null) templateInfo.download_expiry_date = { timestamp: expiresAt, format: { dateStyle: "long" } };
    if (settings.oneTime) templateInfo.download_limit = 1;
    if (password) templateInfo.download_password_protected = true;

    return { url: share.url, templateInfo };
  } catch (error) {
    // Do not leave an unshared or half-configured file behind on the server.
    if (folder) {
      const job = {
        accountId: account.id,
        server: settings.baseUrl,
        userId: settings.userId,
        shareId: share?.id,
        folder,
      };
      try {
        await removeUpload(settings, job);
      } catch {
        // Keep the original connection identity: a reconnect must not delete unrelated files.
        // A random key also survives restarts and reuse of Thunderbird's file IDs.
        try {
          await browser.storage.local.set({ [PENDING_PREFIX + randomId()]: job });
          console.warn("Upload cleanup failed; saved for retry on next start.");
        } catch {
          // Storage failure must not replace the upload error or reject the cloudFile listener.
          console.warn("Upload cleanup failed and could not be saved for retry.");
        }
      }
    }
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
  const job = {
    accountId: account.id,
    server: info.server,
    userId: info.userId,
    shareId: info.shareId,
    folder: parentFolder(info.davPath),
  };
  try {
    await removeSavedUpload(await getAccount(account.id), job);
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
  for (const [key, job] of Object.entries(all)) {
    if (key.startsWith(PASSWORD_EMAIL_PREFIX) && job.accountIds?.includes(accountId)) {
      stale.push(key, ...job.uploadKeys);
      await browser.notifications.clear(key).catch(() => {});
    }
  }
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
    await persistDelivery(draft);
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

/**
 * A message may contain this add-on's password links that its compose window knows nothing about:
 * a draft reopened after closing it or after a restart, possibly with new links added since. Find
 * them by URL among the stored upload records, outside quoted text, and merge them into `draft`
 * (or recover one, restoring the delivery choice saved for them). Returns the resulting draft.
 */
async function recoverDraft(tabId, details, draft) {
  const all = await browser.storage.local.get(null);
  const known = new Set([...(draft?.links.values() ?? [])].map((link) => link.key));
  const records = Object.entries(all).filter(
    ([k, r]) => k.startsWith(UPLOAD_PREFIX) && r.password && r.url && !known.has(k),
  );
  if (!records.length) return draft;
  const urls = records.map(([, r]) => r.url);
  const found = details.isPlainText
    ? findLinksInPlainText(details.plainTextBody ?? "", urls)
    : findLinksInHtml(new DOMParser().parseFromString(details.body ?? "", "text/html"), urls);
  const mine = records.filter(([, r]) => found.includes(r.url));
  if (!mine.length) return draft;
  const links = mine.map(([key, r]) => [key, { url: r.url, name: r.name, password: r.password, key }]);

  if (draft?.delivery) {
    // Older links in a message that also has new ones: deliver them the same way.
    for (const [key, link] of links) draft.links.set(key, link);
    if (draft.delivery === "self") await handOverPasswords([...draft.links.values()]);
    await persistDelivery(draft);
    return draft;
  }

  const accountId = mine[0][1].accountId;
  let delivery = mine.map(([, r]) => r.delivery).find((d) => DELIVERY_NOTES[d]);
  if (!delivery) {
    // Never asked (the window was not answered before closing): no time to ask now, mid-send.
    const preference = (await getAccount(accountId).catch(() => null))?.passwordDelivery;
    delivery = DELIVERY_NOTES[preference] ? preference : "separate";
  }
  const recovered = { tabId, accountId, password: mine[0][1].password, links: new Map(links), delivery };
  drafts.set(tabId, recovered);
  if (delivery === "self") {
    // The clipboard from the earlier session is long gone.
    await handOverPasswords([...recovered.links.values()]);
  } else {
    notify("Link password", `This message has password-protected links from an earlier session. ${DELIVERY_NOTES[delivery]}`);
  }
  return recovered;
}

browser.compose.onBeforeSend.addListener(async (tab, details) => {
  // Recovery must never block sending: on any error, carry on with what this window knows.
  const current = drafts.get(tab.id);
  const draft = await recoverDraft(tab.id, details, current).catch((e) => {
    console.warn("Could not check the message for earlier password links:", e.message);
    return current;
  });
  if (!draft?.links.size) return {};
  if (draft.delivery === "separate") {
    const { to, cc, bcc, subject, identityId } = details;
    draft.recipients = { to, cc, bcc, subject, identityId };
    return {};
  }
  if (draft.delivery !== "same") return {};
  // Thunderbird waits for this listener and never completes the send if it throws, leaving the
  // compose window locked. So never throw: cancel instead, and fall back to a separate email.
  try {
    const entries = [...draft.links.values()];
    if (details.isPlainText) {
      return { details: { plainTextBody: addPasswordToPlainText(details.plainTextBody, entries) } };
    }
    const doc = new DOMParser().parseFromString(details.body, "text/html");
    addPasswordToHtml(doc, entries);
    return { details: { body: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}` } };
  } catch (e) {
    console.warn("Could not add the link password to the message:", e.message);
    draft.delivery = "separate";
    await persistDelivery(draft).catch(() => {});
    notify(
      "Message not sent",
      "The link password could not be added to this message. Click Send again to send it without the password; a separate email with the password will then open.",
    );
    return { cancel: true };
  }
});

browser.compose.onAfterSend.addListener(async (tab, sendInfo) => {
  if (sendInfo.error) return; // keep the draft state; the user may try sending again
  // Sent attachments are never deleted through cloudFile, so their records (and stored passwords)
  // are done with: this window's own, and any recovered from an earlier session.
  const draft = drafts.get(tab.id);
  const recovered = new Set([...(draft?.links.values() ?? [])].map((link) => link.key));
  const all = await browser.storage.local.get(null);
  const ownWindow = (r) => r.session === SESSION && r.tabId === tab.id;
  const sent = Object.keys(all).filter((k) => k.startsWith(UPLOAD_PREFIX) && (ownWindow(all[k]) || recovered.has(k)));
  if (draft?.delivery === "separate" && draft.recipients && draft.links.size) {
    // Persist the recipients and passwords before opening a window: the original compose tab may
    // close, and a failed beginNew must remain recoverable even after Thunderbird restarts.
    const key = PASSWORD_EMAIL_PREFIX + randomId();
    await browser.storage.local.set({
      [key]: {
        details: passwordMessage(draft.recipients, [...draft.links.values()]),
        uploadKeys: sent,
        accountIds: [...new Set([draft.accountId, ...sent.map((k) => all[k].accountId)])],
        createdAt: Date.now(),
      },
    });
    // The durable job now owns password delivery. Keeping URL-bearing upload records would
    // let recovery treat a forward of the sent message as another draft needing its password.
    await browser.storage.local.remove(sent);
    drafts.delete(tab.id);
    await openPasswordEmail(key);
    return;
  }
  drafts.delete(tab.id);
  await browser.storage.local.remove(sent);
});

/** Log API errors without including password/body tokens, recipients, or URLs echoed by validation. */
function logPasswordEmailFailure(error, job) {
  let message = String(error?.message || "Unknown error");
  const details = job?.details;
  const sensitive = [
    ...(details?.plainTextBody?.split(/\s+/).filter((word) => word.length >= 8) || []),
    ...[details?.to, details?.cc, details?.bcc].flat().filter((value) => typeof value === "string"),
  ];
  for (const value of sensitive.sort((a, b) => b.length - a.length)) message = message.replaceAll(value, "[redacted]");
  message = message.replace(/https?:\/\/\S+|[^\s<>@]+@[^\s<>@]+/g, "[redacted]");
  console.warn("Could not open the password email:", message);
}

/** Retain passwords until their separate email opens, or until the retention period expires. */
async function openPasswordEmail(key) {
  if (openingPasswordEmails.has(key)) return;
  openingPasswordEmails.add(key);
  let job;
  try {
    ({ [key]: job } = await browser.storage.local.get(key));
    if (!job) return;
    // Also clean leftovers from older jobs or a failed removal immediately after saving a job.
    await browser.storage.local.remove(job.uploadKeys);
    if (!(job.createdAt > Date.now() - UPLOAD_RECORD_MAX_AGE)) {
      await browser.storage.local.remove([...job.uploadKeys, key]);
      await browser.notifications.clear(key).catch(() => {});
      return;
    }
    // Never send automatically: the user checks the recipients and sends this draft themselves.
    try {
      await browser.compose.beginNew(job.details);
    } catch (e) {
      // With accountsRead, Thunderbird resolves this identity before opening a window.
      // Retry only its explicit missing-identity error; other failures may have opened a window.
      if (!job.details.identityId || e.message !== `Identity not found: ${job.details.identityId}`) throw e;
      logPasswordEmailFailure(e, job);
      delete job.details.identityId;
      await browser.storage.local.set({ [key]: job });
      await browser.compose.beginNew(job.details);
      notify("Check the password email's From address",
        "The original sending identity no longer exists. The password draft uses your default identity. Check From before sending.");
    }
    await browser.storage.local.remove([...job.uploadKeys, key]);
    await browser.notifications.clear(key).catch(() => {});
  } catch (e) {
    logPasswordEmailFailure(e, job);
    await browser.notifications.create(key, {
      type: "basic",
      title: "Password email could not be opened",
      message: "Your original email was sent. The link passwords are saved. Click this notification to retry opening the password email, or restart Thunderbird to retry.",
    }).catch(() => {});
  } finally {
    openingPasswordEmails.delete(key);
  }
}

browser.notifications.onClicked.addListener((id) => {
  if (id.startsWith(PASSWORD_EMAIL_PREFIX)) return openPasswordEmail(id);
});

async function retryPasswordEmails() {
  const all = await browser.storage.local.get(null);
  for (const key of Object.keys(all)) {
    if (key.startsWith(PASSWORD_EMAIL_PREFIX)) await openPasswordEmail(key);
  }
}

async function retryPendingDeletes() {
  const all = await browser.storage.local.get(null);
  for (const [key, job] of Object.entries(all)) {
    if (!key.startsWith(PENDING_PREFIX)) continue;
    try {
      await removeSavedUpload(await getAccount(job.accountId), job); // skipped jobs are dropped too
      await browser.storage.local.remove(key);
    } catch {
      // Offline or disconnected: try again next start.
    }
  }
}

/**
 * Thunderbird keeps an account's "configured" flag in memory only: every add-on account starts
 * unconfigured (parent/ext-cloudFile.js) and shows a warning until told otherwise. Restore it
 * from storage on every start.
 */
async function restoreConfiguredState() {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  for (const account of await browser.cloudFile.getAllAccounts()) {
    const configured = !!accounts[account.id]?.appPassword;
    if (account.configured !== configured) await browser.cloudFile.updateAccount(account.id, { configured });
  }
}

/** Drops upload records of messages sent before this version, or kept as drafts for months. */
async function pruneUploadRecords() {
  const all = await browser.storage.local.get(null);
  const cutoff = Date.now() - UPLOAD_RECORD_MAX_AGE;
  const stale = Object.keys(all).filter((k) => k.startsWith(UPLOAD_PREFIX) && !(all[k].createdAt > cutoff));
  await browser.storage.local.remove(stale);
}

/** Re-reads sharing policy, chunk size and Download Limit availability; the admin may have changed them. */
async function refreshServerInfo() {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  for (const [id, account] of Object.entries(accounts)) {
    if (!account.appPassword) continue;
    try {
      const info = serverInfo(await getCapabilities(account));
      // Re-read just before writing, to keep changes made meanwhile (e.g. in the options page).
      const { accounts: latest = {} } = await browser.storage.local.get("accounts");
      if (!latest[id]?.appPassword) continue;
      latest[id] = { ...latest[id], ...info };
      if (info.policy.passwordEnforced) latest[id].generatePassword = true;
      await browser.storage.local.set({ accounts: latest });
    } catch (e) {
      console.warn("Could not refresh server settings:", e.message); // offline: keep the stored ones
    }
  }
}

restoreConfiguredState();
retryPendingDeletes();
pruneUploadRecords();
refreshServerInfo();
retryPasswordEmails();
