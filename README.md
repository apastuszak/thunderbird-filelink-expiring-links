# Nextcloud Expiring Links

Thunderbird Filelink provider for Nextcloud with expiring links, optional generated passwords and an optional one-time download limit.

## Try it

1. Thunderbird 128 or newer: Tools > Developer Tools > Debug Add-ons > Load Temporary Add-on, and pick `manifest.json`.
2. Settings > Composition > Attachments > Add Filelink Provider > "Nextcloud (expiring links)".
3. Enter your Nextcloud URL and click Connect; finish the login in your browser.
4. Attach a file in the composer and choose to link it with this provider.

## Status

Early scaffold. One-time downloads depend on Nextcloud's Download Limit app and the endpoint used is not yet verified. See `CLAUDE.md` for the full list of open items.
