// Runs `tauri dev` with CLIPDIP_PROFILE=1, cross-platform (used by the
// tauri:dev:profile npm script).
import { spawn } from "node:child_process";

// Node 22+ on Windows needs shell:true to spawn .cmd/.bat shims (CVE-2024-27980);
// this resolves npm via PATH like an interactive prompt.
const env = { ...process.env, CLIPDIP_PROFILE: "1" };
const child = spawn("npm run tauri:dev", { stdio: "inherit", env, shell: true });
child.on("exit", code => process.exit(code ?? 0));
child.on("error", err => {
  console.error("failed to spawn tauri:dev:", err);
  process.exit(1);
});
