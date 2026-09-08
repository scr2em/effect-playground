import { defineConfig } from "astro/config"
import react from "@astrojs/react"
import stylex from "@stylexjs/unplugin"

// https://astro.build/config
export default defineConfig({
  site: "https://scr2em.github.io",
  base: "/effect-playground",
  output: "static",
  trailingSlash: "always",
  integrations: [react()],
  vite: {
    plugins: [
      // StyleX: compile-time atomic CSS. Styles live in src/styles/*.stylex.ts and in
      // client modules via stylex.create(); apply with stylex.props().
      stylex.vite({ devMode: "css-only" })
    ]
  }
})
