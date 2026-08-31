import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { __test } from "../component.js";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(packageDirectory, "../..");
const fixturePath = resolve(repositoryRoot, "test/draft_content.json");
const cliPath = resolve(repositoryRoot, "dist/index.js");
const artifactPath = join(packageDirectory, "dist/capcut-core.wasm");
const wassette = process.env.WASSETTE_BIN ?? "wassette";
const runId = `${process.pid}-${Date.now()}`;
const componentDirectory = join(packageDirectory, "runtime", runId, "components");
const xdgRoot = join(packageDirectory, "runtime", runId, "xdg");
mkdirSync(componentDirectory, { recursive: true });
mkdirSync(xdgRoot, { recursive: true });

const fixtureJson = readFileSync(fixturePath, "utf8");
const changed = JSON.parse(fixtureJson);
changed.materials.texts[0].content = JSON.stringify({ text: "EDITED THROUGH MCP", styles: [] });
changed.tracks[0].segments[0].target_timerange.start += 1_000_000;
const changedJson = JSON.stringify(changed);

const runtimeEnvironment = {
  ...process.env,
  RUST_LOG: "off",
  XDG_CONFIG_HOME: join(xdgRoot, "config"),
  XDG_DATA_HOME: join(xdgRoot, "data"),
  XDG_CACHE_HOME: join(xdgRoot, "cache"),
};

const loaded = spawnSync(
  wassette,
  ["component", "load", pathToFileURL(artifactPath).href, "--component-dir", componentDirectory],
  { cwd: packageDirectory, env: runtimeEnvironment, encoding: "utf8" },
);
assert.equal(loaded.status, 0, loaded.stderr || loaded.error?.message);

const startedAt = performance.now();
const server = spawn(
  wassette,
  ["run", `--component-dir=${componentDirectory}`, "--disable-builtin-tools"],
  { cwd: packageDirectory, env: runtimeEnvironment, stdio: ["pipe", "pipe", "pipe"] },
);

let nextId = 1;
let stderr = "";
const pending = new Map();
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const lines = createInterface({ input: server.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});

function request(method, params = {}, timeoutMilliseconds = 30_000) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`Timeout waiting for ${method}. stderr: ${stderr}`));
    }, timeoutMilliseconds);
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params = {}) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function decodeStructured(result) {
  const structured = result?.structuredContent ?? result?.structured_content;
  const variant = structured?.result;
  if (variant && typeof variant === "object" && Object.hasOwn(variant, "ok")) {
    return { tag: "ok", value: JSON.parse(variant.ok) };
  }
  if (variant && typeof variant === "object" && Object.hasOwn(variant, "err")) {
    return { tag: "err", error: variant.err };
  }
  const text = result?.content?.find((item) => item.type === "text")?.text;
  throw new Error(`Missing structured MCP result: ${text ?? JSON.stringify(result)}`);
}

async function invoke(name, args, attempts = 1) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await request("tools/call", { name, arguments: args });
      if (result?.isError) {
        const message = result.content?.map((item) => item.text ?? "").join(" ") || "MCP tool error";
        throw new Error(message);
      }
      return decodeStructured(result);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(250);
    }
  }
  throw lastError;
}

function toolEnding(names, ending) {
  const found = names.find((name) => name.endsWith(`_${ending}`));
  assert.ok(found, `Missing MCP tool ending in _${ending}: ${names.join(", ")}`);
  return found;
}

function direct(result) {
  return JSON.parse(result);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function cliLatencySamples(iterations) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const before = performance.now();
    const result = spawnSync(process.execPath, [cliPath, "info", fixturePath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    JSON.parse(result.stdout);
    values.push(performance.now() - before);
  }
  return values;
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "capcut-core-verifier", version: "0.1.0" },
  });
  notify("notifications/initialized");
  const initializedMilliseconds = performance.now() - startedAt;

  const listed = await request("tools/list");
  const listedNames = listed.tools.map((tool) => tool.name).sort();
  assert.equal(listedNames.length, 3, `Expected exactly three component tools: ${listedNames.join(", ")}`);
  assert.ok(!listedNames.some((name) => name.includes("permission") || name === "load-component"));
  const tools = {
    inspect: toolEnding(listedNames, "inspect"),
    lintPortable: toolEnding(listedNames, "lint-portable"),
    diff: toolEnding(listedNames, "diff"),
  };

  const firstCallStarted = performance.now();
  const inspectResult = await invoke(tools.inspect, { "draft-json": fixtureJson }, 80);
  const firstCallMilliseconds = performance.now() - firstCallStarted;
  assert.equal(inspectResult.tag, "ok", inspectResult.error);
  assert.deepEqual(inspectResult.value, direct(__test.inspect(fixtureJson)));

  const lintResult = await invoke(tools.lintPortable, { "draft-json": fixtureJson });
  assert.equal(lintResult.tag, "ok", lintResult.error);
  assert.deepEqual(lintResult.value, direct(__test.lintPortable(fixtureJson)));

  const diffResult = await invoke(tools.diff, {
    "before-json": fixtureJson,
    "after-json": changedJson,
  });
  assert.equal(diffResult.tag, "ok", diffResult.error);
  assert.deepEqual(diffResult.value, direct(__test.diff(fixtureJson, changedJson)));

  const malformed = await invoke(tools.inspect, { "draft-json": "not-json" });
  assert.equal(malformed.tag, "err");
  assert.match(malformed.error, /not valid JSON/);
  const afterError = await invoke(tools.inspect, { "draft-json": fixtureJson });
  assert.equal(afterError.tag, "ok");

  const wasmLatencies = [];
  for (let index = 0; index < 20; index += 1) {
    const before = performance.now();
    const value = await invoke(tools.inspect, { "draft-json": fixtureJson });
    assert.equal(value.tag, "ok");
    wasmLatencies.push(performance.now() - before);
  }
  const cliLatencies = cliLatencySamples(12);
  const wasmP50 = percentile(wasmLatencies, 0.5);
  const cliP50 = percentile(cliLatencies, 0.5);

  console.log(
    JSON.stringify(
      {
        ok: true,
        runtime: { name: "wassette", version: "0.7.0", protocolVersion: initialized.protocolVersion },
        security: { componentImports: [], builtinToolsExposed: false },
        mcp: {
          initializedMs: round(initializedMilliseconds),
          firstToolCallMs: round(firstCallMilliseconds),
          tools: listedNames,
          survivedMalformedInput: true,
        },
        parity: { inspect: true, lintPortable: true, diff: true },
        latencyMs: {
          warmWasmMcp: {
            samples: wasmLatencies.length,
            p50: round(wasmP50),
            p95: round(percentile(wasmLatencies, 0.95)),
          },
          nodeCliProcess: {
            samples: cliLatencies.length,
            p50: round(cliP50),
            p95: round(percentile(cliLatencies, 0.95)),
          },
          p50Speedup: round(cliP50 / wasmP50),
        },
      },
      null,
      2,
    ),
  );
} finally {
  server.kill("SIGTERM");
}
