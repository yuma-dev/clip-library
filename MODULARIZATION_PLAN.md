# Main.js Modularization Plan

## Status: IN PROGRESS
**Last Updated:** 2024-01-16
**Current Phase:** Phase 2 - Thumbnails Extraction (NEXT)

---

## Project Organization Goal

This is the **permanent structure** for the codebase going forward. All future code should follow this pattern.

### Target Directory Structure
```
clip-library/
├── main.js                 # App lifecycle, window, IPC registration ONLY (~800 lines target)
├── renderer.js             # UI entry point (future: split into renderer/)
├── main/                   # Main process modules
│   ├── ffmpeg.js           # ✅ Video/audio encoding, export, FFprobe
│   ├── thumbnails.js       # ⏳ Generation, caching, validation, queue
│   ├── metadata.js         # ⏳ .clip_metadata file I/O, atomic writes
│   ├── file-watcher.js     # 🔮 Chokidar setup, new clip detection
│   ├── discord.js          # 🔮 Discord RPC integration
│   └── clips.js            # 🔮 Clip list management, periodic saves
├── renderer/               # 🔮 Future: split renderer.js
│   ├── video-player.js     # Video player, ambient glow
│   ├── clip-grid.js        # Grid display, virtualization
│   ├── controls.js         # Trim, volume, speed controls
│   └── state.js            # Centralized state management
├── shared/                 # 🔮 Code used by both processes
│   └── constants.js        # Shared constants, file extensions, etc.
└── utils/                  # Existing utilities
    ├── logger.js
    ├── settings-manager.js
    ├── activity-tracker.js
    └── ...
```

**Legend:** ✅ Done | ⏳ In Progress | 🔮 Future

### Module Responsibilities

| Module | Single Responsibility |
|--------|----------------------|
| `main.js` | App lifecycle, window creation, IPC handler registration |
| `main/ffmpeg.js` | All FFmpeg/FFprobe operations, encoding, export |
| `main/thumbnails.js` | Thumbnail generation, caching, validation, queue |
| `main/metadata.js` | Reading/writing .clip_metadata files |
| `main/file-watcher.js` | File system watching for new clips |
| `main/discord.js` | Discord Rich Presence |
| `main/clips.js` | Clip list loading, periodic saves, new clip detection |

### Design Principles (Follow Forever)

1. **Single Responsibility**: Each module does ONE thing well
2. **Dependency Injection**: Pass functions/getters, not global state
3. **Thin IPC Layer**: main.js registers handlers, modules contain logic
4. **No Circular Dependencies**: Dependency direction is one-way
5. **Explicit Exports**: Only export what's needed by other modules
6. **Keep Analytics**: Don't remove `logActivity()` calls when moving code - they track user actions

### Dependency Graph
```
main.js
  ├── main/ffmpeg.js (standalone)
  ├── main/thumbnails.js → depends on ffmpeg.js, metadata.js
  ├── main/metadata.js (standalone)
  ├── main/file-watcher.js (standalone)
  ├── main/discord.js (standalone)
  └── main/clips.js → depends on metadata.js
```

---

## Progress Summary

| Phase | Status | Lines Moved | Notes |
|-------|--------|-------------|-------|
| Phase 1: FFmpeg | ✅ COMPLETE | ~290 lines | All exports working |
| Phase 2: Thumbnails | ⏳ NEXT | ~300 lines (est) | Queue, validation, caching |
| Phase 3: Metadata | ⏸️ PENDING | ~400 lines (est) | File I/O, atomic writes |

**Current State:**
- `main.js`: ~1940 lines (down from ~2230)
- `main/ffmpeg.js`: ~340 lines (new)

---

## Architecture Decisions Made

### 1. Dependency Injection Pattern
Instead of importing `settings` directly (which is a module-level variable that changes), we pass `loadSettings` as a function parameter:
```javascript
// In main.js - IPC handler passes loadSettings function
ipcMain.handle("export-video", async (event, clipName, start, end, volume, speed, savePath) => {
  return ffmpegModule.exportVideo(clipName, start, end, volume, speed, savePath, loadSettings);
});

// In ffmpeg.js - calls it when needed
async function exportVideo(clipName, start, end, volume, speed, savePath, getSettings) {
  const settings = await getSettings();
  // ... use settings.clipLocation, settings.exportQuality
}
```

### 2. Direct BrowserWindow Events (No IPC Relay)
Progress events go directly to renderer via BrowserWindow, not through ipcMain.emit:
```javascript
// Old pattern (removed):
ipcMain.emit('ffmpeg-progress', progress);
ipcMain.on('ffmpeg-progress', (percent) => { ... });

// New pattern (in module):
function emitProgress(percent) {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('export-progress', percent);
  });
}
```

### 3. Module Exports fluent-ffmpeg
The ffmpeg module re-exports the configured fluent-ffmpeg instance for thumbnail generation:
```javascript
// main/ffmpeg.js
module.exports = {
  // ... other exports
  ffmpeg  // Re-export configured fluent-ffmpeg
};

// main.js imports it
const { ffmpeg, ffprobeAsync, generateScreenshot } = ffmpegModule;
```

---

## Quirks & Gotchas Found

1. **FFmpeg paths in packaged app**: Must use `.replace('app.asar', 'app.asar.unpacked')` - this is handled in the module now.

2. **Settings timing**: `settings` variable in main.js is populated async during `createWindow()`. The ffmpeg module avoids this by receiving `loadSettings` function.

3. **Removed unused imports after extraction**:
   - `clipboard` (moved to ffmpeg module)
   - `os` (moved to ffmpeg module)
   - `execFile` (moved to ffmpeg module)
   - `exec` and `execPromise` (were unused)

4. **Volume range data**: Export functions read `.volumerange` metadata files. This logic is duplicated in the ffmpeg module - could be consolidated with metadata module later.

---

## Phase 1: FFmpeg Extraction ✅ COMPLETE

### What Was Extracted
- FFmpeg/FFprobe path setup and initialization
- `exportVideoWithFallback()` with NVENC + software fallback
- `export-video`, `export-trimmed-video`, `export-audio` logic
- Progress tracking and fallback notice events
- Clipboard file copy (platform-specific)

### Files Changed
- `main.js`: Removed ~290 lines, added import and thin IPC handlers
- `main/ffmpeg.js`: Created with ~340 lines

### Tested & Working
- [x] App starts without errors
- [x] Export video to file
- [x] Export video to clipboard
- [x] Export audio
- [x] NVENC encoding (with fallback)
- [x] Progress events to renderer

---

## Phase 2: Thumbnails Extraction ⏳ NEXT

### What to Extract
- **Lines 42-46**: Thumbnail constants (CONCURRENT_GENERATIONS, queue, etc.)
- **Lines 83-90**: THUMBNAIL_CACHE_DIR setup
- **Lines 308-311**: `generateThumbnailPath()`
- **Lines 1079-1132**: `validateThumbnail()`
- **Lines 1134-1147**: `saveThumbnailMetadata()`, `getThumbnailMetadata()`
- **Lines 1149-1235**: `processQueue()`
- **Lines 1248-1278**: `regenerate-thumbnail-for-trim` logic
- **Lines 1298-1404**: `handleInitialThumbnails()`
- **Lines 1406-1464**: `generate-thumbnails-progressively` logic
- **Lines 1467-1497**: `generate-thumbnail` logic
- **Lines 1030-1063**: `get-thumbnail-path` and batch handler logic

### Dependencies
- FFmpeg module (for ffprobe, screenshot generation)
- `settings` (for clipLocation)
- `getTrimData` from metadata module
- `fs`, `path`, `crypto`
- `logger`

### Module Interface (main/thumbnails.js)
```javascript
module.exports = {
  initThumbnailCache(),
  generateThumbnailPath(),
  validateThumbnail(),
  getThumbnailMetadata(),
  saveThumbnailMetadata(),
  queueThumbnailGeneration(),
  processQueue(),
  handleInitialThumbnails(),
  regenerateThumbnailForTrim(),
  stopQueue(),  // For cleanup on app quit
}
```

### Status Checklist
- [ ] Create main/thumbnails.js
- [ ] Move thumbnail constants and cache setup
- [ ] Move generation functions
- [ ] Move queue processing
- [ ] Update main.js to import and use module
- [ ] Test: App startup thumbnail generation
- [ ] Test: Trim updates thumbnail
- [ ] Test: Thumbnail progress events

---

## Phase 3: Metadata Extraction ⏸️ PENDING

### What to Extract
- **Lines 956-1007**: `ensureDirectoryExists()`, `writeFileWithRetry()`, `writeFileAtomically()`
- **Lines 921-937**: `saveCustomNameData()`
- **Lines 939-954**: `saveTrimData()`
- **Lines 1065-1077**: `getTrimData()`
- **Lines 489-499**: `save-custom-name` logic
- **Lines 501-552**: `get-clip-info` logic (partial - uses ffprobe)
- **Lines 554-572**: `get-trim` logic
- **Lines 574-654**: speed/volume save/get logic
- **Lines 656-919**: tags handlers logic
- **Lines 2005-2035**: volume range handlers logic

### Dependencies
- `settings` (for clipLocation)
- `fs`, `path`
- `logger`
- `logActivity`

### Module Interface (main/metadata.js)
```javascript
module.exports = {
  ensureDirectoryExists(),
  writeFileAtomically(),

  // Custom names
  saveCustomName(),
  getCustomName(),

  // Trim data
  saveTrimData(),
  getTrimData(),
  deleteTrimData(),

  // Speed/Volume
  saveSpeed(),
  getSpeed(),
  saveVolume(),
  getVolume(),
  saveVolumeRange(),
  getVolumeRange(),

  // Tags
  getClipTags(),
  saveClipTags(),
  loadGlobalTags(),
  saveGlobalTags(),
  removeTagFromAllClips(),
  updateTagInAllClips(),
  restoreMissingGlobalTags(),
}
```

### Status Checklist
- [ ] Create main/metadata.js
- [ ] Move file utility functions
- [ ] Move metadata read/write functions
- [ ] Update main.js to import and use module
- [ ] Test: Rename clip
- [ ] Test: Trim clip
- [ ] Test: Tags work
- [ ] Test: Speed/volume persist

---

## Testing Protocol

After each phase:
1. Run `npm start`
2. Verify app launches without errors
3. Test the specific functionality that was extracted
4. Check DevTools console for any errors
5. If broken: `git checkout main.js` to restore

---

## Rollback Instructions

If something breaks:
```bash
# Discard all changes to main.js
git checkout main.js

# Remove new module files
rm main/ffmpeg.js
rm main/thumbnails.js
rm main/metadata.js
```

---

## Notes for Future Sessions

### Quick Start for Next Session
```
1. Read this file first (MODULARIZATION_PLAN.md)
2. Current phase: Phase 2 - Thumbnails
3. main.js is at ~1940 lines, target is ~1200 after all phases
4. Pattern established: thin IPC handlers in main.js, logic in modules
```

### How to Resume
1. Check the "Status" section at the top to see current phase
2. Look at the checkboxes to see what's done
3. Read the "What to Extract" section for the current phase
4. **IMPORTANT**: Line numbers in Phase 2/3 reference the ORIGINAL main.js (~2230 lines). Since Phase 1 removed ~290 lines, actual line numbers have shifted. Use function names to find code, not line numbers.

### Established Patterns (Follow These)
1. **Dependency injection**: Pass `loadSettings` function, not `settings` variable
2. **Direct BrowserWindow events**: Don't use ipcMain.emit relay pattern
3. **Module exports configured instances**: e.g., ffmpeg module exports configured fluent-ffmpeg
4. **Thin IPC handlers**: Keep IPC registration in main.js, delegate to modules
5. **Preserve activity logging**: All user actions must still call `logActivity()`

### Key Gotchas
- FFmpeg paths need `.replace('app.asar', 'app.asar.unpacked')` for packaged app
- `settings` is a module-level variable in main.js - need to pass it or use getter
- IPC handlers stay in main.js, they just call the module functions
- Activity logging must be preserved for all user actions
- Thumbnail module will depend on ffmpeg module (for generateScreenshot)
- Metadata module's `getTrimData` is used by thumbnails - extract metadata first OR pass as dependency

### Phase 2 Specific Notes
- Thumbnails use `ffmpeg.ffprobe()` and `ffmpeg.screenshots()` - import from ffmpeg module
- Queue processing has `completedThumbnails` counter - keep as module state
- `THUMBNAIL_CACHE_DIR` uses `app.getPath("userData")` - need to pass or import app
- `validateThumbnail()` calls `getTrimData()` - either extract metadata first or pass as param

### Future Improvements (Not Part of This Plan)
- Consolidate volume range reading (duplicated in ffmpeg module and main.js)
- Add TypeScript for type safety
- Consider splitting renderer.js (~3000 lines) similarly
- Reduce logging verbosity (mentioned by user - 2800 lines of logs on startup)
