# capcut-core.wasm

An experimental, capability-free WebAssembly Component for read-only CapCut/JianYing draft analysis through agent runtimes such as [Wassette](https://github.com/microsoft/wassette).

It exposes three JSON-in/JSON-out functions:

- `inspect` — parity-tested against `capcut info`.
- `diff` — parity-tested against `capcut diff`.
- `lint-portable` — a parity-tested subset of `capcut lint` covering `missing-material`, `dangling-companion-ref`, `cue-too-long`, `caption-too-fast`, `caption-outside-safe-area`, and `caption-overlap`.

The portable lint name is intentional. Full `capcut lint` also checks host files, probes media, reads bundled catalogues, and reasons about store/version metadata. Those checks stay in the Node CLI instead of being silently weakened behind a matching name.

## Security boundary

The host reads `draft_content.json` or `draft_info.json` and passes the content as a string. The component:

- has no filesystem, network, environment, clock, random, stdio, or process imports;
- cannot discover a draft path or read another file;
- cannot mutate a project;
- returns a string result or a string error through its WIT interface.

`npm run verify:component` asks Jco to reconstruct the compiled world and fails unless it contains zero imports and the expected CapCut interface. The MCP integration then asserts that agents see exactly the three declared functions. It starts Wassette with `--disable-builtin-tools`, so component-loading and permission-management tools are absent.

This is a narrower boundary than a container, not a replacement for the full CLI. File discovery, local-path linting, media probing, draft writes, rendering, and network-backed operations remain host responsibilities.

## Build and verify

From the repository root:

```bash
npm ci
npm --prefix wasm/capcut-core ci
npm run wasm:verify
```

That builds `wasm/capcut-core/dist/capcut-core.wasm`, runs direct contract tests, compares outputs with the current repository CLI, and proves the compiled component has zero imports.

For the raw MCP test, install [Wassette 0.7.0](https://github.com/microsoft/wassette/releases/tag/v0.7.0), then run:

```bash
WASSETTE_BIN="$(command -v wassette)" npm --prefix wasm/capcut-core run verify:mcp
```

The test loads the component into an isolated ignored directory, starts stdio MCP with built-ins disabled, calls all three functions, verifies malformed-input recovery, and prints non-gating latency measurements against fresh CLI processes.

## Use with Codex or another MCP client

Build, then load the component into a dedicated Wassette directory:

```bash
cd wasm/capcut-core
npm ci
npm run build
mkdir -p runtime/components
wassette component load "file://$PWD/dist/capcut-core.wasm" --component-dir "$PWD/runtime/components"
```

Register that locked-down runtime with Codex:

```bash
codex mcp add capcut-core -- wassette run \
  --component-dir "$PWD/runtime/components" \
  --disable-builtin-tools
```

Other MCP clients can use the same `wassette run` command over stdio. Keep the host-side file read visible and explicit—for example, read a draft, then pass its serialized JSON as `draft-json`. Do not grant storage or network permissions: this component declares none and needs none.

## Distribution

Generated `.wasm`, Wassette binaries, component caches, and runtime state are intentionally excluded from Git. CI uploads the platform-neutral component, its SHA-256 checksum, the repository license, and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) as a build artifact. A future tagged release can publish the same files after the experimental interface stabilizes.

The JavaScript source is MIT-licensed with the repository. The generated artifact embeds Bytecode Alliance runtime code; retain the third-party notices when redistributing it.
