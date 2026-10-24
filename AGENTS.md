# AGENTS.md

Instructions for AI coding agents and contributors working on this repository. (`CLAUDE.md` only imports this file; edit this one.)

**Expiring Links for Self-Hosted Cloud Storage** is a Thunderbird (MailExtension, Manifest V2) Filelink provider that works with Nextcloud. It uploads an attachment over WebDAV, creates a public share through the OCS Share API, and returns the link. It supports expiry, an optional generated password (with a choice of how to deliver it), and a one-time-download option.

## Goals

- The user enters only the Nextcloud base URL (e.g. `https://cloud.example.com` or `https://example.com/nextcloud`). Everything else is derived.
- Sign-in via Login Flow v2; store only the app password, never the real password.
- Per-account defaults: upload folder, expiry in days, generated password, how to deliver it, one-time download.
- Never hand out a link weaker than what the user asked for (see "One-time links" below).

## Target versions

- Thunderbird 128 ESR or newer (`strict_min_version` 128.0). Raise it only if an API needs it. Tested with Thunderbird 158.
- Nextcloud: whatever is currently supported; check `status.php` and capabilities rather than assuming versions. Tested on Nextcloud 35 (AIO, behind a Caddy reverse proxy).

## Layout

- `manifest.json`: `cloud_file` provider; permissions `storage`, `notifications`, `clipboardWrite`, `compose`, `accountsRead`; optional host permissions `https://*/*` plus `http://localhost/*` and `http://127.0.0.1/*` (the server is unknown at build time and is requested per server at Connect).
- `background.js`: `cloudFile` listeners (`onFileUpload`, `onFileUploadAbort`, `onFileDeleted`, `onAccountDeleted`), password delivery (`compose.onBeforeSend`/`onAfterSend`), draft recovery, startup tasks.
- `lib/nextcloud.js`: URL normalisation, `status.php` check, Login Flow v2, OCS calls, WebDAV and chunked uploads. No Thunderbird APIs, so it stays unit-testable in Node.
- `lib/message.js`: adds link passwords to an outgoing message and finds the add-on's links in it (outside quoted text). No Thunderbird APIs.
- `password/`: popup that shows a generated link password and asks how to deliver it.
- `options/`: settings page shown in the account settings. Thunderbird appends `?accountId=<id>` to `management_url`.
- `shares/`: shared-files page (opened from the settings page, `?accountId=<id>`). Lists the add-on's link shares from the server (`listShares` + `addOnShares`: link shares labelled `SHARE_LABEL` on a file in a `<folder>/<16 hex>/` upload folder, or `/<16 hex>/` when the upload folder is the root; Nextcloud's folder filter is shallow, so matching happens client-side), revokes them (`revokeShare`, a share `DELETE`; a 404 means already gone; the file stays), and deletes files (`deleteUploadedFile`: WebDAV `DELETE` of the file only, which removes its shares; refuses any path outside a per-upload folder). The per-upload folder is left in place: a folder `DELETE` is recursive, so an emptiness check before it could still remove a file added in between. Before revoking or deleting, the page re-reads the account and acts only if its server and user still match the list's (with the current app password); otherwise it reloads. A reload clears the old rows first, so a failed one leaves no buttons from a previous connection. Keeps no local records.
- `shares/pending.js`: local Pending actions section, independent of the server share list. Uses account-scoped `pending:list`, `pending:retry`, and `pending:discard` runtime messages. Background returns summaries without password bodies or credentials and serializes retry/discard operations with startup and notification retries. Discard confirmations explain lost passwords or server content left behind. The settings entry remains accessible while disconnected.
- `icons/icon.svg`: the add-on's original icon.
- `test/`: Node tests (`npm test`, no dependencies); see "Tests" below.
- Storage (`browser.storage.local`):
  - `accounts[accountId]`: baseUrl, loginName, appPassword, userId, displayName, policy, chunkSize, downloadLimit, and the per-account defaults.
  - `upload:<accountId>:<session>:<fileId>`, one key per upload so parallel uploads cannot overwrite each other: shareId, davPath, accountId, server, userId, session, tabId, createdAt, url, name, password, delivery. `session` is a random ID per run of the add-on, because Thunderbird numbers fileIds and tab IDs from 1 again every session; without it a new upload or send in a later session could overwrite or delete an unsent draft's record. The link password and delivery choice are kept so a draft reopened later can be recovered at send time (`recoverDraft`, which ignores quoted replies and HTML `.moz-forward-container` blocks). Records are removed when their message is sent and pruned after 90 days.
  - `pendingDelete:<id>`: cleanups that failed (removed attachments and rollback after failed or cancelled uploads), retried at startup. Jobs retain the original server and user ID and do not contain credentials. New jobs include `createdAt`; retries save `lastError` for the pending-actions page.
  - `pendingPasswordEmail:<id>`: separate password emails awaiting a successful `compose.beginNew`, including compose details (recipients and passwords), upload record keys, contributing `accountIds`, `createdAt`, and a redacted `lastError` after failures. Retried from Pending actions, by clicking the failure notification, or at startup; upload records are removed as soon as the job is saved, and the job is removed after the password draft opens, after 90 days (checked before retry), or when a contributing account is deleted. Jobs without a timestamp are discarded. The password draft preserves the original sending identity via `accountsRead`; if that identity is deleted, retry with the default identity and notify the user to check From. Older jobs without an identity use the default. Never sent automatically.
  - Saved cleanups only run if their `server` and `userId` match the account's current connection (`madeHere`): after reconnecting elsewhere, a saved share ID names an unrelated share. Saves without them (older versions) are skipped.

## Conventions

- Plain ES modules, no bundler, no runtime dependencies. Dev tooling only: `web-ext` (via `npx`).
- Use the `browser.*` namespace. Everything is promise-based.
- Keep `lib/nextcloud.js` and `lib/message.js` free of `browser.*` calls.
- Requests carrying the app password go through `authFetch()` in `lib/nextcloud.js`, which refuses redirects so the `Authorization` header cannot follow one. Login Flow polling also refuses redirects.
- Host permissions use `originPattern()`, which drops the port: Firefox/Thunderbird match patterns do not support ports and cover all ports of a host.
- Share links are checked with `checkShareUrl()` before going into an email: https only (another public domain is fine), plain http only for a local server's own links.
- WebDAV errors pass on Nextcloud's `<s:message>` text via `davFailure()`.
- Server settings (`policy`, `chunkSize`, `downloadLimit`) come from `serverInfo(capabilities)`; saved at Connect, refreshed on every start.
- Wrap Nextcloud failures in `Error` with a message a human can act on; `onFileUpload` returns `{ error }` rather than throwing. `compose.onBeforeSend` must never throw (Thunderbird would hang the send with the window locked); cancel instead.
- Do not log credentials, link passwords or full share URLs.
- Server data and passwords go into pages and messages with `textContent`, never `innerHTML`.

## Commands

```
npm run lint     # web-ext lint (via npx; nothing to install)
npm test         # node --test (run with TZ=Australia/Sydney and TZ=America/Los_Angeles too)
npm run build    # produces dist/*.zip (ignore-files already excludes dev files)
npx web-ext run --target=thunderbird --firefox=/path/to/thunderbird   # temporary install
```

Alternatively: Thunderbird > Tools > Developer Tools > Debug Add-ons > Load Temporary Add-on > pick `manifest.json`.

## Tests

- `test/nextcloud.test.js`: URL normalisation, policy, dates, passwords, OCS/WebDAV errors, chunked uploads, Login Flow.
- `test/message.test.js`: the message helpers (plain text).
- `test/background.test.js`: runs `background.js` end to end against a fake Thunderbird API, including restarts (a fresh module instance against the same storage).
- Not covered by Node (no DOM): HTML message handling and the options page. Check HTML changes against Thunderbird's Filelink markup (`.cloudAttachmentItem[data-content-location]`).
- When fixing a bug, add a test that fails without the fix.

## Releases

1. Bump `version` in both `manifest.json` and `package.json`.
2. `npm test`, `npm run lint`, `npm run build`; rename `dist/*.zip` to `thunderbird-filelink-expiring-links-<version>.xpi` (the XPI includes `LICENSE`).
3. Commit, push, then `gh release create v<version> <xpi> --target main`, with release notes for users (install steps, requirements, what changed) and the XPI's SHA-256.
4. If you test on a new Nextcloud or Thunderbird version, update the "tested on" wording in `manifest.json` (description, 132 characters max), the README and the release notes.

## Naming and trademarks

Nextcloud's trademark guidelines (https://nextcloud.com/trademarks/) say third-party apps should not include a Nextcloud mark in their name, and the Nextcloud logo may not be used as the add-on's icon. So:

- The add-on is named "Expiring Links for Self-Hosted Cloud Storage"; the Filelink provider label is "Expiring Links".
- "Works with Nextcloud" and "tested on Nextcloud <version>" appear only as factual compatibility statements.
- `icons/icon.svg` is an original icon. Never add Nextcloud's logo or brand colours.
- The README states the project is not affiliated with or endorsed by Nextcloud GmbH. Keep it that way.

## Nextcloud API reference

- Server check: `GET <base>/status.php` (`installed: true`).
- Login Flow v2: `POST <base>/index.php/login/v2` returns `{poll:{token,endpoint}, login}`. Poll `endpoint` with `token` (404 until done, 200 returns `{server, loginName, appPassword}`).
- Current user: `GET <base>/ocs/v2.php/cloud/user?format=json` (header `OCS-APIRequest: true`). Use `ocs.data.id` as the WebDAV user ID, not the login name.
- Capabilities: `GET <base>/ocs/v2.php/cloud/capabilities?format=json`; see `files_sharing.public` for password/expiry policy, `files.chunked_upload` for chunk size, `downloadlimit` for the Download Limit app.
- Upload: WebDAV `PUT <base>/remote.php/dav/files/<userId>/<path>`, folders via `MKCOL` (405 means it exists).
- Share: `POST <base>/ocs/v2.php/apps/files_sharing/api/v1/shares` with `shareType=3`, `permissions=1`, optional `password`, `expireDate` (YYYY-MM-DD). Delete: `DELETE .../shares/<id>`.
- App password: `DELETE <base>/ocs/v2.php/core/apppassword` revokes the one in use.

## Known gaps and design notes

1. **One-time links.** `setDownloadLimit()` matches the Download Limit app's source: OCS `PUT /apps/files_downloadlimit/api/v1/{token}/limit` with an integer `limit` >= 1 (`appinfo/routes.php`, `ApiController::setDownloadLimit`; single-file link shares only). Availability comes from the `downloadlimit.enabled` capability, saved as `downloadLimit` at Connect and refreshed on startup; the options page disables the checkbox without it. On failure the share and file are deleted and an error returned, rather than an unlimited link; that must stay.
2. **Mail scanners can burn a one-time link.** Security gateways and link previewers fetch URLs. Documented in the README's Known limitations, which recommends pairing one-time downloads with a password.
3. **Sub-day expiry is not possible through the share API** (`expireDate` is date-only). Documented in the README. Do not fake it client-side; Thunderbird may be closed.
4. **Server policy on expiry.** Confirmed in Nextcloud's source (`lib/private/Share20/Manager.php`, `validateExpirationDate`): an expiry beyond an enforced maximum is rejected ("Cannot set expiration date more than %n days in the future"), not shortened, so the requested days are capped with `clampExpiryDays` using the stored policy. Shares expire at 23:59:59 of the chosen date in the user's Nextcloud time zone (`core/timezone`, set by the web UI; else the server's `default_timezone`, UTC by default; `lib/private/DateTimeZone.php`), so the date shown in the email is the last day the link works. `expireDate` is computed from this computer's date; when that is a day ahead of Nextcloud's, a request at an enforced maximum is rejected, so `background.js` retries once a day shorter, only when Nextcloud itself refused (`ocsStatus`, set only when the response has an OCS `meta` block), never after a network error or a bare proxy status (499/502/504), when the first share may already exist.
5. **Generated password delivery.** All password links in one compose tab share one password (keyed by the `tab` argument of `onFileUpload`). `password/password.html` (a popup) shows it and asks how to deliver it, once per message; choices apply immediately, so closing the window keeps the shown choice (separate email by default). The clipboard is used only for "I'll send it myself" or the Copy button, since it lingers and macOS Universal Clipboard shares it with other devices. If adding the password at send time fails, the send is cancelled and delivery falls back to a separate email. Choices: separate email (after `compose.onAfterSend`, `compose.beginNew` opens a draft to the same recipients and sending identity (requires `accountsRead`); if the identity was deleted, fall back to the default and notify the user to check From, never sent automatically), same email (`compose.onBeforeSend` adds a "Password:" row under each `.cloudAttachmentItem[data-content-location=<url>]`, see `lib/message.js`), or the user sends it themselves (when recovering older links at send time, copy all distinct passwords together, labeled by file name if they differ). "Remember my choice" sets the per-account `passwordDelivery` (`ask`|`separate`|`same`|`self`), also on the options page. Unverified in Thunderbird: `tabs.onRemoved` for compose tabs.
6. **Large files.** Files larger than one chunk use Nextcloud chunked upload (`/remote.php/dav/uploads/<user>/thunderbird-<id>/<1..10000>`, then `MOVE .file`, with `Destination` on every request; see `apps/dav/lib/Upload/ChunkingV2Plugin.php`). The chunk size comes from `files.chunked_upload.max_size`, capped at 50 MiB to stay under proxy limits; 0 disables chunking. Chunks are retried on network errors and proxy/5xx statuses. If a proxy drops the final `MOVE` (assembly copies the whole file without object storage), the add-on polls `PROPFIND` until the file has the full size. Not done: progress reporting (the `cloudFile` API has none), parallel chunks, resume across restarts.
7. **`management_url` and `accountId`.** Confirmed in Thunderbird 158 (`preferences/compose.js`): the page is loaded as `management_url + ?accountId=<accountKey>`. Thunderbird does not persist an account's `configured` flag (every add-on account starts unconfigured), so `background.js` restores it from storage on startup. The options page saves every change immediately; there is no Save button.
8. **Self-signed certificates** will fail in `fetch`; valid TLS is required. Plain HTTP is refused except for `localhost`/`127.0.0.1` (the app password would travel in clear text).
9. **Localisation** is missing (`_locales/`). The add-on ID (`thunderbird-filelink-expiring-links@apastuszak`) is final: changing it after the first release breaks updates.
10. **Removed attachments of reopened drafts.** After a restart Thunderbird reports the removal with a new fileId and no URL, so the file stays on the server (it still expires). Documented in the README's Known limitations.

## Rules for changes

- Never request broader host permissions up front; keep them optional and per-server.
- Keep the user's real password out of the extension. Only the app password is stored.
- Test against a real Nextcloud instance for anything touching sharing, expiry or download limits; do not assume API behaviour from memory. Check Thunderbird and Nextcloud source when behaviour matters.
- The repository is public: never commit server names, IP addresses, credentials, personal email addresses or local paths.
