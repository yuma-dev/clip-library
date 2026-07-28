// One-command GitHub release for ClipLib (ported from clipdip's release flow).
//
//   npm run release:preview   -> generates RELEASE_DRAFT.md from commits; edit it
//   npm run release           -> build + tag + GitHub release with the installer
//
// Flags: --draft, --prerelease, --skip-build, --skip-tag
//
// INVARIANT (updater back-compat): every release must contain exactly ONE
// .exe asset — the shipped updater (2.1.0 and later) picks any non-blockmap,
// non-delta .exe from the latest release. Never attach a second exe.
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { generateChangelog } from './changelog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const draftFile = join(root, 'RELEASE_DRAFT.md');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const appTitle = pkg.build?.productName ?? pkg.displayName ?? pkg.name;
const { githubOwner, githubRepo } = resolveGitHubSlug();
const githubSlug = `${githubOwner}/${githubRepo}`;

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
    throw new Error('No git remote "origin".');
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

  const version = pkg.version;
  const tag = `v${version}`;

  const body = resolveReleaseNotes(version);
  console.log(`Release notes for ${tag} (${githubSlug})\n`);
  console.log(body);
  console.log();

  if (options.build) {
    console.log('Building (renderer + clipdip + installer)...');
    await spawnCommand('npm', ['run', 'build'], { cwd: root, env: process.env });
  }

  const installerPath = join(root, 'dist', `${appTitle} Setup ${version}.exe`);
  if (!existsSync(installerPath)) {
    throw new Error(`Installer not found: ${installerPath}. Run without --skip-build or check the build.`);
  }

  // GitHub replaces spaces in asset names anyway — stage with a clean name so
  // the URL is predictable. Still exactly one exe.
  const stageDir = join(tmpdir(), `cliplib-release-${Date.now()}`);
  await mkdir(stageDir, { recursive: true });
  const assetName = `${appTitle}.Setup.${version}.exe`;
  const stagedInstaller = join(stageDir, assetName);
  await copyFile(installerPath, stagedInstaller);

  const notesFile = join(tmpdir(), `cliplib-notes-${Date.now()}.md`);
  writeFileSync(notesFile, `${body}\n`, 'utf8');

  try {
    if (!options.skipTag) {
      ensureGitTag(tag);
    }
    publishGitHubRelease(tag, notesFile, [stagedInstaller], options);
  } finally {
    unlinkSync(notesFile);
    await rm(stageDir, { force: true, recursive: true });
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
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return;
  if (commandSucceeds('gh', ['auth', 'status'])) return;
  console.error('Error: not authenticated with GitHub.');
  console.error('Either run `gh auth login`, or set GH_TOKEN to a PAT with Contents: Read+Write.');
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
  const args = ['release', 'create', tag, ...assets, '--repo', githubSlug, '--title', `${appTitle} ${tag}`, '--notes-file', notesFile];
  if (options.draft) args.push('--draft');
  if (options.prerelease) args.push('--prerelease');
  runCommand('gh', args, { stdio: 'inherit' });
}

// With shell:true, Node concatenates args unquoted (see DEP0190), so an arg
// with a space ("ClipLib v3.1.0") splits into two. Quote anything unsafe.
function shellQuote(args) {
  if (process.platform !== 'win32') return args;
  return args.map((arg) => (/[\s"^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, shellQuote(args), { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' });
  return result.status === 0;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, shellQuote(args), {
    cwd: root,
    env: process.env,
    stdio: options.stdio ?? 'pipe',
    encoding: options.stdio === 'inherit' ? undefined : 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if ((result.status ?? 0) !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return result.stdout;
}

async function spawnCommand(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`${command} exited with signal ${signal}`));
      if ((code ?? 0) !== 0) return reject(new Error(`${command} exited with code ${code}`));
      resolvePromise();
    });
    child.on('error', reject);
  });
}

main().catch((error) => {
  console.error(`[release] ${error.message}`);
  process.exitCode = 1;
});
