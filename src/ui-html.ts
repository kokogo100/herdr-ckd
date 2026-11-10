// Herdr CKD Dedicated Split-Thread Desktop Dashboard UI (English Edition by AXNli Inc. — https://axnli.com)
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Herdr CKD — Multi-Thread AI Orchestrator (Core C + [A_n · B_n] Pairs) | AXNli Inc.</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  <link rel="icon" type="image/svg+xml" href="/icon.svg" />
  <style>
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --panel-2: #1e222b;
      --border: #2c3240;
      --accent: #f59e0b;
      --accent-dim: rgba(245, 158, 11, 0.15);
      --green: #10b981;
      --blue: #3b82f6;
      --purple: #8b5cf6;
      --red: #ef4444;
      --text: #e5e7eb;
      --muted: #9ca3af;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, monospace;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 10px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 16px;
      color: var(--accent);
      flex-wrap: wrap;
    }
    .brand a {
      color: #38bdf8;
      text-decoration: none;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid rgba(56, 189, 248, 0.35);
      background: rgba(56, 189, 248, 0.08);
    }
    .brand a:hover { border-color: #38bdf8; }
    .badge {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      background: var(--panel-2);
      border: 1px solid var(--border);
      color: var(--text);
    }
    .badge.ok { border-color: var(--green); color: var(--green); }
    .badge.work { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
    .badge.check { border-color: var(--purple); color: #c4b5fd; }
    .badge.err { border-color: var(--red); color: var(--red); }
    .top-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    button {
      background: var(--panel-2);
      color: var(--text);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      transition: 0.15s;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    button.primary {
      background: var(--accent);
      color: #111;
      border-color: var(--accent);
    }
    button.primary:hover { filter: brightness(1.1); color: #000; }
    .model-check-banner {
      background: #131722;
      border-bottom: 1px solid var(--border);
      padding: 8px 18px;
      font-size: 12px;
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    main {
      flex: 1;
      display: grid;
      grid-template-columns: var(--left-col-w, 400px) 6px 1fr;
      overflow: hidden;
    }
    .left-col {
      background: var(--panel);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 0;
      gap: 0;
      min-width: 280px;
    }
    .chat-header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: #13161c;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .workspace-bar {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--panel-2);
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .workspace-bar input {
      flex: 1;
      padding: 5px 8px;
      font-size: 11px;
    }
    .history-drawer {
      display: none;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #101319;
      max-height: 220px;
      overflow-y: auto;
      flex-shrink: 0;
    }
    .chat-timeline {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .msg-user {
      align-self: flex-end;
      max-width: 88%;
      background: rgba(245, 158, 11, 0.16);
      border: 1px solid rgba(245, 158, 11, 0.4);
      color: var(--text);
      padding: 10px 12px;
      border-radius: 12px 12px 3px 12px;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg-c {
      align-self: flex-start;
      width: 100%;
      background: var(--panel-2);
      border: 1px solid var(--border);
      color: #e5e7eb;
      padding: 11px 13px;
      border-radius: 12px 12px 12px 3px;
      font-size: 12px;
      line-height: 1.55;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .msg-c-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--accent);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .unit-chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .unit-chip {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--bg);
      border: 1px solid var(--border);
      cursor: pointer;
      color: var(--text);
    }
    .unit-chip:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .chat-composer {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      background: #13161c;
      display: flex;
      flex-direction: column;
      gap: 7px;
      flex-shrink: 0;
    }
    .chat-composer textarea {
      min-height: 54px;
      max-height: 150px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .col-resizer {
      width: 6px;
      cursor: col-resize;
      background: var(--border);
      transition: background 0.15s;
      position: relative;
      z-index: 10;
      user-select: none;
    }
    .col-resizer:hover, .col-resizer.dragging {
      background: var(--accent);
    }
    .col-resizer::after {
      content: "⋮";
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: var(--muted);
      font-size: 11px;
      pointer-events: none;
    }
    .resizable-box {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 12px;
      color: #d1d5db;
      white-space: pre-wrap;
      height: 180px;
      min-height: 70px;
      overflow-y: auto;
      resize: vertical;
    }
    .row-resizer {
      height: 7px;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: 10px;
      letter-spacing: 2px;
      user-select: none;
      border-radius: 4px;
      transition: background 0.15s, color 0.15s;
      margin-top: -4px;
    }
    .row-resizer:hover, .row-resizer.dragging {
      background: var(--accent-dim);
      color: var(--accent);
    }
    .section-card {
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      color: var(--accent);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    label { font-size: 11px; color: var(--muted); display: block; margin-bottom: 3px; }
    input, select, textarea {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: 7px 9px;
      font-size: 12px;
      font-family: inherit;
    }
    textarea { resize: vertical; min-height: 76px; }
    .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .feedback-row {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 6px;
      margin-top: 4px;
    }
    .right-col {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .filter-bar {
      padding: 10px 16px;
      background: #13161c;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .filter-pills { display: flex; gap: 6px; }
    .filter-pills button.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }
    .threads-grid {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 14px;
      align-content: start;
    }
    .threads-grid.zoomed {
      grid-template-columns: 1fr;
    }
    .unit-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .unit-card.working { border-color: var(--accent); }
    .unit-card.checking { border-color: var(--purple); }
    .unit-card.failed, .unit-card.blocked { border-color: var(--red); }
    .unit-card.done, .unit-card.merged, .unit-card.selected { border-color: var(--green); }
    .unit-card.zoomed .unit-logs { max-height: calc(100vh - 340px); font-size: 12px; }
    .unit-card.zoomed .diff-box { max-height: 44vh; font-size: 12px; }
    .unit-header {
      background: var(--panel-2);
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .unit-header button, .unit-header .badge {
      white-space: nowrap;
      flex-shrink: 0;
    }
    .pair-boxes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }
    .role-box {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      font-size: 11px;
    }
    .role-box strong { display: block; margin-bottom: 4px; color: var(--text); }
    .unit-logs {
      padding: 10px 12px;
      font-size: 11px;
      max-height: 190px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 5px;
      background: #0b0d11;
    }
    .log-line { color: #d1d5db; line-height: 1.4; }
    .log-line .actor { font-weight: 700; color: var(--accent); margin-right: 6px; }
    .diff-box {
      padding: 8px 12px;
      font-size: 11px;
      background: #08090c;
      border-top: 1px solid var(--border);
      white-space: pre-wrap;
      max-height: 160px;
      overflow-y: auto;
      color: #a7f3d0;
      display: none;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 50;
    }
    .modal {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      width: 620px;
      max-width: 95vw;
      max-height: 92vh;
      overflow-y: auto;
      padding: 0 18px 18px 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .modal-sticky-header {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--panel);
      padding: 15px 0 10px 0;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .modal-close-x {
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 6px;
      font-size: 14px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .modal-close-x:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: var(--red);
      color: #fca5a5;
    }
    .jobs-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      height: 160px;
      min-height: 70px;
      overflow-y: auto;
      resize: vertical;
    }
    .job-item {
      padding: 7px 9px;
      border-radius: 6px;
      background: var(--bg);
      border: 1px solid var(--border);
      font-size: 11px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .job-item.active { border-color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <img src="/icon.svg" alt="Herdr CKD" style="width:26px;height:26px;border-radius:6px;" />
      <span>Herdr CKD</span>
      <a href="https://axnli.com" target="_blank" rel="noopener">by AXNli Inc. (axnli.com)</a>
      <span class="badge work">C (1 Fixed Core) + [A_n · B_n] Multi-Threads</span>
      <span id="modelBadge" class="badge">Loading models...</span>
      <span id="mcpEndpointBadge" class="badge ok" title="Click to copy IDE MCP endpoint URL" style="cursor:pointer;" onclick="copyMcpUrl()">🔗 MCP: checking...</span>
    </div>
    <div class="top-controls">
      <button id="finetuneTopBtn" onclick="openFinetuneModal(false)">🎯 Fine-Tune: Checking...</button>
      <button onclick="openSettings()">⚙️ Models · Rules · MCP · Settings</button>
    </div>
  </header>

  <main>
    <!-- Left Column: Conversational Command Panel with Core Leader C -->
    <div class="left-col">
      <div class="chat-header">
        <div style="display:flex; align-items:center; gap:7px;">
          <strong style="font-size:13px; color:var(--accent);">👑 Core Leader C</strong>
          <span id="leaderStateBadge" class="badge ok">IDLE</span>
        </div>
        <div style="display:flex; align-items:center; gap:5px;">
          <button id="historyToggleBtn" type="button" onclick="toggleHistoryDrawer()" style="padding:3px 8px; font-size:11px;">🕒 History (0)</button>
          <button type="button" onclick="startNewChat()" style="padding:3px 8px; font-size:11px;" title="Start a new task chat">➕ New Chat</button>
        </div>
      </div>

      <div id="historyDrawer" class="history-drawer">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; font-size:11px; color:var(--muted);">
          <span>Load Past Jobs (Click to restore threads)</span>
          <button type="button" onclick="toggleHistoryDrawer()" style="padding:1px 6px; font-size:10px;">Close</button>
        </div>
        <div id="jobsList" class="jobs-list" style="height:auto; max-height:165px; resize:none;"></div>
      </div>

      <div class="workspace-bar">
        <span style="font-size:13px;" title="Project Workspace Folder">📁</span>
        <input id="workspaceInput" placeholder="Project folder path (click Browse ->)" />
        <button id="pickFolderBtn" type="button" onclick="pickWorkspaceFolder()" style="padding:5px 9px; font-size:11px; white-space:nowrap;">Browse</button>
      </div>

      <div id="chatTimeline" class="chat-timeline"></div>

      <div class="chat-composer">
        <textarea id="requestInput" rows="2" placeholder="Tell Core Leader C what you want to build... (Enter to send · Shift+Enter newline)" onkeydown="onComposerKeydown(event)"></textarea>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <span id="composerHintText" style="font-size:10px; color:var(--muted);">C analyzes your prompt & auto-arranges [A1·B1], [A2·B2]... on the right</span>
          <div style="display:flex; gap:6px; flex-shrink:0;">
            <button id="stopJobBtn" type="button" onclick="stopCurrentJob()" style="display:none; border-color:rgba(239,68,68,0.5); color:#f87171;">⏹ Stop</button>
            <button id="sendChatBtn" type="button" class="primary" onclick="startMultiJob()">⏎ Send to C</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Horizontal Column Splitter -->
    <div id="colResizer" class="col-resizer" title="Drag left/right to resize left panel width (Double-click to reset)"></div>

    <!-- Right Column: Multi-Thread ([A1·B1], [A2·B2]...) Split Grid -->
    <div class="right-col">
      <div class="filter-bar" style="flex-wrap:wrap; gap:8px;">
        <div class="filter-pills" style="flex-wrap:wrap;">
          <button id="flt-all" class="active" onclick="setFilter('all')" title="Ctrl+B G A">All Threads</button>
          <button id="flt-working" onclick="setFilter('working')" title="Ctrl+B G W">Coding (A_n)</button>
          <button id="flt-checking" onclick="setFilter('checking')" title="Ctrl+B G C">Checking (B_n)</button>
          <button id="flt-blocked" onclick="setFilter('blocked')" title="Ctrl+B G B (Needs Fix / Failed / Review)">🚨 Needs Attention <span id="blockedCountBadge" style="display:none; margin-left:4px; padding:1px 6px; border-radius:999px; background:var(--red); color:#fff; font-size:10px;">0</span></button>
          <button id="flt-done" onclick="setFilter('done')" title="Ctrl+B G D">Done</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span id="chordHintBadge" class="badge work" style="display:none;">⌨️ Ctrl+B...</span>
          <input id="unitSearchInput" placeholder="/ Search unit, file, log" style="width:195px; padding:5px 9px; font-size:11px;" oninput="onSearchInput(this.value)" />
          <span style="font-size:11px; color:var(--muted);">
            <code>Ctrl+B G</code> Filter(A/W/C/B/D) · <code>Ctrl+B Z</code> Zoom · <code>/</code> Search
          </span>
        </div>
      </div>

      <div id="threadsGrid" class="threads-grid"></div>
    </div>
  </main>

  <!-- Settings Modal -->
  <div id="settingsModal" class="modal-backdrop" onclick="if(event.target===this)closeSettings()">
    <div class="modal">
      <div class="modal-sticky-header">
        <strong style="font-size:15px;">⚙️ Herdr CKD Settings (Host/Port · AI Models · Custom Rules · GitHub · Auto-Cleanup)</strong>
        <button type="button" class="modal-close-x" onclick="closeSettings()" title="Close (Esc)">✕</button>
      </div>
      <div style="padding:10px 12px; border-radius:8px; background:#121722; border:1px solid var(--border); display:flex; flex-direction:column; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong style="font-size:12px; color:var(--accent);">🔗 IDE (Gemini / Antigravity / Claude) Remote Control MCP & Internal Host Binding</strong>
          <button type="button" onclick="copyMcpUrl()" style="padding:3px 8px; font-size:11px;">📋 Copy MCP URL</button>
        </div>
        <div class="row-2">
          <div>
            <label>Bind Host Address (Local: 127.0.0.1 / LAN Open: 0.0.0.0 or LAN IP)</label>
            <input id="cfgUiHost" placeholder="127.0.0.1 or 0.0.0.0" oninput="updateMcpPreview()" />
          </div>
          <div>
            <label>Dedicated Port (Uncommon Port · Default 37501)</label>
            <input id="cfgUiPort" type="number" min="1024" max="65535" placeholder="37501" oninput="updateMcpPreview()" />
          </div>
        </div>
        <div style="font-size:11px; color:var(--muted);">
          IDE MCP Endpoint URL: <code id="cfgMcpUrlPreview" style="color:var(--green); font-weight:700;">http://127.0.0.1:37501/mcp</code>
          <span style="margin-left:6px;">(Restart app after changing host/port to bind to the new address)</span>
        </div>
      </div>
      <div style="padding:10px 12px; border-radius:8px; background:#121722; border:1px solid var(--border); display:flex; flex-direction:column; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
          <strong style="font-size:12px; color:var(--accent);">👑 Core Leader C Model (Paid Cloud AI or Local LLM · Hybrid Supported)</strong>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            <button type="button" onclick="applyRolePreset('C','lmstudio')" style="padding:2px 6px; font-size:10px;">Local LM Studio</button>
            <button type="button" onclick="applyRolePreset('C','ollama')" style="padding:2px 6px; font-size:10px;">Local Ollama</button>
            <button type="button" onclick="applyRolePreset('C','openai')" style="padding:2px 6px; font-size:10px;">Paid OpenAI</button>
            <button type="button" onclick="applyRolePreset('C','gemini')" style="padding:2px 6px; font-size:10px;">Paid Gemini</button>
            <button type="button" onclick="applyRolePreset('C','claude')" style="padding:2px 6px; font-size:10px;">Paid Claude</button>
            <button type="button" onclick="applyRolePreset('C','openrouter')" style="padding:2px 6px; font-size:10px;">OpenRouter</button>
          </div>
        </div>
        <div class="row-2">
          <div>
            <label>Core Leader C Model Name</label>
            <input id="cfgLeaderModel" placeholder="e.g., local-model, gpt-4.1, gemini-2.5-pro, claude-sonnet-4-20250514" />
          </div>
          <div>
            <label>Core Leader C Server Base URL</label>
            <input id="cfgLeaderUrl" placeholder="e.g., http://localhost:1234/v1 or https://api.anthropic.com/v1" />
          </div>
        </div>
        <div>
          <label>Core Leader C API Key (Leave blank for Local LLM · Enter key for Paid Cloud AI)</label>
          <input id="cfgLeaderApiKey" type="password" placeholder="Blank for Local LLM / Paid AI: sk-..., sk-ant-..., AIza..." />
        </div>
      </div>

      <div style="padding:10px 12px; border-radius:8px; background:#121722; border:1px solid var(--border); display:flex; flex-direction:column; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
          <strong style="font-size:12px; color:var(--blue);">🛠🔍 Shared Worker Model A·B (Free Unlimited Local LLM Ping-Pong or Paid AI)</strong>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            <button type="button" onclick="applyRolePreset('AB','lmstudio')" style="padding:2px 6px; font-size:10px;">Local LM Studio</button>
            <button type="button" onclick="applyRolePreset('AB','mac_lmstudio')" style="padding:2px 6px; font-size:10px;">Remote LAN Server</button>
            <button type="button" onclick="applyRolePreset('AB','ollama')" style="padding:2px 6px; font-size:10px;">Local Ollama</button>
            <button type="button" onclick="applyRolePreset('AB','openai')" style="padding:2px 6px; font-size:10px;">Paid OpenAI</button>
            <button type="button" onclick="applyRolePreset('AB','gemini')" style="padding:2px 6px; font-size:10px;">Paid Gemini</button>
            <button type="button" onclick="applyRolePreset('AB','claude')" style="padding:2px 6px; font-size:10px;">Paid Claude</button>
            <button type="button" onclick="applyRolePreset('AB','openrouter')" style="padding:2px 6px; font-size:10px;">OpenRouter</button>
          </div>
        </div>
        <div class="row-2">
          <div>
            <label>Shared Worker Model (A1..An, B1..Bn)</label>
            <input id="cfgWorkerModel" placeholder="e.g., local-model, llama3.3, gpt-4.1-mini" />
          </div>
          <div>
            <label>Worker Model Server URL (Local · Remote LAN IP · Paid API URL)</label>
            <input id="cfgWorkerUrl" placeholder="e.g., http://localhost:1234/v1 or http://192.168.0.10:1234/v1" />
          </div>
        </div>
        <div>
          <label>A·B Worker API Key (Leave blank for Local LLM · Enter key for Paid Cloud AI)</label>
          <input id="cfgWorkerApiKey" type="password" placeholder="Blank for Local LLM / Paid AI: sk-... or AIza..." />
        </div>
      </div>

      <div style="padding:10px 12px; border-radius:8px; background:#121722; border:1px solid var(--border); display:flex; flex-direction:column; gap:6px;">
        <strong style="font-size:12px; color:var(--green);">📜 Custom Rules (Injected into Core Leader C and all A_n · B_n Threads)</strong>
        <textarea id="cfgCustomRules" style="min-height:68px;" placeholder="e.g., Write all comments in Korean, use strict TypeScript types, and verify zero console errors before declaring DONE."></textarea>
      </div>

      <hr style="border-color:var(--border);" />
      <div class="row-2">
        <div>
          <label style="display:flex; align-items:center; gap:8px; color:var(--text);">
            <input id="cfgUseWorktree" type="checkbox" style="width:auto;" />
            Use Ultra-Fast Per-Thread Git Worktree Isolation
          </label>
        </div>
        <div>
          <label style="display:flex; align-items:center; gap:8px; color:var(--text);">
            <input id="cfgParallelUnits" type="checkbox" style="width:auto;" />
            Run Thread Units in Parallel (Uncheck for Low-VRAM Single GPU Sequential Mode)
          </label>
        </div>
      </div>
      <div>
        <label style="display:flex; align-items:center; gap:8px; color:var(--text);">
          <input id="cfgEmitOsc7501" type="checkbox" style="width:auto;" />
          Emit Herdr Terminal OSC 7501 Status Signals
        </label>
      </div>
      <hr style="border-color:var(--border);" />
      <div class="row-2">
        <div>
          <label>GitHub Sync Mode</label>
          <select id="cfgGithubMode">
            <option value="off">Off (Local Git Worktree Only)</option>
            <option value="push_on_complete">Push Branch on Unit Pass</option>
            <option value="pr_on_review">Auto-Create GitHub PR on B Review</option>
          </select>
        </div>
        <div>
          <label>Max Remote GitHub Branches (FIFO Pruned)</label>
          <input id="cfgMaxBranches" type="number" min="1" max="50" />
        </div>
      </div>
      <div>
        <label style="display:flex; align-items:center; gap:8px; color:var(--text);">
          <input id="cfgDeleteBranch" type="checkbox" style="width:auto;" />
          Auto-Delete Temporary GitHub Branches on Job/Merge Completion (Recommended)
        </label>
      </div>
      <hr style="border-color:var(--border);" />
      <div class="row-2">
        <div>
          <label>Max Jobs to Keep in Logs (FIFO Rolling Cleanup)</label>
          <input id="cfgMaxJobs" type="number" min="5" max="500" />
        </div>
        <div>
          <label>Max Job Logs Storage Size (MB)</label>
          <input id="cfgMaxMB" type="number" min="50" max="10000" />
        </div>
      </div>
      <div class="row-2">
        <div>
          <label>Max Curated Fine-Tuning Storage (finetune/) in MB</label>
          <input id="cfgMaxFinetuneMB" type="number" min="10" max="5000" value="200" />
        </div>
        <div style="display:flex; align-items:flex-end; padding-bottom:6px;">
          <label style="display:flex; align-items:center; gap:8px; color:var(--text); margin:0;">
            <input id="cfgDeleteTemp" type="checkbox" style="width:auto;" />
            Delete Heavy Temp Folders Immediately on Job Completion
          </label>
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap;">
        <button type="button" onclick="shutdownBackgroundServer()" style="border-color:rgba(239,68,68,0.45); color:#f87171;" title="Closing the window only detaches (keeps background session alive). Click here to stop the server completely.">🛑 Shutdown Background Server</button>
        <div style="display:flex; gap:8px;">
          <button onclick="closeSettings()">Cancel</button>
          <button class="primary" onclick="saveSettings()">💾 Save Settings</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Dedicated Fine-Tuning Dataset Collection & JSON Export Modal -->
  <div id="finetuneModal" class="modal-backdrop" onclick="if(event.target===this)closeFinetuneModal()">
    <div class="modal" style="width:600px;">
      <div class="modal-sticky-header">
        <strong style="font-size:15px;">🎯 Fine-Tuning (Knowledge Distillation) Dataset · JSON Export</strong>
        <button type="button" class="modal-close-x" onclick="closeFinetuneModal()" title="Close (Esc)">✕</button>
      </div>

      <div id="ftReadyBanner" style="display:none; padding:11px 13px; border-radius:8px; background:rgba(245,158,11,0.16); border:1px solid var(--accent); color:#fde68a; font-size:12px; line-height:1.55;">
        🎉 <strong>Your Fine-Tuning dataset has reached 100% of your target size!</strong><br/>
        Ready to fine-tune? Download your <strong>JSON dataset</strong> below and load it into your external training tool. (Click <strong>Manual Reset</strong> at the bottom whenever you want to start a fresh batch from 0 MB.)
      </div>

      <div style="padding:11px 13px; border-radius:8px; background:#121722; border:1px solid var(--border); display:flex; flex-direction:column; gap:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
          <label style="display:flex; align-items:center; gap:8px; color:var(--text); font-size:13px; font-weight:700; margin:0; cursor:pointer;">
            <input id="ftEnabledCheck" type="checkbox" style="width:auto; transform:scale(1.15);" />
            Collect Fine-Tuning Trajectories Automatically (ON / OFF)
          </label>
          <span id="ftStatePill" class="badge ok">ON</span>
        </div>
        <div style="font-size:11px; color:var(--muted); line-height:1.5;">
          📌 <strong>Auto-Save Vault (No manual save button needed):</strong> Whenever collection is <strong>ON</strong>, each completed run is <strong>automatically accumulated inside a dedicated Fine-Tuning vault (<code>finetune/</code>)</strong>—completely separate from UI history logs.
        </div>

        <div class="row-2" style="align-items:flex-end;">
          <div>
            <label>Target Dataset Size (MB · Default 200 MB · Notifies at 100%)</label>
            <input id="ftTargetMBInput" type="number" min="1" max="10000" step="1" placeholder="200" />
          </div>
          <div>
            <button type="button" class="primary" style="width:100%;" onclick="saveFinetuneConfig()">💾 Save ON/OFF & Target Size</button>
          </div>
        </div>

        <div>
          <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--muted); margin-bottom:5px;">
            <span id="ftProgressText">Collected: 0 MB / 200 MB (0%)</span>
            <span id="ftCountText">Sessions: 0 (👍 Good: 0)</span>
          </div>
          <div style="width:100%; height:9px; border-radius:999px; background:#0b0d11; border:1px solid var(--border); overflow:hidden;">
            <div id="ftProgressBar" style="width:0%; height:100%; background:linear-gradient(90deg, var(--green), var(--accent)); transition:width 0.25s;"></div>
          </div>
        </div>
      </div>

      <div style="padding:11px 13px; border-radius:8px; background:#121722; border:1px solid var(--border); display:flex; flex-direction:column; gap:9px;">
        <strong style="font-size:12px; color:var(--green);">📥 Export JSON Dataset (Available anytime, even before 100%)</strong>
        <div style="font-size:11px; color:var(--muted); line-height:1.55;">
          💡 Herdr CKD does not run model training directly; instead, it exports verified <code>C · A_n · B_n</code> trajectories as a <strong>standard JSON file</strong>. Load the exported file into <strong>LM Studio, Unsloth, LLaMA-Factory, MLX-LM, or OpenAI Fine-tuning</strong> to train your model.<br/>
          ✨ <strong style="color:var(--text);">Custom Curation (2nd-Pass AI Rewriting) Tip:</strong> Every team has different training goals—you can feed the downloaded <code>.json</code> file into another AI (Claude, Gemini, GPT, etc.) to <em>compress multi-turn retries into clean single-shot solutions, unify coding conventions, mask local paths, or convert into ShareGPT/Alpaca schemas</em> before fine-tuning.
        </div>
        <div class="row-2">
          <div>
            <label>Quality Filter</label>
            <select id="ftExportQuality">
              <option value="all">All Collected Sessions (C · A · B)</option>
              <option value="good">👍 Confirmed Good Ratings Only</option>
            </select>
          </div>
          <div>
            <label>Role Filter</label>
            <select id="ftExportRole">
              <option value="all">All Roles (Core C + Maker A + Checker B)</option>
              <option value="A">Maker Threads (A) Only</option>
              <option value="B">Checker Threads (B) Only</option>
              <option value="C">Core Leader (C) Only</option>
            </select>
          </div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:2px;">
          <button type="button" class="primary" style="flex:1;" onclick="downloadFinetuneFile('json')">📥 Download Fine-Tuning JSON (.json)</button>
          <button type="button" onclick="downloadFinetuneFile('jsonl')">📥 Download JSONL (.jsonl)</button>
        </div>
      </div>

      <div style="padding:10px 13px; border-radius:8px; background:#121722; border:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
        <div style="font-size:11px; color:var(--muted); line-height:1.45; flex:1; min-width:220px;">
          <strong style="color:var(--text); display:block; margin-bottom:2px;">🔄 Manual Dataset Reset (Reset to 0 MB)</strong>
          Once you export your JSON for fine-tuning (at 100% or earlier), click Manual Reset to clear collected data back to 0 MB. (Data is never auto-wiped without your action.)
        </div>
        <button type="button" onclick="manualResetFinetune()" style="border-color:rgba(239,68,68,0.45); color:#f87171; white-space:nowrap;">🗑️ Manual Reset (0 MB)</button>
      </div>
    </div>
  </div>

  <!-- Dedicated Job Log Cleanup Modal -->
  <div id="cleanupModal" class="modal-backdrop" onclick="if(event.target===this)closeCleanupModal()">
    <div class="modal" style="width:480px;">
      <div class="modal-sticky-header">
        <strong style="font-size:15px;">🧹 Clean Up Job Logs Now</strong>
        <button type="button" class="modal-close-x" onclick="closeCleanupModal()" title="Close (Esc)">✕</button>
      </div>
      <div style="padding:11px 13px; border-radius:8px; background:#121722; border:1px solid var(--border); font-size:12px; line-height:1.6; color:var(--text);">
        <div id="cleanupSummaryText" style="margin-bottom:6px; font-weight:700; color:var(--accent);">Checking stored job logs...</div>
        <div style="font-size:11px; color:var(--muted);">
          • Immediately clears <strong>all completed, failed, and stopped job logs (<code>jobs/</code>)</strong>, regardless of the 30-job limit (active running jobs are protected).<br/>
          • <strong>🎯 Fine-Tuning datasets (<code>finetune/</code>)</strong> are NOT deleted and remain safely preserved.
        </div>
      </div>
      <div id="cleanupResultBox" style="display:none; padding:10px 12px; border-radius:8px; background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.4); color:#6ee7b7; font-size:12px;"></div>
      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button type="button" onclick="closeCleanupModal()">Close</button>
        <button type="button" class="primary" onclick="executeCleanupLogs()">🧹 Clear All Finished Logs</button>
      </div>
    </div>
  </div>

  <script>
    let currentJobId = null;
    let isNewChatMode = false;
    let remoteOverrides = {};
    let lastChatSignature = '';
    let currentFilter = 'all';
    let currentSearch = '';
    let zoomedUnitId = null;
    let chordStage = null;
    let chordTimer = null;
    let cachedJobs = [];
    let lastNewestJobId = null;
    const openDiffKeys = new Set();
    let lastRenderedSignature = '';

    function updateMcpPreview() {
      const hostEl = document.getElementById('cfgUiHost');
      const portEl = document.getElementById('cfgUiPort');
      const prevEl = document.getElementById('cfgMcpUrlPreview');
      if (!hostEl || !portEl || !prevEl) return;
      const h = (hostEl.value || '').trim() || '127.0.0.1';
      const displayHost = h === '0.0.0.0' ? '127.0.0.1' : h;
      const p = Number(portEl.value) || 37501;
      prevEl.textContent = 'http://' + displayHost + ':' + p + '/mcp';
    }

    function copyMcpUrl() {
      const prevEl = document.getElementById('cfgMcpUrlPreview');
      const url = (prevEl && prevEl.textContent) ? prevEl.textContent : (window.location.origin + '/mcp');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url);
      }
      alert('Copied IDE MCP Endpoint URL:\\n' + url);
    }

    function esc(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function setFilter(f) {
      currentFilter = f;
      for (const id of ['all', 'working', 'checking', 'blocked', 'done']) {
        const el = document.getElementById('flt-' + id);
        if (el) el.classList.toggle('active', id === f);
      }
      renderCurrentJob();
    }

    function onSearchInput(val) {
      currentSearch = String(val || '').trim();
      renderCurrentJob();
    }

    function toggleZoomUnit(unitId) {
      if (!unitId) {
        zoomedUnitId = null;
      } else {
        zoomedUnitId = zoomedUnitId === unitId ? null : unitId;
      }
      renderCurrentJob();
    }

    function setChordHint(txt) {
      const b = document.getElementById('chordHintBadge');
      if (!b) return;
      if (!txt) {
        b.style.display = 'none';
      } else {
        b.textContent = txt;
        b.style.display = 'inline-block';
      }
    }

    function resetChord() {
      chordStage = null;
      if (chordTimer) {
        clearTimeout(chordTimer);
        chordTimer = null;
      }
      setChordHint('');
    }

    function copyUnitLogs(unitId) {
      const job = cachedJobs.find(j => j.jobId === currentJobId);
      const u = job && job.units ? job.units.find(x => x.unitId === unitId) : null;
      if (!u) return;
      const nl = String.fromCharCode(10);
      const lines = ['[' + u.unitId + '] ' + u.title + ' (' + u.status + ')'];
      for (const l of (u.logs || [])) {
        lines.push('[' + l.actor + '] ' + (l.status ? '(' + l.status + ') ' : '') + l.summary);
      }
      if (u.diffPreview) {
        lines.push('', '--- Git Diff ---', u.diffPreview);
      }
      const txt = lines.join(nl);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
      }
      alert('Copied [' + u.unitId + '] logs & Git Diff to clipboard.');
    }

    function showShortcutHelp() {
      const nl = String.fromCharCode(10);
      alert([
        '⌨️ Herdr CKD Shortcuts (Ctrl+B ?)',
        '----------------------------------------',
        '• Ctrl+B → G → A : Show All Threads',
        '• Ctrl+B → G → W : Coding (A_n) Filter',
        '• Ctrl+B → G → C : Checking (B_n) Filter',
        '• Ctrl+B → G → B : 🚨 Needs Attention (Blocked) Filter',
        '• Ctrl+B → G → D : Done Filter',
        '• Ctrl+B → Z     : Zoom / Unzoom Thread Card',
        '• /              : Quick Search (unit, file, log)',
        '• Esc            : Exit Zoom / Blur Search Input',
      ].join(nl));
    }

    window.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
      const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';

      if (e.key === 'Escape') {
        const cm = document.getElementById('cleanupModal');
        if (cm && cm.style.display === 'flex') {
          closeCleanupModal();
          return;
        }
        const fm = document.getElementById('finetuneModal');
        if (fm && fm.style.display === 'flex') {
          closeFinetuneModal();
          return;
        }
        const sm = document.getElementById('settingsModal');
        if (sm && sm.style.display === 'flex') {
          closeSettings();
          return;
        }
        if (isTyping && e.target) e.target.blur();
        if (zoomedUnitId) toggleZoomUnit(null);
        resetChord();
        return;
      }

      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        chordStage = 'prefix';
        setChordHint('⌨️ Ctrl+B (G:Filter / Z:Zoom / ?:Help)');
        if (chordTimer) clearTimeout(chordTimer);
        chordTimer = setTimeout(resetChord, 2500);
        return;
      }

      if (chordStage === 'prefix') {
        e.preventDefault();
        if (e.key === '?' || (e.shiftKey && e.key === '/')) {
          resetChord();
          showShortcutHelp();
          return;
        }
        const k = e.key.toLowerCase();
        if (k === 'g') {
          chordStage = 'goto';
          setChordHint('⌨️ Ctrl+B G → A/W/C/B/D');
          if (chordTimer) clearTimeout(chordTimer);
          chordTimer = setTimeout(resetChord, 2500);
          return;
        }
        if (k === 'z') {
          const job = cachedJobs.find(j => j.jobId === currentJobId);
          const firstId = job && job.units && job.units[0] ? job.units[0].unitId : null;
          toggleZoomUnit(zoomedUnitId ? null : firstId);
          resetChord();
          return;
        }
        resetChord();
        return;
      }

      if (chordStage === 'goto') {
        e.preventDefault();
        const k = e.key.toLowerCase();
        const map = { a: 'all', w: 'working', c: 'checking', b: 'blocked', d: 'done' };
        if (map[k]) setFilter(map[k]);
        resetChord();
        return;
      }

      if (!isTyping && e.key === '/') {
        e.preventDefault();
        const s = document.getElementById('unitSearchInput');
        if (s) { s.focus(); s.select(); }
        return;
      }

      if (e.altKey && e.key.toLowerCase() === 'd') setFilter('done');
      if (e.altKey && e.key.toLowerCase() === 'a') setFilter('all');
      if (e.altKey && e.key.toLowerCase() === 'b') setFilter('blocked');
    });

    async function api(path, opts) {
      const res = await fetch(path, opts);
      return await res.json();
    }

    function applyRolePreset(target, preset) {
      const presets = {
        lmstudio: { model: 'local-model', url: 'http://localhost:1234/v1', clearKey: true },
        mac_lmstudio: { model: 'local-model', url: 'http://192.168.0.10:1234/v1', clearKey: true },
        ollama: { model: 'llama3.3', url: 'http://localhost:11434/v1', clearKey: true },
        openai: { model: target === 'C' ? 'gpt-4.1' : 'gpt-4.1-mini', url: 'https://api.openai.com/v1', clearKey: false },
        gemini: { model: target === 'C' ? 'gemini-2.5-pro' : 'gemini-2.5-flash', url: 'https://generativelanguage.googleapis.com/v1beta/openai', clearKey: false },
        claude: { model: target === 'C' ? 'claude-sonnet-4-20250514' : 'claude-3-5-haiku-latest', url: 'https://api.anthropic.com/v1', clearKey: false },
        openrouter: { model: target === 'C' ? 'anthropic/claude-sonnet-4' : 'anthropic/claude-3.5-haiku', url: 'https://openrouter.ai/api/v1', clearKey: false },
      };
      const p = presets[preset];
      if (!p) return;
      if (target === 'C') {
        document.getElementById('cfgLeaderModel').value = p.model;
        document.getElementById('cfgLeaderUrl').value = p.url;
        if (p.clearKey) document.getElementById('cfgLeaderApiKey').value = '';
      } else {
        document.getElementById('cfgWorkerModel').value = p.model;
        document.getElementById('cfgWorkerUrl').value = p.url;
        if (p.clearKey) document.getElementById('cfgWorkerApiKey').value = '';
      }
    }

    let lastOverviewData = null;

    function syncFinetuneModalView(autoPrompted) {
      const d = lastOverviewData;
      if (!d || !d.config) return;
      const enabled = d.config.curateLogs !== false;
      const targetMB = (d.config.retention && d.config.retention.maxFinetuneSizeMB) || 200;
      const ft = d.finetune || { finetuneMB: (d.storage && d.storage.finetuneMB) || 0, sessionCount: 0, goodCount: 0 };
      const curMB = Number(ft.finetuneMB || 0);
      const pct = targetMB > 0 ? Math.min(100, Math.round((curMB / targetMB) * 1000) / 10) : 0;
      const isFull = enabled && curMB >= targetMB && targetMB > 0;

      const chk = document.getElementById('ftEnabledCheck');
      const inp = document.getElementById('ftTargetMBInput');
      if (chk && (!document.getElementById('finetuneModal') || document.getElementById('finetuneModal').style.display !== 'flex' || autoPrompted)) {
        chk.checked = enabled;
        if (inp) inp.value = String(targetMB);
      }
      const pill = document.getElementById('ftStatePill');
      if (pill) {
        pill.textContent = enabled ? (isFull ? '100% Ready!' : 'Collecting (ON)') : 'Paused (OFF)';
        pill.className = 'badge ' + (enabled ? (isFull ? 'work' : 'ok') : '');
      }
      const pTxt = document.getElementById('ftProgressText');
      if (pTxt) pTxt.textContent = 'Collected: ' + curMB + ' MB / Target ' + targetMB + ' MB (' + pct + '%)';
      const cTxt = document.getElementById('ftCountText');
      if (cTxt) cTxt.textContent = 'Sessions: ' + (ft.sessionCount || 0) + ' (👍 Good: ' + (ft.goodCount || 0) + ')';
      const bar = document.getElementById('ftProgressBar');
      if (bar) bar.style.width = Math.min(100, pct) + '%';
      const banner = document.getElementById('ftReadyBanner');
      if (banner) banner.style.display = isFull ? 'block' : 'none';
    }

    function openFinetuneModal(autoPrompted) {
      syncFinetuneModalView(true);
      document.getElementById('finetuneModal').style.display = 'flex';
    }

    function closeFinetuneModal() {
      document.getElementById('finetuneModal').style.display = 'none';
    }

    async function saveFinetuneConfig() {
      const enabled = document.getElementById('ftEnabledCheck').checked;
      const targetMB = Math.max(1, Number(document.getElementById('ftTargetMBInput').value) || 200);
      await api('/api/finetune/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, targetMB }),
      });
      localStorage.removeItem('herdr_ft_notified_key');
      await refreshAll();
      syncFinetuneModalView(true);
    }

    function downloadFinetuneFile(format) {
      const onlyGood = document.getElementById('ftExportQuality').value === 'good' ? '1' : '0';
      const role = document.getElementById('ftExportRole').value || 'all';
      const url = '/api/finetune/export?format=' + encodeURIComponent(format) + '&onlyGood=' + onlyGood + '&role=' + encodeURIComponent(role);
      const a = document.createElement('a');
      a.href = url;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 300);
    }

    async function manualResetFinetune() {
      if (!confirm('Clear all collected Fine-Tuning data back to 0 MB? (Make sure you have downloaded your JSON file first if needed.)')) return;
      await api('/api/finetune/reset', { method: 'POST' });
      localStorage.removeItem('herdr_ft_notified_key');
      await refreshAll();
      syncFinetuneModalView(true);
    }

    async function refreshAll() {
      const data = await api('/api/overview');
      lastOverviewData = data;
      const cfg = data.config;
      const st = data.storage;
      const ft = data.finetune || { finetuneMB: st.finetuneMB || 0, sessionCount: 0, goodCount: 0 };
      const leaderM = (cfg.roleModels && cfg.roleModels.C && cfg.roleModels.C.model) || cfg.model.model;
      const workerM = (cfg.roleModels && cfg.roleModels.A && cfg.roleModels.A.model) || cfg.model.model;
      document.getElementById('modelBadge').textContent = 'C: ' + leaderM + ' | A·B Shared: ' + workerM;
      const hostStr = cfg.uiHost || '127.0.0.1';
      const portNum = cfg.uiPort || window.location.port || 37501;
      const mcpBadge = document.getElementById('mcpEndpointBadge');
      if (mcpBadge) {
        mcpBadge.textContent = '🔗 MCP: ' + hostStr + ':' + portNum + '/mcp';
      }
      const maxFtMB = (cfg.retention && cfg.retention.maxFinetuneSizeMB) || 200;
      const storageEl = document.getElementById('storageBadge');
      if (storageEl) {
        storageEl.textContent =
          'Logs: ' + st.jobCount + '/' + cfg.retention.maxJobsToKeep + ' (' + st.jobsMB + '/' + cfg.retention.maxLogSizeMB + ' MB)';
      }

      const ftBtn = document.getElementById('finetuneTopBtn');
      const ftEnabled = cfg.curateLogs !== false;
      const curFtMB = Number(ft.finetuneMB || 0);
      if (ftBtn) {
        if (!ftEnabled) {
          ftBtn.textContent = '🎯 Fine-Tune: OFF';
          ftBtn.style.borderColor = '';
          ftBtn.style.color = 'var(--muted)';
          ftBtn.style.background = '';
        } else {
          const pctInt = maxFtMB > 0 ? Math.min(100, Math.floor((curFtMB / maxFtMB) * 100)) : 0;
          if (curFtMB >= maxFtMB && maxFtMB > 0) {
            ftBtn.textContent = '🎯 Fine-Tune 100% Ready! (' + curFtMB + '/' + maxFtMB + ' MB)';
            ftBtn.style.borderColor = 'var(--accent)';
            ftBtn.style.color = 'var(--accent)';
            ftBtn.style.background = 'var(--accent-dim)';
            const notifyKey = maxFtMB + '::full';
            if (localStorage.getItem('herdr_ft_notified_key') !== notifyKey) {
              localStorage.setItem('herdr_ft_notified_key', notifyKey);
              openFinetuneModal(true);
            }
          } else {
            ftBtn.textContent = '🎯 Fine-Tune: ON (' + curFtMB + '/' + maxFtMB + ' MB · ' + pctInt + '%)';
            ftBtn.style.borderColor = 'rgba(16,185,129,0.45)';
            ftBtn.style.color = '#6ee7b7';
            ftBtn.style.background = '';
          }
        }
      }
      if (document.getElementById('finetuneModal') && document.getElementById('finetuneModal').style.display === 'flex') {
        syncFinetuneModalView(false);
      }

      if (!document.getElementById('workspaceInput').value && cfg.defaultWorkspace) {
        document.getElementById('workspaceInput').value = cfg.defaultWorkspace;
      }

      cachedJobs = data.jobs || [];
      const runningCnt = cachedJobs.filter(j => j.status === 'running' || j.status === 'awaiting_review').length;
      const hBtn = document.getElementById('historyToggleBtn');
      if (hBtn) {
        hBtn.textContent = runningCnt > 0
          ? '⚡ Running ' + runningCnt + ' · Jobs (' + cachedJobs.length + ')'
          : '🕒 History (' + cachedJobs.length + ')';
        hBtn.style.borderColor = runningCnt > 1 ? 'var(--accent)' : '';
        hBtn.style.color = runningCnt > 1 ? 'var(--accent)' : '';
      }

      if (cachedJobs.length > 0) {
        const newestChanged = lastNewestJobId && cachedJobs[0].jobId !== lastNewestJobId;
        if (newestChanged) isNewChatMode = false;
        const stillExists = cachedJobs.some(j => j.jobId === currentJobId);
        if (!isNewChatMode && (!currentJobId || !stillExists || newestChanged)) {
          currentJobId = cachedJobs[0].jobId;
        }
        lastNewestJobId = cachedJobs[0].jobId;
      } else {
        currentJobId = null;
        lastNewestJobId = null;
      }
      renderJobList();
      renderCurrentJob();
    }

    function toggleHistoryDrawer() {
      const dr = document.getElementById('historyDrawer');
      if (!dr) return;
      dr.style.display = dr.style.display === 'block' ? 'none' : 'block';
    }

    function startNewChat() {
      isNewChatMode = true;
      currentJobId = null;
      lastRenderedSignature = '';
      lastChatSignature = '';
      const dr = document.getElementById('historyDrawer');
      if (dr) dr.style.display = 'none';
      renderJobList();
      renderCurrentJob();
      const inp = document.getElementById('requestInput');
      if (inp) inp.focus();
    }

    async function pickWorkspaceFolder() {
      const btn = document.getElementById('pickFolderBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'Selecting...'; }
      try {
        const res = await api('/api/pick-folder', { method: 'POST' });
        if (res && res.path) {
          document.getElementById('workspaceInput').value = res.path;
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Browse'; }
      }
    }

    function onComposerKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        startMultiJob();
      }
    }

    function renderJobList() {
      const box = document.getElementById('jobsList');
      if (!box) return;
      if (cachedJobs.length === 0) {
        box.innerHTML = '<div style="font-size:11px; color:var(--muted);">No jobs executed yet.</div>';
        return;
      }
      box.innerHTML = cachedJobs.map(j => {
        const active = j.jobId === currentJobId ? 'active' : '';
        const tLabel = j.curation && j.curation.training_label ? ' · [' + esc(j.curation.training_label) + ']' : '';
        return '<div class="job-item ' + active + '" data-job-id="' + esc(j.jobId) + '" onclick="selectJob(this.dataset.jobId)">' +
          '<span>' + esc((j.request || '').slice(0, 26)) + ' (' + esc((j.units || []).length) + ' pairs)' + tLabel + '</span>' +
          '<strong>' + esc(j.status) + '</strong>' +
        '</div>';
      }).join('');
    }

    function selectJob(id) {
      isNewChatMode = false;
      currentJobId = id;
      const picked = cachedJobs.find(j => j.jobId === id);
      if (picked && picked.workspace) {
        document.getElementById('workspaceInput').value = picked.workspace;
      }
      const dr = document.getElementById('historyDrawer');
      if (dr) dr.style.display = 'none';
      renderJobList();
      renderCurrentJob();
    }

    function toggleDiff(unitId) {
      const key = (currentJobId || '') + '::' + unitId;
      const el = document.getElementById('diff-' + unitId);
      const btn = document.getElementById('diff-btn-' + unitId);
      if (openDiffKeys.has(key)) {
        openDiffKeys.delete(key);
        if (el) el.style.display = 'none';
        if (btn) btn.textContent = 'View Git Diff';
      } else {
        openDiffKeys.add(key);
        if (el) el.style.display = 'block';
        if (btn) btn.textContent = 'Hide Git Diff';
      }
    }

    async function submitFeedback(verdict) {
      if (!currentJobId) return;
      const noteEl = document.getElementById('feedbackNoteInput');
      const note = noteEl ? noteEl.value.trim() : '';
      const res = await api('/api/jobs/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: currentJobId, verdict, note }),
      });
      if (res.error) return alert(res.error);
      if (noteEl) noteEl.value = '';
      await refreshAll();
    }

    function renderCurrentJob() {
      const grid = document.getElementById('threadsGrid');
      const chatBox = document.getElementById('chatTimeline');
      const stopBtn = document.getElementById('stopJobBtn');
      const sendBtn = document.getElementById('sendChatBtn');
      const job = cachedJobs.find(j => j.jobId === currentJobId);

      if (!job) {
        lastRenderedSignature = '';
        lastChatSignature = '';
        zoomedUnitId = null;
        grid.classList.remove('zoomed');
        const lBadge = document.getElementById('leaderStateBadge');
        if (lBadge) { lBadge.textContent = 'IDLE'; lBadge.className = 'badge ok'; }
        if (stopBtn) stopBtn.style.display = 'none';
        if (sendBtn) sendBtn.textContent = '⏎ Send to C';
        const bBadge = document.getElementById('blockedCountBadge');
        if (bBadge) bBadge.style.display = 'none';
        if (chatBox) {
          chatBox.innerHTML =
            '<div class="msg-c">' +
              '<div class="msg-c-title"><span>👑 Core Leader C</span><span class="badge work">Auto-Orchestration Ready</span></div>' +
              '<div>Hello! Select your <strong>📁 Project Folder</strong> above and simply describe what you want to build or fix below.</div>' +
              '<div style="font-size:11px; color:var(--muted);">• I automatically decide the optimal number of <code>[A1·B1], [A2·B2]...</code> pairs, split vs. compete mode, and arrange the thread grid on the right.<br/>• You can also command Herdr CKD directly from your IDE via MCP.</div>' +
            '</div>';
        }
        grid.innerHTML = '<div style="color:var(--muted); font-size:13px; padding:6px;">Simply tell <strong>Core Leader C</strong> what you want in the chat on the left—<strong>C</strong> will autonomously size and arrange <code>[A1·B1], [A2·B2]...</code> thread pairs here.</div>';
        return;
      }

      const lBadge = document.getElementById('leaderStateBadge');
      if (lBadge) {
        lBadge.textContent = String(job.status || '').toUpperCase();
        lBadge.className = 'badge ' + (job.status === 'running' ? 'work' : job.status === 'failed' ? 'err' : 'ok');
      }
      if (stopBtn) stopBtn.style.display = job.status === 'running' ? 'inline-block' : 'none';
      if (sendBtn) {
        sendBtn.textContent = job.status === 'awaiting_review' ? '🔄 Send Rework' : '⏎ Send to C';
      }

      const isFtOn = !lastOverviewData || !lastOverviewData.config || lastOverviewData.config.curateLogs !== false;
      const tLabel = job.curation && job.curation.training_label;
      const sLabel = job.curation && job.curation.suggested_label;
      const allUnitsForChat = job.units || [];

      const chatSig = JSON.stringify({
        id: job.jobId,
        st: job.status,
        ph: job.phase,
        md: job.mode,
        rd: job.round,
        oc: job.overallCriteria,
        lj: job.lastJudge,
        rp: job.report,
        er: job.error,
        ft: isFtOn,
        tl: tLabel,
        sl: sLabel,
        us: allUnitsForChat.map(u => [u.unitId, u.status, u.round]),
      });

      if (chatBox && chatSig !== lastChatSignature) {
        lastChatSignature = chatSig;
        const unitChips = allUnitsForChat.map(u =>
          '<span class="unit-chip" data-unit-id="' + esc(u.unitId) + '" onclick="toggleZoomUnit(this.dataset.unitId)" title="Click to zoom thread card">' +
            '[' + esc(u.makerLabel) + '·' + esc(u.checkerLabel) + '] ' + esc((u.title || '').slice(0, 18)) + ' · <b>' + esc(String(u.status || '').toUpperCase()) + '</b>' +
          '</span>'
        ).join('');

        const criteriaHtml = (job.overallCriteria && job.overallCriteria.length)
          ? '<div style="font-size:11px; color:var(--muted);">🎯 <strong>Criteria:</strong> ' + esc(job.overallCriteria.join(' / ')) + '</div>'
          : '';

        let planSummary = 'Analyzing your request and planning thread pairs...';
        if (allUnitsForChat.length > 0) {
          planSummary = 'Analyzed your request and auto-arranged <strong>' + allUnitsForChat.length + ' thread pair(s) ([A1·B1]' + (allUnitsForChat.length > 1 ? ' ~ [A' + allUnitsForChat.length + '·B' + allUnitsForChat.length + ']' : '') + ')</strong> in <strong>' + (job.mode === 'compete' ? 'Compete' : 'Split') + ' mode</strong>.';
        }

        let verdictBubble = '';
        if (job.lastJudge || job.report || job.error || job.status === 'awaiting_review') {
          const judgeLine = job.lastJudge
            ? '<div style="font-weight:700; color:' + (job.lastJudge.verdict === 'PASS' ? 'var(--green)' : 'var(--accent)') + ';">[Core C Verdict: ' + esc(job.lastJudge.verdict) + '] ' + esc(job.lastJudge.reason) + '</div>'
            : '';
          const reportBody = job.report ? '<div style="white-space:pre-wrap;">' + esc(job.report) + '</div>' : '';
          const errBody = job.error ? '<div style="color:#f87171; white-space:pre-wrap;">[Notice] ' + esc(job.error) + '</div>' : '';
          const reviewRow = job.status === 'awaiting_review'
            ? '<div style="display:flex; gap:6px; margin-top:4px;">' +
                '<button type="button" class="primary" data-dec="accept" onclick="sendReview(this.dataset.dec)">✅ Accept</button>' +
                '<button type="button" data-dec="rework" onclick="sendReview(this.dataset.dec)">🔄 Rework</button>' +
              '</div>'
            : '';
          const labelBadgeText = tLabel ? ('Confirmed: ' + tLabel) : (sLabel ? ('Suggested: ' + sLabel) : 'Unrated');
          const labelClass = tLabel === 'good' ? 'ok' : tLabel === 'partial' ? 'work' : tLabel === 'bad' ? 'err' : '';
          const ftRow = (isFtOn && job.status !== 'running')
            ? '<div style="border-top:1px solid var(--border); padding-top:8px; margin-top:4px; display:flex; flex-direction:column; gap:5px;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; font-size:11px; color:var(--muted);">' +
                  '<span>🎯 Fine-Tuning Rating</span>' +
                  '<span class="badge ' + labelClass + '">' + esc(labelBadgeText) + '</span>' +
                '</div>' +
                '<div class="feedback-row">' +
                  '<button type="button" data-vd="correct" onclick="submitFeedback(this.dataset.vd)" style="padding:4px 6px; font-size:11px;">👍 Good</button>' +
                  '<button type="button" data-vd="partial" onclick="submitFeedback(this.dataset.vd)" style="padding:4px 6px; font-size:11px;">🤔 Partial</button>' +
                  '<button type="button" data-vd="incorrect" onclick="submitFeedback(this.dataset.vd)" style="padding:4px 6px; font-size:11px;">👎 Bad</button>' +
                '</div>' +
              '</div>'
            : '';

          verdictBubble =
            '<div class="msg-c">' +
              '<div class="msg-c-title"><span>👑 Core Leader C Final Verdict</span><span class="badge ' + (job.status === 'completed' ? 'ok' : 'work') + '">' + esc(job.phase || job.status) + '</span></div>' +
              judgeLine + reportBody + errBody + reviewRow + ftRow +
            '</div>';
        }

        chatBox.innerHTML =
          '<div class="msg-user">' + esc(job.request || '') + '</div>' +
          '<div class="msg-c">' +
            '<div class="msg-c-title"><span>👑 Core Leader C Orchestration</span><span class="badge work">' + esc(job.phase || '-') + '</span></div>' +
            '<div>' + planSummary + '</div>' +
            criteriaHtml +
            (unitChips ? '<div class="unit-chip-row">' + unitChips + '</div>' : '') +
          '</div>' +
          verdictBubble;
        chatBox.scrollTop = chatBox.scrollHeight;
      }

      function isUnitBlocked(u, parentJob) {
        if (!u) return false;
        if (u.status === 'failed') return true;
        if (u.status === 'done' || u.status === 'merged' || u.status === 'selected') {
          return parentJob && parentJob.status === 'awaiting_review';
        }
        if (u.lastChecker && u.lastChecker.status === 'NEEDS_FIX') return true;
        if (parentJob && (parentJob.status === 'failed' || parentJob.status === 'limit_reached')) return true;
        return false;
      }

      const allUnits = job.units || [];
      const blockedCount = allUnits.filter(u => isUnitBlocked(u, job)).length;
      const blockedBadge = document.getElementById('blockedCountBadge');
      if (blockedBadge) {
        blockedBadge.textContent = String(blockedCount);
        blockedBadge.style.display = blockedCount > 0 ? 'inline-block' : 'none';
      }

      if (zoomedUnitId && !allUnits.some(u => u.unitId === zoomedUnitId)) {
        zoomedUnitId = null;
      }

      const q = currentSearch.toLowerCase();
      const units = allUnits.filter(u => {
        if (zoomedUnitId && u.unitId !== zoomedUnitId) return false;
        if (currentFilter === 'working' && !(u.status === 'working' || u.status === 'pending')) return false;
        if (currentFilter === 'checking' && u.status !== 'checking') return false;
        if (currentFilter === 'blocked' && !isUnitBlocked(u, job)) return false;
        if (currentFilter === 'done' && !(u.status === 'done' || u.status === 'merged' || u.status === 'selected')) return false;
        if (q) {
          const hay = [
            u.unitId,
            u.title,
            u.instruction,
            (u.changedFiles || []).join(' '),
            (u.logs || []).map(l => l.summary).join(' '),
          ].join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      grid.classList.toggle('zoomed', Boolean(zoomedUnitId));

      const nextSig = JSON.stringify({
        jobId: job.jobId,
        status: job.status,
        round: job.round,
        phase: job.phase,
        filter: currentFilter,
        search: currentSearch,
        zoom: zoomedUnitId,
        blockedCount,
        units: units.map(u => ({
          id: u.unitId,
          st: u.status,
          r: u.round,
          cf: u.changedFiles,
          dp: (u.diffPreview || '').length,
          logsLen: (u.logs || []).length,
          lm: u.lastMaker,
          lc: u.lastChecker,
        })),
      });
      if (nextSig === lastRenderedSignature) return;
      lastRenderedSignature = nextSig;

      if (units.length === 0) {
        grid.innerHTML = '<div style="color:var(--muted); font-size:12px; padding:12px;">No threads match the current filter (' + esc(currentFilter) + ') or search query.</div>';
        return;
      }

      grid.innerHTML = units.map(u => {
        const logsHtml = (u.logs || []).map(l =>
          '<div class="log-line"><span class="actor">[' + esc(l.actor) + ']</span>' +
          (l.status ? '<b>(' + esc(l.status) + ')</b> ' : '') +
          esc(l.summary) + '</div>'
        ).join('') || '<div class="log-line">Waiting...</div>';

        const blockedFlag = isUnitBlocked(u, job) && u.status !== 'done' && u.status !== 'merged' && u.status !== 'selected';
        const safeStatusClass = ['pending', 'working', 'checking', 'done', 'failed', 'merged', 'selected'].includes(u.status)
          ? u.status
          : 'pending';
        const isZoomed = zoomedUnitId === u.unitId;
        const cardClasses = 'unit-card ' + safeStatusClass + (blockedFlag ? ' blocked' : '') + (isZoomed ? ' zoomed' : '');
        const changedFilesText = (u.changedFiles && u.changedFiles.length)
          ? u.changedFiles.map(esc).join(', ')
          : 'None';
        const isDiffOpen = openDiffKeys.has((currentJobId || '') + '::' + u.unitId);
        const summaryLen = isZoomed ? 240 : 70;

        return '<div class="' + cardClasses + '">' +
          '<div class="unit-header">' +
            '<div><strong>[' + esc(u.unitId) + '] ' + esc(u.title) + '</strong> <span style="font-size:11px; color:var(--muted);">(Round ' + esc(u.round) + ')</span></div>' +
            '<div style="display:flex; align-items:center; gap:6px;">' +
              (blockedFlag ? '<span class="badge err">Needs Fix</span>' : '') +
              '<button data-unit-id="' + esc(u.unitId) + '" onclick="toggleZoomUnit(this.dataset.unitId)" style="padding:2px 7px; font-size:10px;" title="Zoom Unit (Ctrl+B Z)">' + (isZoomed ? '🔎 Unzoom' : '🔍 Zoom') + '</button>' +
              '<span class="badge ' + (u.status === 'working' ? 'work' : u.status === 'checking' ? 'check' : u.status === 'failed' ? 'err' : 'ok') + '">' + esc(String(u.status || '').toUpperCase()) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="pair-boxes">' +
            '<div class="role-box">' +
              '<strong>🛠 ' + esc(u.makerLabel) + ' (Maker Thread)</strong>' +
              '<div>Status: ' + esc((u.lastMaker && u.lastMaker.status) || 'Idle') + '</div>' +
              '<div style="color:var(--muted); margin-top:3px;">' + esc(((u.lastMaker && u.lastMaker.summary) || u.instruction || '').slice(0, summaryLen)) + '</div>' +
            '</div>' +
            '<div class="role-box">' +
              '<strong>🔍 ' + esc(u.checkerLabel) + ' (Dedicated Checker)</strong>' +
              '<div>Status: ' + esc((u.lastChecker && u.lastChecker.status) || 'Idle') + '</div>' +
              '<div style="color:var(--muted); margin-top:3px;">' + esc(((u.lastChecker && u.lastChecker.summary) || 'Verifies immediately after A_n').slice(0, summaryLen)) + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="padding:6px 12px; font-size:11px; display:flex; justify-content:space-between; align-items:center; gap:8px; background:#14171f;">' +
            '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Changed Files: ' + changedFilesText + '</span>' +
            '<div style="display:flex; gap:5px; flex-shrink:0;">' +
              '<button data-unit-id="' + esc(u.unitId) + '" onclick="copyUnitLogs(this.dataset.unitId)" style="padding:2px 7px; font-size:10px; white-space:nowrap;" title="Copy logs and Git Diff for this unit">📋 Copy</button>' +
              '<button id="diff-btn-' + esc(u.unitId) + '" data-unit-id="' + esc(u.unitId) + '" onclick="toggleDiff(this.dataset.unitId)" style="padding:2px 8px; font-size:10px; white-space:nowrap;">' + (isDiffOpen ? 'Hide Git Diff' : 'View Git Diff') + '</button>' +
            '</div>' +
          '</div>' +
          '<div id="diff-' + esc(u.unitId) + '" class="diff-box" style="display:' + (isDiffOpen ? 'block' : 'none') + ';">' + esc(u.diffPreview || 'No changes') + '</div>' +
          '<div class="unit-logs">' + logsHtml + '</div>' +
        '</div>';
      }).join('');
    }

    async function startMultiJob() {
      const reqEl = document.getElementById('requestInput');
      const request = reqEl.value.trim();
      const workspace = document.getElementById('workspaceInput').value.trim();
      if (!request) return alert('Please enter a message for Core Leader C.');

      const activeJob = cachedJobs.find(j => j.jobId === currentJobId);
      if (activeJob && activeJob.status === 'awaiting_review') {
        reqEl.value = '';
        await api('/api/jobs/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: currentJobId, decision: 'rework', note: request }),
        });
        await refreshAll();
        return;
      }

      if (!workspace) return alert('Please select or enter a project folder path above first.');
      const payload = {
        request,
        workspace,
        mode: remoteOverrides.mode || 'auto',
        maxUnits: remoteOverrides.maxUnits || 6,
      };
      if (remoteOverrides.maxRounds !== undefined) payload.maxRounds = remoteOverrides.maxRounds;
      if (remoteOverrides.parallelUnits !== undefined) payload.parallelUnits = remoteOverrides.parallelUnits;
      remoteOverrides = {};

      const res = await api('/api/jobs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.error) return alert(res.error);
      reqEl.value = '';
      isNewChatMode = false;
      currentJobId = res.job.jobId;
      await refreshAll();
    }

    async function stopCurrentJob() {
      if (!currentJobId) return;
      await api('/api/jobs/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: currentJobId }),
      });
      await refreshAll();
    }

    async function sendReview(decision) {
      if (!currentJobId) return;
      const note = decision === 'rework' ? (prompt('Enter rework instructions:') || '') : 'Accepted';
      if (decision === 'rework' && !note.trim()) return;
      await api('/api/jobs/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: currentJobId, decision, note }),
      });
      await refreshAll();
    }

    function cleanupLogsNow() {
      const st = (lastOverviewData && lastOverviewData.storage) ? lastOverviewData.storage : { jobCount: 0, jobsMB: 0 };
      const sumEl = document.getElementById('cleanupSummaryText');
      if (sumEl) {
        sumEl.textContent = 'Currently stored job logs: ' + st.jobCount + ' jobs (' + st.jobsMB + ' MB)';
      }
      const resBox = document.getElementById('cleanupResultBox');
      if (resBox) resBox.style.display = 'none';
      document.getElementById('cleanupModal').style.display = 'flex';
    }

    function closeCleanupModal() {
      document.getElementById('cleanupModal').style.display = 'none';
    }

    async function executeCleanupLogs() {
      const res = await api('/api/cleanup', { method: 'POST' });
      currentJobId = null;
      lastNewestJobId = null;
      lastRenderedSignature = '';
      openDiffKeys.clear();
      await refreshAll();
      const st = (lastOverviewData && lastOverviewData.storage) ? lastOverviewData.storage : { jobCount: 0, jobsMB: 0 };
      const sumEl = document.getElementById('cleanupSummaryText');
      if (sumEl) {
        sumEl.textContent = 'Currently stored job logs: ' + st.jobCount + ' jobs (' + st.jobsMB + ' MB)';
      }
      const resBox = document.getElementById('cleanupResultBox');
      if (resBox) {
        resBox.textContent = '✅ Cleanup complete! Deleted job logs: ' + res.report.deletedJobs.length + ' · Freed space: ' + (res.report.freedBytes / (1024*1024)).toFixed(2) + ' MB';
        resBox.style.display = 'block';
      }
    }

    async function openSettings() {
      const data = await api('/api/overview');
      const cfg = data.config;
      document.getElementById('cfgUiHost').value = cfg.uiHost || '127.0.0.1';
      document.getElementById('cfgUiPort').value = cfg.uiPort || 37501;
      updateMcpPreview();
      document.getElementById('cfgLeaderModel').value = (cfg.roleModels?.C?.model) || cfg.model.model;
      document.getElementById('cfgLeaderUrl').value = (cfg.roleModels?.C?.baseUrl) || cfg.model.baseUrl || 'http://localhost:1234/v1';
      document.getElementById('cfgLeaderApiKey').value = (cfg.roleModels?.C?.apiKey) ? '***' : '';
      document.getElementById('cfgWorkerModel').value = cfg.model.model;
      document.getElementById('cfgWorkerUrl').value = cfg.model.baseUrl || 'http://localhost:1234/v1';
      document.getElementById('cfgWorkerApiKey').value = (cfg.model?.apiKey) ? '***' : '';
      document.getElementById('cfgCustomRules').value = cfg.customRules || '';
      document.getElementById('cfgUseWorktree').checked = cfg.threads ? Boolean(cfg.threads.useWorktree) : true;
      document.getElementById('cfgParallelUnits').checked = cfg.threads ? cfg.threads.parallelUnits !== false : true;
      document.getElementById('cfgEmitOsc7501').checked = cfg.herdr ? Boolean(cfg.herdr.emitOsc7501) : true;
      document.getElementById('cfgGithubMode').value = cfg.github.mode;
      document.getElementById('cfgMaxBranches').value = cfg.github.maxRemoteBranches;
      document.getElementById('cfgDeleteBranch').checked = cfg.github.deleteBranchOnComplete;
      document.getElementById('cfgMaxJobs').value = cfg.retention.maxJobsToKeep;
      document.getElementById('cfgMaxMB').value = cfg.retention.maxLogSizeMB;
      document.getElementById('cfgMaxFinetuneMB').value = cfg.retention.maxFinetuneSizeMB || 200;
      document.getElementById('cfgDeleteTemp').checked = cfg.retention.deleteTempOnComplete;
      document.getElementById('settingsModal').style.display = 'flex';
    }

    function closeSettings() {
      document.getElementById('settingsModal').style.display = 'none';
    }

    async function saveSettings() {
      const body = {
        uiHost: document.getElementById('cfgUiHost').value.trim() || '127.0.0.1',
        uiPort: Number(document.getElementById('cfgUiPort').value) || 37501,
        leaderModel: document.getElementById('cfgLeaderModel').value.trim(),
        leaderUrl: document.getElementById('cfgLeaderUrl').value.trim(),
        leaderApiKey: document.getElementById('cfgLeaderApiKey').value.trim(),
        workerModel: document.getElementById('cfgWorkerModel').value.trim(),
        workerUrl: document.getElementById('cfgWorkerUrl').value.trim(),
        workerApiKey: document.getElementById('cfgWorkerApiKey').value.trim(),
        customRules: document.getElementById('cfgCustomRules').value.trim(),
        useWorktree: document.getElementById('cfgUseWorktree').checked,
        parallelUnits: document.getElementById('cfgParallelUnits').checked,
        emitOsc7501: document.getElementById('cfgEmitOsc7501').checked,
        githubMode: document.getElementById('cfgGithubMode').value,
        maxRemoteBranches: Number(document.getElementById('cfgMaxBranches').value),
        deleteBranchOnComplete: document.getElementById('cfgDeleteBranch').checked,
        maxJobsToKeep: Number(document.getElementById('cfgMaxJobs').value),
        maxLogSizeMB: Number(document.getElementById('cfgMaxMB').value),
        maxFinetuneSizeMB: Number(document.getElementById('cfgMaxFinetuneMB').value),
        deleteTempOnComplete: document.getElementById('cfgDeleteTemp').checked,
      };
      await api('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      closeSettings();
      await refreshAll();
    }

    // Initialize horizontal & vertical drag resizers
    (function initResizers() {
      const root = document.documentElement;
      const colResizer = document.getElementById('colResizer');
      const savedW = Number(localStorage.getItem('herdr_left_col_w'));
      if (savedW >= 260 && savedW <= 900) {
        root.style.setProperty('--left-col-w', savedW + 'px');
      }

      if (colResizer) {
        colResizer.addEventListener('mousedown', (e) => {
          e.preventDefault();
          colResizer.classList.add('dragging');
          document.body.style.cursor = 'col-resize';
          const onMove = (ev) => {
            const nextW = Math.max(260, Math.min(Math.min(900, window.innerWidth - 360), ev.clientX));
            root.style.setProperty('--left-col-w', nextW + 'px');
            localStorage.setItem('herdr_left_col_w', String(nextW));
          };
          const onUp = () => {
            colResizer.classList.remove('dragging');
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
        colResizer.addEventListener('dblclick', () => {
          root.style.setProperty('--left-col-w', '400px');
          localStorage.removeItem('herdr_left_col_w');
        });
      }

      function bindVerticalResizer(handleId, boxId, storageKey, defaultH) {
        const handle = document.getElementById(handleId);
        const box = document.getElementById(boxId);
        if (!handle || !box) return;
        const savedH = Number(localStorage.getItem(storageKey));
        if (savedH >= 70 && savedH <= 800) {
          box.style.height = savedH + 'px';
        }
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          handle.classList.add('dragging');
          document.body.style.cursor = 'ns-resize';
          const startY = e.clientY;
          const startH = box.getBoundingClientRect().height;
          const onMove = (ev) => {
            const nextH = Math.max(70, Math.min(800, Math.round(startH + (ev.clientY - startY))));
            box.style.height = nextH + 'px';
            localStorage.setItem(storageKey, String(nextH));
          };
          const onUp = () => {
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        });
        handle.addEventListener('dblclick', () => {
          box.style.height = defaultH + 'px';
          localStorage.removeItem(storageKey);
        });
      }

      bindVerticalResizer('reportResizer', 'leaderReportBox', 'herdr_report_h', 180);
      bindVerticalResizer('jobsResizer', 'jobsList', 'herdr_jobs_h', 160);
    })();

    async function shutdownBackgroundServer() {
      if (!confirm('Stop the background Herdr CKD server and MCP endpoint completely? (Closing the window alone detaches and leaves the session running)')) return;
      await api('/api/shutdown', { method: 'POST' });
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#9ca3af;font-size:15px;">🛑 Herdr CKD background server has shut down cleanly. You may close this window.</div>';
      setTimeout(() => { try { window.close(); } catch {} }, 400);
    }

    function handleRemoteUiAction(ev) {
      if (!ev || !ev.uiAction) return;
      if (ev.uiAction === 'set_form') {
        if (ev.workspace !== undefined) document.getElementById('workspaceInput').value = ev.workspace;
        if (ev.request !== undefined) document.getElementById('requestInput').value = ev.request;
        if (ev.mode !== undefined) remoteOverrides.mode = ev.mode;
        if (ev.maxUnits !== undefined) remoteOverrides.maxUnits = Number(ev.maxUnits);
        if (ev.parallelUnits !== undefined) remoteOverrides.parallelUnits = Boolean(ev.parallelUnits);
        if (ev.maxRounds !== undefined) remoteOverrides.maxRounds = Number(ev.maxRounds);
        if (ev.jobId) {
          isNewChatMode = false;
          currentJobId = ev.jobId;
        }
        refreshAll();
      } else if (ev.uiAction === 'select_job' && ev.jobId) {
        selectJob(ev.jobId);
      } else if (ev.uiAction === 'set_filter' && ev.filter) {
        setFilter(ev.filter);
      } else if (ev.uiAction === 'set_search') {
        const s = document.getElementById('unitSearchInput');
        if (s) s.value = ev.search || '';
        onSearchInput(ev.search || '');
      } else if (ev.uiAction === 'zoom_unit') {
        if (ev.open === false || !ev.unitId) toggleZoomUnit(null);
        else if (ev.open === true) { zoomedUnitId = ev.unitId; renderCurrentJob(); }
        else toggleZoomUnit(ev.unitId);
      } else if (ev.uiAction === 'toggle_diff') {
        const job = cachedJobs.find(j => j.jobId === currentJobId);
        const targets = ev.unitId === 'all'
          ? (job && job.units ? job.units.map(u => u.unitId) : [])
          : (ev.unitId ? [ev.unitId] : []);
        for (const uid of targets) {
          const key = (currentJobId || '') + '::' + uid;
          const isOpen = openDiffKeys.has(key);
          if (ev.open === true && !isOpen) toggleDiff(uid);
          else if (ev.open === false && isOpen) toggleDiff(uid);
          else if (ev.open === undefined) toggleDiff(uid);
        }
      } else if (ev.uiAction === 'open_settings') {
        openSettings();
      } else if (ev.uiAction === 'close_settings') {
        closeSettings();
      } else {
        refreshAll();
      }
    }

    const evtSource = new EventSource('/api/events');
    evtSource.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data || '{}');
        if (parsed && parsed.uiAction) {
          handleRemoteUiAction(parsed);
          return;
        }
      } catch {}
      refreshAll();
    };
    refreshAll();
    setInterval(refreshAll, 3000);
  </script>
</body>
</html>`;
}
