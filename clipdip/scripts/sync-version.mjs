import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
// Cargo workspace: the version lives in [workspace.package] at the repo
// root and every crate (incl. src-tauri) inherits it via version.workspace.
const cargoTomlPath = path.join(rootDir, 'Cargo.toml');
const cargoLockPath = path.join(rootDir, 'Cargo.lock');
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

export async function readPackageVersion() {
  const packageJsonRaw = await readFile(packageJsonPath, 'utf8');
  return JSON.parse(packageJsonRaw).version;
}

export async function syncVersions() {
  const version = await readPackageVersion();
  const [cargoTomlRaw, cargoLockRaw, tauriConfigRaw] = await Promise.all([
    readFile(cargoTomlPath, 'utf8'),
    readFile(cargoLockPath, 'utf8').catch(() => null),
    readFile(tauriConfigPath, 'utf8'),
  ]);

  // Workspace Cargo.toml: the first `version = "..."` line is
  // [workspace.package] version (it precedes [workspace.dependencies]).
  const nextCargoToml = cargoTomlRaw.replace(/^version = "([^"]+)"/m, `version = "${version}"`);

  // Cargo.lock: bump every clipdip* workspace crate (they all share the
  // workspace version).
  let nextCargoLock = cargoLockRaw;
  if (cargoLockRaw) {
    nextCargoLock = cargoLockRaw.replace(
      /(name = "clipdip[a-z-]*"\nversion = ")([^"]+)(")/g,
      `$1${version}$3`,
    );
  }

  const tauriConfig = JSON.parse(tauriConfigRaw);
  tauriConfig.version = version;
  const nextTauriConfigRaw = `${JSON.stringify(tauriConfig, null, 2)}\n`;

  await Promise.all([
    nextCargoToml === cargoTomlRaw ? Promise.resolve() : writeFile(cargoTomlPath, nextCargoToml, 'utf8'),
    !nextCargoLock || nextCargoLock === cargoLockRaw
      ? Promise.resolve()
      : writeFile(cargoLockPath, nextCargoLock, 'utf8'),
    nextTauriConfigRaw === tauriConfigRaw
      ? Promise.resolve()
      : writeFile(tauriConfigPath, nextTauriConfigRaw, 'utf8'),
  ]);

  return version;
}

async function main() {
  const version = await syncVersions();
  console.log(`Synced Cargo.toml, Cargo.lock and tauri.conf.json to ${version}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sync-version] ${error.message}`);
    process.exitCode = 1;
  });
}
