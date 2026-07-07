#!/usr/bin/env node
/**
 * Launches Electron with the startup performance trace armed
 * (CLIPS_PERF_STARTUP=1) — used by `npm run dev:trace`.
 *
 * Dep-free + cross-platform: `require('electron')` resolves to the Electron
 * executable path, so we set the env var here and spawn it, avoiding cross-env
 * and the OS-specific `VAR=1 cmd` syntax that npm scripts can't do portably.
 */
'use strict';

const { spawn } = require('child_process');
const electron = require('electron'); // path to the electron binary

process.env.CLIPS_PERF_STARTUP = '1';

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
