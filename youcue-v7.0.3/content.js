(() => {
  const DEFAULTS = {
    enabled: true,
    bpm: 120,
    division: "1/16",
    holdThresholdMs: 180,
    dimFlash: true,
    oneShotMode: true,
    fadeOut: true,
    fadeOutMs: 20,
    repeatScale: 1,
    youtubeAutoCues: true,
    blockYouTubeShortcuts: false
  };

  const AUTOSAVE_META_PREFIX = "youcueVideoMeta:";
  const BOOKMARKS_KEY = "youcueBookmarks";
  const AUTO_PRUNE_TRIGGER_RATIO = 0.80;
  const AUTO_PRUNE_TARGET_RATIO = 0.60;
  const AUTO_PRUNE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

  let lastAutosavePruneCheckAt = 0;

  const CUE_MOVE_RATE = 0.25;
  const DIM_BRIGHTNESS = 0.5;
  const DIM_MS = 25;

  // Dedicated normal-loop edge smoothing. This is intentionally separate
  // from the user-selectable note-repeat fade setting.
  const LOOP_EDGE_FADE_OUT_MS = 10;
  const LOOP_EDGE_FADE_IN_MS = 10;

  const activeCueKeys = new Map();
  const movementKeysDown = new Set();
  const heldKeys = new Set();

  let settings = { ...DEFAULTS };
  let lastPressedCue = null;
  let detachedEdit = null;
  let tapTimes = [];

  let performanceRecordingState = {
    active: false,
    processing: false,
    startedAt: 0,
    timerId: null
  };

  let exportPlaybackState = null;

  let loopState = {
    videoId: null,
    inPoint: null,
    outPoint: null,
    enabled: false,
    armed: false
  };

  let loopBoundaryEdit = {
    boundary: null,       // "in" | "out"
    repeatActive: false,
    repeatTimerId: null,
    lastRepeatAt: null,
    nextRepeatAt: null,
    moveDirection: 0,
    moveRafId: null,
    moveLastTs: null,
    dirty: false
  };

  let loopPlayback = {
    boundaryTimerId: null,
    scheduledOutPoint: null,
    transitioning: false,
    fadeTimerId: null,
    fadeToken: 0,
    originalVolume: null
  };


  chrome.storage.local.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    loadLoopState(getVideoId());
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) settings[key] = changes[key].newValue;
    }

    if (changes.enabled && !changes.enabled.newValue) {
      cancelAllInteractions();
    }
  });

  function getVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function getVideoId() {
    const url = new URL(location.href);
    return url.searchParams.get("v");
  }

  function autosaveMetaKey(videoId) {
    return `${AUTOSAVE_META_PREFIX}${videoId}`;
  }

  function storageItemApproxBytes(key, value) {
    try {
      return key.length + JSON.stringify(value).length;
    } catch {
      return key.length;
    }
  }

  function autosaveVideoIdFromKey(key) {
    const prefixes = ["youtubeCues:", "youtubeLoop:", AUTOSAVE_META_PREFIX];

    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) return key.slice(prefix.length);
    }

    return null;
  }

  async function maybeAutoPruneAutosaves(currentVideoId) {
    const now = Date.now();

    if (now - lastAutosavePruneCheckAt < AUTO_PRUNE_CHECK_INTERVAL_MS) {
      return;
    }

    lastAutosavePruneCheckAt = now;

    const quota =
      Number(chrome.storage.local.QUOTA_BYTES) || 10 * 1024 * 1024;
    const currentBytes = await chrome.storage.local.getBytesInUse(null);

    if (currentBytes < quota * AUTO_PRUNE_TRIGGER_RATIO) return;

    const all = await chrome.storage.local.get(null);
    const bookmarks = Array.isArray(all[BOOKMARKS_KEY])
      ? all[BOOKMARKS_KEY]
      : [];

    const protectedVideoIds = new Set(
      bookmarks.map((bookmark) => bookmark?.videoId).filter(Boolean)
    );

    if (currentVideoId) protectedVideoIds.add(currentVideoId);

    const videoEntries = new Map();

    for (const [key, value] of Object.entries(all)) {
      const videoId = autosaveVideoIdFromKey(key);
      if (!videoId) continue;

      if (!videoEntries.has(videoId)) {
        videoEntries.set(videoId, {
          videoId,
          updatedAt: 0,
          keys: [],
          bytes: 0
        });
      }

      const entry = videoEntries.get(videoId);
      entry.keys.push(key);
      entry.bytes += storageItemApproxBytes(key, value);

      if (key.startsWith(AUTOSAVE_META_PREFIX)) {
        entry.updatedAt = Number(value?.updatedAt) || 0;
      }
    }

    const candidates = [...videoEntries.values()]
      .filter((entry) => !protectedVideoIds.has(entry.videoId))
      .sort((a, b) => a.updatedAt - b.updatedAt);

    const bytesToFree = Math.max(
      0,
      currentBytes - quota * AUTO_PRUNE_TARGET_RATIO
    );

    let estimatedFreed = 0;
    const keysToRemove = [];

    for (const entry of candidates) {
      if (estimatedFreed >= bytesToFree) break;
      keysToRemove.push(...entry.keys);
      estimatedFreed += entry.bytes;
    }

    if (keysToRemove.length) {
      await chrome.storage.local.remove(keysToRemove);
    }
  }

  async function touchAutosaveVideo(videoId) {
    if (!videoId) return;

    await chrome.storage.local.set({
      [autosaveMetaKey(videoId)]: {
        updatedAt: Date.now()
      }
    });

    // Storage is tiny in normal use. This check is throttled and only starts
    // deleting old, unbookmarked autosaves if total extension storage exceeds
    // 80% of Chrome's local quota. It trims toward 60%.
    maybeAutoPruneAutosaves(videoId).catch(() => {});
  }

  const YOUCUE_MARKER_HOST_ID = "youcue-timeline-markers";
  const YOUCUE_MARKER_STYLE_ID = "youcue-timeline-marker-style";

  let markerRenderTimer = null;

  function ensureTimelineMarkerStyle() {
    if (document.getElementById(YOUCUE_MARKER_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = YOUCUE_MARKER_STYLE_ID;
    style.textContent = `
      #${YOUCUE_MARKER_HOST_ID} {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 1px;
        pointer-events: none;
        z-index: 45;
        overflow: visible;
      }

      #${YOUCUE_MARKER_HOST_ID} .youcue-marker {
        position: absolute;
        width: 15px;
        height: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        transform: translateX(-50%);
        border: 1.5px solid rgba(255,255,255,.98);
        border-radius: 999px;
        background: rgba(12,12,14,.94);
        color: #fff;
        font: 700 8px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 1px 3px rgba(0,0,0,.55);
        box-sizing: border-box;
      }

      #${YOUCUE_MARKER_HOST_ID} .youcue-marker--cue {
        top: -19px;
      }

      #${YOUCUE_MARKER_HOST_ID} .youcue-marker--loop {
        top: -36px;
        width: 16px;
        height: 16px;
        font-size: 9px;
        border-width: 2px;
      }
    `;

    document.documentElement.appendChild(style);
  }

  function getTimelineMarkerParent() {
    return (
      document.querySelector(".ytp-progress-bar-container") ||
      document.querySelector(".ytp-progress-bar")
    );
  }

  function ensureTimelineMarkerHost() {
    ensureTimelineMarkerStyle();

    const parent = getTimelineMarkerParent();
    if (!parent) return null;

    let host = document.getElementById(YOUCUE_MARKER_HOST_ID);

    if (!host || host.parentElement !== parent) {
      if (host) host.remove();

      host = document.createElement("div");
      host.id = YOUCUE_MARKER_HOST_ID;
      host.setAttribute("aria-hidden", "true");
      parent.appendChild(host);
    }

    return host;
  }

  function createTimelineMarker(host, time, duration, label, type) {
    if (
      !host ||
      typeof time !== "number" ||
      !Number.isFinite(time) ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      return;
    }

    const marker = document.createElement("div");
    marker.className = `youcue-marker youcue-marker--${type}`;

    const percent = Math.max(0, Math.min(100, (time / duration) * 100));

    marker.style.left = `${percent}%`;
    marker.textContent = label;
    marker.title = `${label} · ${formatTime(time)}`;

    host.appendChild(marker);
  }

  async function renderTimelineMarkers() {
    const video = getVideo();
    const videoId = getVideoId();
    const host = ensureTimelineMarkerHost();

    if (!host) return;

    host.replaceChildren();

    if (
      !settings.enabled ||
      !video ||
      !videoId ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    ) {
      return;
    }

    const cues = await loadCues(videoId);

    for (let cueNumber = 1; cueNumber <= 10; cueNumber++) {
      const cueTime = cues[String(cueNumber)];
      if (typeof cueTime !== "number") continue;

      createTimelineMarker(
        host,
        cueTime,
        video.duration,
        cueNumber === 10 ? "0" : String(cueNumber),
        "cue"
      );
    }

    if (loopState.videoId !== videoId) {
      await loadLoopState(videoId);
    }

    if (typeof loopState.inPoint === "number") {
      createTimelineMarker(
        host,
        loopState.inPoint,
        video.duration,
        "I",
        "loop"
      );
    }

    if (typeof loopState.outPoint === "number") {
      createTimelineMarker(
        host,
        loopState.outPoint,
        video.duration,
        "O",
        "loop"
      );
    }
  }

  function scheduleTimelineMarkerRender(delay = 40) {
    if (markerRenderTimer) clearTimeout(markerRenderTimer);

    markerRenderTimer = window.setTimeout(() => {
      markerRenderTimer = null;
      renderTimelineMarkers().catch(() => {});
    }, delay);
  }

  function cueStorageKey(videoId) {
    return `youtubeCues:${videoId}`;
  }

  async function loadCues(videoId) {
    const key = cueStorageKey(videoId);
    const result = await chrome.storage.local.get(key);
    return result[key] || {};
  }

  async function writeCue(videoId, cueNumber, time) {
    const key = cueStorageKey(videoId);
    const cues = await loadCues(videoId);
    const cleanTime = Math.max(0, time);

    cues[String(cueNumber)] = cleanTime;
    await chrome.storage.local.set({ [key]: cues });
    await touchAutosaveVideo(videoId);
    scheduleTimelineMarkerRender();

    if (
      lastPressedCue &&
      lastPressedCue.videoId === videoId &&
      lastPressedCue.cueNumber === cueNumber
    ) {
      lastPressedCue.cueTime = cleanTime;
    }
  }

  async function saveCue(videoId, cueNumber, time) {
    await writeCue(videoId, cueNumber, time);
    flash(`Cue ${cueNumber} set · ${formatTime(time)}`);
  }


  function recordPerformanceEvent(type, label, extra = {}) {
    if (!performanceRecordingState.active) return;

    chrome.runtime.sendMessage({
      type: "YOUCUE_PERFORMANCE_EVENT",
      event: {
        type,
        label,
        wallMs: Date.now(),
        videoId: getVideoId(),
        ...extra
      }
    }).catch(() => {});
  }

  function ensureRecordingOverlay() {
    let overlay = document.getElementById("youcue-recording-overlay");

    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "youcue-recording-overlay";

    Object.assign(overlay.style, {
      position: "fixed",
      right: "18px",
      top: "76px",
      zIndex: "2147483647",
      display: "none",
      alignItems: "center",
      gap: "9px",
      padding: "8px 10px",
      borderRadius: "10px",
      background: "rgba(18,18,20,.94)",
      border: "1px solid rgba(255,255,255,.18)",
      color: "#fff",
      font: "600 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      boxShadow: "0 3px 14px rgba(0,0,0,.35)"
    });

    const dot = document.createElement("span");
    dot.textContent = "●";
    dot.style.color = "#ef4444";
    dot.style.fontSize = "13px";

    const time = document.createElement("span");
    time.id = "youcue-recording-time";
    time.textContent = "REC 00:00";

    const stop = document.createElement("button");
    stop.id = "youcue-recording-stop";
    stop.type = "button";
    stop.textContent = "STOP";

    Object.assign(stop.style, {
      border: "1px solid rgba(255,255,255,.25)",
      borderRadius: "7px",
      padding: "4px 7px",
      background: "#ef4444",
      color: "#fff",
      cursor: "pointer",
      font: "700 10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
    });

    stop.addEventListener("click", () => {
      stop.disabled = true;
      stop.textContent = "STOPPING…";

      chrome.runtime.sendMessage({
        type: "YOUCUE_RECORD_STOP_REQUEST"
      }).catch(() => {
        stop.disabled = false;
        stop.textContent = "STOP";
      });
    });

    overlay.append(dot, time, stop);
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function formatRecordingElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function showRecordingOverlay(startedAt) {
    const overlay = ensureRecordingOverlay();
    const time = overlay.querySelector("#youcue-recording-time");
    const stop = overlay.querySelector("#youcue-recording-stop");

    performanceRecordingState.active = true;
    performanceRecordingState.processing = false;
    performanceRecordingState.startedAt = startedAt || Date.now();

    if (stop) {
      stop.disabled = false;
      stop.textContent = "STOP";
    }

    overlay.style.display = "flex";

    if (performanceRecordingState.timerId) {
      clearInterval(performanceRecordingState.timerId);
    }

    const update = () => {
      if (!time) return;

      if (performanceRecordingState.processing) {
        time.textContent = "PROCESSING MP3…";
        return;
      }

      time.textContent =
        `REC ${formatRecordingElapsed(
          Date.now() - performanceRecordingState.startedAt
        )}`;
    };

    update();
    performanceRecordingState.timerId =
      window.setInterval(update, 250);
  }

  function setRecordingOverlayProcessing() {
    performanceRecordingState.processing = true;

    const stop =
      document.getElementById("youcue-recording-stop");

    if (stop) {
      stop.disabled = true;
      stop.textContent = "WAIT";
    }
  }

  function hideRecordingOverlay(message = null) {
    performanceRecordingState.active = false;
    performanceRecordingState.processing = false;

    if (performanceRecordingState.timerId) {
      clearInterval(performanceRecordingState.timerId);
    }

    performanceRecordingState.timerId = null;

    const overlay =
      document.getElementById("youcue-recording-overlay");

    if (overlay) overlay.style.display = "none";

    if (message) flash(message);
  }

  function waitForVideoEvent(video, eventName, timeoutMs = 5000) {
    return new Promise((resolve) => {
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const cleanup = () => {
        video.removeEventListener(eventName, finish);
        clearTimeout(timerId);
      };

      const timerId = window.setTimeout(finish, timeoutMs);
      video.addEventListener(eventName, finish, { once: true });
    });
  }

  async function prepareExportPlayback(startTime) {
    const video = getVideo();
    if (!video) throw new Error("No YouTube video found");

    if (!exportPlaybackState) {
      await ensureLoopStateForCurrentVideo();

      exportPlaybackState = {
        time: video.currentTime,
        paused: video.paused,
        playbackRate: video.playbackRate,
        loopEnabled: loopState.enabled,
        loopArmed: loopState.armed
      };
    }

    cancelAllInteractions();

    // Prevent a saved YouCue loop from fighting the export transport.
    loopState.armed = false;
    cancelLoopEdgeTransition(true);

    video.pause();
    video.playbackRate = 1;

    const target = Math.max(
      0,
      Math.min(
        Number.isFinite(video.duration) ? video.duration : startTime,
        Number(startTime) || 0
      )
    );

    if (Math.abs(video.currentTime - target) > 0.01) {
      video.currentTime = target;
      await waitForVideoEvent(video, "seeked", 5000);
    }

    if (video.readyState < 3) {
      await waitForVideoEvent(video, "canplay", 5000);
    }

    return {
      ok: true,
      currentTime: video.currentTime
    };
  }

  async function restoreAfterExport() {
    const video = getVideo();

    if (!video || !exportPlaybackState) {
      exportPlaybackState = null;
      return;
    }

    const state = exportPlaybackState;
    exportPlaybackState = null;

    video.pause();
    video.playbackRate = state.playbackRate;

    if (Number.isFinite(state.time)) {
      video.currentTime = state.time;
    }

    loopState.enabled = state.loopEnabled;
    loopState.armed = state.loopArmed;

    if (!state.paused) {
      video.play().catch(() => {});
    }

    if (loopState.enabled && loopState.armed) {
      scheduleLoopBoundary();
    }
  }

  function loopStorageKey(videoId) {
    return `youtubeLoop:${videoId}`;
  }

  async function loadLoopState(videoId) {
    if (!videoId) {
      loopState = {
        videoId: null,
        inPoint: null,
        outPoint: null,
        enabled: false,
        armed: false
      };
      return;
    }

    const key = loopStorageKey(videoId);
    const result = await chrome.storage.local.get(key);
    const stored = result[key] || {};

    loopState = {
      videoId,
      inPoint: typeof stored.inPoint === "number" ? stored.inPoint : null,
      outPoint: typeof stored.outPoint === "number" ? stored.outPoint : null,
      enabled: Boolean(stored.enabled),
      armed: false
    };

    const video = getVideo();
    if (
      video &&
      loopState.enabled &&
      loopState.inPoint !== null &&
      loopState.outPoint !== null &&
      video.currentTime >= loopState.inPoint &&
      video.currentTime < loopState.outPoint
    ) {
      loopState.armed = true;
    }

    scheduleTimelineMarkerRender();
  }

  async function saveLoopState() {
    if (!loopState.videoId) return;

    const key = loopStorageKey(loopState.videoId);
    await chrome.storage.local.set({
      [key]: {
        inPoint: loopState.inPoint,
        outPoint: loopState.outPoint,
        enabled: loopState.enabled
      }
    });

    await touchAutosaveVideo(loopState.videoId);
    scheduleTimelineMarkerRender();
  }

  async function ensureLoopStateForCurrentVideo() {
    const videoId = getVideoId();
    if (!videoId) return false;

    if (loopState.videoId !== videoId) {
      await loadLoopState(videoId);
    }

    return true;
  }

  async function setInPoint() {
    const video = getVideo();
    const videoId = getVideoId();
    if (!video || !videoId) return;

    await ensureLoopStateForCurrentVideo();

    loopState.inPoint = video.currentTime;

    if (
      loopState.outPoint !== null &&
      loopState.outPoint <= loopState.inPoint
    ) {
      loopState.outPoint = null;
      loopState.enabled = false;
      loopState.armed = false;
    }

    await saveLoopState();
    flash(`IN · ${formatTime(loopState.inPoint)}`);
  }

  async function setOutPoint() {
    const video = getVideo();
    const videoId = getVideoId();
    if (!video || !videoId) return;

    await ensureLoopStateForCurrentVideo();

    if (loopState.inPoint === null) {
      flash("Set IN first");
      return;
    }

    if (video.currentTime <= loopState.inPoint) {
      flash("OUT must be after IN");
      return;
    }

    loopState.outPoint = video.currentTime;

    // Setting OUT completes the loop and starts it immediately.
    loopState.enabled = true;
    loopState.armed = true;

    await saveLoopState();

    video.currentTime = loopState.inPoint;
    video.play().catch(() => {});
    scheduleLoopBoundary();

    recordPerformanceEvent(
      "loop",
      "Loop I-O",
      {
        inPoint: loopState.inPoint,
        outPoint: loopState.outPoint
      }
    );

    flash(
      `Loop ON · ${formatTime(loopState.inPoint)} → ${formatTime(loopState.outPoint)}`
    );
  }

  async function toggleLoop() {
    const video = getVideo();
    if (!video || !(await ensureLoopStateForCurrentVideo())) return;

    if (!loopState.enabled) {
      if (
        loopState.inPoint === null ||
        loopState.outPoint === null ||
        loopState.outPoint <= loopState.inPoint
      ) {
        flash("Set IN and OUT first");
        return;
      }

      loopState.enabled = true;
      loopState.armed = true;
      video.currentTime = loopState.inPoint;
      video.play().catch(() => {});
      scheduleLoopBoundary();
      await saveLoopState();

      recordPerformanceEvent(
        "loop",
        "Loop I-O",
        {
          inPoint: loopState.inPoint,
          outPoint: loopState.outPoint
        }
      );

      flash("Loop ON");
      return;
    }

    loopState.enabled = false;
    loopState.armed = false;
    cancelLoopEdgeTransition(true);
    await saveLoopState();

    recordPerformanceEvent(
      "boundary",
      "Loop off"
    );

    flash("Loop OFF");
  }

  function disarmLoopForCueJump() {
    if (loopState.enabled) {
      loopState.armed = false;
      cancelLoopEdgeTransition(true);
    }
  }

  function cancelLoopBoundarySchedule() {
    if (loopPlayback.boundaryTimerId) {
      clearTimeout(loopPlayback.boundaryTimerId);
    }

    loopPlayback.boundaryTimerId = null;
    loopPlayback.scheduledOutPoint = null;
  }

  function cancelLoopEdgeTransition(restoreVolume = true) {
    cancelLoopBoundarySchedule();

    loopPlayback.fadeToken += 1;

    if (loopPlayback.fadeTimerId) {
      clearTimeout(loopPlayback.fadeTimerId);
    }

    loopPlayback.fadeTimerId = null;
    loopPlayback.transitioning = false;

    const video = getVideo();

    if (
      restoreVolume &&
      video &&
      typeof loopPlayback.originalVolume === "number"
    ) {
      video.volume = loopPlayback.originalVolume;
    }

    loopPlayback.originalVolume = null;
  }

  function fadeLoopVolume(video, from, to, durationMs, token, onComplete) {
    if (!video) return;

    const startedAt = performance.now();
    video.volume = Math.max(0, Math.min(1, from));

    const step = () => {
      if (token !== loopPlayback.fadeToken) return;

      const elapsed = performance.now() - startedAt;
      const progress = Math.min(1, elapsed / Math.max(1, durationMs));
      const value = from + (to - from) * progress;

      video.volume = Math.max(0, Math.min(1, value));

      if (progress >= 1) {
        loopPlayback.fadeTimerId = null;
        if (typeof onComplete === "function") onComplete();
        return;
      }

      // A short stepped fade is more useful here than requestAnimationFrame:
      // a 10 ms audio edge can otherwise fit inside a single display frame.
      loopPlayback.fadeTimerId = window.setTimeout(step, 2);
    };

    step();
  }

  function smoothLoopRetrigger(video) {
    if (
      !video ||
      loopPlayback.transitioning ||
      !settings.enabled ||
      !loopState.enabled ||
      !loopState.armed ||
      loopState.inPoint === null ||
      loopState.outPoint === null
    ) {
      return;
    }

    cancelLoopBoundarySchedule();
    loopPlayback.transitioning = true;

    // Cancel any note-repeat volume automation before taking ownership of
    // the media volume for the loop edge.
    restoreVideoVolume(video);

    const originalVolume = video.volume;
    const token = ++loopPlayback.fadeToken;
    loopPlayback.originalVolume = originalVolume;

    fadeLoopVolume(
      video,
      originalVolume,
      0,
      LOOP_EDGE_FADE_OUT_MS,
      token,
      () => {
        if (
          token !== loopPlayback.fadeToken ||
          !loopState.enabled ||
          !loopState.armed ||
          loopState.inPoint === null
        ) {
          video.volume = originalVolume;
          loopPlayback.transitioning = false;
          loopPlayback.originalVolume = null;
          return;
        }

        // Seek only after the outgoing waveform has reached silence.
        video.currentTime = loopState.inPoint;
        video.play().catch(() => {});

        fadeLoopVolume(
          video,
          0,
          originalVolume,
          LOOP_EDGE_FADE_IN_MS,
          token,
          () => {
            if (token !== loopPlayback.fadeToken) return;

            video.volume = originalVolume;
            loopPlayback.transitioning = false;
            loopPlayback.originalVolume = null;

            // Schedule the next loop edge from the newly-entered IN point.
            scheduleLoopBoundary();
          }
        );
      }
    );
  }

  function scheduleLoopBoundary() {
    cancelLoopBoundarySchedule();

    if (
      loopPlayback.transitioning ||
      !settings.enabled ||
      !loopState.enabled ||
      !loopState.armed ||
      loopState.inPoint === null ||
      loopState.outPoint === null
    ) {
      return;
    }

    const video = getVideo();
    const videoId = getVideoId();

    if (
      !video ||
      !videoId ||
      loopState.videoId !== videoId ||
      video.paused
    ) {
      return;
    }

    const playbackRate = Math.max(0.01, Number(video.playbackRate) || 1);
    const secondsRemaining = loopState.outPoint - video.currentTime;

    if (secondsRemaining <= 0) {
      smoothLoopRetrigger(video);
      return;
    }

    // Begin the fade so it reaches zero at approximately the requested OUT.
    const delayMs = Math.max(
      0,
      (secondsRemaining / playbackRate) * 1000 - LOOP_EDGE_FADE_OUT_MS
    );

    loopPlayback.scheduledOutPoint = loopState.outPoint;
    loopPlayback.boundaryTimerId = window.setTimeout(() => {
      loopPlayback.boundaryTimerId = null;
      loopPlayback.scheduledOutPoint = null;
      smoothLoopRetrigger(video);
    }, delayMs);
  }

  function maintainLoopBoundary() {
    if (
      !settings.enabled ||
      !loopState.enabled ||
      !loopState.armed ||
      loopState.inPoint === null ||
      loopState.outPoint === null
    ) {
      cancelLoopBoundarySchedule();
      return;
    }

    const video = getVideo();
    const videoId = getVideoId();
    if (!video || !videoId || loopState.videoId !== videoId) return;

    if (video.paused) {
      cancelLoopBoundarySchedule();
      return;
    }

    if (loopPlayback.transitioning) return;

    // OUT may have been moved while a timer was already scheduled.
    if (
      loopPlayback.boundaryTimerId &&
      loopPlayback.scheduledOutPoint !== loopState.outPoint
    ) {
      scheduleLoopBoundary();
      return;
    }

    if (!loopPlayback.boundaryTimerId) {
      scheduleLoopBoundary();
    }
  }

  function loopBoundaryTime(boundary) {
    return boundary === "in" ? loopState.inPoint : loopState.outPoint;
  }

  function setLoopBoundaryTime(boundary, value) {
    const video = getVideo();
    const maxTime =
      video && Number.isFinite(video.duration) ? video.duration : Infinity;

    if (boundary === "in") {
      const maxIn =
        loopState.outPoint !== null
          ? Math.max(0, loopState.outPoint - 0.001)
          : maxTime;

      loopState.inPoint = Math.max(0, Math.min(maxIn, value));
    } else {
      if (loopState.inPoint === null) return;

      const minOut = loopState.inPoint + 0.001;
      loopState.outPoint = Math.max(minOut, Math.min(maxTime, value));
    }
  }

  function stopLoopBoundaryMovement(save = true) {
    if (loopBoundaryEdit.moveRafId) {
      cancelAnimationFrame(loopBoundaryEdit.moveRafId);
    }

    loopBoundaryEdit.moveRafId = null;
    loopBoundaryEdit.moveDirection = 0;
    loopBoundaryEdit.moveLastTs = null;

    if (save && loopBoundaryEdit.dirty) {
      loopBoundaryEdit.dirty = false;
      saveLoopState().then(() => {
        const t = loopBoundaryTime(loopBoundaryEdit.boundary);
        if (typeof t === "number") {
          flash(
            `${loopBoundaryEdit.boundary === "in" ? "IN" : "OUT"} · ${formatTime(t)}`
          );
        }

        if (loopState.enabled && loopState.armed) {
          scheduleLoopBoundary();
        }
      });
    }
  }

  function startLoopBoundaryMovement(direction) {
    if (
      !loopBoundaryEdit.repeatActive ||
      !loopBoundaryEdit.boundary ||
      direction === 0
    ) {
      return;
    }

    const currentTime = loopBoundaryTime(loopBoundaryEdit.boundary);
    if (typeof currentTime !== "number") return;

    stopLoopBoundaryMovement(false);

    loopBoundaryEdit.moveDirection = direction;
    loopBoundaryEdit.moveLastTs = performance.now();

    const step = (ts) => {
      if (
        !loopBoundaryEdit.repeatActive ||
        loopBoundaryEdit.moveDirection === 0
      ) {
        loopBoundaryEdit.moveRafId = null;
        return;
      }

      const elapsed = Math.max(
        0,
        (ts - loopBoundaryEdit.moveLastTs) / 1000
      );
      loopBoundaryEdit.moveLastTs = ts;

      const current = loopBoundaryTime(loopBoundaryEdit.boundary);
      if (typeof current !== "number") {
        loopBoundaryEdit.moveRafId = null;
        return;
      }

      setLoopBoundaryTime(
        loopBoundaryEdit.boundary,
        current +
          loopBoundaryEdit.moveDirection *
            CUE_MOVE_RATE *
            elapsed
      );

      loopBoundaryEdit.dirty = true;
      loopBoundaryEdit.moveRafId = requestAnimationFrame(step);
    };

    loopBoundaryEdit.moveRafId = requestAnimationFrame(step);
  }

  function beginLoopBoundaryRepeat(boundary) {
    if (loopBoundaryEdit.repeatActive) return;

    cancelLoopBoundarySchedule();

    const video = getVideo();
    const point = loopBoundaryTime(boundary);

    if (!video || typeof point !== "number") {
      flash(boundary === "in" ? "Set IN first" : "Set OUT first");
      return;
    }

    loopBoundaryEdit.boundary = boundary;
    loopBoundaryEdit.repeatActive = true;
    loopBoundaryEdit.dirty = false;

    // Audition the boundary immediately.
    video.currentTime = point;
    video.play().catch(() => {});
    pulseVideoDim(video);

    loopBoundaryEdit.lastRepeatAt = performance.now();
    loopBoundaryEdit.nextRepeatAt =
      loopBoundaryEdit.lastRepeatAt + repeatLengthMs();

    const tick = () => {
      if (!loopBoundaryEdit.repeatActive) return;

      const now = performance.now();
      const interval = repeatLengthMs();

      loopBoundaryEdit.nextRepeatAt =
        loopBoundaryEdit.lastRepeatAt + interval;

      if (now >= loopBoundaryEdit.nextRepeatAt - 2) {
        const currentPoint = loopBoundaryTime(loopBoundaryEdit.boundary);

        if (typeof currentPoint === "number") {
          retriggerWithFade(video, currentPoint);
        }

        loopBoundaryEdit.lastRepeatAt = now;
        loopBoundaryEdit.nextRepeatAt =
          now + repeatLengthMs();
      }

      loopBoundaryEdit.repeatTimerId = window.setTimeout(
        tick,
        Math.max(
          4,
          Math.min(
            16,
            loopBoundaryEdit.nextRepeatAt - performance.now()
          )
        )
      );
    };

    tick();
  }

  function stopLoopBoundaryRepeat() {
    if (!loopBoundaryEdit.repeatActive) return;

    stopLoopBoundaryMovement(true);

    loopBoundaryEdit.repeatActive = false;

    if (loopBoundaryEdit.repeatTimerId) {
      clearTimeout(loopBoundaryEdit.repeatTimerId);
    }

    loopBoundaryEdit.repeatTimerId = null;
    loopBoundaryEdit.lastRepeatAt = null;
    loopBoundaryEdit.nextRepeatAt = null;
    loopBoundaryEdit.boundary = null;

    if (loopState.enabled && loopState.armed) {
      scheduleLoopBoundary();
    }
  }

  function divisionToBeats(division) {
    const map = {
      "1/4": 1,
      "1/8": 0.5,
      "1/16": 0.25,
      "1/32": 0.125
    };
    return map[division] ?? 0.25;
  }

  function minimumRepeatScale() {
    // 1/32 is 0.125 beats. Clamp the multiplier so the selected base
    // division can never be shortened past that effective duration.
    const baseBeats = divisionToBeats(settings.division);
    return Math.min(1, 0.125 / baseBeats);
  }

  function repeatLengthMs() {
    const beatMs = 60000 / Math.max(1, Number(settings.bpm) || 120);
    const minScale = minimumRepeatScale();
    const scale = Math.max(minScale, Math.min(16, Number(settings.repeatScale) || 1));
    return beatMs * divisionToBeats(settings.division) * scale;
  }

  const videoVolumeStates = new WeakMap();

  function restoreVideoVolume(video) {
    if (!video) return;

    const state = videoVolumeStates.get(video);
    if (!state) return;

    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.timerId) clearTimeout(state.timerId);

    video.volume = state.originalVolume;
    videoVolumeStates.delete(video);
  }

  function fadeVideoOut(video, durationMs, onComplete) {
    if (!video || !settings.fadeOut || durationMs <= 0) {
      if (typeof onComplete === "function") onComplete();
      return;
    }

    restoreVideoVolume(video);

    const originalVolume = video.volume;
    const startedAt = performance.now();

    const state = {
      originalVolume,
      rafId: null,
      timerId: null
    };
    videoVolumeStates.set(video, state);

    const step = (ts) => {
      const progress = Math.min(1, Math.max(0, (ts - startedAt) / durationMs));
      video.volume = originalVolume * (1 - progress);

      if (progress >= 1) {
        state.rafId = null;
        if (typeof onComplete === "function") onComplete();
        return;
      }

      state.rafId = requestAnimationFrame(step);
    };

    state.rafId = requestAnimationFrame(step);
  }

  function retriggerWithFade(video, cueTime) {
    const doRetrigger = () => {
      if (!video) return;

      video.currentTime = cueTime;
      restoreVideoVolume(video);
      video.play().catch(() => {});
      pulseVideoDim(video);
    };

    if (settings.fadeOut) {
      fadeVideoOut(video, Number(settings.fadeOutMs) || 20, doRetrigger);
    } else {
      doRetrigger();
    }
  }

  const videoDimStates = new WeakMap();

  function pulseVideoDim(video) {
    if (!settings.dimFlash || !video) return;

    let dimState = videoDimStates.get(video);
    if (!dimState) {
      dimState = {
        originalFilter: video.style.getPropertyValue("filter"),
        originalPriority: video.style.getPropertyPriority("filter"),
        timerId: null
      };
      videoDimStates.set(video, dimState);
    }

    if (dimState.timerId) clearTimeout(dimState.timerId);

    const baseFilter = dimState.originalFilter.trim();
    const dimFilter = baseFilter
      ? `${baseFilter} brightness(${DIM_BRIGHTNESS})`
      : `brightness(${DIM_BRIGHTNESS})`;

    video.style.setProperty("filter", dimFilter, "important");

    dimState.timerId = window.setTimeout(() => {
      if (dimState.originalFilter) {
        video.style.setProperty(
          "filter",
          dimState.originalFilter,
          dimState.originalPriority
        );
      } else {
        video.style.removeProperty("filter");
      }

      dimState.timerId = null;
      videoDimStates.delete(video);
    }, DIM_MS);
  }


  function repeatLengthLabel() {
    const baseMap = {
      "1/4": 4,
      "1/8": 8,
      "1/16": 16,
      "1/32": 32
    };

    const baseDenominator = baseMap[settings.division] || 16;
    const scale = Math.max(
      minimumRepeatScale(),
      Math.min(16, Number(settings.repeatScale) || 1)
    );
    const effectiveDenominator = baseDenominator / scale;

    if (Number.isInteger(effectiveDenominator) && effectiveDenominator >= 1) {
      return `1/${effectiveDenominator}`;
    }

    return `${repeatLengthMs().toFixed(1)} ms`;
  }

  async function adjustRepeatScale(multiplier) {
    const minScale = minimumRepeatScale();
    const current = Math.max(
      minScale,
      Math.min(16, Number(settings.repeatScale) || 1)
    );
    const next = Math.max(minScale, Math.min(16, current * multiplier));

    settings.repeatScale = next;
    await chrome.storage.local.set({ repeatScale: next });
    flash(`Repeat ${repeatLengthLabel()}`);
  }


  async function registerGlobalTapTempo() {
    const now = performance.now();

    if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) {
      tapTimes = [];
    }

    tapTimes.push(now);

    // 5 taps = 4 intervals, matching the popup tap-tempo behavior.
    if (tapTimes.length > 5) tapTimes.shift();

    if (tapTimes.length < 2) {
      flash("Tap tempo · tap again");
      return;
    }

    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) {
      intervals.push(tapTimes[i] - tapTimes[i - 1]);
    }

    const averageInterval =
      intervals.reduce((sum, value) => sum + value, 0) / intervals.length;

    const calculatedBpm = Math.max(
      40,
      Math.min(240, Math.round(60000 / averageInterval))
    );

    settings.bpm = calculatedBpm;
    await chrome.storage.local.set({ bpm: calculatedBpm });
    flash(`BPM ${calculatedBpm}`);
  }

  function youtubeAutomaticCueTime(cueNumber, video) {
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
      return null;
    }

    const fraction = cueNumber === 10 ? 0 : cueNumber / 10;
    return video.duration * fraction;
  }

  function cueNumberFromEvent(event) {
    if (!/^Digit[0-9]$/.test(event.code)) return null;
    const digit = Number(event.code.slice(5));
    return digit === 0 ? 10 : digit;
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;

    return Boolean(
      target.closest(
        'input, textarea, select, [contenteditable="true"], [role="textbox"], ytd-searchbox'
      )
    );
  }

  function getActiveCueState() {
    const states = [...activeCueKeys.values()];
    if (!states.length) return null;
    return states[states.length - 1];
  }

  function isBareCueKey(event) {
    return (
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    );
  }

  async function startCuePress(event, cueNumber) {
    if (!settings.enabled || !isBareCueKey(event) || isEditableTarget(event.target)) return;
    if (event.repeat || activeCueKeys.has(event.code)) return;

    const video = getVideo();
    const videoId = getVideoId();
    if (!video || !videoId) return;

    const cues = await loadCues(videoId);
    const savedCueTime = cues[String(cueNumber)];

    // Custom cue always overrides the automatic YouTube percentage position.
    // If this slot has never been set, optionally behave like YouTube's native
    // number keys. Automatic positions are seeks only: they do not become
    // repeatable/movable custom cue states.
    if (typeof savedCueTime !== "number") {
      if (!settings.youtubeAutoCues) return;

      const automaticCueTime = youtubeAutomaticCueTime(cueNumber, video);
      if (typeof automaticCueTime !== "number") return;

      disarmLoopForCueJump();

      // Match native-style seeking and preserve the current play/pause state.
      video.currentTime = automaticCueTime;

      recordPerformanceEvent(
        "cue",
        `Cue ${cueNumber === 10 ? 0 : cueNumber}`,
        {
          cueNumber: cueNumber === 10 ? 0 : cueNumber,
          cueTime: automaticCueTime,
          automatic: true
        }
      );

      flash(
        cueNumber === 10
          ? "YouTube cue · 0%"
          : `YouTube cue · ${cueNumber * 10}%`
      );
      return;
    }

    const cueTime = savedCueTime;
    const startedPaused = video.paused;

    // If a paused-video one-shot is already in progress, any additional
    // overlapping cue joins the same one-shot session. This lets you move
    // between held cues without playback pausing between them.
    const inheritedOneShotSession = [...activeCueKeys.values()].some(
      (activeState) => activeState.pauseOnRelease
    );

    const pauseOnRelease = Boolean(
      settings.oneShotMode && (startedPaused || inheritedOneShotSession)
    );

    lastPressedCue = { videoId, cueNumber, cueTime };

    disarmLoopForCueJump();

    const state = {
      code: event.code,
      videoId,
      cueNumber,
      cueTime,
      pauseOnRelease,
      timerId: null,
      repeatTimerId: null,
      nextRepeatAt: null,
      repeatActive: false,
      moveDirection: 0,
      moveRafId: null,
      moveLastTs: null,
      cueDirty: false
    };

    activeCueKeys.set(event.code, state);

    video.currentTime = cueTime;
    video.play().catch(() => {});

    recordPerformanceEvent(
      "cue",
      `Cue ${cueNumber === 10 ? 0 : cueNumber}`,
      {
        cueNumber: cueNumber === 10 ? 0 : cueNumber,
        cueTime
      }
    );

    if (settings.oneShotMode) {
      // One Shot Mode: holding the cue alone never starts repeat.
      // R is the explicit repeat modifier.
      if (heldKeys.has("KeyR")) {
        beginRepeat(state);
      }
    } else {
      // Normal mode: preserve the original 180 ms hold-to-repeat behavior.
      state.timerId = window.setTimeout(() => {
        if (!activeCueKeys.has(event.code)) return;

        beginRepeat(state);

        if (movementKeysDown.has("KeyZ")) {
          startMovingHeldCue(state, -1);
        } else if (movementKeysDown.has("KeyX")) {
          startMovingHeldCue(state, 1);
        }
      }, settings.holdThresholdMs);
    }
  }

  function beginRepeat(state) {
    if (!state || state.repeatActive || !activeCueKeys.has(state.code)) return;

    const video = getVideo();
    if (!video) return;

    state.repeatActive = true;
    pulseVideoDim(video);

    // Keep the repeat clock based on the most recent retrigger time.
    // The interval itself is recalculated every tick so [ / ] changes,
    // BPM changes, and popup division changes take effect immediately.
    state.lastRepeatAt = performance.now();
    state.nextRepeatAt = state.lastRepeatAt + repeatLengthMs();

    const tick = () => {
      if (!activeCueKeys.has(state.code) || !state.repeatActive) return;

      const now = performance.now();
      const interval = repeatLengthMs();
      state.nextRepeatAt = state.lastRepeatAt + interval;

      if (now >= state.nextRepeatAt - 2) {
        retriggerWithFade(video, state.cueTime);

        state.lastRepeatAt = now;
        state.nextRepeatAt = now + repeatLengthMs();
      }

      state.repeatTimerId = window.setTimeout(
        tick,
        Math.max(4, Math.min(16, state.nextRepeatAt - performance.now()))
      );
    };

    tick();
  }


  function stopRepeat(state) {
    if (!state) return;

    const wasRepeating = state.repeatActive;
    state.repeatActive = false;

    if (state.repeatTimerId) {
      clearTimeout(state.repeatTimerId);
      state.repeatTimerId = null;
    }

    state.nextRepeatAt = null;
    state.lastRepeatAt = null;

    if (wasRepeating && settings.fadeOut) {
      const video = getVideo();
      if (video) {
        fadeVideoOut(video, Number(settings.fadeOutMs) || 20, () => {
          restoreVideoVolume(video);
        });
      }
    }
  }

  function startMovingHeldCue(state, direction) {
    if (!state || !state.repeatActive || !activeCueKeys.has(state.code)) return;

    // Held-cue movement always requires R + cue + Z/X.
    if (!heldKeys.has("KeyR")) return;

    if (state.moveDirection === direction && state.moveRafId) return;

    stopMovingHeldCue(state, false);

    state.moveDirection = direction;
    state.moveLastTs = performance.now();

    const step = (ts) => {
      if (
        !activeCueKeys.has(state.code) ||
        !state.repeatActive ||
        state.moveDirection === 0 ||
        !heldKeys.has("KeyR")
      ) {
        state.moveRafId = null;
        return;
      }

      const video = getVideo();
      const elapsedSeconds = Math.max(0, (ts - state.moveLastTs) / 1000);
      state.moveLastTs = ts;

      const maxTime =
        video && Number.isFinite(video.duration) ? video.duration : Infinity;

      state.cueTime = Math.min(
        maxTime,
        Math.max(
          0,
          state.cueTime +
            state.moveDirection * CUE_MOVE_RATE * elapsedSeconds
        )
      );

      state.cueDirty = true;

      if (
        lastPressedCue &&
        lastPressedCue.videoId === state.videoId &&
        lastPressedCue.cueNumber === state.cueNumber
      ) {
        lastPressedCue.cueTime = state.cueTime;
      }

      state.moveRafId = requestAnimationFrame(step);
    };

    state.moveRafId = requestAnimationFrame(step);
  }

  function stopMovingHeldCue(state, save = true) {
    if (!state) return;

    state.moveDirection = 0;
    state.moveLastTs = null;

    if (state.moveRafId) cancelAnimationFrame(state.moveRafId);
    state.moveRafId = null;

    if (save && state.cueDirty) {
      state.cueDirty = false;

      writeCue(state.videoId, state.cueNumber, state.cueTime).then(() => {
        flash(`Cue ${state.cueNumber} · ${formatTime(state.cueTime)}`);
      });
    }
  }

  async function startDetachedEdit(direction) {
    if (!settings.enabled || detachedEdit) return;

    const currentVideoId = getVideoId();

    if (
      !lastPressedCue ||
      !currentVideoId ||
      lastPressedCue.videoId !== currentVideoId
    ) {
      flash("Press a cue first");
      return;
    }

    const cues = await loadCues(currentVideoId);
    const storedTime = cues[String(lastPressedCue.cueNumber)];

    if (typeof storedTime !== "number") return;

    detachedEdit = {
      videoId: currentVideoId,
      cueNumber: lastPressedCue.cueNumber,
      cueTime: storedTime,
      direction,
      rafId: null,
      lastTs: performance.now(),
      dirty: false
    };

    const step = (ts) => {
      if (!detachedEdit || detachedEdit.direction === 0) return;

      const video = getVideo();
      const elapsedSeconds = Math.max(
        0,
        (ts - detachedEdit.lastTs) / 1000
      );

      detachedEdit.lastTs = ts;

      const maxTime =
        video && Number.isFinite(video.duration) ? video.duration : Infinity;

      detachedEdit.cueTime = Math.min(
        maxTime,
        Math.max(
          0,
          detachedEdit.cueTime +
            detachedEdit.direction * CUE_MOVE_RATE * elapsedSeconds
        )
      );

      detachedEdit.dirty = true;
      lastPressedCue.cueTime = detachedEdit.cueTime;
      detachedEdit.rafId = requestAnimationFrame(step);
    };

    detachedEdit.rafId = requestAnimationFrame(step);
  }

  function stopDetachedEdit(save = true) {
    if (!detachedEdit) return;

    const state = detachedEdit;
    detachedEdit = null;

    if (state.rafId) cancelAnimationFrame(state.rafId);

    if (save && state.dirty) {
      writeCue(state.videoId, state.cueNumber, state.cueTime).then(() => {
        flash(`Cue ${state.cueNumber} · ${formatTime(state.cueTime)}`);
      });
    }
  }

  function movementDirectionForCode(code) {
    if (code === "KeyZ") return -1;
    if (code === "KeyX") return 1;
    return 0;
  }

  function handleMovementKeyDown(event) {
    const direction = movementDirectionForCode(event.code);

    if (!direction || !settings.enabled || isEditableTarget(event.target)) {
      return false;
    }

    movementKeysDown.add(event.code);

    if (
      loopBoundaryEdit.repeatActive &&
      (heldKeys.has("LoopEditI") || heldKeys.has("LoopEditO"))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      startLoopBoundaryMovement(direction);
      return true;
    }

    const active = getActiveCueState();

    if (active) {
      const movementAllowed =
        active.repeatActive &&
        heldKeys.has("KeyR");

      if (!movementAllowed) {
        return false;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      startMovingHeldCue(active, direction);
      return true;
    }

    // Preserve v3's detached last-cue editor.
    if (heldKeys.has("KeyE")) {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (detachedEdit) {
        detachedEdit.direction = direction;
        detachedEdit.lastTs = performance.now();
      } else {
        startDetachedEdit(direction);
      }

      return true;
    }

    return false;
  }

  function handleMovementKeyUp(event) {
    const direction = movementDirectionForCode(event.code);
    if (!direction) return false;

    movementKeysDown.delete(event.code);

    if (loopBoundaryEdit.repeatActive) {
      event.preventDefault();
      event.stopImmediatePropagation();

      const opposite = event.code === "KeyZ" ? "KeyX" : "KeyZ";

      if (
        movementKeysDown.has(opposite) &&
        (heldKeys.has("LoopEditI") || heldKeys.has("LoopEditO"))
      ) {
        startLoopBoundaryMovement(
          movementDirectionForCode(opposite)
        );
      } else {
        stopLoopBoundaryMovement(true);
      }

      return true;
    }

    const active = getActiveCueState();

    if (active && active.moveDirection !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();

      const opposite = event.code === "KeyZ" ? "KeyX" : "KeyZ";

      if (
        movementKeysDown.has(opposite) &&
        active.repeatActive &&
        heldKeys.has("KeyR")
      ) {
        startMovingHeldCue(
          active,
          movementDirectionForCode(opposite)
        );
      } else {
        stopMovingHeldCue(active, true);
      }

      return true;
    }

    if (detachedEdit) {
      event.preventDefault();
      event.stopImmediatePropagation();

      const opposite = event.code === "KeyZ" ? "KeyX" : "KeyZ";

      if (heldKeys.has("KeyE") && movementKeysDown.has(opposite)) {
        detachedEdit.direction = movementDirectionForCode(opposite);
        detachedEdit.lastTs = performance.now();
      } else {
        stopDetachedEdit(true);
      }

      return true;
    }

    return false;
  }

  function handleRKeyDown(event) {
    if (
      event.code !== "KeyR" ||
      !settings.enabled ||
      isEditableTarget(event.target)
    ) {
      return false;
    }

    heldKeys.add("KeyR");

    if (!settings.oneShotMode) {
      const active = getActiveCueState();

      if (active && active.moveDirection !== 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        stopMovingHeldCue(active, true);
        return true;
      }

      return false;
    }

    const active = getActiveCueState();

    if (!active) {
      // Keep R available as a modifier for a cue pressed next.
      return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    beginRepeat(active);

    if (movementKeysDown.has("KeyZ")) {
      startMovingHeldCue(active, -1);
    } else if (movementKeysDown.has("KeyX")) {
      startMovingHeldCue(active, 1);
    }

    return true;
  }

  function handleRKeyUp(event) {
    if (event.code !== "KeyR") return false;

    heldKeys.delete("KeyR");

    if (loopBoundaryEdit.repeatActive) {
      return false;
    }

    if (!settings.oneShotMode) {
      return false;
    }

    const active = getActiveCueState();

    if (!active || !active.repeatActive) {
      return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    stopMovingHeldCue(active, true);
    stopRepeat(active);

    // If this cue started while YouTube was paused, playback continues
    // until the cue key itself is released, then One Shot Mode pauses it.
    return true;
  }

  function handleEKeyDown(event) {
    if (
      event.code !== "KeyE" ||
      !settings.enabled ||
      isEditableTarget(event.target)
    ) {
      return false;
    }

    heldKeys.add("KeyE");

    if (!getActiveCueState()) {
      if (movementKeysDown.has("KeyZ")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        startDetachedEdit(-1);
        return true;
      }

      if (movementKeysDown.has("KeyX")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        startDetachedEdit(1);
        return true;
      }
    }

    return false;
  }

  function handleEKeyUp(event) {
    if (event.code !== "KeyE") return false;

    heldKeys.delete("KeyE");

    if (detachedEdit) {
      event.preventDefault();
      event.stopImmediatePropagation();
      stopDetachedEdit(true);
      return true;
    }

    return false;
  }

  function endCuePress(event) {
    const state = activeCueKeys.get(event.code);
    if (!state) return;

    if (state.timerId) clearTimeout(state.timerId);

    stopMovingHeldCue(state, false);
    stopRepeat(state);

    activeCueKeys.delete(event.code);

    if (state.cueDirty) {
      state.cueDirty = false;

      writeCue(state.videoId, state.cueNumber, state.cueTime).then(() => {
        flash(`Cue ${state.cueNumber} · ${formatTime(state.cueTime)}`);
      });
    }

    if (state.pauseOnRelease && activeCueKeys.size === 0) {
      const video = getVideo();
      if (video) video.pause();
    }
  }

  async function setCueFromShortcut(event, cueNumber) {
    if (!settings.enabled || !event.altKey || isEditableTarget(event.target)) return;
    if (event.repeat) return;

    const video = getVideo();
    const videoId = getVideoId();

    if (!video || !videoId) return;

    await saveCue(videoId, cueNumber, video.currentTime);
  }

  function cancelAllInteractions() {
    movementKeysDown.clear();
    heldKeys.clear();
    stopDetachedEdit(true);
    stopLoopBoundaryRepeat();

    for (const state of activeCueKeys.values()) {
      if (state.timerId) clearTimeout(state.timerId);

      stopMovingHeldCue(state, false);
      stopRepeat(state);

      if (state.cueDirty) {
        writeCue(state.videoId, state.cueNumber, state.cueTime);
      }

      if (state.pauseOnRelease) {
        const video = getVideo();
        if (video) video.pause();
      }
    }

    activeCueKeys.clear();

    cancelLoopEdgeTransition(true);

    const video = getVideo();
    if (video) restoreVideoVolume(video);
  }


  function shouldBlockYouTubeShortcut(event) {
    if (
      !settings.enabled ||
      !settings.blockYouTubeShortcuts ||
      isEditableTarget(event.target)
    ) {
      return false;
    }

    // Let YouCue's own controls through so our later handlers can process them.
    const youCueCodes = new Set([
      "Digit0","Digit1","Digit2","Digit3","Digit4",
      "Digit5","Digit6","Digit7","Digit8","Digit9",
      "Numpad0","Numpad1","Numpad2","Numpad3","Numpad4",
      "Numpad5","Numpad6","Numpad7","Numpad8","Numpad9",
      "KeyI","KeyO","KeyR","KeyZ","KeyX","KeyE",
      "BracketLeft","BracketRight","Quote"
    ]);

    if (youCueCodes.has(event.code)) return false;

    // Block common YouTube single-key shortcuts and navigation/media keys.
    const blockedCodes = new Set([
      "Space",
      "KeyK","KeyJ","KeyL",
      "KeyM","KeyF","KeyC","KeyT",
      "ArrowLeft","ArrowRight","ArrowUp","ArrowDown",
      "Home","End",
      "Comma","Period"
    ]);

    return blockedCodes.has(event.code);
  }

  for (const eventName of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(
      eventName,
      (event) => {
        if (!shouldBlockYouTubeShortcut(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true
    );
  }

  function shouldHardBlockYouTubeI(event) {
    return (
      settings.enabled &&
      event.code === "KeyI" &&
      !isEditableTarget(event.target)
    );
  }

  // Hard-block YouTube's native I shortcut (mini-player) at capture phase.
  // This covers normal I, Option+I, and R+I+Z/X editing.
  //
  // IMPORTANT: keydown I is handled here instead of the later generic I/O
  // shortcut branch so stopImmediatePropagation cannot prevent our own logic.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!shouldHardBlockYouTubeI(event)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (event.repeat) return;

      // R + I = audition/edit loop IN with note repeat.
      if (
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        heldKeys.has("KeyR")
      ) {
        heldKeys.add("LoopEditI");
        beginLoopBoundaryRepeat("in");
        return;
      }

      // Option + I = set loop OUT and start looping.
      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey
      ) {
        setOutPoint();
        return;
      }

      // Bare I = set loop IN.
      if (
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey
      ) {
        setInPoint();
      }
    },
    true
  );

  // Also swallow keypress/keyup so YouTube cannot react on another keyboard phase.
  window.addEventListener(
    "keypress",
    (event) => {
      if (!shouldHardBlockYouTubeI(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );

  window.addEventListener(
    "keyup",
    (event) => {
      if (!shouldHardBlockYouTubeI(event)) return;

      heldKeys.delete("LoopEditI");

      if (
        loopBoundaryEdit.repeatActive &&
        loopBoundaryEdit.boundary === "in"
      ) {
        stopLoopBoundaryRepeat();
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (
        settings.enabled &&
        !isEditableTarget(event.target) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.repeat &&
        event.code === "KeyO"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();

        // R + O turns OUT into an auditionable, note-repeating edit point.
        if (heldKeys.has("KeyR") && !event.altKey) {
          heldKeys.add("LoopEditO");
          beginLoopBoundaryRepeat("out");
          return;
        }

        // Bare O = loop toggle.
        if (!event.altKey) {
          toggleLoop();
        }

        return;
      }

      if (
        settings.enabled &&
        !isEditableTarget(event.target) &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.repeat &&
        event.code === "Quote"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        registerGlobalTapTempo();
        return;
      }

      if (
        settings.enabled &&
        !isEditableTarget(event.target) &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.repeat &&
        (event.code === "BracketLeft" || event.code === "BracketRight")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();

        // [ = half the repeat duration, ] = double the repeat duration.
        adjustRepeatScale(event.code === "BracketLeft" ? 0.5 : 2);
        return;
      }
      if (event.code === "KeyR") {
        if (handleRKeyDown(event)) return;
      }

      if (event.code === "KeyE") {
        handleEKeyDown(event);
      }

      if (handleMovementKeyDown(event)) return;

      const cueNumber = cueNumberFromEvent(event);

      if (
        !cueNumber ||
        !settings.enabled ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setCueFromShortcut(event, cueNumber);
        return;
      }

      if (isBareCueKey(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        startCuePress(event, cueNumber);
      }
    },
    true
  );

  window.addEventListener(
    "keyup",
    (event) => {
      if (
        settings.enabled &&
        !isEditableTarget(event.target) &&
        event.code === "KeyO"
      ) {
        heldKeys.delete("LoopEditO");

        if (
          loopBoundaryEdit.repeatActive &&
          loopBoundaryEdit.boundary === "out"
        ) {
          stopLoopBoundaryRepeat();
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      if (handleMovementKeyUp(event)) return;
      if (handleRKeyUp(event)) return;
      if (handleEKeyUp(event)) return;

      if (
        !settings.enabled ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      if (activeCueKeys.has(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        endCuePress(event);
      }
    },
    true
  );

  document.addEventListener(
    "timeupdate",
    (event) => {
      const video = getVideo();
      if (event.target === video) {
        maintainLoopBoundary();
      }
    },
    true
  );

  for (const eventName of ["play", "seeked", "ratechange"]) {
    document.addEventListener(
      eventName,
      (event) => {
        const video = getVideo();
        if (event.target === video) {
          scheduleLoopBoundary();
        }
      },
      true
    );
  }

  for (const eventName of ["loadedmetadata", "durationchange"]) {
    document.addEventListener(
      eventName,
      (event) => {
        const video = getVideo();
        if (event.target === video) {
          scheduleTimelineMarkerRender();
        }
      },
      true
    );
  }

  document.addEventListener(
    "pause",
    (event) => {
      const video = getVideo();
      if (event.target === video) {
        cancelLoopBoundarySchedule();
      }
    },
    true
  );

  window.addEventListener("blur", cancelAllInteractions);

  let observedVideoId = getVideoId();

  const navigationObserver = new MutationObserver(() => {
    const currentVideoId = getVideoId();

    if (
      settings.enabled &&
      !document.getElementById(YOUCUE_MARKER_HOST_ID) &&
      getTimelineMarkerParent()
    ) {
      scheduleTimelineMarkerRender(80);
    }

    if (currentVideoId !== observedVideoId) {
      cancelAllInteractions();
      lastPressedCue = null;
      observedVideoId = currentVideoId;

      const oldMarkerHost =
        document.getElementById(YOUCUE_MARKER_HOST_ID);

      if (oldMarkerHost) oldMarkerHost.remove();

      loadLoopState(currentVideoId);
      scheduleTimelineMarkerRender(120);
    }
  });

  navigationObserver.observe(document.documentElement, {
    subtree: true,
    childList: true
  });

  scheduleTimelineMarkerRender(150);

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds - mins * 60;
    return `${mins}:${secs.toFixed(3).padStart(6, "0")}`;
  }

  let toastTimer = null;

  function flash(message) {
    let toast = document.getElementById("yt-cues-toast");

    if (!toast) {
      toast = document.createElement("div");
      toast.id = "yt-cues-toast";

      Object.assign(toast.style, {
        position: "fixed",
        left: "50%",
        bottom: "88px",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        padding: "8px 12px",
        borderRadius: "8px",
        background: "rgba(0,0,0,.82)",
        color: "#fff",
        font: "600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        pointerEvents: "none",
        opacity: "0",
        transition: "opacity 120ms ease"
      });

      document.documentElement.appendChild(toast);
    }

    toast.textContent = message;
    toast.style.opacity = "1";

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      toast.style.opacity = "0";
    }, 900);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return;

    if (message.type === "YOUCUE_PERFORMANCE_RECORDING_START") {
      showRecordingOverlay(message.startedAt || Date.now());
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "YOUCUE_PERFORMANCE_RECORDING_PROCESSING") {
      setRecordingOverlayProcessing();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "YOUCUE_PERFORMANCE_RECORDING_STOP") {
      hideRecordingOverlay(
        message.message || "Take downloaded"
      );
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "YOUCUE_EXPORT_STATUS") {
      flash(message.message || "Exporting…");
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "YOUCUE_EXPORT_PREPARE") {
      prepareExportPlayback(message.startTime)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error?.message || String(error)
          });
        });

      return true;
    }

    if (message.type === "YOUCUE_EXPORT_PLAY") {
      const video = getVideo();

      if (!video) {
        sendResponse({ ok: false, error: "No YouTube video found" });
        return;
      }

      video.play().then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({
          ok: false,
          error: error?.message || String(error)
        })
      );

      return true;
    }

    if (message.type === "YOUCUE_EXPORT_PAUSE") {
      const video = getVideo();
      if (video) video.pause();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "YOUCUE_EXPORT_END") {
      restoreAfterExport()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({
          ok: false,
          error: error?.message || String(error)
        }));

      return true;
    }

    if (message.type === "YOUCUE_CLEAR_CURRENT_VIDEO_SAVES") {
      (async () => {
        const videoId = getVideoId();

        if (!videoId) {
          sendResponse({ ok: false, error: "No YouTube video found" });
          return;
        }

        await chrome.storage.local.remove([
          cueStorageKey(videoId),
          loopStorageKey(videoId),
          autosaveMetaKey(videoId)
        ]);

        if (loopState.videoId === videoId) {
          cancelLoopEdgeTransition(true);
          loopState = {
            videoId,
            inPoint: null,
            outPoint: null,
            enabled: false,
            armed: false
          };
        }

        lastPressedCue = null;
        scheduleTimelineMarkerRender();
        sendResponse({ ok: true, videoId });
      })().catch((error) => {
        sendResponse({ ok: false, error: String(error) });
      });

      return true;
    }

    if (message.type !== "YOUCUE_GET_CURRENT_VIDEO") return;

    (async () => {
      const videoId = getVideoId();
      const video = getVideo();

      if (!videoId || !video) {
        sendResponse({ ok: false, error: "No YouTube video found" });
        return;
      }

      const cues = await loadCues(videoId);
      await ensureLoopStateForCurrentVideo();

      // Prefer YouTube's visible title, then document.title.
      const titleNode =
        document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
        document.querySelector("h1.title yt-formatted-string") ||
        document.querySelector("h1 yt-formatted-string");

      let title = titleNode?.textContent?.trim() || document.title || "YouTube video";
      title = title.replace(/\s*-\s*YouTube\s*$/i, "").trim();

      sendResponse({
        ok: true,
        videoId,
        title,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        snapshot: {
          cues,
          loop: {
            inPoint: loopState.inPoint,
            outPoint: loopState.outPoint,
            enabled: loopState.enabled
          }
        }
      });
    })().catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });

    return true;
  });

})();
