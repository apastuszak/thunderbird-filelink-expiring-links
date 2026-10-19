# Nextcloud Expiring Links

Thunderbird Filelink provider for Nextcloud with expiring links, optional generated passwords and an optional one-time download limit.

## Try it

1. Thunderbird 128 or newer: Tools > Developer Tools > Debug Add-ons > Load Temporary Add-on, and pick `manifest.json`.
2. Settings > Composition > Attachments > Add Filelink Provider > "Nextcloud (expiring links)".
3. Enter your Nextcloud URL and click Connect; finish the login in your browser.
4. Attach a file in the composer and choose to link it with this provider.

## Security notes

- The server must be reachable over HTTPS with a valid certificate (plain HTTP only for `localhost`).
- Only a Nextcloud app password is stored, in the Thunderbird profile (`browser.storage.local`), unencrypted. Thunderbird gives add-ons no encrypted storage. Disconnecting or removing the account revokes the app password on the server.
- When a link gets a generated password, a window shows it and asks how to deliver it: a separate email to the same recipients (opened as a draft for you to send; the default), in the same email below the link, or by yourself. A separate email or another channel (text message, chat) keeps the password away from anyone who only sees the first email.
- The password is copied to the clipboard only when you choose to send it yourself or click Copy, since the clipboard keeps it (and on a Mac, Universal Clipboard shares it with your other devices).
- Requests that carry the app password never follow redirects, and share links are only put into an email if they use https.
- The `compose` permission is used only to add the password to messages that contain this add-on's password-protected links.

## Status

Requires Thunderbird 128 or newer. Tested with Thunderbird 158 and Nextcloud AIO behind a Caddy reverse proxy. One-time downloads need Nextcloud's Download Limit app; without it the option is disabled. Not yet listed on addons.thunderbird.net: localisation is missing, and the Nextcloud logo used as the icon is a Nextcloud GmbH trademark. See `CLAUDE.md` for open items.
