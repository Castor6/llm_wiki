// Cross-platform, explicit opt-in to a few synthetic TypeSafe API requests.
// Vitest's existing setup reads .env.test.local; never print its contents.
import { spawnSync } from "node:child_process"
const result = spawnSync(process.execPath, [
  "node_modules/vitest/vitest.mjs", "run", "src/lib/jev-client.real-llm.test.ts",
  "--no-file-parallelism", "--reporter=verbose",
], { stdio: "inherit", env: { ...process.env, RUN_JEV_LIVE_TESTS: "1" } })
process.exit(result.status ?? 1)
