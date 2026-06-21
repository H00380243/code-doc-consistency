#!/usr/bin/env node
/**
 * extract-structure.mjs — Phase C.1 of /code-graph-rag (per-file extraction)
 *
 * Self-contained adaptation: tree-sitter WASM (when available) or
 * regex/heuristic-based extraction of functions, classes, exports, and
 * non-code structural elements (services, endpoints, steps, resources).
 *
 * Tree-sitter WASM provides accurate AST parsing for Java when the WASM
 * files are available. Falls back to regex parsing (zero dependencies)
 * for all other languages or when tree-sitter is not installed.
 *
 * Usage:
 *   node extract-structure.mjs <input.json> <output.json> [--wasm-dir=<path>]
 *
 * Input:  { projectRoot, batchFiles: [{ path, language, sizeLines, fileCategory }] }
 * Output: { scriptCompleted, filesAnalyzed, filesSkipped, parserUsed, results: [...] }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Tree-sitter WASM integration (optional dependency)
// ---------------------------------------------------------------------------

let treeSitterAvailable = null;
let treeSitterModule = null;

async function loadTreeSitter(wasmDir) {
  if (treeSitterAvailable !== null) return treeSitterAvailable;

  try {
    const modulePath = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'tree-sitter-java.mjs');
    treeSitterModule = await import(modulePath);
    treeSitterAvailable = true;
    return true;
  } catch {
    treeSitterAvailable = false;
    return false;
  }
}

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

// -- Java/Spring annotation extraction helpers ------------------------------

function extractAnnotations(content, lineStart, lineEnd) {
  // Extract all annotations preceding or within a declaration range
  const annotations = [];
  const lines = content.split('\n');
  const start = Math.max(0, (lineStart || 1) - 1);
  const end = Math.min(lines.length, lineEnd || lines.length);
  const re = /@(\w+)(?:\(([^)]*)\))?/g;
  for (let i = start; i < end; i++) {
    let m;
    while ((m = re.exec(lines[i]))) {
      const name = m[1];
      const rawArgs = m[2] || null;
      annotations.push({ name, rawArgs, line: i + 1 });
    }
    re.lastIndex = 0;
  }
  return annotations;
}

function extractJavaPackage(content) {
  const m = content.match(/(?:^|\n)\s*package\s+([\w.]+)\s*;/);
  return m ? m[1] : null;
}

function extractJavaFields(content, classStartLine, classEndLine) {
  // Extract Java fields: [annotations] [modifiers] Type name [= value];
  const fields = [];
  const lines = content.split('\n');
  const start = Math.max(0, (classStartLine || 1) - 1);
  const end = Math.min(lines.length, classEndLine || lines.length);

  const fieldRe = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:volatile\s+)?(?:transient\s+)?([\w<>\[\], ?]+)\s+(\w+)\s*[;=]/;

  for (let i = start; i < end; i++) {
    const m = fieldRe.exec(lines[i]);
    if (m) {
      const type = m[1].trim();
      const name = m[2];
      // Skip if it looks like a method declaration (has parentheses after name)
      const afterName = lines[i].slice(lines[i].indexOf(name) + name.length).trim();
      if (afterName.startsWith('(')) continue;
      // Skip common false positives
      if (['return', 'throw', 'new', 'if', 'for', 'while'].includes(type)) continue;

      const fieldAnnotations = [];
      const annRe = /@(\w+)/g;
      let am;
      while ((am = annRe.exec(lines[i]))) {
        fieldAnnotations.push(am[1]);
      }

      fields.push({
        name,
        type,
        annotations: fieldAnnotations,
        line: i + 1,
        visibility: lines[i].includes('private') ? 'private'
          : lines[i].includes('protected') ? 'protected'
          : lines[i].includes('public') ? 'public' : 'package-private',
        isStatic: /\bstatic\b/.test(lines[i]),
        isFinal: /\bfinal\b/.test(lines[i]),
      });
    }
  }
  return fields;
}

function extractJavaMethods(content, classStartLine, classEndLine) {
  // Extract Java methods with full signatures, annotations, return types
  const methods = [];
  const lines = content.split('\n');
  const start = Math.max(0, (classStartLine || 1) - 1);
  const end = Math.min(lines.length, classEndLine || lines.length);

  // Build a continuous block to search (handles multi-line signatures)
  let block = '';
  let lineMap = []; // maps char index to line number
  for (let i = start; i < end; i++) {
    lineMap.push(i + 1);
    block += lines[i] + '\n';
  }

  // Method pattern: [annotations] [modifiers] ReturnType methodName(params) [throws ...] {
  // We look for lines that end with { or ; (abstract methods) and contain method signatures
  const methodRe = /(?:^|\n)\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:synchronized\s+)?(?:native\s+)?(?:default\s+)?([\w<>\[\], ?]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w., ]+)?\s*[{;]/g;

  let m;
  while ((m = methodRe.exec(block))) {
    const returnType = m[1].trim();
    const name = m[2];
    const rawParams = m[3];

    // Skip Java keywords that look like methods
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'class', 'interface', 'enum', 'package', 'import'].includes(name)) continue;
    // Skip if returnType is a visibility keyword (means regex matched a constructor call inside a method body)
    if (['public', 'private', 'protected', 'static', 'final', 'abstract'].includes(returnType)) continue;
    if (['void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'byte', 'short', 'String'].includes(returnType) && !rawParams) continue;

    // Calculate line number from the method name position (not match start, which includes annotations)
    const nameOffset = m[0].indexOf(name);
    const charIdx = m.index + (nameOffset >= 0 ? nameOffset : 0);
    // Approximate line number from char index
    let lineNum = start + 1;
    let charCount = 0;
    for (let i = start; i < end; i++) {
      charCount += lines[i].length + 1;
      if (charCount > charIdx) { lineNum = i + 1; break; }
    }

    const params = rawParams.split(',').map(s => {
      const parts = s.trim().split(/\s+/);
      if (parts.length >= 2) {
        return { type: parts.slice(0, -1).join(' '), name: parts[parts.length - 1].replace(/[,;]/g, '') };
      }
      return { type: '', name: s.trim() };
    }).filter(p => p.name);

    // Extract annotations on this method (look backwards from current line)
    const methodAnnotations = [];
    for (let i = Math.max(start, lineNum - 5); i < lineNum - 1; i++) {
      const annRe = /@(\w+)/g;
      let am;
      while ((am = annRe.exec(lines[i]))) {
        methodAnnotations.push(am[1]);
      }
    }

    const isConstructor = returnType === name || returnType === '';

    methods.push({
      name,
      returnType: isConstructor ? 'void' : returnType,
      params,
      annotations: methodAnnotations,
      line: lineNum,
      visibility: block.slice(Math.max(0, m.index - 30), m.index).includes('private') ? 'private'
        : block.slice(Math.max(0, m.index - 30), m.index).includes('protected') ? 'protected'
        : 'public',
      isStatic: block.slice(Math.max(0, m.index - 30), m.index).includes('static'),
      isAbstract: block.slice(Math.max(0, m.index - 30), m.index).includes('abstract'),
      isConstructor,
    });
  }

  return methods;
}

function parseJavaRegex(content) {
  const fns = [], classes = [], interfaces = [], enums = [], exports_ = [];
  const allAnnotations = [];
  let callGraph = [];

  const pkg = extractJavaPackage(content);

  // --- Extract annotations (top-level and nested) ---
  const globalAnnRe = /@(\w+)/g;
  let am;
  while ((am = globalAnnRe.exec(content))) {
    allAnnotations.push({ name: am[1], line: lineOf(content, am.index) });
  }

  // --- Extract interfaces ---
  const ifaceRe = /(?:^|\n)\s*(?:public|private|protected)?\s*(?:abstract\s+)?interface\s+(\w+)(?:\s*<([^>]*?)>)?(?:\s+extends\s+([\w., <>]+))?\s*\{/g;
  while ((am = ifaceRe.exec(content))) {
    const name = am[1];
    const generics = am[2] ? am[2].split(',').map(s => s.trim()) : [];
    const extendsList = am[3] ? am[3].split(',').map(s => s.trim()) : [];
    const start = lineOf(content, am.index);
    const openIdx = content.indexOf('{', am.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;

    const ifaceAnnotations = extractAnnotations(content, Math.max(1, start - 5), start);
    const ifaceMethods = extractJavaMethods(content, start, end);
    const ifaceFields = extractJavaFields(content, start, end);

    interfaces.push({
      name, startLine: start, endLine: end,
      methods: ifaceMethods.map(m => m.name),
      methodDetails: ifaceMethods,
      fields: ifaceFields,
      properties: [],
      extends: extendsList.length ? extendsList : null,
      generics,
      annotations: ifaceAnnotations.map(a => a.name),
      javaPackage: pkg,
    });
    exports_.push({ name, line: start, isDefault: false });
  }

  // --- Extract enums ---
  const enumRe = /(?:^|\n)\s*(?:public|private|protected)?\s*(?:abstract\s+)?enum\s+(\w+)(?:\s+implements\s+([\w., <>]+))?\s*\{/g;
  while ((am = enumRe.exec(content))) {
    const name = am[1];
    const implementsList = am[2] ? am[2].split(',').map(s => s.trim()) : [];
    const start = lineOf(content, am.index);
    const openIdx = content.indexOf('{', am.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;

    // Extract enum constants
    const block = content.slice(openIdx + 1, content.indexOf('}', openIdx));
    const constants = [];
    const skipWords = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'class', 'interface', 'enum', 'implements', 'extends']);
    for (const line of block.split('\n')) {
      const trimmed = line.trim().replace(/[,;{}]$/, '').trim();
      if (trimmed && /^\w+$/.test(trimmed) && !skipWords.has(trimmed)) {
        constants.push(trimmed);
      }
    }

    const enumAnnotations = extractAnnotations(content, Math.max(1, start - 5), start);

    enums.push({
      name, startLine: start, endLine: end,
      constants,
      methods: [],
      implements: implementsList.length ? implementsList : null,
      annotations: enumAnnotations.map(a => a.name),
      javaPackage: pkg,
    });
    exports_.push({ name, line: start, isDefault: false });
  }

  // --- Extract classes (after interfaces and enums to avoid double-matching) ---
  const clsRe = /(?:^|\n)\s*(?:public|private|protected)?\s*(?:abstract\s+|final\s+)?class\s+(\w+)(?:\s*<([^>]*?)>)?(?:\s+extends\s+([\w., <>]+))?(?:\s+implements\s+([\w., <>]+))?\s*\{/g;
  while ((am = clsRe.exec(content))) {
    const name = am[1];
    const generics = am[2] ? am[2].split(',').map(s => s.trim()) : [];
    const extendsClass = am[3] || null;
    const implementsList = am[4] ? am[4].split(',').map(s => s.trim()) : [];
    const start = lineOf(content, am.index);
    const openIdx = content.indexOf('{', am.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;

    const classAnnotations = extractAnnotations(content, Math.max(1, start - 10), start);
    // Find nested class ranges within this class to exclude their methods
    const nestedClassRe = /(?:^|\n)\s*(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+|final\s+)?class\s+\w+/g;
    const nestedRanges = [];
    let ncm;
    while ((ncm = nestedClassRe.exec(content))) {
      const nStart = lineOf(content, ncm.index);
      if (nStart > start && nStart < end) {
        const nOpenIdx = content.indexOf('{', ncm.index);
        const nEnd = nOpenIdx >= 0 ? findBlockEnd(content, nOpenIdx) : nStart;
        nestedRanges.push([nStart, nEnd]);
      }
    }
    const rawMethods = extractJavaMethods(content, start, end);
    const classMethods = rawMethods.filter(m => !nestedRanges.some(([ns, ne]) => m.line >= ns && m.line <= ne));
    const classFields = extractJavaFields(content, start, end);

    classes.push({
      name, startLine: start, endLine: end,
      methods: classMethods.map(m => m.name),
      methodDetails: classMethods,
      fields: classFields,
      properties: classFields.map(f => ({ name: f.name, type: f.type, annotations: f.annotations })),
      extends: extendsClass,
      implements: implementsList.length ? implementsList : null,
      generics,
      annotations: classAnnotations.map(a => a.name),
      javaPackage: pkg,
    });
    exports_.push({ name, line: start, isDefault: false });
  }

  // --- Extract top-level functions (outside classes) ---
  // Build list of class/interface/enum ranges to exclude
  const typeRanges = [...classes, ...interfaces, ...enums].map(t => [t.startLine, t.endLine]);
  const fnRe = /(?:^|\n)\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:synchronized\s+)?([\w<>\[\], ?]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w., ]+)?\s*[{;]/g;
  let fm;
  while ((fm = fnRe.exec(content))) {
    const returnType = fm[1].trim();
    const name = fm[2];
    const rawParams = fm[3];

    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'new', 'class', 'interface', 'enum', 'package', 'import', 'public', 'private', 'protected'].includes(name)) continue;
    if (['void', 'int', 'long', 'double', 'float', 'boolean', 'char', 'byte', 'short', 'String'].includes(returnType) && !rawParams) continue;

    const start = lineOf(content, fm.index);
    // Skip if inside a class/interface/enum
    const insideType = typeRanges.some(([s, e]) => start >= s && start <= e);
    if (insideType) continue;

    const openIdx = content.indexOf('{', fm.index);
    const end = openIdx >= 0 ? findBlockEnd(content, openIdx) : start;
    const params = rawParams.split(',').map(s => {
      const parts = s.trim().split(/\s+/);
      if (parts.length >= 2) return parts[parts.length - 1].replace(/[,;]/g, '');
      return s.trim();
    }).filter(Boolean);

    const fnAnnotations = extractAnnotations(content, Math.max(1, start - 5), start);

    fns.push({
      name,
      startLine: start,
      endLine: end,
      params,
      returnType,
      annotations: fnAnnotations.map(a => a.name),
      javaPackage: pkg,
      visibility: content.slice(Math.max(0, fm.index - 30), fm.index).includes('private') ? 'private'
        : content.slice(Math.max(0, fm.index - 30), fm.index).includes('protected') ? 'protected'
        : 'public',
      isStatic: content.slice(Math.max(0, fm.index - 30), fm.index).includes('static'),
    });
  }

  // --- Build call graph (basic: method A calls method B within same file) ---
  // Extract all method names from the file
  const allMethodNames = new Set([
    ...fns.map(f => f.name),
    ...classes.flatMap(c => (c.methodDetails || []).map(m => m.name)),
    ...interfaces.flatMap(i => (i.methodDetails || []).map(m => m.name)),
  ]);

  // Simple heuristic: look for method invocations in each method body
  for (const fn of fns) {
    const bodyStart = content.split('\n').slice(0, fn.startLine - 1).join('\n').length;
    const bodyEnd = content.split('\n').slice(0, fn.endLine).join('\n').length;
    const body = content.slice(bodyStart, bodyEnd);
    for (const callee of allMethodNames) {
      if (callee === fn.name) continue;
      const callRe = new RegExp(`\\b${callee}\\s*\\(`, 'g');
      if (callRe.test(body)) {
        callGraph.push({ caller: fn.name, callee, lineNumber: fn.startLine });
      }
    }
  }

  return {
    functions: fns,
    classes,
    interfaces,
    enums,
    exports: exports_,
    annotations: allAnnotations,
    callGraph,
    javaPackage: pkg,
  };
}

/**
 * Parse Java source code using tree-sitter WASM if available, else regex.
 *
 * @param {string} content - Java source code
 * @param {string} wasmDir - Optional path to tree-sitter WASM directory
 * @returns {Promise<object>} - Parsed structure
 */
async function parseJava(content, wasmDir) {
  // Try tree-sitter WASM first
  if (treeSitterAvailable !== false) {
    try {
      const available = treeSitterAvailable ?? await loadTreeSitter(wasmDir);
      if (available && treeSitterModule) {
        const result = await treeSitterModule.parseJava(content, { wasmDir });
        if (result) {
          // Tree-sitter result needs normalization to match regex output format
          return normalizeTreeSitterResult(result, content);
        }
      }
    } catch {
      // Fall through to regex
    }
  }

  // Fallback to regex parser
  return parseJavaRegex(content);
}

/**
 * Normalize tree-sitter AST output to match the regex parser's output format.
 */
function normalizeTreeSitterResult(ast, content) {
  const pkg = extractJavaPackage(content);

  // Normalize classes to include methodDetails and properties
  const classes = (ast.classes || []).map(cls => {
    const fullMethods = extractJavaMethods(content, cls.startLine, cls.endLine);
    const fields = extractJavaFields(content, cls.startLine, cls.endLine);
    const classAnnotations = extractAnnotations(content, Math.max(1, cls.startLine - 10), cls.startLine);

    return {
      name: cls.name,
      startLine: cls.startLine,
      endLine: cls.endLine,
      methods: fullMethods.map(m => m.name),
      methodDetails: fullMethods,
      fields: fields,
      properties: fields.map(f => ({ name: f.name, type: f.type, annotations: f.annotations })),
      extends: cls.extends || null,
      implements: cls.implements || null,
      generics: [],
      annotations: classAnnotations.map(a => a.name),
      javaPackage: pkg,
    };
  });

  // Normalize interfaces
  const interfaces = (ast.interfaces || []).map(iface => {
    const fullMethods = extractJavaMethods(content, iface.startLine, iface.endLine);
    const fields = extractJavaFields(content, iface.startLine, iface.endLine);
    const ifaceAnnotations = extractAnnotations(content, Math.max(1, iface.startLine - 5), iface.startLine);

    return {
      name: iface.name,
      startLine: iface.startLine,
      endLine: iface.endLine,
      methods: fullMethods.map(m => m.name),
      methodDetails: fullMethods,
      fields: fields,
      properties: [],
      extends: iface.extends || null,
      generics: [],
      annotations: ifaceAnnotations.map(a => a.name),
      javaPackage: pkg,
    };
  });

  // Normalize enums
  const enums = (ast.enums || []).map(en => {
    const enumAnnotations = extractAnnotations(content, Math.max(1, en.startLine - 5), en.startLine);
    // Extract enum constants from the source
    const openIdx = content.indexOf('{', content.indexOf('enum ' + en.name));
    const constants = [];
    if (openIdx >= 0) {
      const block = content.slice(openIdx + 1, content.indexOf('}', openIdx));
      const skipWords = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'class', 'interface', 'enum', 'implements', 'extends']);
      for (const line of block.split('\n')) {
        const trimmed = line.trim().replace(/[,;{}]$/, '').trim();
        if (trimmed && /^\w+$/.test(trimmed) && !skipWords.has(trimmed)) {
          constants.push(trimmed);
        }
      }
    }

    return {
      name: en.name,
      startLine: en.startLine,
      endLine: en.endLine,
      constants,
      methods: [],
      implements: null,
      annotations: enumAnnotations.map(a => a.name),
      javaPackage: pkg,
    };
  });

  // Normalize functions (add annotations, javaPackage, visibility)
  const functions = (ast.functions || []).map(fn => {
    const fnAnnotations = extractAnnotations(content, Math.max(1, fn.startLine - 5), fn.startLine);
    const startIdx = content.split('\n').slice(0, fn.startLine - 1).join('\n').length;
    const prefix = content.slice(Math.max(0, startIdx - 30), startIdx);

    return {
      name: fn.name,
      startLine: fn.startLine,
      endLine: fn.endLine,
      params: fn.params || [],
      returnType: fn.returnType || 'void',
      annotations: fnAnnotations.map(a => a.name),
      javaPackage: pkg,
      visibility: prefix.includes('private') ? 'private'
        : prefix.includes('protected') ? 'protected'
        : 'public',
      isStatic: prefix.includes('static'),
    };
  });

  // Global annotations
  const allAnnotations = [];
  const globalAnnRe = /@(\w+)/g;
  let am;
  while ((am = globalAnnRe.exec(content))) {
    allAnnotations.push({ name: am[1], line: lineOf(content, am.index) });
  }

  return {
    functions,
    classes,
    interfaces,
    enums,
    exports: ast.exports || [],
    annotations: allAnnotations,
    callGraph: ast.callGraph || [],
    javaPackage: pkg,
    parserUsed: 'tree-sitter',
  };
}

function parseCSharp(content) {
  return parseJava(content); // close enough for declaration shape
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
  java: parseJava, kotlin: parseJava,
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

async function analyzeFile(file, projectRoot, wasmDir) {
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
    interfaces: [], enums: [], annotations: [],
    javaPackage: null,
    parserUsed: 'regex',
    jpaEntities: [], springEndpoints: [], springConfig: [],
    sections: [], definitions: [], services: [], endpoints: [], steps: [], resources: [],
    metrics: {},
  };

  if (file.fileCategory === 'code' || file.fileCategory === 'script') {
    const parser = CODE_PARSERS[file.language];
    if (parser) {
      try {
        // Handle async parsers (parseJava) vs sync parsers
        const r = await parser(content, wasmDir);
        result.functions = r.functions || [];
        result.classes = r.classes || [];
        result.exports = r.exports || [];
        result.callGraph = r.callGraph || [];
        if (r.interfaces) result.interfaces = r.interfaces;
        if (r.enums) result.enums = r.enums;
        if (r.annotations) result.annotations = r.annotations;
        if (r.javaPackage) result.javaPackage = r.javaPackage;
        if (r.parserUsed) result.parserUsed = r.parserUsed;
      } catch (e) {
        process.stderr.write(`Warning: extract-structure: ${file.path} parser failed: ${e.message}\n`);
      }
    }
  }

  // --- Java/Spring-specific post-processing ---
  if (file.language === 'java') {
    const allClasses = [...(result.classes || []), ...(result.interfaces || [])];
    for (const cls of allClasses) {
      const classAnnotations = cls.annotations || [];
      const isController = classAnnotations.some(a =>
        ['RestController', 'Controller'].includes(a)
      );

      if (isController && cls.methodDetails) {
        let basePath = '';
        const classAnnText = content.split('\n').slice(
          Math.max(0, cls.startLine - 10), cls.startLine
        ).join('\n');
        const classMapping = classAnnText.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
        if (classMapping) basePath = classMapping[1];

        for (const method of cls.methodDetails) {
          const httpMappings = [];
          for (const ann of (method.annotations || [])) {
            const httpMethodMap = {
              'GetMapping': 'GET', 'PostMapping': 'POST',
              'PutMapping': 'PUT', 'DeleteMapping': 'DELETE',
              'PatchMapping': 'PATCH', 'RequestMapping': null,
            };
            const httpMethod = httpMethodMap[ann];

            if (httpMethod) {
              // Check annotation lines before the method for path
              let methodPath = '';
              const allLines = content.split('\n');
              for (let i = Math.max(0, method.line - 5); i < method.line; i++) {
                const pathMatch = allLines[i].match(/@(?:Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
                if (pathMatch) { methodPath = pathMatch[1]; break; }
              }
              const fullPath = (basePath + methodPath).replace(/\/+/g, '/') || '/';
              httpMappings.push({
                method: httpMethod || 'GET',
                path: fullPath,
                params: (method.params || []).map(p => p.name || p),
              });
            }
          }

          if (httpMappings.length > 0) {
            result.springEndpoints.push({
              className: cls.name,
              methodName: method.name,
              mappings: httpMappings,
              annotations: method.annotations,
              line: method.line,
            });
          }
        }
      }

      const isEntity = classAnnotations.some(a => a === 'Entity');
      if (isEntity) {
        let tableName = cls.name;
        const classAnnText = content.split('\n').slice(
          Math.max(0, cls.startLine - 10), cls.startLine
        ).join('\n');
        const tableMatch = classAnnText.match(/@Table\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["']/);
        if (tableMatch) tableName = tableMatch[1];

        result.jpaEntities.push({
          className: cls.name,
          tableName,
          fields: (cls.fields || []).map(f => ({
            name: f.name,
            type: f.type,
            annotations: f.annotations,
          })),
          line: cls.startLine,
        });
      }

      const isConfig = classAnnotations.some(a => a === 'Configuration');
      if (isConfig) {
        result.springConfig.push({
          className: cls.name,
          beanMethods: (cls.methodDetails || [])
            .filter(m => (m.annotations || []).includes('Bean'))
            .map(m => ({
              name: m.name,
              returnType: m.returnType,
              annotations: m.annotations,
              line: m.line,
            })),
          line: cls.startLine,
        });
      }
    }

    for (const fn of result.functions) {
      const fnAnnotations = fn.annotations || [];
      const sqlAnnotations = ['Select', 'Insert', 'Update', 'Delete', 'SelectProvider', 'InsertProvider', 'UpdateProvider', 'DeleteProvider'];
      const sqlAnnotation = fnAnnotations.find(a => sqlAnnotations.includes(a));
      if (sqlAnnotation) {
        const fnLine = content.split('\n')[fn.startLine - 1] || '';
        const sqlMatch = fnLine.match(/["']([^"']+)["']/);
        if (sqlMatch) {
          fn.sqlQuery = sqlMatch[1];
          fn.mybatisAnnotation = sqlAnnotation;
        }
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
    interfaceCount: result.interfaces?.length || 0,
    enumCount: result.enums?.length || 0,
    exportCount: result.exports.length,
    serviceCount: result.services.length,
    endpointCount: result.endpoints.length + (result.springEndpoints?.length || 0),
    definitionCount: result.definitions.length,
    stepCount: result.steps.length,
    resourceCount: result.resources.length,
    sectionCount: result.sections.length,
    annotationCount: result.annotations?.length || 0,
    jpaEntityCount: result.jpaEntities?.length || 0,
    springConfigCount: result.springConfig?.length || 0,
  };

  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  let batchIndex = null;
  let projectRootOverride = null;
  let wasmDir = null;
  for (const a of argv) {
    if (a.startsWith('--batch=')) batchIndex = Number.parseInt(a.slice('--batch='.length), 10);
    else if (a.startsWith('--project-root=')) projectRootOverride = a.slice('--project-root='.length);
    else if (a.startsWith('--wasm-dir=')) wasmDir = a.slice('--wasm-dir='.length);
    else positional.push(a);
  }
  const [inputPath, outputPath] = positional;
  if (!inputPath || !outputPath) {
    process.stderr.write(
      'Usage: node extract-structure.mjs <input.json> <output.json> [--batch=<i>] [--project-root=<path>] [--wasm-dir=<path>]\n' +
      '  Input may be either:\n' +
      '    (a) {projectRoot, batchFiles[]} (legacy single-batch input), or\n' +
      '    (b) full 01_code_batches.json + --batch=<i> + --project-root=<path>\n'
    );
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));

  let projectRoot;
  let batchFiles;
  if (Number.isInteger(batchIndex)) {
    // Mode (b): pluck the requested batch out of a 01_code_batches.json-shaped file.
    if (!Array.isArray(input.batches)) {
      process.stderr.write('Error: --batch=<i> requires input to contain `batches[]`\n');
      process.exit(1);
    }
    const batch = input.batches[batchIndex];
    if (!batch) {
      process.stderr.write(`Error: batchIndex ${batchIndex} out of range (0..${input.batches.length - 1})\n`);
      process.exit(1);
    }
    batchFiles = batch.batchFiles;
    projectRoot = projectRootOverride || input.projectRoot;
    if (!projectRoot || !Array.isArray(batchFiles)) {
      process.stderr.write('Error: cannot resolve projectRoot/batchFiles for that batch — pass --project-root=<path>\n');
      process.exit(1);
    }
  } else {
    // Mode (a): legacy single-batch input.
    ({ projectRoot, batchFiles } = input);
    if (projectRootOverride) projectRoot = projectRootOverride;
    if (!projectRoot || !Array.isArray(batchFiles)) {
      process.stderr.write('Error: input must contain projectRoot + batchFiles (or use --batch=<i> with a 01_code_batches.json file)\n');
      process.exit(1);
    }
  }

  const results = []; const filesSkipped = [];
  const parserCounts = { regex: 0, 'tree-sitter': 0 };
  for (const file of batchFiles) {
    const r = await analyzeFile(file, projectRoot, wasmDir);
    if (r.skipped) {
      filesSkipped.push(file.path);
      process.stderr.write(`Warning: extract-structure: ${file.path} skipped — ${r.reason}\n`);
      continue;
    }
    parserCounts[r.parserUsed || 'regex']++;
    results.push(r);
  }

  const out = {
    scriptCompleted: true,
    filesAnalyzed: results.length,
    filesSkipped,
    parserUsed: parserCounts,
    results,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(
    `extract-structure: filesAnalyzed=${results.length} filesSkipped=${filesSkipped.length} ` +
    `tree-sitter=${parserCounts['tree-sitter']} regex=${parserCounts.regex}\n`
  );
}

main();
