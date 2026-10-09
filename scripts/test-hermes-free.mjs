// Tests for the Hermes Free gateway (protocol + HTTP server with a fake web model).
// Run: npm run compile && node --test scripts/test-hermes-free.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const protocol = require("../out/hermes/freeProtocol.js");
const { FreeGateway } = require("../out/hermes/freeGateway.js");

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path" },
          offset: { type: "integer" },
          limit: { type: "integer" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "terminal",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          background: { type: "boolean" },
          env: { type: "object", properties: { NAME: { type: "string" } } },
          mode: { type: "string", enum: ["fast", "safe"] }
        },
        required: ["command"]
      }
    }
  }
];

// --- protocol -------------------------------------------------------------

test("compact manifest is much smaller than pretty JSON", () => {
  const manifest = protocol.compactManifest(tools);
  assert.match(manifest, /read_file\(path: string, offset\?: int, limit\?: int\)/);
  assert.match(manifest, /mode\?: "fast" \| "safe"/);
  assert.ok(manifest.length < JSON.stringify(tools, null, 2).length / 2);
});

test("schema-aware coercion keeps strings as strings", () => {
  const parsed = protocol.parseReply(
    '<function_call name="read_file">\n<argument name="path">123</argument>\n<argument name="offset">5</argument>\n</function_call>',
    tools
  );
  const result = protocol.validateCalls(parsed, tools, "auto");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.calls[0].args, { path: "123", offset: 5 });
});

test("multiline code arguments survive untouched", () => {
  const code = "def f():\n    return {\"a\": 1}\n";
  const parsed = protocol.parseReply(`<function_call name="terminal">\n<argument name="command">\n${code}</argument>\n</function_call>`, tools);
  const { calls } = protocol.validateCalls(parsed, tools, "auto");
  assert.equal(calls[0].args.command, code.replace(/\n$/, ""));
});

test("validation reports missing params, bad types, enums and unknown tools", () => {
  const parsed = protocol.parseReply(
    [
      '<function_call name="read_file"><argument name="offset">abc</argument></function_call>',
      '<function_call name="termnal"><argument name="command">ls</argument></function_call>',
      '<function_call name="terminal"><argument name="command">ls</argument><argument name="mode">yolo</argument></function_call>'
    ].join("\n"),
    tools
  );
  const { errors } = protocol.validateCalls(parsed, tools, "auto");
  assert.equal(errors.length, 3);
  assert.match(errors[0], /expected a integer|missing required parameter "path"/);
  assert.match(errors[1], /Did you mean "terminal"/);
  assert.match(errors[2], /must be one of "fast", "safe"/);
});

test("casing/separator slips in tool names are auto-corrected", () => {
  const parsed = protocol.parseReply('<function_call name="Read-File"><argument name="path">a</argument></function_call>', tools);
  const result = protocol.validateCalls(parsed, tools, "auto");
  assert.equal(result.renamed, 1);
  assert.equal(result.calls[0].name, "read_file");
});

test("hallucination guard drops invented tool results", () => {
  const parsed = protocol.parseReply(
    'Let me look.\n<function_call name="read_file"><argument name="path">a.txt</argument></function_call>\n<tool_result>hello</tool_result>\nThe file says hello.',
    tools
  );
  assert.equal(parsed.guardTrimmed, true);
  assert.equal(parsed.content, "Let me look.");
  assert.equal(parsed.calls.length, 1);
});

test("JSON-style calls are recovered", () => {
  const parsed = protocol.parseReply('```json\n{"name": "terminal", "arguments": {"command": "pwd"}}\n```', tools);
  assert.equal(parsed.recovered, true);
  assert.equal(protocol.validateCalls(parsed, tools, "auto").calls[0].args.command, "pwd");
});

test("DeepSeek's native DSML call markup is understood", () => {
  // Shape observed from the real web chat: doubled bars, spaces, string="…" attrs.
  const raw = [
    "I'll read it.",
    "<｜｜DSML｜｜ function_calls>",
    '<｜｜DSML｜｜ invoke name="read_file">',
    '<｜｜DSML｜｜ parameter name="path" string="true">package.json</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="limit" string="false">30</｜｜DSML｜｜ parameter>',
    "</｜｜DSML｜｜ invoke>",
    "</｜｜DSML｜｜ function_calls>"
  ].join("\n");
  const parsed = protocol.parseReply(raw, tools);
  assert.equal(parsed.recovered, true);
  assert.equal(parsed.content, "I'll read it.");
  const { calls, errors } = protocol.validateCalls(parsed, tools, "auto");
  assert.deepEqual(errors, []);
  assert.deepEqual(calls[0], { name: "read_file", args: { path: "package.json", limit: 30 } });

  const single = protocol.parseReply('<｜DSML｜invoke name="terminal"><｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter></｜DSML｜invoke>', tools);
  assert.equal(protocol.validateCalls(single, tools, "auto").calls[0].args.command, "ls");
});

test("<parameter> is accepted in place of <argument> (seen in real sessions)", () => {
  const raw = '<function_call name="read_file">\n<parameter name="path">/workspace/hermes/test/new.py</parameter>\n<parameter name="limit">40</parameter>\n</function_call>';
  const parsed = protocol.parseReply(raw, tools);
  assert.equal(parsed.recovered, true);
  const { calls, errors } = protocol.validateCalls(parsed, tools, "auto");
  assert.deepEqual(errors, []);
  assert.deepEqual(calls[0].args, { path: "/workspace/hermes/test/new.py", limit: 40 });
});

test("<parameter> text inside a real <argument> stays untouched", () => {
  const xml = '<parameter name="x">1</parameter>';
  const raw = `<function_call name="terminal">\n<argument name="command">echo '${xml}' > a.xml</argument>\n</function_call>`;
  const { calls } = protocol.validateCalls(protocol.parseReply(raw, tools), tools, "auto");
  assert.equal(calls[0].args.command, `echo '${xml}' > a.xml`);
});

test("unclosed function_call is a syntax error", () => {
  const parsed = protocol.parseReply('<function_call name="terminal"><argument name="command">ls</argument>', tools);
  assert.equal(parsed.syntaxErrors.length, 1);
});

test("hash chain ignores tool-call ids and argument key order", () => {
  const a = [{ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "t", arguments: '{"a":1,"b":2}' } }] }];
  const b = [{ role: "assistant", content: "", tool_calls: [{ id: "y", type: "function", function: { name: "t", arguments: '{"b":2,"a":1}' } }] }];
  assert.deepEqual(protocol.hashChain(a), protocol.hashChain(b));
});

test("tool diff only lists what changed", () => {
  const changed = [tools[0], { ...tools[1], function: { ...tools[1].function, description: "new" } }];
  const diff = protocol.diffTools(tools, changed);
  assert.deepEqual(diff.added.map((t) => t.function.name), ["terminal"]);
  assert.deepEqual(diff.removed, []);
});

// --- gateway end to end ---------------------------------------------------

/** Fake DeepSeek web chat: stateful sessions, scripted replies. */
function fakeWeb(replies) {
  const sessions = new Map();
  let next = 1;
  return {
    sessions,
    upstream: {
      async rawTurn(prompt, sessionId) {
        const id = sessionId || `s${next++}`;
        if (!sessions.has(id)) sessions.set(id, []);
        sessions.get(id).push(prompt);
        const reply = replies.shift();
        if (reply === undefined) throw new Error("fake web chat ran out of replies");
        return { sessionId: id, content: typeof reply === "function" ? reply(prompt) : reply, reasoning: "" };
      }
    }
  };
}

async function post(gateway, body, key = gateway.apiKey) {
  const res = await fetch(`${gateway.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, text, json: text.startsWith("{") ? JSON.parse(text) : undefined };
}

test("multi-turn agent loop uses one web session and only sends deltas", async () => {
  const web = fakeWeb([
    '<function_call name="read_file"><argument name="path">README.md</argument></function_call>',
    "The README says hi.",
    "Sure, done."
  ]);
  const events = [];
  const gateway = new FreeGateway({ upstream: web.upstream, onEvent: (e) => events.push(e) });
  await gateway.start();
  try {
    const system = { role: "system", content: "You are Hermes. ".repeat(200) };
    const user = { role: "user", content: "What does the README say?" };

    const r1 = await post(gateway, { model: "deepseek-chat", messages: [system, user], tools });
    assert.equal(r1.status, 200);
    const call = r1.json.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "read_file");
    assert.deepEqual(JSON.parse(call.function.arguments), { path: "README.md" });
    assert.equal(r1.json.choices[0].finish_reason, "tool_calls");

    // Hermes echoes the assistant turn back (new ids, null content) + the tool result.
    const assistant = { role: "assistant", content: null, tool_calls: [{ ...call, id: "call_rewritten" }] };
    const toolMsg = { role: "tool", tool_call_id: "call_rewritten", name: "read_file", content: "hi" };
    const r2 = await post(gateway, { model: "deepseek-chat", messages: [system, user, assistant, toolMsg], tools });
    assert.equal(r2.json.choices[0].message.content, "The README says hi.");

    const r3 = await post(gateway, {
      model: "deepseek-chat",
      messages: [system, user, assistant, toolMsg, { role: "assistant", content: "The README says hi." }, { role: "user", content: "thanks" }],
      tools
    });
    assert.equal(r3.json.choices[0].message.content, "Sure, done.");

    assert.equal(web.sessions.size, 1, "all turns stay in one web session");
    const prompts = web.sessions.get("s1");
    assert.match(prompts[0], /<system_instructions>/);
    assert.match(prompts[0], /read_file\(path: string/);
    assert.doesNotMatch(prompts[1], /system_instructions|read_file\(path/, "delta re-sends neither system nor tools");
    assert.match(prompts[1], /<tool_result name="read_file"/);
    assert.match(prompts[2], /thanks/);
    assert.deepEqual(events.map((e) => e.kind), ["bootstrap", "delta", "delta"]);
    assert.ok(events[2].sentChars < events[2].naiveChars / 10, "delta is >10x smaller than naive replay");
  } finally {
    await gateway.stop();
  }
});

test("invalid tool calls are self-repaired inside the same session", async () => {
  const web = fakeWeb([
    '<function_call name="read_file"><argument name="offset">x</argument></function_call>',
    (prompt) => {
      assert.match(prompt, /could not be executed/);
      assert.match(prompt, /missing required parameter "path"|expected a integer/);
      return '<function_call name="read_file"><argument name="path">a.ts</argument></function_call>';
    }
  ]);
  const gateway = new FreeGateway({ upstream: web.upstream });
  await gateway.start();
  try {
    const r = await post(gateway, { messages: [{ role: "user", content: "read a.ts" }], tools });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.json.choices[0].message.tool_calls[0].function.arguments), { path: "a.ts" });
    assert.equal(web.sessions.size, 1);
    assert.equal(gateway.getStats().repairs, 1);
  } finally {
    await gateway.stop();
  }
});

test("gives up with a clear error after max repairs", async () => {
  const bad = '<function_call name="nope"></function_call>';
  const web = fakeWeb([bad, bad]);
  const gateway = new FreeGateway({ upstream: web.upstream, maxRepairs: 1 });
  await gateway.start();
  try {
    const r = await post(gateway, { messages: [{ role: "user", content: "x" }], tools });
    assert.equal(r.status, 502);
    assert.match(r.json.error.message, /Unknown function "nope"/);
  } finally {
    await gateway.stop();
  }
});

test("streaming responses are valid SSE with tool_calls deltas", async () => {
  const web = fakeWeb(['<function_call name="terminal"><argument name="command">ls</argument><argument name="background">false</argument></function_call>']);
  const gateway = new FreeGateway({ upstream: web.upstream });
  await gateway.start();
  try {
    const r = await post(gateway, { stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "ls" }], tools });
    const events = r.text.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
    assert.equal(events.at(-1), "[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    const callChunk = chunks.find((c) => c.choices[0]?.delta?.tool_calls);
    assert.deepEqual(JSON.parse(callChunk.choices[0].delta.tool_calls[0].function.arguments), { command: "ls", background: false });
    assert.ok(chunks.some((c) => c.choices[0]?.finish_reason === "tool_calls"));
    assert.ok(chunks.some((c) => c.usage));
  } finally {
    await gateway.stop();
  }
});

test("a non-matching history starts a fresh session (no context bleed)", async () => {
  const web = fakeWeb(["one", "two"]);
  const gateway = new FreeGateway({ upstream: web.upstream });
  await gateway.start();
  try {
    await post(gateway, { messages: [{ role: "user", content: "conversation A" }] });
    await post(gateway, { messages: [{ role: "user", content: "conversation B" }] });
    assert.equal(web.sessions.size, 2);
  } finally {
    await gateway.stop();
  }
});

test("rejects requests without the per-launch key", async () => {
  const gateway = new FreeGateway({ upstream: fakeWeb([]).upstream });
  await gateway.start();
  try {
    const r = await post(gateway, { messages: [{ role: "user", content: "x" }] }, "wrong");
    assert.equal(r.status, 401);
  } finally {
    await gateway.stop();
  }
});

// --- docker runtime helpers -----------------------------------------------

const docker = require("../out/hermes/docker.js");

test("loopback URLs are rewritten for containers, others untouched", () => {
  assert.equal(docker.toContainerUrl("http://127.0.0.1:49770/v1"), "http://host.docker.internal:49770/v1");
  assert.equal(docker.toContainerUrl("http://localhost:3000"), "http://host.docker.internal:3000");
  assert.equal(docker.toContainerUrl("https://api.deepseek.com"), "https://api.deepseek.com");
  assert.equal(docker.toContainerUrl("http://localhost.evil.com/x"), "http://localhost.evil.com/x");
});

test("workspace paths map into the container by longest prefix (Windows host semantics)", () => {
  const maps = { "C:\\codes": "/workspace", "C:\\codes\\github": "/gh" };
  assert.equal(docker.mapPathIntoContainer("C:\\codes\\github\\rc-vscode", maps, true), "/gh/rc-vscode");
  assert.equal(docker.mapPathIntoContainer("c:\\codes\\Other\\App", maps, true), "/workspace/Other/App");
  assert.equal(docker.mapPathIntoContainer("C:\\codesX\\a", maps, true), undefined);
  assert.equal(docker.mapPathIntoContainer("D:\\x", maps, true), undefined);
});

test("docker exec forwards secrets by name only and records the PID", () => {
  const inv = docker.dockerExecInvocation("hermes", ["chat", "-Q"], ["DEEPSEEK_API_KEY"]);
  assert.equal(inv.command, "docker");
  assert.deepEqual(inv.args.slice(0, 5), ["exec", "-i", "-e", "DEEPSEEK_API_KEY", "hermes"]);
  assert.ok(!inv.args.some((a) => a.includes("=")), "no NAME=value in argv");
  assert.ok(inv.args[7].includes(`rc-hermes-${inv.turnId}.pid; exec "$@"`));
  assert.deepEqual(inv.args.slice(-3), ["hermes", "chat", "-Q"]);
});

// --- tool cards (real Hermes result shapes) ---------------------------------

const cards = require("../out/hermes/toolCards.js");

test("tool cards: icon and the most useful argument", () => {
  const c = cards.callCard("x", "terminal", { command: "python3 -m pytest -q test_calc.py", workdir: "/w" }, false);
  assert.equal(c.icon, "▷");
  assert.equal(c.detail, "python3 -m pytest -q test_calc.py");
  assert.equal(c.state, "running");
  assert.equal(cards.callCard("y", "write_file", { path: "/workspace/hermes/test/new.py", content: "x" }, true).detail, "test/new.py");
  assert.equal(cards.callCard("z", "search_files", { pattern: "*.py", target: "files" }, false).detail, "*.py");
  assert.equal(cards.toolIcon("some_new_tool"), "⚙");
});

test("tool cards: statuses from real Hermes results", () => {
  const s = (name, content) => cards.resultStatus(name, content);
  assert.deepEqual(s("write_file", '{"bytes_written": 31, "dirs_created": true, "verified": true}'), { state: "ok", status: "✓" });
  assert.deepEqual(
    s("write_file", `{"bytes_written": 0, "error": "Write denied: '/tmp/x' is outside HERMES_WRITE_SAFE_ROOT (/opt/data)."}`),
    { state: "fail", status: "✗ Write denied" }
  );
  assert.deepEqual(s("read_file", '{"content": "1|x", "total_lines": 2, "file_size": 31}'), { state: "ok", status: "✓ 2 lines" });
  assert.deepEqual(s("search_files", '{"total_count": 2, "files": ["a.py", "b.py"]}'), { state: "ok", status: "✓ 2 found" });
  assert.deepEqual(
    s("terminal", '{"output": "cat: x.txt: No such file or directory", "exit_code": 1, "error": null}'),
    { state: "fail", status: "✗ exit 1" }
  );
  const J = (o) => JSON.stringify(o); // real newlines inside, valid JSON outside
  assert.deepEqual(s("terminal", J({ output: ".......\n7 passed in 9.88s", exit_code: 0, error: null })), { state: "ok", status: "✓ 7 passed" });
  assert.deepEqual(
    s("terminal", J({ output: "F.\n1 failed, 1 passed in 0.1s", exit_code: 1, error: null })),
    { state: "fail", status: "✗ 1 failed, 1 passed" }
  );
  assert.deepEqual(
    s("patch", J({ success: true, diff: "--- a/t.py\n+++ b/t.py\n@@ -6 +6 @@\n-    assert 5\n+    assert 4\n" })),
    { state: "ok", status: "✓ +1 −1" }
  );
  assert.deepEqual(s("patch", '{"success": false}'), { state: "fail", status: "✗" });
  assert.deepEqual(s("anything", "plain text result"), { state: "ok", status: "✓" });
  assert.deepEqual(s("anything", "Traceback (most recent call last): boom"), { state: "fail", status: "✗ Traceback (most recent call las…" });
});

test("gateway emits a tool call, then its result when the client sends it back", async () => {
  const web = fakeWeb(['<function_call name="read_file"><argument name="path">a.py</argument></function_call>', "done"]);
  const gateway = new FreeGateway({ upstream: web.upstream });
  const seen = [];
  gateway.subscribeTools((e) => seen.push(e));
  await gateway.start();
  try {
    const user = { role: "user", content: "read a.py" };
    const r1 = await post(gateway, { messages: [user], tools });
    const call = r1.json.choices[0].message.tool_calls[0];
    await post(gateway, {
      messages: [user, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: '{"content": "x", "total_lines": 1}' }],
      tools
    });
    assert.deepEqual(seen.map((e) => [e.type, e.name, e.id === call.id]), [["call", "read_file", true], ["result", "read_file", true]]);
    assert.deepEqual(seen[0].args, { path: "a.py" });
    assert.equal(seen[1].content, '{"content": "x", "total_lines": 1}');
  } finally {
    await gateway.stop();
  }
});

// --- custom endpoint (direct mode) ----------------------------------------

import http from "node:http";

/** Minimal OpenAI-compatible server with native tool calling. */
async function mockOpenAI(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, auth: req.headers.authorization, body: json });
      const [status, reply] = handler(json, requests.length);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

test("direct mode forwards to a custom endpoint with its own model and native tools", async () => {
  const upstream = await mockOpenAI((body, n) => [200, {
    choices: [{ message: n === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "up_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.py"}' } }] }
      : { role: "assistant", content: "all good" } }]
  }]);
  const gateway = new FreeGateway({
    upstream: fakeWeb([]).upstream, // must never be used in direct mode
    direct: () => ({ baseUrl: upstream.url, apiKey: "sk-custom", model: "qwen2.5-coder:7b" })
  });
  const seen = [];
  gateway.subscribeTools((e) => seen.push([e.type, e.name, e.id]));
  await gateway.start();
  try {
    const user = { role: "user", content: "read a.py" };
    const r1 = await post(gateway, { model: "deepseek-chat", messages: [user], tools, stream: true });
    assert.equal(r1.status, 200);
    assert.match(r1.text, /"tool_calls"/);
    assert.equal(upstream.requests[0].body.model, "qwen2.5-coder:7b", "custom model name replaces the client's");
    assert.equal(upstream.requests[0].body.stream, false);
    assert.equal(upstream.requests[0].auth, "Bearer sk-custom");
    assert.deepEqual(upstream.requests[0].body.tools, tools, "tools pass through natively");
    const call = { id: "up_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.py"}' } };
    const r2 = await post(gateway, { messages: [user, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "up_1", content: "x" }], tools });
    assert.equal(r2.json.choices[0].message.content, "all good");
    assert.deepEqual(seen, [["call", "read_file", "up_1"], ["result", "read_file", "up_1"]]);
    assert.equal(gateway.getStats().requests, 2);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test("direct mode surfaces endpoint errors clearly", async () => {
  const upstream = await mockOpenAI(() => [401, { error: { message: "bad key" } }]);
  const gateway = new FreeGateway({ upstream: fakeWeb([]).upstream, direct: () => ({ baseUrl: upstream.url, apiKey: "x", model: "m" }) });
  await gateway.start();
  try {
    const r = await post(gateway, { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 401);
    assert.match(r.json.error.message, /Custom endpoint: bad key/);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
  const dead = new FreeGateway({ upstream: fakeWeb([]).upstream, direct: () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "m" }) });
  await dead.start();
  try {
    const r = await post(dead, { messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 502);
    assert.match(r.json.error.message, /unreachable/);
  } finally {
    await dead.stop();
  }
});

// --- Linux / Docker routing --------------------------------------------------

test("container -> host route per platform and Docker flavour", async () => {
  const fake = (answers) => async (_cmd, args) => {
    const key = args.join(" ");
    for (const [needle, out] of answers) if (key.includes(needle)) return out;
    return undefined;
  };
  // Docker Desktop (Windows/macOS) forwards host.docker.internal to host loopback.
  assert.deepEqual(await docker.containerHostRoute("hermes", "win32", fake([])), { host: "host.docker.internal" });
  assert.deepEqual(await docker.containerHostRoute("hermes", "darwin", fake([])), { host: "host.docker.internal" });
  // Docker Desktop for Linux behaves the same.
  assert.deepEqual(
    await docker.containerHostRoute("hermes", "linux", fake([["OperatingSystem", "Docker Desktop"]])),
    { host: "host.docker.internal" }
  );
  // Docker Engine on Linux, host network: shares our loopback.
  assert.deepEqual(
    await docker.containerHostRoute("hermes", "linux", fake([["OperatingSystem", "Ubuntu 24.04 LTS"], ["NetworkMode", "host\n"]])),
    { host: "127.0.0.1" }
  );
  // Docker Engine on Linux, compose bridge: reach us via the network gateway, which we must bind.
  assert.deepEqual(
    await docker.containerHostRoute("hermes", "linux", fake([["OperatingSystem", "Debian GNU/Linux 12"], ["NetworkMode", "hermes-stack_default"], ["Gateway", "172.18.0.1 \n"]])),
    { host: "172.18.0.1", bindHost: "172.18.0.1" }
  );
});

test("Linux paths map case-sensitively, Windows paths case-insensitively", () => {
  const maps = { "/home/me/code": "/workspace" };
  assert.equal(docker.mapPathIntoContainer("/home/me/code/App", maps, false), "/workspace/App");
  assert.equal(docker.mapPathIntoContainer("/home/me/Code/App", maps, false), undefined);
  assert.equal(docker.mapPathIntoContainer("C:\\Codes\\x", { "c:\\codes": "/w" }, true), "/w/x");
  assert.equal(docker.toContainerUrl("http://127.0.0.1:5000/v1", "172.18.0.1"), "http://172.18.0.1:5000/v1");
  assert.equal(docker.isLoopbackUrl("http://localhost:1/v1"), true);
  assert.equal(docker.isLoopbackUrl("https://api.deepseek.com"), false);
});

test("gateway can also listen on a second address (Linux Docker bridge)", async () => {
  const gateway = new FreeGateway({ upstream: fakeWeb(["hello"]).upstream });
  await gateway.start();
  try {
    const url = await gateway.exposeOn("127.0.0.1");
    assert.notEqual(url, gateway.baseUrl, "a separate listener");
    assert.equal(await gateway.exposeOn("127.0.0.1"), url, "reused, not duplicated");
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.apiKey}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    });
    assert.equal((await res.json()).choices[0].message.content, "hello");
    const denied = await fetch(`${url}/models`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(denied.status, 401, "same per-launch key on every listener");
  } finally {
    await gateway.stop();
  }
});

// --- remote Hermes (API server) --------------------------------------------

const remote = require("../out/hermes/remote.js");

test("SSE parser handles split chunks, keepalives and named events", () => {
  const p = new remote.SseParser();
  assert.deepEqual(p.push(": keepalive\n\nevent: tool.started\ndata: {\"tool_na"), []);
  const out = p.push('me":"terminal"}\n\nevent: done\ndata: {}\n\n');
  assert.deepEqual(out, [{ event: "tool.started", data: { tool_name: "terminal" } }, { event: "done", data: {} }]);
});

test("remote URL is normalised", () => {
  assert.equal(remote.normalizeRemoteUrl("https://h.example:8642/v1/"), "https://h.example:8642");
  assert.equal(remote.normalizeRemoteUrl(" http://1.2.3.4:18642 "), "http://1.2.3.4:18642");
});

/** Mock Hermes API server: sessions, an SSE chat stream with tools + approval, runs control. */
async function mockHermes({ key = "k", sessions = new Set(["s1"]) } = {}) {
  const log = [];
  let releaseApproval;
  const approvalGiven = new Promise((r) => (releaseApproval = r));
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const json = body ? JSON.parse(body) : {};
      log.push({ method: req.method, url: req.url, body: json });
      if (req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Invalid gateway API key" } }));
      }
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/capabilities") return send(200, { model: "hermes-agent", runtime: { tool_execution: "server" } });
      if (req.url === "/api/sessions" && req.method === "POST") { sessions.add("s2"); return send(200, { session: { id: "s2" } }); }
      if (req.url.endsWith("/approval")) { releaseApproval(json.choice); return send(200, { ok: true }); }
      if (req.url.endsWith("/stop")) return send(200, { ok: true });
      const m = req.url.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/);
      if (m) {
        if (!sessions.has(m[1])) return send(404, { error: { message: "not found" } });
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify({ run_id: "run_1", ...data })}\n\n`);
        ev("run.started", {});
        res.write(": keepalive\n\n");
        ev("tool.started", { tool_name: "read_file", args: { path: "/srv/app/main.py" } });
        ev("tool.completed", { tool_name: "read_file", preview: '{"content":"x","total_lines":12}' });
        ev("tool.started", { tool_name: "terminal", args: { command: "rm -rf build" } });
        ev("approval.request", { command: "rm -rf build", description: "recursive delete", choices: ["once", "session", "deny"], request_id: "rq1" });
        await approvalGiven;
        ev("tool.completed", { tool_name: "terminal", preview: '{"output":"","exit_code":0}' });
        ev("assistant.delta", { delta: "Cleaned " });
        ev("assistant.delta", { delta: "the build." });
        ev("assistant.completed", { content: "Cleaned the build." });
        ev("run.completed", {});
        ev("done", {});
        return res.end();
      }
      send(404, { error: { message: "no route" } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { log, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("remote turn: streamed text, tool cards, approval round-trip", async () => {
  const srv = await mockHermes();
  try {
    const client = new remote.HermesRemoteClient({ baseUrl: srv.url + "/v1", apiKey: "k" });
    assert.deepEqual(await client.probe(), { model: "hermes-agent", toolExecution: "server" });
    const cards = [];
    const texts = [];
    const approvals = [];
    const result = await client.runTurn("s1", "clean the build", "write", {
      onText: (t) => texts.push(t),
      onStatus: () => {},
      onCard: (c) => cards.push([c.name, c.detail, c.status]),
      onApproval: async (req) => { approvals.push(req); return "once"; }
    });
    assert.deepEqual(result, { ok: true, text: "Cleaned the build.", sessionId: "s1" });
    assert.deepEqual(cards, [
      ["read_file", "app/main.py", "…"],
      ["read_file", "app/main.py", "✓ 12 lines"],
      ["terminal", "rm -rf build", "…"],
      ["terminal", "rm -rf build", "✓"]
    ]);
    assert.equal(approvals[0].command, "rm -rf build");
    assert.deepEqual(srv.log.find((r) => r.url.endsWith("/approval")).body, { choice: "once", request_id: "rq1" });
    assert.equal(texts.at(-1), "Cleaned the build.");
    assert.equal(srv.log.find((r) => r.url.includes("/chat/stream")).body.message, "clean the build");
  } finally {
    await srv.close();
  }
});

test("remote turn: chat mode adds the read-only note; unknown session and bad key are reported", async () => {
  const srv = await mockHermes();
  try {
    const client = new remote.HermesRemoteClient({ baseUrl: srv.url, apiKey: "k" });
    const hooks = { onText() {}, onStatus() {}, onCard() {}, onApproval: async () => "deny" };
    await client.runTurn("s1", "explain", "ask", hooks);
    assert.match(srv.log.find((r) => r.url.includes("/chat/stream")).body.message, /^\(Chat mode: read-only/);
    const gone = await client.runTurn("nope", "hi", "write", hooks);
    assert.equal(gone.ok, false);
    assert.equal(gone.sessionGone, true);
    assert.equal(await client.createSession("t"), "s2");
    const bad = new remote.HermesRemoteClient({ baseUrl: srv.url, apiKey: "wrong" });
    await assert.rejects(bad.probe(), /rejected the API key/);
  } finally {
    await srv.close();
  }
});
