/**
 * Single switch between the real runtime (src/runtime/client.ts, src/runtime/editor.ts) and the
 * UI-owned stubs. To flip to the real runtime, change the line below to:
 *   export * from "./runtime-bridge.real"
 */
export * from "./runtime-bridge.real"
