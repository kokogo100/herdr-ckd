// 스레드 유닛([B_n + C_n])별 Git Worktree 격리, 병합, 그리고 GitHub 동기화 및 자동 삭제 모듈
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CkdConfig } from "./config.js";

export interface UnitWorkspace {
  unitId: string;
  mode: "worktree" | "copy";
  mainWorkspace: string;
  unitPath: string;
  branchName?: string;
  baseCommit?: string;
  baseFiles?: Map<string, Buffer>;
  remotePushed?: boolean;
  prUrl?: string;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "dist", "__pycache__", ".pytest_cache"]);
const GIT_IDENTITY = ["-c", "user.name=Herdr CKD", "-c", "user.email=ckd@local"];

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    // 주의: .trim()은 첫 줄 앞 공백(예: git status --porcelain의 " M file")까지 지우므로 줄바꿈만 제거한다.
    return { ok: true, stdout: stdout.replace(/[\r\n]+$/, ""), stderr: "" };
  } catch (err: any) {
    return {
      ok: false,
      stdout: String(err?.stdout ?? "").replace(/[\r\n]+$/, ""),
      stderr: String(err?.stderr ?? err?.message ?? "").trim(),
    };
  }
}

export function isGitRepo(workspace: string): boolean {
  if (!fs.existsSync(workspace)) return false;
  const res = runGit(workspace, ["rev-parse", "--is-inside-work-tree"]);
  return res.ok && res.stdout.trim() === "true";
}

function hasCommits(workspace: string): boolean {
  return runGit(workspace, ["rev-parse", "--verify", "HEAD"]).ok;
}

function copyLightWorkspace(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  if (!fs.existsSync(src)) return;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyLightWorkspace(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function snapshotFilesMap(rootDir: string): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  if (!fs.existsSync(rootDir)) return map;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(rootDir, full).replace(/\\/g, "/");
        map.set(rel, fs.readFileSync(full));
      }
    }
  };
  walk(rootDir);
  return map;
}

// 1. 스레드 유닛([B_n + C_n]) 전용 격리 작업 공간 생성 (Git Worktree 우선, 비-Git 폴더는 경량 복사 폴백)
export function createUnitWorkspace(
  mainWorkspace: string,
  jobDir: string,
  jobId: string,
  unitId: string,
  config: CkdConfig,
): UnitWorkspace {
  const unitRoot = path.join(jobDir, "worktrees", unitId);
  fs.mkdirSync(path.dirname(unitRoot), { recursive: true });

  if (config.threads.useWorktree && isGitRepo(mainWorkspace) && hasCommits(mainWorkspace)) {
    const shortJob = jobId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-14);
    const branchName = `${config.github.branchPrefix}/${shortJob}/${unitId}`;
    const head = runGit(mainWorkspace, ["rev-parse", "HEAD"]);
    const wt = runGit(mainWorkspace, ["worktree", "add", "-B", branchName, unitRoot, "HEAD"]);
    if (wt.ok) {
      return {
        unitId,
        mode: "worktree",
        mainWorkspace,
        unitPath: unitRoot,
        branchName,
        baseCommit: head.stdout.trim(),
      };
    }
  }

  // Git 저장소가 아니거나 커밋이 없는 새 폴더인 경우 경량 격리 폴더 생성 + 초기 파일 스냅샷 기록
  copyLightWorkspace(mainWorkspace, unitRoot);
  const baseFiles = snapshotFilesMap(unitRoot);
  return {
    unitId,
    mode: "copy",
    mainWorkspace,
    unitPath: unitRoot,
    baseFiles,
  };
}

// 2. 유닛 작업 공간의 변경점(Diff 및 변경된 파일 목록) 추출 — B_n 검수자 및 UI 표시용
export function getUnitDiff(unit: UnitWorkspace): { changedFiles: string[]; diffText: string } {
  if (!fs.existsSync(unit.unitPath)) return { changedFiles: [], diffText: "" };

  if (unit.mode === "worktree") {
    // 새 파일(untracked)까지 diff에 보이기 위해 intent-to-add 적용 후 HEAD 기준 diff 추출
    runGit(unit.unitPath, ["add", "-N", "."]);
    const names = runGit(unit.unitPath, ["diff", "--name-only", "HEAD"]);
    const changedFiles = names.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const diff = runGit(unit.unitPath, ["diff", "HEAD"]);
    return {
      changedFiles,
      diffText: diff.stdout.slice(0, 20000),
    };
  }

  // copy 모드: 초기 스냅샷(baseFiles)과 현재 유닛 파일들을 비교 (추가/수정/삭제 모두 감지)
  const base = unit.baseFiles ?? new Map<string, Buffer>();
  const current = snapshotFilesMap(unit.unitPath);
  const changedFiles: string[] = [];
  const diffLines: string[] = [];

  for (const [rel, buf] of current.entries()) {
    const baseBuf = base.get(rel);
    if (!baseBuf) {
      changedFiles.push(rel);
      diffLines.push(`+ ${rel}`);
    } else if (!buf.equals(baseBuf)) {
      changedFiles.push(rel);
      diffLines.push(`M ${rel}`);
    }
  }
  for (const rel of base.keys()) {
    if (!current.has(rel)) {
      changedFiles.push(rel);
      diffLines.push(`- ${rel}`);
    }
  }

  return {
    changedFiles,
    diffText: changedFiles.length > 0 ? `변경된 파일 (${changedFiles.length}개):\n` + diffLines.join("\n") : "",
  };
}

// 3. 유닛 변경 사항 커밋 및 선택형 GitHub 브랜치 Push / PR 생성 (B 검수용 또는 완료 동기화용)
export function syncUnitToGithub(
  unit: UnitWorkspace,
  config: CkdConfig,
  commitMessage: string,
): { pushed: boolean; prUrl?: string; warning?: string } {
  if (unit.mode !== "worktree" || !unit.branchName) {
    return { pushed: false };
  }

  // 로컬 worktree 브랜치에 먼저 커밋 (전역 git user.name/email 미설정 환경 대비)
  runGit(unit.unitPath, ["add", "-A"]);
  const hasStaged = runGit(unit.unitPath, ["diff", "--cached", "--quiet"]);
  if (!hasStaged.ok) {
    runGit(unit.unitPath, [...GIT_IDENTITY, "commit", "-m", commitMessage]);
  }

  if (config.github.mode === "off") {
    return { pushed: false };
  }

  const push = runGit(unit.unitPath, ["push", "-u", config.github.remote, unit.branchName, "--force-with-lease"]);
  if (!push.ok) {
    return { pushed: false, warning: `GitHub Push 실패: ${push.stderr}` };
  }
  unit.remotePushed = true;

  if (config.github.mode === "pr_on_review" && !unit.prUrl) {
    try {
      const prOut = execFileSync(
        "gh",
        ["pr", "create", "--head", unit.branchName, "--title", `[CKD ${unit.unitId}] ${commitMessage}`, "--body", "Herdr CKD 자동 생성 검수 PR"],
        { cwd: unit.unitPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 },
      );
      unit.prUrl = prOut.trim();
    } catch {
      // gh CLI가 없거나 이미 PR이 있는 경우 브랜치 Push만 유지
    }
  }

  // 오래된 원격 브랜치 순차 삭제 정책 실행
  pruneOldRemoteBranches(unit.mainWorkspace, config);
  return { pushed: true, prUrl: unit.prUrl };
}

// 4. 통과한 유닛의 결과를 메인 작업 폴더로 병합(Merge / 반영)
export function applyUnitToMain(unit: UnitWorkspace, commitMsg: string): { ok: boolean; conflicts: string[]; error?: string } {
  if (!fs.existsSync(unit.unitPath)) return { ok: false, conflicts: [], error: "유닛 작업 폴더가 없습니다." };

  if (unit.mode === "worktree" && unit.branchName) {
    runGit(unit.unitPath, ["add", "-A"]);
    const hasStaged = runGit(unit.unitPath, ["diff", "--cached", "--quiet"]);
    if (!hasStaged.ok) {
      runGit(unit.unitPath, [...GIT_IDENTITY, "commit", "-m", commitMsg]);
    }
    const merge = runGit(unit.mainWorkspace, [...GIT_IDENTITY, "merge", "--no-ff", "-m", `[CKD Merge] ${commitMsg}`, unit.branchName]);
    if (!merge.ok) {
      const conflictCheck = runGit(unit.mainWorkspace, ["diff", "--name-only", "--diff-filter=U"]);
      const conflicts = conflictCheck.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      runGit(unit.mainWorkspace, ["merge", "--abort"]);
      return { ok: false, conflicts, error: merge.stderr || merge.stdout };
    }
    return { ok: true, conflicts: [] };
  }

  // copy 모드: baseFiles 대비 추가/수정/삭제된 파일만 반영하며, 메인 폴더와의 동시 수정 충돌을 검사한다.
  const base = unit.baseFiles ?? new Map<string, Buffer>();
  const current = snapshotFilesMap(unit.unitPath);
  const toWrite: [string, Buffer][] = [];
  const toDelete: string[] = [];

  for (const [rel, buf] of current.entries()) {
    const baseBuf = base.get(rel);
    if (!baseBuf || !buf.equals(baseBuf)) {
      toWrite.push([rel, buf]);
    }
  }
  for (const rel of base.keys()) {
    if (!current.has(rel)) {
      toDelete.push(rel);
    }
  }

  const conflicts: string[] = [];
  for (const [rel, unitBuf] of toWrite) {
    const mainFile = path.join(unit.mainWorkspace, ...rel.split("/"));
    const mainExists = fs.existsSync(mainFile) && fs.statSync(mainFile).isFile();
    const mainBuf = mainExists ? fs.readFileSync(mainFile) : undefined;
    const baseBuf = base.get(rel);

    if (baseBuf) {
      // 원래 있던 파일을 이 유닛이 수정했는데, 메인 폴더에서도 원래와 다르게 수정(또는 삭제)되었고 내용도 다르면 충돌
      const mainChanged = !mainBuf || !mainBuf.equals(baseBuf);
      if (mainChanged && (!mainBuf || !mainBuf.equals(unitBuf))) {
        conflicts.push(rel);
      }
    } else {
      // 새로 추가한 파일인데, 메인 폴더에도 같은 경로의 파일이 다른 내용으로 이미 생성되어 있으면 충돌
      if (mainBuf && !mainBuf.equals(unitBuf)) {
        conflicts.push(rel);
      }
    }
  }

  for (const rel of toDelete) {
    const mainFile = path.join(unit.mainWorkspace, ...rel.split("/"));
    const mainExists = fs.existsSync(mainFile) && fs.statSync(mainFile).isFile();
    const baseBuf = base.get(rel)!;
    if (mainExists) {
      const mainBuf = fs.readFileSync(mainFile);
      if (!mainBuf.equals(baseBuf)) {
        conflicts.push(rel);
      }
    }
  }

  if (conflicts.length > 0) {
    return { ok: false, conflicts, error: "동일 파일 동시 수정 충돌" };
  }

  fs.mkdirSync(unit.mainWorkspace, { recursive: true });
  for (const [rel, unitBuf] of toWrite) {
    const to = path.join(unit.mainWorkspace, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, unitBuf);
  }
  for (const rel of toDelete) {
    const to = path.join(unit.mainWorkspace, ...rel.split("/"));
    if (fs.existsSync(to)) {
      fs.rmSync(to, { force: true });
    }
  }

  return { ok: true, conflicts: [] };
}

// Round 2+ 재작업 진입 시 메인 작업 폴더의 최신 병합 상태를 유닛 작업 공간으로 동기화한다.
export function syncUnitWithMain(unit: UnitWorkspace): void {
  if (!fs.existsSync(unit.unitPath) || !fs.existsSync(unit.mainWorkspace)) return;

  if (unit.mode === "worktree") {
    runGit(unit.unitPath, ["add", "-A"]);
    const hasStaged = runGit(unit.unitPath, ["diff", "--cached", "--quiet"]);
    if (!hasStaged.ok) {
      runGit(unit.unitPath, [...GIT_IDENTITY, "commit", "-m", `[CKD] WIP before sync ${unit.unitId}`]);
    }
    const head = runGit(unit.mainWorkspace, ["rev-parse", "HEAD"]);
    const mainSha = head.stdout.trim();
    if (!head.ok || !mainSha) return;

    const merge = runGit(unit.unitPath, [...GIT_IDENTITY, "merge", "--no-edit", mainSha]);
    if (!merge.ok) {
      runGit(unit.unitPath, ["merge", "--abort"]);
      const theirs = runGit(unit.unitPath, [...GIT_IDENTITY, "merge", "--no-edit", "-X", "theirs", mainSha]);
      if (!theirs.ok) {
        runGit(unit.unitPath, ["merge", "--abort"]);
      }
    }
    unit.baseCommit = mainSha;
    return;
  }

  // copy 모드: 메인 작업 폴더에서 새로 추가/수정/삭제된 파일들을 유닛 작업 공간에 반영하고 baseFiles를 갱신한다.
  const base = unit.baseFiles ?? new Map<string, Buffer>();
  const mainFiles = snapshotFilesMap(unit.mainWorkspace);

  for (const [rel, mainBuf] of mainFiles.entries()) {
    const prevBase = base.get(rel);
    if (!prevBase || !prevBase.equals(mainBuf)) {
      const dst = path.join(unit.unitPath, ...rel.split("/"));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, mainBuf);
      base.set(rel, mainBuf);
    }
  }

  for (const [rel, prevBase] of [...base.entries()]) {
    if (!mainFiles.has(rel)) {
      const dst = path.join(unit.unitPath, ...rel.split("/"));
      if (fs.existsSync(dst) && fs.statSync(dst).isFile()) {
        const cur = fs.readFileSync(dst);
        if (cur.equals(prevBase)) {
          fs.rmSync(dst, { force: true });
        }
      }
      base.delete(rel);
    }
  }

  unit.baseFiles = base;
}

// 5. 작업 완료 시 로컬 Worktree 삭제 및 GitHub 원격 임시 브랜치 자동 삭제
export function cleanupUnitWorkspace(unit: UnitWorkspace, config: CkdConfig): void {
  if (unit.mode === "worktree") {
    if (unit.remotePushed && unit.branchName && config.github.deleteBranchOnComplete) {
      runGit(unit.mainWorkspace, ["push", config.github.remote, "--delete", unit.branchName]);
    }
    runGit(unit.mainWorkspace, ["worktree", "remove", "--force", unit.unitPath]);
    if (unit.branchName) {
      runGit(unit.mainWorkspace, ["branch", "-D", unit.branchName]);
    }
  }
  if (fs.existsSync(unit.unitPath)) {
    try {
      fs.rmSync(unit.unitPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// 6. GitHub에 쌓인 오래된 ckd/* 원격 브랜치를 maxRemoteBranches 한도에 맞춰 순차 자동 삭제(FIFO)
export function pruneOldRemoteBranches(mainWorkspace: string, config: CkdConfig): string[] {
  const maxKeep = config.github.maxRemoteBranches;
  if (maxKeep <= 0 || !isGitRepo(mainWorkspace)) return [];

  const remote = config.github.remote;
  const prefix = `${config.github.branchPrefix}/`;
  runGit(mainWorkspace, ["fetch", remote, "--prune"]);

  // 커밋 시각 오래된 순(committerdate)으로 원격 브랜치 조회
  const refs = runGit(mainWorkspace, [
    "for-each-ref",
    "--sort=committerdate",
    "--format=%(refname:short)",
    `refs/remotes/${remote}/${config.github.branchPrefix}`,
  ]);
  if (!refs.ok || !refs.stdout) return [];

  const branches = refs.stdout
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith(`${remote}/${prefix}`))
    .map((b) => b.slice(remote.length + 1));

  if (branches.length <= maxKeep) return [];

  const toDelete = branches.slice(0, branches.length - maxKeep);
  const deleted: string[] = [];
  for (const branch of toDelete) {
    const del = runGit(mainWorkspace, ["push", remote, "--delete", branch]);
    if (del.ok) deleted.push(branch);
  }
  return deleted;
}
