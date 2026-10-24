// End-to-end tests of background.js against a fake Thunderbird API. Each "session" imports a fresh
// copy of the script, as a Thunderbird restart would, while storage persists across them.
// Messages are plain text, so no HTML parser is needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
let identities;
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
let requests = []; // every request background.js makes: { method, url }

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
      beginNew: async (details) => {
        if (details.identityId != null) {
          if (!manifest.permissions.includes("accountsRead")) throw new Error('Using identities requires the "accountsRead" permission');
          if (!identities.has(details.identityId)) throw new Error(`Identity not found: ${details.identityId}`);
        }
        log.push(["beginNew", details]);
      },
    },
    tabs: { onRemoved: on("tabRemoved") },
    runtime: { onMessage: on("message") },
    notifications: {
      create: async (id, options) => {
        const n = options || id;
        log.push(["notify", n.message, options ? id : undefined]);
      },
      clear: async () => true,
      onClicked: on("notificationClicked"),
    },
    windows: { create: async (w) => void log.push(["window", w.url]) },
    permissions: { remove: async () => {} },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text) => void log.push(["clipboard", text]) } },
    configurable: true,
  });
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ method: init.method || "GET", url });
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
    if (init.method === "DELETE") return new Response(null, { status: 204 });
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
  ...(manifest.permissions.includes("accountsRead") ? { identityId: "id-secondary" } : {}),
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
  identities = new Set(["id-default", "id-secondary"]);
  shareRequests = [];
  rejectShare = () => null;
  capabilities = {};
  requests = [];
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
  it("does not recover a sent link for new recipients while its password email is pending", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    const beginNew = browser.compose.beginNew;
    browser.compose.beginNew = async () => { throw new Error("Compose unavailable"); };
    await send(3, plainMessage(link, "original@example.com"));
    assert.equal(records().length, 0, "the pending job replaces the sent upload records");
    browser.compose.beginNew = beginNew;
    await send(4, plainMessage(`Forwarded Message\n${link}`, "new@example.com"));
    assert.equal(passwordEmails().length, 0);
    const key = Object.keys(store).find((k) => k.startsWith("pendingPasswordEmail:"));
    await listeners.notificationClicked(key);
    assert.deepEqual(passwordEmails()[0].to, ["original@example.com"]);
  });

  it("retains upload records if saving the pending password email fails", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    await listeners.beforeSend({ id: 3 }, plainMessage(link));
    browser.storage.local.set = async () => { throw new Error("Storage unavailable"); };
    await assert.rejects(listeners.afterSend({ id: 3 }, {}), /Storage unavailable/);
    assert.equal(records().length, 1);
    assert.equal(passwordEmails().length, 0);
  });

  it("opens the password email from the original non-default identity", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    await send(3, plainMessage(link));
    assert.equal(passwordEmails()[0].identityId, "id-secondary");
  });

  it("keeps the original identity when a queued password email is retried after restart", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    browser.compose.beginNew = async () => { throw new Error("Compose unavailable"); };
    await send(3, plainMessage(link));
    await startSession();
    assert.equal(passwordEmails()[0].identityId, "id-secondary");
  });

  it("falls back to the default only if the queued sending identity has been deleted", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    browser.compose.beginNew = async () => { throw new Error("Compose unavailable"); };
    await send(3, plainMessage(link));
    const job = Object.values(store).find((r) => r.details?.plainTextBody);
    assert.equal(job.details.identityId, "id-secondary");
    const body = job.details.plainTextBody;
    identities.delete("id-secondary");
    await startSession();
    assert.equal(passwordEmails().length, 1);
    assert.equal("identityId" in passwordEmails()[0], false);
    assert.equal(passwordEmails()[0].plainTextBody, body);
    assert.deepEqual(passwordEmails()[0].to, ["bob@example.com"]);
    assert.equal(records().length, 0);
  });

  it("hands over old and new passwords together for self-delivery", async () => {
    store.accounts.acc1.passwordDelivery = "self";
    await startSession();
    const oldLink = (await upload(1, 3)).url;
    const oldPassword = records()[0][1].password;
    assert.equal(log.find(([kind]) => kind === "clipboard")[1], oldPassword,
      "a single password is still copied without a filename prefix");
    await startSession();
    const newLink = (await upload(2, 4)).url;
    const newPassword = records().find(([, r]) => r.url === newLink)[1].password;
    log.length = 0;
    await send(4, plainMessage(`${oldLink}\n${newLink}`));
    const copies = log.filter(([kind]) => kind === "clipboard");
    assert.equal(copies.length, 1, "one clipboard write must contain all passwords");
    assert.ok(copies[0][1].includes(`file1.pdf: ${oldPassword}`));
    assert.ok(copies[0][1].includes(`file2.pdf: ${newPassword}`));
    assert.equal(passwordEmails().length, 0);
    assert.equal(records().length, 0);
  });

  it("names all files in the copied notification when they share one recovered password", async () => {
    store.accounts.acc1.passwordDelivery = "self";
    await startSession();
    const first = (await upload(1, 3)).url;
    const second = (await upload(2, 3)).url;
    const password = records()[0][1].password;
    await startSession();
    log.length = 0;
    await send(4, plainMessage(`${first}\n${second}`));
    assert.deepEqual(log.filter(([kind]) => kind === "clipboard"), [["clipboard", password]]);
    const notice = log.find(([kind]) => kind === "notify")[1];
    assert.match(notice, /file1\.pdf, file2\.pdf: the password is on your clipboard/);
    assert.ok(!notice.includes(password));
  });

  it("hands over every recovered password with filenames, excluding quoted links", async () => {
    store.accounts.acc1.passwordDelivery = "self";
    await startSession();
    const first = (await upload(1, 3)).url;
    const shared = (await upload(2, 3)).url;
    const second = (await upload(3, 4)).url;
    const quoted = (await upload(4, 5)).url;
    const passwords = new Map(records().map(([, r]) => [r.url, r.password]));
    await startSession();
    log.length = 0;
    await send(6, plainMessage(`${first}\n${shared}\n${second}\n> ${quoted}`));
    const copies = log.filter(([kind]) => kind === "clipboard");
    assert.equal(copies.length, 1);
    assert.equal(copies[0][1], `file1.pdf, file2.pdf: ${passwords.get(first)}\nfile3.pdf: ${passwords.get(second)}`);
    assert.equal(records().length, 1, "quoted link stays untouched");
  });

  it("shows all recovered passwords when the clipboard is unavailable", async () => {
    store.accounts.acc1.passwordDelivery = "self";
    await startSession();
    const first = (await upload(1, 3)).url;
    const second = (await upload(2, 4)).url;
    const saved = records().map(([, r]) => r);
    await startSession();
    navigator.clipboard.writeText = async () => { throw new Error("Clipboard unavailable"); };
    log.length = 0;
    await send(6, plainMessage(`${first}\n${second}`));
    const notices = log.filter(([kind]) => kind === "notify");
    assert.equal(notices.length, 1);
    for (const r of saved) assert.ok(notices[0][1].includes(`${r.name}: ${r.password}`));
  });

  it("retains the job and logs a redacted error when opening the password email fails", async (t) => {
    await startSession();
    const link = (await upload(1, 3)).url;
    const password = records()[0][1].password;
    const warnings = [];
    t.mock.method(console, "warn", (...args) => warnings.push(args.join(" ")));
    browser.compose.beginNew = async () => {
      throw new Error(`Compose failed: ${password} bob@example.com`);
    };
    await send(3, plainMessage(link));
    const [key, job] = Object.entries(store).find(([k]) => k.startsWith("pendingPasswordEmail:"));
    assert.equal(job.details.identityId, "id-secondary");
    assert.equal(records().length, 0);
    assert.ok(warnings.some((message) => message.includes("Compose failed")));
    assert.ok(warnings.every((message) => !message.includes(password) && !message.includes("bob@example.com")));
    await startSession();
    assert.equal(store[key], undefined);
    assert.equal(passwordEmails().length, 1);
  });

  it("expires pending password emails before retrying, including undated jobs", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    browser.compose.beginNew = async () => { throw new Error("Compose failed"); };
    await send(3, plainMessage(link));
    const [key, job] = Object.entries(store).find(([k]) => k.startsWith("pendingPasswordEmail:"));
    assert.ok(job.createdAt > Date.now() - 10000);
    job.createdAt = Date.now() - 90 * 24 * 60 * 60 * 1000;
    store["pendingPasswordEmail:undated"] = { details: job.details, uploadKeys: [] };
    await startSession();
    assert.equal(store[key], undefined);
    assert.equal(store["pendingPasswordEmail:undated"], undefined);
    assert.equal(records().length, 0);
    assert.equal(passwordEmails().length, 0);
  });

  it("removes pending emails for a deleted contributing account and keeps unrelated jobs", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    browser.compose.beginNew = async () => { throw new Error("Compose failed"); };
    await send(3, plainMessage(link));
    const [key, job] = Object.entries(store).find(([k]) => k.startsWith("pendingPasswordEmail:"));
    assert.deepEqual(job.accountIds, ["acc1"]);
    // A reopened draft can combine links from more than one Filelink account.
    job.accountIds.push("acc2");
    store["pendingPasswordEmail:unrelated"] = { ...clone(job), accountIds: ["acc3"], uploadKeys: [] };
    await listeners.accountDeleted("acc2");
    assert.equal(store[key], undefined);
    assert.equal(records().length, 0);
    assert.ok(store["pendingPasswordEmail:unrelated"]);
    await listeners.notificationClicked(key);
    assert.equal(passwordEmails().length, 0);
  });

  it("keeps passwords after a failed password email and retries from the notification", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    const password = records()[0][1].password;
    const beginNew = browser.compose.beginNew;
    let attempts = 0;
    browser.compose.beginNew = async () => { attempts++; throw new Error("Could not open compose window"); };
    await send(3, plainMessage(link));
    assert.equal(attempts, 1, "failed opens wait for an explicit retry or restart");
    listeners.tabRemoved(3);
    assert.equal(records().length, 0);
    const key = Object.keys(store).find((k) => k.startsWith("pendingPasswordEmail:"));
    assert.ok(key);
    assert.ok(log.some(([kind, message, id]) => kind === "notify" && id === key && !message.includes(password)));
    await listeners.notificationClicked(key); // a second failure also retains the password
    assert.ok(store[key]);
    browser.compose.beginNew = beginNew;
    await listeners.notificationClicked(key);
    assert.ok(passwordEmails()[0].plainTextBody.includes(password));
    assert.deepEqual(passwordEmails()[0].to, ["bob@example.com"]);
    assert.equal(records().length, 0);
    assert.equal(store[key], undefined);
    await listeners.notificationClicked(key);
    assert.equal(passwordEmails().length, 1, "a stale notification cannot open another draft");
  });

  it("retries a failed password email after restart without resending the original", async () => {
    await startSession();
    const link = (await upload(1, 3)).url;
    const password = records()[0][1].password;
    browser.compose.beginNew = async () => { throw new Error("Could not open compose window"); };
    await send(3, plainMessage(link, "carol@example.com"));
    await startSession();
    assert.equal(passwordEmails().length, 1);
    assert.ok(passwordEmails()[0].plainTextBody.includes(password));
    assert.deepEqual(passwordEmails()[0].to, ["carol@example.com"]);
    assert.equal(records().length, 0);
    assert.ok(!Object.keys(store).some((k) => k.startsWith("pendingPasswordEmail:")));
  });

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

  it("does not retry after a proxy error, since Nextcloud may already have created the share", async () => {
    // The proxy timed out waiting; Nextcloud might have finished. A retry could add a second public link.
    rejectShare = () => new Response("", { status: 499 });
    await startSession();
    const result = await upload(1, 3);
    assert.equal(shareRequests.length, 1);
    assert.match(result.error ?? "", /HTTP 499/);
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

describe("failed upload rollback", () => {
  for (const cancelled of [false, true]) {
    it(`queues failed cleanup after ${cancelled ? "cancellation" : "an upload error"} and retries after restart`, async () => {
      await startSession();
      const originalFetch = fetch;
      let rollbackUrl;
      globalThis.fetch = async (url, init = {}) => {
        if (init.method === "PUT") {
          if (cancelled) listeners.abort({ id: "acc1" }, 1);
          throw new Error("Upload offline");
        }
        if (init.method === "DELETE") {
          rollbackUrl = url;
          throw new Error("Cleanup offline");
        }
        return originalFetch(url, init);
      };
      const result = await upload(1, 3);
      if (cancelled) assert.deepEqual(result, { aborted: true });
      else assert.match(result.error, /Could not reach Nextcloud/);
      const pending = Object.entries(store).filter(([k]) => k.startsWith("pendingDelete:"));
      assert.equal(pending.length, 1);
      const [key, job] = pending[0];
      assert.equal(job.accountId, "acc1");
      assert.equal(job.server, store.accounts.acc1.baseUrl);
      assert.equal(job.userId, "alice");
      assert.equal("appPassword" in job, false);
      assert.ok(job.folder);
      assert.equal(records().length, 0);
      requests = [];
      await startSession();
      assert.ok(requests.some((r) => r.method === "DELETE" && r.url === rollbackUrl));
      assert.equal(store[key], undefined);
    });
  }

  it("does not queue a rollback that succeeds", async () => {
    await startSession();
    const originalFetch = fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === "PUT") throw new Error("Upload offline");
      return originalFetch(url, init);
    };
    assert.ok((await upload(1, 3)).error);
    assert.ok(requests.some((r) => r.method === "DELETE"));
    assert.ok(!Object.keys(store).some((k) => k.startsWith("pendingDelete:")));
  });

  it("preserves the upload error if saving the cleanup job also fails", async () => {
    await startSession();
    const originalFetch = fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === "PUT" || init.method === "DELETE") throw new Error("Offline");
      return originalFetch(url, init);
    };
    browser.storage.local.set = async () => { throw new Error("Storage unavailable"); };
    const result = await upload(1, 3);
    assert.match(result.error, /Could not reach Nextcloud/);
    assert.doesNotMatch(result.error, /Storage unavailable/);
  });
});

describe("cleanup after switching server or user", () => {
  const deletes = () => requests.filter((r) => r.method === "DELETE");

  it("still cleans up on the same server and account", async () => {
    await startSession();
    await upload(1, 3);
    const { shareId } = records()[0][1];
    await listeners.deleted({ id: "acc1" }, 1, { id: 3 });
    assert.ok(deletes().some((r) => r.url.startsWith(`https://cloud.example.com/ocs/v2.php/apps/files_sharing/api/v1/shares/${shareId}?`)));
    assert.equal(records().length, 0);
  });

  it("does not delete a share on a server the account was reconnected to", async () => {
    await startSession();
    await upload(1, 3);
    // Disconnect, then Connect the same Thunderbird account to another server.
    Object.assign(store.accounts.acc1, { baseUrl: "https://other.example.org", appPassword: "new" });
    requests = [];
    await listeners.deleted({ id: "acc1" }, 1, { id: 3 });
    assert.deepEqual(deletes(), [], "share 1 on the new server is someone else's share");
    assert.equal(records().length, 0, "the record is dropped, not queued for retry");
  });

  it("does not delete a share after reconnecting as another Nextcloud user", async () => {
    await startSession();
    await upload(1, 3);
    Object.assign(store.accounts.acc1, { userId: "bob", loginName: "bob" });
    requests = [];
    await listeners.deleted({ id: "acc1" }, 1, { id: 3 });
    assert.deepEqual(deletes(), []);
  });

  it("drops queued cleanups for another server, and ones saved without a server, at startup", async () => {
    store["pendingDelete:a"] = { accountId: "acc1", server: "https://other.example.org", userId: "alice", shareId: "7", folder: "T/x" };
    store["pendingDelete:b"] = { accountId: "acc1", shareId: "8", folder: "T/y" }; // saved by an older version
    await startSession();
    assert.deepEqual(deletes(), []);
    assert.equal(Object.keys(store).filter((k) => k.startsWith("pendingDelete:")).length, 0);
  });
});
