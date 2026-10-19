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

const DEFAULTS = {
  folder: "Thunderbird attachments",
  expiryDays: 7, // 0 = no expiry requested (server policy may still apply)
  oneTime: false,
  generatePassword: false,
};

const aborters = new Map(); // fileId -> AbortController
const tabPasswords = new Map(); // `${accountId}:${tabId}` -> password, so all links in one message share it

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

function passwordFor(accountId, tab) {
  if (tab?.id == null) return { password: randomPassword(), reused: false };
  const key = `${accountId}:${tab.id}`;
  if (tabPasswords.has(key)) return { password: tabPasswords.get(key), reused: true };
  const password = randomPassword();
  tabPasswords.set(key, password);
  return { password, reused: false };
}

function notify(title, message) {
  browser.notifications.create({ type: "basic", title, message });
}

/** Copies the password rather than showing it, so it does not linger in the notification centre. */
async function deliverPassword(fileName, password, reused) {
  const same = reused ? " It is the same password as the other links in this message." : "";
  try {
    await navigator.clipboard.writeText(password);
    notify(
      "Link password copied",
      `${fileName}: the password is on your clipboard. Send it to the recipient separately, not in this email.${same}`,
    );
  } catch {
    // Without the clipboard, the notification is the only way to get the password to the user.
    notify("Link password", `${fileName}: ${password}\nSend it to the recipient separately.${same}`);
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
    // One random sub-folder per upload avoids name collisions without renaming the file.
    folder = `${settings.folder.replace(/^\/+|\/+$/g, "")}/${randomId()}`;
    const davPath = `${folder}/${fileInfo.name}`;
    await ensureFolder(settings, folder);
    await uploadFile(settings, davPath, fileInfo.data, { signal: controller.signal });

    const wantsPassword = settings.generatePassword || settings.policy?.passwordEnforced;
    const { password, reused } = wantsPassword ? passwordFor(account.id, tab) : {};
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

    if (password) deliverPassword(fileInfo.name, password, reused);

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

browser.cloudFile.onFileDeleted.addListener(async (account, fileId) => {
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

browser.tabs.onRemoved.addListener((tabId) => {
  for (const key of tabPasswords.keys()) if (key.endsWith(`:${tabId}`)) tabPasswords.delete(key);
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
