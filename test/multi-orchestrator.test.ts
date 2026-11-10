// Herdr CKD 다중 스레드 오케스트레이터(C 중심 1개 + [A_n·B_n] 다중 세트), Git Worktree/GitHub 동기화,
// 작동 로그 순차 정리(Retention), 대시보드 UI 서버 통합 테스트
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, type CkdConfig } from "../src/config.js";
import { MultiJob } from "../src/multi-orchestrator.js";
import {
  applyUnitToMain,
  cleanupUnitWorkspace,
  createUnitWorkspace,
  pruneOldRemoteBranches,
  syncUnitToGithub,
} from "../src/git-worktree.js";
import { enforceLogRetention } from "../src/retention.js";
import { applyFeedback, rebuildCurated } from "../src/curation.js";
import { formatOsc7501, liveBus, publishThreadEvent, type ThreadLiveEvent } from "../src/herdr-bridge.js";
import { startUiServer } from "../src/ui-server.js";

type Msg = { role: string; content: string | null; tool_calls?: unknown[] };

function statusBlock(s: string, summary = ""): string {
  return `\n<CKD_STATUS>{"status": "${s}", "summary": "${summary}"}</CKD_STATUS>`;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ckd-git-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@local"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "initial commit"]);
  return dir;
}

function detectActor(sysPrompt: string): "C" | "A1" | "A2" | "B1" | "B2" {
  if (sysPrompt.startsWith("당신은 Herdr CKD의 중심 코어 C")) return "C";
  if (sysPrompt.startsWith("당신은 Herdr CKD 다중 스레드의 A1")) return "A1";
  if (sysPrompt.startsWith("당신은 Herdr CKD 다중 스레드의 A2")) return "A2";
  if (sysPrompt.startsWith("당신은 Herdr CKD 다중 스레드의 B1")) return "B1";
  if (sysPrompt.startsWith("당신은 Herdr CKD 다중 스레드의 B2")) return "B2";
  return "C";
}

function makeTestConfig(baseUrl: string, overrides: Record<string, unknown> = {}): { dataDir: string; config: CkdConfig } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ckd-data-"));
  fs.writeFileSync(
    path.join(dataDir, "ckd.config.json"),
    JSON.stringify({
      model: { backend: "custom", baseUrl, model: "mock-qwen" },
      requireReview: false,
      tools: { web: false, browser: false },
      herdr: { enabled: true, emitOsc7501: false, autoSpawnPanes: false },
      ...overrides,
    }),
    "utf8",
  );
  return { dataDir, config: loadConfig({ CKD_DATA_DIR: dataDir }) };
}

test("1. split(분업 모드) + Git Worktree 격리·검수·병합 및 자동 정리", async () => {
  const seen: Record<string, Msg[][]> = { C: [], A1: [], A2: [], B1: [], B2: [] };
  let a1Round = 0;
  let b1Round = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const messages: Msg[] = JSON.parse(body).messages;
      const sys = String(messages[0]?.content ?? "");
      const actor = detectActor(sys);
      seen[actor].push(messages);

      const last = messages[messages.length - 1];
      const lastUser = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
      let message: Record<string, unknown>;

      if (actor === "C") {
        if (last.role === "user" && lastUser.includes("최종 통합 판정을 내리세요")) {
          // split 모드에서는 C가 통합 판정 전에 도구(list_dir 등)로 직접 확인해야 함 (verify = true)
          message = {
            role: "assistant",
            content: "",
            tool_calls: [{ id: `c_verify_${messages.length}`, type: "function", function: { name: "list_dir", arguments: "{}" } }],
          };
        } else if (lastUser.includes("최종 통합 판정을 내리세요")) {
          message = {
            role: "assistant",
            content: JSON.stringify({
              verdict: "PASS",
              winner_unit_id: "",
              criteria_check: [{ criterion: "a, b 생성", met: true, evidence: "확인" }],
              reason: "모두 통과",
              rework_units: [],
              report_for_user: "분업 완료",
            }),
          };
        } else {
          message = {
            role: "assistant",
            content: JSON.stringify({
              mode: "split",
              overall_done_criteria: ["a, b 생성"],
              definitions: [],
              units: [
                {
                  title: "유닛 1 - a.txt 작성",
                  target_files: ["a.txt"],
                  instruction: "a.txt를 작성하세요",
                  done_criteria: ["a.txt 생성"],
                },
                {
                  title: "유닛 2 - b.txt 작성",
                  target_files: ["b.txt"],
                  instruction: "b.txt를 작성하세요",
                  done_criteria: ["b.txt 생성"],
                },
              ],
            }),
          };
        }
      } else if (actor === "A1") {
        if (last.role === "user") {
          a1Round++;
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: `a1_write_${a1Round}`,
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "a.txt", content: `hello A v${a1Round}` }),
                },
              },
            ],
          };
        } else {
          message = {
            role: "assistant",
            content: `a.txt를 hello A v${a1Round}로 작성했습니다.${statusBlock("DONE", "a.txt 작성")}`,
          };
        }
      } else if (actor === "B1") {
        b1Round++;
        message =
          b1Round === 1
            ? { role: "assistant", content: `버전을 v2로 올려 주세요.${statusBlock("NEEDS_FIX", "v2 필요")}` }
            : { role: "assistant", content: `확인했습니다.${statusBlock("DONE", "B1 통과")}` };
      } else if (actor === "A2") {
        if (last.role === "user") {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "a2_write_1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "b.txt", content: "hello B" }),
                },
              },
            ],
          };
        } else {
          message = {
            role: "assistant",
            content: `b.txt를 작성했습니다.${statusBlock("DONE", "b.txt 작성")}`,
          };
        }
      } else {
        // B2
        message = { role: "assistant", content: `b.txt 이상 없습니다.${statusBlock("DONE", "B2 통과")}` };
      }

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 50 } }));
    });
  });

  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const workspace = initTempGitRepo();
  const { config } = makeTestConfig(url);

  try {
    const job = new MultiJob(config, {
      request: "a.txt와 b.txt를 각각 만들어 줘",
      workspace,
      mode: "split",
      maxUnits: 2,
    });
    const state = await job.done;

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.mode, "split");
    assert.equal(state.units.length, 2);
    assert.equal(state.report, "분업 완료");

    // 두 유닛의 작업물이 모두 메인 Git 작업 공간에 병합되었는지 확인
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "hello A v2");
    assert.equal(fs.readFileSync(path.join(workspace, "b.txt"), "utf8"), "hello B");

    // B1이 A를 통해 전달받은 메시지에 Git 변경 내역과 a.txt가 포함되었는지 확인
    const b1FirstMsg = String(seen.B1[0]?.at(-1)?.content ?? "");
    assert.match(b1FirstMsg, /\[시스템이 자동 추출한 Git 변경 내역\]/);
    assert.match(b1FirstMsg, /a\.txt/);

    // 로컬 Worktree 및 임시 ckd/* 브랜치 자동 정리 확인
    assert.equal(state.cleanupSummary?.worktreesCleaned, 2);
    assert.ok(!fs.existsSync(path.join(job.recorder.jobDir, "worktrees")), "임시 worktrees 폴더 삭제됨");
    const remainingBranches = git(workspace, ["branch", "--list", "ckd/*"]);
    assert.equal(remainingBranches, "", "임시 ckd/* 로컬 브랜치가 모두 정리됨");
  } finally {
    server.close();
  }
});

test("2. compete(경쟁 모드) + 우승 유닛 채택 및 파인튜닝 선호도 태그 기록", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const messages: Msg[] = JSON.parse(body).messages;
      const sys = String(messages[0]?.content ?? "");
      const actor = detectActor(sys);
      const last = messages[messages.length - 1];
      const lastUser = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
      let message: Record<string, unknown>;

      if (actor === "C") {
        if (lastUser.includes("최종 통합 판정을 내리세요")) {
          message = {
            role: "assistant",
            content: JSON.stringify({
              verdict: "PASS",
              winner_unit_id: "unit-2",
              criteria_check: [{ criterion: "answer.txt 작성", met: true, evidence: "비교 완료" }],
              reason: "unit-2 풀이가 더 정확함",
              rework_units: [],
              report_for_user: "경쟁 모드 완료",
            }),
          };
        } else {
          message = {
            role: "assistant",
            content: JSON.stringify({
              mode: "compete",
              overall_done_criteria: ["answer.txt 작성"],
              definitions: [],
              units: [
                {
                  title: "해법 1",
                  target_files: ["answer.txt"],
                  instruction: "solution 1을 작성하세요",
                  done_criteria: ["answer.txt 존재"],
                },
                {
                  title: "해법 2",
                  target_files: ["answer.txt"],
                  instruction: "solution 2를 작성하세요",
                  done_criteria: ["answer.txt 존재"],
                },
              ],
            }),
          };
        }
      } else if (actor === "A1") {
        if (last.role === "user") {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "a1_comp",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "answer.txt", content: "solution 1" }) },
              },
            ],
          };
        } else {
          message = { role: "assistant", content: `solution 1 작성 완료.${statusBlock("DONE", "해법 1 완료")}` };
        }
      } else if (actor === "A2") {
        if (last.role === "user") {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "a2_comp",
                type: "function",
                function: { name: "write_file", arguments: JSON.stringify({ path: "answer.txt", content: "solution 2" }) },
              },
            ],
          };
        } else {
          message = { role: "assistant", content: `solution 2 작성 완료.${statusBlock("DONE", "해법 2 완료")}` };
        }
      } else {
        // B1, B2
        message = { role: "assistant", content: `검수 통과.${statusBlock("DONE", "통과")}` };
      }

      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 50 } }));
    });
  });

  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const workspace = initTempGitRepo();
  const { dataDir, config } = makeTestConfig(url);

  try {
    const job = new MultiJob(config, {
      request: "answer.txt에 최적 해법을 작성해 줘",
      workspace,
      mode: "compete",
      maxUnits: 2,
    });
    const state = await job.done;

    assert.equal(state.status, "completed", state.error);
    assert.equal(state.mode, "compete");
    assert.equal(state.winnerUnitId, "unit-2");
    assert.equal(fs.readFileSync(path.join(workspace, "answer.txt"), "utf8"), "solution 2");

    // 파인튜닝 데이터에 우승 유닛(preferred)과 비우승 유닛(non_preferred) 태그가 기록되었는지 확인
    const aLines = fs
      .readFileSync(path.join(dataDir, "finetune", "A.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const unit1Rec = aLines.find((r) => r.meta?.unit_id === "unit-1");
    const unit2Rec = aLines.find((r) => r.meta?.unit_id === "unit-2");
    assert.ok(unit1Rec, "unit-1 파인튜닝 기록 존재");
    assert.ok(unit2Rec, "unit-2 파인튜닝 기록 존재");
    assert.equal(unit2Rec.meta.preference_tag, "preferred");
    assert.equal(unit1Rec.meta.preference_tag, "non_preferred");
  } finally {
    server.close();
  }
});

test("3. 비-Git 일반 폴더(copy 폴백 모드)에서 다중 유닛 병합 시 타 유닛 변경분 덮어쓰기 방지", () => {
  const mainWs = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ckd-plain-"));
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ckd-job-"));
  const { config } = makeTestConfig("http://127.0.0.1:9/v1");

  fs.writeFileSync(path.join(mainWs, "shared.txt"), "base", "utf8");
  fs.writeFileSync(path.join(mainWs, "u1.txt"), "old1", "utf8");
  fs.writeFileSync(path.join(mainWs, "u2.txt"), "old2", "utf8");

  const u1 = createUnitWorkspace(mainWs, jobDir, "job-copy-test", "unit-1", config);
  const u2 = createUnitWorkspace(mainWs, jobDir, "job-copy-test", "unit-2", config);
  assert.equal(u1.mode, "copy");
  assert.equal(u2.mode, "copy");

  // unit-1은 u1.txt만 수정, unit-2는 u2.txt만 수정
  fs.writeFileSync(path.join(u1.unitPath, "u1.txt"), "new1", "utf8");
  fs.writeFileSync(path.join(u2.unitPath, "u2.txt"), "new2", "utf8");

  const m1 = applyUnitToMain(u1, "u1");
  const m2 = applyUnitToMain(u2, "u2");
  assert.equal(m1.ok, true);
  assert.equal(m2.ok, true);

  // unit-2를 나중에 병합해도 unit-1이 수정한 u1.txt("new1")가 unit-2의 구버전("old1")으로 덮어써지지 않아야 함
  assert.equal(fs.readFileSync(path.join(mainWs, "u1.txt"), "utf8"), "new1");
  assert.equal(fs.readFileSync(path.join(mainWs, "u2.txt"), "utf8"), "new2");
  assert.equal(fs.readFileSync(path.join(mainWs, "shared.txt"), "utf8"), "base");
});

test("4. GitHub 원격 브랜치 동기화, 완료 즉시 삭제(deleteBranchOnComplete), 상한 초과 순차 삭제(pruneOldRemoteBranches FIFO)", () => {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ckd-bare-"));
  git(bareDir, ["init", "--bare"]);

  const mainWs = initTempGitRepo();
  git(mainWs, ["remote", "add", "origin", bareDir]);

  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-ckd-ghjob-"));
  const { config } = makeTestConfig("http://127.0.0.1:9/v1", {
    github: {
      mode: "push_on_complete",
      remote: "origin",
      branchPrefix: "ckd",
      deleteBranchOnComplete: true,
      maxRemoteBranches: 5,
    },
  });

  // (1) syncUnitToGithub로 원격 Push 후 cleanupUnitWorkspace 시 원격 브랜치 즉시 삭제 검증
  const ws = createUnitWorkspace(mainWs, jobDir, "job-gh-1", "unit-1", config);
  assert.equal(ws.mode, "worktree");
  assert.ok(ws.branchName);

  fs.writeFileSync(path.join(ws.unitPath, "feature.txt"), "pushed content", "utf8");
  const syncRes = syncUnitToGithub(ws, config, "unit-1 complete");
  assert.equal(syncRes.pushed, true, syncRes.warning);

  const branchesAfterPush = git(bareDir, ["branch", "--list", ws.branchName!]);
  assert.match(branchesAfterPush, new RegExp(ws.branchName!.replace(/\//g, "\\/")));

  cleanupUnitWorkspace(ws, config);
  const branchesAfterCleanup = git(bareDir, ["branch", "--list", ws.branchName!]);
  assert.equal(branchesAfterCleanup, "", "deleteBranchOnComplete=true일 때 원격 브랜치가 즉시 삭제되어야 함");

  // (2) 4개의 원격 브랜치를 시간차 커밋으로 생성한 뒤 maxRemoteBranches: 2로 순차 삭제(FIFO) 검증
  const branchNames = [
    "ckd/old-1/unit-1",
    "ckd/old-2/unit-1",
    "ckd/old-3/unit-1",
    "ckd/old-4/unit-1",
  ];
  for (let i = 0; i < branchNames.length; i++) {
    const b = branchNames[i];
    const dateIso = `2026-01-0${i + 1}T00:00:00Z`;
    git(mainWs, ["checkout", "-B", b]);
    fs.writeFileSync(path.join(mainWs, `file-${i}.txt`), `v${i}`, "utf8");
    git(mainWs, ["add", `file-${i}.txt`]);
    git(mainWs, ["commit", "-m", `commit ${i}`], {
      GIT_AUTHOR_DATE: dateIso,
      GIT_COMMITTER_DATE: dateIso,
    });
    git(mainWs, ["push", "-u", "origin", b]);
  }
  git(mainWs, ["checkout", "-"]);

  const pruneConfig: CkdConfig = {
    ...config,
    github: { ...config.github, maxRemoteBranches: 2 },
  };
  const deleted = pruneOldRemoteBranches(mainWs, pruneConfig);
  assert.deepEqual(deleted, ["ckd/old-1/unit-1", "ckd/old-2/unit-1"]);

  const remainingRemote = git(bareDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/ckd/"]).split("\n").filter(Boolean).sort();
  assert.deepEqual(remainingRemote, ["ckd/old-3/unit-1", "ckd/old-4/unit-1"]);
});

test("5. 작동 로그 순차 삭제(enforceLogRetention) 및 finetune/curated.jsonl 보존 검증", () => {
  const { dataDir, config } = makeTestConfig("http://127.0.0.1:9/v1", {
    retention: {
      deleteTempOnComplete: true,
      maxJobsToKeep: 3,
      maxLogSizeMB: 500,
    },
  });

  const jobsRoot = path.join(dataDir, "jobs");
  fs.mkdirSync(jobsRoot, { recursive: true });

  const baseTimeSec = Math.floor(Date.now() / 1000) - 10000;

  function createFakeJob(id: string, status: string, offsetSec: number): string {
    const dir = path.join(jobsRoot, id);
    fs.mkdirSync(path.join(dir, "original"), { recursive: true });
    fs.mkdirSync(path.join(dir, "worktrees"), { recursive: true });
    fs.writeFileSync(path.join(dir, "original", "dummy.bin"), "orig-data", "utf8");
    fs.writeFileSync(path.join(dir, "worktrees", "dummy.bin"), "wt-data", "utf8");
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ jobId: id, status }), "utf8");
    fs.writeFileSync(
      path.join(dir, "curation.json"),
      JSON.stringify({
        job_id: id,
        summary: `요약 ${id}`,
        suggested_label: "good",
        human_verdict: null,
        training_label: null,
      }),
      "utf8",
    );
    const t = baseTimeSec + offsetSec;
    fs.utimesSync(dir, t, t);
    return dir;
  }

  const job1Dir = createFakeJob("job-1", "completed", 10);
  createFakeJob("job-2", "completed", 20);
  createFakeJob("job-3", "completed", 30);
  const job4Dir = createFakeJob("job-4", "completed", 40);
  const job5Dir = createFakeJob("job-5", "completed", 50);
  const activeDir = createFakeJob("job-active", "running", 5);

  // 가장 오래된 job-1에 사람 판정(correct -> training_label: "good") 부여 및 curated.jsonl 빌드
  applyFeedback(dataDir, "job-1", "correct", "아주 좋음");
  // Windows에서 파일 수정 시 폴더 mtime이 갱신되므로 job-1의 mtime을 다시 가장 오래된 시각으로 고정
  fs.utimesSync(job1Dir, baseTimeSec + 10, baseTimeSec + 10);
  rebuildCurated(dataDir);

  // maxJobsToKeep: 3으로 순차 정리 실행 (진행 중인 job-active 포함 총 3개만 남아야 함)
  const report = enforceLogRetention(config, new Set(["job-active"]));

  // 완료된 작업(job-4, job-5)의 무거운 임시 폴더(original, worktrees) 삭제 확인
  assert.ok(!fs.existsSync(path.join(job4Dir, "original")));
  assert.ok(!fs.existsSync(path.join(job4Dir, "worktrees")));
  assert.ok(!fs.existsSync(path.join(job5Dir, "original")));
  assert.ok(!fs.existsSync(path.join(job5Dir, "worktrees")));

  // 활성 작업(job-active)은 임시 폴더와 작업 폴더 모두 건드리지 않음
  assert.ok(fs.existsSync(path.join(activeDir, "original", "dummy.bin")));

  // 가장 오래된 완료 작업 job-1, job-2, job-3이 순차 삭제되고 job-4, job-5, job-active 3개만 남음
  assert.deepEqual(report.deletedJobs, ["job-1", "job-2", "job-3"]);
  assert.equal(report.remainingJobs, 3);
  const remainingDirs = fs.readdirSync(jobsRoot).sort();
  assert.deepEqual(remainingDirs, ["job-4", "job-5", "job-active"]);

  // job-1 폴더가 삭제된 뒤 rebuildCurated를 다시 호출해도 finetune/curated.jsonl에 job-1의 학습 데이터("good")가 보존되어야 함
  rebuildCurated(dataDir);
  const curatedLines = fs
    .readFileSync(path.join(dataDir, "finetune", "curated.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const job1Curated = curatedLines.find((r) => r.job_id === "job-1");
  assert.ok(job1Curated, "삭제된 job-1의 정제 데이터가 curated.jsonl에 보존되어야 함");
  assert.equal(job1Curated.training_label, "good");
  assert.equal(job1Curated.human_verdict?.note, "아주 좋음");
});

test("6. Herdr OSC 7501 신호 및 스레드 분리 대시보드 UI 서버(startUiServer) API 검증", async () => {
  const { config } = makeTestConfig("http://127.0.0.1:9/v1", { uiPort: 0 });

  // (1) publishThreadEvent 호출 시 liveBus 이벤트 수신 검증
  const received: ThreadLiveEvent[] = [];
  const onEvent = (ev: ThreadLiveEvent) => received.push(ev);
  liveBus.on("thread_event", onEvent);
  try {
    publishThreadEvent(config, {
      jobId: "job-live-1",
      unitId: "unit-1",
      actor: "C1",
      state: "working",
      phase: "C1 구현 중",
      round: 1,
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].jobId, "job-live-1");
    assert.equal(received[0].actor, "C1");
    assert.equal(received[0].state, "working");
    assert.ok(received[0].timestamp);
    const osc = formatOsc7501("working", "herdr-ckd:unit-1/A1", "A1 구현 중");
    const expectedB64 = Buffer.from("A1 구현 중", "utf8").toString("base64");
    assert.equal(osc, `\x1b]7501;state=working:app=herdr-ckd:id=unit-1/A1:msg=${expectedB64}\x07`);
  } finally {
    liveBus.off("thread_event", onEvent);
  }

  // (2) startUiServer 기동 및 HTTP 엔드포인트 검증
  const { server, port } = await startUiServer({ ...config, uiPort: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Herdr CKD/);

    const ovRes = await fetch(`${base}/api/overview`);
    assert.equal(ovRes.status, 200);
    const ov = (await ovRes.json()) as Record<string, any>;
    assert.ok(ov.config);
    assert.ok(ov.storage);
    assert.ok(Array.isArray(ov.jobs));

    const setRes = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leaderModel: "gpt-4.1",
        leaderUrl: "http://192.168.0.10:1234/v1",
        workerModel: "llama3.3",
        workerUrl: "http://192.168.0.10:1234/v1",
        githubMode: "push_on_complete",
        maxRemoteBranches: 7,
        deleteBranchOnComplete: true,
        maxJobsToKeep: 25,
        maxLogSizeMB: 300,
        deleteTempOnComplete: true,
      }),
    });
    assert.equal(setRes.status, 200);
    const setJson = (await setRes.json()) as { ok: boolean };
    assert.equal(setJson.ok, true);

    const ovAfter = (await (await fetch(`${base}/api/overview`)).json()) as Record<string, any>;
    assert.equal(ovAfter.config.github.mode, "push_on_complete");
    assert.equal(ovAfter.config.github.maxRemoteBranches, 7);
    assert.equal(ovAfter.config.retention.maxJobsToKeep, 25);

    const cleanRes = await fetch(`${base}/api/cleanup`, { method: "POST" });
    assert.equal(cleanRes.status, 200);
    const cleanJson = (await cleanRes.json()) as Record<string, any>;
    assert.ok(cleanJson.report);
    assert.ok(cleanJson.storage);

    // (3) 내장 Streamable HTTP MCP 엔드포인트 (/mcp) 및 ckd_configure 도구 검증
    const mcpCallRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ckd_configure",
          arguments: {
            uiHost: "127.0.0.1",
            uiPort: 38501,
            maxUnits: 4,
          },
        },
      }),
    });
    assert.equal(mcpCallRes.status, 200);
    const mcpRaw = await mcpCallRes.text();
    assert.match(mcpRaw, /38501/);
    assert.match(mcpRaw, /최대 4유닛/);

    const ovAfterMcp = (await (await fetch(`${base}/api/overview`)).json()) as Record<string, any>;
    assert.equal(ovAfterMcp.config.uiPort, 38501);
    assert.equal(ovAfterMcp.config.threads.maxUnits, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
