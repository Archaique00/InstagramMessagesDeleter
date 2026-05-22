# Instagram Direct Deleter

A Tampermonkey userscript for Instagram Direct. It adds an in-page control panel that can scan a conversation, filter your own messages, export the conversation as a ZIP archive, and unsend selected messages.

Main file: `tampermonkey-instagram-deleter.user.js`.

## What It Does

- Adds an `IG Direct` button on `instagram.com`.
- Detects the currently open Direct conversation from `/direct/t/...`.
- Loads conversation messages through Instagram GraphQL requests.
- Filters messages by ownership, message ID, content type, date range, text, or media.
- Targets only messages sent by the logged-in account by default, using `ds_user_id`.
- Unsends selected messages through Instagram's own unsend mutation.
- Exports the loaded conversation as a ZIP archive with an HTML transcript, media source links, and optional embedded media files.

Instagram only allows you to unsend messages sent by your own account. Messages from other accounts cannot be deleted by this userscript.

## Installation

1. Install Tampermonkey in your browser.
2. Create a new Tampermonkey script.
3. Paste the contents of `tampermonkey-instagram-deleter.user.js`.
4. Save the script.
5. Open `https://www.instagram.com/direct/`.
6. Open the conversation you want to process.
7. Click `IG Direct`.

## Credentials

The userscript runs inside your already-authenticated Instagram browser session. Some request values are still required to replay Instagram GraphQL calls reliably:

```env
INSTAGRAM_CSRFTOKEN=...
INSTAGRAM_COOKIE=...
INSTAGRAM_FB_DTSG=...
```

Open the `Credentials` tab, paste this block, then click `Import .env`. You can also click `Auto-fill` to reuse values detected from the page or from a captured GraphQL request.

### How To Get `fb_dtsg`

1. Open Instagram while logged in.
2. Open your browser developer tools.
3. Go to the `Network` tab.
4. Filter requests with `graphql`.
5. In Instagram Direct, open a conversation or perform an action that triggers a `/api/graphql/` request.
6. Select the GraphQL `POST` request.
7. In `Request` / `Payload` / `Form Data`, copy the `fb_dtsg` value.

`csrftoken` and `ds_user_id` can be found in Instagram cookies. `INSTAGRAM_COOKIE` can contain the full cookie header for the active session.

## Usage

1. Open the target Instagram Direct conversation.
2. Click `Detect conversation` if the conversation URL was not detected automatically.
3. Open `Credentials`.
4. Import or auto-fill the required credentials.
5. Return to `Scan`.
6. Adjust filters if needed.
7. Click `Scan`.
8. Review the target preview.
9. Click `Export ZIP` for a fast archive with source links, `Export ZIP + media` for an archive that embeds downloaded media, or `Delete targets` / `Scan + delete` to unsend messages.
10. For deletion, confirm by typing `DELETE`.

Deletion is permanent in the Instagram interface. Always run `Scan` and check the target preview before deleting messages.

## ZIP Export

After a scan, click `Export ZIP` to download a fast archive of the loaded conversation. The archive contains:

- `index.html`: readable standalone conversation page with messages, source links, and media status;
- `conversation.txt`: chronological text transcript;
- `conversation.json`: raw message data returned by Instagram;
- `manifest.json`: export metadata and media download status;
- `assets/`: only present when using `Export ZIP + media`.

`Export ZIP` is the recommended default: it does not embed media files, so it should finish quickly and keeps media as source links. `Export ZIP + media` is best-effort: it downloads media concurrently, uses an 8-second timeout for stalled URLs, caps downloaded media to 150 files, skips individual media above 20 MB, caps included media to 80 MB per ZIP, and packages the ZIP without recompressing media. Skipped or failed media remain listed as source links in `index.html` and `manifest.json`.

If the scan was stopped before reaching the end of the conversation, the export marks the scan as incomplete.

## Notes

- Cookies, `csrftoken`, and `fb_dtsg` grant access to your Instagram session. Do not publish them.
- The ZIP export uses JSZip through `@require` and `GM_xmlhttpRequest` to fetch media from Instagram/CDN URLs.
- Instagram GraphQL `doc_id` values may change. If requests fail, open Instagram Direct and let the userscript capture a fresh GraphQL request.
- The userscript only works in the browser session that is logged into the Instagram account you want to process.
