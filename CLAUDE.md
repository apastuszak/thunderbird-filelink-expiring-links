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
- `options/`: settings page shown in the account settings. Thunderbird appends `?accountId=<id>` to `management_url`.
- Storage (`browser.storage.local`): `accounts[accountId]` (baseUrl, loginName, appPassword, userId, defaults) and `uploads[fileId]` (shareId, davPath) for cleanup.

## Conventions

- Plain ES modules, no bundler, no runtime dependencies. Dev tooling only: `web-ext`.
- Use the `browser.*` namespace. Everything is promise-based.
- Wrap Nextcloud failures in `Error` with a message a human can act on; `onFileUpload` returns `{ error }` rather than throwing.
- Do not log credentials or full share URLs.
- Keep `lib/nextcloud.js` free of `browser.*` calls.

## Commands

```
npm install --save-dev web-ext
npm run lint     # web-ext lint
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

1. **One-time links are unverified.** Core Nextcloud has no download counter. `setDownloadLimit()` in `lib/nextcloud.js` calls a route I recalled for the Download Limit app (`files_downloadlimit`) and have not confirmed. Read that app's source (routes/controllers), fix the endpoint and verb, and detect availability up front (capabilities or a probe) so the options page can disable the checkbox when it is missing. Current behaviour on failure is correct and must stay: delete the share and file and return an error, rather than returning an unlimited link.
2. **Mail scanners can burn a one-time link.** Security gateways and link previewers fetch URLs. Consider a password on one-time links, or documenting this limit in the options page.
3. **Sub-day expiry is not possible through the share API** (`expireDate` is date-only). Options: document the limit, or provide a small server-side cron/`occ` helper. Do not fake it client-side; Thunderbird may be closed.
4. **Server policy clamps expiry.** If the admin enforces a maximum, the returned `expiration` may differ from what was requested. `templateInfo.download_expiry_date` is built from the server's response for that reason; verify this against a server with an enforced maximum.
5. **Generated password delivery.** The password is shown in a desktop notification only. Better: insert it into the compose body, or at least offer copy-to-clipboard. Check what `cloudFile` `templateInfo` and the `compose` API allow.
6. **Large files.** Single `PUT` of a `File` blob. Add Nextcloud chunked upload (`/remote.php/dav/uploads/<user>/`) with progress and resume for big attachments; mind server `upload_max_filesize` and proxy limits.
7. **`management_url` and `accountId`.** The options page assumes Thunderbird passes `?accountId=`. Confirm in the Thunderbird version you test; if not, derive the account from `browser.cloudFile.getAllAccounts()`.
8. **Self-signed certificates / plain HTTP** will fail in `fetch`. Decide whether to support them or document that valid TLS is required.
9. **Localisation** is missing (`_locales/`); add before publishing. The icon (`icons/nextcloud.svg`) is Nextcloud's own app icon from `nextcloud/server` (`core/img/favicon.svg`); the logo is a Nextcloud GmbH trademark, so check their brand guidelines before listing on addons.thunderbird.net. The add-on ID (`thunderbird-filelink-expiring-links@apastuszak`) is final: changing it after the first release breaks updates.
10. **Tests.** Add Node tests for `normalizeBaseUrl`, `sharePolicy` and the OCS error handling with mocked `fetch`.

## Rules for changes

- Never request broader host permissions up front; keep them optional and per-server.
- Keep the user's real password out of the extension. Only the app password is stored.
- Test against a real Nextcloud instance for anything touching sharing, expiry or download limits; do not assume API behaviour from memory.
