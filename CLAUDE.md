# CLAUDE.md — working agreement

**Before writing any code, read `docs/spec.md` in full — it is the source of truth.**
**Before touching `mint/cdk-fiber/`, read `docs/integration-contract.md`** — it records what cdk and
the Fiber node actually do, including several places where their own comments are wrong.
`README.md` states what this project is. Stack: **Rust** (stable toolchain) + a **Vite/TS** wallet.

## Working agreement (non-negotiable)
- **The spec governs.** If a requirement is ambiguous, underspecified, or contradictory, stop and
  re-read `docs/`. If the docs still do not answer it, surface the question — never guess or invent
  behavior.
- **Verify against source, not docs.** Both cdk and fnn ship comments that contradict their code.
  When a behavior is load-bearing, read the implementation and cite it in
  `docs/integration-contract.md`.
- **Money-safety is the first invariant.** Never credit ecash for funds the mint does not hold, and
  never report an in-flight payment as `Failed`. When a state is uncertain, it is `Pending` or
  `Unknown` — both let the mint recover; `Failed` hands a wallet its proofs back.
- **Nothing half-done ships.** No `TODO`/`FIXME` markers, no `todo!()`/`unimplemented!()`/
  `unreachable!()` used as a stub, no placeholder returns, no commented-out "later" code, no dead
  scaffolding. A unit of work is complete and tested, or it is not started.
- **No numbered-step comments.** Never write comments like `// Step 1`, `// 1.`, or `// then …`.
  A comment states a non-obvious *why* — a protocol constraint, a safety invariant — never *what*
  the next line does.
- **Comments are rare and load-bearing.** Prefer precise names and small functions over narration.
- **Commit often, in small imperative steps** (`add melt idempotency guard`, `raise fiber fee
  rate`). Push a coherent unit of work once it is done and `make ci` is green.
- **No co-author trailers.** Commit messages carry no `Co-Authored-By:` line and no attribution
  footer.
- **CI is the gate.** `.github/workflows/ci.yml` runs `make ci` on every push and pull request.
  Keep it green; never merge red.
- **Docs stay in sync.** When behavior changes, update `docs/`.
- **Self-contained.** This repo references no sibling project and no planning folder; everything it
  needs lives here.

## Commands — always via `make`
| target | does |
|--------|------|
| `make setup` | install rustfmt + clippy, check for `protoc` |
| `make build` | `cargo build --all-targets` |
| `make test`  | `cargo test` |
| `make lint`  | `cargo clippy --all-targets -- -D warnings` |
| `make fmt`   | `cargo fmt --all` |
| `make ci`    | fmt-check + lint + test + build (what CI runs) |
| `make wallet` | run the demo wallet against a local mint |

Run `make ci` before every push. `protoc` is required: `cdk-payment-processor` compiles its
`.proto` at build time.

## Coding standards
- Rust 2021, stable toolchain. Format with `rustfmt` (defaults). Clippy must pass at `-D warnings`
  — zero warnings.
- Prefer `Result` + `?`. Reserve `unwrap`/`expect` for tests and provably-infallible paths, and
  give `expect` a message that states the invariant.
- No `unsafe`. Errors: `thiserror` in `cdk-fiber`, `anyhow` in `fibernuts-processor`. Never swallow
  an error silently — `cdk-payment-processor` replaces our error text with
  `Status::internal("Could not create invoice")`, so a `tracing` line is the only diagnostic that
  survives to the operator.
- The Fiber node is reached through the injectable `FiberRpc` trait, so the `MintPayment` logic is
  tested against a mock. **No live node in tests.**
- Pin cdk to `=0.17.2`. Its `MintPayment` trait changes shape across minor versions.
- Public items carry `///` docs describing the contract, not the implementation.

## Layout
- `mint/` — the Rust workspace
  - `mint/cdk-fiber/` — the payment backend: cdk's `MintPayment` over Fiber JSON-RPC (the crate
    intended for upstream)
  - `mint/processor/` — the `fibernuts-processor` binary: serves the backend over gRPC
- `wallet/` — the demo RUSD ecash wallet (Vite + TypeScript)
- `deploy/` — `cdk-mintd` configuration and compose files
- `docs/` — specification, integration contract (authoritative)
- `Makefile` — task runner (delegates to `mint/`) · `.github/workflows/ci.yml` — CI
