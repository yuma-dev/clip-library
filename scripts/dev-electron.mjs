// npm run dev goes through the native launcher when it is built, so the splash and its handoff
// show in dev too. plain electron otherwise (fresh clone, no cargo build yet)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const launcher = path.join(root, 'clipdip', 'target', 'release', 'cliplib-launcher.exe');
// in dev the launcher waits for electron, so a quick exit means it never started it: a launcher
// built from older code (a release build of a commit without dev mode) looks for ClipLib.exe
// next to itself and quits
const STALE_MS = 3000;

const plain = () => {
  const child = spawn(electron, ['.'], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
};

if (!fs.existsSync(launcher)) plain();
else {
  const started = Date.now();
  const child = spawn(launcher, [], { stdio: 'inherit', env: { ...process.env, CLIPLIB_DEV_APP: electron, CLIPLIB_DEV_APP_DIR: root } });
  child.on('exit', (code) => {
    if (Date.now() - started > STALE_MS) process.exit(code ?? 0);
    console.log('launcher quit without starting the app (stale build? npm run build:launcher), starting electron without the splash');
    plain();
  });
}
