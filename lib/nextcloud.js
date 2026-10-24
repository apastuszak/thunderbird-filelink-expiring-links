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

/**
 * Host permission pattern for the server. Firefox (and so Thunderbird) does not support ports in match
 * patterns (MDN "Match patterns"; bugs 1362809, 1468162) and applies a pattern to every port of the
 * host, so the port is left out.
 */
export function originPattern(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.hostname}/*`;
}

export function authHeader(account) {
  const token = btoa(unescape(encodeURIComponent(`${account.loginName}:${account.appPassword}`)));
  return { Authorization: `Basic ${token}` };
}

/**
 * fetch() with the app password. Redirects are refused rather than followed, so the Authorization
 * header can never travel to another address; Nextcloud's APIs do not redirect.
 */
async function authFetch(account, url, { headers, ...init } = {}) {
  try {
    return await fetch(url, { ...init, headers: { ...authHeader(account), ...headers }, redirect: "error" });
  } catch (e) {
    if (e.name === "AbortError" || init.signal?.aborted) throw e; // a cancelled upload, not a failure
    // fetch() only says "NetworkError when attempting to fetch resource." for all of these.
    throw new Error(
      `Could not reach Nextcloud at ${new URL(account.baseUrl).host}. Check your internet connection, and that the add-on ` +
        "still has permission for this server (Add-ons Manager > this add-on > Permissions). A redirect on the server " +
        "causes this too: the add-on does not follow redirects with your app password.",
      { cause: e },
    );
  }
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

/**
 * Polls until the user finishes logging in. Resolves to {server, loginName, appPassword}.
 * Once a poll has got through, a network error (Wi-Fi dropping, the laptop sleeping) or a
 * transient server or proxy error counts as "not yet": the login the user finishes in the browser
 * would otherwise create an app password nobody receives. The first poll gets no such leeway, so
 * an address that cannot work (it redirects, is unreachable, or the server is down) fails at once
 * instead of after the whole timeout.
 */
export async function pollLoginFlow({ pollUrl, token }, { signal, timeoutMs = 20 * 60 * 1000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let reached = false;
  for (; Date.now() < deadline; await new Promise((r) => setTimeout(r, intervalMs))) {
    if (signal?.aborted) throw new Error("Login cancelled.");
    let res;
    try {
      res = await fetch(pollUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal,
        redirect: "error", // the token is exchanged for the app password; it must not be re-posted elsewhere
      });
    } catch (e) {
      if (signal?.aborted) throw new Error("Login cancelled.");
      if (!reached) {
        throw new Error(
          `Could not check the login with ${new URL(pollUrl).host} (${e.message}). The server may be ` +
            "unreachable, or redirecting its login address, which the add-on does not follow.",
          { cause: e },
        );
      }
      continue;
    }
    if (res.status === 200) {
      const creds = await res.json().catch(() => null);
      if (!creds?.loginName || !creds.appPassword) throw new Error("The server sent an unexpected login result.");
      return creds;
    }
    if (res.status === 404) {
      reached = true; // Nextcloud answered: the user has not finished logging in yet
      continue;
    }
    const transient = res.status === 429 || res.status >= 500 || PROXY_STATUSES.has(res.status);
    if (reached && transient) continue;
    throw new Error(`Login polling failed (HTTP ${res.status}).`);
  }
  throw new Error("Timed out waiting for login.");
}

// ---- OCS -------------------------------------------------------------------

async function ocs(account, path, { method = "GET", form, signal } = {}) {
  const headers = { ...OCS_HEADERS };
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form);
  }
  const res = await authFetch(account, `${account.baseUrl}/ocs/v2.php${path}${path.includes("?") ? "&" : "?"}format=json`, {
    method,
    headers,
    body,
    signal,
  });
  const json = await res.json().catch(() => null);
  const meta = json?.ocs?.meta;
  if (res.status === 401) throw new Error(AUTH_ERROR);
  if (!res.ok || (meta && meta.statuscode >= 300)) {
    // ocsStatus marks a refusal from Nextcloud itself (its OCS error block), so the request was not
    // carried out. A bare status from a proxy (499, 502, 504…) gets none: Nextcloud may have acted.
    throw Object.assign(new Error(meta?.message || `Nextcloud API error (HTTP ${res.status}).`), {
      ocsStatus: meta ? meta.statuscode : undefined,
    });
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

/** Whether the Download Limit app (files_downloadlimit) is installed; it advertises itself in capabilities. */
export function downloadLimitAvailable(capabilities) {
  return capabilities?.downloadlimit?.enabled === true;
}

/** Everything the add-on keeps about the server, saved at Connect and refreshed on every start. */
export function serverInfo(capabilities) {
  return {
    policy: sharePolicy(capabilities),
    chunkSize: chunkSizeFromCapabilities(capabilities),
    downloadLimit: downloadLimitAvailable(capabilities),
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
  checkShareUrl(data.url, account.baseUrl);
  return { id: data.id, token: data.token, url: data.url, expiration: data.expiration || null };
}

/**
 * The link goes into an email, so it must be one the recipient can open securely. Nextcloud builds it
 * from its own config, which can yield http:// or an internal name behind a proxy. Another public
 * domain is fine (some setups share under one); plain http only when the server itself is local.
 */
export function checkShareUrl(shareUrl, baseUrl) {
  let url;
  try {
    url = new URL(shareUrl);
  } catch {
    throw new Error("Nextcloud returned an invalid share link.");
  }
  const local = new URL(baseUrl).protocol === "http:" && url.origin === new URL(baseUrl).origin;
  if (url.protocol !== "https:" && !local) {
    throw new Error(
      `Nextcloud returned a share link starting with ${url.protocol}//${url.host}, which is not https. ` +
        "Ask the admin to set overwriteprotocol to https and overwrite.cli.url to the public address.",
    );
  }
}

export async function deleteShare(account, shareId) {
  await ocs(account, `/apps/files_sharing/api/v1/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" });
}

// ---- shared-files page -----------------------------------------------------

/** Label put on every share this add-on creates; the shared-files page finds them by it. */
export const SHARE_LABEL = "Thunderbird";

/** The user's own shares (GET …/shares without parameters: not "shared with me"). */
export async function listShares(account) {
  const data = await ocs(account, "/apps/files_sharing/api/v1/shares");
  return Array.isArray(data) ? data : [];
}

// Uploads live at <upload folder>/<16 hex characters>/<file> (see background.js); the folder name
// itself may have changed since, so only the per-upload level is matched.
const UPLOAD_PATH = /^\/.+\/[0-9a-f]{16}\/[^/]+$/;

/**
 * This add-on's link shares among `shares`, newest first. Nextcloud's folder filter is shallow and
 * uploads sit one level deeper, so the matching happens here: public link, the add-on's label, and
 * a file in a per-upload folder. Nextcloud never returns a share's password, only "redacted".
 */
export function addOnShares(shares) {
  return shares
    .filter((s) => Number(s.share_type) === 3 && s.label === SHARE_LABEL && s.item_type === "file" && UPLOAD_PATH.test(s.path ?? ""))
    .map((s) => ({
      id: String(s.id),
      name: s.path.split("/").pop(),
      path: s.path,
      folder: s.path.split("/").slice(1, -2).join("/"),
      url: s.url,
      sharedAt: Number(s.stime) * 1000,
      expiresAt: parseShareDate(s.expiration),
      hasPassword: s.password != null && s.password !== "",
    }))
    .sort((a, b) => b.sharedAt - a.sharedAt);
}

/**
 * Revokes a public link (the file stays). Resolves "revoked", or "gone" if Nextcloud no longer has
 * the share (already revoked, expired and cleaned up, or its file deleted).
 */
export async function revokeShare(account, shareId) {
  try {
    await deleteShare(account, shareId);
    return "revoked";
  } catch (e) {
    if (e.ocsStatus === 404) return "gone";
    throw e;
  }
}

/**
 * Sets a per-share download limit via the Download Limit app (files_downloadlimit): OCS route
 * PUT /api/v1/{token}/limit with an integer limit >= 1 (appinfo/routes.php, ApiController::setDownloadLimit).
 * Callers must treat a thrown error as "limit NOT applied".
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

// Statuses a reverse proxy, CDN or tunnel in front of Nextcloud sends when it gives up on a request.
// Nextcloud itself never sends 499 (nginx's "client closed request").
const PROXY_STATUSES = new Set([499, 502, 503, 504, 520, 521, 522, 523, 524]);

function davError(action, status, message = "") {
  if (status === 401) return new Error(AUTH_ERROR);
  if (status === 413) return new Error(`${action} failed: the file is larger than the server or its proxy accepts.`);
  if (status === 507) return new Error(`${action} failed: not enough storage space left on Nextcloud.`);
  if (PROXY_STATUSES.has(status)) {
    return new Error(`${action} failed: a proxy in front of Nextcloud dropped the request (HTTP ${status}). Try again, or ask the admin to raise its timeouts.`);
  }
  return new Error(message ? `${action} failed: ${message} (HTTP ${status}).` : `${action} failed (HTTP ${status}).`);
}

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decodeXml = (text) =>
  text.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi, (match, name, dec, hex) => {
    if (name) return XML_ENTITIES[name.toLowerCase()];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });

/** Nextcloud (SabreDAV) explains WebDAV errors in the body: <s:message>File name contains…</s:message>. */
async function davFailure(action, res) {
  const body = await res.text().catch(() => "");
  const raw = /<s:message>([^<]{1,300})<\/s:message>/.exec(body)?.[1] ?? "";
  const message = decodeXml(raw).trim();
  return davError(action, res.status, message);
}

/** Create every folder in `folderPath` ("a/b/c"). 405 (already exists) is fine. */
export async function ensureFolder(account, folderPath) {
  let current = "";
  for (const segment of folderPath.split("/").filter(Boolean)) {
    current += "/" + segment;
    const res = await authFetch(account, `${davRoot(account)}/${encodePath(current)}`, { method: "MKCOL" });
    if (![201, 405].includes(res.status)) throw await davFailure(`Creating folder "${current}"`, res);
  }
}

// ---- uploads ---------------------------------------------------------------
// Large files go through Nextcloud's chunked upload (apps/dav/lib/Upload/ChunkingV2Plugin.php, with
// v1 as the server-side fallback): MKCOL an upload folder, PUT numbered chunks, MOVE ".file" into
// place. Every request carries a Destination header, which v2 requires and v1 ignores.

const MiB = 1024 * 1024;
// Stay under common proxy request limits (Cloudflare: 100 MB) even when the server allows larger chunks.
export const MAX_CHUNK_SIZE = 50 * MiB;
const MAX_CHUNKS = 10000; // Nextcloud accepts chunk numbers 1..10000
const CHUNK_ATTEMPTS = 4;
const RETRY_STATUSES = new Set([408, 423, 429, 500, ...PROXY_STATUSES]);
const OK = [200, 201, 204];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chunk size for this server from capabilities (files.chunked_upload.max_size, Nextcloud 28+).
 * 0 means the admin disabled chunking; unknown means use our own maximum.
 */
export function chunkSizeFromCapabilities(capabilities) {
  const max = capabilities?.files?.chunked_upload?.max_size;
  if (typeof max !== "number") return MAX_CHUNK_SIZE;
  return max <= 0 ? 0 : Math.min(max, MAX_CHUNK_SIZE);
}

/** `retryDelayMs` and `pollIntervalMs` exist for tests. */
export async function uploadFile(
  account,
  filePath,
  blob,
  { signal, chunkSize = account.chunkSize ?? MAX_CHUNK_SIZE, retryDelayMs = 1000, pollIntervalMs = 5000 } = {},
) {
  if (chunkSize > 0 && blob.size > chunkSize) {
    return uploadChunked(account, filePath, blob, { signal, chunkSize, retryDelayMs, pollIntervalMs });
  }
  const res = await authFetch(account, `${davRoot(account)}/${encodePath(filePath)}`, { method: "PUT", body: blob, signal });
  if (!OK.includes(res.status)) throw await davFailure("Upload", res);
}

async function uploadChunked(account, filePath, blob, { signal, chunkSize, retryDelayMs, pollIntervalMs }) {
  const size = Math.max(chunkSize, Math.ceil(blob.size / MAX_CHUNKS));
  const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const uploadUrl = `${account.baseUrl}/remote.php/dav/uploads/${encodeURIComponent(account.userId)}/thunderbird-${id}`;
  const headers = { Destination: `${davRoot(account)}/${encodePath(filePath)}` };

  const res = await authFetch(account, uploadUrl, { method: "MKCOL", headers, signal });
  if (res.status !== 201) throw await davFailure("Starting the upload", res);
  try {
    for (let offset = 0, n = 1; offset < blob.size; offset += size, n++) {
      await putChunk(account, `${uploadUrl}/${n}`, { headers, body: blob.slice(offset, offset + size), signal, retryDelayMs }, n);
    }
    await finishChunked(account, filePath, blob.size, `${uploadUrl}/.file`, { headers, signal, retryDelayMs, pollIntervalMs });
  } catch (e) {
    // Also cancels a v2 multipart write; Nextcloud's cleanup job would otherwise remove it after a day.
    await authFetch(account, uploadUrl, { method: "DELETE", headers }).catch(() => {});
    throw e;
  }
}

/** PUTs one chunk, retrying network errors and transient statuses. Re-sending a chunk number overwrites it. */
async function putChunk(account, url, { headers, body, signal, retryDelayMs }, n) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await authFetch(account, url, { method: "PUT", headers, body, signal });
    } catch (e) {
      if (signal?.aborted || attempt >= CHUNK_ATTEMPTS) throw new Error(`Upload interrupted at part ${n}: ${e.message}`);
    }
    if (res && OK.includes(res.status)) return;
    if (res && (attempt >= CHUNK_ATTEMPTS || !RETRY_STATUSES.has(res.status))) throw await davFailure(`Uploading part ${n}`, res);
    await sleep(retryDelayMs * 2 ** attempt);
  }
}

/**
 * MOVE assembles the file on the server. Without object storage that copies the whole file, which can
 * outlast a proxy timeout while Nextcloud carries on. So on a dropped MOVE, wait for the file to appear.
 * Transient errors (a lock, a busy server) are retried like chunks.
 */
async function finishChunked(account, filePath, totalSize, fileUrl, { headers, signal, retryDelayMs, pollIntervalMs }) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await authFetch(account, fileUrl, {
        method: "MOVE",
        headers: { ...headers, "OC-Total-Length": String(totalSize) },
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    if (res && OK.includes(res.status)) return;
    // No answer, a proxy gave up, or an earlier attempt already consumed the upload folder:
    // the server may have the file (or still be assembling it).
    if (!res || PROXY_STATUSES.has(res.status) || (attempt > 1 && res.status === 404)) break;
    if (attempt >= CHUNK_ATTEMPTS || !RETRY_STATUSES.has(res.status)) throw await davFailure("Finishing the upload", res);
    await sleep(retryDelayMs * 2 ** attempt);
  }
  if (!(await waitForFile(account, filePath, totalSize, { signal, intervalMs: pollIntervalMs }))) {
    throw new Error("Finishing the upload timed out: Nextcloud did not report the assembled file within 15 minutes.");
  }
}

/** Polls until `filePath` exists with `size` bytes. Resolves false on timeout. */
export async function waitForFile(account, filePath, size, { signal, timeoutMs = 15 * 60 * 1000, intervalMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const res = await authFetch(account, `${davRoot(account)}/${encodePath(filePath)}`, {
      method: "PROPFIND",
      headers: { Depth: "0", "Content-Type": "application/xml" },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>',
      signal,
    }).catch((e) => {
      if (signal?.aborted) throw e;
      return null;
    });
    if (res?.status === 207) {
      const length = /<[a-z0-9]*:?getcontentlength>(\d+)</i.exec(await res.text())?.[1];
      if (Number(length) === size) return true;
    }
  }
  return false;
}

export async function deleteFile(account, filePath) {
  const res = await authFetch(account, `${davRoot(account)}/${encodePath(filePath)}`, { method: "DELETE" });
  if (![200, 204, 404].includes(res.status)) throw await davFailure("Delete", res);
}

/** Whether a folder has nothing in it (PROPFIND Depth 1 lists only the folder itself). */
async function folderIsEmpty(account, folderPath) {
  const res = await authFetch(account, `${davRoot(account)}/${encodePath(folderPath)}`, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml" },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  });
  if (res.status === 404) return false; // already gone: nothing to remove
  if (res.status !== 207) throw await davFailure("Checking the folder", res);
  const responses = (await res.text()).match(/<(?:[a-z0-9]+:)?response[\s>]/gi) ?? [];
  return responses.length === 1;
}

/**
 * Deletes a file this add-on uploaded (`path` from addOnShares), which also removes its links. With
 * Nextcloud's trash bin (on by default) it goes to Deleted files. Its per-upload folder is removed
 * too, but only if that leaves it empty. Resolves "deleted", or "gone" if the file no longer existed.
 */
export async function deleteUploadedFile(account, path) {
  // Same pattern the shared-files page lists by: never delete anything outside a per-upload folder.
  if (!UPLOAD_PATH.test(path ?? "")) throw new Error("This file was not uploaded by this add-on, so it was not deleted.");
  const res = await authFetch(account, `${davRoot(account)}/${encodePath(path)}`, { method: "DELETE" });
  if (![200, 204, 404].includes(res.status)) throw await davFailure("Deleting the file", res);
  const folder = path.split("/").slice(0, -1).join("/");
  try {
    if (await folderIsEmpty(account, folder)) await deleteFile(account, folder);
  } catch {
    // The file is gone; an empty folder left behind is harmless.
  }
  return res.status === 404 ? "gone" : "deleted";
}
