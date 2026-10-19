# CLAUDE.md

Thunderbird (MailExtension, Manifest V2) Filelink provider for Nextcloud. Uploads an attachment over WebDAV, creates a public share through the OCS Share API, and returns the link. Supports expiry, optional generated password, and a one-time-download option.

## Goals

- User enters only the Nextcloud base URL (e.g. `https://cloud.example.com` or `https://example.com/nextcloud`). Everything else is derived.
- Sign-in via Login Flow v2; store only the app password, never the real password.
- Per-account defaults: upload folder, expiry in days, generated password, one-time download.
- Never hand out a link weaker than what the user asked for (see "One-time links" below).

## Target versions

- Thunderbird 128 ESR or newer (`strict_min_version` 128.0). Raise it only if an API needs it.
- Nextcloud: whatever is currently supported; check `status.php` and capabilities rather than assuming versions.

## Layout

- `manifest.json`: `cloud_file` provider, `storage` + `notifications`, optional host permissions (the server is unknown at build time).
- `background.js`: `cloudFile` listeners (`onFileUpload`, `onFileUploadAbort`, `onFileDeleted`, `onAccountDeleted`).
- `lib/nextcloud.js`: URL normalisation, `status.php` check, Login Flow v2, OCS calls, WebDAV calls. No Thunderbird APIs in here, so it stays unit-testable in Node.
- `password/`: popup asking how to deliver a generated link password.
- `lib/message.js`: adds the password to an outgoing message; no Thunderbird APIs.
- `options/`: settings page shown in the account settings. Thunderbird appends `?accountId=<id>` to `management_url`.
- Storage (`browser.storage.local`): `accounts[accountId]` (baseUrl, loginName, appPassword, userId, policy, defaults), one `upload:<accountId>:<fileId>` key per upload (shareId, davPath, tabId, createdAt) so parallel uploads cannot overwrite each other; removed when the message is sent, pruned after 90 days, and `pendingDelete:<id>` for cleanups that failed and are retried at startup.
- `test/`: Node tests for `lib/nextcloud.js` (`npm test`, no dependencies).

## Conventions

- Plain ES modules, no bundler, no runtime dependencies. Dev tooling only: `web-ext`.
- Use the `browser.*` namespace. Everything is promise-based.
- Host permissions use `originPattern()`, which drops the port: Firefox/Thunderbird match patterns do not support ports and cover all ports of a host.
- Share links are checked with `checkShareUrl()` before going into an email: https only (another public domain is fine), plain http only for a local server's own links.
- WebDAV errors pass on Nextcloud's `<s:message>` text via `davFailure()`.
- Requests carrying the app password go through `authFetch()` in `lib/nextcloud.js`, which refuses redirects so the `Authorization` header cannot follow one.
- Server settings (`policy`, `chunkSize`, `downloadLimit`) come from `serverInfo(capabilities)`; saved at Connect, refreshed on every start.
- Wrap Nextcloud failures in `Error` with a message a human can act on; `onFileUpload` returns `{ error }` rather than throwing.
- Do not log credentials or full share URLs.
- Keep `lib/nextcloud.js` free of `browser.*` calls.

## Commands

```
npm install --save-dev web-ext
npm run lint     # web-ext lint
npm test         # node --test (run with TZ=Australia/Sydney and TZ=America/Los_Angeles too)
npm run build    # produces dist/*.zip (ignore-files already excludes dev files)
npx web-ext run --target=thunderbird --firefox=/path/to/thunderbird   # temporary install
```

Alternatively: Thunderbird > Tools > Developer Tools > Debug Add-ons > Load Temporary Add-on > pick `manifest.json`.

## Nextcloud API reference

- Server check: `GET <base>/status.php` (`installed: true`).
- Login Flow v2: `POST <base>/index.php/login/v2` returns `{poll:{token,endpoint}, login}`. Poll `endpoint` with `token` (404 until done, 200 returns `{server, loginName, appPassword}`).
- Current user: `GET <base>/ocs/v2.php/cloud/user?format=json` (header `OCS-APIRequest: true`). Use `ocs.data.id` as the WebDAV user ID, not the login name.
- Capabilities: `GET <base>/ocs/v2.php/cloud/capabilities?format=json`; see `files_sharing.public` for password/expiry policy.
- Upload: WebDAV `PUT <base>/remote.php/dav/files/<userId>/<path>`, folders via `MKCOL` (405 means it exists).
- Share: `POST <base>/ocs/v2.php/apps/files_sharing/api/v1/shares` with `shareType=3`, `permissions=1`, optional `password`, `expireDate` (YYYY-MM-DD). Delete: `DELETE .../shares/<id>`.

## Known gaps and open questions (start here)

1. **One-time links.** `setDownloadLimit()` matches the Download Limit app's source: OCS `PUT /apps/files_downloadlimit/api/v1/{token}/limit` with an integer `limit` >= 1 (`appinfo/routes.php`, `ApiController::setDownloadLimit`; single-file link shares only). Availability comes from the `downloadlimit.enabled` capability, saved as `downloadLimit` at Connect and refreshed on startup; the options page disables the checkbox without it. On failure the share and file are deleted and an error returned, rather than an unlimited link; that must stay.
2. **Mail scanners can burn a one-time link.** Security gateways and link previewers fetch URLs. Consider a password on one-time links, or documenting this limit in the options page.
3. **Sub-day expiry is not possible through the share API** (`expireDate` is date-only). Options: document the limit, or provide a small server-side cron/`occ` helper. Do not fake it client-side; Thunderbird may be closed.
4. **Server policy on expiry.** Nextcloud is expected to reject (not shorten) an expiry beyond an enforced maximum, so the requested days are capped with `clampExpiryDays` using the policy stored at Connect time. The policy is only refreshed on reconnect. `templateInfo.download_expiry_date` is still built from the server's response. Verify both against a server with an enforced maximum.
5. **Generated password delivery.** All password links in one compose tab share one password (keyed by the `tab` argument of `onFileUpload`). `password/password.html` (a popup) shows it and asks how to deliver it, once per message; choices apply immediately, so closing the window keeps the shown choice (separate email by default). The clipboard is used only for "I'll send it myself" or the Copy button, since it lingers and macOS Universal Clipboard shares it with other devices. If adding the password at send time fails, the send is cancelled (Thunderbird would otherwise hang with the window locked) and delivery falls back to a separate email. Choices: separate email (after `compose.onAfterSend`, `compose.beginNew` opens a draft to the same recipients and identity, never sent automatically), same email (`compose.onBeforeSend` adds a "Password:" row under each `.cloudAttachmentItem[data-content-location=<url>]`, see `lib/message.js`), or the user sends it themselves. "Remember my choice" sets the per-account `passwordDelivery` (`ask`|`separate`|`same`|`self`), also on the options page. Needs the `compose` permission. Unverified in Thunderbird: clipboard writes from the background page, and `tabs.onRemoved` for compose tabs.
6. **Large files.** Files larger than one chunk use Nextcloud chunked upload (`/remote.php/dav/uploads/<user>/thunderbird-<id>/<1..10000>`, then `MOVE .file`, with `Destination` on every request; see `apps/dav/lib/Upload/ChunkingV2Plugin.php`). The chunk size comes from `files.chunked_upload.max_size` (saved at Connect), capped at 50 MiB to stay under proxy limits; 0 disables chunking. Chunks are retried on network errors and proxy/5xx statuses. If a proxy drops the final `MOVE` (assembly copies the whole file without object storage), the add-on polls `PROPFIND` until the file has the full size. Not done: progress reporting (the `cloudFile` API has none), parallel chunks, resume across restarts.
7. **`management_url` and `accountId`.** Confirmed in Thunderbird 158 (`preferences/compose.js`): the page is loaded as `management_url + ?accountId=<accountKey>`. Thunderbird does not persist an account's `configured` flag (every add-on account starts unconfigured), so `background.js` restores it from storage on startup. The options page saves every change immediately; there is no Save button.
8. **Self-signed certificates** will fail in `fetch`; valid TLS is required. Plain HTTP is refused except for `localhost`/`127.0.0.1` (the app password would travel in clear text).
9. **Localisation** is missing (`_locales/`); add before publishing. The icon (`icons/nextcloud.svg`) is Nextcloud's own app icon from `nextcloud/server` (`core/img/favicon.svg`); the logo is a Nextcloud GmbH trademark, so check their brand guidelines before listing on addons.thunderbird.net. The add-on ID (`thunderbird-filelink-expiring-links@apastuszak`) is final: changing it after the first release breaks updates.
10. **Tests.** `test/nextcloud.test.js` covers URL normalisation, policy, dates, passwords, OCS/WebDAV errors and Login Flow origin checks. `background.js` and the options page have no tests yet.

## Rules for changes

- Never request broader host permissions up front; keep them optional and per-server.
- Keep the user's real password out of the extension. Only the app password is stored.
- Test against a real Nextcloud instance for anything touching sharing, expiry or download limits; do not assume API behaviour from memory.
