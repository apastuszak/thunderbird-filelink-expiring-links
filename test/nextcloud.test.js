import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  chunkSizeFromCapabilities,
  clampExpiryDays,
  createPublicShare,
  MAX_CHUNK_SIZE,
  localDateFromNow,
  normalizeBaseUrl,
  parseShareDate,
  randomPassword,
  sharePolicy,
  startLoginFlow,
  uploadFile,
} from "../lib/nextcloud.js";

const account = { baseUrl: "https://cloud.example.com", loginName: "alice", appPassword: "secret", userId: "alice" };
const realFetch = globalThis.fetch;

/** Replaces fetch with one that returns `body` (object -> JSON, string -> text) and records calls. */
function mockFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return calls;
}

/** Replaces fetch with `handler(method, url, init)`, which returns [status, body] or throws. */
function routeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url, init });
    const [status, body = ""] = await handler(method, url, init);
    return new Response(body, { status });
  };
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("normalizeBaseUrl", () => {
  it("adds https and keeps subpaths", () => {
    assert.equal(normalizeBaseUrl("cloud.example.com"), "https://cloud.example.com");
    assert.equal(normalizeBaseUrl(" https://example.com/nextcloud/ "), "https://example.com/nextcloud");
  });

  it("strips tails copied from the address bar", () => {
    assert.equal(normalizeBaseUrl("https://example.com/nextcloud/index.php/apps/files/"), "https://example.com/nextcloud");
    assert.equal(normalizeBaseUrl("https://cloud.example.com/login"), "https://cloud.example.com");
  });

  it("rejects plain http except for this machine", () => {
    assert.throws(() => normalizeBaseUrl("http://cloud.example.com"), /https/);
    assert.equal(normalizeBaseUrl("http://localhost:8080"), "http://localhost:8080");
    assert.equal(normalizeBaseUrl("http://127.0.0.1"), "http://127.0.0.1");
  });

  it("rejects empty, invalid and non-web input", () => {
    assert.throws(() => normalizeBaseUrl(""), /Enter/);
    assert.throws(() => normalizeBaseUrl("https://exa mple.com"), /valid/);
    assert.throws(() => normalizeBaseUrl("ftp://example.com"), /https/);
  });
});

describe("sharePolicy and clampExpiryDays", () => {
  const caps = {
    files_sharing: { public: { password: { enforced: true }, expire_date: { enabled: true, enforced: true, days: 7 } } },
  };

  it("reads the public link policy", () => {
    assert.deepEqual(sharePolicy(caps), {
      passwordEnforced: true,
      expireDefaultEnabled: true,
      expireEnforced: true,
      expireDays: 7,
    });
    assert.deepEqual(sharePolicy({}), {
      passwordEnforced: false,
      expireDefaultEnabled: false,
      expireEnforced: false,
      expireDays: null,
    });
  });

  it("caps expiry only when the server enforces a maximum", () => {
    const policy = sharePolicy(caps);
    assert.equal(clampExpiryDays(30, policy), 7);
    assert.equal(clampExpiryDays(3, policy), 3);
    assert.equal(clampExpiryDays(0, policy), 0);
    assert.equal(clampExpiryDays(30, { expireEnforced: false, expireDays: 7 }), 30);
    assert.equal(clampExpiryDays(30, undefined), 30);
  });
});

describe("dates", () => {
  it("counts days on the local calendar", () => {
    // Early morning local time: a UTC-based calculation would land on the wrong day east of UTC.
    assert.equal(localDateFromNow(1, new Date(2026, 9, 19, 1, 0)), "2026-10-20");
    // Late evening: likewise west of UTC.
    assert.equal(localDateFromNow(1, new Date(2026, 9, 18, 23, 30)), "2026-10-19");
    assert.equal(localDateFromNow(14, new Date(2026, 11, 25, 12, 0)), "2027-01-08");
  });

  it("reads the share expiration as a local date", () => {
    const d = new Date(parseShareDate("2026-10-25 00:00:00"));
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 9, 25]);
    assert.equal(parseShareDate(null), null);
    assert.equal(parseShareDate("soon"), null);
  });
});

describe("randomPassword", () => {
  it("has the requested length and every character class", () => {
    for (let i = 0; i < 200; i++) {
      const pw = randomPassword();
      assert.equal(pw.length, 16);
      assert.match(pw, /[A-Z]/);
      assert.match(pw, /[a-z]/);
      assert.match(pw, /[0-9]/);
      assert.match(pw, /[^A-Za-z0-9]/);
      assert.match(pw, /^[A-HJ-NP-Za-km-z2-9!#%+\-=?@_]+$/);
    }
  });
});

describe("OCS error handling", () => {
  it("returns share fields on success", async () => {
    const calls = mockFetch(200, {
      ocs: { meta: { statuscode: 200 }, data: { id: "42", token: "abc", url: "https://x/s/abc", expiration: "2026-10-25 00:00:00" } },
    });
    const share = await createPublicShare(account, { path: "/f/a.txt", expireDate: "2026-10-25" });
    assert.deepEqual(share, { id: "42", token: "abc", url: "https://x/s/abc", expiration: "2026-10-25 00:00:00" });
    assert.match(calls[0].url, /\/ocs\/v2\.php\/apps\/files_sharing\/api\/v1\/shares\?format=json$/);
    assert.equal(calls[0].init.headers["OCS-APIRequest"], "true");
    assert.equal(calls[0].init.body.get("expireDate"), "2026-10-25");
  });

  it("passes on the server's message", async () => {
    mockFetch(403, { ocs: { meta: { statuscode: 403, message: "Expiration date is too far in the future" }, data: [] } });
    await assert.rejects(createPublicShare(account, { path: "/a" }), /too far in the future/);
  });

  it("explains a rejected app password", async () => {
    mockFetch(401, { ocs: { meta: { statuscode: 401, message: "Unauthorised" }, data: [] } });
    await assert.rejects(createPublicShare(account, { path: "/a" }), /Disconnect, then Connect again/);
  });

  it("reports a non-JSON 200 instead of crashing", async () => {
    mockFetch(200, "<html>Sign in</html>");
    await assert.rejects(createPublicShare(account, { path: "/a" }), /proxy or single sign-on/);
  });
});

describe("login flow", () => {
  it("rejects a poll endpoint on another host", async () => {
    mockFetch(200, { login: "https://cloud.example.com/login/v2/flow/x", poll: { token: "t", endpoint: "https://evil.example/poll" } });
    await assert.rejects(startLoginFlow("https://cloud.example.com"), /evil\.example/);
  });

  it("accepts addresses on the same server", async () => {
    mockFetch(200, {
      login: "https://example.com/nextcloud/login/v2/flow/x",
      poll: { token: "t", endpoint: "https://example.com/nextcloud/login/v2/poll" },
    });
    const flow = await startLoginFlow("https://example.com/nextcloud");
    assert.equal(flow.pollUrl, "https://example.com/nextcloud/login/v2/poll");
  });
});

describe("WebDAV", () => {
  it("encodes paths and refuses dot segments", async () => {
    const calls = mockFetch(201, "");
    await uploadFile(account, "Thunderbird attachments/ab12/report #1.pdf", new Blob(["x"]));
    assert.equal(calls[0].url, "https://cloud.example.com/remote.php/dav/files/alice/Thunderbird%20attachments/ab12/report%20%231.pdf");
    await assert.rejects(uploadFile(account, "a/../b.txt", new Blob(["x"])), /cannot be "\.\."/);
  });

  it("gives actionable upload errors", async () => {
    mockFetch(507, "");
    await assert.rejects(uploadFile(account, "a/b.txt", new Blob(["x"])), /storage space/);
    mockFetch(413, "");
    await assert.rejects(uploadFile(account, "a/b.txt", new Blob(["x"])), /larger than the server/);
  });
});

describe("chunked upload", () => {
  const fast = { retryDelayMs: 0, pollIntervalMs: 0 };
  const dest = "https://cloud.example.com/remote.php/dav/files/alice/f/big.bin";
  const blob = new Blob(["x".repeat(25)]);

  it("picks the chunk size from capabilities", () => {
    assert.equal(chunkSizeFromCapabilities({ files: { chunked_upload: { max_size: 10 * 1024 * 1024 } } }), 10 * 1024 * 1024);
    assert.equal(chunkSizeFromCapabilities({ files: { chunked_upload: { max_size: 100 * 1024 * 1024 } } }), MAX_CHUNK_SIZE);
    assert.equal(chunkSizeFromCapabilities({ files: { chunked_upload: { max_size: 0 } } }), 0);
    assert.equal(chunkSizeFromCapabilities({}), MAX_CHUNK_SIZE);
  });

  it("uses a single PUT for files that fit in one chunk", async () => {
    const calls = routeFetch(() => [201]);
    await uploadFile(account, "f/small.bin", new Blob(["12345"]), { chunkSize: 10, ...fast });
    assert.deepEqual(calls.map((c) => c.method), ["PUT"]);
  });

  it("uploads numbered chunks and moves .file into place", async () => {
    const calls = routeFetch(() => [201]);
    await uploadFile(account, "f/big.bin", blob, { chunkSize: 10, ...fast });
    assert.deepEqual(calls.map((c) => c.method), ["MKCOL", "PUT", "PUT", "PUT", "MOVE"]);
    const base = calls[0].url;
    assert.match(base, /^https:\/\/cloud\.example\.com\/remote\.php\/dav\/uploads\/alice\/thunderbird-[0-9a-f]{16}$/);
    assert.deepEqual(calls.slice(1, 4).map((c) => [c.url, c.init.body.size]), [[`${base}/1`, 10], [`${base}/2`, 10], [`${base}/3`, 5]]);
    assert.equal(calls[4].url, `${base}/.file`);
    assert.equal(calls[4].init.headers["OC-Total-Length"], "25");
    for (const c of calls) assert.equal(c.init.headers.Destination, dest);
  });

  it("retries a chunk after a transient error", async () => {
    let failures = 1;
    const calls = routeFetch((method, url) => [method === "PUT" && url.endsWith("/2") && failures-- > 0 ? 502 : 201]);
    await uploadFile(account, "f/big.bin", blob, { chunkSize: 10, ...fast });
    assert.equal(calls.filter((c) => c.method === "PUT").length, 4);
  });

  it("cancels the upload folder and explains a permanent failure", async () => {
    const calls = routeFetch((method) => [method === "PUT" ? 507 : 201]);
    await assert.rejects(uploadFile(account, "f/big.bin", blob, { chunkSize: 10, ...fast }), /storage space/);
    assert.deepEqual(calls.map((c) => c.method), ["MKCOL", "PUT", "DELETE"]);
    assert.equal(calls[2].url, calls[0].url);
  });

  it("gives up on a chunk after repeated proxy errors", async () => {
    const calls = routeFetch((method) => [method === "PUT" ? 499 : 201]);
    await assert.rejects(uploadFile(account, "f/big.bin", blob, { chunkSize: 10, ...fast }), /proxy in front of Nextcloud.*HTTP 499/);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 4);
    assert.equal(calls.at(-1).method, "DELETE");
  });

  it("waits for the file when a proxy drops the final MOVE", async () => {
    let polls = 0;
    const calls = routeFetch((method) => {
      if (method === "MOVE") return [504];
      if (method === "PROPFIND") {
        polls++;
        const length = polls < 2 ? 10 : 25; // still assembling, then done
        return [207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getcontentlength>${length}</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`];
      }
      return [201];
    });
    await uploadFile(account, "f/big.bin", blob, { chunkSize: 10, ...fast });
    assert.equal(polls, 2);
    assert.equal(calls.filter((c) => c.method === "PROPFIND")[0].url, dest);
  });

  it("stops and cleans up when cancelled", async () => {
    const controller = new AbortController();
    const calls = routeFetch((method, url, init) => {
      if (method === "PUT" && url.endsWith("/2")) controller.abort();
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return [201];
    });
    await assert.rejects(uploadFile(account, "f/big.bin", blob, { chunkSize: 10, signal: controller.signal, ...fast }));
    assert.deepEqual(calls.map((c) => c.method), ["MKCOL", "PUT", "PUT", "DELETE"]);
  });

  it("explains a proxy error on a single PUT", async () => {
    routeFetch(() => [499]);
    await assert.rejects(uploadFile(account, "f/small.bin", new Blob(["1"]), fast), /proxy in front of Nextcloud/);
  });
});
