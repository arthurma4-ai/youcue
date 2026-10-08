# YouCue — v7.0.3

## New in v4

### Tap tempo
While the extension popup is open:
- Press the `'` apostrophe key repeatedly, or
- Click the `' TAP` button.

Tap tempo averages the most recent 4 tap intervals.
If more than 2 seconds pass between taps, the next tap starts a fresh tempo measurement.
The result updates the extension's global BPM automatically.

### Fade out
The popup now has a **Fade out** toggle and presets:
- 5 ms
- 10 ms
- 20 ms
- 30 ms
- 50 ms

When Fade out is ON:
- Audio fades just before every note-repeat retrigger.
- The cue then jumps back, volume is restored, and the next slice plays.
- When note repeat stops, the same short fade is applied to soften the transition.

Default fade: 20 ms.

## Existing controls
- `Option + 1…9,0`: set Cue 1…10.
- Tap `1…9,0`: trigger cue.
- One Shot Mode ON:
  - paused-video cue plays while held and pauses when the last held cue is released;
  - `R + cue` enables note repeat;
  - `R + cue + Z/X` moves the repeated cue.
- One Shot Mode OFF:
  - hold a cue >180 ms for note repeat;
  - cue + Z/X moves the repeated cue.
- `E + Z/X`: edit the last pressed cue.
- Dim flash remains optional at 50% brightness for 25 ms.
- YouTube native 0–9 percentage seeking remains disabled while the extension is ON.


## Repeat length shortcuts
- `[` halves the current note-repeat duration.
- `]` doubles the current note-repeat duration.
- The adjusted repeat length is saved globally.
- Selecting a repeat division in the popup resets this multiplier back to normal for that division.

Example: with `1/16` selected, `[` gives `1/32`; pressing `[` again gives `1/64`. `]` steps in the opposite direction.


## v4.1.1
Repeat timing is now live while note repeat is running. Pressing `[` or `]` during `R + cue` immediately changes the active repeat interval without releasing or retriggering the cue manually. BPM and popup division changes also update the running repeat clock.


## v4.1.2
Tap tempo with the `'` key now works directly on YouTube even when the extension popup is closed. It uses the same global BPM storage and 4-interval averaging as the popup tap button. The shortcut is ignored while typing in search boxes, comments, inputs, textareas, or other editable fields.


## v4.1.3
The shortest allowed note-repeat duration is now `1/32`. Pressing `[` at `1/32` no longer shortens the repeat. This limit also applies live while a cue is already repeating.


## v4.2.0 — IN / OUT looping
- `Option + I` sets the IN point at the current playhead.
- `I` recalls the IN point like a cue and starts playback.
- `Option + O` sets the OUT point. OUT must be after IN.
- `O` toggles the IN→OUT loop ON/OFF.
- Turning the loop ON starts playback from IN.
- IN/OUT state is stored per YouTube video.
- While the extension is ON, YouTube's native `I` and `O` shortcuts are intercepted.
- Numbered cue points still work normally while looping.
- Triggering a numbered cue outside the active loop temporarily disarms the loop so the cue can play normally. The loop automatically re-arms when playback later enters the IN→OUT region.


## v4.2.1
`Option + O` now completes and starts the loop immediately:
- sets OUT at the current playhead,
- turns looping ON,
- jumps playback directly back to IN,
- begins looping IN → OUT.

Bare `O` still manually toggles the saved loop ON/OFF.


## v4.2.2 — simplified loop controls
- `Option + I` starts a fresh loop definition:
  - sets IN at the current playhead,
  - clears the previous OUT,
  - disables any currently active loop.
- `I` recalls the IN point like a cue.
- `Option + O`:
  - sets OUT at the current playhead,
  - requires OUT to be after IN,
  - immediately turns looping ON,
  - jumps playback back to IN,
  - loops IN → OUT.
- Bare `O` no longer toggles the loop. It is still intercepted so YouTube does not receive the key.
- Numbered cues continue to work while a loop exists.
- Triggering a numbered cue outside the loop temporarily disarms the loop; if playback later enters the IN→OUT region, the loop re-arms automatically.


## v4.2.3
- A numbered cue that jumps outside the active IN→OUT loop now disarms looping permanently for that pass.
- The loop does **not** automatically re-arm if playback later enters the IN→OUT range.
- To resume the loop, press `I` to recall IN or use `Option + O` to set/start the loop again.
- `I` and `O` are intercepted on both key-down and key-up while the extension is enabled, preventing YouTube's native `I` mini-player/small-window behavior from firing.


## v4.3.0 — final revamped loop controls
- `I` sets the loop IN point at the current playhead.
- `Option + I` sets the loop OUT point.
- `O` toggles looping:
  - if OFF, it jumps to IN, starts playback, and loops IN → OUT;
  - if ON, it exits the loop immediately and playback continues naturally.
- `R + I` turns IN into a BPM-synced note-repeat audition point.
  - add `Z/X` while held to move IN backward/forward at 0.25×.
- `R + O` turns OUT into a BPM-synced note-repeat audition point.
  - add `Z/X` while held to move OUT backward/forward at 0.25×.
- Moving IN/OUT uses the same live repeat length, dim flash, and fade behavior as cue repeat.
- `I` and `O` remain fully intercepted so YouTube's native shortcuts do not fire.


## v4.3.1
`Option + I` now completes and starts the loop immediately:
- sets OUT at the current playhead,
- turns looping ON,
- jumps playback back to IN,
- starts looping IN → OUT.

Bare `O` still toggles the active loop OFF/ON manually.


## v4.3.2 — hard-disable YouTube I shortcut
- `I` is now intercepted at capture phase before YouTube receives it.
- The extension swallows `I` on `keydown`, `keypress`, and `keyup`.
- `R + I + Z/X` can adjust the loop IN point while note-repeating without opening YouTube mini-player or changing viewing mode.
- `I` still works for the extension:
  - `I` sets IN.
  - `Option + I` sets OUT and starts looping.
  - `R + I + Z/X` edits IN while repeating.
- Editable/search/comment fields remain unaffected so typing the letter `i` still works normally.


## v4.3.3 — smoother loop edges
Normal IN→OUT looping no longer hard-seeks at the OUT boundary.

Changes:
- The next OUT boundary is scheduled ahead of time instead of relying only on coarse `timeupdate` events.
- Approximately 10 ms before OUT, audio fades to silence.
- At the loop boundary, playback seeks to IN.
- Audio fades back in over approximately 10 ms.
- This loop-edge smoothing is always active and is separate from the note-repeat Fade Out setting.
- Loop timing is rescheduled after seeks, playback-rate changes, boundary edits, and loop restarts.
- Cue jumps still disarm the loop as before.


## v5.0.0 — YouTube automatic cue points
New popup toggle: **YouTube auto cues**. Default: ON.

Number keys now use a hybrid system:
- A saved custom cue always has priority.
- `Option + 1…9,0` saves a custom cue at the current playhead and overrides that slot's automatic YouTube position for the current video.
- If the slot is unset and **YouTube auto cues** is ON:
  - `1` seeks to 10%
  - `2` seeks to 20%
  - ...
  - `9` seeks to 90%
  - `0` seeks to 0%
- Automatic YouTube cues preserve whether the video was playing or paused and behave only as percentage seeks; they do not become note-repeat or movable custom cue states.
- If the slot is unset and **YouTube auto cues** is OFF, the number key does nothing.


## v6.0.0 — YouCue
The extension is now named **YouCue**.

### Popup navigation
The popup opens on the **Main** page. Main contains all live settings and two navigation buttons:
- **Controls** — complete keyboard shortcut reference.
- **Bookmarks** — saved YouTube videos.

The old shortcut list has been removed from Main.

### Bookmarks
Bookmarks are manual only. Creating cues does not automatically save a video.

**Save current video** stores:
- video title,
- saved date,
- YouTube URL,
- a snapshot of that video's current custom cues,
- the current IN / OUT loop points and loop enabled state.

The visible bookmark list intentionally shows only:
- video title,
- saved date,
- Open,
- Delete.

Saving the same video again replaces its previous bookmark snapshot with the current cue/loop state.


## v6.1.0 — autosave storage management
Custom cues already autosave per YouTube video even when the video is not bookmarked. Version 6.1 makes that behavior explicit and adds cleanup metadata.

### Automatic save
- Every custom cue write is stored immediately in `chrome.storage.local`.
- Loop IN / OUT state is also stored per video.
- Autosaving does not require a bookmark.
- Each autosaved video now receives a lightweight last-updated timestamp used only for cleanup ordering.

### Main-page storage meter
The bottom of Main shows:
- MB used by YouCue's automatic per-video cue/loop data,
- number of videos with autosaved data,
- total extension storage used versus Chrome's 10 MB local quota.

### Cleanup
- **Clear old 180d** removes unbookmarked autosaves not updated for 180 days.
- **Clear unbookmarked** removes all unbookmarked cue/loop autosaves.
- Bookmarked video IDs are protected from both manual cleanup actions.

### Automatic guardrail
On cue/loop writes, YouCue periodically checks total local storage. If it reaches 80% of the local quota (about 8 MB with Chrome's default 10 MB quota), it removes the oldest unbookmarked autosaved videos until usage is approximately 60% (about 6 MB), preserving bookmarked videos and the currently edited video.


## v6.2.0 — clearer popup structure
- **Bookmarks** page renamed to **Storage**.
- Storage contains:
  - Save current video,
  - saved video list,
  - Open / Delete,
  - real storage usage,
  - manual cleanup controls,
  - automatic cleanup explanation.
- Main is now focused only on active playback settings.
- Controls is simplified to short function descriptions only.
- A new **Additional information** subpage explains custom cues, YouTube fallback cues, One shot mode, moving cues, looping, repeat length, tap tempo, and saved-data behavior in plain language.
- Toggle descriptions on Main were rewritten to be shorter and easier to understand.


## v6.3.0 — clearer controls and storage actions
- Storage now has **Clear current video**, which removes that video's custom number cues, loop IN/OUT data, and autosave cleanup metadata without deleting its bookmark entry.
- **One shot mode** is shown above Dim flash and explicitly explains that One shot behavior applies when cueing from a paused video.
- BPM is labeled **Repeat BPM** and explains that it controls note-repeat timing.
- Controls is reorganized into:
  - Cue keys: `1–9,0`, `I`, `O`
  - Modifier/edit keys: Option, R, Z/X, E, `[ ]`, apostrophe
  - Common combinations
- New **Block YouTube shortcuts** toggle disables common YouTube-native keyboard commands while preserving YouCue's own keyboard controls and normal typing in editable fields.


## v6.3.1
The main YouCue power toggle now uses clear status colors:
- green when the extension is ON,
- red when the extension is OFF.

Other settings toggles keep their existing neutral styling.


## v6.4.0 — fade slider and smooth cue seeks
- Fade out now explicitly uses **milliseconds (ms)**.
- The old 5/10/20/30/50 preset buttons are replaced by a **1–50 ms slider** with the exact current value shown.
- New **Smooth cue seeks** toggle:
  - applies to number-cue jumps (`1–9,0`),
  - briefly fades audio to silence,
  - seeks to the exact cue timestamp,
  - fades audio back in,
  - uses the same ms duration selected by the Fade slider.
- Smooth cue seeks never changes or snaps the stored cue position.
- `Z/X` cue movement remains entirely manual and under the user's control.
- R-triggered note repeat keeps using the existing repeat retrigger engine instead of competing with the smooth-seek transition.


## v6.5.0 — timeline markers
Custom saved points now appear above YouTube's progress bar:
- saved number cues display as small circled `1`–`9` / `0` markers,
- loop IN displays `I`,
- loop OUT displays `O`,
- `I` and `O` sit slightly above the number markers,
- no marker appears for an unset cue,
- YouTube automatic percentage fallback positions do not get markers because they are not custom saved cues.

Markers update when cues or loop points are created, moved, cleared, or when the YouTube video changes.

Cue editing is also clearer and stricter:
- `Z/X` never edits a number cue by itself,
- use `R + cue + Z/X` to move a held cue while repeating,
- or `E + Z/X` to move the last number cue,
- `O` remains the loop ON/OFF toggle.

Main now includes:
- `Youtube becomes your sampler, create custom cue points and loop`
- `Created by Arthur and Chatgpt`

The rejected Smooth cue seek feature has been removed. True transient-based Smart Cue placement is deferred until its audio-analysis implementation can be tested reliably.


## v6.5.1
Clarified the Fade Out control:
- renamed to **Note repeat fade out**
- description now states that the duration applies specifically to note repeat and is measured in milliseconds (ms)


## v7.0.0 — Record & Export

### Performance Record
The popup now has a **Record & Export** page.

**Start Take** captures the audio from the current YouTube tab while the user performs with YouCue cue points, note repeat, and loops.

Options:
- **Master MP3** — one uninterrupted recording of the entire performance.
- **Split by cue / loop** — also generates separate MP3 files for sections that begin with a YouCue cue or loop trigger.

While recording, YouTube shows a small red **REC** overlay with an elapsed timer and STOP button.

Performance downloads use:
`Downloads/YouCue/<Video Title>/Take <date-time>/`

The first V7 build records stereo MP3 at 192 kbps and limits a take to 10 minutes to prevent very large uncompressed in-memory recordings.

### Cue Export
Cue Export only displays saved custom cues and the I→O loop from the current YouTube video.

Each custom cue has:
- a checkbox,
- cue name and timestamp,
- a 1 / 2 / 4 / 8 / 16 bar length selector,
- a calculated duration in seconds.

The Export BPM is the same universal BPM used by YouCue note repeat:
`1 bar = 240 / BPM seconds` in 4/4.

A saved I→O loop can also be selected and exported as one MP3.

**Download selected MP3s** captures each selected region in real time and saves the results into:
`Downloads/YouCue/<Video Title>/Cue Export/`

### Audio engine
YouCue V7 uses Chrome `tabCapture` and an MV3 offscreen document. The captured tab stream is routed back to the default audio output so recording does not intentionally mute YouTube.

MP3 encoding is performed locally with the bundled lamejs/LAME encoder. No audio is uploaded by YouCue.


## v7.0.1 — ZIP downloads
Both V7 audio workflows now download as a single ZIP.

### Performance Record
A completed take creates one ZIP:
- `Master Take.mp3` when Master is enabled.
- `Clips/01 - Cue 1.mp3`, etc. when split recording is enabled.

Chrome downloads one file:
`YouCue/<Video Title>/Take <date-time>.zip`

### Cue Export
All selected cue and I→O loop exports are encoded as MP3, collected, and downloaded in one ZIP:
`YouCue/<Video Title>/Cue Export.zip`

The MP3 audio inside the ZIP is unchanged. ZIP uses store mode because MP3 data is already compressed, avoiding unnecessary recompression and another third-party ZIP dependency.


## v7.0.2 — wider Cue Export lengths
Cue Export length can now be selected from:
- 1/32 bar
- 1/16 bar
- 1/8 bar
- 1/4 bar
- 1/2 bar
- 1, 2, 4, 8, or 16 bars

The displayed seconds and MP3 capture duration continue to use the universal YouCue BPM. Fractional-bar filenames are preserved inside the ZIP.


## v7.0.3 — Cue Export ZIP naming
Cue Export now downloads as:

`CueEx - <YouTube Video Title>.zip`

Example:
`CueEx - Amen Break Tutorial.zip`

The MP3 files inside the ZIP keep their existing cue / loop names. Performance Record take ZIP naming is unchanged.
