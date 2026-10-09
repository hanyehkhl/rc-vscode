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

test("workspace paths map into the container by longest prefix", () => {
  const maps = { "C:\\codes": "/workspace", "C:\\codes\\github": "/gh" };
  assert.equal(docker.mapPathIntoContainer("C:\\codes\\github\\rc-vscode", maps), "/gh/rc-vscode");
  assert.equal(docker.mapPathIntoContainer("c:\\codes\\Other\\App", maps), "/workspace/Other/App");
  assert.equal(docker.mapPathIntoContainer("C:\\codesX\\a", maps), undefined);
  assert.equal(docker.mapPathIntoContainer("D:\\x", maps), undefined);
});

test("docker exec forwards secrets by name only and records the PID", () => {
  const inv = docker.dockerExecInvocation("hermes", ["chat", "-Q"], ["DEEPSEEK_API_KEY"]);
  assert.equal(inv.command, "docker");
  assert.deepEqual(inv.args.slice(0, 5), ["exec", "-i", "-e", "DEEPSEEK_API_KEY", "hermes"]);
  assert.ok(!inv.args.some((a) => a.includes("=")), "no NAME=value in argv");
  assert.ok(inv.args[7].includes(`rc-hermes-${inv.turnId}.pid; exec "$@"`));
  assert.deepEqual(inv.args.slice(-3), ["hermes", "chat", "-Q"]);
});
