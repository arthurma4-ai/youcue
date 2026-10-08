const MP3_DEFAULT_BITRATE = 192;
const PROCESSOR_BUFFER_SIZE = 4096;

let capture = null;
const liveObjectUrls = new Set();

function crc32(bytes) {
  let crc = 0xffffffff;

  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];

    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);

  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();

  return { dosTime, dosDate };
}

async function createZipBlob(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = new Uint8Array(await entry.blob.arrayBuffer());
    const crc = crc32(dataBytes);
    const { dosTime, dosDate } = dosDateTime();

    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const localView = new DataView(localHeader);

    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800); // UTF-8 names
    writeU16(localView, 8, 0);      // store, MP3 is already compressed
    writeU16(localView, 10, dosTime);
    writeU16(localView, 12, dosDate);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, dataBytes.length);
    writeU32(localView, 22, dataBytes.length);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);

    new Uint8Array(localHeader, 30).set(nameBytes);

    localParts.push(localHeader, dataBytes);

    const centralHeader = new ArrayBuffer(46 + nameBytes.length);
    const centralView = new DataView(centralHeader);

    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, dosTime);
    writeU16(centralView, 14, dosDate);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, dataBytes.length);
    writeU32(centralView, 24, dataBytes.length);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, localOffset);

    new Uint8Array(centralHeader, 46).set(nameBytes);
    centralParts.push(centralHeader);

    localOffset += localHeader.byteLength + dataBytes.length;
  }

  const centralSize = centralParts.reduce(
    (sum, part) => sum + part.byteLength,
    0
  );

  const end = new ArrayBuffer(22);
  const endView = new DataView(end);

  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 4, 0);
  writeU16(endView, 6, 0);
  writeU16(endView, 8, entries.length);
  writeU16(endView, 10, entries.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, localOffset);
  writeU16(endView, 20, 0);

  return new Blob(
    [...localParts, ...centralParts, end],
    { type: "application/zip" }
  );
}

let cueExportZipEntries = [];

function floatToInt16(input) {
  const output = new Int16Array(input.length);

  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] =
      sample < 0
        ? sample * 0x8000
        : sample * 0x7fff;
  }

  return output;
}

function totalChunkSamples(chunks) {
  let total = 0;

  for (const chunk of chunks) {
    total += chunk.length;
  }

  return total;
}

function encodeMp3Range({
  leftChunks,
  rightChunks,
  sampleRate,
  startSample = 0,
  endSample = null,
  bitrate = MP3_DEFAULT_BITRATE
}) {
  const totalSamples = totalChunkSamples(leftChunks);
  const start = Math.max(0, Math.floor(startSample));
  const end = Math.max(
    start,
    Math.min(
      totalSamples,
      endSample === null
        ? totalSamples
        : Math.floor(endSample)
    )
  );

  const encoder = new lamejs.Mp3Encoder(
    2,
    sampleRate,
    bitrate
  );

  const mp3Data = [];
  let cursor = 0;

  for (let index = 0; index < leftChunks.length; index++) {
    const left = leftChunks[index];
    const right = rightChunks[index] || left;
    const chunkStart = cursor;
    const chunkEnd = cursor + left.length;

    cursor = chunkEnd;

    if (chunkEnd <= start || chunkStart >= end) continue;

    const localStart = Math.max(0, start - chunkStart);
    const localEnd = Math.min(left.length, end - chunkStart);

    if (localEnd <= localStart) continue;

    const leftSlice = left.subarray(localStart, localEnd);
    const rightSlice = right.subarray(localStart, localEnd);

    const encoded =
      encoder.encodeBuffer(leftSlice, rightSlice);

    if (encoded.length) {
      mp3Data.push(new Int8Array(encoded));
    }
  }

  const tail = encoder.flush();

  if (tail.length) {
    mp3Data.push(new Int8Array(tail));
  }

  return new Blob(mp3Data, {
    type: "audio/mpeg"
  });
}

function createDownloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  liveObjectUrls.add(url);

  // Give chrome.downloads plenty of time to consume the blob.
  setTimeout(() => {
    if (!liveObjectUrls.has(url)) return;
    URL.revokeObjectURL(url);
    liveObjectUrls.delete(url);
  }, 5 * 60 * 1000);

  return {
    url,
    filename,
    size: blob.size
  };
}

function cleanupCapture() {
  const state = capture;
  capture = null;

  if (!state) return;

  try {
    state.processor.onaudioprocess = null;
    state.source.disconnect();
    state.processor.disconnect();
    state.silentGain.disconnect();
    state.monitorGain.disconnect();
  } catch {}

  for (const track of state.stream.getTracks()) {
    try {
      track.stop();
    } catch {}
  }

  state.audioContext.close().catch(() => {});
}

async function startCapture({
  streamId,
  tabId,
  mode,
  maxSeconds = 0
}) {
  cleanupCapture();

  if (mode === "export") {
    cueExportZipEntries = [];
  }

  const stream =
    await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

  const audioContext = new AudioContext({
    latencyHint: "interactive"
  });

  await audioContext.resume();

  const source =
    audioContext.createMediaStreamSource(stream);

  const processor =
    audioContext.createScriptProcessor(
      PROCESSOR_BUFFER_SIZE,
      2,
      2
    );

  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  const monitorGain = audioContext.createGain();
  monitorGain.gain.value = 1;

  // Monitoring path: preserve what the user hears.
  source.connect(monitorGain);
  monitorGain.connect(audioContext.destination);

  // Analysis/recording path. The silent output keeps ScriptProcessor active
  // without duplicating the monitored sound.
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  capture = {
    tabId,
    mode,
    stream,
    audioContext,
    source,
    processor,
    silentGain,
    monitorGain,
    sampleRate: audioContext.sampleRate,
    startedAt: Date.now(),

    performance: {
      left: [],
      right: [],
      totalSamples: 0,
      maxSamples:
        maxSeconds > 0
          ? Math.floor(audioContext.sampleRate * maxSeconds)
          : 0,
      limitSent: false
    },

    clip: {
      active: false,
      left: [],
      right: []
    }
  };

  processor.onaudioprocess = (event) => {
    const state = capture;
    if (!state) return;

    const input = event.inputBuffer;
    const leftFloat = input.getChannelData(0);
    const rightFloat =
      input.numberOfChannels > 1
        ? input.getChannelData(1)
        : leftFloat;

    if (state.mode === "performance") {
      const left = floatToInt16(leftFloat);
      const right = floatToInt16(rightFloat);

      state.performance.left.push(left);
      state.performance.right.push(right);
      state.performance.totalSamples += left.length;

      if (
        state.performance.maxSamples > 0 &&
        state.performance.totalSamples >=
          state.performance.maxSamples &&
        !state.performance.limitSent
      ) {
        state.performance.limitSent = true;

        chrome.runtime.sendMessage({
          type: "YOUCUE_RECORD_LIMIT_REACHED",
          tabId: state.tabId
        }).catch(() => {});
      }
    }

    if (state.clip.active) {
      state.clip.left.push(floatToInt16(leftFloat));
      state.clip.right.push(floatToInt16(rightFloat));
    }
  };

  return {
    ok: true,
    startedAt: capture.startedAt,
    sampleRate: capture.sampleRate
  };
}

async function stopPerformance({
  events = [],
  master = true,
  split = true,
  bitrate = MP3_DEFAULT_BITRATE,
  baseFolder = "YouCue/Take"
}) {
  const state = capture;

  if (!state || state.mode !== "performance") {
    return {
      ok: false,
      error: "No performance recording is active"
    };
  }

  const stoppedAt = Date.now();

  // Stop accepting new samples while encoding.
  state.processor.onaudioprocess = null;

  const totalSamples = state.performance.totalSamples;
  const zipEntries = [];

  if (master && totalSamples > 0) {
    const blob = encodeMp3Range({
      leftChunks: state.performance.left,
      rightChunks: state.performance.right,
      sampleRate: state.sampleRate,
      startSample: 0,
      endSample: totalSamples,
      bitrate
    });

    zipEntries.push({
      name: "Master Take.mp3",
      blob
    });
  }

  if (split && totalSamples > 0) {
    const sortedEvents = [...events]
      .filter((event) => Number.isFinite(Number(event.wallMs)))
      .sort((a, b) => Number(a.wallMs) - Number(b.wallMs));

    let clipNumber = 0;

    for (let i = 0; i < sortedEvents.length; i++) {
      const event = sortedEvents[i];

      if (event.type !== "cue" && event.type !== "loop") {
        continue;
      }

      const nextEvent = sortedEvents[i + 1];
      const startMs =
        Math.max(
          0,
          Number(event.wallMs) - state.startedAt
        );

      const endMs =
        Math.min(
          stoppedAt - state.startedAt,
          nextEvent
            ? Number(nextEvent.wallMs) - state.startedAt
            : stoppedAt - state.startedAt
        );

      if (endMs - startMs < 100) continue;

      const startSample =
        Math.floor(
          (startMs / 1000) * state.sampleRate
        );

      const endSample =
        Math.floor(
          (endMs / 1000) * state.sampleRate
        );

      if (endSample <= startSample) continue;

      clipNumber += 1;

      const label = String(event.label || "Section")
        .replace(/[\\/:*?"<>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const blob = encodeMp3Range({
        leftChunks: state.performance.left,
        rightChunks: state.performance.right,
        sampleRate: state.sampleRate,
        startSample,
        endSample,
        bitrate
      });

      zipEntries.push({
        name:
          `Clips/${String(clipNumber).padStart(2, "0")} - ${label}.mp3`,
        blob
      });
    }
  }

  cleanupCapture();

  if (!zipEntries.length) {
    return {
      ok: false,
      error: "No MP3 files were created for this take"
    };
  }

  const zipBlob = await createZipBlob(zipEntries);

  return {
    ok: true,
    file: createDownloadFile(
      zipBlob,
      `${baseFolder}.zip`
    ),
    entryCount: zipEntries.length,
    durationMs: stoppedAt - state.startedAt
  };
}

function startClipRecording() {
  if (!capture || capture.mode !== "export") {
    return {
      ok: false,
      error: "Cue export audio capture is not active"
    };
  }

  capture.clip.active = true;
  capture.clip.left = [];
  capture.clip.right = [];

  return { ok: true };
}

function stopClipRecording({
  filename,
  bitrate = MP3_DEFAULT_BITRATE
}) {
  if (!capture || capture.mode !== "export") {
    return {
      ok: false,
      error: "Cue export audio capture is not active"
    };
  }

  capture.clip.active = false;

  const left = capture.clip.left;
  const right = capture.clip.right;
  const totalSamples = totalChunkSamples(left);

  if (!totalSamples) {
    return {
      ok: false,
      error: "No audio was captured for this clip"
    };
  }

  const blob = encodeMp3Range({
    leftChunks: left,
    rightChunks: right,
    sampleRate: capture.sampleRate,
    startSample: 0,
    endSample: totalSamples,
    bitrate
  });

  capture.clip.left = [];
  capture.clip.right = [];

  if (filename) {
    cueExportZipEntries.push({
      name: filename,
      blob
    });

    return {
      ok: true,
      stored: true,
      name: filename
    };
  }

  return {
    ok: true,
    file: createDownloadFile(
      blob,
      "YouCue/Cue Export.mp3"
    )
  };
}

async function finalizeCueExportZip(zipFilename) {
  if (!cueExportZipEntries.length) {
    return {
      ok: false,
      error: "No cue export MP3s were created"
    };
  }

  const zipBlob = await createZipBlob(cueExportZipEntries);
  const entryCount = cueExportZipEntries.length;
  cueExportZipEntries = [];

  return {
    ok: true,
    file: createDownloadFile(
      zipBlob,
      zipFilename || "YouCue/Cue Export.zip"
    ),
    entryCount
  };
}

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (
      !message ||
      message.target !== "youcue-offscreen"
    ) {
      return;
    }

    if (message.type === "YOUCUE_AUDIO_CAPTURE_START") {
      startCapture(message)
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          error: error?.message || String(error)
        }));

      return true;
    }

    if (message.type === "YOUCUE_AUDIO_CAPTURE_STOP") {
      cleanupCapture();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "YOUCUE_PERFORMANCE_STOP") {
      stopPerformance(message)
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          error: error?.message || String(error)
        }));

      return true;
    }

    if (message.type === "YOUCUE_CLIP_RECORD_START") {
      sendResponse(startClipRecording());
      return;
    }

    if (message.type === "YOUCUE_CLIP_RECORD_STOP") {
      try {
        sendResponse(stopClipRecording(message));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      }

      return;
    }

    if (message.type === "YOUCUE_CUE_EXPORT_ZIP_FINALIZE") {
      finalizeCueExportZip(message.zipFilename)
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          error: error?.message || String(error)
        }));

      return true;
    }
  }
);
