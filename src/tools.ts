// A·B가 작업 폴더 안에서 쓰는 도구. A는 읽기·쓰기·명령, B는 읽기·명령(검사용)만 받는다.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CkdConfig, Role } from "./config.js";
import type { ToolSpec } from "./llm.js";
import { PREFIX as SERENA_PREFIX, type ExternalTools } from "./serena.js";
import { fetchUrl, githubSearch, webSearch } from "./web.js";
import { browserCheck, pathToFileURL, type BrowserAction } from "./browser.js";
import { imagePart } from "./images.js";
import { factsText, inspectJob } from "./inspect.js";
import type { ContentPart } from "./llm.js";

export interface ToolContext {
  workspace: string;
  config: CkdConfig;
  signal?: AbortSignal;
  external?: ExternalTools;
  onImage?: (part: ContentPart) => void; // view_image가 본 이미지를 다음 메시지에 붙이게 넘긴다
  jobDir?: string; // 지금 작업의 기록 폴더 (inspect_job 기본값)
}

type Handler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

interface ToolDef {
  spec: ToolSpec;
  handler: Handler;
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

// 작업 폴더 밖으로 나가는 경로는 막는다.
export function resolveInWorkspace(workspace: string, p: string): string {
  const root = path.resolve(workspace);
  const full = path.resolve(root, p);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`작업 폴더 밖의 경로는 사용할 수 없습니다: ${p}`);
  }
  return full;
}

// 출력만 UTF-8로 맞춘다. PYTHONUTF8까지 켜면 open()의 기본 인코딩도 바뀌어서
// 사용자 터미널(Windows는 cp949)에서만 생기는 인코딩 버그가 숨는다.
export function commandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: "utf-8" };
}

// CKD 자신의 보조 스크립트(ddgs 검색)는 전부 UTF-8로 돌린다.
export function utf8Env(): NodeJS.ProcessEnv {
  return { ...commandEnv(), PYTHONUTF8: "1" };
}

// 읽기는 작업 폴더와 readPaths 안에서만 허용한다. 쓰기는 작업 폴더만.
export function resolveForRead(workspace: string, readPaths: string[], p: string): string {
  if (path.isAbsolute(p)) {
    const full = path.resolve(p);
    for (const root of readPaths) {
      const rel = path.relative(path.resolve(root), full);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return full;
    }
  }
  return resolveInWorkspace(workspace, p);
}

// Windows cmd 내장 메시지나 PowerShell은 UTF-8 설정을 무시하고 cp949로 출력하기도 한다.
// UTF-8로 올바르지 않으면 cp949(euc-kr)로 다시 읽는다.
export function decodeOutput(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("euc-kr").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n... (${text.length - max}자 생략) ...\n\n${text.slice(-half)}`;
}

const listDir: ToolDef = {
  spec: fn("list_dir", "작업 폴더(또는 읽기 전용 경로) 안의 파일과 폴더 목록을 봅니다.", { path: { type: "string", description: "작업 폴더 기준 상대 경로. 기본값 ." } }, []),
  async handler(args, ctx) {
    const dir = resolveForRead(ctx.workspace, ctx.config.readPaths, String(args.path ?? "."));
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== "node_modules" && e.name !== ".git")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return entries.join("\n") || "(비어 있음)";
  },
};

const readFile: ToolDef = {
  spec: fn("read_file", "파일 내용을 읽습니다. 작업 폴더 기준 상대 경로 또는 읽기 전용 경로 안의 절대 경로.", { path: { type: "string" } }, ["path"]),
  async handler(args, ctx) {
    const file = resolveForRead(ctx.workspace, ctx.config.readPaths, String(args.path));
    const text = fs.readFileSync(file, "utf8");
    if (text.length <= ctx.config.maxToolOutputChars) return text;
    const lines = text.split("\n").filter((l) => l.length > 0).length;
    return `${truncate(text, ctx.config.maxToolOutputChars)}\n\n[파일이 길어 가운데가 잘렸습니다. 전체 ${lines}줄, ${text.length}자. 줄 수 세기나 집계는 이 화면으로 추측하지 말고 run_command로 python 한 줄 스크립트를 실행해 계산하세요.]`;
  },
};

// 쓰기 경로에 이상한 문자가 있으면 실행하지 않는다 (예: "index.html`"처럼 끝에 기호가 붙어 엉뚱한 새 파일이 생기는 일).
export function badWritePath(p: string): string | undefined {
  if (p !== p.trim()) return "경로 앞뒤에 공백이 있습니다";
  if (/[\u0000-\u001f`'"<>|?*]/.test(p)) return "경로에 쓸 수 없는 문자(백틱, 따옴표, 제어 문자, < > | ? * 등)가 있습니다";
  const withoutDrive = p.replace(/^[A-Za-z]:(?=[\\/])/, "");
  if (withoutDrive.includes(":")) return "경로에 콜론(:)이 있습니다";
  return undefined;
}

const writeFile: ToolDef = {
  spec: fn("write_file", "파일을 새로 만들거나 전체 내용을 덮어씁니다.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  async handler(args, ctx) {
    const bad = badWritePath(String(args.path));
    if (bad) return `도구 실행 안 함: ${bad}: ${JSON.stringify(args.path)}. 아무것도 바뀌지 않았습니다. 경로를 고쳐 다시 부르세요.`;
    const file = resolveInWorkspace(ctx.workspace, String(args.path));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(args.content ?? ""), "utf8");
    return `저장함: ${args.path}`;
  },
};

const editFile: ToolDef = {
  spec: fn(
    "edit_file",
    "파일에서 old_text를 정확히 한 번 찾아 new_text로 바꿉니다.",
    { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
    ["path", "old_text", "new_text"],
  ),
  async handler(args, ctx) {
    const bad = badWritePath(String(args.path));
    if (bad) return `도구 실행 안 함: ${bad}: ${JSON.stringify(args.path)}. 아무것도 바뀌지 않았습니다. 경로를 고쳐 다시 부르세요.`;
    const file = resolveInWorkspace(ctx.workspace, String(args.path));
    const content = fs.readFileSync(file, "utf8");
    const oldText = String(args.old_text);
    const count = content.split(oldText).length - 1;
    if (count !== 1) return `수정 실패: old_text가 ${count}번 나옵니다. 정확히 한 번 나오는 부분을 지정해 주세요.`;
    fs.writeFileSync(file, content.replace(oldText, () => String(args.new_text)), "utf8");
    return `수정함: ${args.path}`;
  },
};

const runCommand: ToolDef = {
  spec: fn("run_command", "작업 폴더에서 셸 명령을 실행하고 출력과 종료 코드를 받습니다.", { command: { type: "string" } }, ["command"]),
  async handler(args, ctx) {
    let command = String(args.command);
    if (ctx.config.tools.rtk) command = `rtk ${command}`;
    // Windows cmd는 기본이 cp949라 출력이 깨진다. 코드 페이지를 UTF-8(65001)로 바꾸고 실행한다.
    if (process.platform === "win32") command = `chcp 65001 >nul & ${command}`;
    return new Promise((resolve) => {
      const child = spawn(command, { cwd: ctx.workspace, shell: true, signal: ctx.signal, env: commandEnv() });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => child.kill(), ctx.config.commandTimeoutMs);
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) => chunks.push(d));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`실행 오류: ${err.message}`);
      });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        const status = sig ? `중단됨(${sig})` : `종료 코드 ${code}`;
        resolve(`${status}\n${truncate(decodeOutput(Buffer.concat(chunks)), ctx.config.maxToolOutputChars)}`);
      });
    });
  },
};

const webSearchTool: ToolDef = {
  spec: fn(
    "web_search",
    "인터넷을 검색합니다 (네이버 키가 있으면 네이버, 이어서 DuckDuckGo). 제목, 주소, 요약을 돌려줍니다.",
    { query: { type: "string" }, max_results: { type: "integer", description: "기본 5" } },
    ["query"],
  ),
  handler: (args, ctx) => webSearch(String(args.query), Number(args.max_results ?? 5), ctx.config),
};

const githubSearchTool: ToolDef = {
  spec: fn(
    "github_search",
    "GitHub를 검색합니다. type은 repositories(기본), code, issues. 오픈소스 후보를 찾을 때 쓰세요.",
    { query: { type: "string" }, type: { type: "string", enum: ["repositories", "code", "issues"] }, max_results: { type: "integer" } },
    ["query"],
  ),
  handler: (args) => githubSearch(String(args.query), String(args.type ?? "repositories"), Number(args.max_results ?? 5)),
};

const fetchUrlTool: ToolDef = {
  spec: fn("fetch_url", "웹페이지를 읽어 본문 텍스트를 돌려줍니다.", { url: { type: "string" } }, ["url"]),
  handler: (args, ctx) => fetchUrl(String(args.url), ctx.config.maxToolOutputChars),
};

const browserCheckTool: ToolDef = {
  spec: fn(
    "browser_check",
    "HTML 결과물을 실제 브라우저(headless)로 엽니다. 파일은 file://로 열어서 더블클릭 실행과 같은 조건입니다. 클릭 등 동작을 한 뒤 콘솔 오류, 페이지 오류, 실패한 요청, 선택자별 개수, 화면 글자를 돌려줍니다.",
    {
      target: { type: "string", description: "HTML 파일 경로(작업 폴더 기준) 또는 http(s) 주소" },
      actions: {
        type: "array",
        description: "차례로 할 동작",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["click", "right_click", "middle_click", "dblclick", "both_click", "wait", "mouse_down", "mouse_move", "mouse_up", "key_press"],
              description: "key_press는 key의 키를 누릅니다(키보드 조작 시험). mouse_down/mouse_up은 button을 누르거나 뗀 채로 둡니다(selector가 있으면 그 요소 가운데로 옮겨서, 없으면 지금 마우스 자리에서). 한 번 누르고 떼는 클릭은 click을 쓰세요. mouse_move는 selector 요소로 마우스를 옮기고, selector가 없으면 화면 구석으로 옮깁니다. 누른 채 옮기는 동작을 시험할 때 씁니다.",
            },
            selector: { type: "string", description: "CSS 선택자" },
            index: { type: "integer", description: "선택자에 맞는 요소 중 몇 번째(0부터)" },
            ms: { type: "integer", description: "wait일 때 기다릴 밀리초" },
            button: { type: "string", enum: ["left", "right", "middle"], description: "mouse_down, mouse_up의 버튼" },
            key: { type: "string", description: "key_press로 누를 키. 예: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Enter, Space" },
          },
          required: ["type"],
        },
      },
      count: { type: "array", items: { type: "string" }, description: "개수를 셀 CSS 선택자" },
    },
    ["target"],
  ),
  handler: (args, ctx) =>
    browserCheck(
      { target: String(args.target), actions: args.actions as BrowserAction[] | undefined, count: args.count as string[] | undefined },
      (p) => pathToFileURL(resolveForRead(ctx.workspace, ctx.config.readPaths, p)).href,
      ctx.config,
    ),
};

// 이미지는 도구 결과(글자)로 보낼 수 없어서, 세션이 바로 다음 user 메시지에 붙인다 (Codex의 view_image와 같은 방식).
const viewImageTool: ToolDef = {
  spec: fn(
    "view_image",
    "이미지 파일(png, jpg, gif, webp)을 직접 봅니다. 사용자가 첨부한 참고 이미지, browser_check 스크린샷, 작업 폴더의 이미지를 확인할 때 씁니다. 이미지는 바로 다음 메시지에 붙습니다.",
    { path: { type: "string", description: "작업 폴더 기준 경로, 또는 첨부 파일·읽기 전용 경로·스크린샷 폴더 안의 절대 경로" } },
    ["path"],
  ),
  async handler(args, ctx) {
    const roots = [...ctx.config.readPaths, path.join(ctx.config.dataDir, "screenshots")];
    const part = imagePart(resolveForRead(ctx.workspace, roots, String(args.path)));
    if (!ctx.onImage) return "이 환경에서는 이미지를 붙일 수 없습니다.";
    ctx.onImage(part);
    return `이미지를 다음 메시지에 붙였습니다: ${args.path}`;
  },
};

// C 전용: 작업 기록을 규칙으로 집계한 사실(회차, 판정, 실패한 명령, 차단된 호출, 반복 등)을 본다.
const inspectJobTool: ToolDef = {
  spec: fn(
    "inspect_job",
    "작업 기록(events.jsonl, 세션)을 규칙으로 집계한 사실을 봅니다: 회차, 판정, 역할별 도구 호출 수, 실패한 명령, 차단된 호출(필수 인자 누락, 반복, 모르는 동작), 같은 수정 반복, 형식 오류, 개인정보 의심. 기록을 정리하거나 반복 원인을 진단할 때 먼저 쓰세요.",
    { job_id: { type: "string", description: "작업 ID. 비우면 지금 작업" } },
    [],
  ),
  async handler(args, ctx) {
    const dir = args.job_id ? path.join(ctx.config.dataDir, "jobs", String(args.job_id)) : ctx.jobDir;
    if (!dir || !fs.existsSync(dir)) return `작업 기록이 없습니다: ${args.job_id ?? "(지금 작업)"}`;
    return truncate(factsText(inspectJob(dir)), ctx.config.maxToolOutputChars);
  },
};

const WEB_TOOLS = [webSearchTool, githubSearchTool, fetchUrlTool];

export type ToolProfile = "maker" | "checker" | "leader";

const PROFILE_TOOLS: Record<ToolProfile, ToolDef[]> = {
  maker: [listDir, readFile, writeFile, editFile, runCommand],
  checker: [listDir, readFile, runCommand],
  leader: [listDir, readFile, runCommand, inspectJobTool],
};

// 기본 Role 매핑 (하위 호환 유지) 및 명시적 ToolProfile 지원
const ROLE_TOOLS: Record<Role, ToolDef[]> = {
  A: PROFILE_TOOLS.maker,
  B: PROFILE_TOOLS.checker,
  C: PROFILE_TOOLS.leader,
};

function resolveTools(roleOrProfile: Role | ToolProfile, config: CkdConfig): ToolDef[] {
  const base = roleOrProfile in PROFILE_TOOLS
    ? PROFILE_TOOLS[roleOrProfile as ToolProfile]
    : ROLE_TOOLS[roleOrProfile as Role];
  return [...base, ...(config.tools.web ? WEB_TOOLS : []), ...(config.tools.browser ? [browserCheckTool] : []), ...(config.tools.vision ? [viewImageTool] : [])];
}

export function toolSpecs(role: Role, config: CkdConfig, external?: ExternalTools, profile?: ToolProfile): ToolSpec[] {
  const serenaRole: Role = profile === "maker" ? "A" : profile === "checker" ? "B" : role;
  return [...resolveTools(profile ?? role, config).map((t) => t.spec), ...(external?.specs(serenaRole) ?? [])];
}

export async function runTool(role: Role, name: string, rawArgs: string, ctx: ToolContext, profile?: ToolProfile): Promise<string> {
  const serenaRole: Role = profile === "maker" ? "A" : profile === "checker" ? "B" : role;
  if (name.startsWith(SERENA_PREFIX) && ctx.external) {
    try {
      return truncate(await ctx.external.call(serenaRole, name, rawArgs), ctx.config.maxToolOutputChars);
    } catch (err) {
      return `도구 실행 실패: ${(err as Error).message}`;
    }
  }
  const tool = resolveTools(profile ?? role, ctx.config).find((t) => t.spec.function.name === name);
  if (!tool) return `알 수 없거나 ${role}에게 허용되지 않은 도구입니다: ${name}`;
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `도구 인수가 올바른 JSON이 아닙니다: ${rawArgs.slice(0, 200)}`;
  }
  // 필수 인자가 빠지면 실행하지 않는다. 빠진 path가 "undefined"라는 파일 이름으로 쓰이던 문제를 막는다.
  const required = (tool.spec.function.parameters as { required?: string[] }).required ?? [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || (k === "path" && args[k] === ""));
  if (missing.length > 0) {
    return `도구 실행 안 함: ${name}의 필수 인자 ${missing.join(", ")}가 없습니다. 아무것도 바뀌지 않았습니다. 인자를 채워 다시 부르세요.`;
  }
  try {
    return await tool.handler(args, ctx);
  } catch (err) {
    return `도구 실행 실패: ${(err as Error).message}`;
  }
}
