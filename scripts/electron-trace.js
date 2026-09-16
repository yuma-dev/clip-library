#!/usr/bin/env node
// Arms the startup perf trace (CLIPS_PERF_STARTUP=1) for `npm run dev:trace`.
// require('electron') resolves to the binary path, so we set the env var and
// spawn it here, avoiding cross-env and npm's non-portable `VAR=1 cmd` syntax.
'use strict';

const { spawn } = require('child_process');
const electron = require('electron'); // path to the electron binary

process.env.CLIPS_PERF_STARTUP = '1';

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => process.exit(code == null ? 0 : code));
