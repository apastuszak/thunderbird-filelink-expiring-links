// Settings page, loaded by Thunderbird inside the account settings with ?accountId=<id>.
import {
  checkServer,
  chunkSizeFromCapabilities,
  clampExpiryDays,
  getCapabilities,
  getCurrentUser,
  normalizeBaseUrl,
  originPattern,
  pollLoginFlow,
  revokeAppPassword,
  sharePolicy,
  startLoginFlow,
} from "../lib/nextcloud.js";

const accountId = new URLSearchParams(location.search).get("accountId");
const $ = (id) => document.getElementById(id);
const DEFAULTS = { folder: "Thunderbird attachments", expiryDays: 7, oneTime: false, generatePassword: false };

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function loadAccount() {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  return { ...DEFAULTS, ...(accounts[accountId] || {}) };
}

// Saves run one at a time: a settings save overlapping Connect could otherwise write back
// the account without its new app password.
let saving = Promise.resolve();

function saveAccount(patch) {
  const run = saving.then(async () => {
    const { accounts = {} } = await browser.storage.local.get("accounts");
    accounts[accountId] = { ...(accounts[accountId] || {}), ...patch };
    await browser.storage.local.set({ accounts });
    return accounts;
  });
  saving = run.catch(() => {});
  return run;
}

function policyText(policy) {
  if (!policy) return "";
  let text = "";
  if (policy.expireEnforced) text = `Server enforces expiry (up to ${policy.expireDays} days).`;
  else if (policy.expireDefaultEnabled) text = `Server default expiry: ${policy.expireDays} days.`;
  if (policy.passwordEnforced) text += " Server requires passwords on public links.";
  return text.trim();
}

async function render() {
  const a = await loadAccount();
  const passwordEnforced = !!a.policy?.passwordEnforced;
  $("url").value = a.baseUrl || "";
  $("folder").value = a.folder;
  $("expiry").value = a.expiryDays;
  $("password").checked = a.generatePassword || passwordEnforced;
  $("password").disabled = passwordEnforced;
  $("onetime").checked = a.oneTime;
  const connected = !!a.appPassword;
  $("connected").hidden = !connected;
  $("who").textContent = connected ? `${a.displayName || a.userId} @ ${a.baseUrl}` : "";
  $("connect-btn").hidden = connected;
  $("url").disabled = connected;
  $("policy").textContent = policyText(a.policy);
}

$("connect-btn").addEventListener("click", async () => {
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl($("url").value);
  } catch (e) {
    return setStatus(e.message, true);
  }
  let account;
  try {
    // Must be the first await so it still counts as a user gesture.
    const granted = await browser.permissions.request({ origins: [originPattern(baseUrl)] });
    if (!granted) return setStatus("Permission to contact that server was denied.", true);
    $("connect-btn").disabled = true;

    setStatus("Checking server…");
    await checkServer(baseUrl);

    setStatus("Waiting for you to log in in your browser…");
    const flow = await startLoginFlow(baseUrl);
    await browser.windows.openDefaultBrowser(flow.loginUrl);
    const creds = await pollLoginFlow(flow);

    account = { baseUrl, loginName: creds.loginName, appPassword: creds.appPassword };
    const user = await getCurrentUser(account);
    const capabilities = await getCapabilities(account);
    const policy = sharePolicy(capabilities);
    const chunkSize = chunkSizeFromCapabilities(capabilities);

    const patch = { ...account, userId: user.id, displayName: user.displayName, policy, chunkSize };
    if (policy.passwordEnforced) patch.generatePassword = true;
    await saveAccount(patch);
    account = null; // stored now; no longer ours to revoke
    if (accountId) await browser.cloudFile.updateAccount(accountId, { configured: true });

    setStatus("Connected.");
    await render();
  } catch (e) {
    // Setup failed after login: do not leave an app password nobody stores on the server.
    if (account) await revokeAppPassword(account).catch(() => {});
    setStatus(e.message, true);
  } finally {
    $("connect-btn").disabled = false;
  }
});

$("disconnect-btn").addEventListener("click", async () => {
  const a = await loadAccount();
  // Ignore failures; the user can still revoke it in Nextcloud's security settings.
  await revokeAppPassword(a).catch(() => {});
  const accounts = await saveAccount({ appPassword: null, loginName: null, userId: null, displayName: null });
  if (a.baseUrl) {
    const origin = new URL(a.baseUrl).origin;
    const inUse = Object.values(accounts).some((o) => o.appPassword && o.baseUrl && new URL(o.baseUrl).origin === origin);
    if (!inUse) await browser.permissions.remove({ origins: [originPattern(a.baseUrl)] }).catch(() => {});
  }
  if (accountId) await browser.cloudFile.updateAccount(accountId, { configured: false });
  setStatus("Disconnected.");
  await render();
});

// Settings apply as soon as they change, like Thunderbird's own preferences. With a Save button,
// ticking a box and leaving the page silently dropped the change.
let typingTimer;
let savedTimer;

async function saveSettings({ tidy = false } = {}) {
  clearTimeout(typingTimer);
  const a = await loadAccount();
  const requested = Math.max(0, parseInt($("expiry").value, 10) || 0);
  const expiryDays = clampExpiryDays(requested, a.policy);
  const folder = $("folder").value.trim() || DEFAULTS.folder;
  await saveAccount({
    folder,
    expiryDays,
    generatePassword: $("password").checked || !!a.policy?.passwordEnforced,
    oneTime: $("onetime").checked,
  });
  if (tidy) {
    $("folder").value = folder;
    $("expiry").value = expiryDays;
  }
  $("saved").textContent = expiryDays < requested ? `Saved. Expiry capped at ${expiryDays} days by the server.` : "Saved.";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("saved").textContent = ""), 4000);
}

for (const id of ["password", "onetime"]) $(id).addEventListener("change", () => saveSettings());
for (const id of ["folder", "expiry"]) {
  // Also save while typing, so closing the settings tab without leaving the field keeps the value.
  $(id).addEventListener("input", () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(saveSettings, 500);
  });
  $(id).addEventListener("change", () => saveSettings({ tidy: true }));
}

render();
