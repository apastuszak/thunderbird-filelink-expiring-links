# Feature roadmap

These are proposed features, not commitments or scheduled releases. Priorities reflect expected usefulness and a suggested implementation order. Each feature needs its own implementation review and tests before release.

## Road to 1.0

Version 1.0 is when the add-on will be listed on [addons.thunderbird.net](https://addons.thunderbird.net/), which gives users automatic updates. Until then, updates are manual: users install each release's XPI from the [Releases page](https://github.com/apastuszak/thunderbird-filelink-expiring-links/releases).

Before listing:

- **Localisation.** Add `_locales/` and move user-facing strings (manifest, options page, password window, notifications, error messages) into message files, with English as the default.
- **Live verification of the remaining untested paths.** The notification-click and startup retries of a password email, and the fallback to the default identity when the sending identity was deleted, are covered only by mocked tests so far.
- **Data-collection declaration.** Add `data_collection_permissions` to the manifest (`web-ext lint` already warns about it); the add-on collects no data and sends nothing anywhere except the user's own server.
- **Permission justifications for reviewers**, especially `compose` (adding the password at send time, opening the password email) and `accountsRead` (keeping the original sending identity for the password email), plus the per-server optional host permissions.
- **Privacy note.** State what is stored locally (the app password; link passwords and recipients only until delivered, at most 90 days) and that nothing leaves the computer except requests to the user's own server.
- **Manual test pass in Thunderbird** on the release candidate, against a real Nextcloud server.

## Priorities

| Order | Feature | Intended benefit |
| --- | --- | --- |
| 1 | Shared-files page: link revocation (done in 0.3.0) and pending actions | Let users correct mistakes after sending, and resolve pending work after notifications disappear. |
| 2 | Optional cleanup of old uploads | Prevent expired shares from leaving files indefinitely. |
| 3 | Sharing panel in the compose window: summary, then per-message choices | Make protection clear before sending, and adapt it to individual messages. |
| 4 | Large-upload status view | Explain long-running uploads and server processing. |

## 1. Shared-files page: link revocation and pending actions

**Status:** The shared-files list with **Revoke link** is implemented (0.3.0): opened from the provider's settings page, built from the server's share list, no local records. **Delete file** is implemented too (the file goes to Nextcloud's trash bin when enabled; the per-upload folder is removed only if empty). Not yet done: the Pending section, showing which email a share was sent with, and paging for very large share lists.

**Scope:** One page that lists recently shared files with a **Revoke link** control, so users can withdraw access after sending the wrong file or choosing the wrong recipients. A **Pending** section on the same page shows password emails waiting to open and server cleanups waiting to retry, with Retry now, Open password email, and Discard controls appropriate to each. Pending work is rare by design, so it does not warrant a page of its own.

**Design constraints (shared files):**

- Prefer Nextcloud as the source of truth: `GET /ocs/v2.php/apps/files_sharing/api/v1/shares` lists the user's own shares with id, URL, path, expiry and label (`ShareAPIController::formatShare`), and every share this add-on creates is labelled "Thunderbird" in a known upload folder. Verify this listing against a real Nextcloud instance first. Building the list from the server keeps local storage minimal, works across computers and reinstalls, and reflects changes made in Nextcloud.
- Filter by folder in the add-on, not on the server. The API's folder filter (`path` with `subfiles=true`) is shallow: it lists only shares on items directly inside that folder (`getSharesInDir` uses `getDirectoryListing()`, and `Share20\Manager::getSharesInFolder` rejects non-shallow requests). Uploads live one level deeper (`<upload folder>/<random>/<file>`), so fetch the user's shares and match by path prefix and the "Thunderbird" label. Matching the label as well covers uploads from before the upload folder was changed. Add paging if a user has thousands of shares.
- Revoking uses `DELETE …/shares/<id>`, which the add-on already calls when an attachment is removed. No new permissions are needed.
- The server does not know which email a share was sent with. If that context is needed, keep only a separate, minimal local record for it; never retain passwords or make sent links eligible for draft-password recovery. Document what is kept and for how long.
- Distinguish revoking a public link from deleting the uploaded file.
- Explain that revocation cannot recall copies already downloaded.
- Verify the original server and user before any destructive operation, including after reconnecting an account.

**Design constraints (pending actions):**

- Reuse the existing pending-job storage and retry mechanisms.
- Show a useful failure reason without exposing credentials or passwords in logs.
- Explain that discarding a password-email job may lose the only remaining copy of its passwords, while discarding cleanup leaves server content in place.
- Preserve expiry, account-removal cleanup, and original-server/user checks.
- Open password drafts for review; never send automatically.

**Done when:** Users can identify a share, revoke it, and see whether revocation succeeded or is waiting for retry; and can discover and resolve pending work without a notification, including after restarting Thunderbird. Repeated clicks cannot start duplicate operations. Test against a real Nextcloud instance.

## 2. Optional cleanup of old uploads

**Scope:** Offer an opt-in retention policy, such as deleting uploaded files 30 days after their links expire, with a preview of affected files.

**Design constraints:**

- Link expiry does not itself delete the file.
- Depend on trustworthy share data from feature 1 (ideally the server's own share list); define handling for links without expiry and shares changed outside the add-on.
- Protect unsent drafts and pending password delivery from automatic deletion.
- Limit deletion to uploads owned by the add-on and verified against the original connection.
- Run cleanup while Thunderbird is open; do not promise deletion at an exact time.
- Make the consequences of file deletion clear before enabling the policy.
- Document the server-side alternative: Nextcloud administrators can set up retention rules on the server, which run whether or not Thunderbird is open.

**Done when:** The preview and cleanup agree, protected files are excluded, and failed deletions can be retried safely. Validate expiry and deletion behavior on a real server.

## 3. Sharing panel in the compose window

Both parts need a control in the compose window; Thunderbird's compose toolbar button (`compose_action`) is the natural home for one shared panel. Build the summary first: it only reads what was applied, so it carries less risk than changing how shares are created.

### 3a. Sharing summary

**Scope:** Show the message's link count, expiration dates, password-delivery methods, and one-time restrictions, highlighting mixed settings and multiple passwords in reopened drafts. Optionally offer it as a review step before sending.

**Design constraints:**

- Summarize settings actually applied to shares, rather than current account defaults.
- Exclude quoted replies and HTML forwarded content from recovery; retain the documented plain-text forwarding limitation.
- Do not unnecessarily expose passwords in the summary.
- Ensure errors or a cancelled review cannot leave Thunderbird's send window locked.
- Avoid adding a mandatory confirmation to every email.

**Done when:** The summary accurately describes both new and recovered links, and the user can review or cancel without losing compose state.

### 3b. Per-message sharing choices

**Scope:** Allow a message to override account defaults for expiry, password protection, password delivery, and one-time download.

**Design constraints:**

- Thunderbird starts uploading as soon as a file is attached, so per-message choices must be set **before** attaching. Design the panel around that, and make clear that attaching first uses the account defaults.
- Confirm which Thunderbird UI and API mechanisms can support this on the minimum supported version.
- Apply choices before shares are created; changing a setting must not imply existing shares were updated.
- Respect enforced server policy and fail closed when requested restrictions cannot be applied.
- Define behavior for multiple Filelink accounts in one message and for reopened drafts.
- Keep account defaults as the starting point so ordinary uploads remain simple.

**Done when:** A message can use different settings from its account defaults without changing other messages, and the resulting server shares match the selected settings.

## 4. Large-upload status view

**Scope:** Show stages such as uploading, assembling, creating the share, and applying restrictions in an extension-owned view, with useful failure and retry information.

**Design constraints:**

- Thunderbird's cloudFile API has no upload-progress reporting mechanism (confirmed in Thunderbird 158: its only functions are `getAccount`, `getAllAccounts` and `updateAccount`); investigate a separate UI rather than promising native progress integration.
- Report only measurable progress. Chunk completion can inform upload progress; server assembly should remain an indeterminate stage unless the server supplies more information.
- Support concurrent uploads and distinguish cancellation from failure.
- Keep retry behavior consistent with existing protections against duplicate shares and partially configured links.
- Never expose credentials or full share URLs in diagnostic logs.

**Done when:** Users can distinguish an active transfer from server processing and a failed operation without opening developer tools.

## Open question: other servers

The add-on's name, "Expiring Links for Self-Hosted Cloud Storage", suggests servers beyond Nextcloud, but it currently works only with Nextcloud (Login Flow v2, the OCS Share API, Nextcloud's chunked uploads). Decide whether other servers, such as ownCloud, are in scope. Until then, keep describing the add-on as working with Nextcloud only.

## Verification before release

- Keep regression tests for failure, cancellation, restart, and account-switching behavior.
- Run the Node suite in the default time zone, Australia/Sydney, and America/Los_Angeles, plus lint and build checks.
- Validate changes to sharing, expiry, download limits, revocation, or server deletion against a real Nextcloud instance.
- Verify UI behavior in Thunderbird. In particular, the existing notification-click and startup password-email retries still need live verification; passing mocked tests does not establish that they work in the application.
