# 📚 Herdr CKD : CATALOG.md (Heterogeneous AI Presets · GPU Profiles · UI Control Catalog)

> **Created by AXNli Inc. (`주식회사 에이엑스엔엘아이` : [https://axnli.com](https://axnli.com))**  
> **MCP Resource URI**: `ckd://catalog`

This catalog provides ready-to-use **AI Role Mixing Presets, Low-VRAM / High-VRAM GPU Concurrency Profiles, and Autonomous UI Control Actions** that any MCP-connected AI agent or user can invoke immediately.

---

## 1. Heterogeneous AI Role Mixing Presets (`C` vs. `A · B`)

Herdr CKD decouples **Core Leader `C`** (`leaderModel`, `leaderUrl`, `leaderApiKey`) from **Worker/Checker Threads `A · B`** (`workerModel`, `workerUrl`, `workerApiKey`). Apply any preset below with `ckd_ui_control` (`action: "apply_preset"`) or `ckd_configure`:

| Catalog Preset ID | Core Leader `C` (Plan · Relay · Final Judge) | Worker Threads `A · B` (Unlimited Inner Ping-Pong) | Best For & Key Advantage |
| :--- | :--- | :--- | :--- |
| **`hybrid_openai_local`** ⭐ | **Paid OpenAI** (`gpt-4.1`)<br/>`https://api.openai.com/v1` | **Local LM Studio** (`local-model`)<br/>`http://localhost:1234/v1` | **[Best Cost/Performance]** `C` uses minimal paid tokens at start/end, while repetitive `A_n ⇄ B_n` ping-pong runs 100% free on your Local LLM |
| **`hybrid_gemini_local`** ⭐ | **Paid Google Gemini** (`gemini-2.5-pro`)<br/>`https://generativelanguage.googleapis.com/v1beta/openai` | **Local LM Studio** (`local-model`)<br/>`http://localhost:1234/v1` | **[Deep Reasoning + Free Loop]** Gemini 2.5 Pro architecture planning & final judging + unlimited free local coding/checking |
| **`hybrid_claude_local`** ⭐ | **Paid Claude (OpenRouter)** (`anthropic/claude-sonnet-4`)<br/>`https://openrouter.ai/api/v1` | **Local LM Studio** (`local-model`)<br/>`http://localhost:1234/v1` | **[Precision Design + Free Loop]** Claude Sonnet task decomposition & final audit + free local `A_n ⇄ B_n` execution |
| **`local_lmstudio`** | **Local LM Studio** (`local-model`)<br/>`http://localhost:1234/v1` | **Local LM Studio** (`local-model`)<br/>`http://localhost:1234/v1` | **[100% Free & Air-Gapped]** $0 API cost, 100% local code privacy |
| **`local_ollama`** | **Local Ollama** (`qwen2.5-coder:32b`)<br/>`http://localhost:11434/v1` | **Local Ollama** (`qwen2.5-coder:32b`)<br/>`http://localhost:11434/v1` | **[Single Ollama Server]** Runs both `C` and `A·B` on a local Ollama instance |
| **`cloud_openai`** | **Paid OpenAI** (`gpt-4.1`)<br/>`https://api.openai.com/v1` | **Paid OpenAI** (`gpt-4.1-mini`)<br/>`https://api.openai.com/v1` | **[No-GPU Laptop Ultra-Fast Parallel]** Runs 3~6 parallel thread units on any lightweight laptop |
| **`cloud_gemini`** | **Paid Gemini** (`gemini-2.5-pro`)<br/>`https://generativelanguage.googleapis.com/v1beta/openai` | **Paid Gemini** (`gemini-2.5-flash`)<br/>`https://generativelanguage.googleapis.com/v1beta/openai` | **[Fast Cloud Split]** Pro for Core `C` + high-speed Flash for parallel `A·B` threads |

---

## 2. Hardware & GPU Concurrency Profiles

When running Local LLMs, select the concurrency profile matching your GPU's VRAM capacity:

| Hardware Profile ID | Settings (`maxUnits`, `parallelUnits`) | Target Hardware & Execution Behavior |
| :--- | :--- | :--- |
| **`gpu_high_parallel`** | `maxUnits: 3`, `parallelUnits: true` | **High-VRAM GPU / Unified Memory Workstation / Cloud API**<br/>Executes `[A1·B1]`, `[A2·B2]`, `[A3·B3]` simultaneously in parallel (`Promise.all`). |
| **`gpu_low_sequential`** | `maxUnits: 3`, `parallelUnits: false` | **Single Consumer GPU (8GB : 16GB VRAM) : Low-VRAM Safe Mode**<br/>Core `C` still decomposes the task into isolated `Git Worktree` units, but executes `[A1·B1]` → `[A2·B2]` → `[A3·B3]` **one unit at a time sequentially** to prevent KV-cache VRAM Out-Of-Memory (OOM). |
| **`gpu_minimal_single`** | `maxUnits: 1`, `parallelUnits: false` | **Entry-Level GPU / Lightweight Single-Pair Mode**<br/>Runs `C` + a single `[A1·B1]` Maker-Checker pair with minimal VRAM footprint. |

---

## 3. Autonomous UI Control Actions (`ckd_ui_control`)

An MCP-connected AI can manipulate every element of the live Herdr CKD Dashboard UI via `ckd_ui_control`:

* **`set_form`**: Populate `workspace`, `request`, `mode` (`auto`/`split`/`compete`), `maxUnits` (`1` : `6`), `parallelUnits` (`true`/`false`), and `maxRounds` (`0`/`1`/`3`/`5`/`10`/`20`) on the left control panel.
* **`select_job`**: Switch the active job displayed on the dashboard (`jobId`).
* **`set_filter`**: Switch the thread filter bar (`"all"`, `"working"`, `"checking"`, `"done"`).
* **`toggle_diff`**: Open or close the `Git Diff` code viewer on screen for `unitId` (`"unit-1"`, `"unit-2"`, or `"all"`).
* **`apply_preset`**: Immediately apply any Model Preset or GPU Profile ID from this catalog and update the live UI badges.
* **`check_models`**: Probe Core `C` and Worker `A·B` model servers and display the live connection banner on the dashboard.
* **`open_settings` / `close_settings`**: Open or close the Settings modal on the user's screen.
