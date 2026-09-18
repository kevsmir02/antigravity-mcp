#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import {
  agyAgents,
  agyModels,
  agyVersion,
  runAgy,
  treeDiff,
  treeSnapshot,
  type AgyEvent,
  type FileDiff,
  type RunHandle,
  type RunOutcome,
  type StepUpdate,
} from "./agy.js";

const env = {
  binary: process.env.ANTIGRAVITY_BIN ?? "agy",
  directory: path.resolve(process.env.ANTIGRAVITY_MCP_DIRECTORY ?? process.cwd()),
  defaultModel: process.env.ANTIGRAVITY_MCP_MODEL,
  defaultEffort: process.env.ANTIGRAVITY_MCP_EFFORT,
  defaultAgent: process.env.ANTIGRAVITY_MCP_AGENT,
  defaultMode: process.env.ANTIGRAVITY_MCP_MODE,
  skipPermissions: (process.env.ANTIGRAVITY_MCP_SKIP_PERMISSIONS ?? "1") !== "0",
  sandbox: (process.env.ANTIGRAVITY_MCP_SANDBOX ?? "0") !== "0",
  idleTimeoutMs: Number(process.env.ANTIGRAVITY_MCP_IDLE_TIMEOUT_MS ?? 600_000),
  maxDiffChars: Number(process.env.ANTIGRAVITY_MCP_MAX_DIFF_CHARS ?? 40_000),
  maxReportChars: Number(process.env.ANTIGRAVITY_MCP_MAX_REPORT_CHARS ?? 24_000),
  startupTimeoutMs: Number(process.env.ANTIGRAVITY_MCP_STARTUP_TIMEOUT_MS ?? 60_000),
};

const log = (line: string) => process.stderr.write(line + "\n");

const server = new McpServer({ name: "antigravity-mcp", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
type ProgressSink = { token: string | number; send: (params: { progressToken: string | number; progress: number; message: string }) => Promise<unknown> };

/** One delegated turn: an agy child process that lives in this bridge until it settles, then keeps its result for `wait`. */
interface Run {
  /** agy conversation id; known once the init event arrives. */
  sessionID?: string;
  directory: string;
  startedAt: number;
  timeoutMs: number;
  toolCalls: number;
  toolCounts: Map<string, number>;
  lastActivity: string;
  model?: string;
  labels: { model?: string; effort?: string; agent?: string; mode?: string };
  sink?: ProgressSink;
  handle: RunHandle;
  /** Resolves with the conversation id as soon as agy announces it, or undefined if the run ends first. */
  ready: Promise<string | undefined>;
  done: Promise<ToolResult>;
  result?: ToolResult;
}

const runs = new Map<string, Run>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function truncate(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters; ${hint}]`;
}

function attachProgress(run: Run, extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> }): () => void {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  const sink: ProgressSink = { token, send: (params) => extra.sendNotification({ method: "notifications/progress", params }) };
  run.sink = sink;
  return () => {
    if (run.sink === sink) run.sink = undefined;
  };
}

const elapsedLabel = (run: Run) => `${Math.round((Date.now() - run.startedAt) / 1000)}s`;

function toolSummary(run: Run): string {
  return run.toolCalls
    ? `${run.toolCalls} tool call(s): ` + [...run.toolCounts.entries()].map(([k, v]) => `${k} ${v}`).join(", ")
    : "no tool calls observed";
}

function describeStep(s: StepUpdate): string {
  const p = s.tool_info?.parameters ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = (p as Record<string, unknown>)[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };
  const detail = pick("CommandLine", "command", "Command", "AbsolutePath", "TargetFile", "path", "Query", "query", "Name", "name");
  return `${s.tool_name ?? "tool"}${detail ? `: ${detail}` : ""}`.slice(0, 160);
}

function runningResult(run: Run, sessionID: string): ToolResult {
  const lines = [
    `# antigravity running`,
    `session_id: ${sessionID}`,
    `directory: ${run.directory}`,
    `elapsed: ${elapsedLabel(run)} (hard abort at ${run.timeoutMs / 1000}s)`,
    toolSummary(run),
    run.lastActivity ? `last activity: ${run.lastActivity}` : "",
    ``,
    `Still working. Call wait with this session_id to collect the report and diff, or cancel to stop it.`,
  ].filter((l) => l !== "");
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function usageLine(outcome: RunOutcome): string {
  const u = outcome.result?.usage;
  if (!u) return "usage unavailable";
  return `tokens in ${u.input_tokens ?? 0} / out ${u.output_tokens ?? 0} / thinking ${u.thinking_tokens ?? 0} / cache read ${u.cache_read_tokens ?? 0}`;
}

function formatDiffs(files: FileDiff[], patch: string): { summary: string; patch: string } {
  if (files.length === 0) return { summary: "No files changed.", patch: "" };
  const additions = files.reduce((n, d) => n + d.additions, 0);
  const deletions = files.reduce((n, d) => n + d.deletions, 0);
  const lines = files.map((d) => `- ${d.file} (${d.status}, +${d.additions}/-${d.deletions})`);
  return { summary: `${files.length} file(s), +${additions}/-${deletions}\n${lines.join("\n")}`, patch };
}

async function buildResult(run: Run, outcome: RunOutcome, before: string | undefined, includeDiff: boolean): Promise<ToolResult> {
  const sessionID = outcome.conversationID ?? run.sessionID ?? "unknown";
  const l = run.labels;
  const modelLabel = run.model ?? l.model ?? "agy default";
  const header =
    `# antigravity result\n` +
    `session_id: ${sessionID}\n` +
    `model: ${modelLabel}${l.effort ? ` (effort ${l.effort})` : ""}${l.agent ? ` | agent ${l.agent}` : ""}${l.mode ? ` | mode ${l.mode}` : ""}\n` +
    `directory: ${run.directory}\n` +
    `elapsed: ${elapsedLabel(run)}\n` +
    `${usageLine(outcome)}\n${toolSummary(run)}`;

  const sections = [header];
  let isError = false;
  const resume = `Partial work may be on disk; continue with session_id ${sessionID} or inspect git diff.`;
  switch (outcome.reason) {
    case "timeout":
      isError = true;
      sections.push(`## Timed out\nKilled after ${run.timeoutMs / 1000}s. ${resume}`);
      break;
    case "idle":
      isError = true;
      sections.push(`## Stalled\nNo output from agy for ${env.idleTimeoutMs / 1000}s, so the run was killed. ${resume}`);
      break;
    case "human-input":
      isError = true;
      sections.push(
        `## Waiting for a human\nagy called ${run.lastActivity || "a permission/question tool"} and would have blocked forever, so the run was killed. ` +
          `Rephrase the task to remove the ambiguity, or check ANTIGRAVITY_MCP_SKIP_PERMISSIONS. ${resume}`,
      );
      break;
    case "cancelled":
      sections.push(`## Cancelled\nStopped on request after ${elapsedLabel(run)}. ${resume}`);
      break;
    case "spawn-failed":
      isError = true;
      sections.push(`## agy did not start\n${outcome.stderr.trim() || `could not spawn "${env.binary}"`}`);
      break;
  }
  // A killed agy reports status ERROR "interrupted"; the kill reason above already explains that.
  const status = outcome.reason === "finished" ? outcome.result?.status : undefined;
  if (status && status !== "SUCCESS") {
    isError = true;
    sections.push(`## agy error\nstatus ${status}: ${outcome.result?.error ?? outcome.result?.message ?? outcome.result?.response ?? "(no message)"}`);
  } else if (outcome.reason === "finished" && outcome.exitCode !== 0) {
    isError = true;
    sections.push(`## agy exited with code ${outcome.exitCode}${outcome.signal ? ` (signal ${outcome.signal})` : ""}\n${outcome.stderr.trim().slice(-3000) || "(no stderr)"}`);
  }

  const report = outcome.result?.response?.trim() ?? "";
  sections.push(`## Report\n${report ? truncate(report, env.maxReportChars, `read the full transcript with: agy --conversation ${sessionID}`) : "(agy returned no text)"}`);

  if (includeDiff) {
    if (before) {
      const after = await treeSnapshot(run.directory).catch(() => undefined);
      const { files, patch } = after ? await treeDiff(run.directory, before, after).catch(() => ({ files: [], patch: "" })) : { files: [], patch: "" };
      const d = formatDiffs(files, patch);
      sections.push(`## Changed files\n${d.summary}`);
      if (d.patch) sections.push(`## Diff\n\`\`\`diff\n${truncate(d.patch, env.maxDiffChars, "run git diff for the rest")}\n\`\`\``);
    } else {
      sections.push(`## Changed files\n(not a git repository; run your own diff)`);
    }
  }
  if (outcome.unparsed) sections.push(`## Note\nagy printed a line the bridge could not parse: ${outcome.unparsed}`);

  return { content: [{ type: "text", text: sections.join("\n\n") }], isError };
}

function startRun(params: {
  directory: string;
  task: string;
  conversationID?: string;
  timeoutMs: number;
  includeDiff: boolean;
  model?: string;
  effort?: string;
  agent?: string;
  mode?: string;
}): Run {
  let lastProgressAt = 0;
  let announce: (id: string | undefined) => void = () => undefined;
  const ready = new Promise<string | undefined>((r) => (announce = r));

  const run = {
    sessionID: params.conversationID,
    directory: params.directory,
    startedAt: Date.now(),
    timeoutMs: params.timeoutMs,
    toolCalls: 0,
    toolCounts: new Map<string, number>(),
    lastActivity: "",
    labels: { model: params.model, effort: params.effort, agent: params.agent, mode: params.mode },
    ready,
  } as Run;

  const notify = (message: string) => {
    run.lastActivity = message;
    const sink = run.sink;
    if (!sink) return;
    const now = Date.now();
    if (now - lastProgressAt < 1000) return;
    lastProgressAt = now;
    sink.send({ progressToken: sink.token, progress: run.toolCalls, message }).catch(() => {
      // caller went away; the result stays in the registry for the next wait
    });
  };

  const onEvent = (ev: AgyEvent) => {
    if (ev.event === "init") {
      const e = ev as { conversation_id: string; init?: { model?: string } };
      if (e.init?.model) run.model = e.init.model;
      if (e.conversation_id && !run.sessionID) {
        run.sessionID = e.conversation_id;
        runs.set(e.conversation_id, run);
      }
      announce(run.sessionID);
      return;
    }
    if (ev.event !== "step_update") return;
    const s = (ev as { step_update: StepUpdate }).step_update;
    if (s.step_type !== "tool") return;
    if (s.state === "ACTIVE") {
      run.toolCalls++;
      const tool = s.tool_name ?? "tool";
      run.toolCounts.set(tool, (run.toolCounts.get(tool) ?? 0) + 1);
    }
    notify(describeStep(s));
  };

  run.done = (async () => {
    const before = params.includeDiff ? await treeSnapshot(params.directory).catch(() => undefined) : undefined;
    run.handle = runAgy({
      binary: env.binary,
      cwd: params.directory,
      task: params.task,
      conversationID: params.conversationID,
      model: params.model,
      effort: params.effort,
      agent: params.agent,
      mode: params.mode,
      skipPermissions: env.skipPermissions,
      sandbox: env.sandbox,
      timeoutMs: params.timeoutMs,
      idleTimeoutMs: env.idleTimeoutMs,
      onEvent,
      log,
    });
    const outcome = await run.handle.done;
    announce(run.sessionID ?? outcome.conversationID);
    const result = await buildResult(run, outcome, before, params.includeDiff).catch((err) => ({
      content: [{ type: "text" as const, text: `# antigravity result unavailable\nsession_id: ${run.sessionID ?? "unknown"}\n\n${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }));
    run.result = result;
    return result;
  })();

  if (run.sessionID) runs.set(run.sessionID, run);
  return run;
}

/** Resolves with the result if the run settles within waitMs, else undefined. */
async function awaitRun(run: Run, waitMs: number): Promise<ToolResult | undefined> {
  if (run.result) return run.result;
  if (waitMs <= 0) return undefined;
  return Promise.race([run.done, sleep(waitMs).then(() => undefined)]);
}

function checkSessionID(sessionID: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionID)) {
    throw new Error(`session_id must be an agy conversation id (UUID), got "${sessionID}"`);
  }
}

const waitSecondsSchema = z.number().int().min(0).max(600).optional();

server.registerTool(
  "delegate",
  {
    title: "Delegate a task to Antigravity",
    description: [
      "Start a task in a Google Antigravity CLI (agy) conversation on a model you choose. Returns the report and diff if it finishes",
      "within wait_seconds, otherwise a running status with the session_id; the task keeps going and you collect it later with wait.",
      "Use it for heavy lifting: codebase exploration, implementation, debugging, test writing. Review the result yourself before trusting it.",
      "",
      "Big tasks: leave wait_seconds at the default, do other work, then call wait as often as needed. timeout_seconds is only the hard abort.",
      "Follow-ups: pass session_id from a previous result to continue that conversation with its full context.",
      "Exploration: mode=\"plan\" keeps agy read-only. Implementation: mode=\"accept-edits\" (default).",
      "Model: a slug from list_models, e.g. \"gemini-3.1-pro-high\". effort sets reasoning effort (low, medium, high).",
    ].join("\n"),
    inputSchema: {
      task: z.string().min(1).describe("Full task description. Include goal, constraints, acceptance criteria, and ask for a final report."),
      model: z.string().optional().describe('Model slug from list_models, e.g. "gemini-3.1-pro-high". Defaults to ANTIGRAVITY_MCP_MODEL or agy\'s configured model.'),
      effort: z.enum(["low", "medium", "high"]).optional().describe("Reasoning effort for this run."),
      agent: z.string().optional().describe("Custom agy agent name. See list_agents."),
      mode: z.enum(["accept-edits", "plan"]).optional().describe('"plan" is read-only exploration; "accept-edits" lets agy change files (default).'),
      session_id: z.string().optional().describe("Continue an existing agy conversation instead of starting a new one."),
      directory: z.string().optional().describe("Project directory agy works in. Defaults to the MCP server's working directory."),
      wait_seconds: waitSecondsSchema.describe("How long this call waits for the task before returning a running status. Default 120, max 600. 0 returns immediately."),
      timeout_seconds: z.number().int().positive().max(7200).optional().describe("Hard abort for the agy process, independent of wait_seconds. Default 1800."),
      include_diff: z.boolean().optional().describe("Include the unified diff of files agy changed (git repositories only). Default true."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args, extra) => {
    const directory = args.directory ? path.resolve(args.directory) : env.directory;
    const timeoutMs = (args.timeout_seconds ?? 1800) * 1000;
    const waitMs = (args.wait_seconds ?? 120) * 1000;

    if (args.session_id) {
      checkSessionID(args.session_id);
      const active = runs.get(args.session_id);
      if (active && !active.result) throw new Error(`session ${args.session_id} is still running its previous task; call wait first`);
    }

    const run = startRun({
      directory,
      task: args.task,
      conversationID: args.session_id,
      timeoutMs,
      includeDiff: args.include_diff ?? true,
      model: args.model ?? env.defaultModel,
      effort: args.effort ?? env.defaultEffort,
      agent: args.agent ?? env.defaultAgent,
      mode: args.mode ?? env.defaultMode,
    });
    const detach = attachProgress(run, extra);
    try {
      // The conversation id only exists once agy has started; a running status without it would be useless.
      const sessionID = await Promise.race([run.ready, sleep(env.startupTimeoutMs).then(() => undefined)]);
      const settled = await awaitRun(run, waitMs);
      if (settled) return settled;
      if (!sessionID) {
        run.handle?.cancel();
        return run.done;
      }
      return runningResult(run, sessionID);
    } finally {
      detach();
    }
  },
);

server.registerTool(
  "wait",
  {
    title: "Wait for a delegated task",
    description: [
      "Collect the result of a delegate call that returned a running status. Waits up to wait_seconds for the task to finish,",
      "then returns its report and diff, or another running status if it is still going. Call it as many times as needed.",
    ].join("\n"),
    inputSchema: {
      session_id: z.string().describe("The session_id from delegate."),
      wait_seconds: waitSecondsSchema.describe("How long to wait before returning a running status. Default 120, max 600. 0 checks without waiting."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args, extra) => {
    checkSessionID(args.session_id);
    const run = runs.get(args.session_id);
    if (!run) {
      return {
        content: [{ type: "text", text:
          `# antigravity unknown session\nsession_id: ${args.session_id}\n\n` +
          `This bridge process never started that run (the bridge restarted, or it belongs to another process), and agy has no server to ask. ` +
          `The conversation itself persists in agy: continue it with delegate and this session_id, or read it with: agy --conversation ${args.session_id}` }],
        isError: true,
      };
    }
    const waitMs = (args.wait_seconds ?? 120) * 1000;
    const detach = attachProgress(run, extra);
    try {
      return (await awaitRun(run, waitMs)) ?? runningResult(run, args.session_id);
    } finally {
      detach();
    }
  },
);

server.registerTool(
  "cancel",
  {
    title: "Cancel a delegated task",
    description: "Kill a running agy process. Work already written to disk stays; the conversation can be continued later with delegate.",
    inputSchema: { session_id: z.string().describe("The session_id from delegate.") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async (args) => {
    checkSessionID(args.session_id);
    const run = runs.get(args.session_id);
    if (!run) return { content: [{ type: "text", text: `Session ${args.session_id} is not running in this bridge process.` }], isError: true };
    if (run.result) return { content: [{ type: "text", text: `Session ${args.session_id} already finished; call wait to read its result.` }] };
    run.handle?.cancel();
    return { content: [{ type: "text", text: `Kill sent to ${args.session_id} after ${elapsedLabel(run)}. Call wait to collect what it produced so far.` }] };
  },
);

server.registerTool(
  "list_models",
  {
    title: "List Antigravity models",
    description: "List the models agy can use here, as slugs for delegate's model parameter.",
    inputSchema: { directory: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const directory = args.directory ? path.resolve(args.directory) : env.directory;
    const models = await agyModels(env.binary, directory);
    const lines = models.map((m) => `- ${m.id} (${m.name})`);
    if (env.defaultModel) lines.push(`\nBridge default: ${env.defaultModel}`);
    return { content: [{ type: "text", text: lines.join("\n") || "agy listed no models." }] };
  },
);

server.registerTool(
  "list_agents",
  {
    title: "List Antigravity agents",
    description: "List custom agy agents for delegate's agent parameter. Modes (plan, accept-edits) are always available through the mode parameter.",
    inputSchema: { directory: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const directory = args.directory ? path.resolve(args.directory) : env.directory;
    const out = await agyAgents(env.binary, directory);
    return { content: [{ type: "text", text: out || "No custom agents defined. Use mode=\"plan\" for read-only work and mode=\"accept-edits\" for changes." }] };
  },
);

server.registerTool(
  "bridge_info",
  {
    title: "antigravity-mcp info",
    description: "Show the agy binary this bridge runs, its defaults, and the runs it currently holds.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const version = await agyVersion(env.binary).catch((err) => `unavailable (${err instanceof Error ? err.message : String(err)})`);
    const held = [...runs.values()].map((r) => `- ${r.sessionID} ${r.result ? "finished" : `running ${elapsedLabel(r)}`}`);
    const text = [
      `binary: ${env.binary} (version ${version})`,
      `directory: ${env.directory}`,
      `default model: ${env.defaultModel ?? "agy default"}`,
      `default effort: ${env.defaultEffort ?? "agy default"}`,
      `default mode: ${env.defaultMode ?? "agy default"}`,
      `skip permissions: ${env.skipPermissions}`,
      `sandbox: ${env.sandbox}`,
      `idle timeout: ${env.idleTimeoutMs / 1000}s`,
      ``,
      held.length ? `Runs in this process:\n${held.join("\n")}` : "No runs in this process.",
      ``,
      `Read a conversation later: agy --conversation <session_id>`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  const shutdown = () => {
    for (const run of runs.values()) if (!run.result) run.handle?.cancel();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(transport);
}

main().catch((err) => {
  log(`antigravity-mcp failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
