# Agent Guide - Clip Library

**Welcome!** This is your entry point for working on the Clip Library project.

This guide will direct you to the right documentation based on your task. All agent-specific documentation is located in the `agents/` folder.

---

## 🚀 Quick Start: What Are You Here to Do?

### 1️⃣ Just Starting / First Time Here
**Read:** This file (you're already here!)
- Continue reading below for project overview
- Then check "Getting Oriented" section

### 2️⃣ Continuing Previous Work
**Read:** `agents/SESSION_SUMMARY.md` first
- Quick summary of last session
- What was done and what's next
- Current status and metrics

### 3️⃣ Testing & Committing (User Only)
**AI Agents:** Skip this. Your validation is done - hand off to user.
**User:** Use `agents/TESTING_CHECKLIST.md` to test the app

### 4️⃣ Fixing Bugs / Issues
**Read:** This file's "Architecture" section
- Understand the codebase structure
- Then use search/grep to find relevant code
- Check `agents/HANDOFF.md` for recent changes

### 5️⃣ Continuing Modularization
**Read:** `agents/RENDERER_MODULARIZATION_PLAN.md`
- Detailed plan for extracting remaining functions
- Time estimates and recommendations
- Implementation guides

### 6️⃣ Understanding Modularization Progress
**Read:** `agents/MODULARIZATION_PLAN.md`
- Complete history of modularization efforts
- What's been extracted and what remains
- Module responsibilities and dependencies

### 7️⃣ Taking Over from Another Agent
**Read:** `agents/HANDOFF.md`
- Complete session context
- What changed and why
- Current state and next steps

---

## 📁 Agent Documentation Map

All agent-specific docs are in the `agents/` folder:

| File | When to Read | Purpose |
|------|--------------|---------|
| **SESSION_SUMMARY.md** | Starting a session | Quick reference - what was done, what's next |
| **HANDOFF.md** | Taking over from another agent | Full context of last session + handoff info |
| **TESTING_CHECKLIST.md** | Before/after testing | Comprehensive test plan for clip-grid |
| **RENDERER_MODULARIZATION_PLAN.md** | Continuing modularization | Future extraction plans + recommendations |
| **MODULARIZATION_PLAN.md** | Understanding history | Complete modularization progress & history |
| **STATE-VALIDATION.md** | Working with state module | State management patterns (older doc) |

---

## 🗺️ Navigation Guide

### If You Need To...

**Understand the Project**
→ Read "Project Overview" section below

**Know What Was Just Done**
→ Read `agents/SESSION_SUMMARY.md`

**Test the App**
→ Follow `agents/TESTING_CHECKLIST.md`

**Continue Modularizing**
→ Read `agents/RENDERER_MODULARIZATION_PLAN.md`
→ Then run `node validate-renderer-modularization.js`

**Fix a Bug**
→ Read "Architecture" section below
→ Use grep/search to find relevant code
→ Check `agents/HANDOFF.md` for recent changes

**Understand Module Structure**
→ Read "Module Organization" section below
→ Check `agents/MODULARIZATION_PLAN.md` for details

**Debug Validation Errors**
→ Run `node validate-renderer-modularization.js`
→ Read output for specific violations
→ Check `agents/MODULARIZATION_PLAN.md` → "Validation Process"

**Commit Changes**
→ Check `agents/HANDOFF.md` → "Commit Message Template"
→ Run validation first: `node validate-renderer-modularization.js`
→ Test first: `agents/TESTING_CHECKLIST.md`

---

## 📊 Project Overview

### What is Clip Library?

Clip Library is an **Electron-based desktop application** for managing video clips. It's a replacement for SteelSeries GG Moments, allowing users to organize, trim, tag, and export video clips from any recording software (OBS Studio, etc.).

### Key Features
- Video clip management with thumbnail grid
- Tag-based organization
- Trim and export clips (video/audio)
- Keyboard shortcuts and gamepad support
- Discord Rich Presence integration
- Ambient glow effects (YouTube-style)
- Search and filtering

### Tech Stack
- **Framework:** Electron
- **Processes:** Main (Node.js) + Renderer (Chromium)
- **Video Processing:** FFmpeg with hardware acceleration
- **Storage:** File-based metadata + JSON configs
- **UI:** Custom HTML/CSS/JS (no framework)

---

## 🏗️ Architecture

### Process Structure

**Main Process** (`main.js` + `main/` modules)
- File system operations
- FFmpeg video processing
- Metadata management
- File watching
- IPC handlers

**Renderer Process** (`renderer.js` + `renderer/` modules)
- UI logic and interactions
- Video playback
- Tag management
- Search and filtering
- Grid rendering

**IPC Communication**
- Main ↔ Renderer via `ipcMain.handle` and `ipcRenderer.invoke`

### Module Organization

#### Main Process Modules (`main/`)
```
main/
├── ffmpeg.js           # Video encoding, export, FFprobe (~480 lines)
├── thumbnails.js       # Thumbnail generation, caching (~430 lines)
├── metadata.js         # .clip_metadata file I/O (~680 lines)
├── file-watcher.js     # Chokidar file watching
├── clips.js            # Clip list management
└── discord.js          # Discord Rich Presence
```

#### Renderer Process Modules (`renderer/`)
```
renderer/
├── clip-grid.js        # Grid rendering, clips, thumbnails (~1,425 lines) ⭐
├── video-player.js     # Video playback, controls (~2,129 lines)
├── tag-manager.js      # Tag operations, UI (~734 lines)
├── search-manager.js   # Search, filtering (~488 lines)
├── gamepad-manager.js  # Controller support (~538 lines)
├── settings-manager-ui.js # Settings UI (~378 lines)
├── state.js            # Centralized state (~301 lines)
├── grid-navigation.js  # Grid navigation (~210 lines)
├── export-manager.js   # Export operations (~147 lines)
└── keybinding-manager.js # Keyboard shortcuts (~102 lines)
```

#### Utility Modules (`utils/`)
```
utils/
├── logger.js           # Unified logging (shared by main + renderer)
├── settings-manager.js # Settings persistence
└── activity-tracker.js # Usage analytics
```

**Current State:**
- `main.js`: ~1,070 lines (52% reduction from original)
- `renderer.js`: ~3,714 lines (54% reduction from original)
- **11 renderer modules** created
- **3 main modules** created
- **92 functions** remaining in renderer.js

---

## 🎯 Current Status (2026-02-02)

### ✅ What's Complete
- Core renderer modularization (54% reduction)
- Clip grid module extraction and fix
- Video player, tags, search, export modules
- All validation checks pass (0 violations)

### 🔧 What's In Progress
- Optional: Further renderer.js modularization (see `agents/RENDERER_MODULARIZATION_PLAN.md`)

### ⚠️ Critical Context
**A previous AI broke the clip-grid modularization** by removing critical initialization logic from `loadClips()`. This was fixed in the last session (2026-02-02). See `agents/HANDOFF.md` for details.

**Key Fix:** Restored complete `loadClips()` function that actually renders clips to the DOM (was showing 0 clips despite loading 1670).

---

## 🚨 Important Patterns & Rules

### 1. Validation is Mandatory
**Always run before committing:**
```bash
node validate-renderer-modularization.js
```

**Goal:** 0 violations
- No duplicate functions
- No circular dependencies
- No direct calls to extracted functions

### 2. Atomic File Writes
For metadata saves, use atomic writes:
```javascript
await writeFileAtomically(filePath, data);
```

### 3. Activity Logging
Log all user actions for analytics:
```javascript
const { logActivity } = require('./activity-tracker');
logActivity('action-name', { data });
```

### 4. IPC Pattern
Main process handlers:
```javascript
ipcMain.handle('handler-name', async (event, ...args) => {
  // Logic here
  return result;
});
```

Renderer calls:
```javascript
const result = await ipcRenderer.invoke('handler-name', arg1, arg2);
```

### 5. Dependency Injection
Pass functions/getters, not global state:
```javascript
// Good
module.init({ loadSettings, getState, showAlert });

// Bad
module.init({ settings, state }); // These change over time!
```

### 6. Module Exports
Only export what's needed:
```javascript
module.exports = {
  init,
  publicFunction1,
  publicFunction2
  // privateHelper stays private
};
```

---

## 📝 Development Commands

### Running the App
```bash
npm start                    # Start in dev mode
npm run build               # Build production installer
```

### Validation & Testing
```bash
node validate-renderer-modularization.js  # Check for violations
npm start                                  # Manual testing
```

### Benchmarking
```bash
npm run benchmark           # Run all benchmarks
npm run benchmark:verbose   # Detailed output
npm run benchmark:openclip  # Profile clip opening
```

### Debugging
```bash
# View function from previous commit
git show HEAD~1:renderer.js | sed -n '/function loadClips/,/^}/p'

# Count lines in files
wc -l renderer.js renderer/clip-grid.js

# Search for function definition
grep -n "function loadClips" renderer/clip-grid.js
```

---

## 🗂️ Data Storage Locations

**Clip Metadata** (stored per-clip in clip folder):
- `{clipLocation}/.clip_metadata/{clipName}.customname`
- `{clipLocation}/.clip_metadata/{clipName}.trim`
- `{clipLocation}/.clip_metadata/{clipName}.tags`
- `{clipLocation}/.clip_metadata/{clipName}.speed`
- `{clipLocation}/.clip_metadata/{clipName}.volume`
- `{clipLocation}/.clip_metadata/{clipName}.volumerange`
- `{clipLocation}/.clip_metadata/{clipName}.date`
- `{clipLocation}/.clip_metadata/{clipName}.gameinfo`

**User Data** (in Electron userData directory):
- `settings.json` - App settings
- `global_tags.json` - All available tags
- `tagPreferences.json` - Tag filter preferences
- `last-clips.json` - For detecting new clips
- `thumbnail-cache/` - MD5-hashed thumbnails + `.jpg.meta` files
- `logs/` - Application logs

---

## 🎓 Key Concepts

### Modularization Principles
1. **Single Responsibility** - Each module does ONE thing
2. **Dependency Injection** - Pass functions, not state
3. **Thin IPC Layer** - main.js registers handlers, modules contain logic
4. **No Circular Dependencies** - One-way dependency flow
5. **Explicit Exports** - Only export what's needed
6. **Preserve Analytics** - Don't remove `logActivity()` calls

### Module Communication
Modules communicate through:
1. **Dependency injection** during `init()`
2. **Exported functions** called by parent
3. **IPC** for main ↔ renderer
4. **State module** for shared state (renderer only)

### State Management
- **Main process:** Local variables in modules
- **Renderer process:** Centralized in `renderer/state.js`
- **Access pattern:** `state.getXxx()` and `state.setXxx()`

---

## 🐛 Common Gotchas

### FFmpeg in Production
FFmpeg paths need special handling in packaged app:
```javascript
.replace('app.asar', 'app.asar.unpacked')
```

### Video File Locking
Video files must be closed before deletion. Use retry logic.

### Thumbnail Validation
Uses epsilon comparison (0.001) for floating-point trim times.

### Context Isolation
Disabled in this app (`contextIsolation: false`) for Node.js integration.

### File Operations
Always handle `ENOENT` errors gracefully - files may not exist.

### Trim Point Precision
Thumbnail validation compares trim points with 0.001 epsilon to handle floating-point imprecision.

---

## 📚 Additional Resources

### For Humans
- **README.md** - Project README for end users

### For Agents (in `agents/` folder)
- **SESSION_SUMMARY.md** - Quick start for new sessions
- **HANDOFF.md** - Complete session context
- **TESTING_CHECKLIST.md** - Test plans
- **RENDERER_MODULARIZATION_PLAN.md** - Future work
- **MODULARIZATION_PLAN.md** - Complete history
- **STATE-VALIDATION.md** - State patterns (older)

### Code References
When mentioning functions or code, use the pattern:
```
functionName() at file.js:123
```

Example: `loadClips() at renderer/clip-grid.js:69`

---

## 🎯 Decision Tree: What Should I Read?

```
Start Here
│
├─ First time / Getting oriented?
│  └─ Read this file (AGENT.md) fully
│
├─ Continuing from previous session?
│  └─ Read: agents/SESSION_SUMMARY.md
│
├─ Taking over from another agent?
│  └─ Read: agents/HANDOFF.md
│
├─ Need to test the app?
│  └─ Read: agents/TESTING_CHECKLIST.md
│
├─ Continuing modularization work?
│  ├─ Read: agents/RENDERER_MODULARIZATION_PLAN.md
│  └─ Run: node validate-renderer-modularization.js
│
├─ Fixing a bug?
│  ├─ Read: This file's Architecture section
│  ├─ Check: agents/HANDOFF.md for recent changes
│  └─ Search: Use grep to find relevant code
│
├─ Need modularization history?
│  └─ Read: agents/MODULARIZATION_PLAN.md
│
└─ Working with state management?
   └─ Read: agents/STATE-VALIDATION.md
```

---

## ✅ Before You Start Coding

1. **Understand the task** - What are you trying to accomplish?
2. **Read the right docs** - Use decision tree above
3. **Check current state** - Run validation script
4. **Understand context** - Read recent session docs
5. **Plan your approach** - Don't jump straight to coding

---

## ✅ Before Handing Off to User

**AI Agents:** Prepare the code, validate, document. Do NOT test or commit.
**User:** You test the app and commit if it works.

**AI Agent Checklist:**
1. **Run validation** - `node validate-renderer-modularization.js` - Must show 0 violations
2. **Update documentation** - Update relevant docs with what you changed
3. **Prepare handoff** - Document what was done, what to test, what's next
4. **Provide commit message** - Write a commit message for the user to use

**User Checklist:**
- Test the app (`npm start`) using agents/TESTING_CHECKLIST.md
- Review changes (`git diff`)
- Commit if tests pass

---

## 🚀 Quick Reference Commands

```bash
# Development
npm start                              # Run app
node validate-renderer-modularization.js  # Validate

# Git
git status                             # Check status
git diff renderer.js                   # View changes
git add .                              # Stage all
git commit -m "message"                # Commit

# File Operations
ls -la agents/                         # List agent docs
cat agents/SESSION_SUMMARY.md          # Quick read
grep -r "function name" .              # Search code

# Debugging
wc -l renderer.js                      # Count lines
git show HEAD~1:renderer.js | head -50 # View old version
```

---

## 📞 When Things Go Wrong

### App Won't Start
1. Check console for errors
2. Verify all modules are properly exported/imported
3. Run validation script
4. Check `agents/HANDOFF.md` for recent breaking changes

### Validation Fails
1. Read the validation output carefully
2. Look for duplicate functions or circular deps
3. Check `agents/MODULARIZATION_PLAN.md` → "Validation Process"
4. Fix violations one at a time

### Tests Fail
1. Check console for specific errors
2. Use `agents/TESTING_CHECKLIST.md` → Console Checks section
3. Compare with expected output in `agents/HANDOFF.md`
4. Check if issue existed before your changes (git stash + test)

### Lost Context
1. Read `agents/SESSION_SUMMARY.md` for quick context
2. Read `agents/HANDOFF.md` for full session details
3. Check `agents/MODULARIZATION_PLAN.md` for history

---

## 💡 Pro Tips

1. **Always validate first** - Before starting work, run the validation script
2. **Read recent docs** - Check SESSION_SUMMARY.md before diving in
3. **Test incrementally** - Test after each small change
4. **Commit often** - Small, working commits are better than big broken ones
5. **Document decisions** - Update relevant docs as you work
6. **Use the validation script** - It's your best friend
7. **Follow established patterns** - Don't invent new module structures
8. **Preserve analytics** - Never remove `logActivity()` calls

---

## 🎓 Learning Path

**If you're new to this codebase:**

1. Read this file (AGENT.md) fully ← You are here
2. Skim `agents/MODULARIZATION_PLAN.md` to understand history
3. Read "Architecture" section above carefully
4. Look at one existing module (e.g., `renderer/tag-manager.js`)
5. Understand the init() pattern and dependency injection
6. Run `npm start` and explore the app
7. Run validation script to see current state
8. Read `agents/SESSION_SUMMARY.md` for recent context

**Now you're ready to work!** 🚀

---

## 📋 Checklist for AI Agents

- [ ] Read AGENT.md (this file)
- [ ] Understand what task you're doing
- [ ] Read the appropriate doc from `agents/` folder
- [ ] Run validation script to check current state
- [ ] Plan your approach before coding
- [ ] Make changes incrementally
- [ ] Run validation after changes (must show 0 violations)
- [ ] Update relevant docs with what you changed
- [ ] Prepare handoff with commit message
- [ ] **STOP - Hand off to user for testing/committing**

**User will:**
- [ ] Test the app using agents/TESTING_CHECKLIST.md
- [ ] Review changes
- [ ] Commit if tests pass
- [ ] Delete testing checklist when done

---

**You're all set!** Use the decision tree above to find the right documentation for your specific task.

**Remember:** All agent-specific docs are in `agents/` folder. This file is just the navigation hub.

Good luck! 🎉
