#!/usr/bin/env node
/**
 * discover-docs.mjs — Phase A (DISCOVER) of /doc-graph-rag
 *
 * Self-contained adaptation: file enumeration + doc-type classification for
 * the doc-graph-builder. Mirrors scan-project.mjs's structure but with a
 * doc-specific category map (markdown/openapi/mermaid/plantuml/proto/...).
 *
 * Usage:
 *   node discover-docs.mjs <projectRoot> <outputPath> [--scope=<docs-dir>]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, extname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_DOC_DIRS = ['docs', 'design', 'specs', 'doc', 'documentation', 'api'];
const ROOT_DOC_FILES = [
  'README.md', 'README.rst', 'readme.md',
  'ARCHITECTURE.md', 'DESIGN.md', 'CONTRIBUTING.md',
  'CHANGELOG.md', 'API.md',
];

const DEFAULT_IGNORES = [
  'node_modules', '.git', 'vendor', 'venv', '.venv',
  '__pycache__', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', 'target',
];

function detectDocType(relPath, content) {
  const fname = basename(relPath);
  const ext = extname(fname).toLowerCase();
  const lower = relPath.toLowerCase();

  if (['.md', '.mdx', '.rst', '.txt'].includes(ext)) return 'markdown';
  if (['.puml', '.plantuml', '.pu'].includes(ext)) return 'plantuml';
  if (['.mmd', '.mermaid'].includes(ext)) return 'mermaid';
  if (['.proto'].includes(ext)) return 'proto';
  if (['.graphql', '.gql'].includes(ext)) return 'graphql';
  if (lower.endsWith('.schema.json') || lower.endsWith('.json-schema')) return 'jsonschema';

  // OpenAPI / Swagger detection — check filename hints + content
  if (['.yaml', '.yml', '.json'].includes(ext)) {
    if (/openapi|swagger/i.test(fname)) {
      return 'openapi';
    }
    if (content) {
      const head = content.slice(0, 500);
      if (/^\s*(?:openapi|swagger):\s*['"]?\d/m.test(head) || /"openapi"\s*:\s*"\d/.test(head) || /"swagger"\s*:\s*"\d/.test(head)) {
        return 'openapi';
      }
    }
  }

  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.drawio', '.pdf'].includes(ext)) return 'binary';
  return 'other';
}

function shouldIgnore(relPath) {
  const segments = relPath.split(sep);
  for (const seg of segments) {
    if (DEFAULT_IGNORES.includes(seg)) return true;
  }
  return false;
}

function tryGitLsFiles(root) {
  try {
    const r = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && r.stdout) {
      return r.stdout.split(/\r?\n/).filter(Boolean);
    }
  } catch { /* */ }
  return null;
}

function walkDir(root, rel = '', acc = []) {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); }
  catch { return acc; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (DEFAULT_IGNORES.includes(e.name)) continue;
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) walkDir(root, r, acc);
    else if (e.isFile()) acc.push(r.split(sep).join('/'));
  }
  return acc;
}

function countLines(absPath) {
  try {
    const buf = readFileSync(absPath);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    if (buf.length && buf[buf.length - 1] !== 0x0a) n++;
    return n;
  } catch { return 0; }
}

function main() {
  const args = process.argv.slice(2);
  const root = args[0]; const outPath = args[1];
  if (!root || !outPath) {
    process.stderr.write('Usage: node discover-docs.mjs <projectRoot> <outputPath> [--scope=<dir>]\n');
    process.exit(1);
  }
  const scopeArg = args.find(a => a.startsWith('--scope='));
  const scope = scopeArg ? scopeArg.slice(8) : null;

  // Enumerate candidate files
  let candidates = tryGitLsFiles(root);
  if (!candidates) {
    candidates = walkDir(root);
    process.stderr.write(`discover-docs: git ls-files unavailable, fell back to fs walk\n`);
  } else {
    candidates = candidates.map(p => p.split(sep).join('/'));
  }

  // Filter to doc candidates: anything in DEFAULT_DOC_DIRS, ROOT_DOC_FILES, or with doc-shaped extensions
  const docs = [];
  const byType = {};

  for (const rel of candidates) {
    if (shouldIgnore(rel)) continue;
    if (scope && !rel.startsWith(scope)) continue;

    const segments = rel.split('/');
    const inDocDir = DEFAULT_DOC_DIRS.includes(segments[0]);
    const isRootDoc = segments.length === 1 && ROOT_DOC_FILES.includes(rel);
    const ext = extname(rel).toLowerCase();
    const docExt = ['.md', '.mdx', '.rst', '.puml', '.plantuml', '.mmd', '.mermaid', '.proto', '.graphql', '.gql'].includes(ext);
    const apiExt = ['.yaml', '.yml', '.json'].includes(ext) && (/openapi|swagger|api/i.test(rel));

    if (!inDocDir && !isRootDoc && !docExt && !apiExt) continue;

    const abs = join(root, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;

    let content = null;
    let docType;
    // For YAML/JSON we need to peek at content to detect openapi vs plain config
    if (['.yaml', '.yml', '.json'].includes(ext)) {
      try { content = readFileSync(abs, 'utf-8'); } catch { /* */ }
      docType = detectDocType(rel, content);
      if (docType === 'other' && !apiExt) continue; // plain config in docs/ — skip
    } else {
      docType = detectDocType(rel, null);
    }

    const sizeLines = countLines(abs);
    docs.push({ path: rel, docType, sizeLines });
    byType[docType] = (byType[docType] || 0) + 1;
  }

  docs.sort((a, b) => a.path.localeCompare(b.path));

  const out = {
    scriptCompleted: true,
    documents: docs,
    totalDocuments: docs.length,
    byType,
    scope: scope || null,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  process.stderr.write(`discover-docs: total=${docs.length} types=${JSON.stringify(byType)}\n`);
}

main();
