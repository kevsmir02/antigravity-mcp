import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

export type Json = Record<string, unknown>;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface StepUpdate {
  conversation_id: string;
  step_index: number;
  state: "ACTIVE" | "DONE" | string;
  step_type: "user_input" | "tool" | "agent_response" | string;
  tool_name?: string;
  tool_info?: { name?: string; parameters?: Json };
  text_delta?: string;
  duration_seconds?: number;
  usage?: Usage;
}

export interface AgyResult {
  conversation_id: string;
  status: "SUCCESS" | string;
  response?: string;
  error?: string;
  message?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: Usage;
}

export type AgyEvent =
  | { event: "init"; conversation_id: string; init?: { cwd?: string; tools?: string[]; model?: string } }
  | { event: "step_update"; step_update: StepUpdate }
  | { event: "result"; result: AgyResult }
  | { event: string; [key: string]: unknown };

/** Tools that block on a human answer. Nobody is on this side of the bridge, so an ACTIVE one means the run is stuck. */
export const HUMAN_TOOLS = new Set(["ask_permission", "ask_custom_permission", "ask_question"]);

export interface RunOptions {
  binary: string;
  cwd: string;
  task: string;
  conversationID?: string;
  model?: string;
  effort?: string;
  agent?: string;
  mode?: string;
  skipPermissions: boolean;
  sandbox: boolean;
  /** Hard ceiling passed to agy and enforced here with a kill. */
  timeoutMs: number;
  /** Kill the run if no event arrives for this long. */
  idleTimeoutMs: number;
  onEvent: (event: AgyEvent) => void;
  log: (line: string) => void;
}

export type EndReason = "finished" | "timeout" | "idle" | "human-input" | "cancelled" | "spawn-failed";

export interface RunOutcome {
  reason: EndReason;
  conversationID?: string;
  result?: AgyResult;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Last raw line that failed to parse, if any, for diagnostics. */
  unparsed?: string;
}

export interface RunHandle {
  pid?: number;
  done: Promise<RunOutcome>;
  cancel: () => void;
}

export function buildArgs(o: Omit<RunOptions, "onEvent" | "log" | "binary" | "idleTimeoutMs">): string[] {
  // Without --add-dir, a cwd outside agy's trustedWorkspaces is treated as foreign and agy works in its own scratch folder.
  const args = ["--print", o.task, "--output-format", "stream-json", "--print-timeout", `${Math.ceil(o.timeoutMs / 1000)}s`, "--add-dir", o.cwd];
  if (o.conversationID) args.push("--conversation", o.conversationID);
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.agent) args.push("--agent", o.agent);
  if (o.mode) args.push("--mode", o.mode);
  if (o.skipPermissions) args.push("--dangerously-skip-permissions");
  if (o.sandbox) args.push("--sandbox");
  return args;
}

/**
 * Spawns one headless agy turn in its own process group. stdin is closed so the MCP transport
 * is never inherited, and every kill targets the group so agy's children never outlive the run.
 */
export function runAgy(o: RunOptions): RunHandle {
  const args = buildArgs(o);
  let child: ChildProcess;
  try {
    child = spawn(o.binary, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: process.env });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { done: Promise.resolve({ reason: "spawn-failed", exitCode: null, signal: null, stderr: msg }), cancel: () => undefined };
  }

  let reason: EndReason | undefined;
  let conversationID: string | undefined = o.conversationID;
  let result: AgyResult | undefined;
  let unparsed: string | undefined;
  let stderr = "";
  let killTimer: NodeJS.Timeout | undefined;

  const killGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  const stop = (why: EndReason) => {
    if (reason) return;
    reason = why;
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
    killTimer.unref();
  };

  const hardTimer = setTimeout(() => stop("timeout"), o.timeoutMs);
  let idleTimer = setTimeout(() => stop("idle"), o.idleTimeoutMs);
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop("idle"), o.idleTimeoutMs);
  };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    touch();
    let ev: AgyEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      unparsed = line.slice(0, 500);
      return;
    }
    if (ev.event === "init" && typeof (ev as any).conversation_id === "string") conversationID = (ev as any).conversation_id;
    if (ev.event === "step_update") {
      const s = (ev as { step_update: StepUpdate }).step_update;
      if (s.conversation_id) conversationID = s.conversation_id;
      if (s.step_type === "tool" && s.state === "ACTIVE" && s.tool_name && HUMAN_TOOLS.has(s.tool_name)) {
        o.onEvent(ev);
        stop("human-input");
        return;
      }
    }
    if (ev.event === "result") {
      result = (ev as { result: AgyResult }).result;
      if (result.conversation_id) conversationID = result.conversation_id;
    }
    o.onEvent(ev);
  };

  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8000);
  });

  const done = new Promise<RunOutcome>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (buffer.trim()) handleLine(buffer);
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ reason: reason ?? "finished", conversationID, result, exitCode, signal, stderr, unparsed });
    };
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      reason ??= "spawn-failed";
      finish(null, null);
    });
    child.on("close", finish);
  });

  return { pid: child.pid, done, cancel: () => stop("cancelled") };
}

/** Snapshot of the working tree (tracked + untracked, minus ignored) as a git tree hash, without touching the real index. */
export async function treeSnapshot(cwd: string): Promise<string | undefined> {
  const top = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd }).then((r) => r.stdout.trim()).catch(() => undefined);
  if (!top) return undefined;
  const indexFile = path.join(os.tmpdir(), `antigravity-mcp-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await execFileP("git", ["read-tree", "HEAD"], { cwd: top, env }).catch(() => undefined); // no HEAD in an empty repo
    await execFileP("git", ["add", "-A", "."], { cwd: top, env, maxBuffer: 64 * 1024 * 1024 });
    const { stdout } = await execFileP("git", ["write-tree"], { cwd: top, env });
    return stdout.trim();
  } finally {
    fs.rm(indexFile, { force: true }, () => undefined);
  }
}

export interface FileDiff {
  file: string;
  additions: number;
  deletions: number;
  status: string;
}

export async function treeDiff(cwd: string, before: string, after: string): Promise<{ files: FileDiff[]; patch: string }> {
  if (before === after) return { files: [], patch: "" };
  const opts = { cwd, maxBuffer: 64 * 1024 * 1024 };
  const [numstat, status, patch] = await Promise.all([
    execFileP("git", ["diff", "--numstat", before, after], opts).then((r) => r.stdout),
    execFileP("git", ["diff", "--name-status", before, after], opts).then((r) => r.stdout),
    execFileP("git", ["diff", before, after], opts).then((r) => r.stdout),
  ]);
  const statusByFile = new Map<string, string>();
  for (const line of status.split("\n")) {
    const [code, ...rest] = line.split("\t");
    if (!code || rest.length === 0) continue;
    const name = rest[rest.length - 1];
    statusByFile.set(name, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : code.startsWith("R") ? "renamed" : "modified");
  }
  const files: FileDiff[] = [];
  for (const line of numstat.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    if (!a || rest.length === 0) continue;
    const file = rest[rest.length - 1];
    files.push({ file, additions: a === "-" ? 0 : Number(a), deletions: d === "-" ? 0 : Number(d), status: statusByFile.get(file) ?? "modified" });
  }
  return { files, patch };
}

export async function agyVersion(binary: string): Promise<string> {
  const { stdout } = await execFileP(binary, ["--version"]);
  return stdout.trim();
}

export async function agyModels(binary: string, cwd: string): Promise<{ id: string; name: string }[]> {
  const { stdout } = await execFileP(binary, ["models"], { cwd });
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l.includes("\t"))
    .map((l) => {
      const [id, ...name] = l.split("\t");
      return { id: id.trim(), name: name.join(" ").trim() };
    });
}

export async function agyAgents(binary: string, cwd: string): Promise<string> {
  const { stdout } = await execFileP(binary, ["agents"], { cwd });
  return stdout.trim();
}
