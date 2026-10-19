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
- Generated link passwords are copied to the clipboard, and a window asks how to deliver them: a separate email to the same recipients (opened as a draft for you to send), in the same email below the link, or by yourself. A separate email or another channel (text message, chat) keeps the password away from anyone who only sees the first email.
- The `compose` permission is used only to add the password to messages that contain this add-on's password-protected links.

## Status

Early scaffold. One-time downloads depend on Nextcloud's Download Limit app and the endpoint used is not yet verified. See `CLAUDE.md` for the full list of open items.
