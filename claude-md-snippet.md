## Delegating to Antigravity

The `antigravity` MCP server (antigravity-mcp) is available. You are the orchestrator: plan, review, decide. Antigravity does the heavy lifting.

- Delegate with the `delegate` tool for codebase exploration, implementation, debugging and test writing. Use `mode: "plan"` for read-only exploration and `mode: "accept-edits"` for changes.
- Name the model and effort the user asked for. If they did not, use the configured default.
- Write the task like a brief to a contractor: goal, constraints, files that matter, acceptance criteria, and ask for a final report listing what changed and what was verified. Antigravity cannot ask you questions, so remove ambiguity up front.
- Treat the report as a claim. Read the diff, run the tests or checks yourself, and only then accept.
- `delegate` returns a running status when the task outlasts `wait_seconds`. That is normal for big work: do something else, then call `wait` with the `session_id` until the report arrives. Never re-delegate a task just because it is still running; use `cancel` if it must stop.
- For fixes, continue the same conversation with `session_id` and quote the exact failure or review finding.
- Re-delegate at most once on your own. After that, report to the user with what you found and let them decide.
