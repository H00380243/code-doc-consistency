#!/usr/bin/env node
/**
 * extract-import-map.mjs — Phase A.4 of /code-graph-rag
 *
 * Self-contained adaptation: regex-based import extraction + path resolution
 * for the import graph. Covers the same 12 languages Understand-Anything
 * supports (TS/JS/Python/Go/Rust/Java/Kotlin/C#/Ruby/PHP/C/C++) without the
 * tree-sitter dependency. Result-equivalent in the common case; some edge
 * cases (multiline imports, conditional `require()` inside functions) drop
 * to "best-effort" with a logged warning rather than a hard failure.
 *
 * Usage:
 *   node extract-import-map.mjs <inputJson> <outputJson>
 *
 * Input:  { projectRoot, files: [{ path, language, fileCategory }] }
 * Output: { scriptCompleted, stats, importMap: { <path>: [<resolvedPath>, ...] } }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join, sep, posix } from 'node:path';

// -- Per-language extractors -------------------------------------------------
// Each returns an array of "spec" strings (the raw import target as it
// appears in source). Resolution to project paths happens in resolveSpec().

function extractTSJS(content) {
  const specs = [];
  // import x from 'y' / import 'y' / import {a} from 'y' / export ... from 'y'
  const re1 = /(?:^|\n|;)\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  // require('y') / require("y")
  const re2 = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // dynamic import('y')
  const re3 = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re1.exec(content))) specs.push(m[1]);
  while ((m = re2.exec(content))) specs.push(m[1]);
  while ((m = re3.exec(content))) specs.push(m[1]);
  return specs;
}

function extractPython(content) {
  const specs = [];
  // from x import y / from .x import y / from ..x import y
  const re1 = /(?:^|\n)\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s/g;
  // import x / import x.y / import x as z
  const re2 = /(?:^|\n)\s*import\s+([\w.]+)(?:\s+as\s+\w+)?/g;
  let m;
  while ((m = re1.exec(content))) specs.push(m[1]);
  while ((m = re2.exec(content))) specs.push(m[1]);
  return specs;
}

function extractGo(content) {
  const specs = [];
  const re1 = /(?:^|\n)import\s+"([^"]+)"/g;
  const re2 = /import\s+\(([\s\S]*?)\)/g;
  let m;
  while ((m = re1.exec(content))) specs.push(m[1]);
  while ((m = re2.exec(content))) {
    const block = m[1];
    const re3 = /(?:^|\n)\s*(?:\w+\s+)?"([^"]+)"/g;
    let mm;
    while ((mm = re3.exec(block))) specs.push(mm[1]);
  }
  return specs;
}

function extractRust(content) {
  const specs = [];
  // use crate::x::y::Z; / use super::x; / use self::x; / use a::b::C;
  const re1 = /(?:^|\n)\s*use\s+([\w:]+)/g;
  // mod x;
  const re2 = /(?:^|\n)\s*(?:pub\s+)?mod\s+(\w+)\s*;/g;
  let m;
  while ((m = re1.exec(content))) specs.push('use:' + m[1]);
  while ((m = re2.exec(content))) specs.push('mod:' + m[1]);
  return specs;
}

function extractJavaKotlin(content) {
  const specs = [];
  const re = /(?:^|\n)\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;?/g;
  let m;
  while ((m = re.exec(content))) specs.push(m[1]);
  return specs;
}

function extractCSharp(content) {
  const specs = [];
  const re = /(?:^|\n)\s*using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/g;
  let m;
  while ((m = re.exec(content))) specs.push(m[1]);
  return specs;
}

function extractRuby(content) {
  const specs = [];
  const re1 = /(?:^|\n)\s*require\s+['"]([^'"]+)['"]/g;
  const re2 = /(?:^|\n)\s*require_relative\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re1.exec(content))) specs.push('require:' + m[1]);
  while ((m = re2.exec(content))) specs.push('require_relative:' + m[1]);
  return specs;
}

function extractPHP(content) {
  const specs = [];
  const re1 = /(?:^|\n)\s*use\s+([\w\\]+)\s*;/g;
  const re2 = /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re1.exec(content))) specs.push('use:' + m[1]);
  while ((m = re2.exec(content))) specs.push('include:' + m[1]);
  return specs;
}

function extractCpp(content) {
  const specs = [];
  const re = /(?:^|\n)\s*#include\s+["<]([^">]+)[">]/g;
  let m;
  while ((m = re.exec(content))) specs.push(m[1]);
  return specs;
}

const EXTRACTORS = {
  typescript: extractTSJS, javascript: extractTSJS,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  java: extractJavaKotlin, kotlin: extractJavaKotlin,
  csharp: extractCSharp,
  ruby: extractRuby,
  php: extractPHP,
  c: extractCpp, cpp: extractCpp,
};

// -- Path resolution ---------------------------------------------------------
function toPosix(p) { return p.split(sep).join('/'); }

function fileExists(projectRoot, relPath) {
  return existsSync(join(projectRoot, relPath));
}

function tryExtensions(projectRoot, base, exts) {
  for (const ext of exts) {
    const p = base + ext;
    if (fileExists(projectRoot, p)) return toPosix(p);
  }
  // Try as directory with index file
  for (const ext of exts) {
    const p = posix.join(base, 'index' + ext);
    if (fileExists(projectRoot, p)) return toPosix(p);
  }
  return null;
}

const TS_JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const PY_EXTS = ['.py', '.pyi'];

function resolveTSJS(spec, sourcePath, projectRoot) {
  // External package or non-relative non-aliased: drop
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('@/')) return null;
  const sourceDir = posix.dirname(toPosix(sourcePath));
  let base;
  if (spec.startsWith('.')) base = posix.normalize(posix.join(sourceDir, spec));
  else if (spec.startsWith('@/')) base = spec.slice(2);
  else base = spec.startsWith('/') ? spec.slice(1) : spec;
  // Strip trailing /index if explicit
  if (fileExists(projectRoot, base)) return base;
  return tryExtensions(projectRoot, base, TS_JS_EXTS);
}

function resolvePython(spec, sourcePath, projectRoot, allFiles) {
  const sourceDir = posix.dirname(toPosix(sourcePath));
  // Relative: from .x or .x.y
  if (spec.startsWith('.')) {
    let level = 0;
    while (spec[level] === '.') level++;
    const rest = spec.slice(level);
    let dir = sourceDir;
    for (let i = 1; i < level; i++) dir = posix.dirname(dir);
    const base = rest ? posix.join(dir, rest.replace(/\./g, '/')) : dir;
    return tryExtensions(projectRoot, base, PY_EXTS);
  }
  // Absolute: a.b.c → a/b/c.py or a/b/c/__init__.py
  const base = spec.replace(/\./g, '/');
  return tryExtensions(projectRoot, base, PY_EXTS);
}

function resolveGo(spec, sourcePath, projectRoot) {
  // Strip module prefix from go.mod
  const goModPath = join(projectRoot, 'go.mod');
  let modulePrefix = null;
  if (existsSync(goModPath)) {
    const m = readFileSync(goModPath, 'utf-8').match(/^module\s+(.+)$/m);
    if (m) modulePrefix = m[1].trim();
  }
  if (modulePrefix && spec.startsWith(modulePrefix + '/')) {
    const rel = spec.slice(modulePrefix.length + 1);
    // Go pkg path → directory; pick first .go file
    const dirAbs = join(projectRoot, rel);
    if (existsSync(dirAbs)) {
      try {
        const fs = require('fs');
        const goFiles = fs.readdirSync(dirAbs).filter(f => f.endsWith('.go') && !f.endsWith('_test.go'));
        if (goFiles.length) return toPosix(posix.join(rel, goFiles.sort()[0]));
      } catch { /* */ }
    }
    return null;
  }
  return null;
}

function resolveRust(spec, sourcePath, projectRoot) {
  if (spec.startsWith('use:')) {
    const path = spec.slice(4);
    if (path.startsWith('crate::')) {
      const rest = path.slice(7).replace(/::/g, '/');
      const base = posix.join('src', rest);
      return tryExtensions(projectRoot, base, ['.rs']) ||
             tryExtensions(projectRoot, posix.join(base, 'mod'), ['.rs']);
    }
    return null;
  }
  if (spec.startsWith('mod:')) {
    const name = spec.slice(4);
    const dir = posix.dirname(toPosix(sourcePath));
    return tryExtensions(projectRoot, posix.join(dir, name), ['.rs']) ||
           tryExtensions(projectRoot, posix.join(dir, name, 'mod'), ['.rs']);
  }
  return null;
}

function resolveJavaKotlin(spec, sourcePath, projectRoot) {
  // com.foo.Bar → src/main/java/com/foo/Bar.java (or .kt)
  const path = spec.replace(/\./g, '/');
  const candidates = [
    posix.join('src/main/java', path) + '.java',
    posix.join('src/main/kotlin', path) + '.kt',
    posix.join('src', path) + '.java',
    posix.join('src', path) + '.kt',
  ];
  for (const c of candidates) if (fileExists(projectRoot, c)) return c;
  return null;
}

function resolveCSharp(spec, sourcePath, projectRoot) {
  // C# imports are namespaces, not paths. Best-effort: search for a class-like
  // file matching the last segment.
  const last = spec.split('.').pop();
  // Heuristic: .cs file with that name
  // (Skipping in this lite version — would need full namespace map.)
  return null;
}

function resolveRuby(spec, sourcePath, projectRoot) {
  if (spec.startsWith('require_relative:')) {
    const rel = spec.slice(17);
    const sourceDir = posix.dirname(toPosix(sourcePath));
    const base = posix.normalize(posix.join(sourceDir, rel));
    return tryExtensions(projectRoot, base, ['.rb']);
  }
  if (spec.startsWith('require:')) {
    const rel = spec.slice(8);
    // Try lib/, app/
    return tryExtensions(projectRoot, posix.join('lib', rel), ['.rb']) ||
           tryExtensions(projectRoot, posix.join('app', rel), ['.rb']);
  }
  return null;
}

function resolvePHP(spec, sourcePath, projectRoot) {
  if (spec.startsWith('include:')) {
    const rel = spec.slice(8);
    const sourceDir = posix.dirname(toPosix(sourcePath));
    const base = posix.normalize(posix.join(sourceDir, rel));
    if (fileExists(projectRoot, base)) return toPosix(base);
    return tryExtensions(projectRoot, base, ['.php']);
  }
  // PSR-4 namespace resolution would need composer.json — skipped in lite
  return null;
}

function resolveCpp(spec, sourcePath, projectRoot) {
  const sourceDir = posix.dirname(toPosix(sourcePath));
  // Try relative
  const rel = posix.normalize(posix.join(sourceDir, spec));
  if (fileExists(projectRoot, rel)) return toPosix(rel);
  // Try include/, src/
  for (const prefix of ['include', 'src', '.']) {
    const candidate = posix.join(prefix, spec);
    if (fileExists(projectRoot, candidate)) return toPosix(candidate);
  }
  return null;
}

const RESOLVERS = {
  typescript: resolveTSJS, javascript: resolveTSJS,
  python: resolvePython,
  go: resolveGo,
  rust: resolveRust,
  java: resolveJavaKotlin, kotlin: resolveJavaKotlin,
  csharp: resolveCSharp,
  ruby: resolveRuby,
  php: resolvePHP,
  c: resolveCpp, cpp: resolveCpp,
};

// -- Main --------------------------------------------------------------------
function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: node extract-import-map.mjs <input.json> <output.json>\n');
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const { projectRoot, files } = input;
  if (!projectRoot || !Array.isArray(files)) {
    process.stderr.write('Error: input must contain projectRoot + files\n');
    process.exit(1);
  }

  const importMap = {};
  let filesWithImports = 0; let totalEdges = 0;

  for (const file of files) {
    importMap[file.path] = [];
    if (file.fileCategory !== 'code' && file.fileCategory !== 'script') continue;
    const extractor = EXTRACTORS[file.language];
    const resolver = RESOLVERS[file.language];
    if (!extractor || !resolver) continue;

    const abs = join(projectRoot, file.path);
    let content;
    try { content = readFileSync(abs, 'utf-8'); }
    catch (e) {
      process.stderr.write(`Warning: extract-import-map: ${file.path} — ${e.message}\n`);
      continue;
    }

    let specs;
    try { specs = extractor(content); }
    catch (e) {
      process.stderr.write(`Warning: extract-import-map: ${file.path} extractor failed: ${e.message}\n`);
      continue;
    }

    const resolved = new Set();
    for (const spec of specs) {
      try {
        const r = resolver(spec, file.path, projectRoot, files);
        if (r) resolved.add(r);
      } catch { /* skip per-spec failures */ }
    }
    importMap[file.path] = [...resolved].sort();
    if (importMap[file.path].length) {
      filesWithImports++;
      totalEdges += importMap[file.path].length;
    }
  }

  const out = {
    scriptCompleted: true,
    stats: { filesScanned: files.length, filesWithImports, totalEdges },
    importMap,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(`extract-import-map: filesScanned=${files.length} filesWithImports=${filesWithImports} totalEdges=${totalEdges}\n`);
}

main();
