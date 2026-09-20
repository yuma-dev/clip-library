# Project documentation

Read `DEVELOPMENT.md` before changing commands or build behavior. `README.md`
describes the product. `AGENT.md` and `agents/` contain local architecture and
handoff notes when available; those files are ignored by Git.

For UI assets, staged interactions, transparent media, cursor animation, or
advertisement source material, read `ASSET-PIPELINE.md`. Use the existing
component exporter and `npm run assets`; keep generated files, local recipes
and source media under ignored `export-out/`. Never force-add those outputs.
The pipeline code and reusable documentation are tracked.

Keep documentation current with behavior changes. Update the root package
version after a change and run `node scripts/sync-clipdip-version.mjs` to keep
the recorder version aligned. Explain limitations when a staged scene differs
from production behavior; prefer sharing production components over copying UI.
