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

async function saveAccount(patch) {
  const { accounts = {} } = await browser.storage.local.get("accounts");
  accounts[accountId] = { ...(accounts[accountId] || {}), ...patch };
  await browser.storage.local.set({ accounts });
  return accounts;
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
    const policy = sharePolicy(await getCapabilities(account));

    const patch = { ...account, userId: user.id, displayName: user.displayName, policy };
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

$("save-btn").addEventListener("click", async () => {
  const a = await loadAccount();
  const requested = Math.max(0, parseInt($("expiry").value, 10) || 0);
  const expiryDays = clampExpiryDays(requested, a.policy);
  await saveAccount({
    folder: $("folder").value.trim() || DEFAULTS.folder,
    expiryDays,
    generatePassword: $("password").checked || !!a.policy?.passwordEnforced,
    oneTime: $("onetime").checked,
  });
  $("expiry").value = expiryDays;
  $("saved").textContent = expiryDays < requested ? `Saved. Expiry capped at ${expiryDays} days by the server.` : "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 4000);
});

render();
