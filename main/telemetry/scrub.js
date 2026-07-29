// Path scrubbing for anything free-text that leaves the machine.
//
// TWO rules, and the second one matters more than the first.
//
// `scrubUserPaths` is the port of clipdip's scrub_user_paths
// (clipdip/crates/diagnostics/src/lib.rs:827). It masks ONLY the segment after
// `C:\Users\`, which is nowhere near enough on its own: a user whose clips live
// at `D:\Games\Clips\...` has nothing masked, and Node fs errors embed the full
// operand path, so `ENOENT: ... open 'D:\Games\Clips\Valorant 2026-07-28.mp4'`
// would ship the game name and the clip name intact.
//
// `redactPaths` therefore replaces every absolute path with `<drive>:\<path>`,
// keeping the drive letter (useful, and not identifying) and discarding every
// folder and file name. It is applied to all outgoing messages and to log tails.
// TELEMETRY.md documents what survives it: bare file names written without a
// directory, and tag text, neither of which a regex can safely remove.
//
// Rewrites `C:\Users\<name>` to `C:\Users\<home>`, preserving the drive letter,
// the separator style and the casing of "Users". The segment after the
// separator is dropped up to the next path separator, whitespace or quote.
//
// cliplib applies this to every outgoing `message` AND to log tails before they
// are compressed. clipdip does not scrub its tails; that difference is
// deliberate (see docs/telemetry-cliplib-api.md).

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

// Windows paths contain spaces constantly ("Counter-Strike 2", "Apex Legends"),
// so a run that stops at whitespace leaks most of the interesting part. Consume
// to a quote, a closing paren, or end of line instead. fs errors quote their
// operand and stack frames parenthesise theirs, so those terminate precisely;
// an unquoted path consumes the rest of the line, which over-redacts and is the
// correct direction to err in.
const PATH_TAIL = "[^'\"\\r\\n)|>]*";
const DRIVE_PATH = new RegExp(`([A-Za-z]):[\\\\/]${PATH_TAIL}`, 'g');
const UNC_PATH = new RegExp(`\\\\\\\\${PATH_TAIL}`, 'g');

/**
 * Replace absolute paths with `<drive>:\<path>`, keeping the drive letter
 * (useful for correlating disk problems, not identifying) and discarding every
 * folder and file name after it. UNC paths lose the host and share too.
 */
function redactPaths(input) {
  if (typeof input !== 'string' || input.length < 3) return input;
  return input
    .replace(UNC_PATH, '<unc>')
    .replace(DRIVE_PATH, (_match, drive) => `${drive}:\\<path>`);
}

/**
 * Both rules. redactPaths runs FIRST: running the user-path rule first would
 * insert a `<home>` marker that the path rule then terminates on, leaving the
 * rest of the path exposed.
 */
function scrubText(input) {
  return scrubUserPaths(redactPaths(input));
}

module.exports = { scrubUserPaths, redactPaths, scrubText };
