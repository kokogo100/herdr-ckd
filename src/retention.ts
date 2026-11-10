// CKD 작동 로그 및 임시 폴더 자동 정리(Retention & Garbage Collection) 모듈
// 무한히 쌓이는 jobs/<ID>/ 로그와 original/worktrees 임시 데이터를 설정된 한도(개수·용량) 내에서 순차 삭제한다.
import fs from "node:fs";
import path from "node:path";
import type { CkdConfig } from "./config.js";

export interface JobDirInfo {
  jobId: string;
  fullPath: string;
  mtimeMs: number;
  sizeBytes: number;
  status?: string;
}

export interface RetentionReport {
  deletedTempDirs: string[];
  deletedJobs: string[];
  freedBytes: number;
  remainingJobs: number;
  remainingBytes: number;
}

export function getDirectorySize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirectorySize(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch {
    // 삭제 중이거나 접근 불가한 파일은 무시
  }
  return total;
}

// 1. 단일 작업이 끝났을 때 무거운 임시 폴더(original 사본, 임시 worktrees, 임시 screenshots)를 즉시 삭제한다.
export function cleanupJobTemp(jobDir: string, deleteTempOnComplete = true): { deleted: string[]; freedBytes: number } {
  const deleted: string[] = [];
  let freedBytes = 0;
  if (!deleteTempOnComplete || !fs.existsSync(jobDir)) return { deleted, freedBytes };

  for (const sub of ["original", "worktrees", "screenshots"]) {
    const target = path.join(jobDir, sub);
    if (fs.existsSync(target)) {
      const bytes = getDirectorySize(target);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        deleted.push(target);
        freedBytes += bytes;
      } catch {
        // 파일 잠김 시 다음 순환 정리에서 제거됨
      }
    }
  }
  return { deleted, freedBytes };
}

export function listJobDirs(dataDir: string): JobDirInfo[] {
  const jobsRoot = path.join(dataDir, "jobs");
  if (!fs.existsSync(jobsRoot)) return [];
  const list: JobDirInfo[] = [];
  for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const fullPath = path.join(jobsRoot, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      const stateFile = path.join(fullPath, "state.json");
      let status: string | undefined;
      if (fs.existsSync(stateFile)) {
        try {
          status = JSON.parse(fs.readFileSync(stateFile, "utf8")).status;
        } catch {
          status = undefined;
        }
      }
      list.push({
        jobId: entry.name,
        fullPath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: getDirectorySize(fullPath),
        status,
      });
    } catch {
      // ignore
    }
  }
  // 오래된 작업이 먼저 오도록 정렬 (FIFO 삭제용)
  return list.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function trimFinetuneDirectory(dataDir: string, maxFinetuneSizeMB: number): number {
  if (maxFinetuneSizeMB <= 0) return 0;
  const finetuneDir = path.join(dataDir, "finetune");
  if (!fs.existsSync(finetuneDir)) return 0;

  const maxBytes = maxFinetuneSizeMB * 1024 * 1024;
  let currentBytes = getDirectorySize(finetuneDir);
  if (currentBytes <= maxBytes) return 0;

  let freed = 0;
  const entries = fs
    .readdirSync(finetuneDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => e.name);

  // curated.jsonl은 가장 마지막에 정리되도록 뒤로 배치한다.
  entries.sort((a, b) => {
    if (a === "curated.jsonl") return 1;
    if (b === "curated.jsonl") return -1;
    return a.localeCompare(b);
  });

  for (const name of entries) {
    if (currentBytes <= maxBytes) break;
    const filePath = path.join(finetuneDir, name);
    const beforeSize = fs.statSync(filePath).size;
    if (beforeSize === 0) continue;

    const rawLines = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    if (rawLines.length === 0) continue;

    if (name === "curated.jsonl") {
      // curated.jsonl은 비-"good" 항목을 먼저 삭제한 뒤, 여전히 초과할 때만 오래된 "good" 항목을 삭제한다.
      const indexed = rawLines.map((line, idx) => {
        let tier = 0; // 0: 비-good, 1: suggested_label만 good, 2: training_label이 good
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.training_label === "good" || parsed.label === "good") {
            tier = 2;
          } else if (parsed.suggested_label === "good") {
            tier = 1;
          }
        } catch {
          tier = 0;
        }
        return { line, idx, tier, byteLen: Buffer.byteLength(line + "\n", "utf8") };
      });

      const dropOrder = [...indexed].sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.idx - b.idx));
      const droppedIndices = new Set<number>();
      for (const item of dropOrder) {
        if (currentBytes <= maxBytes) break;
        droppedIndices.add(item.idx);
        currentBytes -= item.byteLen;
        freed += item.byteLen;
      }

      const kept = indexed.filter((item) => !droppedIndices.has(item.idx)).map((item) => item.line);
      fs.writeFileSync(filePath, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
    } else {
      // 일반 jsonl 파일은 가장 오래된 앞줄부터 순차 삭제
      let startIdx = 0;
      while (startIdx < rawLines.length && currentBytes > maxBytes) {
        const byteLen = Buffer.byteLength(rawLines[startIdx] + "\n", "utf8");
        currentBytes -= byteLen;
        freed += byteLen;
        startIdx++;
      }
      const kept = rawLines.slice(startIdx);
      fs.writeFileSync(filePath, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
    }
  }

  return Math.max(0, freed);
}

// 2. 전체 jobs/ 폴더를 점검하여 maxJobsToKeep 또는 maxLogSizeMB 초과 시 가장 오래된 작업부터 순차 삭제한다.
// 진행 중인 작업(running, awaiting_review)은 삭제하지 않는다.
export function enforceLogRetention(config: CkdConfig, activeJobIds: Set<string> = new Set()): RetentionReport {
  const { maxJobsToKeep, maxLogSizeMB, deleteTempOnComplete } = config.retention;
  const maxFinetuneSizeMB = config.retention.maxFinetuneSizeMB ?? 200;
  const maxBytes = maxLogSizeMB > 0 ? maxLogSizeMB * 1024 * 1024 : 0;
  const deletedTempDirs: string[] = [];
  const deletedJobs: string[] = [];
  let freedBytes = 0;

  const jobs = listJobDirs(config.dataDir);
  const hasActiveJob =
    activeJobIds.size > 0 || jobs.some((j) => j.status === "running" || j.status === "awaiting_review");

  // 먼저 끝난 작업들에 남아 있는 original / worktrees / screenshots 임시 폴더부터 정리
  if (deleteTempOnComplete) {
    for (const j of jobs) {
      if (activeJobIds.has(j.jobId) || j.status === "running" || j.status === "awaiting_review") continue;
      const res = cleanupJobTemp(j.fullPath, true);
      if (res.deleted.length > 0) {
        deletedTempDirs.push(...res.deleted);
        freedBytes += res.freedBytes;
        j.sizeBytes = getDirectorySize(j.fullPath);
      }
    }

    // 진행 중인 작업이 없으면 공용 임시 스크린샷 폴더(dataDir/screenshots)도 정리
    if (!hasActiveJob) {
      const sharedShots = path.join(config.dataDir, "screenshots");
      if (fs.existsSync(sharedShots)) {
        const shotBytes = getDirectorySize(sharedShots);
        try {
          fs.rmSync(sharedShots, { recursive: true, force: true });
          if (shotBytes > 0) {
            deletedTempDirs.push(sharedShots);
            freedBytes += shotBytes;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  let totalBytes = jobs.reduce((sum, j) => sum + j.sizeBytes, 0);
  let remainingCount = jobs.length;

  for (const j of jobs) {
    const overCount = maxJobsToKeep > 0 && remainingCount > maxJobsToKeep;
    const overSize = maxLogSizeMB > 0 && totalBytes > maxBytes;
    if (!overCount && !overSize) break;

    if (activeJobIds.has(j.jobId) || j.status === "running" || j.status === "awaiting_review") {
      continue;
    }

    try {
      fs.rmSync(j.fullPath, { recursive: true, force: true });
      deletedJobs.push(j.jobId);
      freedBytes += j.sizeBytes;
      totalBytes -= j.sizeBytes;
      remainingCount--;
    } catch {
      // ignore
    }
  }

  return {
    deletedTempDirs,
    deletedJobs,
    freedBytes,
    remainingJobs: remainingCount,
    remainingBytes: Math.max(0, totalBytes),
  };
}

// 사용자가 상단 [🧹 작동 로그 즉시 정리] 버튼을 직접 눌렀을 때:
// 설정 한도(30개/500MB) 이하더라도, 현재 진행 중(running / awaiting_review)이 아닌 모든 완료·실패·중단 작업 로그를 즉시 전부 비운다.
// (파인튜닝 데이터 finetune/ 폴더는 건드리지 않고 안전하게 보존한다.)
export function purgeAllCompletedLogs(
  config: CkdConfig,
  activeJobIds: Set<string> = new Set(),
): RetentionReport {
  const jobs = listJobDirs(config.dataDir);
  const deletedTempDirs: string[] = [];
  const deletedJobs: string[] = [];
  let freedBytes = 0;
  let remainingJobs = 0;
  let remainingBytes = 0;

  for (const j of jobs) {
    if (activeJobIds.has(j.jobId) || j.status === "running" || j.status === "awaiting_review") {
      remainingJobs++;
      remainingBytes += j.sizeBytes;
      continue;
    }
    try {
      fs.rmSync(j.fullPath, { recursive: true, force: true });
      deletedJobs.push(j.jobId);
      freedBytes += j.sizeBytes;
    } catch {
      remainingJobs++;
      remainingBytes += j.sizeBytes;
    }
  }

  // jobs/_curation 임시 폴더가 있으면 함께 정리
  const curationTmp = path.join(config.dataDir, "jobs", "_curation");
  if (fs.existsSync(curationTmp)) {
    const tmpBytes = getDirectorySize(curationTmp);
    try {
      fs.rmSync(curationTmp, { recursive: true, force: true });
      deletedTempDirs.push(curationTmp);
      freedBytes += tmpBytes;
    } catch {
      // ignore
    }
  }

  return {
    deletedTempDirs,
    deletedJobs,
    freedBytes,
    remainingJobs,
    remainingBytes,
  };
}

export interface FinetuneSummary {
  finetuneBytes: number;
  finetuneMB: number;
  sessionCount: number;
  byRole: { A: number; B: number; C: number };
  curatedCount: number;
  goodCount: number;
}

export function getFinetuneSummary(dataDir: string): FinetuneSummary {
  const ftDir = path.join(dataDir, "finetune");
  const finetuneBytes = getDirectorySize(ftDir);
  const byRole = { A: 0, B: 0, C: 0 };

  for (const role of ["A", "B", "C"] as const) {
    const f = path.join(ftDir, `${role}.jsonl`);
    if (fs.existsSync(f)) {
      try {
        const lines = fs
          .readFileSync(f, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0);
        byRole[role] = lines.length;
      } catch {
        // ignore
      }
    }
  }

  let curatedCount = 0;
  let goodCount = 0;
  const curatedPath = path.join(ftDir, "curated.jsonl");
  if (fs.existsSync(curatedPath)) {
    try {
      const lines = fs
        .readFileSync(curatedPath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      curatedCount = lines.length;
      for (const l of lines) {
        try {
          const obj = JSON.parse(l) as Record<string, unknown>;
          if (obj.training_label === "good" || obj.label === "good") goodCount++;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    finetuneBytes,
    finetuneMB: Number((finetuneBytes / (1024 * 1024)).toFixed(2)),
    sessionCount: byRole.A + byRole.B + byRole.C,
    byRole,
    curatedCount,
    goodCount,
  };
}

export function exportFinetuneDataset(
  dataDir: string,
  opts: { onlyGood?: boolean; role?: string; format?: "json" | "jsonl" } = {},
): { content: string; count: number; filename: string; contentType: string } {
  const ftDir = path.join(dataDir, "finetune");
  const curatedMap = new Map<string, Record<string, unknown>>();
  const curatedPath = path.join(ftDir, "curated.jsonl");
  if (fs.existsSync(curatedPath)) {
    try {
      for (const line of fs.readFileSync(curatedPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (typeof obj.job_id === "string") curatedMap.set(obj.job_id, obj);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  const targetRoles =
    opts.role && ["A", "B", "C"].includes(opts.role.toUpperCase())
      ? [opts.role.toUpperCase()]
      : ["C", "A", "B"];

  const records: Array<Record<string, unknown>> = [];
  for (const role of targetRoles) {
    const f = path.join(ftDir, `${role}.jsonl`);
    if (!fs.existsSync(f)) continue;
    try {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { messages?: unknown[]; meta?: Record<string, unknown> };
          const meta = parsed.meta ?? {};
          const jobId = typeof meta.job_id === "string" ? meta.job_id : "";
          const cur = jobId ? curatedMap.get(jobId) : undefined;
          const trainingLabel = cur?.training_label ?? cur?.label ?? null;
          if (opts.onlyGood) {
            const isPreferred = meta.preference_tag === "preferred";
            if (trainingLabel !== "good" && !(trainingLabel === null && isPreferred && cur === undefined ? false : trainingLabel === "good")) {
              if (trainingLabel !== "good") continue;
            }
          }
          records.push({
            messages: Array.isArray(parsed.messages) ? parsed.messages : [],
            meta: {
              ...meta,
              ...(trainingLabel ? { training_label: trainingLabel } : {}),
            },
          });
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore
    }
  }

  const dateTag = new Date().toISOString().slice(0, 10);
  const fmt = opts.format === "jsonl" ? "jsonl" : "json";
  if (fmt === "jsonl") {
    return {
      content: records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
      count: records.length,
      filename: `herdr-ckd-finetune-${dateTag}.jsonl`,
      contentType: "application/x-ndjson; charset=utf-8",
    };
  }
  return {
    content: JSON.stringify(records, null, 2),
    count: records.length,
    filename: `herdr-ckd-finetune-${dateTag}.json`,
    contentType: "application/json; charset=utf-8",
  };
}

// 사용자의 수동 리셋 버튼 실행 시 파인튜닝 수집 폴더를 0 MB로 초기화한다.
export function resetFinetuneDirectory(dataDir: string): { freedBytes: number } {
  const ftDir = path.join(dataDir, "finetune");
  const freedBytes = getDirectorySize(ftDir);
  if (fs.existsSync(ftDir)) {
    fs.rmSync(ftDir, { recursive: true, force: true });
  }
  fs.mkdirSync(ftDir, { recursive: true });

  // 기존 완료된 작업 폴더 내 curation.json이 다음 작업 완료 시 다시 합쳐지지 않도록 정리
  const jobsRoot = path.join(dataDir, "jobs");
  if (fs.existsSync(jobsRoot)) {
    for (const entry of fs.readdirSync(jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const curFile = path.join(jobsRoot, entry.name, "curation.json");
      if (fs.existsSync(curFile)) {
        try {
          fs.rmSync(curFile, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }
  return { freedBytes };
}

export function getStorageStats(dataDir: string): {
  jobCount: number;
  jobsBytes: number;
  jobsMB: number;
  finetuneBytes: number;
  finetuneMB: number;
} {
  const jobs = listJobDirs(dataDir);
  const jobsBytes = jobs.reduce((s, j) => s + j.sizeBytes, 0);
  const finetuneBytes = getDirectorySize(path.join(dataDir, "finetune"));
  return {
    jobCount: jobs.length,
    jobsBytes,
    jobsMB: Number((jobsBytes / (1024 * 1024)).toFixed(2)),
    finetuneBytes,
    finetuneMB: Number((finetuneBytes / (1024 * 1024)).toFixed(2)),
  };
}
