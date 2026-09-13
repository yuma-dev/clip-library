// Stops app and launcher instances running from dist/win-unpacked (benchmark and smoke
// launches) so electron-builder can replace the files. Never touches an
// installed ClipLib.
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "win-unpacked");
const script = `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${dist.replace(/'/g, "''")}', [System.StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force`;
try {
  execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
} catch {
  /* nothing running */
}
