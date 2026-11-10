#!/usr/bin/env node
// Windows 네이티브 실행 파일(Herdr-CKD.exe) 및 배치 런처(Herdr-CKD.bat) 생성 스크립트
// 별도 무거운 외부 패키저 없이 Windows 기본 내장 .NET Framework csc.exe로 경량 GUI 런처를 컴파일한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const outExe = path.join(projectRoot, "Herdr-CKD.exe");
const outBat = path.join(projectRoot, "Herdr-CKD.bat");

function findCscExe() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework64", "v3.5", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v3.5", "csc.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Windows .NET Framework csc.exe 컴파일러를 찾을 수 없습니다.");
}

const csharpSource = `using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace HerdrCkdLauncher
{
    internal static class Program
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        private const int ATTACH_PARENT_PROCESS = -1;
        private const int STD_OUTPUT_HANDLE = -11;

        private static string ResolveNodeExe()
        {
            string envNode = Environment.GetEnvironmentVariable("NODE_EXE");
            if (!string.IsNullOrEmpty(envNode) && File.Exists(envNode))
            {
                return envNode;
            }
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pfNode = Path.Combine(pf, "nodejs", "node.exe");
            if (File.Exists(pfNode))
            {
                return pfNode;
            }
            string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string fnmOrLocalNode = Path.Combine(localApp, "Programs", "nodejs", "node.exe");
            if (File.Exists(fnmOrLocalNode))
            {
                return fnmOrLocalNode;
            }
            return "node";
        }

        private static string QuoteArg(string arg)
        {
            if (string.IsNullOrEmpty(arg)) return "\\"\\"";
            if (arg.IndexOf(' ') < 0 && arg.IndexOf('"') < 0) return arg;
            return "\\"" + arg.Replace("\\"", "\\\\\\"") + "\\"";
        }

        [STAThread]
        private static int Main(string[] args)
        {
            string appRoot = AppDomain.CurrentDomain.BaseDirectory;
            if (appRoot.EndsWith("\\\\") || appRoot.EndsWith("/"))
            {
                appRoot = appRoot.Substring(0, appRoot.Length - 1);
            }

            bool verifyOnly = Environment.GetEnvironmentVariable("HERDR_VERIFY_ONLY") == "1";
            StringBuilder passArgs = new StringBuilder();
            string scriptRel = Path.Combine("dist", "src", "ui-server.js");
            string scriptAbs = Path.Combine(appRoot, scriptRel);

            passArgs.Append(QuoteArg(scriptAbs));
            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--verify-only") verifyOnly = true;
                    passArgs.Append(" ");
                    passArgs.Append(QuoteArg(args[i]));
                }
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = ResolveNodeExe();
            psi.Arguments = passArgs.ToString();
            psi.WorkingDirectory = appRoot;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.EnvironmentVariables["HERDR_APP_ROOT"] = appRoot;

            if (verifyOnly)
            {
                IntPtr stdOut = GetStdHandle(STD_OUTPUT_HANDLE);
                if (stdOut == IntPtr.Zero)
                {
                    AttachConsole(ATTACH_PARENT_PROCESS);
                }

                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;

                using (Process proc = Process.Start(psi))
                {
                    if (proc == null) return 1;
                    string stdout = proc.StandardOutput.ReadToEnd();
                    string stderr = proc.StandardError.ReadToEnd();
                    proc.WaitForExit(20000);

                    try
                    {
                        Console.OutputEncoding = Encoding.UTF8;
                    }
                    catch
                    {
                    }

                    if (!string.IsNullOrEmpty(stdout))
                    {
                        Console.Out.Write(stdout);
                        Console.Out.Flush();
                    }
                    if (!string.IsNullOrEmpty(stderr))
                    {
                        Console.Error.Write(stderr);
                        Console.Error.Flush();
                    }

                    string outFile = Environment.GetEnvironmentVariable("HERDR_VERIFY_OUT_FILE");
                    if (!string.IsNullOrEmpty(outFile))
                    {
                        File.WriteAllText(outFile, stdout + stderr, Encoding.UTF8);
                    }

                    return proc.HasExited ? proc.ExitCode : 0;
                }
            }

            Process.Start(psi);
            return 0;
        }
    }
}
`;

const batContent = [
  "@echo off",
  "setlocal",
  'cd /d "%~dp0"',
  'set "HERDR_APP_ROOT=%~dp0"',
  'if not exist "dist\\src\\ui-server.js" (',
  "  echo [Herdr CKD] Building TypeScript sources...",
  "  call npm run build",
  ")",
  'if "%~1"=="--verify-only" (',
  '  node "dist\\src\\ui-server.js" %*',
  "  exit /b %ERRORLEVEL%",
  ")",
  'start "" /b node "dist\\src\\ui-server.js" %*',
  "",
].join("\r\n");

function buildWindowsArtifacts() {
  fs.writeFileSync(outBat, batContent, "utf8");
  console.log(`[Herdr CKD] 배치 런처 생성 완료: ${outBat}`);

  if (process.platform !== "win32") {
    console.log("[Herdr CKD] Windows 환경이 아니므로 csc.exe 컴파일을 건너뜁니다.");
    return;
  }

  const csc = findCscExe();
  const icoPath = path.join(projectRoot, "assets", "herdr-ckd.ico");
  if (!fs.existsSync(icoPath)) {
    execFileSync(process.execPath, [path.join(__dirname, "generate-icon.mjs")], { stdio: "inherit" });
  }

  const tempCs = path.join(os.tmpdir(), `HerdrCkdLauncher_${process.pid}.cs`);
  fs.writeFileSync(tempCs, csharpSource, "utf8");

  try {
    const cscArgs = ["/nologo", "/target:winexe", "/optimize+"];
    if (fs.existsSync(icoPath)) {
      cscArgs.push(`/win32icon:${icoPath}`);
    }
    cscArgs.push(`/out:${outExe}`, tempCs);
    execFileSync(csc, cscArgs, { stdio: "inherit" });
    console.log(`[Herdr CKD] Windows 네이티브 실행 파일(전용 아이콘 포함) 생성 완료: ${outExe}`);
    try {
      execFileSync("ie4uinit.exe", ["-show"], { stdio: "ignore" });
    } catch {
      // ignore
    }
  } finally {
    try {
      fs.unlinkSync(tempCs);
    } catch {
      // ignore
    }
  }
}

buildWindowsArtifacts();
