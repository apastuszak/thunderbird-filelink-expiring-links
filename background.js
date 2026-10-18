// Background script: implements the Thunderbird cloudFile provider.
import {
  createPublicShare,
  deleteFile,
  deleteShare,
  ensureFolder,
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

// ---- storage helpers -------------------------------------------------------

async function getAccount(accountId) {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  const account = accounts[accountId];
  if (!account?.appPassword) throw new Error("This Nextcloud account is not connected. Open its settings and click Connect.");
  return { ...DEFAULTS, ...account };
}

async function rememberUpload(fileId, info) {
  const { uploads = {} } = await browser.storage.local.get("uploads");
  uploads[fileId] = info;
  await browser.storage.local.set({ uploads });
}

async function takeUpload(fileId) {
  const { uploads = {} } = await browser.storage.local.get("uploads");
  const info = uploads[fileId];
  if (info) {
    delete uploads[fileId];
    await browser.storage.local.set({ uploads });
  }
  return info;
}

// ---- small utilities -------------------------------------------------------

function randomId(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomPassword(length = 16) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const values = crypto.getRandomValues(new Uint32Array(length));
  return [...values].map((v) => alphabet[v % alphabet.length]).join("");
}

/** Nextcloud's expireDate is date-granular (YYYY-MM-DD). */
function expireDateFromNow(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// ---- cloudFile listeners ---------------------------------------------------

browser.cloudFile.onFileUpload.addListener(async (account, fileInfo) => {
  const settings = await getAccount(account.id);
  const controller = new AbortController();
  aborters.set(fileInfo.id, controller);

  let davPath;
  let share;
  try {
    // One random sub-folder per upload avoids name collisions without renaming the file.
    const folder = `${settings.folder.replace(/^\/+|\/+$/g, "")}/${randomId()}`;
    davPath = `${folder}/${fileInfo.name}`;
    await ensureFolder(settings, folder);
    await uploadFile(settings, davPath, fileInfo.data, { signal: controller.signal });

    const password = settings.generatePassword ? randomPassword() : undefined;
    const expireDate = settings.expiryDays > 0 ? expireDateFromNow(settings.expiryDays) : undefined;
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
        // Never hand out an unlimited link when the user asked for one-time.
        await deleteShare(settings, share.id).catch(() => {});
        await deleteFile(settings, folder).catch(() => {});
        throw new Error(`One-time download could not be applied: ${e.message}. Is the Download Limit app installed?`);
      }
    }

    await rememberUpload(fileInfo.id, { accountId: account.id, shareId: share.id, davPath });

    if (password) {
      browser.notifications.create({
        type: "basic",
        title: "Nextcloud link password",
        message: `${fileInfo.name}: ${password}\nSend this to the recipient separately.`,
      });
    }

    const templateInfo = {};
    if (share.expiration) {
      const ts = Date.parse(share.expiration.replace(" ", "T") + "Z");
      if (!Number.isNaN(ts)) {
        templateInfo.download_expiry_date = { timestamp: ts, format: { dateStyle: "long" } };
      }
    }
    if (settings.oneTime) templateInfo.download_limit = 1;
    if (password) templateInfo.download_password_protected = true;

    return { url: share.url, templateInfo };
  } catch (error) {
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
  const info = await takeUpload(fileId);
  if (!info) return;
  try {
    const settings = await getAccount(account.id);
    await deleteShare(settings, info.shareId).catch(() => {});
    await deleteFile(settings, info.davPath.split("/").slice(0, -1).join("/")); // remove the per-upload folder
  } catch (e) {
    console.warn("Cleanup failed", e);
  }
});

browser.cloudFile.onAccountDeleted.addListener(async (accountId) => {
  const { accounts = {}, uploads = {} } = await browser.storage.local.get(["accounts", "uploads"]);
  delete accounts[accountId];
  for (const [id, info] of Object.entries(uploads)) if (info.accountId === accountId) delete uploads[id];
  await browser.storage.local.set({ accounts, uploads });
});
