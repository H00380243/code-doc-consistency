#!/usr/bin/env node
/**
 * compute-batches.mjs — Phase B (BATCH) of /code-graph-rag
 *
 * Self-contained adaptation: directory-based + size-bounded batching with
 * neighborMap construction from importMap. Drops Understand-Anything's
 * Louvain community-detection (graphology dep) for a simpler but
 * deterministic strategy: group by top-level directory, split groups that
 * exceed BATCH_MAX_FILES, then fill any leftover singletons into a "misc"
 * batch. Empirically yields batches of comparable semantic cohesion for
 * the consistency-check use case where batch boundaries don't have to be
 * graph-optimal — they only have to keep neighborMap small enough for
 * cross-batch edges to be issuable.
 *
 * Usage:
 *   node compute-batches.mjs <scanResultPath> <importMapPath> <outputPath>
 *                            [--max-files=15] [--exports-from=<path>]
 *
 * Input:
 *   scanResultPath:    output of scan-project.mjs
 *   importMapPath:     output of extract-import-map.mjs
 *   exports-from path: optional pre-computed exports JSON (per-path symbols).
 *                      If absent, exports are extracted lazily from
 *                      extract-structure.mjs output (one shared call upstream).
 *
 * Output:
 *   {
 *     "totalBatches": N,
 *     "batches": [{ batchIndex, batchFiles[], batchImportData{}, neighborMap{} }]
 *   }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';

function topDir(path) {
  const idx = path.indexOf('/');
  return idx === -1 ? '__root__' : path.slice(0, idx);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildBatches(files, maxFiles) {
  // 1. Group by top-level directory
  const groups = {};
  for (const f of files) {
    const k = topDir(f.path);
    (groups[k] ||= []).push(f);
  }

  // 2. Split oversized groups; deterministic order (path.localeCompare)
  const batches = [];
  const groupKeys = Object.keys(groups).sort();
  for (const k of groupKeys) {
    const sorted = groups[k].sort((a, b) => a.path.localeCompare(b.path));
    if (sorted.length <= maxFiles) {
      batches.push(sorted);
    } else {
      // Sub-group by next-level dir; any sub-group larger than maxFiles also splits
      const subgroups = {};
      for (const f of sorted) {
        const rest = f.path.slice(k.length + 1);
        const sub = rest.indexOf('/') === -1 ? '__direct__' : rest.slice(0, rest.indexOf('/'));
        (subgroups[sub] ||= []).push(f);
      }
      const subKeys = Object.keys(subgroups).sort();
      for (const sk of subKeys) {
        const subFiles = subgroups[sk].sort((a, b) => a.path.localeCompare(b.path));
        if (subFiles.length <= maxFiles) batches.push(subFiles);
        else for (const part of chunk(subFiles, maxFiles)) batches.push(part);
      }
    }
  }

  // 3. Coalesce tiny batches (<3 files) with the next batch when possible to
  //    reduce LLM call overhead, but never beyond maxFiles
  const coalesced = [];
  for (const b of batches) {
    if (coalesced.length && b.length < 3 && coalesced[coalesced.length - 1].length + b.length <= maxFiles) {
      coalesced[coalesced.length - 1].push(...b);
    } else {
      coalesced.push(b);
    }
  }
  return coalesced;
}

function loadExports(exportsPath, batchFiles) {
  // exportsPath: optional JSON of { <path>: [<symbol>, ...] }
  // If missing, return empty map (neighborMap will list paths without symbols).
  if (exportsPath && existsSync(exportsPath)) {
    return JSON.parse(readFileSync(exportsPath, 'utf-8'));
  }
  return {};
}

function buildNeighborMap(batches, importMap, exportsByPath) {
  // Reverse import index: target → [source]
  const reverseImports = {};
  for (const [src, targets] of Object.entries(importMap)) {
    for (const t of targets) {
      (reverseImports[t] ||= []).push(src);
    }
  }
  // For each file, batchIndex
  const batchIndexOf = {};
  batches.forEach((b, i) => b.forEach(f => { batchIndexOf[f.path] = i; }));

  // Per-batch neighborMap
  const result = batches.map((batch, batchIndex) => {
    const batchPaths = new Set(batch.map(f => f.path));
    const batchImportData = {};
    const neighborMap = {};

    for (const f of batch) {
      // batchImportData: this file's resolved imports (regardless of cross-batch)
      batchImportData[f.path] = importMap[f.path] || [];

      // neighborMap: cross-batch neighbors only
      const neighbors = new Map(); // key = neighbor path
      // Outgoing: imports that land in another batch
      for (const t of (importMap[f.path] || [])) {
        if (batchPaths.has(t)) continue;
        const ni = batchIndexOf[t];
        if (ni === undefined) continue;
        neighbors.set(t, { path: t, batchIndex: ni, symbols: exportsByPath[t] || [] });
      }
      // Incoming: files in other batches that import this one
      for (const src of (reverseImports[f.path] || [])) {
        if (batchPaths.has(src)) continue;
        const ni = batchIndexOf[src];
        if (ni === undefined) continue;
        if (!neighbors.has(src)) {
          neighbors.set(src, { path: src, batchIndex: ni, symbols: exportsByPath[src] || [] });
        }
      }
      if (neighbors.size) neighborMap[f.path] = [...neighbors.values()];
    }

    return { batchIndex, batchFiles: batch, batchImportData, neighborMap };
  });

  return result;
}

function main() {
  const args = process.argv.slice(2);
  const [scanResultPath, importMapPath, outputPath] = args;
  if (!scanResultPath || !importMapPath || !outputPath) {
    process.stderr.write('Usage: node compute-batches.mjs <scan-result.json> <import-map.json> <output.json> [--max-files=15] [--exports-from=<path>]\n');
    process.exit(1);
  }
  const maxArg = args.find(a => a.startsWith('--max-files='));
  const maxFiles = maxArg ? parseInt(maxArg.slice(12)) : 15;
  const expArg = args.find(a => a.startsWith('--exports-from='));
  const exportsPath = expArg ? expArg.slice(15) : null;

  const scan = JSON.parse(readFileSync(scanResultPath, 'utf-8'));
  const imp = JSON.parse(readFileSync(importMapPath, 'utf-8'));
  const importMap = imp.importMap || {};

  // Only batch files with fileCategory in {code, script, docs, infra, data, config, markup}
  const files = (scan.files || []).filter(f => f.fileCategory !== 'unknown');
  const batches = buildBatches(files, maxFiles);
  const exportsByPath = loadExports(exportsPath, files);
  const enriched = buildNeighborMap(batches, importMap, exportsByPath);

  const out = { totalBatches: enriched.length, batches: enriched };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(`compute-batches: totalBatches=${enriched.length} maxFiles=${maxFiles}\n`);
}

main();
