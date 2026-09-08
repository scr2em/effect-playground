/**
 * Node `--import` hook: installs the shared console formatter (src/runtime/format.ts) so learner
 * programs print exactly what the browser worker prints. Used by lib/run.ts:
 *   node --import tsx --import <this file> program.ts
 */
import { installConsole } from "../src/runtime/format.ts"

installConsole({
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n")
})
