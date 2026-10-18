// Minimal Nextcloud client: URL normalisation, Login Flow v2, OCS, WebDAV, shares.
// Everything is derived from the base URL the user types.

export const OCS_HEADERS = { "OCS-APIRequest": "true", Accept: "application/json" };

/** Turn whatever the user pasted into a clean base URL (keeps subpaths like /nextcloud). */
export function normalizeBaseUrl(input) {
  let value = (input || "").trim();
  if (!value) throw new Error("Enter your Nextcloud URL.");
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  const url = new URL(value);
  let path = url.pathname;
  // Strip common tails people copy from the address bar.
  path = path.replace(/\/(index\.php|login|apps|settings|remote\.php|ocs|status\.php)(\/.*)?$/i, "");
  path = path.replace(/\/+$/, "");
  return url.origin + path;
}

export function originPattern(baseUrl) {
  return new URL(baseUrl).origin + "/*";
}

export function authHeader(account) {
  const token = btoa(unescape(encodeURIComponent(`${account.loginName}:${account.appPassword}`)));
  return { Authorization: `Basic ${token}` };
}

/** Throws unless the URL is a working Nextcloud instance. Returns status.php JSON. */
export async function checkServer(baseUrl) {
  let res;
  try {
    res = await fetch(`${baseUrl}/status.php`, { cache: "no-store" });
  } catch (e) {
    throw new Error(`Could not reach ${baseUrl} (${e.message}).`);
  }
  if (!res.ok) throw new Error(`status.php returned HTTP ${res.status}. Is this the Nextcloud base URL?`);
  const status = await res.json().catch(() => null);
  if (!status || status.installed !== true) throw new Error("That does not look like a Nextcloud server.");
  if (status.maintenance) throw new Error("The server is in maintenance mode.");
  return status;
}

// ---- Login Flow v2 ---------------------------------------------------------

export async function startLoginFlow(baseUrl) {
  const res = await fetch(`${baseUrl}/index.php/login/v2`, { method: "POST" });
  if (!res.ok) throw new Error(`Login flow could not start (HTTP ${res.status}).`);
  const data = await res.json();
  return { loginUrl: data.login, pollUrl: data.poll.endpoint, token: data.poll.token };
}

/** Polls until the user finishes logging in. Resolves to {server, loginName, appPassword}. */
export async function pollLoginFlow({ pollUrl, token }, { signal, timeoutMs = 20 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled.");
    const res = await fetch(pollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal,
    });
    if (res.status === 200) return res.json();
    if (res.status !== 404) throw new Error(`Login polling failed (HTTP ${res.status}).`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timed out waiting for login.");
}

// ---- OCS -------------------------------------------------------------------

async function ocs(account, path, { method = "GET", form, signal } = {}) {
  const headers = { ...OCS_HEADERS, ...authHeader(account) };
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form);
  }
  const res = await fetch(`${account.baseUrl}/ocs/v2.php${path}${path.includes("?") ? "&" : "?"}format=json`, {
    method,
    headers,
    body,
    signal,
  });
  const json = await res.json().catch(() => null);
  const meta = json?.ocs?.meta;
  if (!res.ok || (meta && meta.statuscode >= 300)) {
    throw new Error(meta?.message || `Nextcloud API error (HTTP ${res.status}).`);
  }
  return json.ocs.data;
}

export async function getCurrentUser(account) {
  const data = await ocs(account, "/cloud/user");
  return { id: data.id, displayName: data["display-name"] || data.displayname || data.id };
}

export async function getCapabilities(account) {
  const data = await ocs(account, "/cloud/capabilities");
  return data.capabilities || {};
}

/** Subset of sharing policy we care about. */
export function sharePolicy(capabilities) {
  const pub = capabilities?.files_sharing?.public || {};
  return {
    passwordEnforced: !!pub.password?.enforced,
    expireDefaultEnabled: !!pub.expire_date?.enabled,
    expireEnforced: !!pub.expire_date?.enforced,
    expireDays: pub.expire_date?.days ?? null,
  };
}

export async function createPublicShare(account, { path, password, expireDate, label, signal }) {
  const form = { path, shareType: "3", permissions: "1" };
  if (password) form.password = password;
  if (expireDate) form.expireDate = expireDate; // YYYY-MM-DD
  if (label) form.label = label;
  const data = await ocs(account, "/apps/files_sharing/api/v1/shares", { method: "POST", form, signal });
  return { id: data.id, token: data.token, url: data.url, expiration: data.expiration || null };
}

export async function deleteShare(account, shareId) {
  await ocs(account, `/apps/files_sharing/api/v1/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" });
}

/**
 * UNVERIFIED: sets a per-share download limit via the Download Limit app (files_downloadlimit).
 * The endpoint below is my best recollection of that app's OCS route. Check the app source and
 * adjust. Callers must treat a thrown error as "limit NOT applied".
 */
export async function setDownloadLimit(account, shareToken, limit) {
  await ocs(account, `/apps/files_downloadlimit/api/v1/${encodeURIComponent(shareToken)}/limit`, {
    method: "PUT",
    form: { limit: String(limit) },
  });
}

// ---- WebDAV ----------------------------------------------------------------

export const davRoot = (account) =>
  `${account.baseUrl}/remote.php/dav/files/${encodeURIComponent(account.userId)}`;

const encodePath = (p) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/** Create every folder in `folderPath` ("a/b/c"). 405 (already exists) is fine. */
export async function ensureFolder(account, folderPath) {
  let current = "";
  for (const segment of folderPath.split("/").filter(Boolean)) {
    current += "/" + segment;
    const res = await fetch(`${davRoot(account)}${encodePath(current)}`, {
      method: "MKCOL",
      headers: authHeader(account),
    });
    if (![201, 405].includes(res.status)) {
      throw new Error(`Could not create folder "${current}" (HTTP ${res.status}).`);
    }
  }
}

export async function uploadFile(account, filePath, blob, { signal } = {}) {
  const res = await fetch(`${davRoot(account)}${"/" + encodePath(filePath)}`, {
    method: "PUT",
    headers: authHeader(account),
    body: blob,
    signal,
  });
  if (![200, 201, 204].includes(res.status)) {
    throw new Error(`Upload failed (HTTP ${res.status}).`);
  }
}

export async function deleteFile(account, filePath) {
  const res = await fetch(`${davRoot(account)}${"/" + encodePath(filePath)}`, {
    method: "DELETE",
    headers: authHeader(account),
  });
  if (![200, 204, 404].includes(res.status)) throw new Error(`Delete failed (HTTP ${res.status}).`);
}
