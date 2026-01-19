# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Clip Library is an Electron-based desktop application for managing video clips. It serves as a replacement for SteelSeries GG Moments, allowing users to organize, trim, tag, and export video clips captured by any recording software (OBS Studio, etc.).

## Development Commands

### Running the Application
```bash
npm start                    # Start the Electron app in development mode
```

### Building
```bash
npm run build               # Build Windows installer using electron-builder
```

### Benchmarking
```bash
npm run benchmark                  # Run all benchmarks
npm run benchmark:verbose          # Run with detailed output
npm run benchmark:json             # Output results in JSON format
npm run benchmark:openclip         # Profile clip opening performance
```

## Architecture

### Process Structure
- **Main Process** (`main.js`): Core Electron main process handling IPC, file system operations, FFmpeg processing, and system integration
- **Renderer Process** (`renderer.js`): UI logic, video playback, and user interactions
- **IPC Communication**: Extensive use of `ipcMain.handle` and `ipcRenderer.invoke` for main-renderer communication

### Key Components

#### Main Process (`main.js`)
- **FFmpeg Integration**: Video processing for thumbnails, exports, and trimming using `fluent-ffmpeg`
  - Hardware encoding with fallback to software encoding
  - Concurrent thumbnail generation (4 max concurrent)
  - Progress tracking for exports
- **Metadata Management**: All clip metadata stored in `.clip_metadata/` folder within clip location:
  - `{clipName}.customname` - Custom clip names
  - `{clipName}.trim` - Trim points (start/end times)
  - `{clipName}.tags` - Clip-specific tags
  - `{clipName}.speed` - Playback speed
  - `{clipName}.volume` - Volume level
  - `{clipName}.volumerange` - Volume adjustments for specific time ranges
  - `{clipName}.date` - Recording timestamp
  - `{clipName}.gameinfo` - Game information and icon reference
- **File Watching**: Uses `chokidar` to detect new clips added to the watched folder
- **Thumbnail Cache**: MD5-hashed thumbnail storage in app userData with metadata (`.jpg.meta` files)
- **Settings**: Stored in userData as `settings.json` (managed by `settings-manager.js`)

#### Renderer Process (`renderer.js`)
- **Video Player**: Custom video player with:
  - Trim controls (draggable start/end markers)
  - Volume and speed controls
  - Ambient glow effect (YouTube-style background glow)
  - Frame-by-frame navigation
  - Keyboard shortcuts and gamepad support
- **Clip Grid**: Virtualized grid display with thumbnail lazy loading
- **Tag System**: Global tags stored in `global_tags.json` with per-clip tag assignments
- **Search & Filter**: Real-time search and tag-based filtering

#### Supporting Modules
- **`settings-manager.js`**: Settings persistence with defaults for keybindings, controller mappings, and app preferences
- **`keybinding-manager.js`**: Centralized keyboard shortcut handling
- **`gamepad-manager.js`**: Controller/gamepad input support
- **`logger.js`**: Unified logging system for both main and renderer processes
- **`updater.js`**: GitHub release-based update checking
- **`activity-tracker.js`**: Usage analytics and activity logging
- **`steelseries-processor.js`**: Import tool for SteelSeries GG Moments clips
- **`diagnostics/collector.js`**: Diagnostics bundle generation for troubleshooting

### Data Flow

1. **Clip Loading**:
   - Main process scans clip folder using `readify`
   - Metadata loaded from `.clip_metadata/` folder
   - Renderer receives clip list and requests thumbnails
   - Initial 12 thumbnails generated in parallel (fast path)
   - Remaining thumbnails processed in background queue

2. **Video Export**:
   - User initiates export (video/audio, to file or clipboard)
   - Main process runs FFmpeg with hardware acceleration (NVENC)
   - Progress tracked via stderr parsing
   - Falls back to software encoding (libx264) on error
   - Output copied to clipboard or saved to user-selected location

3. **Trim Workflow**:
   - User sets trim points in video player
   - Trim data saved as JSON in `.clip_metadata/{clipName}.trim`
   - Thumbnail regenerated at trim start point
   - Exports respect trim boundaries

### Performance Optimizations

- **Thumbnail Generation**:
  - Concurrent processing (4 workers)
  - Smart validation with epsilon comparison for trim points
  - Metadata caching to avoid redundant FFprobe calls
  - Fast path for initial visible clips
- **Clip Data Caching**: 1-minute cache for recently accessed clip metadata
- **Periodic Saves**: Auto-save clip list every 5 minutes to prevent data loss
- **GPU Acceleration**: NVENC hardware encoding for exports (with fallback)

### Benchmark System

Located in `benchmark/` directory:
- **`runner.js`**: Main benchmark orchestrator
- **`main-harness.js`**: Main process performance tracking
- **`renderer-harness.js`**: Renderer process performance tracking
- **`open-clip-profiler.js`**: Specialized profiling for clip opening
- **`scenarios.js`**: Benchmark scenario definitions
- Environment variable `CLIPS_BENCHMARK=1` enables benchmark mode

## Important Patterns

### Atomic File Writes
Use `writeFileAtomically()` for metadata saves to prevent corruption:
```javascript
await writeFileAtomically(filePath, data);
```

### Activity Logging
Log user actions for analytics using `activity-tracker.js`. All tracked activities:

```javascript
const { logActivity } = require('./activity-tracker');
```

**Tracked Activities:**

1. **`rename`** - Clip renamed with custom name
   ```javascript
   logActivity('rename', { originalName, newCustomName: customName });
   ```

2. **`speed_change`** - Playback speed modified
   ```javascript
   logActivity('speed_change', { clipName, speed });
   ```

3. **`volume_change`** - Volume level adjusted
   ```javascript
   logActivity('volume_change', { clipName, volume });
   ```

4. **`tags_update_clip`** - Tags assigned to specific clip
   ```javascript
   logActivity('tags_update_clip', { clipName, tags });
   ```

5. **`tags_update_global`** - Global tag list updated
   ```javascript
   logActivity('tags_update_global', { tags });
   ```

6. **`tags_restore_global`** - Missing global tags restored
   ```javascript
   logActivity('tags_restore_global', { restoredTags: missingTags, count: missingTags.length });
   ```

7. **`trim`** - Clip trimmed
   ```javascript
   logActivity('trim', { clipName, start: trimData.start, end: trimData.end });
   ```

8. **`delete`** - Clip deleted
   ```javascript
   logActivity('delete', { clipName });
   ```

9. **`export`** - Video or audio exported (multiple variants)
   ```javascript
   // Video export to file or clipboard
   logActivity('export', {
     clipName,
     format: 'video',
     destination: 'file' | 'clipboard',
     start,
     end,
     volume,
     speed
   });

   // Trimmed video to clipboard
   logActivity('export', {
     clipName,
     format: 'video',
     destination: 'trimmed_clipboard',
     start,
     end,
     volume,
     speed
   });

   // Audio export to file or clipboard
   logActivity('export', {
     clipName,
     format: 'audio',
     destination: 'file' | 'clipboard',
     start,
     end,
     volume,
     speed
   });
   ```

10. **`import_start`** - SteelSeries import initiated
    ```javascript
    logActivity('import_start', { source: 'steelseries', sourcePath });
    ```

11. **`watch_session`** - Video watch session completed (logged from renderer via IPC)
    ```javascript
    logActivity('watch_session', sessionData);
    // sessionData must include: { durationSeconds, ... }
    ```

### IPC Handlers
Main process handlers use `ipcMain.handle` for async operations:
```javascript
ipcMain.handle('handler-name', async (event, ...args) => {
  // Return value sent back to renderer
});
```

### Settings Management
Always use settings-manager for persistence:
```javascript
const { loadSettings, saveSettings } = require('./settings-manager');
const settings = await loadSettings();
await saveSettings(modifiedSettings);
```

## File Locations

- **Clip Location**: User-configurable (default: Videos folder)
- **Metadata**: `{clipLocation}/.clip_metadata/`
- **Thumbnails**: `{userData}/thumbnail-cache/`
- **Settings**: `{userData}/settings.json`
- **Global Tags**: `{userData}/global_tags.json`
- **Tag Preferences**: `{userData}/tagPreferences.json`
- **Logs**: `{userData}/logs/`
- **Last Clips**: `{userData}/last-clips.json` (for detecting new clips)

## Testing Notes

- No formal test suite currently exists
- Manual testing workflow: run `npm start` and verify functionality
- Benchmark suite provides performance regression testing
- Use Dev Tools with Ctrl+Shift+I for debugging

### Validation Scripts

The project includes validation scripts to check code quality and catch common issues during modularization.

```bash
node validate-renderer-modularization.js  # Specifically for renderer.js modularization
```

This script helps track progress and identifies:
- Functions remaining in `renderer.js` that should be moved.
- Direct calls to functions that have already been extracted to modules (dependency violations).
- Duplicate function definitions across `renderer.js` and modules.

Run this script frequently to guide your modularization efforts and ensure no new dependencies are introduced.

### Recovering Lost Code

If code gets accidentally removed during refactoring, you can view previous versions using git:

```bash
# View a specific function from a previous commit
git show HEAD~1:renderer.js | sed -n '/function enableGridNavigation/,/}/p'

# General pattern:
git show HEAD~N:filename.js | sed -n '/pattern/,/end-pattern/p'
```

Where:
- `HEAD~1` = previous commit (use `HEAD~2`, `HEAD~3`, etc. for older commits)
- `/pattern/,/end-pattern/p` = sed pattern to extract specific function or block
- Common patterns: `/function name/,/^}/p` for functions, `/class Name/,/^}/p` for classes

Examples:
```bash
# View a function from 2 commits ago
git show HEAD~2:main.js | sed -n '/async function generateThumbnail/,/^}/p'

# View a class definition
git show HEAD~1:renderer.js | sed -n '/class ClipManager/,/^}/p'

# View lines between two patterns
git show HEAD~1:main.js | sed -n '/START_MARKER/,/END_MARKER/p'
```

## Common Gotchas

- FFmpeg paths need `.replace('app.asar', 'app.asar.unpacked')` in packaged app
- Video files must be closed before deletion (use retry logic)
- Thumbnail validation uses epsilon comparison (0.001) for floating-point times
- Context isolation is disabled (`contextIsolation: false`) for Node.js integration
- All file operations should handle ENOENT errors gracefully
