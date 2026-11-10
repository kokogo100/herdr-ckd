// 외부 검색 도구: 인터넷 검색(네이버 → DuckDuckGo), GitHub 검색, 웹페이지 읽기.
// AutoInvest(네이버 + ddgs)와 2호 사이트(GitHub REST 검색)의 방식을 따른다. A·B·C 모두 쓴다.
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CkdConfig } from "./config.js";
import { utf8Env } from "./tools.js";

export interface SearchResult {
  title: string;
  summary: string;
  url: string;
  published_at?: string;
  source: string;
}

const DDGS_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/ddgs_search.py");

export function cleanHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/$/, "")}${u.search}`;
  } catch {
    return url;
  }
}

// 네이버 검색은 두 가지 방식이 있다. AutoInvest, 2호 사이트와 같은 환경변수를 쓴다.
// api_hub(기본): 네이버 클라우드 NAVER API HUB 키, NAVER_SEARCH_BASE_URL/search/v1/webkr, X-NCP-APIGW-* 헤더
// developers: developers.naver.com 키, openapi.naver.com, X-Naver-Client-* 헤더
// NAVER_SEARCH_PROVIDER를 정하지 않았으면 api_hub가 401일 때 developers로 한 번 더 시도한다.
async function naverSearch(query: string, n: number, env: NodeJS.ProcessEnv): Promise<SearchResult[]> {
  const id = env.NAVER_CLIENT_ID;
  const secret = env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return [];
  const q = `query=${encodeURIComponent(query)}&display=${Math.min(Math.max(n, 1), 100)}`;
  const hub = () =>
    fetch(`${(env.NAVER_SEARCH_BASE_URL ?? "https://naverapihub.apigw.ntruss.com").replace(/\/$/, "")}/search/v1/webkr?${q}`, {
      headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret },
      signal: AbortSignal.timeout(15000),
    });
  const developers = () =>
    fetch(`${env.NAVER_OPENAPI_BASE_URL ?? "https://openapi.naver.com"}/v1/search/webkr.json?${q}`, {
      headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": secret },
      signal: AbortSignal.timeout(15000),
    });
  const provider = (env.NAVER_SEARCH_PROVIDER ?? "").toLowerCase();
  let res = provider === "developers" ? await developers() : await hub();
  if (res.status === 401 && provider === "") res = await developers();
  if (!res.ok) throw new Error(`네이버 검색 HTTP ${res.status}`);
  const json = await res.json();
  return (json.items ?? []).map((it: Record<string, string>) => ({
    title: cleanHtml(it.title),
    summary: cleanHtml(it.description),
    url: it.link,
    source: "naver",
  }));
}

function ddgsSearch(query: string, n: number, config: CkdConfig): Promise<SearchResult[]> {
  const [cmd, ...args] = config.tools.ddgsCommand;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args, DDGS_SCRIPT, query, String(n)], { shell: false, env: utf8Env() });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`DuckDuckGo 검색 실행 실패: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`DuckDuckGo 검색 실패: ${err.trim().split("\n").pop()}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("DuckDuckGo 검색 결과를 읽지 못했습니다."));
      }
    });
  });
}

// 네이버 키가 있으면 네이버 먼저, 모자라면 DuckDuckGo로 채운다. URL 기준 중복 제거.
export async function webSearch(query: string, n: number, config: CkdConfig, env = process.env): Promise<string> {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  const add = (rows: SearchResult[]) => {
    for (const r of rows) {
      const k = normUrl(r.url);
      if (!r.url || seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  };
  try {
    add(await naverSearch(query, n, env));
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (out.length < n) {
    try {
      add(await ddgsSearch(query, n, config));
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (out.length === 0) return `검색 결과 없음${errors.length ? ` (${errors.join("; ")})` : ""}`;
  return out
    .slice(0, n)
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.summary}${r.published_at ? ` (${r.published_at})` : ""} [${r.source}]`)
    .join("\n");
}

const GITHUB_TYPES = ["repositories", "code", "issues"] as const;

export async function githubSearch(query: string, type: string, n: number, env = process.env, base = "https://api.github.com"): Promise<string> {
  if (!GITHUB_TYPES.includes(type as (typeof GITHUB_TYPES)[number])) type = "repositories";
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "ckd-mcp" };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  else if (type === "code") return "GitHub 코드 검색은 GITHUB_TOKEN 환경변수가 필요합니다. repositories 검색을 쓰세요.";
  const url = `${base}/search/${type}?q=${encodeURIComponent(query)}&per_page=${Math.min(Math.max(n, 1), 30)}`;
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  // 토큰이 잘못되었으면 토큰 없이 한 번 더 (repositories, issues 검색은 토큰 없이도 된다)
  if (res.status === 401 && headers.authorization && type !== "code") {
    delete headers.authorization;
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  }
  if (!res.ok) return `GitHub 검색 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
  const items: Record<string, any>[] = (await res.json()).items ?? [];
  const listed = items
    .map((it, i) => {
      if (type === "repositories") {
        return `${i + 1}. ${it.full_name} ★${it.stargazers_count} (${it.license?.spdx_id ?? "라이선스 미표기"}, 최근 푸시 ${String(it.pushed_at ?? "").slice(0, 10)})\n   ${it.html_url}\n   ${it.description ?? ""}`;
      }
      if (type === "code") return `${i + 1}. ${it.repository?.full_name}: ${it.path}\n   ${it.html_url}`;
      return `${i + 1}. ${it.title} (${it.state})\n   ${it.html_url}`;
    })
    .join("\n");
  // GitHub 검색은 모든 단어가 들어간 결과만 찾는다. 결과가 1건 이하이고 단어가 많으면 앞의 두 단어로 한 번 더 찾는다.
  const words = query.trim().split(/\s+/);
  if (items.length <= 1 && words.length > 2) {
    const broader = words.slice(0, 2).join(" ");
    const retry = await githubSearch(broader, type, n, env, base);
    const head = items.length === 0 ? `"${query}" 검색 결과 없음.` : `"${query}" 검색 결과 1건:\n${listed}\n`;
    return `${head} 검색어를 "${broader}"로 넓혀 다시 찾았습니다.\n${retry}`;
  }
  return items.length === 0 ? "검색 결과 없음" : listed;
}

export async function fetchUrl(url: string, maxChars: number): Promise<string> {
  if (!/^https?:\/\//.test(url)) return "http 또는 https 주소만 읽을 수 있습니다.";
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 ckd-mcp" }, signal: AbortSignal.timeout(20000) });
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = type.includes("html")
    ? cleanHtml(body.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|div|li|h\d|tr|br)>/gi, "\n"))
    : body;
  const status = res.ok ? "" : `HTTP ${res.status}\n`;
  return status + (text.length > maxChars ? `${text.slice(0, maxChars)}\n... (${text.length - maxChars}자 생략)` : text);
}

// 검색 키를 설정 파일에 넣지 않고, 서버가 시작할 때 다른 프로젝트의 .env에서 필요한 값만 읽는다.
// CKD_ENV_FILE에 .env 경로를 주면 NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, NAVER_SEARCH_BASE_URL, NAVER_SEARCH_PROVIDER, GITHUB_TOKEN만 가져온다.
// 이미 환경변수에 있는 값은 덮어쓰지 않는다. 읽은 키 이름만 돌려주고 값은 어디에도 남기지 않는다.
const SECRET_KEYS = ["NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET", "NAVER_SEARCH_BASE_URL", "NAVER_SEARCH_PROVIDER", "GITHUB_TOKEN"];

export function loadSearchKeys(file: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!file || !fs.existsSync(file)) return [];
  const loaded: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (!m || !SECRET_KEYS.includes(m[1]) || env[m[1]]) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    env[m[1]] = value;
    loaded.push(m[1]);
  }
  return loaded;
}
