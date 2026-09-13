import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const workRoot = path.resolve(repoRoot, 'work');
mkdirSync(workRoot, { recursive: true });
const buildRoot = mkdtempSync(path.join(workRoot, 'parts-tests-'));
const compiled = new Map();

process.once('exit', () => {
  const resolved = path.resolve(buildRoot);
  if (resolved.startsWith(`${workRoot}${path.sep}`) && path.basename(resolved).startsWith('parts-tests-')) {
    rmSync(resolved, { recursive: true, force: true });
  }
});

function compile(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (compiled.has(resolved)) return compiled.get(resolved);
  if (!resolved.startsWith(`${path.resolve(repoRoot)}${path.sep}`)) throw new Error('Test module must be inside repository');
  const destination = path.join(buildRoot, path.relative(repoRoot, resolved).replace(/\.(?:ts|mts|tsx)$/, '.mjs'));
  compiled.set(resolved, destination);
  const result = ts.transpileModule(readFileSync(resolved, 'utf8'), {
    fileName: resolved,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  });
  const ast = ts.createSourceFile(destination, result.outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const replacements = [];
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) specifier = node.arguments[0];
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      const base = path.resolve(path.dirname(resolved), specifier.text);
      const dependency = [base, `${base}.ts`, `${base}.mts`, `${base}.tsx`, path.join(base, 'index.ts')]
        .find((candidate) => /\.(?:ts|mts|tsx)$/.test(candidate) && existsSync(candidate));
      if (!dependency) throw new Error(`Cannot compile test dependency ${specifier.text} in ${resolved}`);
      replacements.push({ start: specifier.getStart(ast), end: specifier.getEnd(), text: JSON.stringify(pathToFileURL(compile(dependency)).href) });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let output = result.outputText;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, output);
  return destination;
}

/** Compile actual source modules for Node tests without modifying application code. */
export async function loadTypeScript(relativePath) {
  return import(pathToFileURL(compile(path.resolve(repoRoot, relativePath))).href);
}
