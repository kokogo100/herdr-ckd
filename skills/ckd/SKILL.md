---
name: ckd
description: Delegate tasks to the Herdr CKD MCP server (ckd_multi_run, ckd_ui_control, ckd_configure, etc.) when the user invokes "/ckd <task>" or asks to run with Herdr CKD.
---

# Working with Herdr CKD (Autonomous IDE Control & Multi-Thread Orchestrator)

Delegate tasks requested via `/ckd` or natural language ("Run this with Herdr CKD") to the Herdr CKD MCP server.

## 1. Job Execution & `max_rounds` Rules
1. Determine the target workspace directory (use the current project's absolute path if unspecified).
2. Call `ckd_multi_run` (or `ckd_run` for single-thread) with `request` (verbatim user request—never summarize or alter) and `workspace`.
   - If the user specifies an explicit round limit (e.g., "in 10 rounds", "10회로", "max 3 rounds"), pass that integer as `max_rounds` and strip only the round-count phrase from `request`.
   - If the user does NOT specify a round count, 횟수를 말하지 않았으면 `max_rounds`를 넘기지 않습니다 (do NOT pass `max_rounds`; let it run until `A`, `B`, and `C` all declare completion). Inform the user in one line that they can ask to stop anytime.
   - Pass any attached images, sketches, screenshots, or office/PDF documents via `attachments`.
3. Poll or inspect progress using `ckd_multi_status` (`include_diff: true` available) or `ckd_status`.
4. When status reaches `awaiting_review`, inspect the result and call `ckd_multi_review` (`decision: "accept"` or `"rework"`).
5. Report `failed` or `stopped` reasons verbatim; on `limit_reached`, report what succeeded/remained and ask whether to continue.
6. Call `ckd_multi_stop` if the user asks to stop, and `ckd_feedback` (`correct` | `partial` | `incorrect`) to lock `training_label` in `finetune/curated.jsonl`.

## 2. Live UI Control & Configuration (`ckd_ui_control`, `ckd_configure`)
- **`ckd_ui_control`**: Operate the open Dashboard UI in real time (`set_form`, `select_job`, `set_filter`, `set_search`, `zoom_unit`, `toggle_diff`, `apply_preset`, `get_soul_and_catalog`).
- **`ckd_configure`**: View or update `uiHost` (`127.0.0.1` default), `uiPort` (`37501` default), Core Leader `C` and shared Worker `A·B` models/URLs/API keys (including Hybrid Cloud+Local mode), `customRules`, Low-VRAM `parallelUnits`, `defaultWorkspace`, `maxUnits`, GitHub branch auto-cleanup, and FIFO log retention.
- **`ckd_check_models`** / **`ckd_cleanup_logs`**: Probe `C` and `A·B` model servers or run immediate FIFO log cleanup.
