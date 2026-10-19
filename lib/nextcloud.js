// Minimal Nextcloud client: URL normalisation, Login Flow v2, OCS, WebDAV, shares.
// Everything is derived from the base URL the user types.

export const OCS_HEADERS = { "OCS-APIRequest": "true", Accept: "application/json" };

const AUTH_ERROR = "Nextcloud rejected the stored app password. Open this account's settings, click Disconnect, then Connect again.";

// Plain HTTP would send the app password in clear text; only allow it for a server on this machine.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]); // must match optional_permissions in manifest.json

/** Turn whatever the user pasted into a clean base URL (keeps subpaths like /nextcloud). */
export function normalizeBaseUrl(input) {
  let value = (input || "").trim();
  if (!value) throw new Error("Enter your Nextcloud URL.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "https://" + value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error("Use an https:// address. Plain http:// would send your app password unencrypted.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Use an https:// address.");
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
  const data = await res.json().catch(() => null);
  if (!data?.login || !data.poll?.endpoint || !data.poll.token) throw new Error("The server sent an unexpected login flow response.");
  // The poll endpoint receives the app password, so it must be the server the user chose.
  const origin = new URL(baseUrl).origin;
  for (const address of [data.login, data.poll.endpoint]) {
    if (new URL(address).origin !== origin) {
      throw new Error(
        `The server sent login addresses on ${new URL(address).origin} instead of ${origin}. ` +
          "Ask the admin to check overwrite.cli.url, overwritehost and overwriteprotocol, or enter that address instead.",
      );
    }
  }
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
    if (res.status === 200) {
      const creds = await res.json().catch(() => null);
      if (!creds?.loginName || !creds.appPassword) throw new Error("The server sent an unexpected login result.");
      return creds;
    }
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
  if (res.status === 401) throw new Error(AUTH_ERROR);
  if (!res.ok || (meta && meta.statuscode >= 300)) {
    throw new Error(meta?.message || `Nextcloud API error (HTTP ${res.status}).`);
  }
  if (!json?.ocs) {
    throw new Error(`Unexpected response from Nextcloud (HTTP ${res.status}). A proxy or single sign-on page may be in the way.`);
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

/** Revokes the app password the account is using. */
export async function revokeAppPassword(account) {
  await ocs(account, "/core/apppassword", { method: "DELETE" });
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

/**
 * Nextcloud rejects (rather than shortens) an expiry beyond an enforced maximum, so cap it here.
 * 0 means "no expiry requested" and is left for the server to fill in.
 */
export function clampExpiryDays(days, policy) {
  const max = policy?.expireEnforced ? Number(policy.expireDays) : 0;
  if (days > 0 && max > 0) return Math.min(days, max);
  return days;
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

// ---- dates and passwords ---------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

/** The user's local calendar date `days` from now, as YYYY-MM-DD (Nextcloud's expireDate is date-only). */
export function localDateFromNow(days, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Share `expiration` ("YYYY-MM-DD 00:00:00") as a timestamp for local midnight of that date, or null. */
export function parseShareDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

// One of each class so the password passes Nextcloud's password_policy app with default settings.
const PASSWORD_CLASSES = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+-=?@_"];
const PASSWORD_ALPHABET = PASSWORD_CLASSES.join("");

export function randomPassword(length = 16) {
  const limit = 256 - (256 % PASSWORD_ALPHABET.length); // rejection sampling avoids modulo bias
  for (;;) {
    let password = "";
    while (password.length < length) {
      const [byte] = crypto.getRandomValues(new Uint8Array(1));
      if (byte < limit) password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
    }
    if (PASSWORD_CLASSES.every((chars) => [...chars].some((c) => password.includes(c)))) return password;
  }
}

// ---- WebDAV ----------------------------------------------------------------

export const davRoot = (account) =>
  `${account.baseUrl}/remote.php/dav/files/${encodeURIComponent(account.userId)}`;

const encodePath = (p) =>
  p
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      // fetch() would resolve these and step outside the intended folder.
      if (segment === "." || segment === "..") throw new Error(`Folder names cannot be "${segment}".`);
      return encodeURIComponent(segment);
    })
    .join("/");

function davError(action, status) {
  if (status === 401) return new Error(AUTH_ERROR);
  if (status === 413) return new Error(`${action} failed: the file is larger than the server or its proxy accepts.`);
  if (status === 507) return new Error(`${action} failed: not enough storage space left on Nextcloud.`);
  return new Error(`${action} failed (HTTP ${status}).`);
}

/** Create every folder in `folderPath` ("a/b/c"). 405 (already exists) is fine. */
export async function ensureFolder(account, folderPath) {
  let current = "";
  for (const segment of folderPath.split("/").filter(Boolean)) {
    current += "/" + segment;
    const res = await fetch(`${davRoot(account)}/${encodePath(current)}`, {
      method: "MKCOL",
      headers: authHeader(account),
    });
    if (![201, 405].includes(res.status)) throw davError(`Creating folder "${current}"`, res.status);
  }
}

export async function uploadFile(account, filePath, blob, { signal } = {}) {
  const res = await fetch(`${davRoot(account)}/${encodePath(filePath)}`, {
    method: "PUT",
    headers: authHeader(account),
    body: blob,
    signal,
  });
  if (![200, 201, 204].includes(res.status)) throw davError("Upload", res.status);
}

export async function deleteFile(account, filePath) {
  const res = await fetch(`${davRoot(account)}/${encodePath(filePath)}`, {
    method: "DELETE",
    headers: authHeader(account),
  });
  if (![200, 204, 404].includes(res.status)) throw davError("Delete", res.status);
}
