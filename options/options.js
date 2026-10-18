// Settings page, loaded by Thunderbird inside the account settings with ?accountId=<id>.
import {
  checkServer,
  getCapabilities,
  getCurrentUser,
  normalizeBaseUrl,
  originPattern,
  pollLoginFlow,
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
  return accounts[accountId];
}

async function render() {
  const a = await loadAccount();
  $("url").value = a.baseUrl || "";
  $("folder").value = a.folder;
  $("expiry").value = a.expiryDays;
  $("password").checked = a.generatePassword;
  $("onetime").checked = a.oneTime;
  const connected = !!a.appPassword;
  $("connected").hidden = !connected;
  $("who").textContent = connected ? `${a.displayName || a.userId} @ ${a.baseUrl}` : "";
  $("connect-btn").hidden = connected;
  $("url").disabled = connected;
  $("policy").textContent = a.policyText || "";
}

$("connect-btn").addEventListener("click", async () => {
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl($("url").value);
  } catch (e) {
    return setStatus(e.message, true);
  }
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

    const account = { baseUrl, loginName: creds.loginName, appPassword: creds.appPassword };
    const user = await getCurrentUser(account);
    const policy = sharePolicy(await getCapabilities(account));

    let policyText = "";
    if (policy.expireEnforced) policyText = `Server enforces expiry (up to ${policy.expireDays} days).`;
    else if (policy.expireDefaultEnabled) policyText = `Server default expiry: ${policy.expireDays} days.`;
    if (policy.passwordEnforced) policyText += " Server requires passwords on public links.";

    const patch = { ...account, userId: user.id, displayName: user.displayName, policyText };
    if (policy.passwordEnforced) patch.generatePassword = true;
    await saveAccount(patch);
    if (accountId) await browser.cloudFile.updateAccount(accountId, { configured: true });

    setStatus("Connected.");
    await render();
  } catch (e) {
    setStatus(e.message, true);
  }
});

$("disconnect-btn").addEventListener("click", async () => {
  const a = await loadAccount();
  // Revoke the app password server-side; ignore failures (user can revoke in Nextcloud security settings).
  try {
    const { authHeader, OCS_HEADERS } = await import("../lib/nextcloud.js");
    await fetch(`${a.baseUrl}/ocs/v2.php/core/apppassword`, {
      method: "DELETE",
      headers: { ...OCS_HEADERS, ...authHeader(a) },
    });
  } catch { /* ignore */ }
  await saveAccount({ appPassword: null, loginName: null, userId: null, displayName: null });
  if (accountId) await browser.cloudFile.updateAccount(accountId, { configured: false });
  setStatus("Disconnected.");
  await render();
});

$("save-btn").addEventListener("click", async () => {
  await saveAccount({
    folder: $("folder").value.trim() || DEFAULTS.folder,
    expiryDays: Math.max(0, parseInt($("expiry").value, 10) || 0),
    generatePassword: $("password").checked,
    oneTime: $("onetime").checked,
  });
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
});

render();
