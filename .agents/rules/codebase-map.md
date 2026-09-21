---
trigger: always_on
description: Points the agent to the repo's CODEBASE_MAP.md so it never re-explores or forgets code between sessions.
---

# Read the codebase map first

This repo maintains a Graft-style codebase map at [CODEBASE_MAP.md](file:///d:/Successwa/CODEBASE_MAP.md).

- **At the start of a session, or whenever you're unsure where something lives, open `CODEBASE_MAP.md` first** instead of re-exploring blind. It lists every page, API endpoint (with line numbers), DB table, helper, run/test rules, and current project status.
- **Keep it fresh.** Whenever you add, rename, move, or delete an endpoint, DB table, page, feature, or important helper, update the matching row in `CODEBASE_MAP.md` in the same change.
- Trust the map for orientation, but verify exact code with `view_file` / `Select-String` before editing — line numbers can drift.
