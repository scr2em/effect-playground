/// <reference types="vitest" />
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import stylex from "@stylexjs/unplugin"

// Plain Vite config with the same React + StyleX plugins the Astro build uses.
// (Astro's getViteConfig works too but keeps two Vite servers alive for ~10s on shutdown.)
// UI tests declare `// @vitest-environment happy-dom` at the top of the file.
export default defineConfig({
  plugins: [react(), stylex.vite({ devMode: "css-only" })],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Something keeps Vite's servers open after the run (seen with both this config and Astro's
    // getViteConfig); do not wait the default 10s for them.
    teardownTimeout: 1_000
  }
})
