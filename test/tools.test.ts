// 도구 스위치(Serena, Headroom) 테스트. Serena 실제 연결은 CKD_TEST_SERENA에 serena 실행 파일 경로를 주면 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, modelFor } from "../src/config.js";
import { allowedFor, startSerena } from "../src/serena.js";
import { decodeOutput, resolveForRead, runTool, toolSpecs } from "../src/tools.js";
import { githubSearch, webSearch } from "../src/web.js";
import { shellNote, systemPromptB } from "../src/prompts.js";

function configWith(tools: Record<string, unknown>) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "ollama", model: "qwen3:8b" }, tools }));
  return loadConfig({ CKD_DATA_DIR: dataDir });
}

test("Headroom을 켜면 모델 호출이 프록시로 가고 원래 주소는 따로 남는다", () => {
  const off = modelFor(configWith({}), "A");
  assert.equal(off.baseUrl, "http://localhost:11434/v1");
  const on = modelFor(configWith({ headroom: true }), "A");
  assert.equal(on.baseUrl, "http://localhost:8787/v1");
  assert.equal(on.upstreamUrl, "http://localhost:11434/v1");
});

test("B(Checker)는 Serena 수정 도구를 받지 않는다", () => {
  assert.ok(allowedFor("A").includes("replace_symbol_body"));
  assert.ok(!allowedFor("B").includes("replace_symbol_body"));
  assert.ok(allowedFor("B").includes("find_symbol"));
  assert.deepEqual(allowedFor("C"), []);
});

test("Serena 실제 연결", { skip: !process.env.CKD_TEST_SERENA }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-serena-"));
  fs.writeFileSync(path.join(ws, "calc.py"), "def add(a, b):\n    return a + b\n");
  const config = configWith({ serena: true, serenaCommand: process.env.CKD_TEST_SERENA, serenaArgs: ["start-mcp-server"] });
  const ext = await startSerena(config, ws);
  try {
    assert.ok(ext.specs("A").some((s) => s.function.name === "serena_replace_symbol_body"));
    assert.ok(!ext.specs("B").some((s) => s.function.name === "serena_replace_symbol_body"));
    const overview = await ext.call("B", "serena_get_symbols_overview", JSON.stringify({ relative_path: "calc.py" }));
    assert.match(overview, /add/);
    assert.match(await ext.call("B", "serena_replace_symbol_body", "{}"), /허용되지 않은/);
  } finally {
    await ext.close();
  }
});

test("GitHub 검색 결과를 정리해서 돌려준다", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    assert.match(req.url!, /^\/search\/repositories\?q=mcp/);
    // 단어가 많으면 0건을 돌려주고, 넓힌 검색어에만 결과를 준다.
    if (decodeURIComponent(req.url!).includes("mcp server python")) return res.end(JSON.stringify({ items: [] }));
    res.end(JSON.stringify({ items: [{ full_name: "a/b", stargazers_count: 10, license: { spdx_id: "MIT" }, pushed_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/a/b", description: "desc" }] }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const out = await githubSearch("mcp", "repositories", 3, {}, base);
    assert.match(out, /a\/b ★10 \(MIT/);
    assert.match(await githubSearch("x", "code", 3, {}, base), /GITHUB_TOKEN/);
    const broadened = await githubSearch("mcp server python sqlite", "repositories", 3, {}, base);
    assert.match(broadened, /"mcp server"로 넓혀/);
    assert.match(broadened, /a\/b/);
    // 결과가 1건이어도 넓혀서 더 찾는다.
    const one = await githubSearch("mcp tool jsonl stats", "repositories", 3, {}, base);
    assert.match(one, /검색 결과 1건/);
    assert.match(one, /"mcp tool"로 넓혀/);
  } finally {
    server.close();
  }
});

test("인터넷 검색은 DuckDuckGo 결과를 중복 없이 보여준다", async () => {
  const rows = [
    { title: "T1", summary: "S1", url: "https://www.x.com/a/", source: "ddg" },
    { title: "T1 dup", summary: "S", url: "https://x.com/a", source: "ddg" },
    { title: "T2", summary: "S2", url: "https://y.com", source: "ddg" },
  ];
  const config = configWith({ ddgsCommand: ["node", "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(rows))})`] });
  const out = await webSearch("q", 5, config, {});
  assert.match(out, /1\. T1/);
  assert.match(out, /2\. T2/);
  assert.doesNotMatch(out, /dup/);
});

test("검색 도구는 A·B·C 모두 받고, 끄면 사라진다", () => {
  const on = configWith({});
  for (const role of ["A", "B", "C"] as const) {
    assert.ok(toolSpecs(role, on).some((t) => t.function.name === "web_search"), role);
  }
  assert.ok(!toolSpecs("C", configWith({ web: false })).some((t) => t.function.name === "web_search"));
  assert.ok(!toolSpecs("B", on).some((t) => t.function.name === "write_file"));
  // C는 판정 전에 직접 계산해 볼 수 있지만 파일을 고칠 수는 없다.
  assert.ok(toolSpecs("C", on).some((t) => t.function.name === "run_command"));
  assert.ok(!toolSpecs("C", on).some((t) => t.function.name === "write_file" || t.function.name === "edit_file"));
});

test("Windows 셸 안내와 B의 실제 입력 검수 규칙이 프롬프트에 들어간다", () => {
  const note = shellNote("win32");
  assert.match(note, /mkdir -p 대신 mkdir/);
  assert.match(note, /python -m pytest/);
  assert.match(systemPromptB(configWith({})), /실제 입력/);
  assert.match(systemPromptB(configWith({})), /기대값/);
});

test("run_command 출력은 UTF-8이 아니면 cp949로 다시 읽는다", () => {
  assert.equal(decodeOutput(Buffer.from([0xbe, 0xf8, 0xb4, 0xc2])), "없는");
  assert.equal(decodeOutput(Buffer.from("한글 utf8")), "한글 utf8");
});

test("readPaths 안은 읽기만 되고, 쓰기는 작업 폴더만 된다", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-real-"));
  const jobsFile = path.join(data, "jobs.jsonl");
  fs.writeFileSync(jobsFile, '{"outcome":"completed","rounds":1}\n');
  const config = { ...configWith({}), readPaths: [data] };
  assert.match(await runTool("B", "read_file", JSON.stringify({ path: jobsFile }), { workspace, config }), /"rounds":1/);
  assert.throws(() => resolveForRead(workspace, [], jobsFile), /작업 폴더 밖/);
  const out = await runTool("A", "write_file", JSON.stringify({ path: path.join(data, "x.txt"), content: "x" }), { workspace, config });
  assert.match(out, /작업 폴더 밖/);
  assert.ok(!fs.existsSync(path.join(data, "x.txt")));
});

test("네이버 검색은 API HUB 방식이 기본이고, developers 방식도 고를 수 있다", async () => {
  const http = await import("node:http");
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url!);
    const hub = req.url!.startsWith("/search/v1/webkr?query=");
    if (hub) assert.equal(req.headers["x-ncp-apigw-api-key-id"], "id");
    else assert.equal(req.headers["x-naver-client-id"], "id");
    res.end(JSON.stringify({ items: [{ title: `<b>${hub ? "HUB" : "DEV"}</b>`, description: "d", link: `https://n.example/${seen.length}` }] }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const config = configWith({ ddgsCommand: ["node", "-e", "process.stdout.write('[]')"] });
    const env = { NAVER_CLIENT_ID: "id", NAVER_CLIENT_SECRET: "secret", NAVER_SEARCH_BASE_URL: base, NAVER_OPENAPI_BASE_URL: base };
    assert.match(await webSearch("q", 1, config, env), /1\. HUB/);
    assert.match(await webSearch("q", 1, config, { ...env, NAVER_SEARCH_PROVIDER: "developers" }), /1\. DEV/);
    assert.equal(seen.length, 2);
  } finally {
    server.close();
  }
});

test("browser_check는 HTML을 file://로 열어 모듈 로딩 오류와 클릭 결과를 보여 준다", async (t) => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const has = (name: string) => {
    try {
      require.resolve(name);
      return true;
    } catch {
      return false;
    }
  };
  if (!has("playwright-core") && !has("playwright")) return t.skip("playwright-core가 설치되지 않음");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-html-"));
  fs.writeFileSync(path.join(workspace, "lib.js"), "export const n = 1;");
  fs.writeFileSync(
    path.join(workspace, "module.html"),
    '<div id="b"></div><script type="module">import { n } from "./lib.js"; document.getElementById("b").textContent = "ok" + n;</script>',
  );
  fs.writeFileSync(
    path.join(workspace, "plain.html"),
    '<button id="go">go</button><p id="out">0</p><script>document.getElementById("go").onclick = () => { document.getElementById("out").textContent = "1"; };</script>',
  );
  const config = configWith({ web: false });
  const ctx = { workspace, config };
  assert.match(await runTool("B", "browser_check", JSON.stringify({ target: "module.html" }), ctx), /콘솔 오류 [1-9]|실패한 요청 [1-9]/);
  const plain = await runTool("B", "browser_check", JSON.stringify({ target: "plain.html", actions: [{ type: "click", selector: "#go" }], count: ["button"] }), ctx);
  assert.match(plain, /개수 button: 1/);
  assert.match(plain, /콘솔 오류 0개/);
  assert.match(plain, /go\s+1/);
  // 누른 채로 있기: 양쪽 버튼을 누른 상태가 유지된다.
  fs.writeFileSync(
    path.join(workspace, "hold.html"),
    '<button id="h">h</button><p id="s">up</p><script>document.addEventListener("mousedown", (e) => { document.getElementById("s").textContent = "down" + e.buttons; }); document.addEventListener("mouseup", () => { document.getElementById("s").textContent = "up"; }); document.addEventListener("contextmenu", (e) => e.preventDefault());</script>',
  );
  const hold = await runTool(
    "B",
    "browser_check",
    JSON.stringify({ target: "hold.html", actions: [{ type: "mouse_move", selector: "#h" }, { type: "mouse_down", button: "left" }, { type: "mouse_down", button: "right" }] }),
    ctx,
  );
  assert.match(hold, /down3/);
  // 모르는 동작은 click으로 바꾸지 않고 오류로 알린다.
  assert.match(await runTool("B", "browser_check", JSON.stringify({ target: "plain.html", actions: [{ type: "pointerdown", selector: "#go" }] }), ctx), /알 수 없는 동작입니다: pointerdown/);
  // 키보드 누르기
  fs.writeFileSync(path.join(workspace, "key.html"), '<p id="k">none</p><script>document.addEventListener("keydown", (e) => { document.getElementById("k").textContent = e.key; });</script>');
  const key = await runTool("B", "browser_check", JSON.stringify({ target: "key.html", actions: [{ type: "key_press", key: "ArrowUp" }] }), ctx);
  assert.match(key.split("화면 글자")[1] ?? "", /ArrowUp/);
  // mouse_down/mouse_up에 selector가 있으면 그 요소를 누른다 (먼저 옮기지 않아도).
  fs.writeFileSync(path.join(workspace, "target.html"), '<div style="height:200px"></div><button id="b2" style="margin-left:300px">b2</button><p id="t">none</p><script>document.addEventListener("mousedown", (e) => { document.getElementById("t").textContent = "down:" + (e.target.id || "none"); });</script>');
  const pressed = await runTool("B", "browser_check", JSON.stringify({ target: "target.html", actions: [{ type: "mouse_down", selector: "#b2" }, { type: "mouse_up", selector: "#b2" }] }), ctx);
  assert.match(pressed, /down:b2/);
  assert.match(await runTool("B", "browser_check", JSON.stringify({ target: "target.html", actions: [{ type: "mouse_down", selector: "#nothing" }] }), ctx), /요소가 화면에 없습니다/);
  // 숨겨진 요소도 전체 개수에는 들어가지만, 보이는 개수는 0이다.
  fs.writeFileSync(path.join(workspace, "hidden.html"), '<div id="over" style="display:none"><h2>GAME OVER</h2></div>');
  assert.ok((await runTool("B", "browser_check", JSON.stringify({ target: "hidden.html", count: ["#over h2"] }), ctx)).includes("개수 #over h2: 1 (화면에 보이는 것 0)"));
});

// 1x1 PNG
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// 손으로 만든 2쪽짜리 PDF (글자: "Snake spec page 1", "Head is yellow")
function tinyPdf(): Buffer {
  const s1 = "BT /F1 24 Tf 40 100 Td (Snake spec page 1) Tj ET";
  const s2 = "BT /F1 24 Tf 40 100 Td (Head is yellow) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    `<< /Length ${s1.length} >> stream\n${s1}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    `<< /Length ${s2.length} >> stream\n${s2}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj ${o} endobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("view_image는 이미지를 다음 메시지에 붙이게 넘기고, 이미지가 아니거나 허용 밖이면 막는다", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  fs.writeFileSync(path.join(workspace, "a.png"), TINY_PNG);
  fs.writeFileSync(path.join(workspace, "a.txt"), "x");
  const config = configWith({ web: false });
  const seen: { type: string; image_url?: { url: string }; source?: string }[] = [];
  const out = await runTool("B", "view_image", JSON.stringify({ path: "a.png" }), { workspace, config, onImage: (p) => seen.push(p as never) });
  assert.match(out, /다음 메시지에 붙였습니다/);
  assert.equal(seen.length, 1);
  assert.match(seen[0].image_url!.url, /^data:image\/png;base64,/);
  assert.equal(seen[0].source, path.join(workspace, "a.png"));
  assert.match(await runTool("B", "view_image", JSON.stringify({ path: "a.txt" }), { workspace, config }), /이미지 파일이 아닙니다/);
  assert.match(await runTool("B", "view_image", JSON.stringify({ path: path.join(os.tmpdir(), "x.png") }), { workspace, config }), /작업 폴더 밖/);
});

test("첨부 파일 준비: 이미지는 그림으로, 문서는 글자로, 3D는 안내만, 상한과 vision 끄기", async () => {
  const { prepareAttachments } = await import("../src/attachments.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-att-"));
  const out = path.join(dir, "out");
  const png = path.join(dir, "ref.png");
  const png2 = path.join(dir, "ref2.png");
  const txt = path.join(dir, "spec.md");
  const glb = path.join(dir, "model.glb");
  fs.writeFileSync(png, TINY_PNG);
  fs.writeFileSync(png2, TINY_PNG);
  fs.writeFileSync(txt, "# 기획");
  fs.writeFileSync(glb, "glTF");
  const limits = { vision: true, maxImages: 1, maxImageBytes: 5 * 1024 * 1024, pdfPages: 3 };
  const r = await prepareAttachments([png, png2, txt, glb], out, limits);
  assert.equal(r.images.length, 1, "상한 1장");
  assert.match(r.notes[0], /그림으로 붙어 있음/);
  assert.match(r.notes[1], /상한/);
  assert.match(r.notes[2], /글자 파일: read_file/);
  assert.match(r.notes[3], /렌더링한 이미지로 바꿔/);
  const off = await prepareAttachments([png], out, { ...limits, vision: false });
  assert.equal(off.images.length, 0);
  assert.match(off.notes[0], /꺼져 있어/);
});

test("첨부 PDF는 글자 파일과 앞쪽 페이지 그림으로 바뀐다", async (t) => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  try {
    require.resolve("officeparser");
    require.resolve("pdf-to-png-converter");
  } catch {
    return t.skip("officeparser 또는 pdf-to-png-converter가 없음");
  }
  const { prepareAttachments } = await import("../src/attachments.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-pdf-"));
  const pdf = path.join(dir, "spec.pdf");
  fs.writeFileSync(pdf, tinyPdf());
  const r = await prepareAttachments([pdf], path.join(dir, "out"), { vision: true, maxImages: 6, maxImageBytes: 5 * 1024 * 1024, pdfPages: 3 });
  assert.equal(r.warnings.length, 0, r.warnings.join("; "));
  assert.equal(r.images.length, 2, "2쪽 모두 그림");
  const textFile = fs.readdirSync(path.join(dir, "out")).find((f) => f.endsWith(".txt"))!;
  const text = fs.readFileSync(path.join(dir, "out", textFile), "utf8");
  assert.match(text, /Snake spec page 1/);
  assert.match(text, /Head is yellow/);
});

test("이상한 문자가 들어간 쓰기 경로는 실행하지 않는다", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  const config = configWith({ web: false });
  for (const bad of ["index.html`", " index.html", 'a"b.txt', "a|b.txt", "a:b.txt"]) {
    const out = await runTool("A", "write_file", JSON.stringify({ path: bad, content: "x" }), { workspace, config });
    assert.match(out, /도구 실행 안 함/, bad);
  }
  assert.deepEqual(fs.readdirSync(workspace), []);
  assert.match(await runTool("A", "write_file", JSON.stringify({ path: "sub/ok.txt", content: "x" }), { workspace, config }), /저장함/);
  assert.match(await runTool("A", "write_file", JSON.stringify({ path: path.join(workspace, "abs.txt"), content: "x" }), { workspace, config }), /저장함/, "드라이브 표기가 있는 절대 경로는 허용");
  assert.match(await runTool("A", "edit_file", JSON.stringify({ path: "ok.txt`", old_text: "x", new_text: "y" }), { workspace, config }), /도구 실행 안 함/);
});

test("CKD_ENV_FILE의 .env에서 검색 키만 읽고, 이미 있는 값은 덮어쓰지 않는다", async () => {
  const { loadSearchKeys } = await import("../src/web.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, 'NAVER_CLIENT_ID="abc"\r\nNAVER_CLIENT_SECRET=def\nOTHER_SECRET=zzz\nGITHUB_TOKEN=\n');
  const env: NodeJS.ProcessEnv = { NAVER_CLIENT_SECRET: "keep" };
  assert.deepEqual(loadSearchKeys(file, env), ["NAVER_CLIENT_ID"]);
  assert.equal(env.NAVER_CLIENT_ID, "abc");
  assert.equal(env.NAVER_CLIENT_SECRET, "keep");
  assert.equal(env.OTHER_SECRET, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.deepEqual(loadSearchKeys(path.join(dir, "none.env"), env), []);
});
