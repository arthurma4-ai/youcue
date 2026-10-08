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

const BOOKMARKS_KEY = "youcueBookmarks";
const AUTOSAVE_META_PREFIX = "youcueVideoMeta:";
const AUTOSAVE_PREFIXES = ["youtubeCues:", "youtubeLoop:", AUTOSAVE_META_PREFIX];
const STORAGE_QUOTA_BYTES =
  Number(chrome.storage.local.QUOTA_BYTES) || 10 * 1024 * 1024;

const enabled = document.getElementById("enabled");
const bpm = document.getElementById("bpm");
const dimFlash = document.getElementById("dimFlash");
const oneShotMode = document.getElementById("oneShotMode");
const youtubeAutoCues = document.getElementById("youtubeAutoCues");
const blockYouTubeShortcuts = document.getElementById("blockYouTubeShortcuts");
const fadeOut = document.getElementById("fadeOut");
const fadeOutMs = document.getElementById("fadeOutMs");
const fadeOutMsValue = document.getElementById("fadeOutMsValue");
const tapButton = document.getElementById("tapButton");
const status = document.getElementById("status");
const bookmarkStatus = document.getElementById("bookmarkStatus");
const bookmarkList = document.getElementById("bookmarkList");
const saveCurrentVideo = document.getElementById("saveCurrentVideo");
const autosaveStorageValue = document.getElementById("autosaveStorageValue");
const autosaveStorageMeta = document.getElementById("autosaveStorageMeta");
const storageFill = document.getElementById("storageFill");
const clearOldAutosaves = document.getElementById("clearOldAutosaves");
const clearUnbookmarkedAutosaves = document.getElementById(
  "clearUnbookmarkedAutosaves"
);
const clearCurrentVideoSaves = document.getElementById("clearCurrentVideoSaves");

const exportBpm = document.getElementById("exportBpm");
const barSeconds = document.getElementById("barSeconds");
const exportVideoTitle = document.getElementById("exportVideoTitle");
const cueExportList = document.getElementById("cueExportList");
const loopExportContainer = document.getElementById("loopExportContainer");
const downloadSelected = document.getElementById("downloadSelected");
const exportStatus = document.getElementById("exportStatus");

const recordMaster = document.getElementById("recordMaster");
const recordSplit = document.getElementById("recordSplit");
const startTake = document.getElementById("startTake");
const stopTake = document.getElementById("stopTake");
const recordStatus = document.getElementById("recordStatus");

const divisionButtons = [...document.querySelectorAll("[data-division]")];
let settings = { ...DEFAULTS };
let tapTimes = [];

function showStatus(message) {
  status.textContent = message;
  window.clearTimeout(showStatus.timerId);
  showStatus.timerId = window.setTimeout(() => {
    status.textContent = "";
  }, 1400);
}

function showBookmarkStatus(message) {
  bookmarkStatus.textContent = message;
  window.clearTimeout(showBookmarkStatus.timerId);
  showBookmarkStatus.timerId = window.setTimeout(() => {
    bookmarkStatus.textContent = "";
  }, 1800);
}

function updateDivisionButtons() {
  divisionButtons.forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.division === settings.division
    );
  });
}

function renderSettings() {
  enabled.checked = Boolean(settings.enabled);
  bpm.value = Number(settings.bpm) || 120;
  exportBpm.value = Number(settings.bpm) || 120;
  dimFlash.checked = Boolean(settings.dimFlash);
  oneShotMode.checked = Boolean(settings.oneShotMode);
  youtubeAutoCues.checked = Boolean(settings.youtubeAutoCues);
  blockYouTubeShortcuts.checked = Boolean(settings.blockYouTubeShortcuts);
  fadeOut.checked = Boolean(settings.fadeOut);
  fadeOutMs.value = Number(settings.fadeOutMs) || 20;
  fadeOutMsValue.textContent = `${fadeOutMs.value} ms`;
  updateDivisionButtons();
  renderBarTiming();
  updateCueExportDurations();
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  settings = { ...DEFAULTS, ...stored };
  renderSettings();
}

enabled.addEventListener("change", async () => {
  settings.enabled = enabled.checked;
  await chrome.storage.local.set({ enabled: settings.enabled });
  showStatus(settings.enabled ? "YouCue on" : "YouCue off");
});

async function saveUniversalBpm(value, source = "main") {
  const next = Math.max(
    40,
    Math.min(240, Math.round(Number(value) || 120))
  );

  settings.bpm = next;
  bpm.value = next;
  exportBpm.value = next;

  await chrome.storage.local.set({ bpm: next });

  renderBarTiming();
  updateCueExportDurations();

  if (source === "main") {
    showStatus(`BPM ${next}`);
  } else {
    exportStatus.textContent = `BPM ${next}`;
  }
}

bpm.addEventListener("change", () => {
  saveUniversalBpm(bpm.value, "main");
});

exportBpm.addEventListener("change", () => {
  saveUniversalBpm(exportBpm.value, "export");
});

dimFlash.addEventListener("change", async () => {
  settings.dimFlash = dimFlash.checked;
  await chrome.storage.local.set({ dimFlash: settings.dimFlash });
  showStatus(settings.dimFlash ? "Dim flash on" : "Dim flash off");
});

oneShotMode.addEventListener("change", async () => {
  settings.oneShotMode = oneShotMode.checked;
  await chrome.storage.local.set({ oneShotMode: settings.oneShotMode });
  showStatus(settings.oneShotMode ? "One shot mode on" : "One shot mode off");
});

youtubeAutoCues.addEventListener("change", async () => {
  settings.youtubeAutoCues = youtubeAutoCues.checked;
  await chrome.storage.local.set({ youtubeAutoCues: settings.youtubeAutoCues });
  showStatus(
    settings.youtubeAutoCues
      ? "YouTube auto cues on"
      : "YouTube auto cues off"
  );
});

blockYouTubeShortcuts.addEventListener("change", async () => {
  settings.blockYouTubeShortcuts = blockYouTubeShortcuts.checked;
  await chrome.storage.local.set({
    blockYouTubeShortcuts: settings.blockYouTubeShortcuts
  });
  showStatus(
    settings.blockYouTubeShortcuts
      ? "YouTube shortcuts blocked"
      : "YouTube shortcuts enabled"
  );
});

fadeOut.addEventListener("change", async () => {
  settings.fadeOut = fadeOut.checked;
  await chrome.storage.local.set({ fadeOut: settings.fadeOut });
  showStatus(settings.fadeOut ? "Fade out on" : "Fade out off");
});

fadeOutMs.addEventListener("input", () => {
  fadeOutMsValue.textContent = `${fadeOutMs.value} ms`;
});

fadeOutMs.addEventListener("change", async () => {
  const next = Math.max(1, Math.min(50, Number(fadeOutMs.value) || 20));
  settings.fadeOutMs = next;
  fadeOutMs.value = next;
  fadeOutMsValue.textContent = `${next} ms`;
  await chrome.storage.local.set({ fadeOutMs: next });
  showStatus(`Fade ${next} ms`);
});

divisionButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    settings.division = button.dataset.division;
    settings.repeatScale = 1;
    await chrome.storage.local.set({
      division: settings.division,
      repeatScale: 1
    });
    updateDivisionButtons();
    showStatus(`Repeat ${settings.division}`);
  });
});

async function registerTap() {
  const now = performance.now();

  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) {
    tapTimes = [];
  }

  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes.shift();

  if (tapTimes.length < 2) {
    showStatus("Tap again");
    return;
  }

  const intervals = [];
  for (let i = 1; i < tapTimes.length; i++) {
    intervals.push(tapTimes[i] - tapTimes[i - 1]);
  }

  const avg = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const next = Math.max(40, Math.min(240, Math.round(60000 / avg)));

  settings.bpm = next;
  bpm.value = next;
  exportBpm.value = next;
  await chrome.storage.local.set({ bpm: next });
  renderBarTiming();
  updateCueExportDurations();
  showStatus(`BPM ${next}`);
}

tapButton.addEventListener("click", registerTap);

window.addEventListener(
  "keydown",
  (event) => {
    if (
      !event.repeat &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      event.code === "Quote"
    ) {
      event.preventDefault();
      registerTap();
    }
  },
  true
);

// ------------------------
// Record & Export
// ------------------------
let currentExportVideo = null;

function secondsPerBar() {
  return 240 / Math.max(1, Number(settings.bpm) || 120);
}

function formatBarLength(bars) {
  const value = Number(bars);

  const labels = new Map([
    [1 / 32, "1/32 bar"],
    [1 / 16, "1/16 bar"],
    [1 / 8, "1/8 bar"],
    [1 / 4, "1/4 bar"],
    [1 / 2, "1/2 bar"],
    [1, "1 bar"],
    [2, "2 bars"],
    [4, "4 bars"],
    [8, "8 bars"],
    [16, "16 bars"]
  ]);

  return labels.get(value) || `${value} bars`;
}

function formatShortTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const secs = value - minutes * 60;

  return `${minutes}:${secs.toFixed(2).padStart(5, "0")}`;
}

function renderBarTiming() {
  if (!barSeconds) return;

  barSeconds.textContent =
    `1 bar = ${secondsPerBar().toFixed(2)} sec`;
}

function updateCueExportDurations() {
  document.querySelectorAll(".cue-export-row[data-cue]").forEach((row) => {
    const select = row.querySelector(".bars-select");
    const duration = row.querySelector("[data-duration]");

    if (!select || !duration) return;

    const bars = Number(select.value) || 1;
    duration.textContent =
      `${formatBarLength(bars)} · ` +
      `${(bars * secondsPerBar()).toFixed(3)} sec`;
  });
}

async function getActiveVideoTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (
    !tab?.id ||
    !/^https:\/\/(www\.)?youtube\.com\/watch/.test(tab.url || "")
  ) {
    throw new Error("Open a YouTube video first");
  }

  return tab;
}

function makeCueExportRow({
  cueNumber,
  cueTime
}) {
  const row = document.createElement("div");
  row.className = "cue-export-row";
  row.dataset.cue = String(cueNumber);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = false;
  checkbox.dataset.exportCue = String(cueNumber);

  const main = document.createElement("div");
  main.className = "cue-export-main";

  const title = document.createElement("div");
  title.className = "cue-export-title";
  title.textContent =
    `Cue ${cueNumber === 10 ? 0 : cueNumber}`;

  const meta = document.createElement("div");
  meta.className = "cue-export-meta";

  const duration = document.createElement("span");
  duration.dataset.duration = "true";

  meta.append(
    document.createTextNode(`${formatShortTime(cueTime)} · `),
    duration
  );

  main.append(title, meta);

  const select = document.createElement("select");
  select.className = "bars-select";
  select.dataset.barsFor = String(cueNumber);

  const barOptions = [
    { value: 1 / 32, label: "1/32 bar" },
    { value: 1 / 16, label: "1/16 bar" },
    { value: 1 / 8, label: "1/8 bar" },
    { value: 1 / 4, label: "1/4 bar" },
    { value: 1 / 2, label: "1/2 bar" },
    { value: 1, label: "1 bar" },
    { value: 2, label: "2 bars" },
    { value: 4, label: "4 bars" },
    { value: 8, label: "8 bars" },
    { value: 16, label: "16 bars" }
  ];

  for (const optionData of barOptions) {
    const option = document.createElement("option");
    option.value = String(optionData.value);
    option.textContent = optionData.label;

    if (optionData.value === 4) option.selected = true;
    select.appendChild(option);
  }

  select.addEventListener("change", updateCueExportDurations);

  row.append(checkbox, main, select);
  return row;
}

async function loadCurrentExportVideo() {
  cueExportList.textContent = "";
  loopExportContainer.textContent = "";
  exportStatus.textContent = "";

  try {
    currentExportVideo = await queryCurrentVideoSnapshot();
  } catch (error) {
    currentExportVideo = null;
    exportVideoTitle.textContent =
      error.message || "Open a YouTube video first";

    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No current YouTube cues available.";
    cueExportList.appendChild(empty);
    return;
  }

  exportVideoTitle.textContent = currentExportVideo.title;

  const cues = currentExportVideo.snapshot?.cues || {};
  let cueCount = 0;

  for (let cueNumber = 1; cueNumber <= 10; cueNumber++) {
    const cueTime = cues[String(cueNumber)];
    if (typeof cueTime !== "number") continue;

    cueCount += 1;
    cueExportList.appendChild(
      makeCueExportRow({
        cueNumber,
        cueTime
      })
    );
  }

  if (!cueCount) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No custom number cues on this video.";
    cueExportList.appendChild(empty);
  }

  const loop = currentExportVideo.snapshot?.loop || {};

  if (
    typeof loop.inPoint === "number" &&
    typeof loop.outPoint === "number" &&
    loop.outPoint > loop.inPoint
  ) {
    const row = document.createElement("div");
    row.className = "cue-export-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "exportLoopCheck";

    const main = document.createElement("div");
    main.className = "cue-export-main";

    const title = document.createElement("div");
    title.className = "cue-export-title";
    title.textContent = "Loop I → O";

    const meta = document.createElement("div");
    meta.className = "cue-export-meta";
    meta.textContent =
      `${formatShortTime(loop.inPoint)} → ` +
      `${formatShortTime(loop.outPoint)} · ` +
      `${(loop.outPoint - loop.inPoint).toFixed(2)} sec`;

    main.append(title, meta);

    const type = document.createElement("div");
    type.className = "cue-export-meta";
    type.textContent = "MP3";

    row.append(checkbox, main, type);
    loopExportContainer.appendChild(row);
  }

  updateCueExportDurations();
}

function selectedCueExportItems() {
  if (!currentExportVideo) return [];

  const items = [];
  const cues = currentExportVideo.snapshot?.cues || {};
  const videoDuration = Number(currentExportVideo.duration);

  document.querySelectorAll("[data-export-cue]").forEach((checkbox) => {
    if (!checkbox.checked) return;

    const cueNumber = Number(checkbox.dataset.exportCue);
    const cueTime = cues[String(cueNumber)];

    if (typeof cueTime !== "number") return;

    const select =
      document.querySelector(`[data-bars-for="${cueNumber}"]`);

    const bars = Number(select?.value) || 1;
    let durationSeconds = bars * secondsPerBar();

    if (Number.isFinite(videoDuration)) {
      durationSeconds = Math.min(
        durationSeconds,
        Math.max(0.1, videoDuration - cueTime)
      );
    }

    const displayNumber = cueNumber === 10 ? 0 : cueNumber;

    const barLabel = formatBarLength(bars);

    items.push({
      label: `Cue ${displayNumber}`,
      filename:
        `Cue ${displayNumber} - ${barLabel}`,
      startTime: cueTime,
      durationMs: Math.round(durationSeconds * 1000)
    });
  });

  const loopCheck =
    document.getElementById("exportLoopCheck");

  const loop = currentExportVideo.snapshot?.loop || {};

  if (
    loopCheck?.checked &&
    typeof loop.inPoint === "number" &&
    typeof loop.outPoint === "number" &&
    loop.outPoint > loop.inPoint
  ) {
    items.push({
      label: "Loop I-O",
      filename: "Loop I-O",
      startTime: loop.inPoint,
      durationMs:
        Math.round(
          (loop.outPoint - loop.inPoint) * 1000
        )
    });
  }

  return items;
}

async function refreshRecordStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "YOUCUE_RECORD_STATUS"
    });

    const session = response?.session;

    if (session?.active) {
      startTake.disabled = true;
      stopTake.disabled = false;

      recordStatus.textContent =
        `Recording · ${session.title || "YouTube video"} · ` +
        `started ${new Date(session.startedAt).toLocaleTimeString()}`;
    } else {
      startTake.disabled = false;
      stopTake.disabled = true;

      recordStatus.textContent =
        "Ready · MP3 192 kbps · 10 minute maximum per take";
    }
  } catch {
    startTake.disabled = false;
    stopTake.disabled = true;
  }
}

startTake.addEventListener("click", async () => {
  startTake.disabled = true;

  try {
    const tab = await getActiveVideoTab();
    const current = await queryCurrentVideoSnapshot();

    const response = await chrome.runtime.sendMessage({
      type: "YOUCUE_RECORD_START",
      tabId: tab.id,
      title: current.title,
      videoId: current.videoId,
      master: recordMaster.checked,
      split: recordSplit.checked
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not start recording");
    }

    recordStatus.textContent =
      "Recording · use YouCue normally on YouTube · STOP overlay is available";
    stopTake.disabled = false;
  } catch (error) {
    startTake.disabled = false;
    recordStatus.textContent =
      error.message || String(error);
  }
});

stopTake.addEventListener("click", async () => {
  stopTake.disabled = true;
  recordStatus.textContent =
    "Stopping and encoding MP3…";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "YOUCUE_RECORD_STOP"
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Could not stop recording");
    }

    recordStatus.textContent =
      `Downloaded ZIP · ${response.entryCount || 0} MP3 file(s) inside`;
  } catch (error) {
    recordStatus.textContent =
      error.message || String(error);
  } finally {
    await refreshRecordStatus();
  }
});

downloadSelected.addEventListener("click", async () => {
  const items = selectedCueExportItems();

  if (!items.length) {
    exportStatus.textContent =
      "Select at least one cue or loop.";
    return;
  }

  downloadSelected.disabled = true;
  exportStatus.textContent =
    `Exporting ${items.length} MP3 file${items.length === 1 ? "" : "s"} in real time…`;

  try {
    const tab = await getActiveVideoTab();

    const response = await chrome.runtime.sendMessage({
      type: "YOUCUE_CUE_EXPORT_START",
      tabId: tab.id,
      title: currentExportVideo?.title || "YouTube Video",
      items
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Cue export failed");
    }

    exportStatus.textContent =
      `Downloaded ZIP · ${response.completed} MP3 file${response.completed === 1 ? "" : "s"} inside`;
  } catch (error) {
    exportStatus.textContent =
      error.message || String(error);
  } finally {
    downloadSelected.disabled = false;
  }
});

// ------------------------
// Autosave storage
// ------------------------
function autosaveVideoIdFromKey(key) {
  for (const prefix of AUTOSAVE_PREFIXES) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }

  return null;
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function getStorageStats() {
  const all = await chrome.storage.local.get(null);
  const autosaveKeys = Object.keys(all).filter((key) =>
    AUTOSAVE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );

  const videoIds = new Set(
    autosaveKeys.map(autosaveVideoIdFromKey).filter(Boolean)
  );

  const [autosaveBytes, totalBytes] = await Promise.all([
    autosaveKeys.length
      ? chrome.storage.local.getBytesInUse(autosaveKeys)
      : Promise.resolve(0),
    chrome.storage.local.getBytesInUse(null)
  ]);

  return {
    all,
    autosaveKeys,
    videoIds,
    autosaveBytes,
    totalBytes
  };
}

async function renderStorageUsage() {
  const stats = await getStorageStats();
  const totalPercent = Math.min(
    100,
    (stats.totalBytes / STORAGE_QUOTA_BYTES) * 100
  );

  autosaveStorageValue.textContent =
    `${formatMb(stats.autosaveBytes)} autosaved`;

  autosaveStorageMeta.textContent =
    `${stats.videoIds.size.toLocaleString()} videos · ` +
    `${formatMb(stats.totalBytes)} total / ${formatMb(STORAGE_QUOTA_BYTES)}`;

  storageFill.style.width = `${totalPercent}%`;
}

function bookmarkedVideoIdsFromStorage(all) {
  const bookmarks = Array.isArray(all[BOOKMARKS_KEY])
    ? all[BOOKMARKS_KEY]
    : [];

  return new Set(
    bookmarks.map((bookmark) => bookmark?.videoId).filter(Boolean)
  );
}

function collectAutosaveEntries(all) {
  const entries = new Map();

  for (const [key, value] of Object.entries(all)) {
    const videoId = autosaveVideoIdFromKey(key);
    if (!videoId) continue;

    if (!entries.has(videoId)) {
      entries.set(videoId, {
        videoId,
        updatedAt: 0,
        keys: []
      });
    }

    const entry = entries.get(videoId);
    entry.keys.push(key);

    if (key.startsWith(AUTOSAVE_META_PREFIX)) {
      entry.updatedAt = Number(value?.updatedAt) || 0;
    }
  }

  return [...entries.values()];
}

async function clearAutosaves({ olderThanMs = null } = {}) {
  const all = await chrome.storage.local.get(null);
  const protectedIds = bookmarkedVideoIdsFromStorage(all);
  const entries = collectAutosaveEntries(all);
  const cutoff = olderThanMs === null ? null : Date.now() - olderThanMs;

  const keysToRemove = entries
    .filter((entry) => !protectedIds.has(entry.videoId))
    .filter((entry) => cutoff === null || entry.updatedAt < cutoff)
    .flatMap((entry) => entry.keys);

  if (!keysToRemove.length) {
    showStatus("Nothing to clear");
    await renderStorageUsage();
    return 0;
  }

  await chrome.storage.local.remove(keysToRemove);
  await renderStorageUsage();
  return new Set(keysToRemove.map(autosaveVideoIdFromKey)).size;
}

clearOldAutosaves.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Clear unbookmarked cue/loop autosaves older than 180 days? Bookmarks and their saved cue data are protected."
  );

  if (!confirmed) return;

  const count = await clearAutosaves({
    olderThanMs: 180 * 24 * 60 * 60 * 1000
  });

  showStatus(count ? `Cleared ${count} old videos` : "Nothing to clear");
});

clearUnbookmarkedAutosaves.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Clear ALL unbookmarked auto-saved cue and loop data? Bookmarked videos are protected."
  );

  if (!confirmed) return;

  const count = await clearAutosaves();
  showStatus(
    count ? `Cleared ${count} unbookmarked videos` : "Nothing to clear"
  );
});

// ------------------------
// Popup page navigation
// ------------------------
const pages = {
  main: document.getElementById("pageMain"),
  controls: document.getElementById("pageControls"),
  info: document.getElementById("pageInfo"),
  storage: document.getElementById("pageStorage"),
  export: document.getElementById("pageExport")
};

function showPage(name) {
  Object.entries(pages).forEach(([key, page]) => {
    page.classList.toggle("active", key === name);
  });

  if (name === "storage") {
    renderBookmarks();
    renderStorageUsage();
  }

  if (name === "export") {
    loadCurrentExportVideo();
    refreshRecordStatus();
    renderBarTiming();
  }
}

document.getElementById("openControls").addEventListener("click", () => {
  showPage("controls");
});

document.getElementById("openStorage").addEventListener("click", () => {
  showPage("storage");
});

document.getElementById("openExport").addEventListener("click", () => {
  showPage("export");
});

document.getElementById("openInfo").addEventListener("click", () => {
  showPage("info");
});

document.getElementById("backControls").addEventListener("click", () => {
  showPage("controls");
});

document.querySelectorAll(".backMain").forEach((button) => {
  button.addEventListener("click", () => showPage("main"));
});

// ------------------------
// Bookmark storage
// ------------------------
async function getBookmarks() {
  const result = await chrome.storage.local.get(BOOKMARKS_KEY);
  const value = result[BOOKMARKS_KEY];
  return Array.isArray(value) ? value : [];
}

async function setBookmarks(bookmarks) {
  await chrome.storage.local.set({ [BOOKMARKS_KEY]: bookmarks });
}

function formatSavedDate(iso) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    }).format(new Date(iso));
  } catch {
    return iso || "";
  }
}

async function renderBookmarks() {
  const bookmarks = await getBookmarks();
  bookmarkList.textContent = "";

  if (!bookmarks.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No saved videos yet.";
    bookmarkList.appendChild(empty);
    return;
  }

  bookmarks
    .slice()
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
    .forEach((bookmark) => {
      const item = document.createElement("div");
      item.className = "bookmark-item";

      const title = document.createElement("div");
      title.className = "bookmark-title";
      title.textContent = bookmark.title || "YouTube video";

      const date = document.createElement("div");
      date.className = "bookmark-date";
      date.textContent = `Saved ${formatSavedDate(bookmark.savedAt)}`;

      const buttons = document.createElement("div");
      buttons.className = "bookmark-buttons";

      const open = document.createElement("button");
      open.className = "btn small";
      open.type = "button";
      open.textContent = "Open";
      open.addEventListener("click", async () => {
        await chrome.tabs.create({ url: bookmark.url });
      });

      const remove = document.createElement("button");
      remove.className = "btn small danger";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.addEventListener("click", async () => {
        const current = await getBookmarks();
        await setBookmarks(
          current.filter((entry) => entry.videoId !== bookmark.videoId)
        );
        await renderBookmarks();
        showBookmarkStatus("Bookmark deleted");
      });

      buttons.append(open, remove);
      item.append(title, date, buttons);
      bookmarkList.appendChild(item);
    });
}

async function queryCurrentVideoSnapshot() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !/^https:\/\/(www\.)?youtube\.com\/watch/.test(tab.url || "")) {
    throw new Error("Open a YouTube video first");
  }

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "YOUCUE_GET_CURRENT_VIDEO"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Could not read current video");
  }

  return response;
}

async function clearCurrentVideoAutosaves() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !/^https:\/\/(www\.)?youtube\.com\/watch/.test(tab.url || "")) {
    throw new Error("Open a YouTube video first");
  }

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "YOUCUE_CLEAR_CURRENT_VIDEO_SAVES"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Could not clear current video");
  }

  return response;
}

clearCurrentVideoSaves.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Clear all custom cues and loop points for the current YouTube video? This does not delete the video bookmark itself."
  );

  if (!confirmed) return;

  try {
    await clearCurrentVideoAutosaves();
    await renderStorageUsage();
    showBookmarkStatus("Current video cues cleared");
  } catch (error) {
    showBookmarkStatus(error.message || String(error));
  }
});

saveCurrentVideo.addEventListener("click", async () => {
  try {
    const currentVideo = await queryCurrentVideoSnapshot();
    const bookmarks = await getBookmarks();

    const bookmark = {
      videoId: currentVideo.videoId,
      title: currentVideo.title,
      url: currentVideo.url,
      savedAt: new Date().toISOString(),
      snapshot: currentVideo.snapshot
    };

    const next = [
      bookmark,
      ...bookmarks.filter((entry) => entry.videoId !== bookmark.videoId)
    ];

    await setBookmarks(next);
    await renderBookmarks();
    showBookmarkStatus("Current video saved");
  } catch (error) {
    showBookmarkStatus(error.message || String(error));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  for (const key of Object.keys(DEFAULTS)) {
    if (changes[key]) {
      settings[key] = changes[key].newValue;
    }
  }

  renderSettings();
  renderStorageUsage();
});

loadSettings();
renderStorageUsage();
