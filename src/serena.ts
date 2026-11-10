// Serena MCP 서버를 작업마다 띄워 A·B에게 심볼 단위 코드 도구를 준다.
// A는 검색과 수정 도구, B는 검색 도구만 받는다.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CkdConfig, Role } from "./config.js";
import type { ToolSpec } from "./llm.js";

export const PREFIX = "serena_";

const READ_TOOLS = [
  "find_declaration",
  "find_file",
  "find_implementations",
  "find_referencing_symbols",
  "find_symbol",
  "get_diagnostics_for_file",
  "get_symbols_overview",
  "search_for_pattern",
];

const EDIT_TOOLS = [
  "insert_after_symbol",
  "insert_before_symbol",
  "rename_symbol",
  "replace_content",
  "replace_symbol_body",
  "safe_delete_symbol",
];

export function allowedFor(role: Role): string[] {
  if (role === "A") return [...READ_TOOLS, ...EDIT_TOOLS];
  if (role === "B") return READ_TOOLS;
  return [];
}

export interface ExternalTools {
  specs(role: Role): ToolSpec[];
  call(role: Role, name: string, rawArgs: string): Promise<string>;
  close(): Promise<void>;
}

export async function startSerena(config: CkdConfig, workspace: string): Promise<ExternalTools> {
  const transport = new StdioClientTransport({
    command: config.tools.serenaCommand,
    args: [
      ...config.tools.serenaArgs,
      "--project", workspace,
      "--context", "oaicompat-agent",
      "--agent-interface", "tools",
      "--enable-web-dashboard", "false",
      "--open-web-dashboard", "false",
    ],
    stderr: "ignore",
  });
  const client = new Client({ name: "ckd", version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const available = new Map(tools.map((t) => [t.name, t]));

  return {
    specs(role) {
      return allowedFor(role)
        .filter((name) => available.has(name))
        .map((name) => {
          const t = available.get(name)!;
          return {
            type: "function" as const,
            function: {
              name: PREFIX + name,
              description: `[Serena] ${t.description ?? name}`,
              parameters: t.inputSchema as Record<string, unknown>,
            },
          };
        });
    },
    async call(role, name, rawArgs) {
      const tool = name.slice(PREFIX.length);
      if (!allowedFor(role).includes(tool) || !available.has(tool)) {
        return `${role}에게 허용되지 않은 Serena 도구입니다: ${tool}`;
      }
      const args = rawArgs ? JSON.parse(rawArgs) : {};
      const result = await client.callTool({ name: tool, arguments: args });
      const content = (result.content as { type: string; text?: string }[]) ?? [];
      const text = content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      return result.isError ? `Serena 오류: ${text}` : text;
    },
    async close() {
      await client.close();
    },
  };
}
