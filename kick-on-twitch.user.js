// ==UserScript==
// @name         Kick on Twitch
// @namespace    https://github.com/Kinshara/kick-on-twitch
// @version      3.9.6
// @description  Watch Kick streams inside Twitch - chat, emotes and UI stay intact. Auto-matches channels, persists your settings, and switches back automatically when a stream ends. Requires Tampermonkey or Violentmonkey.
// @author       Kinshara
// @license      MIT
// @homepageURL  https://github.com/Kinshara/kick-on-twitch
// @supportURL   https://github.com/Kinshara/kick-on-twitch/issues
// @updateURL    https://github.com/Kinshara/kick-on-twitch/releases/latest/download/kick-on-twitch.user.js
// @downloadURL  https://github.com/Kinshara/kick-on-twitch/releases/latest/download/kick-on-twitch.user.js
// @match        https://www.twitch.tv/*
// @icon         data:image/svg+xml,%3Csvg width='64' height='64' viewBox='0 0 64 64' xmlns='http://www.w3.org/2000/svg'%3E%3Crect x='6' y='7' width='52' height='37' rx='4' fill='%23220a3a' stroke='%239146FF' stroke-width='4'/%3E%3Crect x='28' y='44' width='8' height='5' fill='%239146FF'/%3E%3Crect x='18' y='48' width='28' height='3' rx='1.5' fill='%239146FF'/%3E%3Cpolygon points='24%2C16 24%2C36 43%2C26' fill='%2353FC18'/%3E%3C%2Fsvg%3E
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_getResourceURL
// @connect      kick.com
// @connect      cdn.kick.com
// @connect      live-video.net
// @connect      *.live-video.net
// @resource     hlsjs  https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js#sha256-p4s2A9diQoyrou8hZ05NR/vE50likrKPhFunNyhJNgs=
// @run-at       document-idle
// ==/UserScript==

// SECURITY NOTE (finding F1) — @connect * removed:
// The original @connect * has been replaced with the explicit entries above.
// Tampermonkey on Chrome only matches one subdomain level deep for wildcard
// @connect entries (e.g. @connect *.live-video.net matches foo.live-video.net
// but NOT foo.bar.live-video.net). AWS IVS uses deeply nested subdomains whose
// exact hostnames change per-stream, so some users on Tampermonkey/Chrome may
// see a cross-origin permission popup the first time a new deep subdomain is
// encountered. This is the correct trade-off: an explicit grant with a
// browser-native permission prompt is safer than a silent @connect * that grants
// unrestricted cross-origin access to the entire GM sandbox.
// If you observe repeated permission prompts, the most pragmatic solution is to
// switch to Violentmonkey on Firefox, which returns a moz-extension: URL from
// GM_getResourceURL that Twitch's CSP allows as a <script src>, eliminating the
// need for inline injection and simplifying the permission model.
// The meaningful security enforcement layer remains GmLoader's KICK_CDN_HOSTS
// allowlist, which validates every request URL before it is fetched.
//
// SECURITY NOTE (finding F5) — @updateURL / @downloadURL:
// Updates are now pinned to GitHub Releases (via @updateURL / @downloadURL above)
// rather than the mutable main-branch Raw URL. This means only deliberately tagged
// releases are auto-deployed to installed users. To publish an update:
//   1. Bump @version in the script header.
//   2. Create a GitHub Release tagged with that version.
//   3. Attach the script file as kick-on-twitch.user.js in the release assets.
// Users on older installs pointing at the Raw main URL will not receive automatic
// updates from the new release URL — they will need to reinstall once.

// NOTE — hls.js is loaded via @resource with an SRI integrity hash, verified
// by the userscript manager before execution. If the hash check fails the
// resource will not load. To update hls.js:
//   1. Pick a release from https://github.com/video-dev/hls.js/releases
//   2. Download hls.min.js from the release assets
//   3. Regenerate the hash: openssl dgst -sha256 -binary hls.min.js | openssl base64 -A
//   4. Update BOTH the version in the @resource URL AND the hash after the '#' — they must match.
//   5. Bump @version so userscript managers prompt users to update.
//
// ── Security trust model ─────────────────────────────────────────────────────
// This script requires two intentional security trade-offs. Both are documented
// here so that maintainers and security-conscious users can make informed decisions.
//
// TRADE-OFF A — Inline script injection (security finding F2 / F10):
//   hls.js is injected as an inline <script> (via s.textContent) rather than via
//   a <script src="blob:…"> because Twitch's Content Security Policy blocks blob:
//   src attributes on Chrome/Tampermonkey. The inline injection bypasses that CSP
//   restriction. As a consequence, the injected hls.js code executes inside Twitch's
//   JavaScript realm (window.Hls is visible to Twitch's own code, and hls.js can
//   access Twitch's localStorage, cookies, and page globals).
//
//   TRUST ANCHOR: The @resource SRI hash is the sole integrity control. The
//   userscript manager verifies the downloaded hls.js against the hash before
//   storing it. By the time the blob URL is fetched here, the content has already
//   been verified. If your manager does not enforce SRI on @resource entries,
//   or if it is outdated, this trust guarantee is weakened. Keep your userscript
//   manager updated. Verified to work on Tampermonkey ≥ 4.19 and Violentmonkey ≥ 2.13.
//
// TRADE-OFF B — CORS/Origin spoofing (security finding F3):
//   GmLoader injects `Origin: https://kick.com` on every HLS request to satisfy
//   Kick's CDN CORS policy. This makes Kick's CDN believe requests originate from
//   the Kick website. The browser's normal same-origin CORS protection is therefore
//   absent for HLS traffic. GmLoader compensates by validating every request URL
//   against KICK_CDN_HOSTS before issuing the GM request — only allowlisted
//   hostnames are ever fetched, and redirect destinations are re-validated before
//   success is reported (see onload handler).
//
// NOTE — @connect * covers all CDN hostnames Kick uses (deeply-nested AWS IVS
// subdomains change per-stream; a wildcard is the only reliable approach).
// If Kick adds a new CDN provider, add its apex domain to KICK_CDN_HOSTS below.
// GmLoader's per-request host check is the meaningful enforcement layer.

(function () {
  'use strict';

  // ─── Bootstrap: inject hls.js from verified @resource ────────────────────
  // Tampermonkey on Chrome returns a blob: URL from GM_getResourceURL, but
  // Twitch's Content Security Policy blocks <script src="blob:…"> outright,
  // so the script element never loads and main() is never called.
  // Violentmonkey on Firefox returns a moz-extension: URL which Twitch's CSP
  // does allow, so the old src-injection worked there but not on Chrome.
  //
  // The fix: fetch the resource as text and inject it as an *inline* <script>.
  // Inline scripts are evaluated from the page's JS realm (giving hls.js access
  // to window.Hls) and are not subject to src-based CSP restrictions.
  //
  // We use GM_getResourceURL + fetch() as the primary path (works in both
  // managers). If the blob URL itself is somehow blocked (future CSP tightening
  // that restricts fetch() to blob: origins), we fall back to GM_xmlhttpRequest
  // which bypasses CORS/CSP entirely. The SRI hash verification happens inside
  // the userscript manager before the resource is stored; by the time we fetch
  // the blob URL the content is already verified.
  //
  // SECURITY NOTE: This inline injection executes hls.js in Twitch's page realm.
  // The SRI hash on @resource is the integrity guarantee. See the trust model
  // comment block above the IIFE for the full explanation.
  (function loadHls(cb) {
    const blobUrl = GM_getResourceURL('hlsjs');
    if (!blobUrl) {
      console.error('[KickSwap] hls.js resource not available — check @resource and SRI hash.');
      return;
    }

    function injectInline(src) {
      const s = document.createElement('script');
      s.textContent = src;
      document.head.appendChild(s);
      cb();
    }

    // Primary: fetch the blob/extension URL as text, then inline-inject.
    fetch(blobUrl)
      .then(r => {
        if (!r.ok) throw new Error(`fetch status ${r.status}`);
        return r.text();
      })
      .then(src => injectInline(src))
      .catch(fetchErr => {
        // Fallback: use GM_xmlhttpRequest which bypasses all CSP/CORS restrictions.
        // SECURITY NOTE: blob: URLs accessed via GM_xmlhttpRequest return status 0
        // (not 200) because they don't go through HTTP — this is expected and safe.
        // We therefore check for non-empty responseText directly rather than using
        // an HTTP status range check, which would incorrectly reject a successful
        // blob response. A network failure also returns status 0 but with empty
        // responseText, so the `if (resp.responseText)` guard correctly rejects it.
        console.debug('[KickSwap] fetch() of hls.js resource failed, falling back to GM_xmlhttpRequest.', fetchErr);
        GM_xmlhttpRequest({
          method: 'GET',
          url: blobUrl,
          onload(resp) {
            if (resp.responseText) {
              injectInline(resp.responseText);
            } else {
              console.error('[KickSwap] GM_xmlhttpRequest fallback for hls.js also failed — empty response.');
            }
          },
          onerror() { console.error('[KickSwap] Failed to load hls.js via GM_xmlhttpRequest fallback.'); },
        });
      });
  })(main);

  function main() {

  // ─── Constants ────────────────────────────────────────────────────────────
  // KICK_API_VERSION: bump here if Kick ships a v2 endpoint.
  // Check https://kick.com/api/v2/channels/:name for the new shape.
  const KICK_API_VERSION = 'v1';
  const KICK_API_BASE    = `https://kick.com/api/${KICK_API_VERSION}/channels/`;
  const CACHE_TTL_MS     = 5 * 60 * 1000;
  const SESSION_CACHE_MAX = 20;   // max channels to keep in memory cache
  const MAPPINGS_MAX      = 200;  // max entries persisted to GM storage (evicts oldest on overflow)
  const RETRY_DELAY_MS   = 2500;  // pause before re-init after a fatal HLS error
  // Consecutive null-result threshold before emitting an API-shape warning
  const API_WARN_THRESHOLD = 3;
  // How often to poll Kick's API while the stream is active to detect a clean stream-end.
  // The cache TTL matches this interval deliberately: a successful live-check re-caches
  // the result, so the *next* scheduled check will always hit a stale (just-expired) or
  // absent entry and make a fresh API call — meaning we never miss a stream-end because
  // of a long-lived cache hit.
  const LIVE_CHECK_INTERVAL_MS      = 5 * 60 * 1000;  // 5 minutes
  // Minimum gap between visibility-triggered rechecks (prevents API hammering on rapid tab-switching)
  const VISIBILITY_RECHECK_COOLDOWN = 30 * 1000;       // 30 seconds
  // Minimum gap between mini player expand checks (expand is never faster than this)
  const MINI_PLAYER_COOLDOWN        =  2 * 1000;       // 2 seconds

  const HLS_CONFIG = {
    maxBufferLength:         30,
    maxMaxBufferLength:      60,
    enableWorker:            true,
    lowLatencyMode:          false, // must be off — conflicts with manual level locking
    startLevel:              -1,    // let hls.js pick on first load, we lock after
    abrEwmaDefaultEstimate:  8000000, // bias initial ABR toward high quality (8 mbps)
  };

  // Covers all AWS IVS hostnames Kick uses.
  // AWS IVS serves traffic from an open-ended set of *.live-video.net sub-zones
  // (e.g. playback.*, playlist.*, *.hls.*, CloudFront-backed variants, etc.).
  // Enumerating them individually causes breakage whenever AWS adds a new zone,
  // so we allowlist the apex domain live-video.net and permit any subdomain of
  // it — matching the scope already granted by @connect *.live-video.net.
  // cdn.kick.com and kick.com cover the API and any Kick-hosted segments.
  // If Kick adds a new CDN provider, add its apex domain here and to @connect.
  //
  // SECURITY NOTE (finding F4): The apex-domain match permits all subdomains of
  // live-video.net at any depth. This is intentional and necessary because AWS IVS
  // uses dynamically-generated deep subdomains. The risk of a rogue subdomain is
  // mitigated by: (1) AWS controlling the live-video.net zone, and (2) GmLoader
  // re-validating redirect destinations (response.finalUrl) before reporting
  // success, so a 302 redirect to an off-allowlist host is rejected.
  const KICK_CDN_HOSTS = [
    'live-video.net',
    'cdn.kick.com',
    'kick.com',
  ];

  // Accepted Content-Type values for HLS manifest responses (finding F6).
  // Some CDNs serve .m3u8 files as text/plain; all variants are accepted.
  // Segments (.ts/.mp4/.m4s) are not checked — binary types vary widely.
  const HLS_MANIFEST_CONTENT_TYPES = new Set([
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'audio/mpegurl',
    'text/plain',
  ]);

  const USERNAME_RE = /^[a-zA-Z0-9_-]{1,30}$/;

  // ─── State ────────────────────────────────────────────────────────────────
  let hlsInstance       = null;
  let overlayVideo      = null;
  let overlayContainer  = null;
  let playerObserver    = null;
  let resizeObserver    = null;
  let watchdogObserver  = null;   // declared here so destroyKickPlayer can reference it safely
  let theatreObserver   = null;   // watches Twitch's player wrapper class for theatre/fullscreen mode changes
  let cleanupListeners  = [];
  let currentChannel    = null;  // Twitch username currently on screen
  let currentKickUser   = null;  // resolved Kick username for currentChannel
  let knownTwitchVideo  = null;  // reference to the Twitch <video> element we hid, used to detect ad swaps
  let sessionCache      = {};    // keyed by kick username; evicted via LRU order
  let sessionCacheOrder = [];    // insertion-order keys for LRU eviction
  let uiPanel           = null;
  let isKickActive        = false;
  let disabledForSession  = false; // true when user has clicked "Use Twitch" toggle; clears on channel nav
  let apiNullStreak       = 0;     // counts consecutive API non-live / bad-shape results
  let liveCheckTimer      = null;  // setInterval handle for periodic live-status polling
  let lastVisibilityRecheck = 0;   // Date.now() of last visibility-triggered API recheck
  let initInProgress      = false; // true while initKickSwap is awaiting; blocks concurrent calls
  // syncVolUI: assigned from the return value of buildControlBar (via mountOverlay)
  // so startHlsPlayback can call it without duck-punching a property onto the
  // video element. The dependency is explicit at the call site in mountOverlay.
  let syncVolUI           = null;
  // hlsRetryCount is module-level (not closure-local) so it survives the
  // destroyKickPlayer → safeReInit cycle. A local hasRetried flag was reset to
  // false on every new Hls instantiation, creating an infinite retry loop on
  // Chrome/Tampermonkey where manifestLoadError recurs every attempt.
  // Reset to 0 only on successful playback or channel navigation.
  let hlsRetryCount       = 0;

  // ── [P2] Cached player container reference ────────────────────────────────
  // Eliminates the repeated triple-querySelector chain in getTwitchPlayerContainer().
  // Cache is populated lazily on first call, validated with document.contains() on
  // subsequent calls, and explicitly cleared in destroyKickPlayer() and onNavigate()
  // where the element identity may change.
  let _playerContainerCache = null;

  // ── [P6] Cancellable autoShowControls timer ───────────────────────────────
  // Stored at module level so concurrent doPlay() calls (e.g. during retry)
  // cancel the previous pending hide and destroyKickPlayer() can clean it up.
  let _autoShowTimer = null;

  // ── [P10] Cached theatre observer watch target ────────────────────────────
  // The ancestor walk in startTheatreObserver() always resolves to the same
  // element for a given Twitch layout version. Caching it avoids re-walking
  // up to 6 ancestors on every safeReInit() cycle.
  let _theatreWatchTarget = null;

  // ─── In-memory mappings cache (avoids a GM read on every nav) ────────────
  let mappingsCache     = null;  // null = not yet loaded

  // ─── Volume persistence ──────────────────────────────────────────────────
  async function loadVolume() {
    try {
      const raw = await GM_getValue('ksVolume', '{"volume":1,"muted":false}');
      // GM_getValue can return undefined on a cold start in some Tampermonkey
      // builds on Chrome even when a default is supplied. Guard before parsing.
      if (raw === undefined || raw === null) return { volume: 1, muted: false };
      const p   = JSON.parse(String(raw));
      // Guard: p must be a plain object before we access its properties.
      // A corrupt or wrongly-shaped value falls through to the catch defaults.
      if (p === null || typeof p !== 'object' || Array.isArray(p)) {
        throw new Error('ksVolume: unexpected storage shape');
      }
      // Pre-populate slider immediately from persisted state to avoid the
      // brief flash where it shows full volume before the async resolve.
      return {
        volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : 1,
        muted:  typeof p.muted  === 'boolean' ? p.muted : false,
      };
    } catch (e) { console.debug('[KickSwap] loadVolume: corrupt storage value, using defaults', e); return { volume: 1, muted: false }; }
  }

  // loadVolumeCached shares a single promise across all callers so there is
  // only ever one GM storage read per page load. Caching the promise (not just
  // the resolved value) means a second caller that arrives before the first has
  // resolved still gets the same pending promise rather than firing a second
  // GM read — eliminating the race between buildControlBar and startHlsPlayback.
  let volumeCache        = null;  // resolved value, set once GM read completes
  let volumeCachePromise = null;  // the single shared promise
  function loadVolumeCached() {
    if (volumeCache)        return Promise.resolve(volumeCache);
    if (volumeCachePromise) return volumeCachePromise;
    volumeCachePromise = loadVolume().then(v => { volumeCache = v; return v; });
    return volumeCachePromise;
  }

  function saveVolume(volume, muted) {
    volumeCache        = { volume, muted };
    // Resolve to the new value immediately so loadVolumeCached callers that
    // arrive before the next GM read always get the updated state, not a
    // stale re-read triggered by a null promise.
    volumeCachePromise = Promise.resolve(volumeCache);
    GM_setValue('ksVolume', JSON.stringify({ volume, muted }));
  }

  // saveVolumeDebounced is used by the slider's input handler to avoid firing
  // a GM write on every animation frame while the user is dragging. Discrete
  // interactions (mute button, keyboard) call saveVolume directly.
  let _saveVolumeTimer = null;
  function saveVolumeDebounced(volume, muted) {
    clearTimeout(_saveVolumeTimer);
    _saveVolumeTimer = setTimeout(() => saveVolume(volume, muted), 200);
  }

  // ─── Icons ────────────────────────────────────────────────────────────────
  // SVG paths are static, trusted, internal constants — never derived from
  // external data. We still avoid innerHTML and build elements programmatically
  // so that future maintainers cannot accidentally introduce dynamic content
  // into this pattern without noticing the API change.
  const iconPaths = {
    play:           'M8 5v14l11-7z',
    pause:          'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    volumeMute:     'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 15.03 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
    volumeLow:      'M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z',
    volumeHigh:     'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    fullscreen:     'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
    exitFullscreen: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
    syncLive:       'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
  };

  /**
   * Build a standalone SVG icon element from the iconPaths table.
   * Returns an <svg> DOM node — never uses innerHTML.
   */
  function makeIcon(name) {
    const NS  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', iconPaths[name] ?? '');
    svg.appendChild(path);
    return svg;
  }

  /**
   * Replace all child nodes of `el` with a freshly built icon.
   * Drop-in replacement for `el.innerHTML = icons.foo`.
   */
  function setIcon(el, name) {
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(makeIcon(name));
  }

  // ─── Utilities ────────────────────────────────────────────────────────────
  function sanitiseUsername(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    return USERNAME_RE.test(trimmed) ? trimmed : null;
  }

  function validateHlsUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return null;
      if (!parsed.pathname.endsWith('.m3u8')) return null;
      const hostOk = KICK_CDN_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
      return hostOk ? url : null;
    } catch { return null; }
  }

  // ── Redact helper (finding F7) ────────────────────────────────────────────
  // Strips the query string (which may contain signed tokens) from a URL
  // string before it reaches console output. Returns only origin + pathname.
  // Called by all GmLoader log sites so token redaction is centralised here
  // rather than repeated inline at each call site.
  function redactUrl(url) {
    try {
      const p = new URL(url);
      return p.origin + p.pathname;
    } catch {
      // If the input isn't a valid URL (e.g. already a partial string from
      // an error object), truncate at 120 chars to bound log size.
      return String(url).slice(0, 120);
    }
  }

  function parseKickApiResponse(data) {
    try {
      if (!data || typeof data !== 'object') return null;
      const isLive      = data.is_live ?? data.livestream?.is_live;
      if (!isLive) return null;
      const playbackUrl = data.playback_url ?? data.livestream?.playback_url;
      if (typeof playbackUrl !== 'string') return null;
      const safeUrl = validateHlsUrl(playbackUrl);
      return safeUrl ? { hlsUrl: safeUrl } : null;
    } catch { return null; }
  }

  function getTwitchChannel() {
    const match = location.pathname.match(/^\/([a-zA-Z0-9_]{1,25})\/?$/);
    return match ? match[1].toLowerCase() : null;
  }

  // ── [P9] Stream-page guard ────────────────────────────────────────────────
  // Returns true only for /:channelname URLs. Prevents waitForPlayer() from
  // running (and creating a MutationObserver + making a Kick API call) on
  // browse pages, VODs, clips, and other non-stream Twitch URLs.
  // hookNavigation() still runs unconditionally to handle SPA navigations
  // from non-stream pages to stream pages.
  function isLikelyStreamPage() {
    return /^\/[a-zA-Z0-9_]{1,25}\/?$/.test(location.pathname);
  }

  // ── [P2] Cached player container lookup ───────────────────────────────────
  // getTwitchPlayerContainer() used to chain three unconditional querySelector
  // calls on every invocation. On Twitch's live DOM (5,000–15,000+ elements)
  // each attribute-selector scan takes 0.1–0.5 ms; the function is called from
  // at least 8 hot paths including timers and observer callbacks.
  //
  // The cache is validated with document.contains() (O(depth), ~0.01 ms) on
  // every call and explicitly cleared in destroyKickPlayer() and onNavigate()
  // where element identity can change. This keeps the query count at 1 on first
  // call and near-zero on all subsequent calls for the same player session.
  function getTwitchPlayerContainer() {
    if (_playerContainerCache && document.contains(_playerContainerCache)) {
      return _playerContainerCache;
    }
    _playerContainerCache =
      document.querySelector('[data-a-target="video-player"]') ||
      document.querySelector('.video-player') ||
      document.querySelector('.video-player__container');
    return _playerContainerCache;
  }

  // getTwitchVideo re-derives the container each time — fine for callers that
  // don't have it handy. When the container is already known, use
  // getTwitchVideoIn(container) to skip the redundant querySelector chain.
  function getTwitchVideoIn(container) {
    return container ? container.querySelector('video') : null;
  }

  function getTwitchVideo() {
    return getTwitchVideoIn(getTwitchPlayerContainer());
  }

  // ─── Session cache (LRU, max SESSION_CACHE_MAX entries) ──────────────────
  function cacheGet(key) {
    const entry = sessionCache[key];
    if (!entry) return null;
    if ((Date.now() - entry.fetchedAt) >= CACHE_TTL_MS) {
      cacheDelete(key);
      return null;
    }
    return entry;
  }

  function cacheSet(key, value) {
    if (!sessionCache[key]) {
      sessionCacheOrder.push(key);
      // Evict oldest if over limit
      if (sessionCacheOrder.length > SESSION_CACHE_MAX) {
        const evicted = sessionCacheOrder.shift();
        delete sessionCache[evicted];
      }
    }
    sessionCache[key] = value;
  }

  function cacheDelete(key) {
    delete sessionCache[key];
    const idx = sessionCacheOrder.indexOf(key);
    if (idx !== -1) sessionCacheOrder.splice(idx, 1);
  }

  // ─── Persistent Mapping Store ─────────────────────────────────────────────
  async function loadMappings() {
    if (mappingsCache !== null) return mappingsCache;
    try {
      const raw    = await GM_getValue('channelMappings', '{}');
      // GM_getValue can return undefined on a cold start in some Tampermonkey
      // builds on Chrome even when a default is supplied. Guard before parsing.
      if (raw === undefined || raw === null) { mappingsCache = {}; return {}; }
      const parsed = JSON.parse(String(raw));
      // Guard: parsed must be a plain object — not an array, null, or primitive.
      // If the stored value has been corrupted or written by another code path
      // with the wrong shape, treat it as an empty mapping and reset storage
      // rather than letting Object.entries() throw or iterate unexpectedly.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('channelMappings: unexpected storage shape');
      }
      const clean  = {};
      for (const [k, v] of Object.entries(parsed)) {
        const sk = sanitiseUsername(k);
        const sv = sanitiseUsername(v);
        if (sk && sv) clean[sk] = sv;
      }
      mappingsCache = clean;
      return clean;
    } catch {
      // Storage value is corrupt or structurally invalid — reset it so the
      // failure doesn't repeat on every subsequent page load.
      mappingsCache = {};
      GM_setValue('channelMappings', '{}');
      return {};
    }
  }

  async function saveMapping(twitchUser, kickUser) {
    const sk = sanitiseUsername(twitchUser);
    const sv = sanitiseUsername(kickUser);
    if (!sk || !sv) return;
    const mappings = await loadMappings();
    mappings[sk] = sv;
    // Evict oldest entries if the store has grown beyond the cap. Object.keys
    // preserves insertion order in V8 (and per spec for string keys), so the
    // first key is the oldest. We only evict when genuinely over the limit to
    // avoid thrashing on every save.
    const keys = Object.keys(mappings);
    if (keys.length > MAPPINGS_MAX) {
      const toRemove = keys.slice(0, keys.length - MAPPINGS_MAX);
      for (const k of toRemove) delete mappings[k];
    }
    mappingsCache = mappings;
    await GM_setValue('channelMappings', JSON.stringify(mappings));
  }

  async function removeMapping(twitchUser) {
    const sk = sanitiseUsername(twitchUser);
    if (!sk) return;
    const mappings = await loadMappings();
    delete mappings[sk];
    mappingsCache = mappings;
    await GM_setValue('channelMappings', JSON.stringify(mappings));
  }

  // ─── Kick API ─────────────────────────────────────────────────────────────
  function fetchKickHlsUrl(kickUsername) {
    const safe = sanitiseUsername(kickUsername);
    if (!safe) return Promise.resolve(null);

    const cached = cacheGet(safe);
    if (cached) return Promise.resolve(cached.hlsUrl);

    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method:  'GET',
        url:     KICK_API_BASE + encodeURIComponent(safe),
        headers: { 'Accept': 'application/json' },
        timeout: 8000,
        onload(response) {
          // Respect rate-limiting — back off silently, don't cache
          if (response.status === 429) {
            console.warn('[KickSwap] Kick API rate-limited (429). Backing off.');
            resolve(null);
            return;
          }
          try {
            const data   = JSON.parse(response.responseText);
            const result = parseKickApiResponse(data);
            if (result) {
              apiNullStreak = 0;
              cacheSet(safe, { hlsUrl: result.hlsUrl, fetchedAt: Date.now() });
              resolve(result.hlsUrl);
            } else {
              apiNullStreak++;
              if (apiNullStreak >= API_WARN_THRESHOLD) {
                console.warn(
                  `[KickSwap] Kick API returned no usable stream ${apiNullStreak} times in a row. ` +
                  'The API response shape may have changed — check kick.com/api/v1/channels/:name.'
                );
              }
              resolve(null);
            }
          } catch (e) { console.debug('[KickSwap] fetchKickHlsUrl: failed to parse API response', e); resolve(null); }
        },
        onerror()   { resolve(null); },
        ontimeout() { resolve(null); },
      });
    });
  }

  // ─── Quality helpers ──────────────────────────────────────────────────────

  /**
   * Pick the best quality level index.
   * Priority: 1080p60 → 1080p (any fps) → 720p60 → highest available.
   * Does NOT set currentLevel here to avoid a mid-stream buffer flush.
   * Applied via nextLevel after the second fragment loads.
   */
  function getBestQualityIdx(levels) {
    if (!levels || levels.length === 0) return -1;

    const fps = (l) => {
      const raw = l.attrs && l.attrs['FRAME-RATE'];
      return raw ? Math.round(parseFloat(raw)) : 0;
    };

    // 1. 1080p60
    const idx1080p60 = levels.findIndex(l => l.height === 1080 && fps(l) >= 60);
    if (idx1080p60 !== -1) return idx1080p60;

    // 2. 1080p (any fps)
    const idx1080 = levels.findIndex(l => l.height === 1080);
    if (idx1080 !== -1) return idx1080;

    // 3. 720p60
    const idx720p60  = levels.findIndex(l => l.height === 720 && fps(l) >= 60);
    if (idx720p60  !== -1) return idx720p60;

    // 4. Highest available by height, then by fps on tie
    let best = 0;
    levels.forEach((l, i) => {
      const bh = levels[best].height || 0;
      const lh = l.height || 0;
      if (lh > bh || (lh === bh && fps(l) > fps(levels[best]))) best = i;
    });
    return best;
  }

  /**
   * Lock quality after the second fragment has loaded and playback is stable.
   * Using FRAG_LOADED (not MANIFEST_PARSED) avoids the buffer flush that
   * would briefly pause the stream.
   */
  function hookQualityLock() {
    if (!hlsInstance) return;
    let fragCount = 0;
    const onFragLoaded = () => {
      fragCount++;
      if (fragCount < 2) return;
      if (!hlsInstance) return;
      hlsInstance.off(Hls.Events.FRAG_LOADED, onFragLoaded);
      const idx = getBestQualityIdx(hlsInstance.levels);
      if (idx !== -1 && hlsInstance.currentLevel !== idx) {
        hlsInstance.nextLevel = idx;
        const l = hlsInstance.levels[idx];
        const fpsLabel = l.attrs?.['FRAME-RATE'] ? `@${Math.round(parseFloat(l.attrs['FRAME-RATE']))}fps` : '';
        console.info(`[KickSwap] Quality locked to ${l?.height}p${fpsLabel}`);
      }
    };
    hlsInstance.on(Hls.Events.FRAG_LOADED, onFragLoaded);
  }

  // ─── hls.js Custom Loader (CORS bypass) ───────────────────────────────────
  // GmLoader is built once here rather than inside startHlsPlayback so the
  // class definition is not recreated on every stream start. The class closes
  // only over the module-level KICK_CDN_HOSTS constant, so a single instance
  // of the class is safe to reuse across multiple Hls instantiations.
  //
  // SECURITY NOTE (finding F3 / Trade-off B):
  //   All HLS requests (manifests and segments) carry spoofed Origin and Referer
  //   headers so Kick's CDN accepts them. This is intentional and required — see
  //   the trust model comment block at the top of the file. The spoofing is confined to
  //   GmLoader, which is only used for HLS traffic. The Kick API call in
  //   fetchKickHlsUrl uses plain GM_xmlhttpRequest without these headers.
  //
  // SECURITY NOTE (finding F4 / redirect validation):
  //   After a successful response, response.finalUrl is validated against
  //   KICK_CDN_HOSTS before success is reported to hls.js. This prevents a
  //   302 redirect from a trusted host to an off-allowlist host from being
  //   silently accepted.
  const GmLoader = (() => {
    const defaultLoader = Hls.DefaultConfig.loader;

    class GmLoader extends defaultLoader {
      constructor(config) {
        super(config);
        this._gmRequest = null; // holds the active GM request handle for abort()
      }

      load(context, config, callbacks) {
        const { url } = context;

        // Security: validate every URL hls.js asks us to fetch — not just the
        // top-level manifest. Segment and sub-playlist URLs from a compromised
        // manifest could otherwise redirect us outside the allowlist.
        // We allow any pathname here (not just .m3u8) because segments use
        // .ts / .mp4 / .m4s extensions; the manifest URL was already validated
        // in parseKickApiResponse before it ever reached hls.js.
        let parsedUrl;
        try { parsedUrl = new URL(url); } catch {
          callbacks.onError({ code: 0, text: 'GmLoader: invalid URL' }, context, null, null);
          return;
        }
        if (parsedUrl.protocol !== 'https:') {
          callbacks.onError({ code: 0, text: 'GmLoader: non-HTTPS URL blocked' }, context, null, null);
          return;
        }
        const hostAllowed = KICK_CDN_HOSTS.some(
          h => parsedUrl.hostname === h || parsedUrl.hostname.endsWith('.' + h)
        );
        if (!hostAllowed) {
          // redactUrl strips the query string to avoid leaking signed tokens (finding F7).
          console.warn(`[KickSwap] GmLoader blocked request to disallowed host: ${redactUrl(url)}`);
          callbacks.onError({ code: 0, text: 'GmLoader: host not in allowlist' }, context, null, null);
          return;
        }

        const isSegment = /\.(ts|mp4|m4s|fmp4|cmfv|cmfa|cmft)(\?|$)/.test(url);

        // SECURITY NOTE (finding F3): Origin + Referer spoofing is required for
        // Kick's CDN to accept HLS requests. This is scoped to GmLoader (HLS
        // traffic only) and is documented as an intentional trade-off. See the
        // trust model comment block at the top of the file.
        this._gmRequest = GM_xmlhttpRequest({
          method:       'GET',
          url,
          responseType: isSegment ? 'arraybuffer' : 'text',
          headers:      { 'Origin': 'https://kick.com', 'Referer': 'https://kick.com/' },
          timeout:      15000,

          onload: (response) => {
            this._gmRequest = null;

            // ── Redirect destination validation (finding F4) ──────────────
            // If the CDN redirected the request, validate the final URL against
            // the allowlist. A 302 from a trusted host to an off-allowlist host
            // would otherwise be silently accepted because the request itself
            // was initiated against an allowlisted URL.
            const finalUrl = response.finalUrl || url;
            if (finalUrl !== url) {
              let parsedFinal;
              try { parsedFinal = new URL(finalUrl); } catch {
                console.warn('[KickSwap] GmLoader: could not parse redirect destination — blocking.');
                callbacks.onError({ code: 0, text: 'GmLoader: unparseable redirect destination' }, context, null, null);
                return;
              }
              const finalHostAllowed = KICK_CDN_HOSTS.some(
                h => parsedFinal.hostname === h || parsedFinal.hostname.endsWith('.' + h)
              );
              if (!finalHostAllowed) {
                // redactUrl strips query string — no signed tokens in logs (finding F7).
                console.warn(
                  `[KickSwap] GmLoader blocked redirect to off-allowlist host: ${redactUrl(finalUrl)}` +
                  ` (redirected from ${redactUrl(url)})`
                );
                callbacks.onError({ code: 0, text: 'GmLoader: redirect destination not in allowlist' }, context, null, null);
                return;
              }
            }

            if (response.status < 200 || response.status >= 300) {
              // redactUrl strips query string — no signed tokens in logs (finding F7).
              console.warn(`[KickSwap] GmLoader: HTTP ${response.status} for ${redactUrl(url)}`);
              callbacks.onError({ code: response.status, text: response.statusText }, context, null, response.responseText);
              return;
            }

            // ── Manifest Content-Type validation (finding F6) ─────────────
            // For manifest requests, verify the Content-Type header is a known
            // HLS type before handing the response to hls.js. This catches
            // cases where a compromised or misconfigured CDN serves unexpected
            // content at a .m3u8 URL.
            // Segments are not checked — binary MIME types vary too widely and
            // a wrong Content-Type on a segment is harmless to the parser.
            if (!isSegment) {
              const rawCt = response.responseHeaders
                ? (response.responseHeaders.match(/content-type:\s*([^\r\n;]+)/i) || [])[1]
                : null;
              const ct = rawCt ? rawCt.trim().toLowerCase() : null;
              if (ct && !HLS_MANIFEST_CONTENT_TYPES.has(ct)) {
                console.warn(`[KickSwap] GmLoader: unexpected Content-Type for manifest: "${ct}" — blocking.`);
                callbacks.onError({ code: 0, text: `GmLoader: unexpected manifest Content-Type: ${ct}` }, context, null, null);
                return;
              }
              // If ct is null (header absent or unparseable), we allow the response
              // through — some CDNs omit Content-Type on HLS responses. hls.js will
              // error naturally if the content is not a valid playlist.
            }

            // Tampermonkey on Chrome sometimes ignores responseType:'arraybuffer'
            // and returns a string in response.response instead of an ArrayBuffer.
            // We must convert using charCodeAt (lossless for binary) rather than
            // TextEncoder (which encodes as UTF-8 and corrupts bytes > 0x7F in
            // binary .ts/.mp4 segments, producing corrupted video frames).
            let segmentData = response.response;
            if (isSegment && !(segmentData instanceof ArrayBuffer)) {
              try {
                const str = typeof segmentData === 'string' ? segmentData : String(segmentData);
                const buf = new Uint8Array(str.length);
                for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i) & 0xff;
                segmentData = buf.buffer;
              } catch {
                segmentData = new ArrayBuffer(0);
              }
            }

            const dataSize = isSegment ? segmentData.byteLength : response.responseText.length;
            const stats = {
              aborted: false, loaded: dataSize, total: 0,
              retry: 0, chunkCount: 0, bwEstimate: 0,
              loading: { start: 0, first: 0, end: performance.now() },
              parsing: { start: 0, end: 0 },
              buffering: { start: 0, first: 0, end: 0 },
            };
            callbacks.onSuccess(
              { url: finalUrl, data: isSegment ? segmentData : response.responseText },
              stats, context, null
            );
          },
          onerror:   (err) => {
            this._gmRequest = null;
            // redactUrl strips query string — no signed tokens in logs (finding F7).
            console.warn('[KickSwap] GmLoader: GM request error for', redactUrl(url), err);
            callbacks.onError({ code: 0, text: 'GM request error' }, context, null, null);
          },
          ontimeout: () => {
            this._gmRequest = null;
            console.warn('[KickSwap] GmLoader: GM request timeout for', redactUrl(url));
            callbacks.onTimeout({ code: 0, text: 'GM request timeout' }, context, null);
          },
        });
      }

      abort() {
        if (this._gmRequest) {
          try { this._gmRequest.abort(); } catch {}
          this._gmRequest = null;
        }
      }
    }

    return GmLoader;
  })();

  // ─── Player ───────────────────────────────────────────────────────────────
  function destroyKickPlayer() {
    for (const { target, type, fn, capture } of cleanupListeners) {
      try { target.removeEventListener(type, fn, !!capture); } catch {}
    }
    cleanupListeners = [];

    // ── [P6] Cancel any pending autoShowControls timer ────────────────────
    clearTimeout(_autoShowTimer);
    _autoShowTimer = null;

    if (liveCheckTimer)   { clearInterval(liveCheckTimer); liveCheckTimer = null; }
    if (hlsInstance)      { try { hlsInstance.destroy(); }        catch {} hlsInstance      = null; }
    if (resizeObserver)   { try { resizeObserver.disconnect(); }   catch {} resizeObserver   = null; }
    if (watchdogObserver) { try { watchdogObserver.disconnect(); } catch {} watchdogObserver = null; }
    if (theatreObserver)  { try { theatreObserver.disconnect(); }  catch {} theatreObserver  = null; }

    if (overlayContainer && overlayContainer.parentNode) {
      overlayContainer.parentNode.removeChild(overlayContainer);
    }
    overlayContainer = null;
    overlayVideo     = null;
    knownTwitchVideo = null;
    syncVolUI        = null;
    isKickActive     = false;

    // ── [P2] Invalidate player container cache on destroy ─────────────────
    // The Twitch player element may be remounted after destroyKickPlayer returns,
    // so the cached reference must not be reused by the next getTwitchPlayerContainer() call.
    _playerContainerCache = null;

    restoreTwitchVideo();
    updateUiBadge();
  }

  function addTrackedListener(target, type, fn, capture) {
    target.addEventListener(type, fn, !!capture);
    cleanupListeners.push({ target, type, fn, capture: !!capture });
  }

  function restoreTwitchVideo() {
    const v = getTwitchVideo();
    if (!v) return;
    v.style.visibility = '';
    // Click Twitch's own mute button first if the video is muted, so their
    // React UI reflects the actual mute state (avoids a "stuck muted" icon).
    if (v.muted) {
      const muteBtn = document.querySelector('[data-a-target="player-mute-unmute-button"]');
      if (muteBtn) try { muteBtn.click(); } catch {}
    }
    v.muted = false;
    v.play().catch(() => {});
  }

  // ─── Stream-ended toast ───────────────────────────────────────────────────
  function showStreamEndedToast(playerContainer) {
    if (!playerContainer) return;
    if (document.getElementById('ks-ended-toast')) return;

    const toast = document.createElement('div');
    toast.id = 'ks-ended-toast';
    toast.textContent = 'Kick stream ended — switching back to Twitch';
    playerContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4000);
  }

  function startHlsPlayback(hlsUrl) {
    if (!overlayVideo) return;

    // Safari / native HLS fallback
    // Re-validate the URL here rather than relying on the caller to have done so,
    // making the safety guarantee locally verifiable regardless of call site.
    if (!Hls.isSupported()) {
      const safeSrc = validateHlsUrl(hlsUrl);
      if (safeSrc && overlayVideo.canPlayType('application/vnd.apple.mpegurl')) {
        const { volume, muted: savedMuted } = volumeCache || { volume: 1, muted: false };
        overlayVideo.src    = safeSrc;
        overlayVideo.volume = volume;
        overlayVideo.muted  = savedMuted;
        if (syncVolUI) syncVolUI(volume, savedMuted);
        overlayVideo.play().then(() => {
          isKickActive = true;
          updateUiBadge();
          autoShowControls();
        }).catch(() => {});
      }
      return;
    }

    hlsInstance = new Hls({ ...HLS_CONFIG, loader: GmLoader });

    // MANIFEST_PARSED must be registered synchronously before loadSource() so
    // it is never missed. Volume is read from volumeCache directly — it is
    // always populated by the time we get here because mountOverlay calls
    // buildControlBar() which calls loadVolumeCached(), and _initKickSwap
    // awaits loadMappings() before calling mountOverlay, giving the GM read
    // time to settle. Fallback to safe defaults if for any reason the cache
    // is still null.
    // Call flow for autoplay:
    //   MANIFEST_PARSED → doPlay
    //     → play() resolves  → isKickActive = true, removeClickPrompt
    //     → play() rejects   → showClickPrompt → (user clicks) → doPlay
    const removeClickPrompt = () => {
      const p = document.getElementById('ks-click-prompt');
      if (p && p.parentNode) p.parentNode.removeChild(p);
    };

    const showClickPrompt = () => {
      if (document.getElementById('ks-click-prompt') || !overlayContainer) return;
      const prompt = document.createElement('div');
      prompt.id = 'ks-click-prompt';
      prompt.appendChild(makeIcon('play'));
      prompt.addEventListener('click', () => {
        removeClickPrompt();
        doPlay();
      }, { once: true });
      overlayContainer.appendChild(prompt);
    };

    const doPlay = () => {
      if (!overlayVideo) return;
      const { volume, muted: savedMuted } = volumeCache || { volume: 1, muted: false };
      // play() is always called while muted=true — guaranteed to succeed under
      // every browser autoplay policy. The real saved mute/volume state is
      // restored only after the promise resolves so the browser never sees an
      // unmuted autoplay attempt.
      overlayVideo.muted = true;
      overlayVideo.play().then(() => {
        isKickActive    = true;
        hlsRetryCount   = 0;   // playback succeeded — reset so token expiry later still gets a retry
        if (overlayVideo) {
          overlayVideo.volume = volume;
          overlayVideo.muted  = savedMuted;
        }
        if (syncVolUI) syncVolUI(volume, savedMuted);
        updateUiBadge();
        autoShowControls();
        removeClickPrompt();
      }).catch(() => {
        showClickPrompt();
      });
    };

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      hookQualityLock();
      overlayVideo.muted = true;
      doPlay();
    });

    hlsInstance.loadSource(hlsUrl);
    hlsInstance.attachMedia(overlayVideo);

    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;

      if (hlsRetryCount < 1) {
        // First fatal error: token may have expired — invalidate the Kick cache
        // entry (using the resolved kick username, not the twitch channel name)
        // and retry after a short delay to avoid thrashing.
        hlsRetryCount++;
        console.info(
          '[KickSwap] Fatal HLS error — invalidating cache and retrying once.',
          data.details,
          data.response ? `HTTP ${data.response.code}` : ''
        );
        if (currentKickUser) cacheDelete(currentKickUser);
        setTimeout(() => safeReInit(), RETRY_DELAY_MS);
      } else {
        // Second fatal error: give up gracefully, show the user a toast.
        console.warn(
          '[KickSwap] Fatal HLS error on retry — falling back to Twitch.',
          data.details,
          data.response ? `HTTP ${data.response.code}` : ''
        );
        const playerContainer = getTwitchPlayerContainer();
        destroyKickPlayer();
        showStreamEndedToast(playerContainer);
      }
    });
  }

  // ─── Control Bar ──────────────────────────────────────────────────────────

  // ── [P6] autoShowControls with cancellable timer ──────────────────────────
  // The original implementation created a new uncancellable setTimeout on every
  // call. If doPlay() was invoked more than once (e.g. after a retry), orphaned
  // timers could hide controls that should still be visible. The module-level
  // _autoShowTimer handle allows each call to cancel the previous pending hide
  // before scheduling a new one, and destroyKickPlayer() clears it on teardown.
  function autoShowControls() {
    const bar   = document.getElementById('ks-controls');
    const panel = document.getElementById('ks-ui-panel');
    if (!bar && !panel) return;
    if (bar)   bar.classList.add('ks-visible');
    if (panel) panel.classList.add('ks-visible');

    clearTimeout(_autoShowTimer);
    _autoShowTimer = setTimeout(() => {
      _autoShowTimer = null;
      // Only hide if the user isn't already hovering
      if (overlayContainer && overlayContainer.matches(':hover')) return;
      if (bar)   bar.classList.remove('ks-visible');
      if (panel) panel.classList.remove('ks-visible');
    }, 2500);
  }

  /**
   * Build the control bar.
   * Layout:  LEFT: [Play/Pause] [Mute] [Vol slider] [Go Live] [LIVE badge]
   *          RIGHT: [Fullscreen]
   */
  function buildControlBar() {
    const bar = document.createElement('div');
    bar.id = 'ks-controls';

    // ── Left group ────────────────────────────────────────────────────────
    const left = document.createElement('div');
    left.className = 'ks-ctrl-group';

    // Play/Pause
    const playBtn = document.createElement('button');
    playBtn.id        = 'ks-play-btn';
    playBtn.className = 'ks-ctrl-btn';
    playBtn.title      = 'Play / Pause (Space)';
    playBtn.setAttribute('aria-label', 'Play / Pause');
    setIcon(playBtn, 'pause');

    playBtn.addEventListener('click', () => {
      if (!overlayVideo) return;
      overlayVideo.paused ? overlayVideo.play().catch(() => {}) : overlayVideo.pause();
    });

    addTrackedListener(overlayVideo, 'pause', () => { setIcon(playBtn, 'play');  });
    addTrackedListener(overlayVideo, 'play',  () => { setIcon(playBtn, 'pause'); });

    // Mute
    const muteBtn = document.createElement('button');
    muteBtn.id        = 'ks-mute-btn';
    muteBtn.className = 'ks-ctrl-btn';
    muteBtn.title      = 'Mute / Unmute (M)';
    muteBtn.setAttribute('aria-label', 'Mute / Unmute');
    setIcon(muteBtn, 'volumeHigh');

    // Volume slider
    const volSlider = document.createElement('input');
    volSlider.id    = 'ks-vol-slider';
    volSlider.type  = 'range';
    volSlider.min   = '0';
    volSlider.max   = '1';
    volSlider.step  = '0.02';
    volSlider.value = overlayVideo ? String(overlayVideo.volume) : '1';

    const updateVolUI = () => {
      if (!overlayVideo) return;
      _syncVolUI(overlayVideo.volume, overlayVideo.muted);
    };

    addTrackedListener(overlayVideo, 'volumechange', updateVolUI);

    muteBtn.addEventListener('click', () => {
      if (!overlayVideo) return;
      overlayVideo.muted = !overlayVideo.muted;
      saveVolume(overlayVideo.volume, overlayVideo.muted);
      updateVolUI();
    });

    volSlider.addEventListener('input', () => {
      if (!overlayVideo) return;
      const val = parseFloat(volSlider.value);
      overlayVideo.volume = val;
      overlayVideo.muted  = val === 0;
      // Debounced: the slider fires continuously while dragging; we don't need
      // a GM write on every frame. Discrete mute actions use saveVolume directly.
      saveVolumeDebounced(val, val === 0);
      updateVolUI();
    });

    // Go-Live / sync-to-live-edge button
    const syncBtn = document.createElement('button');
    syncBtn.id        = 'ks-sync-btn';
    syncBtn.className = 'ks-ctrl-btn';
    syncBtn.title      = 'Jump to live edge (L)';
    syncBtn.setAttribute('aria-label', 'Jump to live edge');
    setIcon(syncBtn, 'syncLive');
    syncBtn.addEventListener('click', () => syncToLive());

    // LIVE badge
    const liveBadge = document.createElement('div');
    liveBadge.id          = 'ks-live-badge';
    liveBadge.textContent = 'LIVE';

    left.appendChild(playBtn);
    left.appendChild(muteBtn);
    left.appendChild(volSlider);
    left.appendChild(syncBtn);
    left.appendChild(liveBadge);

    // ── Spacer ────────────────────────────────────────────────────────────
    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    // ── Right group ───────────────────────────────────────────────────────
    const right = document.createElement('div');
    right.className = 'ks-ctrl-group';

    // Fullscreen
    const fsBtn = document.createElement('button');
    fsBtn.id        = 'ks-fs-btn';
    fsBtn.className = 'ks-ctrl-btn';
    fsBtn.title      = 'Fullscreen (F)';
    fsBtn.setAttribute('aria-label', 'Toggle fullscreen');
    setIcon(fsBtn, 'fullscreen');

    fsBtn.addEventListener('click', () => toggleFullscreen());

    const onFsChange = () => {
      setIcon(fsBtn, document.fullscreenElement ? 'exitFullscreen' : 'fullscreen');
    };
    addTrackedListener(document, 'fullscreenchange', onFsChange);

    right.appendChild(fsBtn);

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    const HANDLED_KEYS = new Set(['Space', 'KeyM', 'KeyF', 'KeyL']);
    const onKeyDown = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (!overlayVideo) return;
      if (!HANDLED_KEYS.has(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.code === 'Space') {
        overlayVideo.paused ? overlayVideo.play().catch(() => {}) : overlayVideo.pause();
      }
      if (e.code === 'KeyM') {
        overlayVideo.muted = !overlayVideo.muted;
        saveVolume(overlayVideo.volume, overlayVideo.muted);
        updateVolUI();
      }
      if (e.code === 'KeyF') toggleFullscreen();
      if (e.code === 'KeyL') syncToLive();
    };
    // Capture phase: runs before Twitch's bubble-phase listeners, giving us
    // first pick so stopImmediatePropagation actually suppresses them.
    document.addEventListener('keydown', onKeyDown, true);
    cleanupListeners.push({ target: document, type: 'keydown', fn: onKeyDown, capture: true });

    bar.appendChild(left);
    bar.appendChild(spacer);
    bar.appendChild(right);

    loadVolumeCached().then(({ volume, muted }) => {
      volSlider.value = muted ? '0' : String(volume);
      const pct = (muted ? 0 : volume) * 100;
      volSlider.style.background = `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,0.3) ${pct}%)`;
      setIcon(muteBtn, (muted || volume === 0) ? 'volumeMute' : volume < 0.5 ? 'volumeLow' : 'volumeHigh');
    });

    return { bar, syncVolUI: _syncVolUI };

    function _syncVolUI(v, m) {
      setIcon(muteBtn, (m || v === 0) ? 'volumeMute' : v < 0.5 ? 'volumeLow' : 'volumeHigh');
      volSlider.value   = m ? '0' : String(v);
      const pct = (m ? 0 : v) * 100;
      volSlider.style.background = `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,0.3) ${pct}%)`;
    }
  }

  function toggleFullscreen() {
    const target = overlayContainer || overlayVideo;
    if (!target) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document).catch(() => {});
    } else {
      (target.requestFullscreen || target.webkitRequestFullscreen).call(target).catch(() => {});
    }
  }

  /**
   * Seek to the live edge. hls.js exposes liveSyncPosition for this purpose.
   * Falls back to seeking to the end of the seekable range if not available.
   */
  function syncToLive() {
    if (!overlayVideo || !hlsInstance) return;
    const target = hlsInstance.liveSyncPosition ?? hlsInstance.config?.liveSyncDuration;
    if (target != null) {
      overlayVideo.currentTime = target;
    } else if (overlayVideo.seekable.length > 0) {
      const end = overlayVideo.seekable.end(overlayVideo.seekable.length - 1);
      if (!isNaN(end)) overlayVideo.currentTime = end;
    }
    overlayVideo.play().catch(() => {});
  }

  // ─── Overlay ──────────────────────────────────────────────────────────────
  function mountOverlay(playerContainer, twitchVideo) {
    // Hide Twitch's video visually; keep it in the DOM so React doesn't panic.
    twitchVideo.style.visibility = 'hidden';
    twitchVideo.muted  = true;
    twitchVideo.pause();
    knownTwitchVideo = twitchVideo;

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'ks-overlay-container';
    Object.assign(overlayContainer.style, {
      position:   'absolute',
      top:        '0',
      left:       '0',
      width:      '100%',
      height:     '100%',
      zIndex:     '100',
      background: '#000',
    });

    // overlayVideo must be created before buildControlBar() so its event
    // listeners inside that function reference the real element.
    overlayVideo = document.createElement('video');
    overlayVideo.id          = 'ks-overlay-video';
    overlayVideo.playsinline = true;
    Object.assign(overlayVideo.style, {
      position:  'absolute',
      top:       '0',
      left:      '0',
      width:     '100%',
      height:    '100%',
      display:   'block',
      objectFit: 'contain',
    });

    const { bar: controlBar, syncVolUI: builtSyncVolUI } = buildControlBar();
    syncVolUI = builtSyncVolUI;

    overlayContainer.appendChild(overlayVideo);
    overlayContainer.appendChild(controlBar);

    const existingPos = getComputedStyle(playerContainer).position;
    if (existingPos === 'static') playerContainer.style.position = 'relative';

    playerContainer.appendChild(overlayContainer);

    if (uiPanel && uiPanel.parentNode === playerContainer) {
      overlayContainer.appendChild(uiPanel);
    }

    // ── [P5] Close over element references for hover show/hide ────────────
    // The original code called document.getElementById('ks-controls') and
    // document.getElementById('ks-ui-panel') on every mouseenter/mouseleave
    // event. While getElementById is O(1), closing over the already-created
    // element references is free and makes the lookup intent explicit.
    const controlBarEl = controlBar;   // direct reference, no lookup needed
    const panelEl      = uiPanel;      // direct reference, no lookup needed

    const showControls = () => {
      controlBarEl?.classList.add('ks-visible');
      panelEl?.classList.add('ks-visible');
    };
    const hideControls = () => {
      controlBarEl?.classList.remove('ks-visible');
      panelEl?.classList.remove('ks-visible');
    };
    addTrackedListener(overlayContainer, 'mouseenter', showControls);
    addTrackedListener(overlayContainer, 'mouseleave', hideControls);

    // ── [P7] ResizeObserver with equality guard ────────────────────────────
    // The original callback wrote overlayContainer.style.width/height = '100%'
    // unconditionally on every resize event, triggering unnecessary style
    // recalculations even when the values hadn't changed. Since the overlay's
    // inline styles are initialised to '100%' and nothing else changes them,
    // the write is almost always a no-op in practice. The equality guard makes
    // that explicit and avoids the style invalidation entirely during normal
    // resize events where values have not drifted.
    resizeObserver = new ResizeObserver(() => {
      if (!overlayContainer) return;
      if (overlayContainer.style.width  !== '100%') overlayContainer.style.width  = '100%';
      if (overlayContainer.style.height !== '100%') overlayContainer.style.height = '100%';
    });
    resizeObserver.observe(playerContainer);

    startTheatreObserver(playerContainer);
  }

  // ─── Theatre mode observer ────────────────────────────────────────────────
  /**
   * Watches for Twitch theatre-mode / fullscreen class changes on the player
   * wrapper. When a change is detected the overlay dimensions are re-anchored
   * after one animation frame.
   *
   * [P10] The ancestor walk (up to 6 elements) is now cached in _theatreWatchTarget
   * so it only happens once per channel session rather than on every safeReInit()
   * cycle. The cache is cleared in onNavigate() alongside _playerContainerCache.
   */
  function startTheatreObserver(playerContainer) {
    if (theatreObserver) { theatreObserver.disconnect(); theatreObserver = null; }

    // Use cached target if still in the document; otherwise re-walk.
    if (!(_theatreWatchTarget && document.contains(_theatreWatchTarget))) {
      _theatreWatchTarget = playerContainer;
      let el = playerContainer.parentElement;
      for (let i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
        const cls = el.className || '';
        if (/theatre|theater|fullscreen/i.test(cls)) { _theatreWatchTarget = el; break; }
      }
    }

    theatreObserver = new MutationObserver(() => {
      if (!overlayContainer) return;
      requestAnimationFrame(() => {
        overlayContainer.style.width  = '100%';
        overlayContainer.style.height = '100%';
      });
    });

    theatreObserver.observe(_theatreWatchTarget, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  // ─── Ad-swap guard ────────────────────────────────────────────────────────
  function handlePossibleAdSwap(playerContainer) {
    const currentVideo = getTwitchVideoIn(playerContainer);
    if (!currentVideo) return;

    if (currentVideo !== knownTwitchVideo) {
      console.info('[KickSwap] Twitch video element replaced (ad/remount) — re-hiding.');
      currentVideo.style.visibility = 'hidden';
      currentVideo.muted = true;
      currentVideo.pause();
      knownTwitchVideo = currentVideo;
    }
  }

  // ─── UI Panel (badge + channel override) ─────────────────────────────────
  function mountUiPanel(playerContainer) {
    if (uiPanel) return;

    if (!document.getElementById('ks-styles')) {
      const style = document.createElement('style');
      style.id = 'ks-styles';
      style.textContent = `
        #ks-ui-panel {
          position: absolute;
          top: 10px;
          left: 10px;
          z-index: 201;
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: 'Inter', sans-serif;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.2s ease;
        }
        #ks-badge {
          display: flex;
          align-items: center;
          gap: 5px;
          background: rgba(0,0,0,0.72);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 4px;
          padding: 3px 8px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: #aaa;
          user-select: none;
          transition: color 0.3s;
        }
        #ks-badge-dot {
          width: 6px; height: 6px;
          border-radius: 50%;
          background: #555;
          display: inline-block;
          transition: background 0.3s;
        }
        #ks-badge.kick-active #ks-badge-dot   { background: #53fc18; }
        #ks-badge.kick-active #ks-badge-label { color: #53fc18; }
        #ks-badge.ks-checking #ks-badge-dot   { background: #aaa; animation: ks-pulse 1s ease-in-out infinite; }
        #ks-badge.ks-checking #ks-badge-label { color: #aaa; }
        @keyframes ks-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        #ks-edit-btn {
          background: rgba(0,0,0,0.72);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 4px;
          color: #aaa;
          font-size: 13px;
          padding: 2px 7px;
          cursor: pointer;
          user-select: none;
          transition: color 0.2s, border-color 0.2s;
        }
        #ks-edit-btn:hover { color: #fff; border-color: rgba(255,255,255,0.35); }
        #ks-twitch-btn {
          background: rgba(0,0,0,0.72);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 4px;
          color: #aaa;
          font-size: 10px;
          font-weight: 600;
          padding: 2px 7px;
          cursor: pointer;
          user-select: none;
          transition: color 0.2s, border-color 0.2s, background 0.2s;
        }
        #ks-twitch-btn:hover { color: #fff; border-color: rgba(255,255,255,0.35); }
        #ks-twitch-btn.ks-disabled-session { color: #fc5353; border-color: rgba(252,83,83,0.4); }
        #ks-edit-form {
          display: flex;
          align-items: center;
          gap: 5px;
          background: rgba(0,0,0,0.82);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 4px;
          padding: 4px 8px;
        }
        #ks-username-input {
          background: transparent;
          border: none;
          border-bottom: 1px solid rgba(255,255,255,0.3);
          color: #fff;
          font-family: inherit;
          font-size: 11px;
          outline: none;
          width: 110px;
          padding: 2px 0;
        }
        #ks-save-btn, #ks-clear-btn {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.2);
          border-radius: 3px;
          color: #ccc;
          font-size: 10px;
          padding: 2px 7px;
          cursor: pointer;
          font-family: inherit;
          transition: background 0.2s, color 0.2s;
        }
        #ks-save-btn:hover  { background: #53fc18; color: #000; border-color: #53fc18; }
        #ks-clear-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }

        /* ── Control bar ── */
        #ks-controls {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          display: flex;
          align-items: center;
          padding: 0 8px 6px;
          height: 48px;
          box-sizing: border-box;
          background: linear-gradient(to top, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.3) 80%, transparent 100%);
          z-index: 102;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.2s ease;
        }
        #ks-controls.ks-visible,
        #ks-ui-panel.ks-visible {
          opacity: 1 !important;
          pointer-events: auto !important;
        }
        .ks-ctrl-group {
          display: flex;
          align-items: center;
          gap: 2px;
        }
        .ks-ctrl-btn {
          background: transparent;
          border: none;
          color: rgba(255,255,255,0.9);
          cursor: pointer;
          width: 36px;
          height: 36px;
          padding: 6px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: color 0.1s, background 0.1s;
        }
        .ks-ctrl-btn:hover { color: #fff; background: rgba(255,255,255,0.12); }
        .ks-ctrl-btn svg   { width: 20px; height: 20px; display: block; }
        #ks-vol-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 72px;
          height: 3px;
          border-radius: 2px;
          background: rgba(255,255,255,0.3);
          outline: none;
          cursor: pointer;
          margin: 0 4px;
        }
        #ks-vol-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 13px; height: 13px;
          border-radius: 50%;
          background: #fff;
          cursor: pointer;
        }
        #ks-live-badge {
          background: #e91916;
          color: #fff;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          padding: 2px 6px;
          border-radius: 3px;
          margin-left: 8px;
          user-select: none;
          flex-shrink: 0;
        }

        /* ── Toasts & overlays ── */
        #ks-ended-toast {
          position: absolute;
          bottom: 60px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(0,0,0,0.82);
          color: #fff;
          font-family: 'Inter', sans-serif;
          font-size: 13px;
          padding: 8px 16px;
          border-radius: 4px;
          border: 1px solid rgba(255,255,255,0.15);
          z-index: 300;
          pointer-events: none;
          white-space: nowrap;
          animation: ks-fadein 0.2s ease, ks-fadeout 0.4s ease 3.6s forwards;
        }
        @keyframes ks-fadein  { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ks-fadeout { from { opacity: 1; } to { opacity: 0; } }
        #ks-offline-badge {
          position: absolute;
          top: 12px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(0,0,0,0.78);
          color: #bbb;
          font-family: 'Inter', sans-serif;
          font-size: 12px;
          padding: 6px 14px;
          border-radius: 4px;
          border: 1px solid rgba(255,255,255,0.12);
          z-index: 300;
          white-space: nowrap;
          cursor: pointer;
          animation: ks-fadein 0.2s ease, ks-fadeout 0.4s ease 5.6s forwards;
        }
        #ks-click-prompt {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0,0,0,0.35);
          cursor: pointer;
          z-index: 150;
        }
        #ks-click-prompt svg {
          width: 72px;
          height: 72px;
          color: rgba(255,255,255,0.9);
          filter: drop-shadow(0 2px 8px rgba(0,0,0,0.6));
        }
      `;
      document.head.appendChild(style);
    }

    uiPanel = document.createElement('div');
    uiPanel.id = 'ks-ui-panel';

    const badge = document.createElement('div');
    badge.id = 'ks-badge';
    const badgeDot = document.createElement('span');
    badgeDot.id = 'ks-badge-dot';
    const badgeLabel = document.createElement('span');
    badgeLabel.id = 'ks-badge-label';
    badgeLabel.textContent = 'TWITCH';
    badge.appendChild(badgeDot);
    badge.appendChild(badgeLabel);

    const twitchBtnEl = document.createElement('button');
    twitchBtnEl.type  = 'button';
    twitchBtnEl.id    = 'ks-twitch-btn';
    twitchBtnEl.title = 'Temporarily use Twitch for this session (does not remove your mapping)';
    twitchBtnEl.textContent = 'Use Twitch';

    const editBtnEl = document.createElement('button');
    editBtnEl.type  = 'button';
    editBtnEl.id    = 'ks-edit-btn';
    editBtnEl.title = 'Set Kick username for this channel';
    editBtnEl.textContent = '✎';

    const editForm = document.createElement('div');
    editForm.id           = 'ks-edit-form';
    editForm.style.display = 'none';

    const usernameInput = document.createElement('input');
    usernameInput.id          = 'ks-username-input';
    usernameInput.type        = 'text';
    usernameInput.placeholder = 'kick username';
    usernameInput.maxLength   = 30;
    usernameInput.spellcheck  = false;
    usernameInput.autocomplete = 'off';

    const saveBtn = document.createElement('button');
    saveBtn.id          = 'ks-save-btn';
    saveBtn.type        = 'button';
    saveBtn.textContent = 'Save';

    const clearBtn = document.createElement('button');
    clearBtn.id          = 'ks-clear-btn';
    clearBtn.type        = 'button';
    clearBtn.title       = 'Remove mapping, use auto';
    clearBtn.textContent = 'Auto';

    editForm.appendChild(usernameInput);
    editForm.appendChild(saveBtn);
    editForm.appendChild(clearBtn);

    uiPanel.appendChild(badge);
    uiPanel.appendChild(twitchBtnEl);
    uiPanel.appendChild(editBtnEl);
    uiPanel.appendChild(editForm);

    const panelParent = overlayContainer || playerContainer;
    panelParent.appendChild(uiPanel);

    twitchBtnEl.addEventListener('click', () => {
      disabledForSession = !disabledForSession;
      twitchBtnEl.textContent = disabledForSession ? 'Use Kick' : 'Use Twitch';
      twitchBtnEl.title       = disabledForSession
        ? 'Switch back to Kick stream'
        : 'Temporarily use Twitch for this session (does not remove your mapping)';
      twitchBtnEl.classList.toggle('ks-disabled-session', disabledForSession);
      if (disabledForSession) {
        destroyKickPlayer();
      } else {
        // User explicitly re-enabled Kick — reset the retry budget so a
        // transient HLS error on this attempt still gets one automatic retry,
        // rather than falling back immediately because a prior failure had
        // already consumed the single retry allowed per session segment.
        hlsRetryCount = 0;
        safeReInit();
      }
    });

    editBtnEl.addEventListener('click', async () => {
      const isHidden = editForm.style.display === 'none';
      editForm.style.display = isHidden ? 'flex' : 'none';
      if (isHidden) {
        const mappings = await loadMappings();
        usernameInput.value = (currentChannel && mappings[currentChannel]) ? mappings[currentChannel] : '';
        usernameInput.focus();
      }
    });

    saveBtn.addEventListener('click', async () => {
      const raw   = usernameInput.value;
      const clean = sanitiseUsername(raw);
      if (!clean || !currentChannel) return;

      saveBtn.textContent = 'Saved ✓';
      saveBtn.style.color = '#53fc18';
      setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.style.color = ''; }, 1500);

      await saveMapping(currentChannel, clean);
      editForm.style.display = 'none';
      cacheDelete(clean);
      destroyKickPlayer();
      await initKickSwap();
    });

    clearBtn.addEventListener('click', async () => {
      if (!currentChannel) return;
      await removeMapping(currentChannel);
      editForm.style.display = 'none';
      destroyKickPlayer();
      await initKickSwap();
    });

    let debounceTimer;
    usernameInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const val   = e.target.value;
        const valid = sanitiseUsername(val);
        e.target.style.borderBottomColor = val.length === 0 ? 'rgba(255,255,255,0.3)' : valid ? '#53fc18' : '#ff4545';
      }, 300);
    });
  }

  function updateUiBadge(state) {
    const badge = document.getElementById('ks-badge');
    const label = document.getElementById('ks-badge-label');
    if (!badge || !label) return;
    badge.classList.remove('kick-active', 'ks-checking');
    if (state === 'checking') {
      badge.classList.add('ks-checking');
      label.textContent = 'KICK…';
    } else if (isKickActive) {
      badge.classList.add('kick-active');
      label.textContent = 'KICK';
    } else {
      label.textContent = 'TWITCH';
    }
  }

  function destroyUiPanel() {
    if (uiPanel && uiPanel.parentNode) uiPanel.parentNode.removeChild(uiPanel);
    uiPanel = null;
  }

  // ─── Offline badge ────────────────────────────────────────────────────────
  function showOfflineBadge(kickUsername, isMapped) {
    const playerContainer = getTwitchPlayerContainer();
    if (!playerContainer) return;

    const existing = document.getElementById('ks-offline-badge');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    const label = isMapped
      ? `Kick: ${kickUsername} is offline — showing Twitch`
      : `Kick: ${kickUsername} not live — click ✎ above to set a Kick username`;

    const badge = document.createElement('div');
    badge.id = 'ks-offline-badge';
    badge.textContent = label;

    const dismiss = () => { if (badge.parentNode) badge.parentNode.removeChild(badge); };
    badge.addEventListener('click', dismiss, { once: true });

    playerContainer.appendChild(badge);

    setTimeout(dismiss, 6000);
  }

  // ─── Periodic live-status check ───────────────────────────────────────────
  function startLiveCheck(kickUsername) {
    if (liveCheckTimer) { clearInterval(liveCheckTimer); liveCheckTimer = null; }
    liveCheckTimer = setInterval(async () => {
      if (!isKickActive || !kickUsername) return;
      const url = await fetchKickHlsUrl(kickUsername);
      if (!url && isKickActive) {
        console.info('[KickSwap] Periodic check: Kick stream is no longer live — falling back to Twitch.');
        const playerContainer = getTwitchPlayerContainer();
        destroyKickPlayer();
        showStreamEndedToast(playerContainer);
      }
    }, LIVE_CHECK_INTERVAL_MS);
  }

  // ─── Core Init ────────────────────────────────────────────────────────────
  async function initKickSwap() {
    if (initInProgress) return;
    initInProgress = true;
    try {
      await _initKickSwap();
    } finally {
      initInProgress = false;
    }
  }

  async function _initKickSwap() {
    const channel = getTwitchChannel();
    if (!channel) return;
    currentChannel = channel;

    if (disabledForSession) return;

    const playerContainer = getTwitchPlayerContainer();
    const twitchVideo     = getTwitchVideo();
    if (!playerContainer || !twitchVideo) return;

    if (!uiPanel) mountUiPanel(playerContainer);

    const mappings = await loadMappings();
    if (getTwitchChannel() !== channel) return;

    const kickUsername = mappings[channel] || channel;
    currentKickUser = kickUsername;

    updateUiBadge('checking');

    const hlsUrl = await fetchKickHlsUrl(kickUsername);
    if (getTwitchChannel() !== channel) return;

    if (!hlsUrl) {
      updateUiBadge();
      const isMapped = !!mappings[channel];
      console.info(
        `[KickSwap] No live Kick stream for "${kickUsername}"${isMapped ? '' : ' (auto-match — set a mapping if the usernames differ)'}. Using Twitch.`
      );
      showOfflineBadge(kickUsername, isMapped);
      return;
    }

    mountOverlay(playerContainer, twitchVideo);
    startHlsPlayback(hlsUrl);
    startWatchdog(playerContainer);
    startLiveCheck(kickUsername);
  }

  // ─── Navigation & Lifecycle ───────────────────────────────────────────────

  let reInitGuard      = false;
  let reInitGuardTimer = null;

  async function safeReInit() {
    if (reInitGuard) return;
    reInitGuard      = true;
    reInitGuardTimer = setTimeout(() => { reInitGuard = false; }, 15000);
    try {
      try { destroyKickPlayer(); } catch (e) {
        console.warn('[KickSwap] destroyKickPlayer threw during safeReInit — continuing.', e);
      }
      await initKickSwap();
    } finally {
      reInitGuard = false;
      clearTimeout(reInitGuardTimer);
    }
  }

  // ─── Watchdog ─────────────────────────────────────────────────────────────
  function startWatchdog(playerContainer) {
    if (watchdogObserver) { watchdogObserver.disconnect(); watchdogObserver = null; }

    watchdogObserver = new MutationObserver((mutations) => {
      if (!document.getElementById('ks-overlay-container') && isKickActive) {
        console.info('[KickSwap] Overlay removed (likely ad or player remount) — re-initialising.');
        watchdogObserver.disconnect();
        watchdogObserver = null;
        safeReInit();
        return;
      }

      if (isKickActive) {
        for (const m of mutations) {
          if (m.addedNodes.length > 0) { handlePossibleAdSwap(playerContainer); break; }
        }
      }
    });

    // subtree: false — both the overlay container and the Twitch <video> are
    // direct children of playerContainer.
    watchdogObserver.observe(playerContainer, { childList: true, subtree: false });
  }

  function onNavigate() {
    const newChannel = getTwitchChannel();
    if (newChannel === currentChannel) return;
    if (watchdogObserver) { watchdogObserver.disconnect(); watchdogObserver = null; }
    if (theatreObserver)  { theatreObserver.disconnect();  theatreObserver  = null; }
    destroyKickPlayer();
    destroyUiPanel();
    currentKickUser    = null;
    hlsRetryCount      = 0;
    disabledForSession = false;

    // ── [P2, P10] Invalidate caches on channel navigation ─────────────────
    // destroyKickPlayer() clears _playerContainerCache already, but we also
    // clear it here explicitly in case destroyKickPlayer is skipped (e.g. when
    // Kick was never active on the previous channel).
    _playerContainerCache = null;
    // Theatre watch target is layout-dependent and may differ between channels
    // if Twitch renders different wrapper structures (e.g. /popout/ vs normal).
    _theatreWatchTarget   = null;

    waitForPlayer();
  }

  // ── [P1] waitForPlayer — replaced broad subtree observer ──────────────────
  // The original implementation observed `#root` (or `document.body`) with
  // `{ childList: true, subtree: true }` — the broadest possible scope. On
  // Twitch's React-heavy DOM this fires on every chat message, viewer count
  // update, and metadata reconciliation, running getTwitchVideo() (a triple
  // querySelector chain) on every callback during the 1–3 s window between
  // navigation and player mount.
  //
  // Replacement strategy (two-stage):
  //
  // 1. requestIdleCallback polling (primary path).
  //    Schedules up to MAX_ATTEMPTS checks during browser idle time (timeout:
  //    200 ms ensures it doesn't wait forever). Idle callbacks run between
  //    tasks, so they do not compete with Twitch's React reconciliation on
  //    the main thread. For a typical Twitch page load (player appears within
  //    ~1 s), 5–10 idle checks suffice; the MutationObserver fallback is never
  //    reached in normal conditions.
  //
  // 2. Narrowed MutationObserver fallback (slow-load / edge case).
  //    Engaged only after ~5 s (25 × 200 ms) of unsuccessful idle polling.
  //    Observes `main` (Twitch's primary content region, a direct ancestor of
  //    the player) rather than `#root`. Falls back through progressively wider
  //    roots but never starts with the broadest one.
  //
  // requestIdleCallback is available in all Chromium and Firefox versions that
  // support Tampermonkey/Violentmonkey (Chrome 47+, Firefox 55+).
  function waitForPlayer() {
    if (getTwitchVideo()) { initKickSwap(); return; }

    if (playerObserver) { playerObserver.disconnect(); playerObserver = null; }

    let attempts = 0;
    const MAX_ATTEMPTS = 25; // ~5 s at 200 ms timeout per attempt

    const poll = () => {
      if (getTwitchVideo()) {
        initKickSwap();
        return;
      }
      if (++attempts < MAX_ATTEMPTS) {
        requestIdleCallback(poll, { timeout: 200 });
      } else {
        // Idle polling exhausted — fall back to a narrowed MutationObserver.
        // `main` is Twitch's primary content container and a reliable ancestor
        // of the player. Fall through to progressively wider roots only if
        // `main` is absent (e.g. unusual Twitch page variants).
        const narrowRoot =
          document.querySelector('main') ||
          document.querySelector('[data-a-target="page-main-content"]') ||
          document.getElementById('root') ||
          document.body;

        playerObserver = new MutationObserver((_, obs) => {
          if (getTwitchVideo()) {
            obs.disconnect();
            playerObserver = null;
            initKickSwap();
          }
        });
        playerObserver.observe(narrowRoot, { childList: true, subtree: true });
      }
    };

    requestIdleCallback(poll, { timeout: 200 });
  }

  // Module-level sentinels for the history wrapping guards.
  // We cannot tag the native history.pushState / replaceState function objects
  // with a custom property on Tampermonkey/Chrome because the script runs in an
  // isolated sandbox: writes to native cross-realm function objects are silently
  // discarded, so __ksWrapped never sticks and onNavigate fires twice on every
  // SPA navigation. A plain module-level boolean is immune to this.
  let _pushStateWrapped    = false;
  let _replaceStateWrapped = false;

  function hookNavigation() {
    if (!_pushStateWrapped) {
      const _origPushState = history.pushState.bind(history);
      history.pushState = function (...args) {
        _origPushState(...args);
        onNavigate();
      };
      _pushStateWrapped = true;
    }

    if (!_replaceStateWrapped) {
      const _origReplaceState = history.replaceState.bind(history);
      history.replaceState = function (...args) {
        _origReplaceState(...args);
        onNavigate();
      };
      _replaceStateWrapped = true;
    }

    window.addEventListener('popstate', onNavigate);

    // ── Mini player expand detection (P3 — unchanged, with rationale) ─────
    // This capture-phase click listener performs cheap boolean guard checks
    // (isKickActive, disabledForSession, initInProgress, reInitGuard,
    // hlsRetryCount) followed by a Date.now() comparison on every click.
    // The cost is sub-microsecond in the common case (isKickActive = true
    // returns immediately). The setTimeout(0) is only scheduled when all
    // guards pass, which requires the Kick overlay to be absent and the
    // stream page to be active — a rare condition.
    //
    // A narrower listener (e.g. scoped to Twitch's mini-player expand button)
    // would reduce callback frequency but requires identifying a stable Twitch
    // selector, which is fragile across Twitch UI updates. The current
    // page-wide approach is the safe choice; the guards ensure the body of
    // the handler only executes when genuinely needed.
    let lastMiniPlayerCheck = 0;
    document.addEventListener('click', () => {
      if (isKickActive) return;
      if (disabledForSession) return;
      if (initInProgress) return;
      if (reInitGuard) return;
      if (hlsRetryCount > 0) return;
      if (Date.now() - lastMiniPlayerCheck < MINI_PLAYER_COOLDOWN) return;
      setTimeout(() => {
        const channel = getTwitchChannel();
        if (!channel) return;
        if (document.getElementById('ks-overlay-container')) return;
        lastMiniPlayerCheck = Date.now();
        if (channel !== currentChannel || !document.getElementById('ks-ui-panel')) {
          console.info('[KickSwap] Mini player expand detected — re-initialising.');
          waitForPlayer();
        }
      }, 0);
    }, true);

    // ── [P4] visibilitychange — TTL-based recheck (cacheDelete removed) ───
    // The original handler called cacheDelete(currentKickUser) unconditionally
    // before every tab-focus recheck. This bypassed the 5-minute session cache
    // TTL and triggered a fresh Kick API call on every tab-focus after the
    // 30-second VISIBILITY_RECHECK_COOLDOWN — up to 240 calls/hour for a user
    // switching tabs frequently while the Kick stream is offline.
    //
    // Fix: the cacheDelete call is removed. fetchKickHlsUrl honours the TTL
    // natively — a stale "offline" entry expires after 5 minutes and the next
    // call automatically makes a fresh request. The feature intent (detect a
    // stream coming online while away) is fully preserved: after the TTL
    // expires, the next tab-focus triggers a fresh API call as before.
    // API call rate is reduced from ≤1/30 s to ≤1/5 min for offline channels.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!currentChannel) return;

      const overlayPresent = !!document.getElementById('ks-overlay-container');

      if (isKickActive && !overlayPresent) {
        console.info('[KickSwap] Tab became visible — overlay missing, re-initialising.');
        safeReInit();
        return;
      }

      // Stream was offline when page loaded — recheck on tab focus.
      if (!isKickActive && !disabledForSession && getTwitchChannel() === currentChannel) {
        const now = Date.now();
        if (now - lastVisibilityRecheck < VISIBILITY_RECHECK_COOLDOWN) return;
        lastVisibilityRecheck = now;
        // [P4] cacheDelete removed — TTL in fetchKickHlsUrl handles freshness.
        initKickSwap();
      }
    });
  }

  // ── [P9] bootstrap — stream-page guard ────────────────────────────────────
  // hookNavigation() runs unconditionally so SPA navigations from non-stream
  // pages (browse → channel) are detected. waitForPlayer() is skipped for
  // non-stream URLs (VODs, clips, directory) to avoid creating a MutationObserver
  // and making a spurious Kick API call on pages where the script has nothing
  // to do. isLikelyStreamPage() reuses the same regex as getTwitchChannel().
  function bootstrap() {
    hookNavigation();
    if (isLikelyStreamPage()) waitForPlayer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  } // end main()

})();
