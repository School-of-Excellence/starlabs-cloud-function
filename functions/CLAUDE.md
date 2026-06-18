# Project guide for Claude

- **Read `workflow.json` first, at the start of every session** — it is the single
  source of truth (workflow graph + status done/wip/next + file map/relationships).
- When scope, progress, or file relationships change, **update `workflow.json`** to
  reflect the full current state. Do not rely on the conversation to hold state.
