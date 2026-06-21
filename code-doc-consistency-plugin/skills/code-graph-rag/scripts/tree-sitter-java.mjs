#!/usr/bin/env node
/**
 * tree-sitter-java.mjs — Tree-sitter WASM wrapper for Java parsing
 *
 * Provides accurate AST-based Java parsing using tree-sitter WASM.
 * Falls back gracefully to regex if WASM files are not available.
 *
 * Usage:
 *   import { parseJava } from './tree-sitter-java.mjs';
 *   const result = await parseJava(sourceCode);
 *   // result = null if tree-sitter unavailable (caller should use regex)
 *
 * WASM setup:
 *   node tree-sitter-java.mjs --setup [wasmDir]
 *
 * Dependencies: web-tree-sitter (WASM), tree-sitter-java (grammar WASM)
 * These are optional — the module works without them via regex fallback.
 */

let Parser = null;
let JavaGrammar = null;
let initPromise = null;

// ── WASM initialization ──────────────────────────────────────────────────────

async function initTreeSitter(wasmDir) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Try to load web-tree-sitter
      const wsPath = wasmDir
        ? `${wasmDir}/node_modules/web-tree-sitter/tree-sitter.wasm`
        : undefined;

      // Dynamic import of web-tree-sitter
      let wsModule;
      try {
        wsModule = await import('web-tree-sitter');
      } catch {
        // Try alternative path
        try {
          wsModule = await import(wasmDir ? `${wasmDir}/node_modules/web-tree-sitter` : 'web-tree-sitter');
        } catch {
          return false;
        }
      }

      Parser = wsModule.default || wsModule.Parser || wsModule;

      // Initialize parser
      await Parser.init();

      // Load Java grammar
      const grammarPath = wasmDir
        ? `${wasmDir}/tree-sitter-java.wasm`
        : undefined;

      if (grammarPath) {
        try {
          const { readFileSync } = await import('node:fs');
          const grammarBuffer = readFileSync(grammarPath);
          JavaGrammar = await Parser.Language.load(grammarBuffer);
        } catch {
          // Try default location
          try {
            JavaGrammar = await Parser.Language.load(
              new URL('tree-sitter-java.wasm', import.meta.url).href
            );
          } catch {
            return false;
          }
        }
      } else {
        // Try to load from default location
        try {
          JavaGrammar = await Parser.Language.load(
            new URL('tree-sitter-java.wasm', import.meta.url).href
          );
        } catch {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  })();

  return initPromise;
}

// ── AST extraction helpers ───────────────────────────────────────────────────

function getNodeText(node, source) {
  return source.substring(node.startIndex, node.endIndex);
}

function getNodeLine(node) {
  return node.startPosition.row + 1; // 1-based
}

function getNodeEndLine(node) {
  return node.endPosition.row + 1; // 1-based
}

function extractModifiers(node) {
  const mods = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'modifiers') {
      for (let j = 0; j < child.childCount; j++) {
        mods.push(child.child(j).type);
      }
    }
  }
  return mods;
}

function extractAnnotations(node, source) {
  const annotations = [];
  // Annotations are usually children before the main declaration
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'annotation' || child.type === 'marker_annotation') {
      const nameNode = child.child(1); // After '@'
      const name = nameNode ? getNodeText(nameNode, source) : '';
      const rawArgs = child.childCount > 2 ? getNodeText(child.child(2), source) : null;
      annotations.push({ name, rawArgs, line: getNodeLine(child) });
    }
  }
  return annotations;
}

function extractTypeParams(node, source) {
  if (!node) return null;
  const text = getNodeText(node, source);
  // Extract generic type parameters like <T, E extends Enum>
  const match = text.match(/<(.+)>/);
  return match ? match[1].split(',').map(s => s.trim()) : null;
}

// ── Java AST extraction ──────────────────────────────────────────────────────

function extractJavaAST(rootNode, source) {
  const functions = [];
  const classes = [];
  const interfaces = [];
  const enums = [];
  const annotations = [];
  const exports = [];

  function visit(node, depth = 0) {
    if (depth > 20) return; // Safety limit

    switch (node.type) {
      case 'class_declaration':
      case 'record_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? getNodeText(nameNode, source) : '';
        const startLine = getNodeLine(node);
        const endLine = getNodeEndLine(node);
        const mods = extractModifiers(node);
        const anns = extractAnnotations(node, source);

        // Extract extends/implements
        let extendsType = null;
        let implementsTypes = [];
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child.type === 'superclass') {
            extendsType = getNodeText(child, source).replace('extends', '').trim();
          }
          if (child.type === 'super_interfaces') {
            const ifaceText = getNodeText(child, source).replace('implements', '').trim();
            implementsTypes = ifaceText.split(',').map(s => s.trim());
          }
        }

        // Extract fields and methods from class body
        const body = node.childForFieldName('body');
        const methods = [];
        const fields = [];
        if (body) {
          for (let i = 0; i < body.childCount; i++) {
            const member = body.child(i);
            if (member.type === 'method_declaration' || member.type === 'constructor_declaration') {
              const mName = member.childForFieldName('name');
              const methodName = mName ? getNodeText(mName, source) : '';
              methods.push({
                name: methodName,
                startLine: getNodeLine(member),
                endLine: getNodeEndLine(member),
                isConstructor: member.type === 'constructor_declaration',
              });
            }
            if (member.type === 'field_declaration') {
              const fType = member.childForFieldName('type');
              const fName = member.childForFieldName('name');
              if (fType && fName) {
                fields.push({
                  name: getNodeText(fName, source),
                  type: getNodeText(fType, source),
                  line: getNodeLine(member),
                });
              }
            }
          }
        }

        classes.push({
          name,
          startLine,
          endLine,
          methods,
          properties: fields,
          extends: extendsType,
          implements: implementsTypes.length > 0 ? implementsTypes : null,
          annotations: anns,
          modifiers: mods,
        });

        if (mods.includes('public') || mods.includes('protected')) {
          exports.push({ name, line: startLine, isDefault: false });
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? getNodeText(nameNode, source) : '';
        const startLine = getNodeLine(node);
        const endLine = getNodeEndLine(node);
        const anns = extractAnnotations(node, source);
        const mods = extractModifiers(node);

        // Extract extends
        let extendsTypes = [];
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child.type === 'extends_interfaces') {
            const extText = getNodeText(child, source).replace('extends', '').trim();
            extendsTypes = extText.split(',').map(s => s.trim());
          }
        }

        interfaces.push({
          name,
          startLine,
          endLine,
          extends: extendsTypes.length > 0 ? extendsTypes : null,
          annotations: anns,
          modifiers: mods,
        });

        if (mods.includes('public') || mods.includes('protected')) {
          exports.push({ name, line: startLine, isDefault: false });
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? getNodeText(nameNode, source) : '';
        const startLine = getNodeLine(node);
        const endLine = getNodeEndLine(node);
        const anns = extractAnnotations(node, source);

        enums.push({
          name,
          startLine,
          endLine,
          annotations: anns,
        });

        exports.push({ name, line: startLine, isDefault: false });
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? getNodeText(nameNode, source) : '';
        const startLine = getNodeLine(node);
        const endLine = getNodeEndLine(node);

        // Extract return type
        const returnTypeNode = node.childForFieldName('type');
        const returnType = returnTypeNode ? getNodeText(returnTypeNode, source) : 'void';

        // Extract parameters
        const paramsNode = node.childForFieldName('parameters');
        const params = [];
        if (paramsNode) {
          for (let i = 0; i < paramsNode.childCount; i++) {
            const param = paramsNode.child(i);
            if (param.type === 'formal_parameter' || param.type === 'spread_parameter') {
              const pType = param.childForFieldName('type');
              const pName = param.childForFieldName('name');
              if (pType && pName) {
                params.push({
                  type: getNodeText(pType, source),
                  name: getNodeText(pName, source),
                });
              }
            }
          }
        }

        functions.push({
          name,
          startLine,
          endLine,
          params,
          returnType,
        });
        break;
      }

      case 'annotation_type_declaration': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? getNodeText(nameNode, source) : '';
        const startLine = getNodeLine(node);
        const endLine = getNodeEndLine(node);

        annotations.push({
          name,
          startLine,
          endLine,
        });
        break;
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      visit(node.child(i), depth + 1);
    }
  }

  visit(rootNode);

  return {
    functions,
    classes,
    interfaces,
    enums,
    annotations,
    exports,
    callGraph: [],
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse Java source code using tree-sitter WASM.
 *
 * @param {string} source - Java source code
 * @param {object} options - { wasmDir?: string }
 * @returns {Promise<object|null>} - Parsed structure or null if tree-sitter unavailable
 */
export async function parseJava(source, options = {}) {
  const initialized = await initTreeSitter(options.wasmDir);
  if (!initialized || !Parser || !JavaGrammar) return null;

  try {
    const parser = new Parser();
    parser.setLanguage(JavaGrammar);
    const tree = parser.parse(source);
    return extractJavaAST(tree.rootNode, source);
  } catch {
    return null;
  }
}

/**
 * Check if tree-sitter WASM is available.
 *
 * @param {string} wasmDir - Optional path to WASM directory
 * @returns {Promise<boolean>}
 */
export async function isTreeSitterAvailable(wasmDir) {
  return initTreeSitter(wasmDir);
}

// ── CLI setup ────────────────────────────────────────────────────────────────

async function setupWasm(wasmDir) {
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  const targetDir = wasmDir || join(process.cwd(), '.tree-sitter');
  mkdirSync(targetDir, { recursive: true });

  console.log(`Setting up tree-sitter WASM in ${targetDir}...`);

  // Check if web-tree-sitter is available via npm
  const hasNpm = existsSync(join(targetDir, 'node_modules'));

  if (!hasNpm) {
    console.log('\nTree-sitter WASM requires npm packages. Install with:');
    console.log(`  cd ${targetDir}`);
    console.log('  npm init -y');
    console.log('  npm install web-tree-sitter');
    console.log('\nThen download the Java grammar WASM:');
    console.log('  curl -LO https://github.com/tree-sitter/tree-sitter-java/releases/latest/download/tree-sitter-java.wasm');
    console.log(`  mv tree-sitter-java.wasm ${targetDir}/`);
    console.log('\nOr use the --wasm-dir flag to point to an existing installation.');
    return false;
  }

  console.log('tree-sitter WASM setup complete.');
  return true;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('tree-sitter-java.mjs')) {
  const args = process.argv.slice(2);
  if (args[0] === '--setup') {
    const wasmDir = args[1] || null;
    setupWasm(wasmDir).then(ok => process.exit(ok ? 0 : 1));
  } else if (args[0] === '--check') {
    const wasmDir = args[1] || null;
    isTreeSitterAvailable(wasmDir).then(ok => {
      console.log(ok ? 'tree-sitter WASM: available' : 'tree-sitter WASM: not available (using regex fallback)');
      process.exit(0);
    });
  } else {
    console.log('Usage:');
    console.log('  node tree-sitter-java.mjs --setup [wasmDir]  # Setup WASM files');
    console.log('  node tree-sitter-java.mjs --check [wasmDir]  # Check availability');
    process.exit(1);
  }
}
