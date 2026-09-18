# antigravity-mcp

An MCP server that lets Claude Code delegate work to Google Antigravity CLI (`agy`).

Claude stays the orchestrator: it plans, reviews and decides. Antigravity does the heavy lifting on a model you name per call, such as `gemini-3.1-pro-high`, then reports back with its summary and the diff it produced.

The bridge runs the stock `agy` binary in headless mode as a child process. Your Antigravity login, settings, skills, MCP servers and trusted workspaces all apply inside the delegated conversation. The bridge never reads Antigravity's credentials and never calls Google's backend itself, which is the boundary Google staff have drawn for permitted orchestration.

## Requirements

- Node 20 or newer
- [Antigravity CLI](https://antigravity.google/docs/cli) installed as `agy` and logged in
- git, for per-run diffs (optional; without it the result skips the diff)

## Install

```sh
git clone <this repo> ~/Projects/PERSONAL/antigravity-mcp
cd ~/Projects/PERSONAL/antigravity-mcp
npm install
npm run build
```

Register it with Claude Code once, for every project:

```sh
claude mcp add --scope user antigravity \
  --env ANTIGRAVITY_MCP_MODEL=gemini-3.1-pro-high \
  -- node /home/loba/Projects/PERSONAL/antigravity-mcp/dist/index.js
```

Or per project, in `.mcp.json`:

```json
{
  "mcpServers": {
    "antigravity": {
      "command": "node",
      "args": ["/home/loba/Projects/PERSONAL/antigravity-mcp/dist/index.js"],
      "env": { "ANTIGRAVITY_MCP_MODEL": "gemini-3.1-pro-high" }
    }
  }
}
```

Restart Claude Code and check `/mcp` shows `antigravity` connected.

## Use

In a Claude Code session:

```
Delegate the implementation to Antigravity on gemini-3.1-pro at high effort.
```

Claude calls the `delegate` tool. The result contains the session id (an agy conversation id), model, token usage, the report Antigravity wrote, the list of changed files and the unified diff. To send review findings back with full context:

```
Send those three review comments back to the same Antigravity conversation.
```

Claude passes the `session_id` from the earlier result. Read any conversation afterwards from a terminal:

```sh
agy --conversation <session_id>
```

## Tools

| Tool | Purpose |
| --- | --- |
| `delegate` | Start a task in an agy conversation. Returns the report and diff if it finishes within `wait_seconds` (default 120), otherwise a running status with the `session_id`. Parameters: `task`, `model`, `effort`, `agent`, `mode`, `session_id`, `directory`, `wait_seconds`, `timeout_seconds`, `include_diff`. |
| `wait` | Collect a running task: waits up to `wait_seconds` and returns the report and diff, or another running status. Repeat as needed. |
| `cancel` | Kill a running agy process. Work already on disk stays. |
| `list_models` | Model slugs agy can use here. |
| `list_agents` | Custom agy agents. `mode="plan"` is read-only exploration, `mode="accept-edits"` may edit. |
| `bridge_info` | The agy binary, bridge defaults, and the runs this process holds. |

## Configuration

All optional, set through the MCP server's `env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTIGRAVITY_MCP_MODEL` | agy's configured model | Model slug used when a call gives none. |
| `ANTIGRAVITY_MCP_EFFORT` | none | Default reasoning effort: `low`, `medium`, `high`. |
| `ANTIGRAVITY_MCP_MODE` | agy's configured mode | Default mode: `accept-edits` or `plan`. |
| `ANTIGRAVITY_MCP_AGENT` | none | Default custom agent. |
| `ANTIGRAVITY_MCP_DIRECTORY` | server's working directory | Project directory agy works in. |
| `ANTIGRAVITY_MCP_SKIP_PERMISSIONS` | `1` | Pass `--dangerously-skip-permissions` so headless runs never wait on a prompt. Set `0` to rely on agy's own settings. |
| `ANTIGRAVITY_MCP_SANDBOX` | `0` | Pass `--sandbox` to restrict agy's terminal. |
| `ANTIGRAVITY_MCP_IDLE_TIMEOUT_MS` | `600000` | Kill a run that produces no output for this long. |
| `ANTIGRAVITY_MCP_MAX_DIFF_CHARS` | `40000` | Diff length cap in the tool result. |
| `ANTIGRAVITY_MCP_MAX_REPORT_CHARS` | `24000` | Report length cap in the tool result. |
| `ANTIGRAVITY_MCP_STARTUP_TIMEOUT_MS` | `60000` | How long to wait for agy to announce a conversation id. |
| `ANTIGRAVITY_BIN` | `agy` | Path to the Antigravity CLI binary. |

## Long tasks

No single tool call blocks for the whole task. `delegate` starts agy and waits at most `wait_seconds`; if it is still working the call returns a running status and the process carries on inside the bridge. Claude then calls `wait` as many times as it likes, each call bounded by its own `wait_seconds`, and gets the full report and diff once agy exits. A dropped tool call loses nothing: the process keeps running and the result stays cached for the next `wait`.

`timeout_seconds` is the only hard limit. It kills the agy process outright (default 30 minutes) and is meant for runaway tasks, not for pacing.

Unlike opencode, agy has no server to reconnect to. If the bridge process restarts, `wait` reports the session as unknown; the conversation itself still exists in agy and can be continued with `delegate` and its `session_id`.

## Stall protection

Headless agy stalls silently and forever when a tool call needs a human answer ([antigravity-cli#548](https://github.com/google-antigravity/antigravity-cli/issues/548)). The bridge guards against that in layers:

1. `--dangerously-skip-permissions` is passed by default, which is the documented way to avoid the prompt.
2. The event stream is watched for an active `ask_permission`, `ask_custom_permission` or `ask_question` step. One of those means agy is waiting for a human, so the run is killed at once and the result says why.
3. An idle watchdog kills a run that emits no event for `ANTIGRAVITY_MCP_IDLE_TIMEOUT_MS`.
4. Every kill targets agy's whole process group, with SIGTERM then SIGKILL, so orphaned children never pile up.
5. Every event carries the conversation id, so a killed run still returns a `session_id` to continue from.

## Terms of service

Google bans accounts that use third-party software to harvest or piggyback on the CLI's OAuth credentials, or that bypass usage limits. Google staff have confirmed on the developer forum that spawning the unmodified `agy` binary as a child process in headless mode is a supported workflow, as long as the orchestrator lets agy manage its own authentication, extracts no tokens and calls no private backend APIs. This bridge does exactly that and nothing more. It never retries authentication, never runs more than one process per delegate call, and consumes your normal account entitlements.

## Orchestration guidance for Claude

Copy `claude-md-snippet.md` into the `CLAUDE.md` of projects where you want Claude to delegate by default.

## How it works

1. `delegate` snapshots the working tree as a git tree object (tracked and untracked files, ignored ones excluded) without touching your index.
2. It spawns `agy --print <task> --output-format stream-json --add-dir <directory>` in its own process group with stdin closed, plus the model, effort, mode, agent and conversation flags you asked for. The `--add-dir` matters: without it, a directory outside agy's trusted workspaces is treated as foreign and agy quietly works in its own scratch folder instead.
3. It parses the newline-delimited JSON events: tool steps become MCP progress notifications on whichever `delegate` or `wait` call is attached, the `init` event supplies the conversation id, and the `result` event supplies the report and token usage.
4. When agy exits it snapshots the tree again and diffs the two snapshots, so the diff covers exactly what this run changed. Claude reviews that, runs the tests, and decides.

## Development

```sh
npm run dev        # run from source
npm run typecheck
node scripts/smoke.mjs <scratch git project>   # end-to-end test, consumes agy quota
```
