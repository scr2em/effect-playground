/**
 * Turns learner TypeScript into a browser-loadable ES module: ts.transpileModule (no type
 * checking, ESNext modules, ES2022 target) plus a transformer that rewrites `"effect"` and
 * `"effect/testing"` module specifiers (static imports, re-exports and `import()`) to the URLs
 * of the prebuilt bundles. Pure TypeScript: used by typecheck.worker.ts in the browser and by
 * tests/runtime/exec-smoke.test.ts in Node.
 */
import ts from "typescript-js"

export interface EffectUrls {
  effect: string
  testing: string
}

export function transpile(code: string, urls: EffectUrls): string {
  const map = (specifier: string) => (specifier === "effect" ? urls.effect : specifier === "effect/testing" ? urls.testing : undefined)
  const rewrite: ts.TransformerFactory<ts.SourceFile> = (ctx) => (sf) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const to = map(node.moduleSpecifier.text)
        if (to) return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, ts.factory.createStringLiteral(to), node.attributes)
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const to = map(node.moduleSpecifier.text)
        if (to) return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, ts.factory.createStringLiteral(to), node.attributes)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
        const to = map(node.arguments[0].text)
        if (to) return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [ts.factory.createStringLiteral(to)])
      }
      return ts.visitEachChild(node, visit, ctx)
    }
    return ts.visitEachChild(sf, visit, ctx)
  }
  const out = ts.transpileModule(code, {
    fileName: "playground.ts",
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
      sourceMap: false
    },
    transformers: { before: [rewrite] }
  })
  return out.outputText
}
