// End-to-end tests of background.js against a fake Thunderbird API. Each "session" imports a fresh
// copy of the script, as a Thunderbird restart would, while storage persists across them.
// Messages are plain text, so no HTML parser is needed.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { localDateFromNow } from "../lib/nextcloud.js";

const store = {};
const log = [];
let listeners;
let sessions = 0;
let shares = 0;
let shareRequests = [];
let rejectShare = () => null; // (form) => Response to send instead of creating the share, or null
let capabilities = {}; // what the fake server reports; background.js re-reads it on every start

const clone = (value) => structuredClone(value);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function installBrowser() {
  listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  globalThis.browser = {
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return clone(store);
          const out = {};
          for (const key of [].concat(keys)) if (key in store) out[key] = clone(store[key]);
          return out;
        },
        set: async (items) => void Object.assign(store, clone(items)),
        remove: async (keys) => [].concat(keys).forEach((key) => delete store[key]),
      },
    },
    cloudFile: {
      onFileUpload: on("upload"),
      onFileUploadAbort: on("abort"),
      onFileDeleted: on("deleted"),
      onAccountDeleted: on("accountDeleted"),
      getAllAccounts: async () => [],
      updateAccount: async () => {},
    },
    compose: {
      onBeforeSend: on("beforeSend"),
      onAfterSend: on("afterSend"),
      beginNew: async (details) => void log.push(["beginNew", details]),
    },
    tabs: { onRemoved: on("tabRemoved") },
    runtime: { onMessage: on("message") },
    notifications: { create: (n) => void log.push(["notify", n.message]) },
    windows: { create: async (w) => void log.push(["window", w.url]) },
    permissions: { remove: async () => {} },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text) => void log.push(["clipboard", text]) } },
    configurable: true,
  });
  globalThis.fetch = async (url, init = {}) => {
    if (url.includes("/apps/files_sharing/api/v1/shares") && init.method === "POST") {
      const form = Object.fromEntries(init.body);
      shareRequests.push(form);
      const rejection = rejectShare(form);
      if (rejection) return rejection;
      shares++;
      const token = `tok${String(shares).padStart(12, "0")}`; // 15 characters, like Nextcloud's
      const data = { id: String(shares), token, url: `https://cloud.example.com/s/${token}`, expiration: null };
      return new Response(JSON.stringify({ ocs: { meta: { statuscode: 200 }, data } }), { status: 200 });
    }
    if (url.includes("/ocs/")) {
      return new Response(JSON.stringify({ ocs: { meta: { statuscode: 200 }, data: { capabilities } } }), { status: 200 });
    }
    return new Response(null, { status: 201 });
  };
}

/** Starts the add-on, as Thunderbird does on launch: a fresh module instance, same storage. */
async function startSession() {
  installBrowser();
  await import(`../background.js?session=${++sessions}`);
  await tick();
}

async function upload(fileId, tabId) {
  const result = await listeners.upload({ id: "acc1" }, { id: fileId, name: `file${fileId}.pdf`, data: new Blob(["x"]) }, { id: tabId });
  await tick();
  return result;
}

const plainMessage = (text, to = "bob@example.com") => ({
  to: [to],
  cc: [],
  bcc: [],
  subject: "Files",
  identityId: "id1",
  isPlainText: true,
  plainTextBody: text,
});

async function send(tabId, details) {
  const result = await listeners.beforeSend({ id: tabId }, details);
  await listeners.afterSend({ id: tabId }, { mode: "sendNow" });
  return result;
}

const passwordEmails = () => log.filter(([kind]) => kind === "beginNew").map(([, details]) => details);
const records = () => Object.entries(store).filter(([key]) => key.startsWith("upload:"));

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  log.length = 0;
  shareRequests = [];
  rejectShare = () => null;
  capabilities = {};
  store.accounts = {
    acc1: {
      baseUrl: "https://cloud.example.com",
      loginName: "alice",
      appPassword: "app-password",
      userId: "alice",
      generatePassword: true,
      passwordDelivery: "separate",
    },
  };
});

describe("password links across Thunderbird sessions", () => {
  it("keeps a saved draft's password when a later session reuses its fileId and tab ID", async () => {
    // Session 1: a draft with a password link in tab 3, saved and closed.
    await startSession();
    const draftLink = (await upload(1, 3)).url;
    const draftPassword = records()[0][1].password;
    listeners.tabRemoved(3);

    // Session 2: Thunderbird counts from 1 again, so a new message gets fileId 1 in tab 3 too.
    await startSession();
    const newLink = (await upload(1, 3)).url;
    assert.equal(records().length, 2, "the new upload does not overwrite the draft's record");
    await send(3, plainMessage(`New message\nLink: ${newLink}`));
    assert.equal(records().length, 1, "sending tab 3 removes only its own record");

    // The draft is reopened (new tab) and sent: its password is still delivered.
    log.length = 0;
    await send(8, plainMessage(`Reopened draft\nLink: ${draftLink}`, "carol@example.com"));
    const [mail] = passwordEmails();
    assert.deepEqual(mail?.to, ["carol@example.com"]);
    assert.match(mail.plainTextBody, new RegExp(`\\n${draftPassword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n$`));
    assert.equal(records().length, 0, "the stored password is deleted once sent");
  });

  it("never picks up a link that only appears in quoted text", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    listeners.tabRemoved(3);
    log.length = 0;
    await send(5, plainMessage(`My reply\n\n> Earlier mail\n> Link: ${link}`, "eve@example.com"));
    assert.deepEqual(passwordEmails(), []);
    assert.equal(records().length, 1, "the unsent draft's record is kept");
  });

  it("does not mistake a longer link for a stored one", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    listeners.tabRemoved(3);
    log.length = 0;
    await send(5, plainMessage(`Link: ${link}X`, "eve@example.com"));
    assert.deepEqual(passwordEmails(), []);
  });

  it("adds the password below the link when the saved choice is the same email", async () => {
    store.accounts.acc1.passwordDelivery = "same";
    await startSession();
    const link = (await upload(1, 3)).url;
    const password = records()[0][1].password;
    listeners.tabRemoved(3);
    await startSession();
    const result = await send(4, plainMessage(`Hi\nLink: ${link}.\nThanks`));
    assert.equal(result.details.plainTextBody, `Hi\nLink: ${link}.\nPassword: ${password}\nThanks`);
  });
});

describe("expiry at the server's enforced maximum", () => {
  const ocsError = (message) =>
    new Response(JSON.stringify({ ocs: { meta: { statuscode: 404, message }, data: [] } }), { status: 404 });

  beforeEach(() => {
    capabilities = { files_sharing: { public: { expire_date: { enabled: true, enforced: true, days: 7 } } } };
    Object.assign(store.accounts.acc1, { generatePassword: false, expiryDays: 7 });
  });

  it("retries one day shorter when Nextcloud's date for the user is a day behind", async () => {
    // Nextcloud's "today" is yesterday here, so today + 7 is 8 days away for it.
    rejectShare = (form) =>
      form.expireDate === localDateFromNow(7) ? ocsError("Cannot set expiration date more than 7 days in the future") : null;
    await startSession();
    const result = await upload(1, 3);
    assert.deepEqual(shareRequests.map((f) => f.expireDate), [localDateFromNow(7), localDateFromNow(6)]);
    assert.match(result.url ?? "", /^https:\/\/cloud\.example\.com\/s\//);
  });

  it("does not retry after a network error, which may already have created the share", async () => {
    let first = true;
    rejectShare = () => {
      if (!first) return null;
      first = false;
      throw new TypeError("NetworkError when attempting to fetch resource.");
    };
    await startSession();
    const result = await upload(1, 3);
    assert.equal(shareRequests.length, 1);
    assert.match(result.error ?? "", /Could not reach Nextcloud/);
  });

  it("does not retry below the maximum", async () => {
    store.accounts.acc1.expiryDays = 3;
    rejectShare = () => ocsError("Some other problem");
    await startSession();
    const result = await upload(1, 3);
    assert.equal(shareRequests.length, 1);
    assert.equal(result.error, "Some other problem");
  });
});
