# Third-party notices

The source in this directory is MIT-licensed under the repository's root `LICENSE`.

The generated `capcut-core.wasm` artifact embeds runtime code supplied by the following pinned build dependencies:

- [Bytecode Alliance ComponentizeJS 0.19.3](https://github.com/bytecodealliance/ComponentizeJS), including its SpiderMonkey/StarlingMonkey embedding — Apache License 2.0 with LLVM exceptions; see the upstream [`LICENSE`](https://github.com/bytecodealliance/ComponentizeJS/blob/main/LICENSE).
- [Bytecode Alliance Jco 1.17.9](https://github.com/bytecodealliance/jco) — Apache License 2.0 with LLVM exception.
- [Bytecode Alliance Wizer](https://github.com/bytecodealliance/wizer), pulled transitively by ComponentizeJS — Apache License 2.0.

Wassette is used only as an external test/runtime dependency and is not included in the repository or Wasm artifact. Wassette 0.7.0 is MIT-licensed by Microsoft Corporation.

The names WebAssembly, Bytecode Alliance, SpiderMonkey, StarlingMonkey, Wassette, CapCut, JianYing, ByteDance, and their associated marks belong to their respective owners. Inclusion here identifies interoperability and build provenance; it does not imply endorsement.
