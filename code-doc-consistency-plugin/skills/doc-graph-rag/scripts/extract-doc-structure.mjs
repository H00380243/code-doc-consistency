#!/usr/bin/env node
/**
 * extract-doc-structure.mjs — Phase B (STRUCTURED) of /doc-graph-rag
 *
 * Self-contained adaptation: deterministic extraction of nodes + edges from
 * structured doc formats (OpenAPI, Proto, GraphQL, Mermaid, PlantUML, JSON
 * Schema). Output uses the same KnowledgeGraph schema as the code side, so
 * downstream merge + diff tooling treats both sides uniformly.
 *
 * Usage:
 *   node extract-doc-structure.mjs <input.json> <output.json>
 *
 * Input:  { projectRoot, documents: [{ path, docType }] }
 * Output: { scriptCompleted, results: [{ source, nodes, edges }] }
 *
 * Free-text markdown is NOT handled here — that's the LLM's job in Phase C.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

function lineOf(content, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (content[i] === '\n') n++;
  return n;
}

function nodeFor(id, type, name, source, summary, tags, extras = {}) {
  return {
    id, type, name,
    summary: summary || name,
    tags: tags && tags.length ? tags : [type],
    complexity: 'simple',
    source,
    confidence: 'high',
    abstraction_level: 'concrete',
    tentative: false,
    ...extras,
  };
}

function edgeFor(source, target, type, sourceLoc, weight = 0.7) {
  return {
    source, target, type,
    direction: 'forward',
    weight,
    source_location: sourceLoc,
    confidence: 'high',
    unresolved: false,
  };
}

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

function parseOpenAPI(content, sourceFile) {
  const nodes = []; const edges = [];
  const lines = content.split('\n');

  // Heuristic YAML extraction; for JSON we'd use JSON.parse, but for YAML we
  // use a tiny line-based extractor that handles the canonical OpenAPI shape.
  // (A full YAML parser would add a dependency we're avoiding.)

  let mode = null; // null | 'paths' | 'components.schemas' | 'tags'
  let currentPath = null;
  let pathLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^paths:\s*$/.test(line)) { mode = 'paths'; continue; }
    if (/^components:\s*$/.test(line)) { mode = 'components'; continue; }
    if (mode === 'components' && /^\s+schemas:\s*$/.test(line)) { mode = 'components.schemas'; continue; }
    if (/^tags:\s*$/.test(line)) { mode = 'tags'; continue; }
    if (line && /^\S/.test(line) && !line.startsWith('#') && !/^paths|components|tags|info|servers/.test(line)) {
      mode = null;
    }

    if (mode === 'paths') {
      const pm = /^  (\/[^\s:]+):\s*$/.exec(line);
      if (pm) { currentPath = pm[1]; pathLine = i + 1; continue; }
      if (currentPath) {
        const mm = /^    (get|post|put|delete|patch|head|options):\s*$/i.exec(line);
        if (mm) {
          const method = mm[1].toUpperCase();
          const id = `endpoint:${method}:${currentPath}`;
          nodes.push(nodeFor(id, 'endpoint', `${method} ${currentPath}`, {
            file: sourceFile, line_start: i + 1, line_end: i + 1,
          }, `${method} endpoint at ${currentPath}`, ['api-schema', 'endpoint']));

          // Look ahead for $ref schemas in requestBody/responses
          for (let j = i + 1; j < Math.min(lines.length, i + 80); j++) {
            if (/^\s{4}(get|post|put|delete|patch|head|options):/.test(lines[j])) break;
            if (/^\s{2}\//.test(lines[j])) break;
            const refMatch = /\$ref:\s*['"]?#\/components\/schemas\/(\w+)['"]?/.exec(lines[j]);
            if (refMatch) {
              const schemaId = `schema:${refMatch[1]}`;
              edges.push(edgeFor(id, schemaId, 'defines_schema',
                { file: sourceFile, line: j + 1 }, 0.8));
            }
          }
        }
      }
    } else if (mode === 'components.schemas') {
      const sm = /^    (\w+):\s*$/.exec(line);
      if (sm) {
        const id = `schema:${sm[1]}`;
        nodes.push(nodeFor(id, 'schema', sm[1], {
          file: sourceFile, line_start: i + 1, line_end: i + 1,
        }, `Schema definition for ${sm[1]}`, ['schema-definition', 'data-model']));
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Proto
// ---------------------------------------------------------------------------

function parseProto(content, sourceFile) {
  const nodes = []; const edges = [];

  // service X { rpc Y(Req) returns (Resp); }
  const serviceRe = /service\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = serviceRe.exec(content))) {
    const sName = m[1]; const body = m[2];
    const sLine = lineOf(content, m.index);
    const sId = `service:${sName}`;
    nodes.push(nodeFor(sId, 'service', sName, {
      file: sourceFile, line_start: sLine, line_end: lineOf(content, m.index + m[0].length),
    }, `gRPC service ${sName}`, ['service', 'grpc']));

    const rpcRe = /rpc\s+(\w+)\s*\(\s*(?:stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?(\w+)\s*\)/g;
    let rm;
    while ((rm = rpcRe.exec(body))) {
      const fnId = `function:${sName}.${rm[1]}`;
      const reqId = `schema:${rm[2]}`;
      const respId = `schema:${rm[3]}`;
      const fnLine = sLine + body.slice(0, rm.index).split('\n').length;
      nodes.push(nodeFor(fnId, 'function', `${sName}.${rm[1]}`, {
        file: sourceFile, line_start: fnLine, line_end: fnLine,
      }, `RPC method ${rm[1]} on ${sName}`, ['rpc', 'api-handler']));
      edges.push(edgeFor(sId, fnId, 'contains', { file: sourceFile, line: fnLine }, 1.0));
      edges.push(edgeFor(fnId, reqId, 'defines_schema', { file: sourceFile, line: fnLine }, 0.8));
      edges.push(edgeFor(fnId, respId, 'defines_schema', { file: sourceFile, line: fnLine }, 0.8));
    }
  }

  // message X { ... }
  const msgRe = /(?:^|\n)message\s+(\w+)\s*\{/g;
  while ((m = msgRe.exec(content))) {
    const id = `schema:${m[1]}`;
    if (!nodes.find(n => n.id === id)) {
      nodes.push(nodeFor(id, 'schema', m[1], {
        file: sourceFile, line_start: lineOf(content, m.index), line_end: lineOf(content, m.index),
      }, `Protobuf message ${m[1]}`, ['schema-definition', 'data-model']));
    }
  }

  // enum X { ... }
  const enumRe = /(?:^|\n)enum\s+(\w+)\s*\{/g;
  while ((m = enumRe.exec(content))) {
    const id = `schema:${m[1]}`;
    if (!nodes.find(n => n.id === id)) {
      nodes.push(nodeFor(id, 'schema', m[1], {
        file: sourceFile, line_start: lineOf(content, m.index), line_end: lineOf(content, m.index),
      }, `Protobuf enum ${m[1]}`, ['schema-definition', 'enum']));
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

function parseGraphQL(content, sourceFile) {
  const nodes = []; const edges = [];
  const re = /(?:^|\n)\s*(type|input|interface|union|enum|scalar)\s+(\w+)/g;
  let m;
  while ((m = re.exec(content))) {
    const kind = m[1]; const name = m[2];
    const id = `schema:${name}`;
    const line = lineOf(content, m.index);
    if (!nodes.find(n => n.id === id)) {
      nodes.push(nodeFor(id, 'schema', name, {
        file: sourceFile, line_start: line, line_end: line,
      }, `GraphQL ${kind} ${name}`, ['schema-definition', 'graphql']));
    }
    // For Query/Mutation type: extract fields as endpoints
    if ((name === 'Query' || name === 'Mutation') && kind === 'type') {
      const blockMatch = /\{([\s\S]*?)\}/.exec(content.slice(m.index));
      if (blockMatch) {
        const body = blockMatch[1];
        const fldRe = /(?:^|\n)\s*(\w+)\s*(?:\([^)]*\))?\s*:\s*[\w[\]!]+/g;
        let fm;
        while ((fm = fldRe.exec(body))) {
          const fId = `endpoint:GraphQL:${fm[1]}`;
          const fLine = line + body.slice(0, fm.index).split('\n').length;
          nodes.push(nodeFor(fId, 'endpoint', fm[1], {
            file: sourceFile, line_start: fLine, line_end: fLine,
          }, `GraphQL ${name.toLowerCase()} ${fm[1]}`, ['endpoint', 'graphql']));
          edges.push(edgeFor(id, fId, 'contains', { file: sourceFile, line: fLine }, 1.0));
        }
      }
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// PlantUML (class + sequence)
// ---------------------------------------------------------------------------

function parsePlantUML(content, sourceFile) {
  const nodes = []; const edges = [];
  const lines = content.split('\n');

  // class diagrams
  const classRe = /^\s*(?:abstract\s+)?(?:class|interface)\s+"?(\w+)"?(?:\s*<\|--\s*"?(\w+)"?)?/i;
  // relations: A <|-- B (B inherits A)
  const inheritRe = /^\s*(\w+)\s*<\|--\s*(\w+)/;
  const composeRe = /^\s*(\w+)\s*\*--\s*(\w+)/;
  const dependRe = /^\s*(\w+)\s*-->\s*(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = classRe.exec(line))) {
      const id = `class:${m[1]}`;
      if (!nodes.find(n => n.id === id)) {
        nodes.push(nodeFor(id, 'class', m[1], {
          file: sourceFile, line_start: i + 1, line_end: i + 1,
        }, `Class ${m[1]} from PlantUML diagram`, ['class', 'design']));
      }
    }
    if ((m = inheritRe.exec(line))) {
      const child = `class:${m[2]}`; const parent = `class:${m[1]}`;
      // Ensure both endpoints exist
      for (const id of [child, parent]) {
        const n = id.split(':')[1];
        if (!nodes.find(x => x.id === id)) {
          nodes.push(nodeFor(id, 'class', n, { file: sourceFile, line_start: i + 1, line_end: i + 1 },
            `Class ${n} from PlantUML diagram`, ['class', 'design']));
        }
      }
      edges.push(edgeFor(child, parent, 'inherits', { file: sourceFile, line: i + 1 }, 0.9));
    }
    if ((m = composeRe.exec(line))) {
      const parent = `class:${m[1]}`; const child = `class:${m[2]}`;
      edges.push(edgeFor(parent, child, 'contains', { file: sourceFile, line: i + 1 }, 0.9));
    }
    if ((m = dependRe.exec(line))) {
      // Heuristic: arrows in sequence diagrams use --> too. Treat as depends_on for class diagrams.
      const a = `class:${m[1]}`; const b = `class:${m[2]}`;
      edges.push(edgeFor(a, b, 'depends_on', { file: sourceFile, line: i + 1 }, 0.6));
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Mermaid (class + sequence + flowchart)
// ---------------------------------------------------------------------------

function parseMermaid(content, sourceFile) {
  const nodes = []; const edges = [];
  const lines = content.split('\n');

  let diagramType = null;
  for (const line of lines) {
    const t = line.trim();
    if (/^(classDiagram|sequenceDiagram|flowchart|graph)/.test(t)) {
      diagramType = t.split(/\s+/)[0];
      break;
    }
  }

  if (diagramType === 'classDiagram') {
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      let m;
      // class A
      if ((m = /^\s*class\s+(\w+)/.exec(t))) {
        const id = `class:${m[1]}`;
        if (!nodes.find(n => n.id === id)) {
          nodes.push(nodeFor(id, 'class', m[1], { file: sourceFile, line_start: i + 1, line_end: i + 1 },
            `Class ${m[1]} from Mermaid diagram`, ['class', 'design']));
        }
      }
      // A <|-- B (B inherits A)
      if ((m = /^\s*(\w+)\s*<\|--\s*(\w+)/.exec(t))) {
        edges.push(edgeFor(`class:${m[2]}`, `class:${m[1]}`, 'inherits', { file: sourceFile, line: i + 1 }, 0.9));
      }
      if ((m = /^\s*(\w+)\s*-->\s*(\w+)/.exec(t))) {
        edges.push(edgeFor(`class:${m[1]}`, `class:${m[2]}`, 'depends_on', { file: sourceFile, line: i + 1 }, 0.6));
      }
    }
  } else if (diagramType === 'sequenceDiagram') {
    // participants + messages
    const participants = new Set();
    const messages = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      let m;
      if ((m = /^\s*participant\s+(\w+)(?:\s+as\s+.+)?/.exec(t))) {
        participants.add(m[1]);
      }
      // A->>B: message  /  A-->>B: message  /  A->B: ...  (sync vs async arrows)
      if ((m = /^\s*(\w+)\s*-{1,2}>>?\s*(\w+)\s*:\s*(.+)$/.exec(t))) {
        participants.add(m[1]); participants.add(m[2]);
        messages.push({ from: m[1], to: m[2], msg: m[3].trim(), line: i + 1 });
      }
    }
    for (const p of participants) {
      const id = `module:${p}`;
      if (!nodes.find(n => n.id === id)) {
        nodes.push(nodeFor(id, 'module', p, { file: sourceFile, line_start: 1, line_end: 1 },
          `Participant ${p} in sequence diagram`, ['module', 'sequence']));
      }
    }
    for (const msg of messages) {
      edges.push(edgeFor(`module:${msg.from}`, `module:${msg.to}`, 'calls',
        { file: sourceFile, line: msg.line }, 0.7));
    }
  } else if (diagramType === 'flowchart' || diagramType === 'graph') {
    // node[label]; A --> B
    const nodeLabels = {};
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      let m;
      // node id with label: A[Label] or A(Label) or A{Label}
      const labelRe = /(\w+)[\[(\{]([^\])\}]+)[\])\}]/g;
      while ((m = labelRe.exec(t))) {
        if (!nodeLabels[m[1]]) {
          nodeLabels[m[1]] = m[2];
          const id = `concept:${m[1]}`;
          nodes.push(nodeFor(id, 'concept', m[2], { file: sourceFile, line_start: i + 1, line_end: i + 1 },
            `Flowchart node: ${m[2]}`, ['flowchart', 'concept']));
        }
      }
      if ((m = /(\w+)\s*-->\s*(\w+)/.exec(t))) {
        edges.push(edgeFor(`concept:${m[1]}`, `concept:${m[2]}`, 'depends_on',
          { file: sourceFile, line: i + 1 }, 0.5));
      }
    }
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

function parseJsonSchema(content, sourceFile) {
  const nodes = []; const edges = [];
  let schema;
  try { schema = JSON.parse(content); } catch { return { nodes, edges }; }
  const title = schema.title || basename(sourceFile, '.json').replace(/\.schema$/, '');
  const id = `schema:${title}`;
  nodes.push(nodeFor(id, 'schema', title, {
    file: sourceFile, line_start: 1, line_end: content.split('\n').length,
  }, schema.description || `JSON Schema ${title}`, ['schema-definition', 'json-schema']));

  // Definitions
  const defs = schema.definitions || schema.$defs || {};
  for (const [name, def] of Object.entries(defs)) {
    const dId = `schema:${name}`;
    nodes.push(nodeFor(dId, 'schema', name, {
      file: sourceFile, line_start: 1, line_end: 1,
    }, def.description || `Sub-schema ${name}`, ['schema-definition', 'json-schema']));
    edges.push(edgeFor(id, dId, 'contains', { file: sourceFile, line: 1 }, 0.8));
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Markdown mermaid extraction
// ---------------------------------------------------------------------------

function extractMermaidFromMarkdown(content, sourceFile) {
  const blocks = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m; let blockNum = 0;
  while ((m = re.exec(content))) {
    blockNum++;
    const blockStart = lineOf(content, m.index);
    const blockContent = m[1];
    const result = parseMermaid(blockContent, `${sourceFile}#mermaid-${blockNum}`);
    // Adjust line numbers to point back to the markdown file
    for (const n of result.nodes) {
      if (n.source && n.source.line_start) {
        n.source.line_start += blockStart;
        n.source.line_end += blockStart;
      }
    }
    for (const e of result.edges) {
      if (e.source_location && e.source_location.line) {
        e.source_location.line += blockStart;
      }
    }
    blocks.push(result);
  }
  // Combine
  const nodes = []; const edges = [];
  for (const b of blocks) {
    nodes.push(...b.nodes);
    edges.push(...b.edges);
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function processDocument(doc, projectRoot) {
  const abs = join(projectRoot, doc.path);
  let content;
  try { content = readFileSync(abs, 'utf-8'); }
  catch (e) {
    return { source: doc.path, docType: doc.docType, nodes: [], edges: [], error: e.message };
  }

  let result;
  switch (doc.docType) {
    case 'openapi':    result = parseOpenAPI(content, doc.path); break;
    case 'proto':      result = parseProto(content, doc.path); break;
    case 'graphql':    result = parseGraphQL(content, doc.path); break;
    case 'plantuml':   result = parsePlantUML(content, doc.path); break;
    case 'mermaid':    result = parseMermaid(content, doc.path); break;
    case 'jsonschema': result = parseJsonSchema(content, doc.path); break;
    case 'markdown':
      // Only extract embedded mermaid blocks; free-text goes to Phase C
      result = extractMermaidFromMarkdown(content, doc.path);
      break;
    default:           result = { nodes: [], edges: [] };
  }

  return { source: doc.path, docType: doc.docType, nodes: result.nodes, edges: result.edges };
}

function sanitizeSlug(p) {
  return p.replace(/[\\/]/g, '_').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  let split = false;
  let outputPrefix = '02_doc_structured_';
  for (const a of argv) {
    if (a === '--split') split = true;
    else if (a.startsWith('--output-prefix=')) outputPrefix = a.slice('--output-prefix='.length);
    else positional.push(a);
  }
  const [inputPath, outputPath] = positional;
  if (!inputPath || !outputPath) {
    process.stderr.write(
      'Usage: node extract-doc-structure.mjs <input.json> <output> [--split] [--output-prefix=<pfx>]\n' +
      '  Default: writes a single bundled JSON to <output> (a file path).\n' +
      '  --split: writes one JSON per non-markdown doc to <output>/<prefix><slug>.json (treats <output> as a directory).\n' +
      '          The per-file shape ({source, docType, nodes, edges}) is what merge-batch-graphs.mjs --pattern expects.\n'
    );
    process.exit(1);
  }
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const { projectRoot, documents } = input;
  if (!projectRoot || !Array.isArray(documents)) {
    process.stderr.write('Error: input must contain projectRoot + documents\n');
    process.exit(1);
  }

  if (split) {
    mkdirSync(outputPath, { recursive: true });
    let written = 0; let totalNodes = 0; let totalEdges = 0;
    for (const doc of documents) {
      // Skip markdown — those go to FREETEXT workers, not structured parser.
      if (doc.docType === 'markdown' || doc.docType === 'binary') continue;
      const r = processDocument(doc, projectRoot);
      if (r.error) {
        process.stderr.write(`Warning: extract-doc-structure: ${doc.path} — ${r.error}\n`);
        continue;
      }
      const fileName = `${outputPrefix}${sanitizeSlug(doc.path)}.json`;
      writeFileSync(join(outputPath, fileName), JSON.stringify(r, null, 2));
      written++;
      totalNodes += r.nodes.length;
      totalEdges += r.edges.length;
    }
    process.stderr.write(
      `extract-doc-structure (split): wrote ${written} files, totalNodes=${totalNodes} totalEdges=${totalEdges}\n`
    );
    return;
  }

  const results = [];
  let totalNodes = 0; let totalEdges = 0;
  for (const doc of documents) {
    const r = processDocument(doc, projectRoot);
    if (r.error) {
      process.stderr.write(`Warning: extract-doc-structure: ${doc.path} — ${r.error}\n`);
    }
    results.push(r);
    totalNodes += r.nodes.length;
    totalEdges += r.edges.length;
  }

  const out = {
    scriptCompleted: true,
    documentsProcessed: results.length,
    totalNodes, totalEdges,
    results,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(`extract-doc-structure: docs=${results.length} nodes=${totalNodes} edges=${totalEdges}\n`);
}

main();
