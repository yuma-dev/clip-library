import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { generateChangelog } from './changelog.mjs';
import { readPackageVersion, syncVersions } from './sync-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Cargo workspace: the target dir lives at the repo root, not src-tauri/.
const nsisDir = join(root, 'target', 'release', 'bundle', 'nsis');
const draftFile = join(root, 'RELEASE_DRAFT.md');

// --- CONFIG: auto-derived. If a derived value is wrong for this project, hard-code it here. ---
const tauriConf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const appTitle = tauriConf.productName ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const keyName = appTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const defaultSigningKeyPath = join(root, '.tauri', `${keyName}.key`);
const defaultSigningPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? `${keyName}-updater`;
const { githubOwner, githubRepo } = resolveGitHubSlug();
const githubSlug = `${githubOwner}/${githubRepo}`;
const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
// ----------------------------------------------------------------------------------------------

const defaultOptions = {
  build: true,
  draft: false,
  prerelease: false,
  skipTag: false,
};

function resolveGitHubSlug() {
  let url = '';
  try {
    url = execSync('git remote get-url origin', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    throw new Error('No git remote "origin". Create the GitHub repo first: gh repo create <owner>/<repo> --public --source=. --remote=origin --push');
  }
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) {
    throw new Error(`Could not parse a GitHub owner/repo from origin url: ${url}`);
  }
  return { githubOwner: m[1], githubRepo: m[2] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  requireGitHubAuth();

  await syncVersions();
  const version = await readPackageVersion();
  const tag = `v${version}`;

  if (!existsSync(defaultSigningKeyPath)) {
    throw new Error(`Missing signing key at ${defaultSigningKeyPath}. Generate it once: ${pm} exec tauri signer generate -w ${defaultSigningKeyPath} -p ${defaultSigningPassword} --force`);
  }

  const body = resolveReleaseNotes(version);
  console.log(`Release notes for ${tag} (${githubSlug})\n`);
  console.log(body);
  console.log();

  if (options.build) {
    await runBuild();
  }

  const artifacts = await findArtifacts(version);
  const stagedAssets = await stageReleaseAssets(artifacts);
  const latestJsonPath = await writeLatestJson({
    body,
    installerName: stagedAssets.installerName,
    signature: (await readFile(artifacts.signaturePath, 'utf8')).trim(),
    tag,
    version,
  });

  const notesFile = join(tmpdir(), `${keyName}-notes-${Date.now()}.md`);
  writeFileSync(notesFile, `${body}\n`, 'utf8');

  try {
    if (!options.skipTag) {
      ensureGitTag(tag);
    }

    publishGitHubRelease(tag, notesFile, [
      stagedAssets.installerPath,
      stagedAssets.signaturePath,
      latestJsonPath,
    ], options);
  } finally {
    unlinkSync(notesFile);
    await rm(stagedAssets.dir, { force: true, recursive: true });
  }

  if (existsSync(draftFile)) {
    unlinkSync(draftFile);
    console.log('RELEASE_DRAFT.md cleaned up.');
  }

  console.log(`Release ${tag} is ready on GitHub Releases.`);
}

function parseArgs(args) {
  const options = { ...defaultOptions };

  for (const arg of args) {
    switch (arg) {
      case '--draft':
        options.draft = true;
        break;
      case '--prerelease':
        options.prerelease = true;
        break;
      case '--skip-build':
        options.build = false;
        break;
      case '--skip-tag':
        options.skipTag = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireGitHubAuth() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    return;
  }

  console.error('Error: GH_TOKEN is not set.');
  console.error('Create a GitHub PAT with Contents: Read+Write and run:');
  console.error('  [System.Environment]::SetEnvironmentVariable("GH_TOKEN", "your_token", "User")');
  process.exit(1);
}

function resolveReleaseNotes(version) {
  if (existsSync(draftFile)) {
    console.log(`Using RELEASE_DRAFT.md for v${version}`);
    return readFileSync(draftFile, 'utf8').trim();
  }

  const changelog = generateChangelog(root);
  console.log(`Generated changelog: ${changelog.lastTag ?? '(beginning)'} -> v${version}`);
  return changelog.body;
}

async function runBuild() {
  console.log('Building signed NSIS updater artifacts...');
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: String(defaultSigningKeyPath),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: String(defaultSigningPassword),
  };

  // Invoke the tauri CLI directly. Do NOT use `<pm> run tauri build -- --bundles nsis`: pnpm forwards
  // the `--` into `tauri build`, which then hands `--bundles` to cargo ("unexpected argument").
  const [cmd, args] =
    pm === 'pnpm'
      ? ['pnpm', ['exec', 'tauri', 'build', '--bundles', 'nsis']]
      : ['npx', ['tauri', 'build', '--bundles', 'nsis']];

  await spawnCommand(cmd, args, { cwd: root, env });
}

async function findArtifacts(version) {
  const entries = await readdir(nsisDir, { withFileTypes: true });
  const installerName = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .find((name) => name.endsWith('-setup.exe') && name.includes(`_${version}_`));

  if (!installerName) {
    throw new Error(`Could not find NSIS installer for version ${version} in ${nsisDir}`);
  }

  const installerPath = join(nsisDir, installerName);
  const signaturePath = `${installerPath}.sig`;
  if (!existsSync(signaturePath)) {
    throw new Error(`Missing updater signature ${signaturePath}. Check createUpdaterArtifacts + signing config.`);
  }

  return { installerPath, signaturePath };
}

async function stageReleaseAssets(artifacts) {
  const dir = join(tmpdir(), `${keyName}-release-assets-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  const installerName = sanitizeGitHubAssetName(path.basename(artifacts.installerPath));
  const signatureName = `${installerName}.sig`;
  const installerPath = join(dir, installerName);
  const signaturePath = join(dir, signatureName);

  await Promise.all([
    copyFile(artifacts.installerPath, installerPath),
    copyFile(artifacts.signaturePath, signaturePath),
  ]);

  return {
    dir,
    installerName,
    installerPath,
    signaturePath,
  };
}

function sanitizeGitHubAssetName(name) {
  return name.replace(/\s+/g, '.');
}

async function writeLatestJson(context) {
  const latestJsonPath = join(nsisDir, 'latest.json');
  const payload = {
    version: context.version,
    notes: context.body,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: context.signature,
        url: githubReleaseAssetUrl(context.tag, context.installerName),
      },
    },
  };

  await writeFile(latestJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return latestJsonPath;
}

function githubReleaseAssetUrl(tag, assetName) {
  return `https://github.com/${githubSlug}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

function ensureGitTag(tag) {
  const localExists = commandSucceeds('git', ['rev-parse', '--verify', `refs/tags/${tag}`]);
  const remoteExists = commandSucceeds('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`]);

  if (!localExists && remoteExists) {
    runCommand('git', ['fetch', 'origin', 'tag', tag], { stdio: 'inherit' });
    return;
  }

  if (!localExists) {
    runCommand('git', ['tag', tag], { stdio: 'inherit' });
  }

  if (!remoteExists) {
    runCommand('git', ['push', 'origin', tag], { stdio: 'inherit' });
  }
}

function publishGitHubRelease(tag, notesFile, assets, options) {
  const exists = commandSucceeds('gh', ['release', 'view', tag, '--repo', githubSlug]);

  if (exists) {
    console.log(`Updating GitHub release ${tag}...`);
    runCommand('gh', ['release', 'upload', tag, ...assets, '--repo', githubSlug, '--clobber'], {
      stdio: 'inherit',
    });
    runCommand('gh', ['release', 'edit', tag, '--repo', githubSlug, '--title', `${appTitle} ${tag}`, '--notes-file', notesFile], {
      stdio: 'inherit',
    });
    return;
  }

  console.log(`Creating GitHub release ${tag}...`);
  const args = [
    'release',
    'create',
    tag,
    ...assets,
    '--repo',
    githubSlug,
    '--title',
    `${appTitle} ${tag}`,
    '--notes-file',
    notesFile,
  ];
  if (options.draft) {
    args.push('--draft');
  }
  if (options.prerelease) {
    args.push('--prerelease');
  }
  runCommand('gh', args, { stdio: 'inherit' });
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'ignore' });
  return result.status === 0;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: options.stdio ?? 'pipe',
    encoding: options.stdio === 'inherit' ? undefined : 'utf8',
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 0) !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }

  return result.stdout;
}

async function spawnCommand(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')], {
            cwd: options.cwd,
            env: options.env,
            stdio: 'inherit',
          })
        : spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: 'inherit',
          });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if ((code ?? 0) !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolvePromise();
    });

    child.on('error', reject);
  });
}

function quoteForCmd(value) {
  if (!/[ \t"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

main().catch((error) => {
  console.error(`[release] ${error.message}`);
  process.exitCode = 1;
});
