#!/usr/bin/env node
/**
 * generate-mermaid.mjs — Generate Mermaid diagram for consistency reports
 *
 * Reads alignment, validation, and diff data to produce a visual Mermaid
 * diagram showing graph structure, node alignment, and consistency issues.
 *
 * Usage:
 *   node generate-mermaid.mjs <workspaceDir> <outputPath> [--format=graph|alignment|issues|all]
 *
 * Input:  _workspace/03_alignment.json, 04_validation.json, 05_diff.json
 * Output: { scriptCompleted, diagrams: { graph?, alignment?, issues? }, markdown }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function escapeMermaid(str) {
  if (!str) return '';
  return str.replace(/"/g, "'").replace(/[<>{}|]/g, '_').substring(0, 30);
}

function truncate(str, max = 20) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max - 3) + '...' : str;
}

// ── Diagram generators ───────────────────────────────────────────────────────

function generateGraphDiagram(codeGraph, docGraph) {
  const lines = [];
  lines.push('graph LR');
  lines.push('  subgraph code["Code Graph"]');
  lines.push('    style code fill:#e1f5fe,stroke:#0288d1');
  lines.push('  end');
  lines.push('  subgraph doc["Doc Graph"]');
  lines.push('    style doc fill:#fff3e0,stroke:#f57c00');
  lines.push('  end');

  // Code nodes
  const codeNodes = (codeGraph?.nodes || []).slice(0, 15);
  for (const node of codeNodes) {
    const id = escapeMermaid(node.id);
    const label = escapeMermaid(truncate(node.name, 15));
    const shape = node.type === 'class' ? '([' : '[/';
    const endShape = node.type === 'class' ? '])' : ']';
    lines.push(`  code_${id}${shape}"${label}"${endShape}`);
  }

  // Doc nodes
  const docNodes = (docGraph?.nodes || []).slice(0, 15);
  for (const node of docNodes) {
    const id = escapeMermaid(node.id);
    const label = escapeMermaid(truncate(node.name, 15));
    lines.push(`  doc_${id}["${label}"]`);
  }

  // Code edges (limit to 20)
  const codeEdges = (codeGraph?.edges || []).slice(0, 20);
  for (const edge of codeEdges) {
    const src = escapeMermaid(edge.source);
    const tgt = escapeMermaid(edge.target);
    lines.push(`  code_${src} --> code_${tgt}`);
  }

  // Doc edges (limit to 20)
  const docEdges = (docGraph?.edges || []).slice(0, 20);
  for (const edge of docEdges) {
    const src = escapeMermaid(edge.source);
    const tgt = escapeMermaid(edge.target);
    lines.push(`  doc_${src} -.-> doc_${tgt}`);
  }

  return lines.join('\n');
}

function generateAlignmentDiagram(alignment) {
  const lines = [];
  lines.push('graph LR');
  lines.push('  subgraph matched["Matched Nodes"]');
  lines.push('    style matched fill:#c8e6c9,stroke:#388e3c');
  lines.push('  end');
  lines.push('  subgraph code_only["Code Only"]');
  lines.push('    style code_only fill:#ffcdd2,stroke:#d32f2f');
  lines.push('  end');
  lines.push('  subgraph doc_only["Doc Only"]');
  lines.push('    style doc_only fill:#fff9c4,stroke:#fbc02d');
  lines.push('  end');

  // Matched nodes (limit to 10)
  const matched = (alignment?.matched || []).slice(0, 10);
  for (const m of matched) {
    const codeId = escapeMermaid(m.codeNodeId || m.codeId || '');
    const docId = escapeMermaid(m.docNodeId || m.docId || '');
    const conf = m.confidence || 'medium';
    const style = conf === 'high' ? 'stroke:#2e7d32,stroke-width:2px' :
                  conf === 'low' ? 'stroke:#c62828,stroke-dasharray:5,5' : '';
    lines.push(`  matched_${codeId}["${truncate(codeId, 12)}"]`);
    lines.push(`  matched_${docId}["${truncate(docId, 12)}"]`);
    if (style) {
      lines.push(`  style matched_${codeId} ${style}`);
      lines.push(`  style matched_${docId} ${style}`);
    }
    lines.push(`  matched_${codeId} <--> matched_${docId}`);
  }

  // Code only nodes (limit to 8)
  const codeOnly = (alignment?.code_only || alignment?.codeOnly || []).slice(0, 8);
  for (const c of codeOnly) {
    const id = escapeMermaid(c.id || c.nodeId || '');
    lines.push(`  code_only_${id}["${truncate(id, 12)}"]`);
  }

  // Doc only nodes (limit to 8)
  const docOnly = (alignment?.doc_only || alignment?.docOnly || []).slice(0, 8);
  for (const d of docOnly) {
    const id = escapeMermaid(d.id || d.nodeId || '');
    lines.push(`  doc_only_${id}["${truncate(id, 12)}"]`);
  }

  return lines.join('\n');
}

function generateIssuesDiagram(diff) {
  const lines = [];
  lines.push('graph TD');
  lines.push('  subgraph critical["Critical Issues"]');
  lines.push('    style critical fill:#ffcdd2,stroke:#d32f2f');
  lines.push('  end');
  lines.push('  subgraph major["Major Issues"]');
  lines.push('    style major fill:#fff3e0,stroke:#f57c00');
  lines.push('  end');
  lines.push('  subgraph minor["Minor Issues"]');
  lines.push('    style minor fill:#e8f5e9,stroke:#388e3c');
  lines.push('  end');

  const layers = diff?.layers || {};
  let issueIdx = 0;

  // Process each layer
  for (const [layerName, layerData] of Object.entries(layers)) {
    const items = Array.isArray(layerData) ? layerData : (layerData?.items || []);
    for (const item of items.slice(0, 5)) {
      const severity = item.severity || 'minor';
      const category = severity === 'critical' ? 'critical' :
                       severity === 'major' ? 'major' : 'minor';
      const label = escapeMermaid(truncate(
        item.description || item.issue || item.name || 'Issue',
        20
      ));
      const id = `issue_${issueIdx++}`;
      lines.push(`  ${category}_${id}["${label}"]`);
    }
  }

  // Summary node
  const totalIssues = diff?.totalIssues || 0;
  lines.push(`  summary["Total: ${totalIssues} issues"]`);
  lines.push(`  critical --> summary`);
  lines.push(`  major --> summary`);
  lines.push(`  minor --> summary`);

  return lines.join('\n');
}

// ── Markdown report ──────────────────────────────────────────────────────────

function generateMarkdownReport(diagrams, stats) {
  const lines = [];
  lines.push('# CDC Pipeline — Consistency Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  if (stats) {
    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    if (stats.totalFiles) lines.push(`| Files analyzed | ${stats.totalFiles} |`);
    if (stats.totalSymbols) lines.push(`| Symbols extracted | ${stats.totalSymbols} |`);
    if (stats.totalMatched !== undefined) lines.push(`| Nodes matched | ${stats.totalMatched} |`);
    if (stats.totalIssues !== undefined) lines.push(`| Issues found | ${stats.totalIssues} |`);
    if (stats.validationDecision) lines.push(`| Decision | ${stats.validationDecision} |`);
    lines.push('');
  }

  if (diagrams.graph) {
    lines.push('## Graph Structure');
    lines.push('');
    lines.push('```mermaid');
    lines.push(diagrams.graph);
    lines.push('```');
    lines.push('');
  }

  if (diagrams.alignment) {
    lines.push('## Node Alignment');
    lines.push('');
    lines.push('```mermaid');
    lines.push(diagrams.alignment);
    lines.push('```');
    lines.push('');
  }

  if (diagrams.issues) {
    lines.push('## Consistency Issues');
    lines.push('');
    lines.push('```mermaid');
    lines.push(diagrams.issues);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const [workspace, outputPath] = args;
  let format = 'all';

  for (const a of args.slice(2)) {
    if (a.startsWith('--format=')) format = a.slice(9);
  }

  if (!workspace || !outputPath) {
    process.stderr.write(
      'Usage: node generate-mermaid.mjs <workspaceDir> <output.json> [--format=graph|alignment|issues|all]\n'
    );
    process.exit(1);
  }

  // Read input files
  const codeGraph = readJsonSafe(join(workspace, '01_code_assembled.json'))
    || readJsonSafe(join(workspace, '01_code_graph.json'));
  const docGraph = readJsonSafe(join(workspace, '02_doc_assembled.json'))
    || readJsonSafe(join(workspace, '02_doc_graph.json'));
  const alignment = readJsonSafe(join(workspace, '03_alignment.json'));
  const validation = readJsonSafe(join(workspace, '04_validation.json'));
  const diff = readJsonSafe(join(workspace, '05_diff.json'));
  const stats = readJsonSafe(join(workspace, 'stats.json'));

  const diagrams = {};

  // Generate requested diagrams
  if (format === 'all' || format === 'graph') {
    if (codeGraph || docGraph) {
      diagrams.graph = generateGraphDiagram(codeGraph, docGraph);
    }
  }

  if (format === 'all' || format === 'alignment') {
    if (alignment) {
      diagrams.alignment = generateAlignmentDiagram(alignment);
    }
  }

  if (format === 'all' || format === 'issues') {
    if (diff) {
      diagrams.issues = generateIssuesDiagram(diff);
    }
  }

  // Generate markdown report
  const markdown = generateMarkdownReport(diagrams, stats?.stats);

  // Build output
  const output = {
    scriptCompleted: true,
    diagrams,
    markdown,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  // Also write markdown file
  const mdPath = outputPath.replace(/\.json$/, '.md');
  writeFileSync(mdPath, markdown);

  process.stderr.write(
    `generate-mermaid: diagrams=${Object.keys(diagrams).length} format=${format}\n`
  );
}

main();
