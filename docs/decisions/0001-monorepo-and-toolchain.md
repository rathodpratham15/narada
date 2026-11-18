# 0001 — Monorepo and toolchain

Status: accepted

**Decision.** pnpm workspaces + Turborepo, TypeScript `~5.9.3` (strict, ESM, NodeNext), Node 22, Vitest 4,
Fastify 5, Zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, BullMQ 6, pino.

**Why.** Node 22 is required by current pdfjs-dist, and Node 20 is end-of-life soon. TypeScript 7 (native
rewrite) is the npm `latest` but tooling support is unverified, so we pin 5.9. Drizzle 1.0 is still RC. Vitest 4
runs on Node 20/22/24 and is what the neighbouring Sutriva repo already uses.

**Consequences.** Internal packages are consumed from TypeScript source via workspace `exports` pointing at
`src/index.ts`, with `moduleResolution: Bundler`. Processes run under `tsx`, tests under Vitest, and `tsc --noEmit` is
the typecheck. There is no compiled production build or container image yet; adding one (e.g. tsup/esbuild bundle)
is a deployment-phase task. Revisit TS 7 later.

**Workspace rule learned in M1.** `test-utils` depends on `database` (schema fixtures), so `database` cannot
depend on `test-utils` without a cycle. Tests that need both live in `tests/integration`.
