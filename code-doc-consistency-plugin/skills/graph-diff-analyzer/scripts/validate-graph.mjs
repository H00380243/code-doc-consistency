#!/usr/bin/env node
/**
 * validate-graph.mjs — Phase E (REVIEW) script for graph-reviewer agent.
 *
 * Self-contained Node port of validate-graph.py (Python often unavailable on
 * Windows). Performs schema/integrity/quality checks; outputs a structured
 * report. Always exits 0 unless the script itself crashes — the `decision`
 * field carries pass / pass_with_warnings / reject.
 *
 * Usage:
 *   node validate-graph.mjs <graph.json> <report.json> [--side=code|design]
 *   node validate-graph.mjs ignored      <report.json> --code=<a.json> --doc=<b.json>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const VALID_NODE_TYPES = new Set([
  'file', 'function', 'class', 'module', 'concept',
  'config', 'document', 'service', 'table', 'endpoint',
  'pipeline', 'schema', 'resource',
  'domain', 'flow', 'step',
]);

const VALID_EDGE_TYPES = new Set([
  'imports', 'exports', 'contains', 'inherits', 'implements',
  'calls', 'subscribes', 'publishes', 'middleware',
  'reads_from', 'writes_to', 'transforms', 'validates',
  'depends_on', 'tested_by', 'configures',
  'related', 'similar_to',
  'deploys', 'serves', 'provisions', 'triggers',
  'migrates', 'documents', 'routes', 'defines_schema',
  'contains_flow', 'flow_step', 'cross_domain',
]);

const VALID_DIRECTIONS = new Set(['forward', 'backward', 'bidirectional']);
const VALID_COMPLEXITY = new Set(['simple', 'moderate', 'complex']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

const ID_PREFIX_RE = /^([a-z_]+):(.+)$/;
const LOWER_HYPHEN_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateNode(node, idx) {
  const issues = [];
  const nid = node.id;
  if (typeof nid !== 'string' || !nid) {
    issues.push({ node_index: idx, field: 'id', issue: 'missing or non-string' });
    return issues;
  }
  const m = ID_PREFIX_RE.exec(nid);
  if (!m || !VALID_NODE_TYPES.has(m[1])) {
    issues.push({ node_id: nid, field: 'id', issue: `invalid prefix (expected one of ${[...VALID_NODE_TYPES].sort().join(', ')})` });
  }
  if (!VALID_NODE_TYPES.has(node.type)) {
    issues.push({ node_id: nid, field: 'type', issue: `invalid type: ${node.type}` });
  }
  if (m && node.type && m[1] !== node.type) {
    issues.push({ node_id: nid, field: 'type/id', issue: `prefix "${m[1]}" does not match type "${node.type}"` });
  }
  if (typeof node.name !== 'string' || !node.name.trim()) {
    issues.push({ node_id: nid, field: 'name', issue: 'missing or empty' });
  }
  const summary = node.summary;
  if (typeof summary !== 'string' || !summary.trim()) {
    issues.push({ node_id: nid, field: 'summary', issue: 'missing or empty' });
  } else if (summary.trim().length < 10) {
    issues.push({ node_id: nid, field: 'summary', issue: 'too short (<10 chars)', severity: 'quality' });
  } else if (node.name && summary.trim() === node.name.trim()) {
    issues.push({ node_id: nid, field: 'summary', issue: 'equals name', severity: 'quality' });
  } else if (node.filePath && summary.trim() === node.filePath) {
    issues.push({ node_id: nid, field: 'summary', issue: 'equals file path', severity: 'quality' });
  }
  if (!Array.isArray(node.tags) || node.tags.length === 0) {
    issues.push({ node_id: nid, field: 'tags', issue: 'missing or empty' });
  } else {
    for (const t of node.tags) {
      if (typeof t !== 'string') {
        issues.push({ node_id: nid, field: 'tags', issue: `non-string tag: ${JSON.stringify(t)}` });
      } else if (!LOWER_HYPHEN_RE.test(t)) {
        issues.push({ node_id: nid, field: 'tags', issue: `tag not lowercase-hyphenated: "${t}"`, severity: 'quality' });
      }
    }
  }
  if (node.complexity != null && !VALID_COMPLEXITY.has(node.complexity)) {
    issues.push({ node_id: nid, field: 'complexity', issue: `invalid: ${node.complexity}` });
  }
  if (node.confidence != null && !VALID_CONFIDENCE.has(node.confidence)) {
    issues.push({ node_id: nid, field: 'confidence', issue: `invalid: ${node.confidence}` });
  }
  return issues;
}

function validateEdge(edge, idx, validIds) {
  const issues = [];
  if (typeof edge.source !== 'string' || !edge.source) {
    issues.push({ edge_index: idx, field: 'source', issue: 'missing' });
  } else if (!validIds.has(edge.source)) {
    issues.push({ edge_index: idx, field: 'source', issue: `dangling: ${edge.source} not in nodes` });
  }
  if (typeof edge.target !== 'string' || !edge.target) {
    issues.push({ edge_index: idx, field: 'target', issue: 'missing' });
  } else if (!validIds.has(edge.target)) {
    issues.push({ edge_index: idx, field: 'target', issue: `dangling: ${edge.target} not in nodes` });
  }
  if (!VALID_EDGE_TYPES.has(edge.type)) {
    issues.push({ edge_index: idx, field: 'type', issue: `invalid type: ${edge.type}` });
  }
  if (edge.direction != null && !VALID_DIRECTIONS.has(edge.direction)) {
    issues.push({ edge_index: idx, field: 'direction', issue: `invalid: ${edge.direction}` });
  }
  if (edge.weight === undefined || edge.weight === null) {
    issues.push({ edge_index: idx, field: 'weight', issue: 'missing' });
  } else {
    const w = parseFloat(edge.weight);
    if (Number.isNaN(w)) issues.push({ edge_index: idx, field: 'weight', issue: `not a number: ${JSON.stringify(edge.weight)}` });
    else if (w < 0 || w > 1) issues.push({ edge_index: idx, field: 'weight', issue: `out of [0,1]: ${w}` });
  }
  return issues;
}

function validateGraph(graph, side) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const validIds = new Set();
  const seenNodes = new Set();
  const dupNodes = [];
  for (const n of nodes) {
    const nid = n.id;
    if (typeof nid === 'string') {
      if (seenNodes.has(nid)) dupNodes.push(nid);
      else seenNodes.add(nid);
      validIds.add(nid);
    }
  }

  const schemaErrors = []; const qualityIssues = [];
  nodes.forEach((n, i) => {
    for (const issue of validateNode(n, i)) {
      if (issue.severity === 'quality') qualityIssues.push(issue);
      else schemaErrors.push(issue);
    }
  });

  const danglingEdges = []; const dupEdges = [];
  const seenEdges = new Set();
  edges.forEach((e, i) => {
    const k = `${e.source}\x00${e.target}\x00${e.type}`;
    if (seenEdges.has(k)) dupEdges.push({ edge_index: i, key: [e.source, e.target, e.type] });
    else seenEdges.add(k);
    for (const issue of validateEdge(e, i, validIds)) {
      if ((issue.issue || '').includes('dangling')) danglingEdges.push(issue);
      else schemaErrors.push(issue);
    }
  });

  const completeness = {
    node_count: nodes.length,
    edge_count: edges.length,
    has_nodes: nodes.length > 0,
    has_edges: edges.length > 0,
  };

  let decision; let reason;
  if (!completeness.has_nodes) {
    decision = 'reject'; reason = 'graph has no nodes';
  } else if (schemaErrors.length) {
    const threshold = Math.max(5, Math.floor((nodes.length + edges.length) / 20));
    if (schemaErrors.length > threshold) {
      decision = 'reject'; reason = `${schemaErrors.length} schema errors (>${threshold} threshold)`;
    } else {
      decision = 'pass_with_warnings'; reason = `${schemaErrors.length} schema errors (within tolerance)`;
    }
  } else if (danglingEdges.length || dupNodes.length || dupEdges.length || qualityIssues.length) {
    decision = 'pass_with_warnings';
    reason = `${danglingEdges.length} dangling, ${dupNodes.length} duplicate-nodes, ${dupEdges.length} duplicate-edges, ${qualityIssues.length} quality`;
  } else {
    decision = 'pass'; reason = 'all checks passed';
  }

  return {
    side,
    passed: decision === 'pass',
    decision, reason,
    completeness,
    schema_errors: schemaErrors,
    dangling_edges: danglingEdges,
    duplicate_nodes: dupNodes,
    duplicate_edges: dupEdges,
    quality_issues: qualityIssues,
  };
}

function splitId(nid) {
  const m = ID_PREFIX_RE.exec(nid);
  return m ? [m[1], m[2]] : [null, nid];
}

function crossGraphPredict(codeGraph, docGraph) {
  const warnings = [];
  const codeIds = (codeGraph.nodes || []).map(n => n.id).filter(x => typeof x === 'string');
  const docIds = (docGraph.nodes || []).map(n => n.id).filter(x => typeof x === 'string');

  const codeNames = new Set(codeIds.map(i => splitId(i)[1]));
  const docNames = new Set(docIds.map(i => splitId(i)[1]));

  const codeLower = new Map();
  const docLower = new Map();
  for (const n of codeNames) codeLower.set(n.toLowerCase(), n);
  for (const n of docNames) docLower.set(n.toLowerCase(), n);

  const caseMismatches = [];
  for (const [k, v] of codeLower.entries()) {
    if (docLower.has(k) && docLower.get(k) !== v) caseMismatches.push({ code: v, doc: docLower.get(k) });
  }
  if (caseMismatches.length) {
    warnings.push({
      type: 'id_case_mismatch',
      count: caseMismatches.length,
      examples: caseMismatches.slice(0, 5),
      hint: 'Code and doc use different casing for matching identifiers. Provide an alias map or normalize both builders.',
    });
  }

  function styleOf(name) {
    if (name.includes('/')) return 'path';
    if (name.includes('.') && !name.includes(':')) return 'dotted';
    return 'plain';
  }
  const codeStyles = new Set([...codeNames].map(styleOf));
  const docStyles = new Set([...docNames].map(styleOf));
  if (codeStyles.size && docStyles.size) {
    const shared = [...codeStyles].some(s => docStyles.has(s));
    const same = codeStyles.size === docStyles.size && [...codeStyles].every(s => docStyles.has(s));
    if (!same) {
      warnings.push({
        type: 'id_separator_mismatch',
        code_styles: [...codeStyles].sort(),
        doc_styles: [...docStyles].sort(),
        hint: 'Code and doc use different identifier styles. Cross-graph alignment will need explicit aliases.',
      });
    }
  }
  return warnings;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    process.stderr.write('Usage: node validate-graph.mjs <graph.json> <report.json> [--side=code|design] [--code=<a.json> --doc=<b.json>]\n');
    process.exit(1);
  }
  const [graphPath, reportPath] = args;
  let side = 'code'; let codePath = null; let docPath = null;
  for (const a of args.slice(2)) {
    if (a.startsWith('--side=')) side = a.slice(7);
    else if (a.startsWith('--code=')) codePath = a.slice(7);
    else if (a.startsWith('--doc=')) docPath = a.slice(6);
  }

  let report;
  if (codePath && docPath) {
    const codeGraph = JSON.parse(readFileSync(codePath, 'utf-8'));
    const docGraph = JSON.parse(readFileSync(docPath, 'utf-8'));
    const codeReport = validateGraph(codeGraph, 'code');
    const docReport = validateGraph(docGraph, 'design');
    const cross = crossGraphPredict(codeGraph, docGraph);
    let decision;
    if (codeReport.decision === 'reject' || docReport.decision === 'reject') decision = 'reject';
    else if (codeReport.decision === 'pass_with_warnings' || docReport.decision === 'pass_with_warnings' || cross.length) decision = 'pass_with_warnings';
    else decision = 'pass';
    report = {
      schema_version: '1.0',
      code_graph: codeReport,
      doc_graph: docReport,
      cross_graph_warnings: cross,
      decision,
      summary: `code=${codeReport.decision} (${codeReport.reason}); doc=${docReport.decision} (${docReport.reason}); cross-graph-warnings=${cross.length}`,
    };
  } else {
    const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    report = validateGraph(graph, side);
  }

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stderr.write(`validate-graph: decision=${report.decision}\n`);
}

main();
