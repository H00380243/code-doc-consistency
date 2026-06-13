#!/usr/bin/env node
/**
 * scan-project.mjs — Phase A (SCAN) of /code-graph-rag
 *
 * Self-contained adaptation of Understand-Anything's scan-project.mjs.
 * Removes the @understand-anything/core dependency in favor of inline
 * tables + Node.js stdlib only. Result-equivalent for the file enumeration
 * + language/category detection + line counting that this harness needs.
 *
 * Usage:
 *   node scan-project.mjs <projectRoot> <outputPath> [--ignore=<file>]
 *
 * Output: see end of file. stderr-only logging.
 */

import { dirname, join, basename, extname, relative, sep } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// -- Language detection ------------------------------------------------------
const LANGUAGE_BY_EXT = Object.freeze({
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'csharp', '.fs': 'fsharp', '.vb': 'vb',
  '.swift': 'swift', '.m': 'objective-c', '.mm': 'objective-c',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cxx': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
  '.rb': 'ruby', '.php': 'php',
  '.lua': 'lua', '.dart': 'dart', '.scala': 'scala',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
  '.bat': 'batch', '.cmd': 'batch',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
  '.proto': 'protobuf', '.prisma': 'prisma',
  '.md': 'markdown', '.mdx': 'markdown', '.rst': 'restructuredtext',
  '.txt': 'plaintext', '.text': 'plaintext',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.toml': 'toml', '.xml': 'xml', '.xsd': 'xml', '.xsl': 'xml',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.tf': 'terraform', '.tfvars': 'terraform',
  '.csv': 'csv', '.tsv': 'csv',
  '.env': 'env',
  '.cfg': 'ini', '.ini': 'ini', '.properties': 'properties',
  '.lock': 'lock',
});

const LANGUAGE_BY_FILENAME = Object.freeze({
  'Dockerfile': 'dockerfile',
  'Makefile': 'makefile',
  'Jenkinsfile': 'jenkinsfile',
  'Procfile': 'plaintext',
  'Vagrantfile': 'ruby',
  'Gemfile': 'ruby',
  'Rakefile': 'ruby',
  'CMakeLists.txt': 'cmake',
});

function detectLanguage(filename) {
  if (LANGUAGE_BY_FILENAME[filename]) return LANGUAGE_BY_FILENAME[filename];
  // Filename-prefix matches (Dockerfile.dev, docker-compose.yml etc.)
  if (filename.startsWith('Dockerfile')) return 'dockerfile';
  const ext = extname(filename).toLowerCase();
  if (ext && LANGUAGE_BY_EXT[ext]) return LANGUAGE_BY_EXT[ext];
  if (!ext && !filename.includes('.')) return 'unknown';
  return ext.slice(1).toLowerCase() || 'unknown';
}

// -- File-category routing ---------------------------------------------------
// Priority: filename/path rules fire before extension rules.
function categorize(relPath, language) {
  const fname = basename(relPath);
  const lower = relPath.toLowerCase().split(sep).join('/');

  // LICENSE is code (exception)
  if (fname === 'LICENSE' || fname === 'LICENSE.md' || fname === 'LICENSE.txt') return 'code';

  // Infrastructure (filename / path)
  if (
    fname === 'Dockerfile' || fname.startsWith('Dockerfile.') ||
    fname === 'docker-compose.yml' || fname === 'docker-compose.yaml' ||
    fname.startsWith('docker-compose.') || fname === 'compose.yml' || fname === 'compose.yaml' ||
    fname === 'Makefile' || fname === 'Jenkinsfile' || fname === 'Procfile' ||
    fname === 'Vagrantfile' || fname === '.gitlab-ci.yml' || fname === '.dockerignore' ||
    lower.startsWith('.github/workflows/') ||
    lower.startsWith('.circleci/') ||
    lower.includes('/k8s/') || lower.startsWith('k8s/') ||
    lower.includes('/kubernetes/') || lower.startsWith('kubernetes/') ||
    /\.k8s\.ya?ml$/i.test(fname)
  ) return 'infra';

  if (language === 'terraform') return 'infra';

  // Data
  if (['sql', 'graphql', 'protobuf', 'prisma', 'csv'].includes(language)) return 'data';

  // Docs
  if (['markdown', 'restructuredtext', 'plaintext'].includes(language)) return 'docs';

  // Config
  if (
    ['yaml', 'json', 'toml', 'xml', 'ini', 'env', 'properties', 'lock'].includes(language) ||
    /\.(csproj|sln|gradle|mod|sum)$/i.test(fname) ||
    fname === 'package.json' || fname === 'package-lock.json' || fname === 'pnpm-lock.yaml' ||
    fname === 'yarn.lock' || fname === 'pyproject.toml' || fname === 'Cargo.toml'
  ) return 'config';

  // Script
  if (['shell', 'powershell', 'batch'].includes(language)) return 'script';

  // Markup
  if (['html', 'css', 'scss', 'less'].includes(language)) return 'markup';

  // Default: code
  return 'code';
}

// -- Ignore filter -----------------------------------------------------------
const DEFAULT_IGNORES = [
  'node_modules', '.git', 'vendor', 'venv', '.venv',
  '__pycache__', 'dist', 'build', 'out', 'coverage',
  '.next', '.cache', '.turbo', 'target', 'obj', '.idea', '.vscode',
];

function loadIgnore(ignoreFile) {
  if (!ignoreFile || !existsSync(ignoreFile)) return [];
  return readFileSync(ignoreFile, 'utf-8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function shouldIgnore(relPath, ignorePatterns) {
  const segments = relPath.split(sep);
  for (const seg of segments) {
    if (DEFAULT_IGNORES.includes(seg)) return { ignored: true, reason: 'default' };
  }
  // ext-based defaults
  const fname = basename(relPath);
  if (/\.(lock|map)$/.test(fname)) return { ignored: true, reason: 'default' };
  if (/\.min\.(js|css)$/.test(fname)) return { ignored: true, reason: 'default' };
  if (/\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|mp[34]|pdf|zip|tar|gz)$/i.test(fname)) {
    return { ignored: true, reason: 'binary' };
  }

  // user patterns (gitignore-style, simplified — no negation, glob → contains)
  for (const pat of ignorePatterns) {
    if (pat.endsWith('/')) {
      const dir = pat.slice(0, -1);
      if (segments.includes(dir)) return { ignored: true, reason: 'user' };
    } else if (pat.includes('*')) {
      const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      if (re.test(fname)) return { ignored: true, reason: 'user' };
    } else if (relPath === pat || segments.includes(pat)) {
      return { ignored: true, reason: 'user' };
    }
  }
  return { ignored: false };
}

// -- File enumeration --------------------------------------------------------
function tryGitLsFiles(root) {
  try {
    const r = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && r.stdout) {
      return r.stdout.split(/\r?\n/).filter(Boolean);
    }
  } catch { /* fall through */ }
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

function complexityFromCount(n) {
  if (n < 30) return 'small';
  if (n < 150) return 'moderate';
  if (n < 600) return 'large';
  return 'very-large';
}

// -- Main --------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const root = args[0]; const outPath = args[1];
  if (!root || !outPath) {
    process.stderr.write('Usage: node scan-project.mjs <projectRoot> <outputPath> [--ignore=<file>]\n');
    process.exit(1);
  }
  const ignoreArg = args.find(a => a.startsWith('--ignore='));
  const ignoreFile = ignoreArg ? ignoreArg.slice(9) : null;
  const userIgnore = loadIgnore(ignoreFile);

  let candidates = tryGitLsFiles(root);
  if (!candidates) {
    candidates = walkDir(root);
    process.stderr.write(`scan-project: git ls-files unavailable, fell back to fs walk (${candidates.length} candidates)\n`);
  } else {
    candidates = candidates.map(p => p.split(sep).join('/'));
  }

  const files = [];
  let filteredByIgnore = 0;
  const byCategory = {}; const byLanguage = {};

  for (const rel of candidates) {
    const decision = shouldIgnore(rel, userIgnore);
    if (decision.ignored) {
      if (decision.reason === 'user') filteredByIgnore++;
      continue;
    }
    const abs = join(root, rel);
    let st;
    try { st = statSync(abs); }
    catch (e) {
      process.stderr.write(`Warning: scan-project: ${rel} — ${e.message} — file skipped from output\n`);
      continue;
    }
    if (!st.isFile()) continue;
    const language = detectLanguage(basename(rel));
    const fileCategory = categorize(rel, language);
    const sizeLines = countLines(abs);
    files.push({ path: rel, language, sizeLines, fileCategory });
    byCategory[fileCategory] = (byCategory[fileCategory] || 0) + 1;
    byLanguage[language] = (byLanguage[language] || 0) + 1;
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const totalFiles = files.length;
  const estimatedComplexity = complexityFromCount(totalFiles);

  const out = {
    scriptCompleted: true,
    files,
    totalFiles,
    filteredByIgnore,
    estimatedComplexity,
    stats: { filesScanned: totalFiles, byCategory, byLanguage },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  process.stderr.write(`scan-project: filesScanned=${totalFiles} filteredByIgnore=${filteredByIgnore} complexity=${estimatedComplexity}\n`);
}

main();
