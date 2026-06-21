#!/usr/bin/env node
/**
 * build-symbol-index.mjs — Global symbol index builder (Phase A.0)
 *
 * Scans all code files for exported symbols (functions, classes, interfaces,
 * enums, types, constants) and builds a global index used by:
 *   - LLM workers: resolve cross-file calls without reading source
 *   - align-graphs.mjs: token-based similarity matching
 *   - merge-batch-graphs.mjs: dedup verification
 *
 * Runs BEFORE batching — fast regex-only, no AST parsing.
 * enrich-symbol-index.mjs (post-Phase-C) supplements with full signatures.
 *
 * Usage:
 *   node build-symbol-index.mjs <scanResultPath> <importMapPath> <outputPath>
 *                                [--project-root=<path>]
 *
 * Input:  scan-project output + extract-import-map output
 * Output: { scriptCompleted, stats, symbols: { <symbolName>: [...] }, files: { <path>: [...] } }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

// ── Per-language export extractors ──────────────────────────────────────────
// Each returns [{ name, type, signature, line, annotations }]

const JAVA_KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char',
  'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extends', 'final', 'finally', 'float', 'for', 'goto', 'if', 'implements',
  'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static',
  'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws',
  'transient', 'try', 'void', 'volatile', 'while',
  'true', 'false', 'null',
]);

// Java types that are NOT user-defined symbols (constructor calls, built-in exceptions)
const JAVA_BUILTIN_TYPES = new Set([
  'RuntimeException', 'Exception', 'IllegalStateException', 'IllegalArgumentException',
  'NullPointerException', 'UnsupportedOperationException', 'IOException',
  'ClassNotFoundException', 'NoSuchMethodException', 'InstantiationException',
  'IllegalAccessException', 'Throwable', 'Error', 'String', 'Integer', 'Long',
  'Double', 'Float', 'Boolean', 'Object', 'Class', 'System', 'Math',
  'Collections', 'Arrays', 'List', 'Map', 'Set', 'Optional', 'Stream',
  'ResponseEntity', 'HttpStatus', 'HttpStatusCode',
]);

// Common test assertion methods (not user-defined)
const TEST_ASSERTION_METHODS = new Set([
  'assertEquals', 'assertNotEquals', 'assertTrue', 'assertFalse', 'assertNull',
  'assertNotNull', 'assertThrows', 'assertDoesNotThrow', 'assertSame',
  'assertNotSame', 'assertThat', 'assertIterableEquals', 'assertArrayEquals',
  'verify', 'when', 'given', 'willReturn', 'doReturn', 'doThrow',
]);

function extractJava(content) {
  const symbols = [];
  const lines = content.split('\n');

  // Package
  let pkg = '';
  const pkgMatch = content.match(/(?:^|\n)\s*package\s+([\w.]+)\s*;/);
  if (pkgMatch) pkg = pkgMatch[1];

  // Scan for top-level declarations
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Collect preceding annotations (up to 10 lines back)
    const annotations = [];
    for (let j = Math.max(0, i - 10); j < i; j++) {
      const annRe = /@(\w+)/g;
      let am;
      while ((am = annRe.exec(lines[j]))) annotations.push(am[1]);
    }

    // class / abstract class / final class
    const classMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+(\w+)/);
    if (classMatch && !JAVA_KEYWORDS.has(classMatch[1])) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      const extMatch = sig.match(/extends\s+([\w<>, ]+)/);
      const implMatch = sig.match(/implements\s+([\w<>, ]+)/);
      // Extract fields by scanning class body for field declarations
      const fields = [];
      for (let k = i + 1; k < Math.min(i + 200, lines.length); k++) {
        const fldLine = lines[k];
        const fldMatch = fldLine.match(/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?([\w<>\[\], ?]+)\s+(\w+)\s*[;=]/);
        if (fldMatch && !JAVA_KEYWORDS.has(fldMatch[2])) {
          const fldAnnotations = [];
          for (let fj = Math.max(0, k - 3); fj < k; fj++) {
            const faRe = /@(\w+)/g;
            let fam;
            while ((fam = faRe.exec(lines[fj]))) fldAnnotations.push(fam[1]);
          }
          fields.push({ name: fldMatch[2], type: fldMatch[1].trim(), annotations: fldAnnotations });
        }
      }
      symbols.push({
        name: classMatch[1], type: 'class', signature: sig, line: lineNum,
        annotations, javaPackage: pkg,
        extends: extMatch ? extMatch[1].trim() : undefined,
        implements: implMatch ? implMatch[1].split(',').map(s => s.trim()) : undefined,
        fields: fields.length > 0 ? fields : undefined,
      });
      continue;
    }

    // interface
    const ifaceMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+)?interface\s+(\w+)/);
    if (ifaceMatch && !JAVA_KEYWORDS.has(ifaceMatch[1])) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      const extMatch = sig.match(/extends\s+([\w<>, ]+)/);
      symbols.push({
        name: ifaceMatch[1], type: 'interface', signature: sig, line: lineNum,
        annotations, javaPackage: pkg,
        extends: extMatch ? extMatch[1].split(',').map(s => s.trim()) : undefined,
      });
      continue;
    }

    // enum
    const enumMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+)?enum\s+(\w+)/);
    if (enumMatch && !JAVA_KEYWORDS.has(enumMatch[1])) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: enumMatch[1], type: 'enum', signature: sig, line: lineNum, annotations, javaPackage: pkg });
      continue;
    }

    // @interface (annotation type)
    const annTypeMatch = line.match(/^\s*(?:public\s+)?@interface\s+(\w+)/);
    if (annTypeMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: annTypeMatch[1], type: 'annotation', signature: sig, line: lineNum, annotations, javaPackage: pkg });
      continue;
    }

    // Top-level method (static or not, outside class body — heuristic: indent ≤ 1)
    const methodMatch = line.match(/^(\s{0,4})(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:synchronized\s+)?(?:native\s+)?(?:default\s+)?([\w<>\[\], ?]+)\s+(\w+)\s*\(([^)]*)\)/);
    if (methodMatch && methodMatch[1].length <= 4) {
      const returnType = methodMatch[2].trim();
      const name = methodMatch[3];
      if (!JAVA_KEYWORDS.has(name) && !JAVA_KEYWORDS.has(returnType)) {
        const sig = line.replace(/\s*\{?\s*$/, '').trim();
        // Parse parameters: "Type name, Type name2" → [{type, name}]
        const params = [];
        if (methodMatch[4] && methodMatch[4].trim()) {
          for (const param of methodMatch[4].split(',')) {
            const parts = param.trim().split(/\s+/);
            if (parts.length >= 2) {
              params.push({ type: parts.slice(0, -1).join(' '), name: parts[parts.length - 1] });
            }
          }
        }
        symbols.push({
          name, type: 'function', signature: sig, line: lineNum,
          annotations, javaPackage: pkg, returnType,
          params: params.length > 0 ? params : undefined,
        });
      }
    }
  }

  return symbols;
}

function extractTypeScriptJavaScript(content) {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // export function / export async function
    const fnMatch = line.match(/(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      const params = [];
      if (fnMatch[2] && fnMatch[2].trim()) {
        for (const param of fnMatch[2].split(',')) {
          const parts = param.trim().split(/\s*:\s*/);
          if (parts.length >= 2) {
            params.push({ name: parts[0].replace(/[?=.].*$/, ''), type: parts.slice(1).join(':').trim() });
          } else if (parts[0] && !parts[0].startsWith('...')) {
            params.push({ name: parts[0].replace(/[?=.].*$/, ''), type: 'any' });
          }
        }
      }
      symbols.push({
        name: fnMatch[1], type: 'function', signature: sig, line: lineNum,
        annotations: [],
        params: params.length > 0 ? params : undefined,
      });
      continue;
    }

    // export class / export default class
    const clsMatch = line.match(/(?:^|\n)\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)\s*(?:extends\s+(\w+))?\s*(?:implements\s+([\w<>, ]+))?/);
    if (clsMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({
        name: clsMatch[1], type: 'class', signature: sig, line: lineNum,
        annotations: [],
        extends: clsMatch[2] || undefined,
        implements: clsMatch[3] ? clsMatch[3].split(',').map(s => s.trim()) : undefined,
      });
      continue;
    }

    // export interface
    const ifaceMatch = line.match(/(?:^|\n)\s*export\s+interface\s+(\w+)\s*(?:extends\s+([\w<>, ]+))?/);
    if (ifaceMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({
        name: ifaceMatch[1], type: 'interface', signature: sig, line: lineNum,
        annotations: [],
        extends: ifaceMatch[2] ? ifaceMatch[2].split(',').map(s => s.trim()) : undefined,
      });
      continue;
    }

    // export type
    const typeMatch = line.match(/(?:^|\n)\s*export\s+type\s+(\w+)/);
    if (typeMatch) {
      const sig = line.replace(/=\s*.*$/, '').trim();
      symbols.push({ name: typeMatch[1], type: 'type', signature: sig, line: lineNum, annotations: [] });
      continue;
    }

    // export enum
    const enumMatch = line.match(/(?:^|\n)\s*export\s+enum\s+(\w+)/);
    if (enumMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: enumMatch[1], type: 'enum', signature: sig, line: lineNum, annotations: [] });
      continue;
    }

    // export const / export let / export var
    const constMatch = line.match(/(?:^|\n)\s*export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*([^\s=]+))?/);
    if (constMatch) {
      const sig = line.replace(/=\s*.*$/, '').trim();
      symbols.push({ name: constMatch[1], type: 'constant', signature: sig, line: lineNum, annotations: [] });
      continue;
    }

    // export default (anonymous)
    // Skip — no symbol name

    // module.exports = X
    const meMatch = line.match(/\bmodule\.exports\s*=\s*(\w+)/);
    if (meMatch) {
      const sig = line.trim();
      symbols.push({ name: meMatch[1], type: 'constant', signature: sig, line: lineNum, annotations: [] });
    }
  }

  return symbols;
}

function extractPython(content) {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const indent = line.match(/^(\s*)/)[1].length;

    // Only top-level definitions (indent === 0)
    if (indent > 0) continue;

    // def function_name(...)
    const fnMatch = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (fnMatch) {
      const sig = line.replace(/:\s*$/, '').trim();
      symbols.push({ name: fnMatch[1], type: 'function', signature: sig, line: lineNum, annotations: [] });
      continue;
    }

    // class ClassName(...)
    const clsMatch = line.match(/^class\s+(\w+)/);
    if (clsMatch) {
      const sig = line.replace(/:\s*$/, '').trim();
      symbols.push({ name: clsMatch[1], type: 'class', signature: sig, line: lineNum, annotations: [] });
      continue;
    }
  }

  // __all__ exports
  const allMatch = content.match(/__all__\s*=\s*\[([^\]]*)\]/);
  if (allMatch) {
    const exported = allMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    for (const name of exported) {
      const existing = symbols.find(s => s.name === name);
      if (existing) existing.exported = true;
      else symbols.push({ name, type: 'unknown', signature: `__all__ export`, line: 0, annotations: [], exported: true });
    }
  }

  return symbols;
}

function extractGo(content) {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // func FunctionName( or func (r Receiver) MethodName(
    const fnMatch = line.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/);
    if (fnMatch) {
      const name = fnMatch[1];
      // Only exported (capitalized)
      if (name[0] === name[0].toUpperCase()) {
        const sig = line.replace(/\s*\{?\s*$/, '').trim();
        symbols.push({ name, type: 'function', signature: sig, line: lineNum, annotations: [] });
      }
      continue;
    }

    // type TypeName struct/interface
    const typeMatch = line.match(/^type\s+(\w+)\s+(?:struct|interface)/);
    if (typeMatch) {
      const name = typeMatch[1];
      if (name[0] === name[0].toUpperCase()) {
        const sig = line.replace(/\s*\{?\s*$/, '').trim();
        symbols.push({ name, type: 'type', signature: sig, line: lineNum, annotations: [] });
      }
    }
  }

  return symbols;
}

function extractRust(content) {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // pub fn / pub(crate) fn
    const fnMatch = line.match(/^\s*pub\s*(?:\([^)]*\)\s+)?(?:async\s+)?fn\s+(\w+)/);
    if (fnMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: fnMatch[1], type: 'function', signature: sig, line: lineNum, annotations: [] });
      continue;
    }

    // pub struct / pub enum / pub trait
    const typeMatch = line.match(/^\s*pub\s+(?:struct|enum|trait)\s+(\w+)/);
    if (typeMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: typeMatch[1], type: 'type', signature: sig, line: lineNum, annotations: [] });
    }
  }

  return symbols;
}

function extractKotlin(content) {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // fun functionName(
    const fnMatch = line.match(/(?:public\s+|private\s+|protected\s+)?(?:open\s+|override\s+|suspend\s+)?fun\s+(\w+)/);
    if (fnMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: fnMatch[1], type: 'function', signature: sig, line: lineNum, annotations: [] });
      continue;
    }

    // class / data class / interface / object
    const clsMatch = line.match(/(?:public\s+|private\s+|protected\s+)?(?:open\s+|abstract\s+|data\s+|sealed\s+)?(?:class|interface|object)\s+(\w+)/);
    if (clsMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: clsMatch[1], type: 'class', signature: sig, line: lineNum, annotations: [] });
    }
  }

  return symbols;
}

function extractCSharp(content) {
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // public/private/protected ... void/Type MethodName(
    const methodMatch = line.match(/(?:public|private|protected|internal)\s+(?:static\s+)?(?:virtual\s+)?(?:override\s+)?(?:async\s+)?(?:[\w<>\[\], ?]+)\s+(\w+)\s*\(/);
    if (methodMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: methodMatch[1], type: 'function', signature: sig, line: lineNum, annotations: [] });
      continue;
    }

    // class / interface / enum / struct
    const typeMatch = line.match(/(?:public|private|protected|internal)\s+(?:static\s+|abstract\s+|sealed\s+)?(?:class|interface|enum|struct)\s+(\w+)/);
    if (typeMatch) {
      const sig = line.replace(/\s*\{?\s*$/, '').trim();
      symbols.push({ name: typeMatch[1], type: 'type', signature: sig, line: lineNum, annotations: [] });
    }
  }

  return symbols;
}

function extractGeneric(content, language) {
  // Fallback: try common patterns for unsupported languages
  const symbols = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Common function pattern: name(
    const fnMatch = line.match(/^(?:export\s+)?(?:function|def|func|fn|pub\s+fn)\s+(\w+)\s*[\(:]/);
    if (fnMatch) {
      const sig = line.replace(/\s*[{=]\s*$/, '').trim();
      symbols.push({ name: fnMatch[1], type: 'function', signature: sig, line: lineNum, annotations: [] });
    }
  }

  return symbols;
}

const LANGUAGE_EXTRACTORS = {
  java: extractJava,
  kotlin: extractKotlin,
  typescript: extractTypeScriptJavaScript,
  javascript: extractTypeScriptJavaScript,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  csharp: extractCSharp,
};

// ── Node ID generation (matches graph-schema.md format) ─────────────────────

function makeNodeId(filePath, symbolName, symbolType) {
  const prefix = {
    function: 'function', class: 'class', interface: 'interface',
    enum: 'enum', type: 'type', constant: 'constant', annotation: 'annotation',
    unknown: 'function',
  }[symbolType] || 'function';
  return `${prefix}:${filePath}:${symbolName}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const [scanResultPath, importMapPath, outputPath] = args;
  let projectRoot = null;

  for (const a of args.slice(3)) {
    if (a.startsWith('--project-root=')) projectRoot = a.slice(15);
  }

  if (!scanResultPath || !importMapPath || !outputPath) {
    process.stderr.write(
      'Usage: node build-symbol-index.mjs <scan-result.json> <import-map.json> <output.json> [--project-root=<path>]\n'
    );
    process.exit(1);
  }

  const scan = JSON.parse(readFileSync(scanResultPath, 'utf-8'));
  const imp = JSON.parse(readFileSync(importMapPath, 'utf-8'));
  const importMap = imp.importMap || {};

  const files = (scan.files || []).filter(f =>
    f.fileCategory === 'code' || f.fileCategory === 'script'
  );

  // Global symbol index: symbolName → [{ nodeId, filePath, type, signature, line, annotations, javaPackage }]
  const symbolsByName = {};
  // Per-file index: filePath → [{ name, type, nodeId }]
  const symbolsByFile = {};

  let totalSymbols = 0;
  let filesWithSymbols = 0;
  const byType = {};

  for (const file of files) {
    const extractor = LANGUAGE_EXTRACTORS[file.language?.toLowerCase()] || ((c) => extractGeneric(c, file.language));

    let content;
    try {
      if (projectRoot) {
        content = readFileSync(join(projectRoot, file.path), 'utf-8');
      }
    } catch {
      // If we can't read the file, skip signature extraction
    }

    if (!content) {
      // Fallback: can't extract without content; mark file as needing LLM
      symbolsByFile[file.path] = [];
      continue;
    }

    const extracted = extractor(content);
    const fileSymbols = [];

    for (const sym of extracted) {
      // Filter out false positives: built-in types, test assertions, constructor calls
      if (JAVA_BUILTIN_TYPES.has(sym.name)) continue;
      if (TEST_ASSERTION_METHODS.has(sym.name)) continue;

      const nodeId = makeNodeId(file.path, sym.name, sym.type);
      const entry = {
        nodeId,
        filePath: file.path,
        type: sym.type,
        signature: sym.signature || '',
        line: sym.line || 0,
        annotations: sym.annotations || [],
        javaPackage: sym.javaPackage || undefined,
        extends: sym.extends || undefined,
        implements: sym.implements || undefined,
        fields: sym.fields || undefined,
        params: sym.params || undefined,
        returnType: sym.returnType || undefined,
      };

      fileSymbols.push({ name: sym.name, type: sym.type, nodeId });

      if (!symbolsByName[sym.name]) symbolsByName[sym.name] = [];
      symbolsByName[sym.name].push(entry);

      totalSymbols++;
      byType[sym.type] = (byType[sym.type] || 0) + 1;
    }

    if (fileSymbols.length > 0) filesWithSymbols++;
    symbolsByFile[file.path] = fileSymbols;
  }

  // Build reverse import index for cross-file resolution hints
  const reverseImports = {};
  for (const [src, targets] of Object.entries(importMap)) {
    for (const t of targets) {
      (reverseImports[t] ||= []).push(src);
    }
  }

  const out = {
    scriptCompleted: true,
    stats: {
      totalFiles: files.length,
      filesWithSymbols,
      totalSymbols,
      uniqueSymbolNames: Object.keys(symbolsByName).length,
      byType,
    },
    symbols: symbolsByName,
    files: symbolsByFile,
    reverseImports,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(
    `build-symbol-index: files=${files.length} withSymbols=${filesWithSymbols} ` +
    `totalSymbols=${totalSymbols} uniqueNames=${Object.keys(symbolsByName).length}\n`
  );
}

// Handle async import for file reading
main();
