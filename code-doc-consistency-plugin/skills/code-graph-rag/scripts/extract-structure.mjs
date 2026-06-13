#!/usr/bin/env node
/**
 * extract-structure.mjs — Phase C.1 of /code-graph-rag (per-file extraction)
 *
 * Self-contained adaptation: regex/heuristic-based extraction of functions,
 * classes, exports, and non-code structural elements (services, endpoints,
 * steps, resources). Trades tree-sitter accuracy for zero-dependency
 * portability — covers the 80% case across all 12 supported code languages
 * plus the non-code categories Understand-Anything handles.
 *
 * Per-language regexes are deliberately conservative: they catch the canonical
 * declaration forms (export function X / def X / func X / fn X / class X)
 * and skip exotic forms rather than over-match. The LLM in Phase C.2 fills
 * in summaries; the merge script drops anything that doesn't reference an
 * existing node.
 *
 * Usage:
 *   node extract-structure.mjs <input.json> <output.json>
 *
 * Input:  { projectRoot, batchFiles: [{ path, language, sizeLines, fileCategory }] }
 * Output: { scriptCompleted, filesAnalyzed, filesSkipped, results: [...] }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Code language extractors
// Returns { functions: [{name, startLine, endLine, params}],
//           classes:   [{name, startLine, endLine, methods, properties}],
//           exports:   [{name, line, isDefault}],
//           imports:   [...]   (count only, paths handled by extract-import-map)
//           callGraph: [{caller, callee, lineNumber}] }
// ---------------------------------------------------------------------------

function lineOf(content, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (content[i] === '\n') n++;
  return n;
}

function findBlockEnd(content, openIdx) {
  // Find matching brace from openIdx (where the '{' is). Returns line number.
  let depth = 0; let inStr = null; let escape = false;
  for (let i = openIdx; i < content.length; i++) {
    const c = content[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === '\\') { escape = true; continue; }
      if (c === inStr) { inStr = null; continue; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return lineOf(content, i); }
  }
  return lineOf(content, content.length - 1);
}

function findIndentBlockEnd(lines, startIdx, baseIndent) {
  // For Python-like languages: end of block is when indent <= baseIndent
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (indent <= baseIndent) return i; // returns 1-based already since startIdx is 1-based
  }
  return lines.length;
}

function parseTSJS(content) {
  const fns = [], classes = [], exports_ = [], callGraph = [];
  // function declarations
  const fnRe = /(?:^|\n)(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+(\w+)\s*\(([^)]*)\)\s*{/g;
  let m;
  while ((m = fnRe.exec(content))) {
    const name = m[1]; const params = m[2].split(',').map(s => s.trim()).filter(Boolean);
    const start = lineOf(content, m.index);
    const openIdx = m.index + m[0].length - 1;
    const end = findBlockEnd(content, openIdx);
    fns.push({ name, startLine: start, endLine: end, params });
  }
  // arrow function exports: export const X = (...) => { ... }
  const arrowRe = /(?:^|\n)(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>\s*{/g;
  while ((m = arrowRe.exec(content))) {
    const name = m[1]; const params = m[2].split(',').map(s => s.trim()).filter(Boolean);
    const start = lineOf(content, m.index);
    const end = findBlockEnd(content, m.index + m[0].length - 1);
    fns.push({ name, startLine: start, endLine: end, params });
  }
  // class declarations
  const cls = /(?:^|\n)(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w., ]+))?\s*{/g;
  while ((m = cls.exec(content))) {
    const name = m[1];
    const start = lineOf(content, m.index);
    const openIdx = m.index + m[0].length - 1;
    const end = findBlockEnd(content, openIdx);
    const body = content.slice(openIdx, content.indexOf('\n', openIdx + 1) >= 0 ? content.length : content.length);
    // Extract methods inside class body (rough)
    const classBody = content.slice(openIdx, openIdx + (end - start) * 80); // bounded slice
    const methodRe = /(?:^|\n)\s*(?:public|private|protected|static|async)?\s*(\w+)\s*\(([^)]*)\)\s*[:\w<>[\] ]*?{/g;
    const methods = [];
    let mm;
    while ((mm = methodRe.exec(classBody))) {
      if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(mm[1])) continue;
      methods.push(mm[1]);
    }
    classes.push({ name, startLine: start, endLine: end, methods: [...new Set(methods)], properties: [], extends: m[2] || null });
  }
  // exports
  const exp1 = /(?:^|\n)export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g;
  while ((m = exp1.exec(content))) {
    exports_.push({ name: m[1], line: lineOf(content, m.index), isDefault: m[0].includes('default') });
  }
  // export { a, b }
  const exp2 = /(?:^|\n)export\s*{\s*([^}]+)\s*}/g;
  while ((m = exp2.exec(content))) {
    for (const name of m[1].split(',').map(s => s.split(' as ')[0].trim()).filter(Boolean)) {
      exports_.push({ name, line: lineOf(content, m.index), isDefault: false });
    }
  }
  // module.exports = X
  const exp3 = /\bmodule\.exports\s*=\s*(\w+)/g;
  while ((m = exp3.exec(content))) {
    exports_.push({ name: m[1], line: lineOf(content, m.index), isDefault: true });
  }
  return { functions: fns, classes, exports: exports_, callGraph };
}

function parsePython(content) {
  const lines = content.split('\n');
  const fns = [], classes = [], exports_ = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    // function (top-level only — methods captured in class body separately for cleanliness)
    if ((m = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/.exec(line))) {
      const indent = m[1].length;
      const name = m[2]; const params = m[3].split(',').map(s => s.trim().split(':')[0].split('=')[0].trim()).filter(Boolean);
      const startLine = i + 1;
      const endIdx = findIndentBlockEnd(lines, i, indent);
      fns.push({ name, startLine, endLine: endIdx, params, _indent: indent });
      // Public exports: top-level functions not starting with _
      if (indent === 0 && !name.startsWith('_')) exports_.push({ name, line: startLine, isDefault: false });
    }
    if ((m = /^(\s*)class\s+(\w+)(?:\s*\(([^)]*)\))?/.exec(line))) {
      const indent = m[1].length;
      const name = m[2]; const startLine = i + 1;
      const endIdx = findIndentBlockEnd(lines, i, indent);
      // Methods: defs inside class body with indent > class indent
      const methods = [];
      for (let j = i + 1; j < endIdx; j++) {
        const mm = /^(\s+)(?:async\s+)?def\s+(\w+)/.exec(lines[j]);
        if (mm && mm[1].length > indent) methods.push(mm[2]);
      }
      classes.push({ name, startLine, endLine: endIdx, methods, properties: [], extends: m[3] ? m[3].split(',')[0].trim() : null });
      if (indent === 0) exports_.push({ name, line: startLine, isDefault: false });
    }
  }
  // Strip helper field
  fns.forEach(f => delete f._indent);
  return { functions: fns, classes, exports: exports_, callGraph: [] };
}

function parseGo(content) {
  const fns = [], classes = [], exports_ = [];
  // func Name(...) ... { ... }  / func (r *T) Method(...) ... { ... }
  const re = /(?:^|\n)func\s+(?:\(\s*\w+\s+\*?(\w+)\s*\)\s+)?(\w+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(content))) {
    const recv = m[1] || null;
    const name = m[2]; const params = m[3].split(',').map(s => s.trim()).filter(Boolean);
    const start = lineOf(content, m.index);
    const openIdx = content.indexOf('{', m.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;
    fns.push({ name: recv ? `${recv}.${name}` : name, startLine: start, endLine: end, params });
    if (/^[A-Z]/.test(name)) exports_.push({ name: recv ? `${recv}.${name}` : name, line: start, isDefault: false });
  }
  // type X struct { ... }
  const typeRe = /(?:^|\n)type\s+(\w+)\s+(?:struct|interface)\s*{/g;
  while ((m = typeRe.exec(content))) {
    const name = m[1]; const start = lineOf(content, m.index);
    const openIdx = content.indexOf('{', m.index);
    const end = findBlockEnd(content, openIdx);
    classes.push({ name, startLine: start, endLine: end, methods: [], properties: [], extends: null });
    if (/^[A-Z]/.test(name)) exports_.push({ name, line: start, isDefault: false });
  }
  return { functions: fns, classes, exports: exports_, callGraph: [] };
}

function parseRust(content) {
  const fns = [], classes = [], exports_ = [];
  const fnRe = /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
  let m;
  while ((m = fnRe.exec(content))) {
    const isPub = /pub/.test(content.slice(Math.max(0, m.index - 20), m.index + m[0].length));
    const name = m[1]; const params = m[2].split(',').map(s => s.trim()).filter(Boolean);
    const start = lineOf(content, m.index);
    const openIdx = content.indexOf('{', m.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;
    fns.push({ name, startLine: start, endLine: end, params });
    if (isPub) exports_.push({ name, line: start, isDefault: false });
  }
  const sRe = /(?:^|\n)\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/g;
  while ((m = sRe.exec(content))) {
    const isPub = /pub/.test(content.slice(Math.max(0, m.index - 20), m.index + m[0].length));
    const name = m[1]; const start = lineOf(content, m.index);
    const openIdx = content.indexOf('{', m.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start + 1;
    classes.push({ name, startLine: start, endLine: end, methods: [], properties: [], extends: null });
    if (isPub) exports_.push({ name, line: start, isDefault: false });
  }
  return { functions: fns, classes, exports: exports_, callGraph: [] };
}

function parseJavaKotlin(content) {
  const fns = [], classes = [], exports_ = [];
  // Java/Kotlin methods: visibility return name(params)
  const fnRe = /(?:^|\n)\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:final\s+)?(?:override\s+)?(?:abstract\s+)?(?:fun|[\w<>[\], ]+)\s+(\w+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = fnRe.exec(content))) {
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'class', 'interface'].includes(m[1])) continue;
    const name = m[1]; const params = m[2].split(',').map(s => s.trim()).filter(Boolean);
    const start = lineOf(content, m.index);
    const openIdx = content.indexOf('{', m.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;
    fns.push({ name, startLine: start, endLine: end, params });
  }
  const cls = /(?:^|\n)\s*(?:public|private|protected|internal)?\s*(?:abstract\s+|final\s+)?(?:class|interface|object)\s+(\w+)(?:\s*<[^>]*>)?(?:\s*(?:extends|:)\s*([\w<>., ]+))?/g;
  while ((m = cls.exec(content))) {
    const name = m[1]; const start = lineOf(content, m.index);
    const openIdx = content.indexOf('{', m.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;
    classes.push({ name, startLine: start, endLine: end, methods: [], properties: [], extends: m[2] || null });
    exports_.push({ name, line: start, isDefault: false });
  }
  return { functions: fns, classes, exports: exports_, callGraph: [] };
}

function parseCSharp(content) {
  return parseJavaKotlin(content); // close enough for declaration shape
}

function parseRuby(content) {
  const fns = [], classes = [], exports_ = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let m;
    if ((m = /^(\s*)def\s+([\w?!=]+)/.exec(lines[i]))) {
      const indent = m[1].length;
      const name = m[2];
      // Find matching `end` at same indent
      let end = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (new RegExp(`^\\s{${indent}}end\\s*$`).test(lines[j])) { end = j + 1; break; }
      }
      fns.push({ name, startLine: i + 1, endLine: end, params: [] });
    }
    if ((m = /^(\s*)class\s+(\w+)(?:\s*<\s*(\w+))?/.exec(lines[i]))) {
      const indent = m[1].length;
      const name = m[2]; let end = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (new RegExp(`^\\s{${indent}}end\\s*$`).test(lines[j])) { end = j + 1; break; }
      }
      classes.push({ name, startLine: i + 1, endLine: end, methods: [], properties: [], extends: m[3] || null });
      exports_.push({ name, line: i + 1, isDefault: false });
    }
  }
  return { functions: fns, classes, exports: exports_, callGraph: [] };
}

function parsePHP(content) {
  const fns = [], classes = [], exports_ = [];
  const fnRe = /(?:^|\n)\s*(?:public|private|protected|static)?\s*function\s+(\w+)\s*\(([^)]*)\)/g;
  let m;
  while ((m = fnRe.exec(content))) {
    const name = m[1]; const start = lineOf(content, m.index);
    const openIdx = content.indexOf('{', m.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;
    fns.push({ name, startLine: start, endLine: end, params: m[2].split(',').map(s => s.trim()).filter(Boolean) });
  }
  const cls = /(?:^|\n)\s*(?:abstract\s+|final\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
  while ((m = cls.exec(content))) {
    const start = lineOf(content, m.index);
    const openIdx = content.indexOf('{', m.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;
    classes.push({ name: m[1], startLine: start, endLine: end, methods: [], properties: [], extends: m[2] || null });
    exports_.push({ name: m[1], line: start, isDefault: false });
  }
  return { functions: fns, classes, exports: exports_, callGraph: [] };
}

function parseCpp(content) {
  const fns = [], classes = [], exports_ = [];
  // C++ functions are hard; conservative: returnType name(params) {  at line start
  const fnRe = /(?:^|\n)(?:[\w:*&<>, ]+\s+)?(\w+)\s*\(([^)]*)\)\s*(?:const|noexcept|override)?\s*{/g;
  let m;
  while ((m = fnRe.exec(content))) {
    const name = m[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'class', 'struct'].includes(name)) continue;
    const start = lineOf(content, m.index);
    const openIdx = m.index + m[0].length - 1;
    const end = findBlockEnd(content, openIdx);
    fns.push({ name, startLine: start, endLine: end, params: m[2].split(',').map(s => s.trim()).filter(Boolean) });
  }
  const cls = /(?:^|\n)\s*(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|private|protected)?\s*([\w:]+))?\s*{/g;
  while ((m = cls.exec(content))) {
    const start = lineOf(content, m.index);
    const openIdx = m.index + m[0].length - 1;
    const end = findBlockEnd(content, openIdx);
    classes.push({ name: m[1], startLine: start, endLine: end, methods: [], properties: [], extends: m[2] || null });
  }
  return { functions: fns, classes, exports: exports_, callGraph: [] };
}

const CODE_PARSERS = {
  typescript: parseTSJS, javascript: parseTSJS,
  python: parsePython,
  go: parseGo,
  rust: parseRust,
  java: parseJavaKotlin, kotlin: parseJavaKotlin,
  csharp: parseCSharp,
  ruby: parseRuby,
  php: parsePHP,
  c: parseCpp, cpp: parseCpp,
};

// ---------------------------------------------------------------------------
// Non-code extractors
// ---------------------------------------------------------------------------

function parseDockerfile(content) {
  const lines = content.split('\n');
  const services = [];
  let currentStage = null; let currentStart = 1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^FROM\s+\S+(?:\s+AS\s+(\w+))?/i.exec(lines[i]);
    if (m) {
      if (currentStage) {
        services.push({ name: currentStage, lineRange: [currentStart, i], ports: [] });
      }
      currentStage = m[1] || `stage_${services.length}`;
      currentStart = i + 1;
    }
  }
  if (currentStage) services.push({ name: currentStage, lineRange: [currentStart, lines.length], ports: [] });
  // Expose ports
  const ports = [];
  const expRe = /^EXPOSE\s+(\d+)/igm;
  let m; while ((m = expRe.exec(content))) ports.push(parseInt(m[1]));
  if (services.length && ports.length) services[services.length - 1].ports = ports;
  return { services };
}

function parseCompose(content) {
  // Very rough YAML extraction — top-level under `services:`
  const services = [];
  const re = /^services:\s*\n([\s\S]*?)(?=\n[^\s]|\n*$)/m;
  const m = re.exec(content);
  if (m) {
    const block = m[1];
    const lines = block.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lm = /^  (\w[\w-]*):\s*$/.exec(lines[i]);
      if (lm) services.push({ name: lm[1], lineRange: [i + 1, i + 1], ports: [] });
    }
  }
  return { services };
}

function parseGitHubActions(content) {
  const steps = [];
  // Top-level `jobs:` then nested job names
  const jobRe = /^jobs:\s*\n([\s\S]*)/m;
  const m = jobRe.exec(content);
  if (m) {
    const lines = m[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lm = /^  (\w[\w-]*):\s*$/.exec(lines[i]);
      if (lm) steps.push({ name: lm[1], lineRange: [i + 1, i + 1] });
    }
  }
  return { steps };
}

function parseTerraform(content) {
  const resources = [];
  const re = /(?:^|\n)\s*(resource|data|module)\s+"([^"]+)"\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(content))) {
    resources.push({
      name: `${m[2]}.${m[3]}`,
      kind: m[1],
      lineRange: [lineOf(content, m.index), lineOf(content, m.index)],
    });
  }
  return { resources };
}

function parseSQL(content) {
  const definitions = [];
  const re = /CREATE\s+(TABLE|VIEW|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)/ig;
  let m;
  while ((m = re.exec(content))) {
    definitions.push({ name: m[2], kind: m[1].toLowerCase(), lineRange: [lineOf(content, m.index), lineOf(content, m.index)], fields: [] });
  }
  return { definitions };
}

function parseGraphQL(content) {
  const definitions = [];
  const re = /(?:^|\n)(type|input|interface|union|enum|scalar)\s+(\w+)/g;
  let m;
  while ((m = re.exec(content))) {
    definitions.push({ name: m[2], kind: m[1], lineRange: [lineOf(content, m.index), lineOf(content, m.index)], fields: [] });
  }
  return { definitions };
}

function parseProto(content) {
  const definitions = [];
  const re = /(?:^|\n)(service|message|enum)\s+(\w+)/g;
  let m;
  while ((m = re.exec(content))) {
    definitions.push({ name: m[2], kind: m[1], lineRange: [lineOf(content, m.index), lineOf(content, m.index)], fields: [] });
  }
  return { definitions };
}

function parseMarkdownSections(content) {
  const sections = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      sections.push({ name: m[2], level: m[1].length, lineRange: [i + 1, i + 1] });
    }
  }
  return { sections };
}

function parseOpenAPI(content) {
  // Minimal: extract `paths:` keys + their methods
  const endpoints = [];
  const definitions = [];
  const lines = content.split('\n');
  let inPaths = false; let pathsIndent = -1;
  let inComponents = false; let inSchemas = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^paths:\s*$/.test(line)) { inPaths = true; pathsIndent = 0; continue; }
    if (/^components:\s*$/.test(line)) { inPaths = false; inComponents = true; continue; }
    if (inComponents && /^\s+schemas:\s*$/.test(line)) { inSchemas = true; continue; }
    if (inPaths) {
      const pm = /^  (\/[^\s:]+):\s*$/.exec(line);
      if (pm) {
        const path = pm[1];
        // Look at next few lines for methods
        for (let j = i + 1; j < lines.length && /^\s{4,}/.test(lines[j]); j++) {
          const mm = /^    (get|post|put|delete|patch|head|options):\s*$/i.exec(lines[j]);
          if (mm) endpoints.push({
            method: mm[1].toUpperCase(), path,
            lineRange: [j + 1, j + 1],
          });
        }
      }
      if (/^[^\s]/.test(line) && line.trim() && !line.startsWith('#')) inPaths = false;
    }
    if (inSchemas) {
      const sm = /^    (\w+):\s*$/.exec(line);
      if (sm) definitions.push({ name: sm[1], kind: 'schema', lineRange: [i + 1, i + 1], fields: [] });
    }
  }
  return { endpoints, definitions };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function analyzeFile(file, projectRoot) {
  const abs = join(projectRoot, file.path);
  let content;
  try { content = readFileSync(abs, 'utf-8'); }
  catch (e) {
    return { skipped: true, reason: e.message };
  }

  const lines = content.split('\n');
  const totalLines = content.endsWith('\n') ? Math.max(0, lines.length - 1) : lines.length;
  const nonEmptyLines = lines.filter(l => l.trim().length > 0).length;

  let result = {
    path: file.path,
    language: file.language,
    fileCategory: file.fileCategory,
    totalLines,
    nonEmptyLines,
    functions: [], classes: [], exports: [], callGraph: [],
    sections: [], definitions: [], services: [], endpoints: [], steps: [], resources: [],
    metrics: {},
  };

  if (file.fileCategory === 'code' || file.fileCategory === 'script') {
    const parser = CODE_PARSERS[file.language];
    if (parser) {
      try {
        const r = parser(content);
        result.functions = r.functions || [];
        result.classes = r.classes || [];
        result.exports = r.exports || [];
        result.callGraph = r.callGraph || [];
      } catch (e) {
        process.stderr.write(`Warning: extract-structure: ${file.path} parser failed: ${e.message}\n`);
      }
    }
  }

  // Non-code parsers (by filename / language)
  const fname = basename(file.path);
  if (fname === 'Dockerfile' || fname.startsWith('Dockerfile.')) {
    result.services = parseDockerfile(content).services;
  } else if (fname.startsWith('docker-compose') || fname === 'compose.yml' || fname === 'compose.yaml') {
    result.services = parseCompose(content).services;
  } else if (file.path.toLowerCase().includes('.github/workflows/') && (fname.endsWith('.yml') || fname.endsWith('.yaml'))) {
    result.steps = parseGitHubActions(content).steps;
  } else if (file.language === 'terraform') {
    result.resources = parseTerraform(content).resources;
  } else if (file.language === 'sql') {
    result.definitions = parseSQL(content).definitions;
  } else if (file.language === 'graphql') {
    result.definitions = parseGraphQL(content).definitions;
  } else if (file.language === 'protobuf') {
    result.definitions = parseProto(content).definitions;
  } else if (file.language === 'markdown') {
    result.sections = parseMarkdownSections(content).sections;
  } else if (file.language === 'yaml' && /openapi|swagger/i.test(content.slice(0, 200))) {
    const r = parseOpenAPI(content);
    result.endpoints = r.endpoints;
    result.definitions = r.definitions;
  }

  result.metrics = {
    functionCount: result.functions.length,
    classCount: result.classes.length,
    exportCount: result.exports.length,
    serviceCount: result.services.length,
    endpointCount: result.endpoints.length,
    definitionCount: result.definitions.length,
    stepCount: result.steps.length,
    resourceCount: result.resources.length,
    sectionCount: result.sections.length,
  };

  return result;
}

function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: node extract-structure.mjs <input.json> <output.json>\n');
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const { projectRoot, batchFiles } = input;
  if (!projectRoot || !Array.isArray(batchFiles)) {
    process.stderr.write('Error: input must contain projectRoot + batchFiles\n');
    process.exit(1);
  }

  const results = []; const filesSkipped = [];
  for (const file of batchFiles) {
    const r = analyzeFile(file, projectRoot);
    if (r.skipped) {
      filesSkipped.push(file.path);
      process.stderr.write(`Warning: extract-structure: ${file.path} skipped — ${r.reason}\n`);
      continue;
    }
    results.push(r);
  }

  const out = {
    scriptCompleted: true,
    filesAnalyzed: results.length,
    filesSkipped,
    results,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(`extract-structure: filesAnalyzed=${results.length} filesSkipped=${filesSkipped.length}\n`);
}

main();
