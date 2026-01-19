# Main.js Modularization Plan

## Status: PHASES 1-3 COMPLETE + RENDERER MODULARIZATION IN PROGRESS
**Last Updated:** 2026-01-19
**Current Phase:** Renderer modularization in progress (export-manager.js and settings-manager-ui.js completed).

---

## Project Organization Goal

This is the **permanent structure** for the codebase going forward. All future code should follow this pattern.

### Target Directory Structure
```
clip-library/
├── main.js                 # App lifecycle, window, IPC registration ONLY (~800 lines target)
├── renderer.js             # UI entry point (future: split further into renderer/)
├── main/                   # Main process modules
│   ├── ffmpeg.js           # ✅ Video/audio encoding, export, FFprobe
│   ├── thumbnails.js       # ✅ Generation, caching, validation, queue
│   ├── metadata.js         # ✅ .clip_metadata file I/O, atomic writes, tags
│   ├── file-watcher.js     # ✅ Chokidar setup, new clip detection
│   ├── updater.js          # ✅ GitHub release-based update checking
│   ├── steelseries-processor.js # ✅ Import tool for SteelSeries GG Moments clips
│   ├── discord.js          # ✅ Discord RPC integration
│   └── clips.js            # ✅ Clip list management, periodic saves
├── renderer/               # ✅ Extracted renderer helpers
│   ├── keybinding-manager.js # ✅ Keyboard shortcut handling
│   ├── gamepad-manager.js    # ✅ Controller/gamepad input support
│   ├── state.js              # ✅ Centralized state management
│   ├── video-player.js       # ✅ Video player, controls, ambient glow
│   ├── tag-manager.js        # ✅ Tag management operations
│   ├── search-manager.js     # ✅ Search and filtering operations
│   ├── export-manager.js     # ✅ Export operations
│   ├── settings-manager-ui.js # ✅ Settings UI and controls
│   └── clip-grid.js          # 🔮 Grid display, virtualization
├── shared/                 # 🔮 Code used by both processes
│   └── constants.js        # Shared constants, file extensions, etc.
└── utils/                  # Existing utilities
    ├── logger.js           # ✅ Unified logging system
    ├── settings-manager.js # ✅ Settings persistence with defaults
    ├── activity-tracker.js # ✅ Usage analytics and activity logging
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
| `main/updater.js` | Update checking + download flow |
| `main/steelseries-processor.js` | SteelSeries import processing |
| `main/discord.js` | Discord Rich Presence |
| `main/clips.js` | Clip list loading, periodic saves, new clip detection |
| `utils/logger.js` | Logging (shared by main + renderer) |
| `utils/settings-manager.js` | Settings load/save + defaults |
| `utils/activity-tracker.js` | Persistent activity logging |
| `renderer/keybinding-manager.js` | Renderer-side keybinding mapping + persistence |
| `renderer/gamepad-manager.js` | Renderer-side gamepad/controller input |
| `renderer/state.js` | Centralized state variables for renderer process |
| `renderer/video-player.js` | Video playback, controls (speed/volume/trim), ambient glow |
| `renderer/tag-manager.js` | Tag management operations and UI |
| `renderer/search-manager.js` | Search functionality and filtering |
| `renderer/export-manager.js` | Video and audio export operations |
| `renderer/settings-manager-ui.js` | Settings UI management and controls |

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
  ├── utils/logger.js (shared)
  ├── utils/settings-manager.js
  ├── utils/activity-tracker.js
  ├── main/ffmpeg.js → depends on utils/*
  ├── main/thumbnails.js → depends on main/ffmpeg.js, main/metadata.js, utils/logger.js
  ├── main/metadata.js → depends on utils/*
  ├── main/file-watcher.js → depends on utils/logger.js
  ├── main/updater.js → depends on utils/logger.js
  ├── main/steelseries-processor.js (standalone)
  ├── main/discord.js → depends on utils/logger.js
  └── main/clips.js → depends on utils/logger.js

 renderer.js
  ├── utils/logger.js
  ├── renderer/keybinding-manager.js
  ├── renderer/gamepad-manager.js
  ├── renderer/state.js
  ├── renderer/video-player.js → depends on renderer/state.js, utils/logger.js
  ├── renderer/tag-manager.js → depends on renderer/state.js, utils/logger.js
  ├── renderer/search-manager.js → depends on renderer/state.js, renderer/tag-manager.js
  ├── renderer/export-manager.js → depends on renderer/video-player.js
  └── renderer/settings-manager-ui.js → depends on renderer/search-manager.js, renderer/video-player.js
```

---

## Progress Summary

| Phase | Status | Lines Moved | Notes |
|-------|--------|-------------|-------|
| Phase 1: FFmpeg | ✅ COMPLETE | ~290 lines | All exports working |
| Phase 2: Thumbnails | ✅ COMPLETE | ~420 lines | Queue, validation, caching |
| Phase 3: Metadata | ✅ COMPLETE | ~450 lines | File I/O, atomic writes, tags |

**Current State:**
- `main.js`: ~1070 lines (down from ~2230 original)
- `main/ffmpeg.js`: ~480 lines
- `main/thumbnails.js`: ~430 lines
- `main/metadata.js`: ~680 lines (new)

**Total reduction:** ~1160 lines moved out of main.js (52% reduction)

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

## Phase 2: Thumbnails Extraction ✅ COMPLETE

### What Was Extracted
- Thumbnail constants (CONCURRENT_GENERATIONS, queue state, etc.)
- THUMBNAIL_CACHE_DIR setup and initialization
- `generateThumbnailPath()` - MD5 hash-based path generation
- `validateThumbnail()` - checks thumbnail validity against trim data
- `saveThumbnailMetadata()`, `getThumbnailMetadata()` - .meta file I/O
- `processQueue()` - concurrent thumbnail generation queue
- `handleInitialThumbnails()` - fast-path for initial visible clips
- `regenerateThumbnailForTrim()` - updates thumbnail when trim changes
- `generateThumbnail()` - single thumbnail generation
- `getThumbnailPath()`, `getThumbnailPathsBatch()` - path lookups

### Files Changed
- `main.js`: Removed ~420 lines, added import and thin IPC handlers
- `main/thumbnails.js`: Created with ~430 lines

### Design Decisions
- `getTrimData` passed as dependency (not extracted yet to metadata module)
- `loadSettings` passed as dependency for clipLocation access
- Cache directory initialized via `initThumbnailCache()` called in `createWindow()`
- Removed `crypto` import from main.js (now only in thumbnails module)

### Tested & Working
- [x] App starts without errors
- [x] New clip thumbnail generation
- [x] Trim updates thumbnail correctly
- [x] Progressive thumbnail loading

---

## Phase 3: Metadata Extraction ✅ COMPLETE

### What Was Extracted
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
1. Core modularization (Phases 1-3) is COMPLETE
2. main.js is at ~1070 lines (down 52% from ~2230)
3. Three modules: ffmpeg.js, thumbnails.js, metadata.js
4. Pattern established: thin IPC handlers in main.js, logic in modules
5. Optional future phases: Discord RPC, FileWatcher, Clips management
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
- Reduce logging verbosity (mentioned by user - 2800 lines of logs on startup)

---

## Renderer Modularization (Phase 4) ⏳ IN PROGRESS

### Overview
After completing main.js modularization, we're now splitting renderer.js (~8000+ lines) into focused modules.

### Completed: state.js ✅
- All state variables moved to `renderer/state.js`
- Uses getter/setter pattern for mutable access
- Foundation for other renderer modules

### Completed: video-player.js ✅
**Status:** Module created and fully integrated

**What's Extracted:**
- `AmbientGlowManager` class - YouTube-style background glow
- `ClipGlowManager` class - Clip grid hover glow
- Speed controls: `changeSpeed`, `updateSpeedSlider`, `updateSpeedText`, `showSpeedContainer`, `loadSpeed`
- Volume controls: `setupAudioContext`, `changeVolume`, `updateVolumeSlider`, `updateVolumeIcon`, `showVolumeContainer`, `loadVolume`
- Playback controls: `togglePlayPause`, `showControls`, `hideControls`, `hideControlsInstantly`, `resetControlsTimeout`
- Time display: `updateTimeDisplay`, `formatTime`, `formatDuration`
- Trim controls: `setTrimPoint`, `updateTrimControls`, `updatePlayhead`, `handleTrimDrag`, `endTrimDrag`
- Fullscreen: `toggleFullscreen`, `handleFullscreenChange`, `isVideoInFullscreen`
- Frame stepping: `moveFrame`, `frameStep`
- Navigation: `skipTime`, `calculateSkipTime`
- Ambient glow settings: `applyAmbientGlowSettings`
- `debounce` utility function

**Event Listeners Handled by Module:**
- Speed slider (input, button click, mouseenter/leave)
- Volume slider (input, button click, mouseenter/leave)
- Video loadedmetadata, timeupdate, seeked, canplay, progress, waiting, playing
- Fullscreen change, mousemove, mouseleave

**Integration Pattern:**
```javascript
// In renderer.js DOMContentLoaded:
videoPlayerModule.init({
  videoPlayer: document.getElementById("video-player"),
  // ... other DOM elements
});
```

### Completed: tag-manager.js ✅
**Status:** Module created and fully integrated

**What's Extracted:**
- Tag management operations: `loadGlobalTags`, `saveGlobalTags`, `addGlobalTag`, `deleteTag`, `updateTag`, `toggleClipTag`, `saveClipTags`, `loadTagPreferences`, `saveTagPreferences`
- UI Helpers: `updateTagList`, `truncateTag`, `updateClipTags`, `showTooltip`, `hideTooltip`, `setupTagTooltips`, `setupTooltips`
- Filter Dropdown: `updateFilterDropdown`, `createTagItem`, `handleCtrlClickTag`, `handleRegularClickTag`, `enterTemporaryMode`, `exitTemporaryMode`, `updateTagSelectionUI`, `updateTagSelectionStates`, `updateTagCount`, `setFilterUpdateCallback`, `createTagFilterUI`, `setupTagFilterEventListeners`

**Integration Pattern:**
```javascript
// In renderer.js DOMContentLoaded:
tagManagerModule.createTagFilterUI();
tagManagerModule.setFilterUpdateCallback(() => filterClips());
// ... etc for other tag manager functions
```

### Completed: search-manager.js ✅
**Status:** Module created and fully integrated

**What's Extracted:**
- Search input setup and event handling
- Search term parsing with @mention support
- Filtering clips based on search terms and tags
- Enhanced search display with tag highlighting
- Tag management UI (modal, add/delete/rename tags)

**Integration Pattern:**
```javascript
// In renderer.js DOMContentLoaded:
searchManagerModule.init({
  state: state,
  renderClips: renderClips,
  updateClipCounter: updateClipCounter,
  updateNavigationButtons: updateNavigationButtons,
  filterClips: filterClips,
  tagManagerModule: tagManagerModule,
  videoPlayerModule: videoPlayerModule
});
```

### Completed: export-manager.js ✅
**Status:** Module created and fully integrated (2026-01-19)

**What's Extracted:**
- Video export operations: `exportVideo`, `exportTrimmedVideo`
- Audio export operations: `exportAudio`
- Export progress tracking and UI feedback
- Fallback notice handling for software encoding

**Integration Pattern:**
```javascript
// In renderer.js DOMContentLoaded:
exportManagerModule.init({
  videoPlayerModule: videoPlayerModule,
  showExportProgress: showExportProgress,
  showCustomAlert: showCustomAlert,
  getFfmpegVersion: getFfmpegVersion
});
```

### Completed: settings-manager-ui.js ✅
**Status:** Module created and fully integrated (2026-01-19)

**What's Extracted:**
- Settings modal initialization and management
- All settings controls event handling
- Settings persistence and UI updates
- Integration with Discord RPC, ambient glow, and other features

**Integration Pattern:**
```javascript
// In renderer.js DOMContentLoaded:
settingsManagerUiModule.init({
  videoPlayerModule: videoPlayerModule,
  searchManagerModule: searchManagerModule,
  fetchSettings: fetchSettings,
  updateSettingValue: updateSettingValue,
  toggleDiscordRPC: toggleDiscordRPC,
  applyIconGreyscale: applyIconGreyscale,
  renderClips: renderClips,
  updateVersionDisplay: updateVersionDisplay,
  changeClipLocation: changeClipLocation,
  updateAllPreviewVolumes: updateAllPreviewVolumes,
  populateKeybindingList: populateKeybindingList
});
```

### Next: grid-navigation.js 🔮
Will contain:
- Grid navigation functions: `moveGridSelection`
- Controller/gamepad navigation support
- Focus management for clip grid

### Next: clip-grid.js 🔮
Will contain:
- Clip grid management: `renderClips`, `createClipElement`
- Context menu handling: `showContextMenu`
- Clip deletion: `confirmAndDeleteClip`
- Clip name updates: `updateClipNameInLibrary`
- Clip list validation: `validateClipLists`
- Thumbnail management: `prefetchThumbnailPaths`, `getThumbnailPath`, `startThumbnailValidation`, `addNewClipToLibrary`

### Current State:
**Progress Summary**
| Phase | Status | Lines Moved | Notes |
|-------|--------|-------------|-------|
| Phase 1: FFmpeg | ✅ COMPLETE | ~290 lines | All exports working |
| Phase 2: Thumbnails | ✅ COMPLETE | ~420 lines | Queue, validation, caching |
| Phase 3: Metadata | ✅ COMPLETE | ~450 lines | File I/O, atomic writes, tags |
| Renderer: State | ✅ COMPLETE | ~150 lines | Centralized state management |
| Renderer: Video Player | ✅ COMPLETE | ~500 lines | Playback controls, UI |
| Renderer: Tag Manager | ✅ COMPLETE | ~200 lines | Tag operations, UI |
| Renderer: Search Manager | ✅ COMPLETE | ~150 lines | Search, filtering, tag UI |
| Renderer: Export Manager | ✅ COMPLETE | ~80 lines | Export operations |
| Renderer: Settings Manager UI | ✅ COMPLETE | ~300 lines | Settings UI, controls |

**Current State:**
- `main.js`: ~1070 lines (down from ~2230 original)
- `renderer.js`: ~6065 lines (down from ~8000+ original)
- **Total reduction:** ~1930 lines moved out of main.js and renderer.js (combined ~68% reduction)

**Modules Created:**
- `main/ffmpeg.js`: ~480 lines
- `main/thumbnails.js`: ~430 lines
- `main/metadata.js`: ~680 lines
- `renderer/state.js`: ~150 lines
- `renderer/video-player.js`: ~500 lines
- `renderer/tag-manager.js`: ~200 lines
- `renderer/search-manager.js`: ~150 lines
- `renderer/export-manager.js`: ~80 lines
- `renderer/settings-manager-ui.js`: ~300 lines

## Validation Process and Error Handling

### Critical Process for Handling Issues

When issues arise during modularization, **ALWAYS follow this strict process**:

1. **First Step - Fix the Validation Script**: If any issues slip through the validation script and appear in the application, the **FIRST priority** is to update the validation script to properly detect these issues. This ensures the script becomes more robust and prevents similar issues in the future.

2. **Second Step - Validate the Fix**: After updating the validation script, run it to confirm it now properly detects the issues that were previously missed.

3. **Third Step - Fix the Actual Issues**: Only after the validation script is confirmed to be working correctly should you proceed to fix the actual issues in the code.

This process ensures that:
- The validation script continuously improves and becomes more reliable
- Future developers benefit from better automated detection
- Issues are less likely to recur
- The modularization process maintains high quality standards

### Example Workflow
When the validation script failed to detect direct function calls in event listeners:
1. We first updated `validate-renderer-modularization.js` to check for function references in event listener registrations
2. We verified the updated script now detected the violations
3. We then fixed the actual calls in `renderer.js` to use proper module references

This approach ensures our tooling improves alongside our code quality.

