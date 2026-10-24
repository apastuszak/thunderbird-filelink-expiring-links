# Expiring Links for Self-Hosted Cloud Storage

Thunderbird Filelink provider with expiring links, optional generated passwords and an optional one-time download limit.

**Works with Nextcloud.** Tested on Nextcloud 35 (AIO, behind a Caddy reverse proxy) with Thunderbird 158.

See the [feature roadmap](ROADMAP.md) for proposed improvements and priorities.

## Try it

1. Thunderbird 128 or newer: Tools > Developer Tools > Debug Add-ons > Load Temporary Add-on, and pick `manifest.json`.
2. Settings > Composition > Attachments > Add Filelink Provider > "Expiring Links".
3. Enter your Nextcloud URL and click Connect; finish the login in your browser.
4. Attach a file in the composer and choose to link it with this provider.

## Shared files and revoking links

Sent the wrong file, or to the wrong people? Open the provider's settings (Settings > Composition > Attachments, select "Expiring Links") and click **Shared files…**. The page lists the links this add-on has created on your server, newest first, with their expiry date and whether they have a password. **Revoke link** stops anyone from downloading the file through that link and keeps the file on your server. **Delete file** removes the file and its link; with Nextcloud's trash bin (on by default) the file goes to Deleted files, where it can still be restored for a while. Its upload folder is removed too, but only if nothing else is in it. Copies already downloaded cannot be recalled either way.

The list comes straight from your server, so it also reflects links you changed or removed in Nextcloud. Links you shared by hand in Nextcloud are not shown.

## Security notes

- The server must be reachable over HTTPS with a valid certificate (plain HTTP only for `localhost`).
- Only a Nextcloud app password is stored, in the Thunderbird profile (`browser.storage.local`), unencrypted. Thunderbird gives add-ons no encrypted storage. Disconnecting or removing the account revokes the app password on the server.
- When a link gets a generated password, a window shows it and asks how to deliver it: a separate email to the same recipients (opened as a draft for you to send; the default), in the same email below the link, or by yourself. A separate email or another channel (text message, chat) keeps the password away from anyone who only sees the first email.
- A link's password is kept in the add-on's storage (unencrypted, like the app password) until the message is sent, so a draft saved and reopened later still gets its password delivered. It is deleted once the message is sent, or after 90 days for messages never sent. For separate password emails, the passwords and recipients are retained in a pending job until the password draft opens successfully. Once that job is saved, the original upload records and their link addresses are removed. Failed jobs are discarded on startup or retry once they are 90 days old, and when a contributing Filelink account is removed. If opening fails, click the notification to retry; Thunderbird also retries on its next start. The password email uses the same sending identity as the original email. If that identity has since been deleted, it uses your default identity and notifies you to check the From line before sending. Older queued jobs that did not record an identity also use the default. It is never sent automatically.
- The password is copied to the clipboard only when you choose to send it yourself or click Copy, since the clipboard keeps it (and on a Mac, Universal Clipboard shares it with your other devices). When sending a reopened draft with self-delivery, recovered passwords are copied together with any new password. If they differ, the clipboard contains a list labeled by file name; send each recipient the passwords they need.
- Requests that carry the app password never follow redirects, and share links are only put into an email if they use https.
- The `accountsRead` permission lets the add-on preserve the sending identity for separate password emails. Thunderbird may ask you to approve access to account details when updating.
- The `compose` permission is used only to add the password to messages that contain this add-on's password-protected links.

## Troubleshooting

### Uploads fail with HTTP 499 (Nextcloud AIO with ClamAV)

HTTP 499 is not sent by Nextcloud itself. It means a reverse proxy gave up on the request: either your own (for example Caddy in front of AIO) or AIO's internal Caddy inside the `nextcloud-aio-apache` container.

If ClamAV is enabled in AIO, Nextcloud's antivirus app (`files_antivirus`) scans each upload while it is being received. ClamAV unpacks compressed files to scan their contents, so a file that expands to something very large can take too long and the request is dropped. In testing:

- a 16 MB zip that unpacks to about 16 GB failed with 499, while 16 MB of random data uploaded fine;
- a 90 MB `.dmg` (also compressed) failed with 499;
- both worked after ClamAV was turned off.

Ordinary attachments are not affected. To fix it, either:

- **Turn ClamAV off:** in the AIO interface click *Stop containers*, untick *ClamAV* under *Optional containers*, *Save changes*, then *Start containers*. AIO then also removes the `files_antivirus` app (with the default `REMOVE_DISABLED_APPS=yes`). Note that AIO configures ClamAV with `av_infected_action = only_log`: infected files are only logged, not blocked or deleted, so turning it off gives up less than you might expect.
- **Or skip scanning the upload folder (untested):** `files_antivirus` skips any file with a folder of exactly that name in its path. AIO's `CLAMAV_BLOCKLISTED_DIRECTORIES` variable is not passed through by the mastercontainer, so set it directly:

  ```bash
  docker exec --user www-data nextcloud-aio-nextcloud php occ config:app:set files_antivirus \
    av_blocklisted_directories --type=array --value='["Thunderbird attachments"]'
  ```

  This applies to every user's folder of that name, and to the folder set in the add-on's settings only if you keep the default name.

### Every request returns 499 until Caddy is restarted

After a failed upload, the outer Caddy (in front of AIO) kept answering every request, even `status.php`, with an instant 499, while AIO itself answered normally. Restarting Caddy fixed it. To see which layer is failing, run these on the server:

```bash
# Through your Caddy
curl -sS -m 20 -o /dev/null -w '%{http_code}\n' https://cloud.example.com/status.php
# Straight to AIO's internal Caddy (APACHE_PORT, 11000 by default)
curl -sS -m 20 -o /dev/null -w '%{http_code}\n' -H 'Host: cloud.example.com' http://127.0.0.1:11000/status.php
# Straight to Apache inside the AIO container
docker exec nextcloud-aio-apache sh -c 'printf "GET /status.php HTTP/1.0\r\nHost: cloud.example.com\r\n\r\n" | nc -w 10 127.0.0.1 8000 | head -1'
```

If only the first fails, restart your Caddy (`sudo systemctl restart caddy`, or restart its container). A possible safeguard, not yet confirmed to help, is to stop Caddy reusing connections to AIO:

```
cloud.example.com {
	reverse_proxy 127.0.0.1:11000 {
		transport http {
			keepalive off
		}
	}
}
```

Caddy logs nothing for these 499s by default; add a `log` block to the site to get an access log of each request with its status and duration.

### The provider shows a yellow warning triangle after restarting Thunderbird

Fixed in 0.1.3. Thunderbird does not remember whether an add-on's Filelink account is set up, and older versions did not restore it on startup. Update the add-on; removing and re-adding the provider is no longer needed (and each time created a new app password, which you can delete under *Settings > Security > Devices & sessions* in Nextcloud).

## Known limitations

- **Plain-text inline forwards cannot be reliably distinguished from drafts.** HTML forwarded blocks and quoted replies are excluded from password recovery. Plain-text forwards have only a localized header, so forwarding an unsent draft whose passwords are still stored may deliver those passwords to the new recipients. Use HTML forwarding or remove the protected links before forwarding such a draft.

- **Removing an attachment from a reopened draft leaves the file on Nextcloud.** After a restart, Thunderbird reports the removal with a new ID and without the link, so the add-on cannot tell which upload it was. The file still expires as set, and its stored password is cleaned up after 90 days.
- **Mail scanners can use up a one-time link.** Security gateways and link previews fetch links in incoming mail, and that counts as the one download. Combine one-time downloads with a password, which stops a scanner from downloading the file.
- **Uninstalling does not revoke the app password.** Add-ons are not told when they are removed. Click *Disconnect* in the provider's settings before uninstalling, or delete the app password afterwards under *Settings > Security > Devices & sessions* in Nextcloud.
- **Expiry is by date only.** Nextcloud's share API accepts a date, not a time; a link works until the end of that day in the time zone set in your Nextcloud account.

## Status

Requires Thunderbird 128 or newer. Tested on Nextcloud 35 (AIO, behind a Caddy reverse proxy) with Thunderbird 158. One-time downloads need Nextcloud's Download Limit app; without it the option is disabled. Not yet listed on addons.thunderbird.net: localisation is missing. See `CLAUDE.md` for open items.

## License

Copyright (C) 2026 Andy Pastuszak

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

This project is not affiliated with or endorsed by Nextcloud GmbH. Nextcloud is a trademark of Nextcloud GmbH; it is used here only to say which server software the add-on works with.
