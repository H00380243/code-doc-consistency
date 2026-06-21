#!/usr/bin/env node
/**
 * collect-stats.mjs — Pipeline statistics collector + dashboard output
 *
 * Reads all intermediate output files from the _workspace directory and
 * generates a consolidated statistics report with metrics from each phase.
 * Useful for monitoring pipeline performance and identifying bottlenecks.
 *
 * Usage:
 *   node collect-stats.mjs <workspaceDir> <outputPath> [--format=json|text|both]
 *
 * Input:  All intermediate files in _workspace/
 * Output: { scriptCompleted, stats, phases, dashboard }
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// ── File readers ───────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function countFiles(dir, pattern) {
  try {
    const files = readdirSync(dir);
    return files.filter(f => pattern.test(f)).length;
  } catch {
    return 0;
  }
}

function getDirSize(dir) {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else {
        total += statSync(fullPath).size;
      }
    }
  } catch {}
  return total;
}

// ── Phase statistics collectors ─────────────────────────────────────────────

function collectScanStats(workspace) {
  const scan = readJsonSafe(join(workspace, '01_code_scan.json'));
  if (!scan) return null;

  const files = scan.files || [];
  const byCategory = {};
  const byLanguage = {};

  for (const f of files) {
    byCategory[f.fileCategory] = (byCategory[f.fileCategory] || 0) + 1;
    byLanguage[f.language] = (byLanguage[f.language] || 0) + 1;
  }

  return {
    phase: 'SCAN',
    totalFiles: files.length,
    byCategory,
    byLanguage,
    hasGitignore: scan.hasGitignore !== false,
  };
}

function collectImportStats(workspace) {
  const imp = readJsonSafe(join(workspace, '01_code_imp_out.json'));
  if (!imp) return null;

  const importMap = imp.importMap || {};
  const totalImports = Object.values(importMap).reduce((sum, targets) => sum + targets.length, 0);
  const filesWithImports = Object.keys(importMap).length;

  return {
    phase: 'IMPORTS',
    filesWithImports,
    totalImports,
    avgImportsPerFile: filesWithImports > 0 ? (totalImports / filesWithImports).toFixed(2) : 0,
  };
}

function collectBatchStats(workspace) {
  const batches = readJsonSafe(join(workspace, '01_code_batches.json'));
  if (!batches) return null;

  const batchList = batches.batches || [];
  const totalFiles = batchList.reduce((sum, b) => sum + (b.files?.length || 0), 0);

  return {
    phase: 'BATCHES',
    totalBatches: batchList.length,
    totalFiles,
    avgFilesPerBatch: batchList.length > 0 ? (totalFiles / batchList.length).toFixed(2) : 0,
    batchSizes: batchList.map(b => b.files?.length || 0),
  };
}

function collectSymbolStats(workspace) {
  const sym = readJsonSafe(join(workspace, 'symbol_index.json'));
  if (!sym || !sym.stats) return null;

  return {
    phase: 'SYMBOL_INDEX',
    ...sym.stats,
  };
}

function collectAlignStats(workspace) {
  const align = readJsonSafe(join(workspace, '03_alignment.json'));
  if (!align) return null;

  const matched = align.matched || [];
  const unmatched = align.unmatched || [];
  const byConfidence = { high: 0, medium: 0, low: 0 };

  for (const m of matched) {
    if (m.confidence) byConfidence[m.confidence]++;
  }

  return {
    phase: 'ALIGNMENT',
    totalMatched: matched.length,
    totalUnmatched: unmatched.length,
    byConfidence,
    avgConfidence: matched.length > 0
      ? (matched.reduce((sum, m) => sum + (m.align_confidence || 0), 0) / matched.length).toFixed(3)
      : 0,
  };
}

function collectValidationStats(workspace) {
  const validation = readJsonSafe(join(workspace, '04_validation.json'));
  if (!validation) return null;

  return {
    phase: 'VALIDATION',
    decision: validation.decision || 'unknown',
    schemaErrors: validation.schemaErrors?.length || 0,
    qualityIssues: validation.qualityIssues?.length || 0,
    danglingEdges: validation.danglingEdges?.length || 0,
    duplicateNodes: validation.duplicateNodes?.length || 0,
    duplicateEdges: validation.duplicateEdges?.length || 0,
  };
}

function collectDiffStats(workspace) {
  const diff = readJsonSafe(join(workspace, '05_diff.json'));
  if (!diff) return null;

  const layers = diff.layers || {};
  return {
    phase: 'DIFF',
    totalIssues: diff.totalIssues || 0,
    layers: Object.entries(layers).map(([name, data]) => ({
      name,
      count: Array.isArray(data) ? data.length : (data?.count || 0),
    })),
  };
}

// ── Dashboard formatter ─────────────────────────────────────────────────────

function formatDashboard(stats) {
  const lines = [];
  const sep = '─'.repeat(60);

  lines.push(sep);
  lines.push('  CDC Pipeline Dashboard');
  lines.push(sep);

  // Overall summary
  const phases = stats.phases.filter(p => p !== null);
  lines.push(`  Phases completed: ${phases.length}/6`);
  lines.push('');

  // Per-phase summary
  for (const phase of phases) {
    lines.push(`  [${phase.phase}]`);
    switch (phase.phase) {
      case 'SCAN':
        lines.push(`    Files scanned:     ${phase.totalFiles}`);
        lines.push(`    Languages:         ${Object.entries(phase.byLanguage).map(([k,v]) => `${k}(${v})`).join(', ')}`);
        lines.push(`    Categories:        ${Object.entries(phase.byCategory).map(([k,v]) => `${k}(${v})`).join(', ')}`);
        break;
      case 'IMPORTS':
        lines.push(`    Files with imports: ${phase.filesWithImports}`);
        lines.push(`    Total imports:      ${phase.totalImports}`);
        lines.push(`    Avg per file:       ${phase.avgImportsPerFile}`);
        break;
      case 'BATCHES':
        lines.push(`    Total batches:      ${phase.totalBatches}`);
        lines.push(`    Total files:        ${phase.totalFiles}`);
        lines.push(`    Avg files/batch:    ${phase.avgFilesPerBatch}`);
        break;
      case 'SYMBOL_INDEX':
        lines.push(`    Total symbols:      ${phase.totalSymbols}`);
        lines.push(`    Unique names:       ${phase.uniqueSymbolNames}`);
        lines.push(`    By type:            ${Object.entries(phase.byType || {}).map(([k,v]) => `${k}(${v})`).join(', ')}`);
        break;
      case 'ALIGNMENT':
        lines.push(`    Matched:            ${phase.totalMatched}`);
        lines.push(`    Unmatched:          ${phase.totalUnmatched}`);
        lines.push(`    Confidence:         H=${phase.byConfidence.high} M=${phase.byConfidence.medium} L=${phase.byConfidence.low}`);
        lines.push(`    Avg confidence:     ${phase.avgConfidence}`);
        break;
      case 'VALIDATION':
        lines.push(`    Decision:           ${phase.decision}`);
        lines.push(`    Schema errors:      ${phase.schemaErrors}`);
        lines.push(`    Quality issues:     ${phase.qualityIssues}`);
        lines.push(`    Dangling edges:     ${phase.danglingEdges}`);
        break;
      case 'DIFF':
        lines.push(`    Total issues:       ${phase.totalIssues}`);
        for (const layer of phase.layers) {
          lines.push(`    ${layer.name.padEnd(20)} ${layer.count}`);
        }
        break;
    }
    lines.push('');
  }

  // Timing
  if (stats.timing) {
    lines.push('  [TIMING]');
    for (const [phase, ms] of Object.entries(stats.timing)) {
      lines.push(`    ${phase.padEnd(20)} ${ms}ms`);
    }
    lines.push('');
  }

  // Workspace size
  lines.push(`  Workspace size:     ${formatBytes(stats.workspaceSize || 0)}`);
  lines.push(sep);

  return lines.join('\n');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const [workspace, outputPath] = args;
  let format = 'both';

  for (const a of args.slice(2)) {
    if (a.startsWith('--format=')) format = a.slice(9);
  }

  if (!workspace || !outputPath) {
    process.stderr.write(
      'Usage: node collect-stats.mjs <workspaceDir> <output.json> [--format=json|text|both]\n'
    );
    process.exit(1);
  }

  const startTime = Date.now();

  // Collect stats from all phases
  const scanStats = collectScanStats(workspace);
  const importStats = collectImportStats(workspace);
  const batchStats = collectBatchStats(workspace);
  const symbolStats = collectSymbolStats(workspace);
  const alignStats = collectAlignStats(workspace);
  const validationStats = collectValidationStats(workspace);
  const diffStats = collectDiffStats(workspace);

  const phases = [
    scanStats,
    importStats,
    batchStats,
    symbolStats,
    alignStats,
    validationStats,
    diffStats,
  ].filter(s => s !== null);

  const collectTime = Date.now() - startTime;

  // Overall stats
  const totalFiles = scanStats?.totalFiles || 0;
  const totalSymbols = symbolStats?.totalSymbols || 0;
  const totalMatched = alignStats?.totalMatched || 0;
  const totalIssues = diffStats?.totalIssues || 0;
  const validationDecision = validationStats?.decision || 'unknown';

  const stats = {
    scriptCompleted: true,
    stats: {
      totalFiles,
      totalSymbols,
      totalMatched,
      totalIssues,
      validationDecision,
      phasesCompleted: phases.length,
    },
    phases,
    timing: { collectStats: collectTime },
    workspaceSize: getDirSize(workspace),
  };

  // Generate dashboard text
  const dashboard = formatDashboard(stats);
  stats.dashboard = dashboard;

  // Write output
  mkdirSync(join(outputPath, '..'), { recursive: true });

  if (format === 'json' || format === 'both') {
    writeFileSync(outputPath, JSON.stringify(stats, null, 2));
  }
  if (format === 'text' || format === 'both') {
    const textPath = outputPath.replace(/\.json$/, '.txt');
    writeFileSync(textPath, dashboard);
  }

  process.stderr.write(
    `collect-stats: phases=${phases.length} files=${totalFiles} symbols=${totalSymbols} ` +
    `matched=${totalMatched} issues=${totalIssues} decision=${validationDecision}\n`
  );
}

main();
