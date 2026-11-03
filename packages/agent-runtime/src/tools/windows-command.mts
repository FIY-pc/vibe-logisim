import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A job owns the shell and its descendants, including detached children. The
// non-inheritable handle lives until PowerShell exits; closing it kills the job.
// This manages lifetime and memory, not filesystem permissions.
const bootstrap = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
if (-not [IO.File]::Exists($env:VIBE_COMMAND_JOB_ASSEMBLY)) {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class VibeCommandJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    static IntPtr job;
    public static void Start() {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        // KILL_ON_JOB_CLOSE | JOB_MEMORY | ACTIVE_PROCESS, same resource limits
        // as the Linux command runner. No time limit is imposed by the job.
        limits.Basic.Flags = 0x2000 | 0x200 | 0x8;
        limits.Basic.ActiveProcesses = 512;
        limits.JobMemory = new UIntPtr(6442450944UL);
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
            throw new Win32Exception();
    }
}
'@ -OutputAssembly (Join-Path $env:TEMP 'job.dll')
try {
    [IO.File]::Move((Join-Path $env:TEMP 'job.dll'), $env:VIBE_COMMAND_JOB_ASSEMBLY)
} catch [IO.IOException] {
    # Another concurrent command may have finished compiling first. A rename
    # publishes a complete assembly, never a partly written one.
    if (-not [IO.File]::Exists($env:VIBE_COMMAND_JOB_ASSEMBLY)) { throw }
}
}
Add-Type -Path $env:VIBE_COMMAND_JOB_ASSEMBLY
[VibeCommandJob]::Start()
Set-Location -LiteralPath $env:VIBE_PROJECT_ROOT
[Environment]::CurrentDirectory = $env:VIBE_PROJECT_ROOT
$global:LASTEXITCODE = 0
`;

const ordinaryPath = (value: string) =>
  value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");

// Compile the fixed interop type once per sidecar, not on every model tool call.
// The private cache contains only this assembly; each command still gets a new
// PowerShell process, environment and job. No project state is kept here.
let jobAssembly: Promise<string> | undefined;
function cachedJobAssembly() {
  return (jobAssembly ??= mkdtemp(
    path.join(tmpdir(), "vibe-command-runtime-"),
  ).then((directory) => {
    process.once("exit", () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {}
    });
    return path.join(directory, "job.dll");
  }));
}

/** Only OS necessities and the product's interpreters enter the shell. */
function environment(
  root: string,
  temporary: string,
  referenceRoot: string,
  runtimeRoot?: string | null,
) {
  // Rust's canonical paths may have an extended-length prefix. PATH lookup
  // and Windows PowerShell's providers expect ordinary drive/UNC spellings.
  referenceRoot = ordinaryPath(referenceRoot);
  if (runtimeRoot) runtimeRoot = ordinaryPath(runtimeRoot);
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const system32 = path.join(systemRoot, "System32");
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: path.join(system32, "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: [
      path.dirname(process.execPath),
      ...(runtimeRoot ? [path.join(runtimeRoot, "java", "bin")] : []),
      system32,
      path.join(system32, "WindowsPowerShell", "v1.0"),
      systemRoot,
      // Prefer product interpreters; also allow tools the user already installed.
      ...(process.env.PATH ? [process.env.PATH] : []),
    ].join(path.delimiter),
    TEMP: temporary,
    TMP: temporary,
    VIBE_PROJECT_ROOT: ordinaryPath(root),
    VIBE_CIRCUIT_REFERENCE: referenceRoot,
    ...(runtimeRoot ? { VIBE_RUNTIME: runtimeRoot } : {}),
  };
}

export async function windowsCommand(
  commandText: string,
  options: {
    root: string;
    referenceRoot: string;
    runtimeRoot?: string | null;
    signal?: AbortSignal;
    timeout: number;
  },
): Promise<AgentToolResult<any>> {
  const { root, referenceRoot, runtimeRoot, signal, timeout } = options;
  signal?.throwIfAborted();
  const temporary = await mkdtemp(path.join(tmpdir(), "vibe-command-"));
  try {
    // -File avoids Windows' command-line length limit and quoting rules. A BOM
    // is required for non-ASCII scripts in the built-in Windows PowerShell 5.1.
    const script = path.join(temporary, "command.ps1");
    await writeFile(
      script,
      "\ufeff" +
        bootstrap +
        "\n& {\n" +
        commandText +
        "\n}\n$vibeCommandSucceeded = $?\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\nif (-not $vibeCommandSucceeded) { exit 1 }\nexit 0\n",
      "utf8",
    );
    signal?.throwIfAborted();
    const env = environment(root, temporary, referenceRoot, runtimeRoot);
    const commandEnv = {
      ...env,
      VIBE_COMMAND_JOB_ASSEMBLY: await cachedJobAssembly(),
    };
    signal?.throwIfAborted();
    const system32 = path.join(env.SystemRoot, "System32");
    return await new Promise<AgentToolResult<any>>((resolve, reject) => {
      const child = spawn(
        path.join(system32, "WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
        ],
        {
          cwd: root,
          env: commandEnv,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "",
        truncated = false,
        stopped = false;
      let stopTimer: ReturnType<typeof setInterval> | undefined;
      const append = (text: string) => {
        truncated ||= output.length + text.length > 64000;
        output = (output + text).slice(-64000);
      };
      child.stdout.setEncoding("utf8").on("data", append);
      child.stderr.setEncoding("utf8").on("data", append);
      const kill = () => {
        if (child.pid)
          execFile(
            path.join(system32, "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true },
            () => {},
          );
      };
      const stop = () => {
        stopped = true;
        kill();
        stopTimer ||= setInterval(kill, 100);
      };
      const timer = timeout > 0 ? setTimeout(stop, timeout * 1000) : undefined;
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(stopTimer);
        signal?.removeEventListener("abort", stop);
      };
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code) => {
        cleanup();
        if (stopped) reject(new Error("命令已停止或超时"));
        else
          resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify({ exitCode: code, output, truncated }),
              },
            ],
            details: null,
          });
      });
    });
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
