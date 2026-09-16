#!/usr/bin/env node
'use strict';
// Checks that updating keeps the desktop/start-menu shortcuts and taskbar pin
// and that the app repoints them at the native launcher: install OLD silently
// plant a taskbar pin like Windows would (target = installed ClipLib.exe
// tagged with the app's AppUserModelID), install NEW silently, then launch
// once so pin repair runs.
//
//   node benchmark/verify-update-shortcuts.js --old "path\to\ClipLib Setup 3.3.0.exe" --new "dist\ClipLib Setup 3.5.1.exe"
//
// touches the real install (%LOCALAPPDATA%\Programs\Clips) and taskbar pin folder

const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? path.resolve(args[i + 1]) : null;
};
const oldInstaller = opt('--old');
const newInstaller = opt('--new');
if (!oldInstaller || !newInstaller) throw new Error('--old and --new installers required');

const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Clips');
const pinDir = path.join(process.env.APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
const pinLnk = path.join(pinDir, 'ClipLib.lnk');
const desktopLnk = path.join(process.env.USERPROFILE, 'Desktop', 'ClipLib.lnk');
const startLnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ClipLib.lnk');

const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd]).toString().trim();
const lnkTarget = (lnk) => (fs.existsSync(lnk) ? ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}').TargetPath`) : '(absent)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stopApp() {
  const clipdip = path.join(installDir, 'resources', 'clipdip', 'clipdip.exe');
  if (fs.existsSync(clipdip)) spawnSync(clipdip, ['--quit'], { stdio: 'ignore' });
  for (const image of ['ClipLib.exe', 'ClipLib App.exe', 'ClipLib Launcher.exe']) {
    spawnSync('taskkill', ['/IM', image, '/F', '/T'], { stdio: 'ignore' });
  }
}

function install(installer) {
  console.log(`installing ${path.basename(installer)} ...`);
  const r = spawnSync(installer, ['/S'], { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`installer exit ${r.status}`);
}

function report(stage) {
  console.log(`\n[${stage}]`);
  console.log(`  version   ${fs.existsSync(path.join(installDir, 'ClipLib.exe')) ? ps(`(Get-Item '${path.join(installDir, 'ClipLib.exe')}').VersionInfo.ProductVersion`) : '(no ClipLib.exe)'}`);
  console.log(`  launcher  ${fs.existsSync(path.join(installDir, 'ClipLib Launcher.exe')) ? 'present' : 'absent'}`);
  console.log(`  desktop   ${lnkTarget(desktopLnk)}`);
  console.log(`  start     ${lnkTarget(startLnk)}`);
  console.log(`  pin       ${lnkTarget(pinLnk)}`);
}

async function main() {
  stopApp();
  await sleep(1500);
  install(oldInstaller);
  await sleep(1500);
  report('after old install');

  // mimic how Windows plants a pin: .lnk in the taskbar folder targeting the exe, tagged with the AUMID
  const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const script = path.join(root, 'benchmark', 'results', 'make-pin.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `
    const { app, shell } = require('electron');
    app.whenReady().then(() => {
      const ok = shell.writeShortcutLink(${JSON.stringify(pinLnk)}, 'create', {
        target: ${JSON.stringify(path.join(installDir, 'ClipLib.exe'))},
        cwd: ${JSON.stringify(installDir)},
        icon: ${JSON.stringify(path.join(installDir, 'ClipLib.exe'))},
        iconIndex: 0,
        appUserModelId: 'com.yuma-dev.clips',
      });
      process.stdout.write(ok ? 'pin created\\n' : 'pin failed\\n');
      app.quit();
    });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(execFileSync(electron, [script], { env }).toString().trim());
  report('pin planted');

  install(newInstaller);
  await sleep(2000);
  report('after new install');
  const pinSurvived = fs.existsSync(pinLnk);
  const desktopOk = lnkTarget(desktopLnk).endsWith('ClipLib Launcher.exe');
  const startOk = lnkTarget(startLnk).endsWith('ClipLib Launcher.exe');

  // Launch once so repairTaskbarPins moves the pin to the launcher.
  const launcher = path.join(installDir, 'ClipLib Launcher.exe');
  const child = spawn(fs.existsSync(launcher) ? launcher : path.join(installDir, 'ClipLib.exe'), [], { detached: true, stdio: 'ignore' });
  child.unref();
  await sleep(9000);
  report('after first launch');
  const pinTarget = lnkTarget(pinLnk);
  const pinRetargeted = pinTarget.endsWith('ClipLib Launcher.exe');
  const logsDir = path.join(process.env.APPDATA, 'Clips', 'logs');
  const latest = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log')).map((f) => path.join(logsDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const log = latest ? fs.readFileSync(latest, 'utf8') : '';
  const repairLine = (log.match(/Repaired orphaned taskbar pin[^\n]*/) || [''])[0];
  console.log(`  log       ${repairLine || '(no pin repair line)'}`);

  console.log('');
  for (const [name, ok] of [['pin survives update', pinSurvived], ['desktop shortcut targets launcher', desktopOk], ['start menu shortcut targets launcher', startOk], ['pin retargeted to launcher on first launch', pinRetargeted]]) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }
  process.exitCode = pinSurvived && desktopOk && startOk && pinRetargeted ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
