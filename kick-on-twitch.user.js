// ==UserScript==
// @name         Kick on Twitch
// @namespace    https://github.com/Kinshara/kick-on-twitch
// @version      3.7.0
// @description  Replaces the Twitch video feed with a Kick stream, keeping Twitch chat and UI intact. Requires Tampermonkey or Violentmonkey — Greasemonkey 4 is not supported.
// @author       Kinshara
// @match        https://www.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_getResourceURL
// @connect      kick.com
// @connect      cdn.kick.com
// @connect      *.live-video.net
// @resource     hlsjs  https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js#sha256-tSKlOmn2TH8NXqy21zy3/2r2MtYBRLzQdDVN7xBE7Ek=
// @run-at       document-idle
// ==/UserScript==

// NOTE — hls.js is loaded via @resource with an SRI integrity hash, verified
// by the userscript manager before execution. If the hash check fails the
// resource will not load. To update hls.js:
//   1. Pick a release from https://github.com/video-dev/hls.js/releases
//   2. Download hls.min.js from the release assets
//   3. Regenerate the hash: openssl dgst -sha256 -binary hls.min.js | openssl base64 -A
//   4. Update BOTH the version in the @resource URL AND the hash after the '#' — they must match.
//   5. Bump @version so userscript managers prompt users to update.
//
// NOTE — GmLoader injects `Origin: https://kick.com` on every HLS request to
// satisfy Kick's CORS policy. This works because GM_xmlhttpRequest bypasses
// the browser's same-origin enforcement. This is a deliberate, accepted
// trade-off required for the script to function; the CORS backstop the browser
// would normally provide is therefore absent for HLS traffic. GmLoader
// compensates by validating every request URL against KICK_CDN_HOSTS before
// issuing the GM request — only allowlisted hostnames are ever fetched.
// Kick may tighten token validation tied to referrer/origin in future; if
// streams stop loading, this is the first place to investigate.
//
// NOTE — @connect uses *.live-video.net to cover all AWS IVS regions Kick uses.
// If Kick adds a new CDN provider, add its domain here and to KICK_CDN_HOSTS.
// Because the wildcard is broad (all of *.live-video.net, not just Kick's
// sub-prefix), the per-request host check in GmLoader is the meaningful
// enforcement layer.

(function () {
  'use strict';

  // ─── Bootstrap: inject hls.js from verified @resource ────────────────────
  // GM_getResourceURL returns a blob: URL for the SRI-verified resource.
  // Inject it as a <script> and defer all initialisation until it loads.
  (function loadHls(cb) {
    const url = GM_getResourceURL('hlsjs');
    if (!url) { console.error('[KickSwap] hls.js resource not available — check @resource and SRI hash.'); return; }
    const s = document.createElement('script');
    s.src = url;
    s.onload  = cb;
    s.onerror = () => console.error('[KickSwap] Failed to load hls.js from resource URL.');
    document.head.appendChild(s);
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
  const KICK_CDN_HOSTS = [
    'live-video.net',
    'cdn.kick.com',
    'kick.com',
  ];

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
  let gestureUnlocked     = false; // true once a user gesture has unlocked autoplay
  let apiNullStreak       = 0;     // counts consecutive API non-live / bad-shape results
  let liveCheckTimer      = null;  // setInterval handle for periodic live-status polling
  let lastVisibilityRecheck = 0;   // Date.now() of last visibility-triggered API recheck
  let initInProgress      = false; // true while initKickSwap is awaiting; blocks concurrent calls
  // syncVolUI: set by buildControlBar so startHlsPlayback can call it without
  // duck-punching a property onto the video element.
  let syncVolUI           = null;

  // ─── In-memory mappings cache (avoids a GM read on every nav) ────────────
  let mappingsCache     = null;  // null = not yet loaded

  // ─── Volume persistence ──────────────────────────────────────────────────
  async function loadVolume() {
    try {
      const raw = await GM_getValue('ksVolume', '{"volume":1,"muted":false}');
      const p   = JSON.parse(String(raw));
      // Pre-populate slider immediately from persisted state to avoid the
      // brief flash where it shows full volume before the async resolve.
      return {
        volume: typeof p.volume === 'number' ? Math.min(1, Math.max(0, p.volume)) : 1,
        muted:  typeof p.muted  === 'boolean' ? p.muted : false,
      };
    } catch { return { volume: 1, muted: false }; }
  }

  // loadVolumeCached returns a synchronously-resolved promise on subsequent
  // calls within the same page load, preventing the slider flash on re-init.
  let volumeCache = null;
  function loadVolumeCached() {
    if (volumeCache) return Promise.resolve(volumeCache);
    return loadVolume().then(v => { volumeCache = v; return v; });
  }

  function saveVolume(volume, muted) {
    volumeCache = { volume, muted };
    GM_setValue('ksVolume', JSON.stringify({ volume, muted }));
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

  function getTwitchPlayerContainer() {
    return (
      document.querySelector('[data-a-target="video-player"]') ||
      document.querySelector('.video-player') ||
      document.querySelector('.video-player__container')
    );
  }

  function getTwitchVideo() {
    const c = getTwitchPlayerContainer();
    return c ? c.querySelector('video') : null;
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
      const parsed = JSON.parse(String(raw));
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
          } catch { resolve(null); }
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
    const idx720p60 = levels.findIndex(l => l.height === 720 && fps(l) >= 60);
    if (idx720p60 !== -1) return idx720p60;

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
  function buildGmLoader() {
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
          console.warn(`[KickSwap] GmLoader blocked request to disallowed host: ${parsedUrl.hostname}`);
          callbacks.onError({ code: 0, text: 'GmLoader: host not in allowlist' }, context, null, null);
          return;
        }

        const isSegment = /\.(ts|mp4|m4s)(\?|$)/.test(url);

        // Origin spoofing: GM_xmlhttpRequest bypasses the browser's CORS checks,
        // allowing us to set Origin freely. Kick's CDN requires this header.
        // CORS bypass is an accepted trade-off (see file header); host
        // validation above is the compensating control.
        this._gmRequest = GM_xmlhttpRequest({
          method:       'GET',
          url,
          responseType: isSegment ? 'arraybuffer' : 'text',
          headers:      { 'Origin': 'https://kick.com' },
          timeout:      15000,

          onload: (response) => {
            this._gmRequest = null;
            if (response.status < 200 || response.status >= 300) {
              callbacks.onError({ code: response.status, text: response.statusText }, context, null, response.responseText);
              return;
            }
            const dataSize = isSegment ? response.response.byteLength : response.responseText.length;
            const stats = {
              aborted: false, loaded: dataSize, total: 0,
              retry: 0, chunkCount: 0, bwEstimate: 0,
              loading: { start: 0, first: 0, end: performance.now() },
              parsing: { start: 0, end: 0 },
              buffering: { start: 0, first: 0, end: 0 },
            };
            callbacks.onSuccess(
              { url: response.finalUrl || url, data: isSegment ? response.response : response.responseText },
              stats, context, null
            );
          },
          onerror:   () => { this._gmRequest = null; callbacks.onError({ code: 0, text: 'GM request error' }, context, null, null); },
          ontimeout: () => { this._gmRequest = null; callbacks.onTimeout({ code: 0, text: 'GM request timeout' }, context, null); },
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
  }

  // ─── Player ───────────────────────────────────────────────────────────────
  function destroyKickPlayer() {
    for (const { target, type, fn, capture } of cleanupListeners) {
      try { target.removeEventListener(type, fn, !!capture); } catch {}
    }
    cleanupListeners = [];

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
    // Unmute via the media element first so playback resumes audibly.
    v.muted = false;
    v.play().catch(() => {});
    // Also click Twitch's own mute button if it exists while muted, so their
    // React UI reflects the actual mute state (avoids a "stuck muted" icon).
    if (v.muted) {
      const muteBtn = document.querySelector('[data-a-target="player-mute-unmute-button"]');
      if (muteBtn) try { muteBtn.click(); } catch {}
    }
  }

  // ─── Stream-ended toast ───────────────────────────────────────────────────
  function showStreamEndedToast(playerContainer) {
    if (!playerContainer) return;
    if (document.getElementById('ks-ended-toast')) return;

    const toast = document.createElement('div');
    toast.id = 'ks-ended-toast';
    toast.textContent = 'Kick stream ended — switching back to Twitch';
    playerContainer.appendChild(toast);

    // Style injected once
    if (!document.getElementById('ks-toast-style')) {
      const s = document.createElement('style');
      s.id = 'ks-toast-style';
      s.textContent = `
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
      `;
      document.head.appendChild(s);
    }

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
        overlayVideo.src = safeSrc;
        overlayVideo.play().catch(() => {});
      }
      return;
    }

    hlsInstance = new Hls({ ...HLS_CONFIG, loader: buildGmLoader() });
    hlsInstance.loadSource(hlsUrl);
    hlsInstance.attachMedia(overlayVideo);

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      hookQualityLock();
      overlayVideo.muted  = true;
      overlayVideo.volume = 1;
    });

    const doPlay = () => {
      if (!overlayVideo) return;
      overlayVideo.play().then(() => {
        gestureUnlocked = true;
        isKickActive = true;
        updateUiBadge();
        // Brief auto-show of controls so new users discover them
        autoShowControls();
        removeClickPrompt();
      }).catch(() => {
        showClickPrompt();
      });
    };

    // Large translucent play button — satisfies Firefox's gesture requirement
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

      if (!document.getElementById('ks-click-prompt-style')) {
        const s = document.createElement('style');
        s.id = 'ks-click-prompt-style';
        s.textContent = `
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
        document.head.appendChild(s);
      }
    };

    const removeClickPrompt = () => {
      const p = document.getElementById('ks-click-prompt');
      if (p && p.parentNode) p.parentNode.removeChild(p);
    };

    hlsInstance.once(Hls.Events.BUFFER_APPENDED, () => {
      if (!overlayVideo) return;
      if (overlayVideo.readyState >= 3) {
        if (gestureUnlocked) {
          doPlay();
        } else {
          overlayVideo.play().then(() => {
            gestureUnlocked = true;
            isKickActive = true;
            updateUiBadge();
            autoShowControls();
          }).catch(() => {
            isKickActive = true;
            updateUiBadge();
            showClickPrompt();
          });
        }
      } else {
        overlayVideo.addEventListener('canplay', () => {
          gestureUnlocked ? doPlay() : showClickPrompt();
        }, { once: true });
      }
    });

    // Restore saved volume once the video is genuinely rendering frames.
    // loadVolumeCached is used here so the value is already warm from
    // buildControlBar's earlier call, eliminating the slider-flash on re-init.
    overlayVideo.addEventListener('playing', () => {
      loadVolumeCached().then(({ volume, muted }) => {
        if (!overlayVideo) return;
        overlayVideo.volume = volume;
        overlayVideo.muted  = muted;
        if (syncVolUI) syncVolUI(volume, muted);
      });
    }, { once: true });

    let hasRetried = false;
    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;

      if (!hasRetried) {
        // First fatal error: token may have expired — invalidate the Kick cache
        // entry (using the resolved kick username, not the twitch channel name)
        // and retry after a short delay to avoid thrashing.
        hasRetried = true;
        console.info('[KickSwap] Fatal HLS error — invalidating cache and retrying once.', data.details);
        if (currentKickUser) cacheDelete(currentKickUser);
        setTimeout(() => safeReInit(), RETRY_DELAY_MS);
      } else {
        // Second fatal error: give up gracefully, show the user a toast
        console.warn('[KickSwap] Fatal HLS error on retry — falling back to Twitch.', data);
        const playerContainer = getTwitchPlayerContainer();
        destroyKickPlayer();
        showStreamEndedToast(playerContainer);
      }
    });
  }

  // ─── Control Bar ──────────────────────────────────────────────────────────

  /**
   * Briefly auto-shows the control bar and badge when Kick first activates,
   * so users know the controls exist without requiring a hover.
   */
  function autoShowControls() {
    const bar   = document.getElementById('ks-controls');
    const panel = document.getElementById('ks-ui-panel');
    if (!bar && !panel) return;
    if (bar)   bar.classList.add('ks-visible');
    if (panel) panel.classList.add('ks-visible');
    setTimeout(() => {
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
    playBtn.title     = 'Play / Pause (Space)';
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
    muteBtn.title     = 'Mute / Unmute (M)';
    setIcon(muteBtn, 'volumeHigh');

    // Volume slider
    const volSlider = document.createElement('input');
    volSlider.id    = 'ks-vol-slider';
    volSlider.type  = 'range';
    volSlider.min   = '0';
    volSlider.max   = '1';
    volSlider.step  = '0.02';
    volSlider.value = overlayVideo ? String(overlayVideo.volume) : '1';

    // syncVolUI is stored at module level so startHlsPlayback can call it
    // directly without needing to duck-punch a property onto the video element.
    syncVolUI = (v, m) => {
      setIcon(muteBtn, (m || v === 0) ? 'volumeMute' : v < 0.5 ? 'volumeLow' : 'volumeHigh');
      volSlider.value   = m ? '0' : String(v);
      const pct = (m ? 0 : v) * 100;
      volSlider.style.background = `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,0.3) ${pct}%)`;
    };

    const updateVolUI = () => {
      if (!overlayVideo) return;
      syncVolUI(overlayVideo.volume, overlayVideo.muted);
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
      saveVolume(val, val === 0);
      updateVolUI();
    });

    // Go-Live / sync-to-live-edge button
    const syncBtn = document.createElement('button');
    syncBtn.id        = 'ks-sync-btn';
    syncBtn.className = 'ks-ctrl-btn';
    syncBtn.title     = 'Jump to live edge (L)';
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
    fsBtn.title     = 'Fullscreen (F)';
    setIcon(fsBtn, 'fullscreen');

    fsBtn.addEventListener('click', () => toggleFullscreen());

    const onFsChange = () => {
      setIcon(fsBtn, document.fullscreenElement ? 'exitFullscreen' : 'fullscreen');
    };
    addTrackedListener(document, 'fullscreenchange', onFsChange);

    right.appendChild(fsBtn);

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    // Guard: don't fire when user is typing in any input/textarea (including
    // the Kick username input and Twitch chat).
    // Registered via addTrackedListener so it is removed on destroyKickPlayer,
    // preventing accumulation across channel navigations.
    const HANDLED_KEYS = new Set(['Space', 'KeyM', 'KeyF', 'KeyL']);
    const onKeyDown = (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      if (!overlayVideo) return;
      if (!HANDLED_KEYS.has(e.code)) return;
      // Prevent Twitch's own player from also acting on these keys while the
      // Kick overlay is active (e.g. M unmuting the hidden Twitch video).
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

    // Apply persisted volume to slider immediately on render using the cached
    // value so there is no async flash even on re-init.
    loadVolumeCached().then(({ volume, muted }) => {
      volSlider.value = muted ? '0' : String(volume);
      const pct = (muted ? 0 : volume) * 100;
      volSlider.style.background = `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,0.3) ${pct}%)`;
      setIcon(muteBtn, (muted || volume === 0) ? 'volumeMute' : volume < 0.5 ? 'volumeLow' : 'volumeHigh');
    });

    return bar;
  }

  function toggleFullscreen() {
    const target = overlayContainer || overlayVideo;
    if (!target) return;
    // Prefer the standard Fullscreen API; fall back to the webkit-prefixed
    // variant for older Safari versions that don't support the unprefixed form.
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
    // Store a reference so can detect if Twitch swaps it during an ad.
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
    overlayVideo.autoplay    = true;
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

    const controlBar = buildControlBar();

    overlayContainer.appendChild(overlayVideo);
    overlayContainer.appendChild(controlBar);

    const existingPos = getComputedStyle(playerContainer).position;
    if (existingPos === 'static') playerContainer.style.position = 'relative';

    playerContainer.appendChild(overlayContainer);

    // If the UI panel was mounted on playerContainer before overlay existed,
    // move it inside overlayContainer so hover covers it.
    if (uiPanel && uiPanel.parentNode === playerContainer) {
      overlayContainer.appendChild(uiPanel);
    }

    // JS hover: show/hide controls and badge. Using JS rather than CSS :hover
    // keeps the controls visible while interacting with sliders and buttons.
    const showControls = () => {
      const bar   = document.getElementById('ks-controls');
      const panel = document.getElementById('ks-ui-panel');
      if (bar)   bar.classList.add('ks-visible');
      if (panel) panel.classList.add('ks-visible');
    };
    const hideControls = () => {
      const bar   = document.getElementById('ks-controls');
      const panel = document.getElementById('ks-ui-panel');
      if (bar)   bar.classList.remove('ks-visible');
      if (panel) panel.classList.remove('ks-visible');
    };
    overlayContainer.addEventListener('mouseenter', showControls);
    overlayContainer.addEventListener('mouseleave', hideControls);

    resizeObserver = new ResizeObserver((entries) => {
      // Only update when the container's dimensions have actually changed
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (!overlayContainer) break;
        const cur = overlayContainer.style;
        if (cur.width !== `${width}px` || cur.height !== `${height}px`) {
          overlayContainer.style.width  = '100%';
          overlayContainer.style.height = '100%';
        }
      }
    });
    resizeObserver.observe(playerContainer);

    // ── Theatre / fullscreen mode watchdog ────────────────────────────────
    // Twitch toggles theatre mode by mutating CSS classes on the player wrapper,
    // not by resizing it — ResizeObserver alone misses this. We watch the
    // wrapper's class attribute so we can re-anchor the overlay after the layout
    // shift settles (one rAF is enough for the browser to flush style changes).
    //
    // Note on pushState wrapping: Twitch's own router also wraps pushState.
    // hookNavigation sets __ksWrapped *before* Twitch's app boots (run-at:
    // document-idle fires after DOMContentLoaded but Twitch's React init is
    // async). If Twitch later re-wraps pushState, our wrapper is orphaned.
    // This is a known limitation of SPA hook injection; the popstate listener
    // and MutationObserver on #root serve as reliable fallbacks.
    startTheatreObserver(playerContainer);
  }

  // ─── Theatre mode observer ────────────────────────────────────────────────
  /**
   * Watches for Twitch theatre-mode / fullscreen class changes on the player
   * wrapper. When a change is detected the overlay dimensions are re-anchored
   * after one animation frame, by which point the browser has flushed the new
   * layout. This covers the case ResizeObserver misses (class-driven layout
   * shifts that don't immediately change the element's reported size).
   */
  function startTheatreObserver(playerContainer) {
    if (theatreObserver) { theatreObserver.disconnect(); theatreObserver = null; }

    // Walk up from the player container to find the nearest ancestor that
    // carries Twitch's theatre/fullscreen class — typically a wrapper a few
    // levels up with a class like `theatre-mode` or `video-player--theatre`.
    // We observe the container itself as a safe fallback if no such ancestor
    // is found within a reasonable depth.
    let watchTarget = playerContainer;
    let el = playerContainer.parentElement;
    for (let i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
      const cls = el.className || '';
      if (/theatre|theater|fullscreen/i.test(cls)) { watchTarget = el; break; }
    }

    theatreObserver = new MutationObserver(() => {
      if (!overlayContainer) return;
      requestAnimationFrame(() => {
        // Re-anchor to 100% in case the layout shift moved the container
        overlayContainer.style.width  = '100%';
        overlayContainer.style.height = '100%';
      });
    });

    theatreObserver.observe(watchTarget, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  // ─── Ad-swap guard ────────────────────────────────────────────────────────
  /**
   * Twitch injects ads by replacing the <video> element inside the player
   * container. getTwitchVideo() would still return a video element in that
   * case — just the wrong (ad) one — causing restoreTwitchVideo to target it
   * incorrectly. The watchdog's childList observer fires when this happens;
   * here we compare the current video element against the one we recorded at
   * overlay mount time and re-hide any new element so it doesn't bleed through.
   */
  function handlePossibleAdSwap(playerContainer) {
    const currentVideo = getTwitchVideo();
    if (!currentVideo) return;

    if (currentVideo !== knownTwitchVideo) {
      // Twitch swapped the video element (ad injection or player remount).
      // Hide and mute the new element so it doesn't bleed through the overlay,
      // then update our reference so future calls compare against the right one.
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

    // Inject all styles once; guard against duplicate injection on re-init
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
      `;
      document.head.appendChild(style);
    }

    uiPanel = document.createElement('div');
    uiPanel.id = 'ks-ui-panel';

    // Build all child elements programmatically — no innerHTML anywhere in this
    // file, so there is no innerHTML pattern that future changes could
    // accidentally make dynamic.
    const badge = document.createElement('div');
    badge.id = 'ks-badge';
    const badgeDot = document.createElement('span');
    badgeDot.id = 'ks-badge-dot';
    const badgeLabel = document.createElement('span');
    badgeLabel.id = 'ks-badge-label';
    badgeLabel.textContent = 'TWITCH';
    badge.appendChild(badgeDot);
    badge.appendChild(badgeLabel);

    // Session toggle: both states are phrased as actions ("Use Twitch" /
    // "Use Kick") so the label always describes what clicking will do, not the
    // current state. Initial state = Kick active (or will be), so first label
    // is "Use Twitch".
    const twitchBtnEl = document.createElement('div');
    twitchBtnEl.id    = 'ks-twitch-btn';
    twitchBtnEl.title = 'Temporarily use Twitch for this session (does not remove your mapping)';
    twitchBtnEl.textContent = 'Use Twitch';

    const editBtnEl = document.createElement('div');
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
    saveBtn.textContent = 'Save';

    const clearBtn = document.createElement('button');
    clearBtn.id          = 'ks-clear-btn';
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

    // "Use Twitch" / "Use Kick" session toggle — disables the swap for this
    // session without touching persistent mappings.
    twitchBtnEl.addEventListener('click', () => {
      disabledForSession = !disabledForSession;
      // Label always describes the action clicking will perform next.
      twitchBtnEl.textContent = disabledForSession ? 'Use Kick' : 'Use Twitch';
      twitchBtnEl.title       = disabledForSession
        ? 'Switch back to Kick stream'
        : 'Temporarily use Twitch for this session (does not remove your mapping)';
      twitchBtnEl.classList.toggle('ks-disabled-session', disabledForSession);
      if (disabledForSession) {
        destroyKickPlayer();
      } else {
        safeReInit();
      }
    });

    editBtnEl.addEventListener('click', async () => {
      const isHidden = editForm.style.display === 'none';
      editForm.style.display = isHidden ? 'flex' : 'none';
      if (isHidden) {
        // Pre-populate with the current mapping so users can make small edits
        const mappings = await loadMappings();
        usernameInput.value = (currentChannel && mappings[currentChannel]) ? mappings[currentChannel] : '';
        usernameInput.focus();
      }
    });

    saveBtn.addEventListener('click', async () => {
      const raw   = usernameInput.value;
      const clean = sanitiseUsername(raw);
      if (!clean || !currentChannel) return;

      // Visual confirmation before re-init
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
  /**
   * Shows a subtle dismissible badge when no live Kick stream is found,
   * so users understand why the swap didn't happen. Auto-dismisses after 6 s.
   */
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

    if (!document.getElementById('ks-offline-badge-style')) {
      const s = document.createElement('style');
      s.id = 'ks-offline-badge-style';
      s.textContent = `
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
      `;
      document.head.appendChild(s);
    }

    setTimeout(dismiss, 6000);
  }

  // ─── Periodic live-status check ───────────────────────────────────────────
  /**
   * Polls the Kick API every LIVE_CHECK_INTERVAL_MS while the overlay is active.
   * Detects when a streamer ends their stream cleanly (no HLS error fired),
   * tears down the overlay, and shows the stream-ended toast.
   *
   * Cache behaviour: we deliberately do NOT call cacheDelete before fetching.
   * The cache TTL equals the poll interval (both 5 min), so by the time each
   * scheduled check runs the previous entry will have expired naturally —
   * fetchKickHlsUrl will always make a fresh API call. Calling cacheDelete
   * proactively would race with other code paths that legitimately re-use the
   * cached URL (e.g. a simultaneous safeReInit), so we rely on TTL expiry instead.
   */
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
    // Prevent concurrent invocations. waitForPlayer and visibilitychange can
    // both fire within milliseconds of each other (e.g. tab restored while the
    // Twitch player is also mounting), and a double call to mountOverlay would
    // produce a stacked overlay. safeReInit has its own guard; this one covers
    // direct callers (clearBtn, saveBtn, visibility recheck).
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

    // If the user has toggled "Use Twitch" for this session, do nothing.
    if (disabledForSession) return;

    const playerContainer = getTwitchPlayerContainer();
    const twitchVideo     = getTwitchVideo();
    if (!playerContainer || !twitchVideo) return;

    if (!uiPanel) mountUiPanel(playerContainer);

    const mappings = await loadMappings();
    // Guard: abort if the user navigated away while we were awaiting storage.
    if (getTwitchChannel() !== channel) return;

    const kickUsername = mappings[channel] || channel;
    // Expose resolved kick username so the retry path deletes the right cache key
    currentKickUser = kickUsername;

    // Show a "checking" state in the badge while the API call is in-flight,
    // so users get visual feedback that the script is running.
    updateUiBadge('checking');

    const hlsUrl = await fetchKickHlsUrl(kickUsername);
    // Guard: abort if the user navigated away while the API call was in-flight.
    if (getTwitchChannel() !== channel) return;

    if (!hlsUrl) {
      updateUiBadge(); // revert to TWITCH
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
  // Backstop: if reInitGuard gets stuck (e.g. unexpected throw), auto-clear
  // after 15 s so the script doesn't freeze permanently.
  let reInitGuardTimer = null;

  async function safeReInit() {
    if (reInitGuard) return;
    reInitGuard = true;
    // Reset the backstop timer on every entry so rapid sequential calls
    // (e.g. watchdog + visibility recheck firing within ms of each other)
    // don't push the clear arbitrarily far into the future.
    clearTimeout(reInitGuardTimer);
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

      // Check for ad-driven video element swaps even when the overlay is still
      // present. Twitch may replace the underlying <video> without removing the
      // overlay container — the overlay stays visible but restoreTwitchVideo
      // would target the wrong element. handlePossibleAdSwap compares against
      // the reference we captured at mount time and re-hides any new element.
      if (isKickActive) {
        for (const m of mutations) {
          if (m.addedNodes.length > 0) { handlePossibleAdSwap(playerContainer); break; }
        }
      }
    });

    watchdogObserver.observe(playerContainer, { childList: true, subtree: true });
  }

  async function onNavigate() {
    const newChannel = getTwitchChannel();
    if (newChannel === currentChannel) return;
    if (watchdogObserver) { watchdogObserver.disconnect(); watchdogObserver = null; }
    if (theatreObserver)  { theatreObserver.disconnect();  theatreObserver  = null; }
    destroyKickPlayer();
    destroyUiPanel();
    currentKickUser    = null;
    disabledForSession = false; // reset per-channel session toggle on navigation
    waitForPlayer();
  }

  function waitForPlayer() {
    if (getTwitchVideo()) { initKickSwap(); return; }

    if (playerObserver) { playerObserver.disconnect(); playerObserver = null; }

    // Observe the narrowest reliable ancestor rather than the full document body
    const root = document.getElementById('root') || document.body;
    playerObserver = new MutationObserver((_, obs) => {
      if (getTwitchVideo()) { obs.disconnect(); playerObserver = null; initKickSwap(); }
    });
    playerObserver.observe(root, { childList: true, subtree: true });
  }

  function hookNavigation() {
    // Wrap history methods to detect SPA navigations.
    // mark wrapper with a sentinel so we can detect a double-wrap and
    // avoid lost events. Note: if Twitch's own router re-wraps pushState after
    // wrapper is in place, wrapper becomes orphaned — this is a known
    // limitation of SPA hook injection. The popstate listener and the
    // MutationObserver on #root in waitForPlayer serve as reliable fallbacks
    // that cover navigations our pushState wrapper might miss.
    if (!history.pushState.__ksWrapped) {
      const _origPushState = history.pushState.bind(history);
      history.pushState = function (...args) {
        _origPushState(...args);
        onNavigate();
      };
      history.pushState.__ksWrapped = true;
    }

    if (!history.replaceState.__ksWrapped) {
      const _origReplaceState = history.replaceState.bind(history);
      history.replaceState = function (...args) {
        _origReplaceState(...args);
        onNavigate();
      };
      history.replaceState.__ksWrapped = true;
    }

    window.addEventListener('popstate', onNavigate);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!currentChannel) return;

      const overlayPresent = !!document.getElementById('ks-overlay-container');

      if (isKickActive && !overlayPresent) {
        console.info('[KickSwap] Tab became visible — overlay missing, re-initialising.');
        safeReInit();
        return;
      }

      // Stream was offline when page loaded — recheck on tab focus,
      // but throttle to avoid hammering the API on rapid tab switching.
      if (!isKickActive && !disabledForSession && getTwitchChannel() === currentChannel) {
        const now = Date.now();
        if (now - lastVisibilityRecheck < VISIBILITY_RECHECK_COOLDOWN) return;
        lastVisibilityRecheck = now;
        if (currentKickUser) cacheDelete(currentKickUser);
        initKickSwap();
      }
    });
  }

  function bootstrap() {
    hookNavigation();
    waitForPlayer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  } // end main()

})();
