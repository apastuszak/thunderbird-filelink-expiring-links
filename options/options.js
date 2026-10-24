// Settings page, loaded by Thunderbird inside the account settings with ?accountId=<id>.
import {
  checkServer,
  clampExpiryDays,
  getCapabilities,
  getCurrentUser,
  normalizeBaseUrl,
  originPattern,
  pollLoginFlow,
  revokeAppPassword,
  serverInfo,
  startLoginFlow,
} from "../lib/nextcloud.js";

const accountId = new URLSearchParams(location.search).get("accountId");
const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  folder: "Thunderbird attachments",
  expiryDays: 7,
  oneTime: false,
  generatePassword: false,
  passwordDelivery: "ask",
};

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

/** What an expiry of 0 days actually does on this server. */
function zeroExpiryText(policy) {
  if (!policy) return "0 = no expiry, unless the server sets a default.";
  if (policy.expireDefaultEnabled || policy.expireEnforced) {
    return policy.expireDays ? `0 = the server's default (${policy.expireDays} days).` : "0 = the server's default.";
  }
  return "0 = the link never expires: this server sets no default.";
}

function policyText(policy) {
  if (!policy) return "";
  let text = "";
  if (policy.expireEnforced) text = `Server enforces expiry (up to ${policy.expireDays} days).`;
  else if (policy.expireDefaultEnabled) text = `Server default expiry: ${policy.expireDays} days.`;
  if (policy.passwordEnforced) text += " Server requires passwords on public links.";
  return text.trim();
}

/** Fields the background can also change (remembered password choice, refreshed server settings). */
function renderChoices(a) {
  const passwordEnforced = !!a.policy?.passwordEnforced;
  $("password").checked = a.generatePassword || passwordEnforced;
  $("password").disabled = passwordEnforced;
  $("onetime").checked = a.oneTime;
  $("onetime").disabled = a.downloadLimit === false && !a.oneTime;
  $("onetime-hint").textContent =
    a.downloadLimit === false ? "Not available: the Download Limit app is not installed on this server." : "";
  $("delivery").value = a.passwordDelivery;
  $("policy").textContent = [zeroExpiryText(a.policy), policyText(a.policy)].filter(Boolean).join(" ");
}

async function render() {
  const a = await loadAccount();
  $("url").value = a.baseUrl || "";
  $("folder").value = a.folder;
  $("expiry").value = a.expiryDays;
  renderChoices(a);
  const connected = !!a.appPassword;
  $("connected").hidden = !connected;
  $("shares-row").hidden = !connected;
  $("who").textContent = connected ? `${a.displayName || a.userId} @ ${a.baseUrl}` : "";
  $("connect-btn").hidden = connected;
  $("url").disabled = connected;
}

// Without this, a later save from this page would write back a stale value over the background's change.
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && changes.accounts) renderChoices(await loadAccount());
});

/** Gives up the host permission unless a connected account still needs it (the pattern covers all ports). */
async function releaseOriginIfUnused(baseUrl) {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  const pattern = originPattern(baseUrl);
  const inUse = Object.values(accounts).some((o) => o.appPassword && o.baseUrl && originPattern(o.baseUrl) === pattern);
  if (!inUse) await browser.permissions.remove({ origins: [originPattern(baseUrl)] }).catch(() => {});
}

$("connect-btn").addEventListener("click", async () => {
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl($("url").value);
  } catch (e) {
    return setStatus(e.message, true);
  }
  let account;
  // Before any await: a second click while the permission prompt is open would start a second
  // login and leave its app password orphaned on the server.
  $("connect-btn").disabled = true;
  try {
    // Must be the first await so it still counts as a user gesture.
    const granted = await browser.permissions.request({ origins: [originPattern(baseUrl)] });
    if (!granted) return setStatus("Permission to contact that server was denied.", true);

    setStatus("Checking server…");
    await checkServer(baseUrl);

    setStatus("Waiting for you to log in in your browser…");
    const flow = await startLoginFlow(baseUrl);
    await browser.windows.openDefaultBrowser(flow.loginUrl);
    const creds = await pollLoginFlow(flow);

    account = { baseUrl, loginName: creds.loginName, appPassword: creds.appPassword };
    const user = await getCurrentUser(account);
    const info = serverInfo(await getCapabilities(account));

    const patch = { ...account, userId: user.id, displayName: user.displayName, ...info };
    if (info.policy.passwordEnforced) patch.generatePassword = true;
    await saveAccount(patch);
    account = null; // stored now; no longer ours to revoke
    if (accountId) await browser.cloudFile.updateAccount(accountId, { configured: true });

    setStatus("Connected.");
    await render();
  } catch (e) {
    // Setup failed after login: do not leave an app password nobody stores on the server.
    if (account) await revokeAppPassword(account).catch(() => {});
    await releaseOriginIfUnused(baseUrl);
    setStatus(e.message, true);
  } finally {
    $("connect-btn").disabled = false;
  }
});

$("shares-btn").addEventListener("click", () => {
  browser.tabs.create({ url: `/shares/shares.html?accountId=${encodeURIComponent(accountId)}` });
});

$("disconnect-btn").addEventListener("click", async () => {
  const a = await loadAccount();
  // Ignore failures; the user can still revoke it in Nextcloud's security settings.
  await revokeAppPassword(a).catch(() => {});
  await saveAccount({ appPassword: null, loginName: null, userId: null, displayName: null });
  if (a.baseUrl) await releaseOriginIfUnused(a.baseUrl);
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
    passwordDelivery: $("delivery").value,
  });
  if (tidy) {
    $("folder").value = folder;
    $("expiry").value = expiryDays;
  }
  $("saved").textContent = expiryDays < requested ? `Saved. Expiry capped at ${expiryDays} days by the server.` : "Saved.";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("saved").textContent = ""), 4000);
}

for (const id of ["password", "onetime", "delivery"]) $(id).addEventListener("change", () => saveSettings());
for (const id of ["folder", "expiry"]) {
  // Also save while typing, so closing the settings tab without leaving the field keeps the value.
  $(id).addEventListener("input", () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(saveSettings, 500);
  });
  $(id).addEventListener("change", () => saveSettings({ tidy: true }));
}

render();
