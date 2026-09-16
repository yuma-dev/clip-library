// Path scrubbing for anything free-text that leaves the machine, two passes.
// scrubUserPaths ports clipdip's scrub_user_paths (clipdip/crates/diagnostics/src/lib.rs:827) but only masks
// after C:\Users\, so redactPaths below also strips every other absolute path (fs errors embed full paths).
// Applied to outgoing messages and log tails; clipdip does not scrub its tails
// (docs/telemetry-cliplib-api.md).

const TERMINATORS = new Set(['\\', '/', '"', "'", ' ', '\t', '\n', '\r']);

function isUsersPrefix(s, i) {
  // <alpha> ':' ('\'|'/') 'Users' ('\'|'/')  == 9 chars
  if (i + 9 > s.length) return false;
  const drive = s[i];
  if (!/[a-zA-Z]/.test(drive)) return false;
  if (s[i + 1] !== ':') return false;
  const sep1 = s[i + 2];
  if (sep1 !== '\\' && sep1 !== '/') return false;
  if (s.slice(i + 3, i + 8).toLowerCase() !== 'users') return false;
  const sep2 = s[i + 8];
  return sep2 === '\\' || sep2 === '/';
}

function scrubUserPaths(input) {
  if (typeof input !== 'string' || input.length < 9) return input;
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (isUsersPrefix(input, i)) {
      out += input.slice(i, i + 9); // keep drive, separators and "Users" casing
      out += '<home>';
      i += 9;
      while (i < input.length && !TERMINATORS.has(input[i])) i += 1;
      continue;
    }
    out += input[i];
    i += 1;
  }
  return out;
}

// Windows paths contain spaces ("Counter-Strike 2"), so stopping at whitespace would leak most of it.
// Consume to a quote/paren/EOL instead; an unquoted path over-redacts the rest of the line, which is fine.
const PATH_TAIL = "[^'\"\\r\\n)|>]*";
const DRIVE_PATH = new RegExp(`([A-Za-z]):[\\\\/]${PATH_TAIL}`, 'g');
const UNC_PATH = new RegExp(`\\\\\\\\${PATH_TAIL}`, 'g');

/** Replaces absolute paths with `<drive>:\<path>`: keeps the drive letter, drops every folder/file name.
 * UNC paths lose the host and share too. */
function redactPaths(input) {
  if (typeof input !== 'string' || input.length < 3) return input;
  return input
    .replace(UNC_PATH, '<unc>')
    .replace(DRIVE_PATH, (_match, drive) => `${drive}:\\<path>`);
}

/** redactPaths runs first: doing it after scrubUserPaths would terminate on the `<home>` marker it inserts,
 * leaving the rest of the path exposed. */
function scrubText(input) {
  return scrubUserPaths(redactPaths(input));
}

module.exports = { scrubUserPaths, redactPaths, scrubText };
