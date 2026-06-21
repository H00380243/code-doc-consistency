#!/usr/bin/env node
/**
 * compute-file-hashes.mjs — Incremental update support
 *
 * Computes MD5 hashes for all scanned files and compares with cached hashes
 * from the previous run. Outputs a manifest identifying changed, new, and
 * deleted files, plus per-batch change status.
 *
 * Usage:
 *   node compute-file-hashes.mjs <scanResultPath> <batchResultPath> <outputPath>
 *                                 [--cache-dir=<dir>] [--full]
 *
 * Input:  scan-project output + compute-batches output
 * Output: {
 *   scriptCompleted, stats,
 *   changed: [{ path, status: "changed"|"new"|"deleted" }],
 *   unchanged: [{ path }],
 *   batchChanges: { <batchIndex>: { changed: bool, changedFiles: [], totalFiles: int } },
 *   hashCache: { <path>: "<md5>" }
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

function computeFileHash(absPath) {
  try {
    const content = readFileSync(absPath);
    return createHash('md5').update(content).digest('hex');
  } catch {
    return null;
  }
}

function computeFileHashes(files, projectRoot) {
  const hashes = {};
  for (const file of files) {
    const absPath = join(projectRoot, file.path);
    const hash = computeFileHash(absPath);
    if (hash !== null) {
      hashes[file.path] = hash;
    }
  }
  return hashes;
}

function loadCachedHashes(cacheDir) {
  const cachePath = join(cacheDir, 'file_hashes.json');
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCachedHashes(cacheDir, hashes) {
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, 'file_hashes.json');
  writeFileSync(cachePath, JSON.stringify(hashes, null, 2));
}

function diffHashes(oldHashes, newHashes, allPaths) {
  const changed = [];
  const unchanged = [];
  const oldSet = new Set(Object.keys(oldHashes));
  const newSet = new Set(Object.keys(newHashes));

  for (const path of allPaths) {
    const oldHash = oldHashes[path];
    const newHash = newHashes[path];

    if (oldHash === undefined) {
      changed.push({ path, status: 'new' });
    } else if (newHash === undefined) {
      changed.push({ path, status: 'deleted' });
    } else if (oldHash !== newHash) {
      changed.push({ path, status: 'changed' });
    } else {
      unchanged.push({ path });
    }
  }

  return { changed, unchanged };
}

function computeBatchChanges(batches, changedPaths) {
  const changedSet = new Set(changedPaths.map(c => c.path));
  const batchChanges = {};

  for (const batch of batches) {
    const batchIndex = batch.batchIndex;
    const batchFiles = (batch.batchFiles || []).map(f => typeof f === 'string' ? f : f.path);
    const changedInBatch = batchFiles.filter(f => changedSet.has(f));

    batchChanges[batchIndex] = {
      changed: changedInBatch.length > 0,
      changedFiles: changedInBatch,
      totalFiles: batchFiles.length,
      changeRatio: batchFiles.length > 0 ? (changedInBatch.length / batchFiles.length).toFixed(3) : '0',
    };
  }

  return batchChanges;
}

function main() {
  const args = process.argv.slice(2);
  const [scanResultPath, batchResultPath, outputPath] = args;

  let cacheDir = null;
  let forceFull = false;
  let projectRoot = null;

  for (const a of args.slice(3)) {
    if (a.startsWith('--cache-dir=')) cacheDir = a.slice(12);
    else if (a === '--full') forceFull = true;
    else if (a.startsWith('--project-root=')) projectRoot = a.slice(15);
  }

  if (!scanResultPath || !batchResultPath || !outputPath) {
    process.stderr.write(
      'Usage: node compute-file-hashes.mjs <scan-result.json> <batches.json> <output.json>\n' +
      '  [--cache-dir=<dir>] [--project-root=<path>] [--full]\n'
    );
    process.exit(1);
  }

  const scan = JSON.parse(readFileSync(scanResultPath, 'utf-8'));
  const batchData = JSON.parse(readFileSync(batchResultPath, 'utf-8'));
  const batches = batchData.batches || [];

  const files = (scan.files || []).filter(f => f.fileCategory !== 'unknown');
  const allPaths = files.map(f => f.path);

  // Compute current hashes
  const newHashes = projectRoot
    ? computeFileHashes(files, projectRoot)
    : {};

  // Load cached hashes (or empty if --full)
  const resolvedCacheDir = cacheDir || join(dirname(outputPath), '..', 'cache_hash');
  const oldHashes = forceFull ? {} : loadCachedHashes(resolvedCacheDir);

  // Diff
  const { changed, unchanged } = forceFull
    ? { changed: allPaths.map(p => ({ path: p, status: 'new' })), unchanged: [] }
    : diffHashes(oldHashes, newHashes, allPaths);

  // Per-batch changes
  const batchChanges = computeBatchChanges(batches, changed);

  // Save updated hashes
  if (projectRoot) {
    saveCachedHashes(resolvedCacheDir, newHashes);
  }

  const allChanged = changed.filter(c => c.status !== 'deleted');
  const batchesToReanalyze = Object.entries(batchChanges)
    .filter(([, v]) => v.changed)
    .map(([k]) => parseInt(k));

  const out = {
    scriptCompleted: true,
    forceFull,
    stats: {
      totalFiles: allPaths.length,
      changedFiles: changed.length,
      unchangedFiles: unchanged.length,
      newFiles: changed.filter(c => c.status === 'new').length,
      modifiedFiles: changed.filter(c => c.status === 'changed').length,
      deletedFiles: changed.filter(c => c.status === 'deleted').length,
      totalBatches: batches.length,
      batchesToReanalyze: batchesToReanalyze.length,
    },
    changed,
    unchanged: unchanged.map(u => u.path),
    batchChanges,
    batchesToReanalyze,
    hashCache: newHashes,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));

  const s = out.stats;
  process.stderr.write(
    `compute-file-hashes: total=${s.totalFiles} changed=${s.changedFiles} ` +
    `(new=${s.newFiles} modified=${s.modifiedFiles} deleted=${s.deletedFiles}) ` +
    `batches_to_reanalyze=${s.batchesToReanalyze}/${s.totalBatches}\n`
  );
}

main();
