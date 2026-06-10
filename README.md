# Kick on Twitch

A userscript that replaces the Twitch video player with a live Kick stream, keeping Twitch chat, emotes, and the rest of the UI fully intact. Ideal for multistream setups where a streamer is live on both platforms at once.

## Features

- Watch the Kick feed while staying in Twitch chat with everyone else
- Automatically tries to match the Twitch channel name to the same username on Kick
- Set a custom Kick username per channel when names differ, saved permanently
- Falls back silently to Twitch if the Kick stream is offline
- Detects when a Kick stream ends and switches back to Twitch automatically
- Re-initialises correctly after expanding Twitch's mini player
- Persists your volume and mute state across sessions
- Rechecks Kick live status when you switch back to a tab, in case the stream came online while you were away
- Control bar with play/pause, mute, volume slider, go-to-live-edge, and fullscreen
- Keyboard shortcuts: `Space` play/pause, `M` mute, `F` fullscreen, `L` jump to live edge
- "Use Twitch" session toggle to switch back temporarily without removing your mapping
- Theatre mode and fullscreen layout handled correctly
- Handles Twitch ad injection without breaking the overlay

## Requirements

- [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
- Greasemonkey 4 is **not** supported — it lacks `GM_xmlhttpRequest` and `GM_getResourceURL`, both of which this script requires

## Installation

1. Install Tampermonkey or Violentmonkey for your browser
2. Open `kick-on-twitch.user.js` in this repository and click the **Raw** button at the top right of the file
3. Your userscript manager will prompt you to install it, click **Install**

Your manager will notify you automatically when a new version is published.

## Usage

Navigate to any channel on Twitch. The script checks Kick automatically:

- If the streamer is live on Kick under the same username, the Kick stream loads immediately
- If the Kick username differs from Twitch, hover over the player and click the **✎** button to set it
- A badge in the top-left of the player shows **KICK** (green) or **TWITCH** (grey) so you always know which stream is playing
- Click **Use Twitch** to switch back for the current session without removing your saved mapping

### Setting a custom username

1. Go to the Twitch channel
2. Hover over the player so the badge and controls appear
3. Click **✎** and type the Kick username
4. Click **Save** and the stream reloads immediately with the new mapping

To remove a mapping and go back to auto-matching, open the same form and click **Auto**.

## How it works

The script calls the Kick public API to check whether the channel is live and retrieve the HLS stream URL. It then mounts a `<video>` overlay on top of the Twitch player and feeds the HLS stream through [hls.js](https://github.com/video-dev/hls.js), loaded from a CDN with an SRI integrity hash. The Twitch video element is hidden but kept in the DOM so Twitch's React app does not break.

All network requests to Kick's CDN go through `GM_xmlhttpRequest`, which is required to satisfy Kick's CORS policy. Every request URL is validated against an allowlist of known Kick and AWS IVS hostnames before being fetched.

**A note on the `@connect *` permission:** when your userscript manager installs this script, it requests permission to contact external hosts. You will see `@connect *` (a wildcard) listed alongside the explicit `kick.com` and `cdn.kick.com` entries. The wildcard is necessary because Kick's HLS video segments are served from AWS IVS subdomains whose exact hostnames change per-stream (for example `fa723fc1b171.euw13.playlist.live-video.net`). These subdomains are too deeply nested for a wildcard entry like `*.live-video.net` to match reliably across all userscript managers. The wildcard does **not** mean the script will contact arbitrary domains — every URL is checked against the same `kick.com` / `cdn.kick.com` / `live-video.net` allowlist before any request is made.

Channel mappings and volume state are persisted locally in your browser via your userscript manager.

## Troubleshooting

**Stream not loading or stuck on Twitch**
Check the Kick username is correct using the ✎ button. If names match and it still does not load, open the browser console and look for `[KickSwap]` warnings. If you see repeated warnings about the API response shape, check `https://kick.com/api/v1/channels/<username>` directly to see if the structure has changed.

**Stream switches back to Twitch unexpectedly**
The stream token may have expired mid-session. The script retries once automatically. If it keeps happening, open the browser console and look for `[KickSwap]` error messages.

**Controls not appearing**
Hover over the video player. Controls fade in on hover and hide when the cursor leaves. They also briefly appear automatically when the Kick stream first activates.

**Volume resets on every load**
Volume and mute state are saved via your userscript manager's storage. If they are not persisting, check that your manager has storage access enabled for this script (Tampermonkey: Dashboard → script → Settings → Storage).

**Permission prompt for network access**
If your userscript manager asks for permission to contact external hosts, this is expected. See the note about `@connect *` in the "How it works" section above.

## License

MIT
