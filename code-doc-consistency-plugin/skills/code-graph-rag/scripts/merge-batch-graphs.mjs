#!/usr/bin/env node
/**
 * merge-batch-graphs.mjs — Phase D (MERGE) of /code-graph-rag and /doc-graph-rag.
 *
 * Self-contained Node port of the Python merge script (Python is not always
 * available on Windows — the Microsoft Store stub returns exit 49). Pure
 * stdlib; no npm dependencies.
 *
 * Reads all batch-*.json files from a directory, normalizes IDs/complexity,
 * deduplicates nodes (by id) and edges (by source+target+type), drops
 * dangling edges, and fixes inverted tested_by direction.
 *
 * Usage:
 *   node merge-batch-graphs.mjs <batch-dir> <output-path> [--side=code|design] [--pattern=<glob>,<glob>]
 *
 * --pattern accepts comma-separated glob-lite patterns (only `*` wildcard supported).
 * Examples:
 *   --pattern="01_code_batch_*.json"                          (only code-side worker outputs)
 *   --pattern="02_doc_structured_*.json,02_doc_freetext_*.json" (combine doc structured + freetext)
 *
 * Without --pattern, defaults to legacy batch-<n>[-part-<m>].json + batch-existing.json.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const VALID_PREFIXES = new Set([
  'file', 'function', 'class', 'module', 'concept',
  'config', 'document', 'service', 'table', 'endpoint',
  'pipeline', 'schema', 'resource',
  'domain', 'flow', 'step',
]);

const COMPLEXITY_MAP = {
  low: 'simple', easy: 'simple', trivial: 'simple', simple: 'simple',
  medium: 'moderate', moderate: 'moderate', normal: 'moderate',
  high: 'complex', hard: 'complex', complex: 'complex', very_complex: 'complex',
};

const CONF_RANK = { low: 0, medium: 1, high: 2 };

const TEST_PATH_RE = new RegExp(
  '(?:^|/)(?:__tests__|tests?|spec|specs)/|' +
  '\\.(?:test|spec)\\.(?:[jt]sx?|py|rb|go|java|kt|cs|php|rs|cpp|c)$|' +
  '_test\\.go$|_spec\\.rb$|Test\\.java$|Tests\\.cs$|test_[\\w]+\\.py$',
  'i',
);

const ID_PREFIX_RE = /^([a-z_]+):(.+)$/;

function normalizeId(nodeId, nodeType) {
  if (typeof nodeId !== 'string' || !nodeId) return nodeId;
  // Strip project-name prefix: my-proj:file:foo.ts → file:foo.ts
  const parts = nodeId.split(':');
  if (parts.length >= 3 && VALID_PREFIXES.has(parts[1])) {
    nodeId = parts.slice(1).join(':');
  }
  if (VALID_PREFIXES.has(nodeId.split(':')[0])) return nodeId;
  if (nodeType && VALID_PREFIXES.has(nodeType)) return `${nodeType}:${nodeId}`;
  if (nodeId.includes('/') && nodeId.split('/').pop().includes('.')) return `file:${nodeId}`;
  return nodeId;
}

function normalizeComplexity(value) {
  if (typeof value !== 'string') return 'moderate';
  return COMPLEXITY_MAP[value.toLowerCase()] || 'moderate';
}

function mergeConfidence(a, b) {
  const ra = a in CONF_RANK ? CONF_RANK[a] : -1;
  const rb = b in CONF_RANK ? CONF_RANK[b] : -1;
  if (ra < 0 && rb < 0) return 'medium';
  if (ra < 0) return b;
  if (rb < 0) return a;
  return ra >= rb ? a : b;
}

function mergeNode(existing, incoming) {
  const out = { ...existing };
  // Source: union (dedupe by JSON repr)
  const sources = [];
  for (const s of [existing.source, incoming.source]) {
    if (Array.isArray(s)) sources.push(...s);
    else if (s && typeof s === 'object') sources.push(s);
  }
  if (sources.length) {
    const seen = new Set();
    const unique = [];
    for (const s of sources) {
      const k = JSON.stringify(s);
      if (!seen.has(k)) { seen.add(k); unique.push(s); }
    }
    out.source = unique.length === 1 ? unique[0] : unique;
  }

  out.confidence = mergeConfidence(existing.confidence, incoming.confidence);

  const tagsA = Array.isArray(existing.tags) ? existing.tags : [];
  const tagsB = Array.isArray(incoming.tags) ? incoming.tags : [];
  const seenTags = new Set();
  const merged = [];
  for (const t of [...tagsA, ...tagsB]) {
    if (!seenTags.has(t)) { seenTags.add(t); merged.push(t); }
  }
  if (merged.length) out.tags = merged;

  const aT = !!existing.tentative;
  const bT = !!incoming.tentative;
  if (aT && bT) out.tentative = true;
  else if (aT || bT) {
    if (existing.confidence === 'high' && !aT) out.tentative = false;
    else if (incoming.confidence === 'high' && !bT) out.tentative = false;
    else out.tentative = true;
  }

  // Attributes: detect conflicts
  const attrA = existing.attributes || {};
  const attrB = incoming.attributes || {};
  if (Object.keys(attrA).length && Object.keys(attrB).length) {
    const merged = { ...attrA };
    let conflict = false;
    for (const [k, vB] of Object.entries(attrB)) {
      if (!(k in merged)) merged[k] = vB;
      else if (JSON.stringify(merged[k]) !== JSON.stringify(vB) && vB != null && merged[k] != null) {
        merged[k] = { _a: merged[k], _b: vB };
        conflict = true;
      }
    }
    out.attributes = merged;
    if (conflict) out.conflict = true;
  } else if (Object.keys(attrB).length) {
    out.attributes = attrB;
  }

  const sumA = (existing.summary || '').trim();
  const sumB = (incoming.summary || '').trim();
  if (sumB && (!sumA || (sumB.length > sumA.length * 1.5 && incoming.confidence === 'high'))) {
    if (!sumA && ['high', 'medium'].includes(incoming.confidence)) out.summary = sumB;
    else if (sumB.length > sumA.length * 1.5 && incoming.confidence === 'high') out.summary = sumB;
  }
  if (!out.complexity) out.complexity = normalizeComplexity(incoming.complexity);
  return out;
}

function edgeKey(e) { return `${e.source}\x00${e.target}\x00${e.type}`; }

function mergeEdge(a, b) {
  const out = { ...a };
  out.weight = Math.max(parseFloat(a.weight) || 0.5, parseFloat(b.weight) || 0.5);
  out.confidence = mergeConfidence(a.confidence, b.confidence);
  if (!out.description && b.description) out.description = b.description;
  out.unresolved = !!a.unresolved && !!b.unresolved;
  return out;
}

function isTestFile(nodeId) {
  if (!nodeId.includes(':')) return false;
  return TEST_PATH_RE.test(nodeId.split(':').slice(1).join(':'));
}

function fixupTestedBy(edges) {
  const out = []; let flipped = 0; let dropped = 0;
  for (const e of edges) {
    if (e.type !== 'tested_by') { out.push(e); continue; }
    const srcTest = isTestFile(e.source || '');
    const tgtTest = isTestFile(e.target || '');
    if (srcTest && tgtTest) { dropped++; continue; }
    if (!srcTest && !tgtTest) { e.confidence = 'low'; out.push(e); continue; }
    if (srcTest && !tgtTest) {
      out.push({ ...e, source: e.target, target: e.source });
      flipped++; continue;
    }
    out.push(e);
  }
  return { edges: out, flipped, dropped };
}

function findBatchFiles(dir, customPatterns) {
  const files = [];
  const allEntries = readdirSync(dir).sort();

  if (customPatterns && customPatterns.length) {
    // Treat each pattern as a glob-lite (only `*` wildcard supported).
    const regexes = customPatterns.map(p =>
      new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    );
    for (const f of allEntries) {
      if (regexes.some(re => re.test(f))) files.push(join(dir, f));
    }
    return files;
  }

  // Default behavior: batch-<n>[-part-<m>].json + batch-existing.json
  const re = /^batch-(\d+)(?:-part-(\d+))?\.json$/;
  for (const f of allEntries) {
    if (re.test(f)) files.push(join(dir, f));
  }
  const existing = join(dir, 'batch-existing.json');
  if (existsSync(existing)) files.push(existing);
  return files;
}

function main() {
  const args = process.argv.slice(2);
  const positional = [];
  let side = 'code';
  let patterns = null;
  for (const a of args) {
    if (a.startsWith('--side=')) side = a.slice('--side='.length);
    else if (a.startsWith('--pattern=')) {
      patterns = a.slice('--pattern='.length).split(',').map(p => p.trim()).filter(Boolean);
    } else positional.push(a);
  }
  const [batchDir, outPath] = positional;
  if (!batchDir || !outPath) {
    process.stderr.write(
      'Usage: node merge-batch-graphs.mjs <batch-dir> <output-path> [--side=code|design] [--pattern=<glob>,<glob>]\n' +
      '  --pattern lets you merge files matching specific names (e.g. "01_code_batch_*.json").\n' +
      '  Without --pattern, defaults to batch-<n>[-part-<m>].json + batch-existing.json.\n'
    );
    process.exit(1);
  }

  const batchFiles = findBatchFiles(batchDir, patterns);
  if (!batchFiles.length) {
    const hint = patterns ? `matching ${patterns.join(',')}` : 'batch-*.json';
    process.stderr.write(`merge-batch-graphs: no files ${hint} found in ${batchDir}\n`);
    process.exit(1);
  }

  const nodesById = new Map();
  const edgesByKey = new Map();
  let projectMeta = null;
  let layers = [];
  let rawNodeCount = 0; let rawEdgeCount = 0; let idCorrections = 0;

  for (const path of batchFiles) {
    let data;
    try { data = JSON.parse(readFileSync(path, 'utf-8')); }
    catch (e) {
      process.stderr.write(`Warning: merge-batch-graphs: failed to read ${path}: ${e.message}\n`);
      continue;
    }
    if (!projectMeta && data.project && typeof data.project === 'object') projectMeta = data.project;
    if (Array.isArray(data.layers)) layers.push(...data.layers);

    for (const node of data.nodes || []) {
      rawNodeCount++;
      if ('complexity' in node) node.complexity = normalizeComplexity(node.complexity);
      const oldId = node.id;
      const newId = normalizeId(oldId, node.type);
      if (newId !== oldId) idCorrections++;
      node.id = newId;
      if (nodesById.has(newId)) nodesById.set(newId, mergeNode(nodesById.get(newId), node));
      else nodesById.set(newId, node);
    }

    for (const edge of data.edges || []) {
      rawEdgeCount++;
      edge.source = normalizeId(edge.source);
      edge.target = normalizeId(edge.target);
      if (edge.weight === undefined || edge.weight === null) edge.weight = 0.5;
      if (!edge.direction) edge.direction = 'forward';
      const k = edgeKey(edge);
      if (edgesByKey.has(k)) edgesByKey.set(k, mergeEdge(edgesByKey.get(k), edge));
      else edgesByKey.set(k, edge);
    }
  }

  const validIds = new Set(nodesById.keys());
  let surviving = []; let dangling = 0;
  for (const e of edgesByKey.values()) {
    if (validIds.has(e.source) && validIds.has(e.target)) surviving.push(e);
    else dangling++;
  }
  const fix = fixupTestedBy(surviving);
  surviving = fix.edges;

  for (const layer of layers) {
    if (Array.isArray(layer.nodeIds)) {
      layer.nodeIds = layer.nodeIds.filter(id => validIds.has(id));
    }
  }

  const sortedNodes = [...nodesById.values()].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  surviving.sort((a, b) =>
    (a.source || '').localeCompare(b.source || '') ||
    (a.target || '').localeCompare(b.target || '') ||
    (a.type || '').localeCompare(b.type || '')
  );

  const out = {
    schema_version: '1.0',
    kind: side === 'code' ? 'codebase' : 'design',
    project: projectMeta || {},
    nodes: sortedNodes,
    edges: surviving,
    layers,
    stats: {
      node_count: nodesById.size,
      edge_count: surviving.length,
      raw_node_count: rawNodeCount,
      raw_edge_count: rawEdgeCount,
      id_corrections: idCorrections,
      dangling_edges_dropped: dangling,
      tested_by_flipped: fix.flipped,
      tested_by_dropped: fix.dropped,
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  process.stderr.write(
    `merge-batch-graphs: nodes=${nodesById.size} (from ${rawNodeCount}) ` +
    `edges=${surviving.length} (from ${rawEdgeCount}) ` +
    `id-corrections=${idCorrections} dangling-dropped=${dangling} ` +
    `tested-by-flipped=${fix.flipped} tested-by-dropped=${fix.dropped}\n`
  );
}

main();
