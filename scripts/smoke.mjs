import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// Usage: node scripts/smoke.mjs <scratch git project dir>
const cwd = process.argv[2];
const serverPath = new URL("../dist/index.js", import.meta.url).pathname;
const spawnClient = async (name) => {
  const transport = new StdioClientTransport({ command: "node", args: [serverPath], cwd, env: { ...process.env }, stderr: "pipe" });
  transport.stderr?.on("data", (d) => process.stderr.write("[server] " + d));
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(transport);
  return client;
};
const client = await spawnClient("smoke");
const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
const text = (r) => r.content.map((c) => c.text).join("\n");
const progress = (p) => console.log(`  [progress ${p.progress}] ${p.message ?? ""}`);
const call = async (name, args, c = client) => {
  const t0 = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { onprogress: progress, timeout: 15 * 60 * 1000 });
  console.log(`\n===== ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s, isError=${r.isError ?? false}) =====`);
  console.log(text(r).slice(0, 2500));
  return text(r);
};

await call("bridge_info", {});
await call("list_models", {});
await call("list_agents", {});

// 1. delegate with wait 0 must come back at once with a running status carrying a session id
const started = await call("delegate", {
  task: "Add a function `multiply(a, b)` to src/math.js that returns a*b, exported like `add`. Then create src/math.test.js using node:test covering add and multiply, and run it with `node --test src/`. Report what you changed and the test output.",
  wait_seconds: 0, timeout_seconds: 600, effort: "low",
});
const sid = /session_id: (\S+)/.exec(started)?.[1];
if (!/# antigravity running/.test(started) || !sid) throw new Error("expected running status with session id");

// 2. wait 0 is a pure status check
await call("wait", { session_id: sid, wait_seconds: 0 });

// 3. busy session must be refused a second prompt
await client.callTool({ name: "delegate", arguments: { task: "x", session_id: sid, wait_seconds: 0 } }).then((r) => {
  console.log("\n===== delegate on busy session =====\nisError:", r.isError, text(r).slice(0, 200));
});

// 4. poll until done
let out;
for (let i = 0; i < 30; i++) {
  out = await call("wait", { session_id: sid, wait_seconds: 20 });
  if (/# antigravity result/.test(out)) break;
}
if (!/# antigravity result/.test(out)) throw new Error("never finished");
if (!/multiply/.test(out)) throw new Error("diff/report does not mention multiply");
// 5. cached result comes back again instantly
const again = await call("wait", { session_id: sid, wait_seconds: 0 });
if (again !== out) throw new Error("cached result differs");

// 6. follow-up in the same conversation
const follow = await call("delegate", {
  task: "Follow-up in the same conversation: also add a `subtract(a, b)` export and a test for it, then rerun the tests. Report briefly.",
  session_id: sid, wait_seconds: 300, timeout_seconds: 600, effort: "low",
});
if (!/# antigravity result/.test(follow)) throw new Error("follow-up did not finish in time");
if (!/subtract/.test(follow)) throw new Error("follow-up does not mention subtract");

// 7. cancel: start a long task, kill it, collect partial result
const long = await call("delegate", {
  task: "Write a 3000 word essay about the history of arithmetic into ESSAY.md, one paragraph per edit call, at least twelve edits. Report when done.",
  wait_seconds: 8, timeout_seconds: 600, effort: "low",
});
const sid2 = /session_id: (\S+)/.exec(long)?.[1];
if (/# antigravity running/.test(long)) {
  await call("cancel", { session_id: sid2 });
  const c = await call("wait", { session_id: sid2, wait_seconds: 30 });
  if (!/## Cancelled/.test(c)) throw new Error("cancel result missing");
}

// 8. plan mode must not change files
const plan = await call("delegate", {
  task: "Explore this repository. Report every file with a one-line purpose and what src/math.js exports. Do not modify anything.",
  mode: "plan", wait_seconds: 300, timeout_seconds: 600, effort: "low",
});
if (!/No files changed/.test(plan)) throw new Error("plan mode changed files");

// 9. a fresh bridge process must explain it cannot see the old run
await client.close();
const c2 = await spawnClient("smoke-2");
const r = await call("wait", { session_id: sid, wait_seconds: 0 }, c2);
if (!/unknown session/.test(r)) throw new Error("fresh process should report unknown session");
await c2.close();
console.log("\nALL CHECKS PASSED");
