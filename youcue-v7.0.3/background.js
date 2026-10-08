const OFFSCREEN_URL = "offscreen.html";
const RECORDING_SESSION_KEY = "youcuePerformanceRecording";
const MP3_BITRATE = 192;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(value, fallback = "YouTube Video") {
  const clean = String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return clean || fallback;
}

function timestampFolder() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");

  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_URL);

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });

  if (contexts.length) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification:
      "Capture the active YouTube tab audio and encode user-requested YouCue MP3 recordings."
  });
}

async function sendOffscreen(message) {
  await ensureOffscreenDocument();

  return chrome.runtime.sendMessage({
    target: "youcue-offscreen",
    ...message
  });
}

async function startTabCapture(tabId, mode) {
  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

  const response = await sendOffscreen({
    type: "YOUCUE_AUDIO_CAPTURE_START",
    streamId,
    tabId,
    mode,
    maxSeconds: mode === "performance" ? 600 : 0
  });

  if (!response?.ok) {
    throw new Error(
      response?.error || "Could not start tab audio capture"
    );
  }

  return response;
}

async function downloadFiles(files) {
  const ids = [];

  for (const file of files || []) {
    if (!file?.url || !file?.filename) continue;

    const id = await chrome.downloads.download({
      url: file.url,
      filename: file.filename,
      conflictAction: "uniquify",
      saveAs: false
    });

    ids.push(id);
  }

  return ids;
}

async function getPerformanceSession() {
  const data = await chrome.storage.session.get(RECORDING_SESSION_KEY);
  return data[RECORDING_SESSION_KEY] || null;
}

async function setPerformanceSession(session) {
  if (session) {
    await chrome.storage.session.set({
      [RECORDING_SESSION_KEY]: session
    });
  } else {
    await chrome.storage.session.remove(RECORDING_SESSION_KEY);
  }
}

async function notifyTab(tabId, message) {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {}
}

async function startPerformanceRecording({
  tabId,
  title,
  videoId,
  master,
  split
}) {
  const existing = await getPerformanceSession();

  if (existing?.active) {
    throw new Error("A YouCue take is already recording");
  }

  const capture = await startTabCapture(tabId, "performance");

  const session = {
    active: true,
    tabId,
    title: title || "YouTube Video",
    videoId: videoId || null,
    startedAt: capture.startedAt || Date.now(),
    master: master !== false,
    split: split !== false,
    events: []
  };

  await setPerformanceSession(session);

  await notifyTab(tabId, {
    type: "YOUCUE_PERFORMANCE_RECORDING_START",
    startedAt: session.startedAt
  });

  return {
    ok: true,
    session
  };
}

async function stopPerformanceRecording(tabId = null, reason = "user") {
  const session = await getPerformanceSession();

  if (!session?.active) {
    throw new Error("No YouCue take is recording");
  }

  if (tabId && session.tabId !== tabId) {
    throw new Error("The active recording belongs to another tab");
  }

  session.active = false;
  await setPerformanceSession(session);

  await notifyTab(session.tabId, {
    type: "YOUCUE_PERFORMANCE_RECORDING_PROCESSING"
  });

  const safeTitle = sanitizeFilename(session.title);
  const takeFolder =
    `YouCue/${safeTitle}/Take ${timestampFolder()}`;

  const result = await sendOffscreen({
    type: "YOUCUE_PERFORMANCE_STOP",
    events: session.events || [],
    master: session.master !== false,
    split: session.split !== false,
    bitrate: MP3_BITRATE,
    baseFolder: takeFolder,
    reason
  });

  if (!result?.ok) {
    await setPerformanceSession(null);

    await notifyTab(session.tabId, {
      type: "YOUCUE_PERFORMANCE_RECORDING_STOP",
      message: "Recording stopped, but MP3 encoding failed"
    });

    throw new Error(
      result?.error || "Could not encode performance take"
    );
  }

  if (!result.file) {
    throw new Error("Performance ZIP was not created");
  }

  await downloadFiles([result.file]);
  await setPerformanceSession(null);

  await notifyTab(session.tabId, {
    type: "YOUCUE_PERFORMANCE_RECORDING_STOP",
    message:
      reason === "limit"
        ? "10-minute take ZIP downloaded"
        : "Take ZIP downloaded"
  });

  return {
    ok: true,
    zip: result.file.filename,
    entryCount: result.entryCount || 0
  };
}

async function runCueExport({
  tabId,
  title,
  items
}) {
  const existing = await getPerformanceSession();

  if (existing?.active) {
    throw new Error("Stop the current Live Take before cue exporting");
  }

  if (!Array.isArray(items) || !items.length) {
    throw new Error("Select at least one cue or loop");
  }

  const safeTitle = sanitizeFilename(title);
  const folder = `YouCue/${safeTitle}`;
  const cueExportZipName = `CueEx - ${safeTitle}.zip`;

  await startTabCapture(tabId, "export");

  let completed = 0;

  try {
    for (const item of items) {
      const startTime = Math.max(0, Number(item.startTime) || 0);
      const durationMs = Math.max(
        100,
        Math.min(120000, Number(item.durationMs) || 0)
      );

      await notifyTab(tabId, {
        type: "YOUCUE_EXPORT_STATUS",
        message:
          `Exporting ${item.label} · ${Math.round(durationMs / 100) / 10}s`
      });

      const prepared = await chrome.tabs.sendMessage(tabId, {
        type: "YOUCUE_EXPORT_PREPARE",
        startTime
      });

      if (!prepared?.ok) {
        throw new Error(
          prepared?.error || `Could not prepare ${item.label}`
        );
      }

      const begin = await sendOffscreen({
        type: "YOUCUE_CLIP_RECORD_START"
      });

      if (!begin?.ok) {
        throw new Error(begin?.error || "Could not start clip recording");
      }

      const played = await chrome.tabs.sendMessage(tabId, {
        type: "YOUCUE_EXPORT_PLAY"
      });

      if (!played?.ok) {
        throw new Error(played?.error || "Could not play YouTube audio");
      }

      await sleep(durationMs);

      await chrome.tabs.sendMessage(tabId, {
        type: "YOUCUE_EXPORT_PAUSE"
      }).catch(() => {});

      const encoded = await sendOffscreen({
        type: "YOUCUE_CLIP_RECORD_STOP",
        bitrate: MP3_BITRATE,
        filename:
          `${sanitizeFilename(item.filename, item.label)}.mp3`
      });

      if (!encoded?.ok || !encoded.stored) {
        throw new Error(
          encoded?.error || `Could not encode ${item.label}`
        );
      }

      completed += 1;
    }

    const zipped = await sendOffscreen({
      type: "YOUCUE_CUE_EXPORT_ZIP_FINALIZE",
      zipFilename: cueExportZipName
    });

    if (!zipped?.ok || !zipped.file) {
      throw new Error(
        zipped?.error || "Could not create cue export ZIP"
      );
    }

    await downloadFiles([zipped.file]);

    return {
      ok: true,
      completed,
      zip: zipped.file.filename
    };
  } finally {
    await chrome.tabs.sendMessage(tabId, {
      type: "YOUCUE_EXPORT_END"
    }).catch(() => {});

    await sendOffscreen({
      type: "YOUCUE_AUDIO_CAPTURE_STOP"
    }).catch(() => {});

    await notifyTab(tabId, {
      type: "YOUCUE_EXPORT_STATUS",
      message:
        completed === items.length
          ? `Exported ${completed} MP3 file${completed === 1 ? "" : "s"}`
          : "Cue export stopped"
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "youcue-offscreen") return;

  if (message.type === "YOUCUE_RECORD_START") {
    startPerformanceRecording(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));

    return true;
  }

  if (message.type === "YOUCUE_RECORD_STOP") {
    stopPerformanceRecording(message.tabId || null)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));

    return true;
  }

  if (message.type === "YOUCUE_RECORD_STOP_REQUEST") {
    stopPerformanceRecording(sender.tab?.id || null)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));

    return true;
  }

  if (message.type === "YOUCUE_RECORD_STATUS") {
    getPerformanceSession()
      .then((session) => sendResponse({
        ok: true,
        session
      }))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));

    return true;
  }

  if (message.type === "YOUCUE_PERFORMANCE_EVENT") {
    (async () => {
      const session = await getPerformanceSession();

      if (
        !session?.active ||
        !sender.tab?.id ||
        session.tabId !== sender.tab.id ||
        !message.event
      ) {
        sendResponse({ ok: false });
        return;
      }

      session.events = Array.isArray(session.events)
        ? session.events
        : [];

      session.events.push(message.event);

      if (session.events.length > 5000) {
        session.events = session.events.slice(-5000);
      }

      await setPerformanceSession(session);
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));

    return true;
  }

  if (message.type === "YOUCUE_RECORD_LIMIT_REACHED") {
    stopPerformanceRecording(message.tabId || null, "limit")
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));

    return true;
  }

  if (message.type === "YOUCUE_CUE_EXPORT_START") {
    // Reply after completion when the popup stays open. The job also
    // continues while YouTube is visible because capture/encoding lives
    // outside the popup.
    runCueExport(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));

    return true;
  }
});
