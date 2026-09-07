import { loadSections } from "../content/index.ts"
process.stdout.write(JSON.stringify(await loadSections()))
