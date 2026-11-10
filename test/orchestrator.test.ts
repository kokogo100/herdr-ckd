// 가짜 OpenAI 호환 모델 서버로 A·B·C 반복 흐름을 끝까지 돌려 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Job, extractJson, inventedPaths, snapshotWorkspace } from "../src/orchestrator.js";
import { parseStatus } from "../src/session.js";
import { resolveInWorkspace, runTool } from "../src/tools.js";

type Msg = { role: string; content: string | null; tool_calls?: unknown[] };

function status(s: string, summary = "") {
  return `\n<CKD_STATUS>{"status": "${s}", "summary": "${summary}"}</CKD_STATUS>`;
}

// 역할은 시스템 프롬프트로 구분하고, 각 역할의 몇 번째 답인지로 각본을 고른다.
function startMockServer(): Promise<{ url: string; close: () => void; seen: Record<string, Msg[][]> }> {
  const counters: Record<string, number> = { A: 0, B: 0, C: 0 };
  const seen: Record<string, Msg[][]> = { A: [], B: [], C: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const messages: Msg[] = parsed.messages;
      const sys = messages[0].content ?? "";
      const role = sys.startsWith("당신은 CKD 협업의 A") ? "A" : sys.startsWith("당신은 CKD 협업의 B") ? "B" : "C";
      seen[role].push(messages);
      const last = messages[messages.length - 1];
      let message: Record<string, unknown>;

      if (role === "A" && last.role === "user") {
        counters.A++;
        // A는 먼저 도구로 파일을 쓴다.
        message = {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `call${counters.A}`, type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: `v${counters.A}` }) } }],
        };
      } else if (role === "A") {
        message = { role: "assistant", content: `<think>생각 중</think>hello.txt를 v${counters.A}로 작성했습니다.${status("DONE", "작성 완료")}` };
      } else if (role === "B") {
        counters.B++;
        message = counters.B === 1
          ? { role: "assistant", content: `내용에 인사말이 없습니다.${status("NEEDS_FIX", "인사말 누락")}` }
          : { role: "assistant", content: `확인했습니다.${status("DONE", "검수 통과")}` };
      } else if (last.role === "user" && last.content?.includes("모두 완료를 선언했습니다")) {
        // C는 판정 전에 도구로 직접 확인한다.
        message = { role: "assistant", content: "", tool_calls: [{ id: `cj${messages.length}`, type: "function", function: { name: "list_dir", arguments: "{}" } }] };
      } else {
        counters.C++;
        const replies = [
          '{"instruction_for_A": "hello.txt를 만드세요", "done_criteria": ["hello.txt가 있음"]}',
          // 대조 단계에서 빠진 정의를 채운다.
          '{"requirements": ["hello.txt 생성"], "instruction_for_A": "hello.txt를 만드세요", "done_criteria": ["hello.txt가 있음"], "definitions": [{"item": "버전", "source": "hello.txt 내용", "formula": "v 뒤의 숫자"}]}',
          '```json\n{"verdict": "FAIL", "reason": "버전이 부족함", "instruction_for_A": "한 번 더 작성"}\n```',
          '{"verdict": "PASS", "reason": "조건 충족", "report_for_user": "hello.txt를 만들었습니다."}',
        ];
        message = { role: "assistant", content: replies[counters.C - 1] };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close(), seen });
    });
  });
}

test("A·B·C 반복: B 수정 요청 → C 실패 판정 → 최종 완료", async () => {
  const mock = await startMockServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  fs.writeFileSync(
    path.join(dataDir, "ckd.config.json"),
    JSON.stringify({ model: { backend: "custom", baseUrl: mock.url, model: "mock" }, requireReview: false }),
  );

  try {
    const config = loadConfig({ CKD_DATA_DIR: dataDir });
    const job = new Job(config, "hello.txt 파일을 만들어줘", workspace);
    const state = await job.done;

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.round, 3);
    assert.equal(state.report, "hello.txt를 만들었습니다.");
    assert.equal(fs.readFileSync(path.join(workspace, "hello.txt"), "utf8"), "v3");

    // B는 사용자 원래 요청과 C의 항목 정의, 그리고 A의 원문을 출처와 함께 받는다.
    const bFirstInput = mock.seen.B[0].at(-1)!.content!;
    assert.match(bFirstInput, /^사용자의 원래 요청:/);
    assert.match(bFirstInput, /hello\.txt 파일을 만들어줘/);
    assert.match(bFirstInput, /버전: hello\.txt 내용, v 뒤의 숫자/);
    assert.match(bFirstInput, /A라는 AI가 이렇게 진행했어/);
    assert.match(mock.seen.A[0].at(-1)!.content!, /항목 정의/);
    assert.ok(!bFirstInput.includes("<think>"), "사고 블록은 전달하지 않음");
    // A는 B의 검토를 받는다.
    assert.match(mock.seen.A.flat().find((m) => m.content?.startsWith("B라는 AI"))!.content!, /인사말이 없습니다/);
    // C의 실패 판정 뒤에는 C의 재지시가 간다.
    assert.ok(mock.seen.A.some((ms) => ms.some((m) => m.content?.startsWith("C(전달자)가 판단하기에"))));

    // 기록: 파인튜닝용 JSONL과 작업 결과 목록
    const ft = path.join(dataDir, "finetune");
    for (const role of ["A", "B", "C"]) {
      const lines = fs.readFileSync(path.join(ft, `${role}.jsonl`), "utf8").trim().split("\n");
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.meta.outcome, "completed");
      assert.equal(rec.messages[0].role, "system");
    }
    const aRec = JSON.parse(fs.readFileSync(path.join(ft, "A.jsonl"), "utf8"));
    assert.ok(aRec.messages.some((m: Msg) => m.role === "tool"), "도구 호출도 기록됨");
    assert.ok(aRec.messages.some((m: Msg) => m.content?.includes("<think>")), "원문은 사고 블록까지 보존");
    assert.match(fs.readFileSync(path.join(ft, "jobs.jsonl"), "utf8"), /"outcome":"completed"/);
    const events = fs.readFileSync(path.join(job.recorder.jobDir, "events.jsonl"), "utf8");
    assert.match(events, /"type":"judge"/);
    assert.doesNotMatch(events, /judge_unverified/, "C가 직접 확인했으니 되돌려 보내지 않음");
  } finally {
    mock.close();
  }
});

test("데이터 폴더(외장 SSD)가 없으면 멈춘다", () => {
  assert.throws(() => loadConfig({ CKD_DATA_DIR: "/no/such/volume/CKD" }), /외장 SSD/);
});

test("상태 블록은 맨 끝의 것만 인정한다", () => {
  assert.equal(parseStatus(`본문${status("DONE")}`, ["DONE"])?.status, "DONE");
  assert.equal(parseStatus(`인용: <CKD_STATUS>{"status":"DONE"}</CKD_STATUS> 이후 본문`, ["DONE"]), undefined);
  assert.equal(parseStatus(`본문${status("MAYBE")}`, ["DONE"]), undefined);
});

test("C의 JSON은 코드 블록 안에 있어도 읽는다", () => {
  assert.deepEqual(extractJson('```json\n{"verdict":"PASS"}\n```'), { verdict: "PASS" });
});

test("필수 인자가 빠진 도구 호출은 실행하지 않는다", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "ollama", model: "x" } }));
  const config = loadConfig({ CKD_DATA_DIR: dataDir });
  assert.match(await runTool("A", "write_file", JSON.stringify({ content: "hi" }), { workspace, config }), /필수 인자 path가 없습니다/);
  assert.deepEqual(fs.readdirSync(workspace), []);
});

test("작업 폴더 밖 경로는 막는다", () => {
  assert.throws(() => resolveInWorkspace("/tmp/ws", "../etc/passwd"));
  assert.equal(resolveInWorkspace("/tmp/ws", "a/b.txt"), path.resolve("/tmp/ws/a/b.txt"));
});

test("도구 한도에 닿아도 작업을 버리지 않고, 같은 호출 반복은 막는다", async () => {
  const { RoleSession } = await import("../src/session.js");
  const { Recorder } = await import("../src/recorder.js");
  const toolOutputs: string[] = [];
  let sawLimitNotice = false;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const messages: Msg[] = parsed.messages;
      for (const m of messages) if (m.role === "tool") toolOutputs.push(m.content ?? "");
      sawLimitNotice ||= messages.some((m) => m.role === "user" && m.content?.includes("도구 호출 한도"));
      // 도구가 주어지면 계속 같은 명령을 부르고, 도구가 없으면 결론을 낸다.
      const message = parsed.tools
        ? { role: "assistant", content: "", tool_calls: [{ id: `c${messages.length}`, type: "function", function: { name: "list_dir", arguments: "{}" } }] }
        : { role: "assistant", content: `확인한 범위에서 문제를 적습니다.${status("NEEDS_FIX", "한도 도달")}` };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "custom", baseUrl: url, model: "mock" }, maxToolSteps: 4, tools: { web: false } }));
  try {
    const config = loadConfig({ CKD_DATA_DIR: dataDir });
    const session = new RoleSession("B", config.model, "당신은 CKD 협업의 B", config, new Recorder(dataDir, "t1"), workspace, ["DONE", "NEEDS_FIX", "QUESTION"]);
    const reply = await session.send("검수해 주세요");
    assert.equal(reply.status?.status, "NEEDS_FIX");
    assert.ok(reply.hitToolLimit);
    assert.ok(sawLimitNotice, "한도 안내를 받음");
    assert.ok(toolOutputs.some((o) => o.includes("3번 이상 반복")), "반복 호출은 실행하지 않음");
  } finally {
    server.close();
  }
});

test("대조 단계가 만든 없는 경로(오타)를 찾아낸다", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-snap-"));
  const draft = JSON.stringify({ done_criteria: [`${real} 에서 실행`] });
  assert.deepEqual(inventedPaths(draft, JSON.stringify({ done_criteria: [`${real} 에서 실행`, `${path.join(real, "out.txt")} 생성`] })).length, 1);
  assert.deepEqual(inventedPaths(draft, draft), []);
  assert.deepEqual(inventedPaths(draft, JSON.stringify({ done_criteria: [`${real}-typo 에서 실행`] })), [`${real}-typo`]);
  // Windows 경로도 JSON 이스케이프를 풀어서 본다.
  assert.deepEqual(inventedPaths("{}", JSON.stringify({ x: "F:\\Coding\\CKD\\test-data\\ckd-snapshot 폴더" })), ["F:\\Coding\\CKD\\test-data\\ckd-snapshot"]);
});

test("작업 시작 때 작업 폴더 사본을 남기고, 가상환경 등은 뺀다", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  fs.writeFileSync(path.join(ws, "report.py"), "print(1)");
  fs.mkdirSync(path.join(ws, ".venv"));
  fs.writeFileSync(path.join(ws, ".venv", "big.bin"), "x");
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ckd-job-")), "original");
  assert.equal(snapshotWorkspace(ws, dest), dest);
  assert.equal(fs.readFileSync(path.join(dest, "report.py"), "utf8"), "print(1)");
  assert.ok(!fs.existsSync(path.join(dest, ".venv")));
  // 빈 폴더는 사본을 만들지 않는다.
  assert.equal(snapshotWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), "ckd-empty-")), dest + "2"), undefined);
});

test("실패한 명령은 자동으로 모은다", async () => {
  const { RoleSession } = await import("../src/session.js");
  const { Recorder } = await import("../src/recorder.js");
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls++;
      const message = calls === 1
        ? { role: "assistant", content: "", tool_calls: [
            { id: "c1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node -e \"process.exit(3)\"" }) } },
            { id: "c2", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "node -e \"console.log(1)\"" }) } },
          ] }
        : { role: "assistant", content: `확인했습니다.${status("DONE", "끝")}` };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "custom", baseUrl: url, model: "mock" }, tools: { web: false } }));
  try {
    const config = loadConfig({ CKD_DATA_DIR: dataDir });
    const session = new RoleSession("B", config.model, "당신은 CKD 협업의 B", config, new Recorder(dataDir, "t2"), workspace, ["DONE", "NEEDS_FIX", "QUESTION"]);
    const reply = await session.send("검수해 주세요");
    assert.equal(reply.failedCommands?.length, 1);
    assert.match(reply.failedCommands![0], /process\.exit\(3\).*종료 코드 3/);
    assert.equal(reply.toolCalls, 2);
  } finally {
    server.close();
  }
});

test("B의 수정 요청이 3번 이어지면 C가 원인을 진단해 A와 B에게 전한다", async () => {
  const seen: Record<string, Msg[][]> = { A: [], B: [], C: [] };
  let bCount = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const messages: Msg[] = JSON.parse(body).messages;
      const sys = messages[0].content ?? "";
      const role = sys.startsWith("당신은 CKD 협업의 A") ? "A" : sys.startsWith("당신은 CKD 협업의 B") ? "B" : "C";
      seen[role].push(messages);
      const last = messages[messages.length - 1];
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      let message: Record<string, unknown>;
      if (role === "A") {
        message = { role: "assistant", content: `만들었습니다.${status("DONE", "완료")}` };
      } else if (role === "B") {
        bCount++;
        message = bCount <= 3
          ? { role: "assistant", content: `미리 보기가 안 보입니다.${status("NEEDS_FIX", "미리 보기 없음")}` }
          : { role: "assistant", content: `확인했습니다.${status("DONE", "통과")}` };
      } else if (last.role === "user" && /모두 완료를 선언했습니다|연속으로 수정 요청/.test(last.content ?? "")) {
        // C는 판정이나 진단 전에 도구로 직접 확인한다.
        message = { role: "assistant", content: "", tool_calls: [{ id: `c${messages.length}`, type: "function", function: { name: "list_dir", arguments: "{}" } }] };
      } else if (lastUser.includes("연속으로 수정 요청")) {
        message = { role: "assistant", content: '{"diagnosis": "B의 검사 도구가 누른 채 있기를 흉내 내지 못함", "instruction_for_A": "코드는 그대로 두고 근거를 정리", "note_for_B": "mouse_down으로 시험"}' };
      } else if (lastUser.includes("모두 완료를 선언했습니다")) {
        message = { role: "assistant", content: '{"verdict": "PASS", "criteria_check": [{"criterion": "x", "met": true, "evidence": "직접 확인"}], "reason": "충족", "report_for_user": "완료"}' };
      } else {
        message = { role: "assistant", content: '{"instruction_for_A": "만드세요", "done_criteria": ["x"]}' };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "custom", baseUrl: url, model: "mock" }, tools: { web: false, browser: false }, requireReview: false }));
  try {
    const job = new Job(loadConfig({ CKD_DATA_DIR: dataDir }), "미리 보기를 넣어 줘", workspace);
    const state = await job.done;
    assert.equal(state.status, "completed", state.error);
    assert.equal(state.round, 4);
    const events = fs.readFileSync(path.join(job.recorder.jobDir, "events.jsonl"), "utf8");
    assert.match(events, /"type":"fix_streak_diagnosis"/);
    assert.ok(seen.A.flat().some((m) => m.role === "user" && m.content?.includes("반복되는 수정 요청을 진단했어")));
    assert.ok(seen.B.flat().some((m) => m.role === "user" && m.content?.startsWith("C(전달자)가 반복되는 수정 요청을 진단했어")));
  } finally {
    server.close();
  }
});

test("첨부 이미지는 C·A·B의 첫 메시지에 그림으로 붙고, 기록에는 경로만 남으며, 끝나면 C가 사실을 받아 기록을 정리한다", async () => {
  const seen: Record<string, Msg[][]> = { A: [], B: [], C: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const messages: Msg[] = JSON.parse(body).messages;
      const sys = String(messages[0].content ?? "");
      const role = sys.startsWith("당신은 CKD 협업의 A") ? "A" : sys.startsWith("당신은 CKD 협업의 B") ? "B" : "C";
      seen[role].push(messages);
      const last = messages[messages.length - 1];
      const lastText = (m?: Msg) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
      const lastUser = lastText([...messages].reverse().find((m) => m.role === "user"));
      let message: Record<string, unknown>;
      if (role === "A") message = { role: "assistant", content: `만들었습니다.${status("DONE", "완료")}` };
      else if (role === "B") message = { role: "assistant", content: `확인했습니다.${status("DONE", "통과")}` };
      else if (last.role === "user" && lastText(last).includes("모두 완료를 선언했습니다")) {
        message = { role: "assistant", content: "", tool_calls: [{ id: `c${messages.length}`, type: "function", function: { name: "inspect_job", arguments: "{}" } }] };
      } else if (lastUser.includes("모두 완료를 선언했습니다")) {
        message = { role: "assistant", content: '{"verdict": "PASS", "criteria_check": [{"criterion": "x", "met": true, "evidence": "직접 확인"}], "reason": "충족", "report_for_user": "완료"}' };
      } else if (lastUser.includes("학습·평가 데이터로 쓸 수 있게 정리")) {
        message = { role: "assistant", content: '{"summary": "요약", "result_quality": "correct", "suggested_label": "good", "mistakes": [], "lessons": ["교훈"], "evidence": "사실"}' };
      } else {
        message = { role: "assistant", content: '{"instruction_for_A": "그림처럼 만드세요", "done_criteria": ["x"]}' };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  const ref = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ref-")), "snake.png");
  fs.writeFileSync(ref, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "custom", baseUrl: url, model: "mock" }, tools: { web: false, browser: false }, requireReview: false }));
  try {
    const job = new Job(loadConfig({ CKD_DATA_DIR: dataDir }), "이 그림처럼 만들어 줘", workspace, [], [ref]);
    const state = await job.done;
    assert.equal(state.status, "completed", state.error);
    const hasImage = (m: Msg) => Array.isArray(m.content) && (m.content as { type: string }[]).some((p) => p.type === "image_url");
    assert.ok(seen.C[0].some(hasImage), "C의 첫 질문에 그림");
    assert.ok(seen.A[0].some(hasImage), "A의 첫 메시지에 그림");
    assert.ok(seen.B[0].some(hasImage), "B의 첫 메시지에 그림");
    assert.ok(seen.C.flat().some((m) => m.role === "user" && String(m.content).includes("규칙으로 집계한 사실")), "C가 사실을 먼저 받음");
    // 기록에는 이미지 데이터 대신 경로만
    const sessions = fs.readdirSync(path.join(job.recorder.jobDir, "sessions")).map((f) => fs.readFileSync(path.join(job.recorder.jobDir, "sessions", f), "utf8")).join("\n");
    assert.ok(!sessions.includes("data:image"), "기록에 이미지 데이터 없음");
    assert.ok(sessions.includes("ckd-image:"), "기록에 이미지 경로");
    // 정리 결과: C의 제안만 있고 사람 판정 전에는 학습 표시가 없다
    const cur = JSON.parse(fs.readFileSync(path.join(job.recorder.jobDir, "curation.json"), "utf8"));
    assert.equal(cur.suggested_label, "good");
    assert.equal(cur.human_verdict, null);
    assert.equal(cur.training_label, null);
    assert.equal(cur.facts.status, "completed");
    const { applyFeedback } = await import("../src/curation.js");
    applyFeedback(dataDir, state.jobId, "incorrect", "그림과 다름");
    const curated = fs.readFileSync(path.join(dataDir, "finetune", "curated.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(curated.length, 1);
    assert.equal(curated[0].training_label, "bad", "사람 판정이 C의 제안보다 우선");
    assert.equal(curated[0].human_verdict.verdict, "incorrect");
  } finally {
    server.close();
  }
});

test("inspect_job은 기록에서 차단된 호출, 실패한 명령, 반복 수정을 센다", async () => {
  const { inspectJob } = await import("../src/inspect.js");
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-job-"));
  fs.mkdirSync(path.join(jobDir, "sessions"));
  fs.writeFileSync(path.join(jobDir, "state.json"), JSON.stringify({ request: "r", status: "failed", round: 7 }));
  const ev = (o: object) => JSON.stringify({ time: "t", ...o });
  fs.writeFileSync(
    path.join(jobDir, "events.jsonl"),
    [ev({ type: "tool_call", session: "A-0", tool: "edit_file" }), ev({ type: "fix_streak_diagnosis" }), ev({ type: "format_error" }), ev({ type: "judge", round: 1, verdict: "FAIL" })].join("\n") + "\n",
  );
  const call = (id: string, name: string, args: object) => ({ message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } });
  const tool = (id: string, content: string) => ({ message: { role: "tool", tool_call_id: id, content } });
  const lines = [
    call("1", "write_file", { content: "x" }), tool("1", "도구 실행 안 함: write_file의 필수 인자 path가 없습니다."),
    call("2", "run_command", { command: "pytest" }), tool("2", "종료 코드 1\n'pytest' 없음"),
    call("3", "edit_file", { path: "a", old_text: "x", new_text: "y" }), tool("3", "수정함: a"),
    call("4", "edit_file", { path: "a", old_text: "x", new_text: "y" }), tool("4", "수정 실패: old_text가 0번 나옵니다."),
    call("5", "dir", {}), tool("5", "알 수 없거나 B에게 허용되지 않은 도구입니다: dir"),
  ];
  fs.writeFileSync(path.join(jobDir, "sessions", "A-0.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const f = inspectJob(jobDir);
  assert.equal(f.status, "failed");
  assert.equal(f.rounds, 7);
  assert.deepEqual(f.judges, [{ round: 1, verdict: "FAIL" }]);
  assert.equal(f.issues.bad_args, 2, "필수 인자 누락 + old_text 없음");
  assert.equal(f.issues.wrong_tool, 1);
  assert.equal(f.issues.lost_context, 1);
  assert.equal(f.issues.format_error, 1);
  assert.equal(f.repeated_edits, 1);
  assert.equal(f.failed_commands.length, 1);
  assert.match(f.failed_commands[0], /pytest/);
});

test("사람 판정을 받으면 C가 정리를 다시 쓰고, 판정과 학습 표시는 C가 바꾸지 못한다", async () => {
  const { refineCuration } = await import("../src/orchestrator.js");
  const { applyFeedback } = await import("../src/curation.js");
  let asked = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const messages: Msg[] = JSON.parse(body).messages;
      asked = String(messages[messages.length - 1].content);
      // C가 판정과 표시까지 바꾸려고 해도 무시되어야 한다.
      const content = '{"summary": "다시 쓴 요약", "result_quality": "wrong", "mistakes": [{"role": "B", "what": "틀린 판정", "better": "직접 확인"}], "lessons": ["구체적 교훈"], "evidence": "기록", "corrections": ["없던 FAIL을 지움"], "human_verdict": "correct", "training_label": "good"}';
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "custom", baseUrl: url, model: "mock" }, tools: { web: false, browser: false } }));
  const id = "job1";
  const jobDir = path.join(dataDir, "jobs", id);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "state.json"), JSON.stringify({ request: "r", status: "completed", round: 1, workspace: dataDir }));
  fs.writeFileSync(path.join(jobDir, "events.jsonl"), JSON.stringify({ type: "judge", round: 1, verdict: "PASS" }) + "\n");
  fs.writeFileSync(path.join(jobDir, "curation.json"), JSON.stringify({ job_id: id, summary: "처음 요약", suggested_label: "good", human_verdict: null, training_label: null }));
  try {
    applyFeedback(dataDir, id, "incorrect", "사용자: 화면이 안 나와요");
    const updated = await refineCuration(loadConfig({ CKD_DATA_DIR: dataDir }), id);
    assert.match(asked, /incorrect/);
    assert.match(asked, /화면이 안 나와요/);
    assert.match(asked, /처음 요약/);
    assert.equal(updated.summary, "다시 쓴 요약");
    assert.deepEqual((updated.draft as { summary: string }).summary, "처음 요약");
    assert.equal((updated.human_verdict as { verdict: string }).verdict, "incorrect", "C가 판정을 바꾸지 못함");
    assert.equal(updated.training_label, "bad", "C가 학습 표시를 바꾸지 못함");
    assert.equal(updated.revision, 1);
    const curated = fs.readFileSync(path.join(dataDir, "finetune", "curated.jsonl"), "utf8").trim().split("\n");
    assert.equal(curated.length, 1);
    assert.equal(JSON.parse(curated[0]).summary, "다시 쓴 요약");
  } finally {
    server.close();
  }
});

// B가 계속 수정을 요청하는 mock 서버. C는 판정·진단·한도 보고에 맞는 JSON을 준다.
async function startNeverDoneServer(): Promise<{ url: string; close: () => void; seen: Record<string, Msg[][]> }> {
  const seen: Record<string, Msg[][]> = { A: [], B: [], C: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const messages: Msg[] = JSON.parse(body).messages;
      const sys = String(messages[0].content ?? "");
      const role = sys.startsWith("당신은 CKD 협업의 A") ? "A" : sys.startsWith("당신은 CKD 협업의 B") ? "B" : "C";
      seen[role].push(messages);
      const last = messages[messages.length - 1];
      const lastUser = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
      let message: Record<string, unknown>;
      if (role === "A") message = { role: "assistant", content: `고쳤습니다.${status("DONE", "완료")}` };
      else if (role === "B") message = { role: "assistant", content: `아직 틀립니다.${status("NEEDS_FIX", "틀림")}` };
      else if (last.role === "user" && /연속으로 수정 요청/.test(String(last.content))) {
        message = { role: "assistant", content: "", tool_calls: [{ id: `c${messages.length}`, type: "function", function: { name: "list_dir", arguments: "{}" } }] };
      } else if (lastUser.includes("연속으로 수정 요청")) {
        message = { role: "assistant", content: '{"diagnosis": "진단", "instruction_for_A": "다시", "note_for_B": "그대로"}' };
      } else if (lastUser.includes("한도에 도달해 작업을 멈춥니다")) {
        message = { role: "assistant", content: '{"done": ["파일 생성"], "not_done": ["조건 x"], "last_b_issue": "아직 틀립니다", "next_steps": ["x 고치기"], "report_for_user": "2회 안에 끝내지 못했습니다. 남은 문제: 조건 x"}' };
      } else if (lastUser.includes("학습·평가 데이터로 쓸 수 있게 정리")) {
        message = { role: "assistant", content: '{"summary": "요약", "result_quality": "wrong", "suggested_label": "bad"}' };
      } else {
        message = { role: "assistant", content: '{"instruction_for_A": "만드세요", "done_criteria": ["x"]}' };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => server.close(), seen };
}

test("회차 한도를 주면 그 회차에서 멈추고(limit_reached), C가 된 것과 안 된 것을 보고한다", async () => {
  const mock = await startNeverDoneServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "custom", baseUrl: mock.url, model: "mock" }, tools: { web: false, browser: false } }));
  try {
    const job = new Job(loadConfig({ CKD_DATA_DIR: dataDir }), "x를 만들어 줘", workspace, [], [], 2);
    const state = await job.done;
    assert.equal(state.status, "limit_reached");
    assert.equal(state.round, 2);
    assert.equal(state.maxRounds, 2);
    assert.match(state.report ?? "", /2회 안에 끝내지 못했습니다/);
    assert.equal(mock.seen.A.length, 2, "A는 2회차까지만 일함");
    const events = fs.readFileSync(path.join(job.recorder.jobDir, "events.jsonl"), "utf8");
    assert.match(events, /"type":"limit_reached"/);
    assert.match(events, /"max_rounds":2/);
    assert.match(fs.readFileSync(path.join(dataDir, "finetune", "jobs.jsonl"), "utf8"), /"outcome":"limit_reached","rounds":2,"max_rounds":2/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(job.recorder.jobDir, "curation.json"), "utf8")).max_rounds, 2);
  } finally {
    mock.close();
  }
});

test("회차 한도를 주지 않으면 제한 없이 반복한다 (설정 기본값 0)", async () => {
  const mock = await startNeverDoneServer();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "custom", baseUrl: mock.url, model: "mock" }, tools: { web: false, browser: false } }));
  try {
    const config = loadConfig({ CKD_DATA_DIR: dataDir });
    assert.equal(config.maxRounds, 0);
    const job = new Job(config, "x를 만들어 줘", workspace);
    assert.equal(job.state.maxRounds, 0);
    // 기본 한도(예전의 6)를 넘어 8회차까지 가는지 본 뒤 멈춘다.
    while (job.state.round < 8 && job.state.status === "running") await new Promise((r) => setTimeout(r, 20));
    assert.equal(job.state.status, "running");
    job.stop();
    const state = await job.done;
    assert.equal(state.status, "stopped");
    assert.ok(state.round >= 8);
  } finally {
    mock.close();
  }
});

test("/ckd 스킬은 사용자가 말한 횟수만 max_rounds로 넘기고, 없으면 제한 없이 넘긴다", () => {
  const skill = fs.readFileSync(new URL("../../skills/ckd/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /max_rounds/);
  assert.match(skill, /10회로/);
  assert.match(skill, /횟수를 말하지 않았으면 `max_rounds`를 넘기지 않습니다/);
  assert.match(skill, /limit_reached/);
});

// A·B는 늘 완료, C는 직접 확인 뒤 PASS하는 mock. 한도 보고와 정리에도 답한다.
async function startPassServer(): Promise<{ url: string; close: () => void; seen: Record<string, Msg[][]> }> {
  const seen: Record<string, Msg[][]> = { A: [], B: [], C: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const messages: Msg[] = JSON.parse(body).messages;
      const sys = String(messages[0].content ?? "");
      const role = sys.startsWith("당신은 CKD 협업의 A") ? "A" : sys.startsWith("당신은 CKD 협업의 B") ? "B" : "C";
      seen[role].push(messages);
      const last = messages[messages.length - 1];
      const lastUser = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
      let message: Record<string, unknown>;
      if (role === "A") message = { role: "assistant", content: `만들었습니다.${status("DONE", "완료")}` };
      else if (role === "B") message = { role: "assistant", content: `확인했습니다.${status("DONE", "통과")}` };
      else if (last.role === "user" && String(last.content).includes("모두 완료를 선언했습니다")) {
        message = { role: "assistant", content: "", tool_calls: [{ id: `c${messages.length}`, type: "function", function: { name: "list_dir", arguments: "{}" } }] };
      } else if (lastUser.includes("모두 완료를 선언했습니다")) {
        message = { role: "assistant", content: '{"verdict": "PASS", "criteria_check": [{"criterion": "x", "met": true, "evidence": "직접 확인"}], "reason": "충족", "report_for_user": "다 했습니다"}' };
      } else if (lastUser.includes("한도에 도달해 작업을 멈춥니다")) {
        message = { role: "assistant", content: '{"report_for_user": "한도 안에 끝내지 못했습니다"}' };
      } else if (lastUser.includes("학습·평가 데이터로 쓸 수 있게 정리")) {
        message = { role: "assistant", content: '{"summary": "요약", "suggested_label": "needs_review"}' };
      } else {
        message = { role: "assistant", content: '{"instruction_for_A": "만드세요", "done_criteria": ["x"]}' };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => server.close(), seen };
}

function reviewConfig(url: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ckd-data-"));
  fs.writeFileSync(path.join(dataDir, "ckd.config.json"), JSON.stringify({ model: { backend: "custom", baseUrl: url, model: "mock" }, tools: { web: false, browser: false } }));
  return { config: loadConfig({ CKD_DATA_DIR: dataDir }), dataDir, workspace: fs.mkdtempSync(path.join(os.tmpdir(), "ckd-ws-")) };
}

test("A·B·C가 완료해도 연결된 AI가 accept해야 completed로 끝난다", async () => {
  const mock = await startPassServer();
  const { config, workspace } = reviewConfig(mock.url);
  try {
    assert.equal(config.requireReview, true);
    const job = new Job(config, "x를 만들어 줘", workspace);
    const paused = await job.paused();
    assert.equal(paused.status, "awaiting_review");
    assert.equal(paused.report, "다 했습니다");
    assert.equal(job.review("accept", "직접 열어 봄"), undefined);
    const state = await job.done;
    assert.equal(state.status, "completed");
    assert.equal(state.round, 1);
    assert.deepEqual(state.reviews.map((r) => r.decision), ["accept"]);
    // 끝난 작업에는 다시 하기를 받지 않는다
    assert.match(job.review("rework", "더 고쳐") ?? "", /확인을 기다리는 상태가 아닙니다/);
    const cur = JSON.parse(fs.readFileSync(path.join(job.recorder.jobDir, "curation.json"), "utf8"));
    assert.equal(cur.reviewer_decisions[0].decision, "accept");
    assert.equal(cur.training_label, null, "연결된 AI 판정은 학습 표시가 아님");
  } finally {
    mock.close();
  }
});

test("연결된 AI가 rework하면 지적이 A에게 가고 같은 작업이 다음 회차로 이어진다", async () => {
  const mock = await startPassServer();
  const { config, workspace } = reviewConfig(mock.url);
  try {
    const job = new Job(config, "x를 만들어 줘", workspace);
    await job.paused();
    assert.equal(job.review("rework", ""), "rework에는 무엇이 아직 안 됐는지 note가 필요합니다.");
    assert.equal(job.review("rework", "머리와 몸 색이 거의 같음"), undefined);
    while (job.state.status !== "awaiting_review") await new Promise((r) => setTimeout(r, 10));
    assert.equal(job.state.round, 2);
    assert.ok(mock.seen.A.flat().some((m) => m.role === "user" && String(m.content).includes("연결된 AI의 지적") && String(m.content).includes("머리와 몸 색이 거의 같음")));
    assert.ok(mock.seen.B.flat().some((m) => m.role === "user" && String(m.content).includes("머리와 몸 색이 거의 같음")));
    assert.ok(job.state.doneCriteria.some((c) => c.includes("머리와 몸 색이 거의 같음")), "지적이 완료 조건에 더해짐");
    assert.equal(mock.seen.A.length >= 2, true);
    job.review("accept");
    const state = await job.done;
    assert.equal(state.status, "completed");
    assert.deepEqual(state.reviews.map((r) => [r.decision, r.round]), [["rework", 1], ["accept", 2]]);
  } finally {
    mock.close();
  }
});

test("rework로 이어 가다 회차 한도에 닿으면 limit_reached로 멈춘다", async () => {
  const mock = await startPassServer();
  const { config, workspace } = reviewConfig(mock.url);
  try {
    const job = new Job(config, "x를 만들어 줘", workspace, [], [], 1);
    await job.paused();
    job.review("rework", "아직 아님");
    const state = await job.done;
    assert.equal(state.status, "limit_reached");
    assert.equal(state.round, 1);
    assert.match(state.report ?? "", /한도 안에 끝내지 못했습니다/);
  } finally {
    mock.close();
  }
});
