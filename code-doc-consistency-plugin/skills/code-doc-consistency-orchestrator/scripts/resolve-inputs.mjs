#!/usr/bin/env node
/**
 * resolve-inputs.mjs — Phase 1 of orchestrator: deterministic input resolution.
 *
 * Resolves "what code path and what doc path should we compare" from a
 * priority chain:
 *   1. CLI argv overrides (--code=, --docs=, --output=, --focus=, --aliases=)
 *   2. Config file: code-doc-consistency.json at project root, or path passed via --config=
 *   3. Auto-discovery of docs (docs/ design/ specs/ doc/ + root README/ARCHITECTURE/DESIGN)
 *   4. Defaults (code = projectRoot itself, output = consistency_report.md)
 *
 * Validates every path it returns — no missing dirs, no empty doc set, no
 * code path outside the project. Returns a single inputs.json the LLM
 * orchestrator reads at Phase 1.
 *
 * Usage:
 *   node resolve-inputs.mjs <projectRoot> <outputPath>
 *     [--config=<path>]
 *     [--code=<path>] [--docs=<path1>,<path2>] [--output=<path>]
 *     [--focus=<pattern>] [--aliases=<path>]
 *     [--scope=<sub-path-of-code>]
 *
 * Output: inputs.json with shape:
 *   {
 *     "projectRoot": "...",
 *     "code": { "root": "...", "scope": "..."|null, "exists": true },
 *     "docs": { "roots": [...], "discovered": true|false, "fileCount": N },
 *     "output": { "path": "...", "format": "markdown" },
 *     "focus": "..."|null,
 *     "aliases": "..."|null,
 *     "warnings": [...]
 *   }
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename, sep } from 'node:path';

const DEFAULT_DOC_DIRS = ['docs', 'design', 'specs', 'doc', 'documentation'];
const ROOT_DOC_FILES = [
  'README.md', 'README.rst', 'readme.md',
  'ARCHITECTURE.md', 'DESIGN.md', 'API.md',
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq < 0) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

function loadConfig(configPath, projectRoot) {
  // Explicit path wins
  if (configPath && existsSync(configPath)) {
    try {
      return { config: JSON.parse(readFileSync(configPath, 'utf-8')), source: configPath };
    } catch (e) {
      throw new Error(`Failed to parse ${configPath}: ${e.message}`);
    }
  }
  // Default: code-doc-consistency.json at project root
  const defaultPath = join(projectRoot, 'code-doc-consistency.json');
  if (existsSync(defaultPath)) {
    try {
      return { config: JSON.parse(readFileSync(defaultPath, 'utf-8')), source: defaultPath };
    } catch (e) {
      throw new Error(`Failed to parse ${defaultPath}: ${e.message}`);
    }
  }
  return { config: null, source: null };
}

// ---------------------------------------------------------------------------
// Path resolution + validation
// ---------------------------------------------------------------------------

function resolveCodePath(value, projectRoot) {
  if (!value) return projectRoot;
  // Absolute paths pass through; relative resolved against projectRoot
  return value.startsWith('/') || /^[A-Za-z]:/.test(value)
    ? resolve(value)
    : resolve(projectRoot, value);
}

function isUnderProject(absPath, projectRoot) {
  // Both paths normalized (forward slashes, lowercase drive letters on Windows)
  const norm = p => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, l) => l.toLowerCase() + ':');
  return norm(absPath).startsWith(norm(projectRoot));
}

// ---------------------------------------------------------------------------
// Doc auto-discovery
// ---------------------------------------------------------------------------

function discoverDocs(projectRoot) {
  const found = [];

  // Doc directories
  for (const d of DEFAULT_DOC_DIRS) {
    const p = join(projectRoot, d);
    if (existsSync(p) && statSync(p).isDirectory()) {
      found.push(d);
    }
  }

  // Root-level doc files (only if no doc dirs found, to keep the set small)
  if (!found.length) {
    for (const f of ROOT_DOC_FILES) {
      if (existsSync(join(projectRoot, f))) {
        found.push(f);
      }
    }
  }

  return found;
}

function countDocsUnder(projectRoot, paths) {
  // Quickly count files matching doc-shaped extensions under the given paths
  const docExts = new Set([
    '.md', '.mdx', '.rst', '.txt',
    '.yaml', '.yml', '.json',
    '.puml', '.plantuml', '.mmd', '.mermaid',
    '.proto', '.graphql', '.gql',
  ]);
  let total = 0;
  function walk(absDir) {
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.git', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build'].includes(e.name)) continue;
      const child = join(absDir, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) {
        const ext = e.name.toLowerCase().match(/\.[^.]+$/)?.[0];
        if (ext && docExts.has(ext)) total++;
      }
    }
  }
  for (const p of paths) {
    const abs = join(projectRoot, p);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isFile()) total++;
    else walk(abs);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Main resolution logic
// ---------------------------------------------------------------------------

function resolve_inputs(projectRoot, flags) {
  const warnings = [];
  const { config, source: configSource } = loadConfig(flags.config, projectRoot);

  // -- code path --
  let codeRoot = flags.code
    || (config && config.code && config.code.root)
    || null;
  if (codeRoot) codeRoot = resolveCodePath(codeRoot, projectRoot);
  else codeRoot = projectRoot;

  if (!existsSync(codeRoot)) {
    throw new Error(`Code path does not exist: ${codeRoot}`);
  }
  if (!statSync(codeRoot).isDirectory()) {
    throw new Error(`Code path is not a directory: ${codeRoot}`);
  }
  if (!isUnderProject(codeRoot, projectRoot) && codeRoot !== projectRoot) {
    warnings.push(`Code path ${codeRoot} is outside project root ${projectRoot}; this is allowed but unusual.`);
  }

  // -- code scope (sub-path filter) --
  const codeScope = flags.scope || (config && config.code && config.code.scope) || null;
  if (codeScope) {
    const scopeAbs = join(codeRoot, codeScope);
    if (!existsSync(scopeAbs)) {
      throw new Error(`Code scope path does not exist: ${scopeAbs}`);
    }
  }

  // -- doc paths --
  let docRoots = [];
  let discovered = false;

  if (flags.docs) {
    docRoots = flags.docs.split(',').map(p => p.trim()).filter(Boolean);
  } else if (config && config.docs && Array.isArray(config.docs.roots)) {
    docRoots = config.docs.roots;
  } else {
    docRoots = discoverDocs(projectRoot);
    discovered = true;
    if (!docRoots.length) {
      throw new Error(
        `No documentation paths found. Searched: ${DEFAULT_DOC_DIRS.join(', ')} + ${ROOT_DOC_FILES.join(', ')}.\n` +
        `Provide --docs=<path1>,<path2> or create code-doc-consistency.json.`
      );
    }
    warnings.push(`Auto-discovered docs: ${docRoots.join(', ')} (override with --docs= or config file)`);
  }

  // Validate each doc path exists
  for (const d of docRoots) {
    const abs = join(projectRoot, d);
    if (!existsSync(abs)) {
      throw new Error(`Doc path does not exist: ${abs} (relative to ${projectRoot})`);
    }
  }
  const fileCount = countDocsUnder(projectRoot, docRoots);
  if (fileCount === 0) {
    warnings.push(`No doc-shaped files found under: ${docRoots.join(', ')}. Doc graph will be empty.`);
  }

  // -- output --
  const outputPath = flags.output
    || (config && config.output && config.output.path)
    || 'consistency_report.md';
  const outputAbs = outputPath.startsWith('/') || /^[A-Za-z]:/.test(outputPath)
    ? outputPath
    : resolve(projectRoot, outputPath);

  // -- focus filter --
  const focus = flags.focus
    || (config && config.focus)
    || null;

  // -- aliases --
  let aliases = flags.aliases
    || (config && config.aliases)
    || null;
  if (aliases) {
    const aliasAbs = aliases.startsWith('/') || /^[A-Za-z]:/.test(aliases)
      ? aliases
      : resolve(projectRoot, aliases);
    if (!existsSync(aliasAbs)) {
      warnings.push(`Aliases file specified but not found: ${aliasAbs}; will proceed without aliases.`);
      aliases = null;
    } else {
      try {
        JSON.parse(readFileSync(aliasAbs, 'utf-8'));
        aliases = aliasAbs;
      } catch (e) {
        warnings.push(`Aliases file ${aliasAbs} is not valid JSON: ${e.message}; will proceed without.`);
        aliases = null;
      }
    }
  }

  return {
    projectRoot,
    code: {
      root: codeRoot,
      scope: codeScope,
      exists: true,
    },
    docs: {
      roots: docRoots,
      discovered,
      fileCount,
    },
    output: {
      path: outputAbs,
      format: outputPath.endsWith('.json') ? 'json' : 'markdown',
    },
    focus,
    aliases,
    config_source: configSource,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [projectRootRaw, outputPath] = positional;
  if (!projectRootRaw || !outputPath) {
    process.stderr.write(
      'Usage: node resolve-inputs.mjs <projectRoot> <outputPath>\n' +
      '  [--config=<path>]\n' +
      '  [--code=<path>] [--docs=<comma-list>] [--output=<path>]\n' +
      '  [--focus=<patt>] [--aliases=<path>] [--scope=<rel-path>]\n'
    );
    process.exit(1);
  }
  const projectRoot = resolve(projectRootRaw);
  if (!existsSync(projectRoot)) {
    process.stderr.write(`Error: project root does not exist: ${projectRoot}\n`);
    process.exit(1);
  }

  let resolved;
  try {
    resolved = resolve_inputs(projectRoot, flags);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(resolved, null, 2));

  process.stderr.write(
    `resolve-inputs: code=${resolved.code.root}` +
    (resolved.code.scope ? ` scope=${resolved.code.scope}` : '') +
    ` docs=[${resolved.docs.roots.join(',')}] (${resolved.docs.fileCount} files` +
    (resolved.docs.discovered ? ', auto' : '') +
    `) output=${resolved.output.path}` +
    (resolved.warnings.length ? ` warnings=${resolved.warnings.length}` : '') +
    '\n'
  );
}

main();
