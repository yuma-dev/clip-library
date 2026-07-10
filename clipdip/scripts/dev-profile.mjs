// Run `tauri dev` with CLIPDIP_PROFILE=1 set, cross-platform.
// Used by the `tauri:dev:profile` npm script so devs don't have to
// remember the env-var syntax for their shell.
import { spawn } from "node:child_process";

// Node 22+ on Windows refuses to spawn .cmd/.bat shims directly without
// `shell: true` (CVE-2024-27980). Using shell mode here resolves npm via
// PATH the same way an interactive prompt does.
const env = { ...process.env, CLIPDIP_PROFILE: "1" };
const child = spawn("npm run tauri:dev", { stdio: "inherit", env, shell: true });
child.on("exit", code => process.exit(code ?? 0));
child.on("error", err => {
  console.error("failed to spawn tauri:dev:", err);
  process.exit(1);
});
