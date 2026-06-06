# Kick on Twitch

A userscript that replaces the Twitch video player with a live Kick stream, keeping Twitch chat, emotes, and the rest of the UI fully intact.

## Features

- Watches Kick streams inside the Twitch UI — chat, emotes, channel points, everything stays
- Automatically tries to match the Twitch channel name to the same username on Kick
- Lets you set a custom Kick username per channel when names differ
- Falls back silently to Twitch if the Kick stream is offline
- Detects when a Kick stream ends and switches back automatically
- Persists your volume and mute state across sessions
- Control bar with play/pause, mute, volume slider, go-to-live-edge, and fullscreen
- Keyboard shortcuts: `Space` play/pause, `M` mute, `F` fullscreen, `L` jump to live edge
- "Use Twitch" session toggle — temporarily switches back without removing your mapping
- Theatre mode and fullscreen layout are handled correctly
- Handles Twitch ad injection without breaking the overlay

## Requirements

- [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
- Greasemonkey 4 is **not** supported

## Installation

1. Install Tampermonkey or Violentmonkey for your browser
2. Click the raw link for `kick-on-twitch.user.js` in this repository
3. Your userscript manager will prompt you to install it — click **Install**

To update, the same process applies, or your manager will notify you automatically when a new version is published.

## Usage

Navigate to any channel on Twitch. The script checks Kick automatically:

- If the streamer is live on Kick under the same username, the Kick stream loads immediately
- If the Kick username differs from Twitch, hover over the player and click the **✎** button to set it
- A badge in the top-left of the player shows **KICK** (green) or **TWITCH** (grey) so you always know which stream is playing
- Click **Use Twitch** to switch back for the current session without removing your saved mapping

### Setting a custom username

1. Go to the Twitch channel
2. Hover over the player — the badge and controls appear
3. Click **✎** and type the Kick username
4. Click **Save** — the stream reloads immediately with the new mapping

To remove a mapping and go back to auto-matching, open the same form and click **Auto**.

## How it works

The script calls the Kick public API to check whether the channel is live and retrieve the HLS stream URL. It then mounts a `<video>` overlay on top of the Twitch player and feeds the HLS stream through [hls.js](https://github.com/video-dev/hls.js), loaded from a CDN with an SRI integrity hash. The Twitch video element is hidden but kept in the DOM so Twitch's React app does not break.

All network requests to Kick's CDN go through `GM_xmlhttpRequest`, which is required to satisfy Kick's CORS policy. Every request URL is validated against an allowlist of known Kick and AWS IVS hostnames before being fetched — no requests are ever made to arbitrary hosts.

Channel mappings and volume state are persisted in userscript storage via `GM_setValue` / `GM_getValue`.

## Updating hls.js

The bundled hls.js version is pinned with an SRI hash. To update it:

1. Pick a release from [hls.js releases](https://github.com/video-dev/hls.js/releases)
2. Download `hls.min.js` from the release assets
3. Regenerate the hash: `openssl dgst -sha256 -binary hls.min.js | openssl base64 -A`
4. Update both the version in the `@resource` URL and the hash after the `#` in the script header — they must match
5. Bump `@version` so userscript managers prompt users to update

## Troubleshooting

**Stream not loading / stuck on Twitch**
Kick's API shape may have changed. Open the browser console and look for `[KickSwap]` log lines. If you see repeated warnings about the API response shape, check `https://kick.com/api/v1/channels/<username>` directly to see if the response structure has changed.

**Stream loads but then switches back to Twitch**
The Kick stream token expired mid-session. The script retries once automatically. If it keeps happening, Kick may have changed how their CDN validates the `Origin` header — see the note at the top of the script source.

**Controls not appearing**
Hover over the video player. Controls fade in on hover and auto-hide when the cursor leaves.

## License

MIT
