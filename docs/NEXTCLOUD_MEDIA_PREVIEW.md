# Nextcloud media-link previews (+ pluggable cloud backup)

Implementation reference for KaChat (Desktop, iPhone, Android). This spec is meant to be handed to another engineer or AI to implement.

## Goal

1. **Nextcloud media-link previews (build first).** When a user pastes a Nextcloud public share link into a 1:1 chat, and the shared file is a photo or video, preview/play it in high quality **on tap**. On-tap is a privacy choice: the recipient's device only contacts the sender's Nextcloud server when the recipient chooses to view.
2. **Cloud backup (follow-up).** Back up KaChat data to a cloud, with the desktop offering multiple providers behind one interface.

## Key technical facts that set the scope

- A Nextcloud public share `https://host/s/TOKEN` serves the raw file at `https://host/s/TOKEN/download`. Nextcloud supports HTTP range requests on that URL, so images load directly and videos stream (seek and progressive load). A poster thumbnail is available at `https://host/s/TOKEN/preview`.
- **Nextcloud is the only clean way to preview shared media.** Google Drive links only preview via an unofficial thumbnail endpoint that Google frequently changes or blocks. iCloud share links are web-app pages with no auth-free direct-media URL, so they cannot be previewed inline at all. Preview therefore targets **Nextcloud only**. Existing direct-image link previews stay as they are.
- **The share link does not carry the file type.** The client must decide image vs video at view time (see "Type detection").
- Backup providers differ by platform: iCloud is already built on iOS (CloudKit, Apple only), Google Drive is already built on Android and is CORS-friendly for the desktop web, Nextcloud WebDAV is clean on native mobile but CORS-limited in a desktop browser, and iCloud cannot be driven from a desktop browser.

## Feature 1: Nextcloud media preview (photos + video), on-tap

### Shared building blocks

- **Detector** `nextcloudShareDownloadUrl(url)`: when the URL path is `/s/<token>` or `/index.php/s/<token>` (token is roughly 10+ url-safe chars), return `{ downloadUrl: <origin><prefix>/s/<token>/download, previewUrl: <origin><prefix>/s/<token>/preview }`, else null. A generic host match is acceptable because the on-tap flow falls back gracefully; it can be tightened later with a configured Nextcloud host.
- **Type detection** (the link gives no MIME type):
  - **Desktop / browser:** cross-origin response headers are not readable (Nextcloud does not send CORS headers on `/download`), so use a progressive probe on tap. Attempt to load the media, using a `<video>` element as the probe: `loadedmetadata` with a finite duration means video, an `error` means retry as `<img>`, and if both fail, show a "download from Nextcloud" link. Loading media through an element `src` needs no CORS.
  - **Mobile / native:** issue a `HEAD` on `/download` (native HTTP has no CORS) to read `Content-Type` and branch to image vs video directly.

### Desktop (this repo, `KaChat-Desktop`)

Preview logic is centralized in `ui/app.js`, and both message renderers already route through it, so no call-site changes are needed. The relevant call sites are around `ui/app.js:5234` and `ui/app.js:6374`.

1. Add `nextcloudShareDownloadUrl(url)` next to the link helpers near `ui/app.js:799`.
2. Extend `isPreviewableUrl(url)` (near `ui/app.js:813`) to also return true when `nextcloudShareDownloadUrl(url)` is set.
3. Add a Nextcloud branch to `buildLinkPreviewCard(url)` (near `ui/app.js:819`), before the direct-image branch. Emit a gated "Tap to view" card, reusing the existing manual-photo reveal pattern near `ui/app.js:6341` (class `message-photo-hidden`). Optionally show `previewUrl` as a poster `<img>`. On tap, run the progressive probe:
   - **Image:** `<img class="message-link-image" src={downloadUrl}>`, click opens `openPhotoPreview(downloadUrl)` (near `ui/app.js:753`) for full-screen high quality.
   - **Video:** `<video class="message-link-video" controls preload="metadata" src={downloadUrl}>`, directly analogous to the existing `<audio>` render near `ui/app.js:6356`. Streams via range requests. Codecs the browser cannot decode (mkv, some HEVC) fall back to a download link.
   - **Neither:** an "open in Nextcloud" link.
   Nothing loads before the tap. There is no Content-Security-Policy in `index.html`, and cross-origin media already loads, so external Nextcloud media works.
4. CSS: reuse `.message-photo-hidden` and `.message-link-image` in `ui/styles.css`; add `.message-link-video` with a constrained max size. Bump the `?v=` on `app.js` and `styles.css` in `index.html`.

Linkification (`renderTextWithLinks`, near `ui/app.js:771`) is unchanged; the card is additive.

### iPhone (`/home/shudan/KaChat`)

Add a per-path case in `LinkPreviewService.fetchPreview` (`KaChat/Services/LinkPreviewService.swift`, mirroring the `youTubeHosts` / `metaScrapeHosts` branches). Recognize `/s/TOKEN`, `HEAD` the `/download` URL for the MIME, and use `/preview` for the poster. Image previews reuse `LinkPreviewImage` in `LinkPreviewCardView.swift`; attach points in `MessageBubbleView.swift` are unchanged. For on-tap full quality:
- Photo: add a remote-image enlarge path. Chat currently enlarges only local `MediaFile` bytes (`MessageBubbleView.swift` `openPreview()` into `ImagePreviewView`), so route the tapped photo through `LinkPreviewService.imageData(_:referer:)` (raise its 5 MB cap) into `ImagePreviewView`.
- Video: a new inline `AVPlayer` / `VideoPlayer` view fed the `/download` URL (streams natively, handles HEVC and `.mov`).

### Android (`/home/shudan/StudioProjects/KaChatForAndroid`)

Same pattern against `services/LinkPreviewService.kt`, `ui/screens/LinkPreviewCard.kt`, and `util/TextLinkify.kt`. Video via ExoPlayer or `MediaPlayer` on the `/download` URL. Needs a short Android-specific exploration before implementing.

## Feature 2: Cloud backup (follow-up), pluggable storage backends

The archive payload is identical across providers, so model backup as a storage-backend interface (put-file / get-file) and let the user pick per platform.

- **Google Drive:** already on Android (`GoogleDriveBackupService.kt`). Add to Desktop (Google Identity Services OAuth plus Drive REST, CORS-friendly, the smoothest desktop option) and iOS.
- **Nextcloud (WebDAV):** iOS and Android native. `PUT https://host/remote.php/dav/files/USER/<path>/kachat-backup.json` with `Authorization: Basic base64(user:app-password)`. On iOS, reuse the PUT shape in `PushNotificationManager.swift`, store the app-password in `KeychainService` (add a key), use `ChatService.exportChatHistoryArchive()` as the body, and restore with `importChatHistoryArchive(_:)`. Caveats: self-signed-cert trust (needs a `URLSessionDelegate` challenge handler) and optional background upload. On Desktop, browser WebDAV is CORS-blocked on stock Nextcloud, so offer it but document that the user must enable CORS on their Nextcloud or reverse proxy; otherwise fall back to a local-file export the user uploads manually (`downloadBlob` near `ui/app.js:1807`).
- **iCloud:** iOS only, already built (CloudKit / `NSPersistentCloudKitContainer`). Leave untouched. Not available on Desktop or Android; the desktop backup UI should show it as iOS only rather than a working option.
- **Local file export:** everywhere, via `downloadBlob`.

Desktop backup UI lives in the Storage / Chat History groups in `index.html` (replace the "iCloud storage / Coming Soon" placeholder with a provider picker) and wires the currently-stub `data-shell-action` export/import buttons (generic dispatcher near `ui/app.js:9392`). Provider URLs and prefs go in `engine/endpoints.js` (`ENDPOINT_DEFAULTS`) or localStorage; secrets (Nextcloud app-password, OAuth tokens) are kept out of plain config.

## Verification

- **Desktop preview:** hard-refresh, then in a 1:1 chat paste: (a) a Nextcloud photo share, which should show a "Tap to view" card, then the full-quality image on tap, then full-screen on click; (b) a Nextcloud video share, which should stream an inline `<video>` player with controls on tap; (c) a Nextcloud non-media share, which should fall back to an "open in Nextcloud" link; (d) a normal URL and a direct `.jpg`, which should behave as before. The Network panel should show no request before the tap, and video seeking should issue range requests.
- **iOS / Android preview:** the same cases; photo enlarges full-res, video plays inline.
- **Backup (when built):** connect a provider, back up, confirm the archive lands in that cloud, wipe local history, and restore. On desktop, confirm Google Drive OAuth works and that Nextcloud surfaces the CORS requirement clearly.

## Sequencing

1. Desktop Nextcloud photo and video preview (this repo), self-contained.
2. iOS Nextcloud preview (photo enlarge path plus inline video player).
3. Android Nextcloud preview (after a short Android exploration).
4. Backup backends: Google Drive on Desktop, then Nextcloud on iOS and Android; leave iCloud as-is (iOS only); document the desktop Nextcloud CORS requirement.
