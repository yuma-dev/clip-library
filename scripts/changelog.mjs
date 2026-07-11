import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function generateChangelog(root) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

  let lastTag;
  try {
    lastTag = execSync('git describe --tags --match "v[0-9]*" --abbrev=0', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    lastTag = null;
  }

  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
  const raw = execSync(`git log ${range} --pretty=format:%s`, {
    cwd: root,
    encoding: 'utf8',
  }).trim();

  const noise = /^(bump\s|merge\s|release\s|initial commit)/i;
  const commits = raw
    .split('\n')
    .map((subject) => subject.trim())
    .filter((subject) => subject && !noise.test(subject));

  const fixRe = /^(fix|bug|resolve|revert|patch)\b/i;
  const improveRe = /^(polish|update|improve|refactor|rework|tweak|enhance|clean|remove|change)\b/i;

  const features = [];
  const improvements = [];
  const fixes = [];

  for (const commit of commits) {
    if (fixRe.test(commit)) {
      fixes.push(commit);
    } else if (improveRe.test(commit)) {
      improvements.push(commit);
    } else {
      features.push(commit);
    }
  }

  const section = (title, items) =>
    items.length ? `### ${title}\n${items.map((item) => `- ${item}`).join('\n')}` : '';

  const body =
    [
      section("What's new", features),
      section('Improvements', improvements),
      section('Bug fixes', fixes),
    ]
      .filter(Boolean)
      .join('\n\n') || 'No notable changes.';

  return { version, lastTag, body };
}
