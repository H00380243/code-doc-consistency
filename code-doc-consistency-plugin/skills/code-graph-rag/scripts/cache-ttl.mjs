#!/usr/bin/env node
/**
 * cache-ttl.mjs — Cache management with TTL support for incremental updates
 *
 * Manages a file-based cache with time-to-live (TTL) for pipeline artifacts.
 * Supports incremental updates by tracking file modification times and
 * determining which artifacts need regeneration.
 *
 * Usage:
 *   node cache-ttl.mjs --check <cacheDir> <file>       # Check if file is cached
 *   node cache-ttl.mjs --put <cacheDir> <file> <data>  # Cache file data
 *   node cache-ttl.mjs --get <cacheDir> <file>         # Retrieve cached data
 *   node cache-ttl.mjs --invalidate <cacheDir> [pattern]  # Invalidate cache
 *   node cache-ttl.mjs --stats <cacheDir>              # Show cache statistics
 *
 * Options:
 *   --ttl=<seconds>      Cache TTL in seconds (default: 3600 = 1 hour)
 *   --max-size=<bytes>   Maximum cache size (default: 100MB)
 *   --max-entries=<n>    Maximum number of entries (default: 1000)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';

// ── Default configuration ────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  ttlSeconds: 3600, // 1 hour
  maxSizeBytes: 100 * 1024 * 1024, // 100MB
  maxEntries: 1000,
};

// ── Cache implementation ─────────────────────────────────────────────────────

class CacheManager {
  constructor(cacheDir, config = {}) {
    this.cacheDir = cacheDir;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metaPath = join(cacheDir, '.cache-meta.json');
    this.meta = this.loadMeta();
  }

  /**
   * Load cache metadata
   */
  loadMeta() {
    try {
      return JSON.parse(readFileSync(this.metaPath, 'utf-8'));
    } catch {
      return { entries: {}, stats: { hits: 0, misses: 0, evictions: 0 } };
    }
  }

  /**
   * Save cache metadata
   */
  saveMeta() {
    mkdirSync(dirname(this.metaPath), { recursive: true });
    writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2));
  }

  /**
   * Generate cache key from file path
   */
  cacheKey(filePath) {
    const hash = createHash('md5').update(filePath).digest('hex');
    return hash;
  }

  /**
   * Get cache file path
   */
  cachePath(filePath) {
    return join(this.cacheDir, `${this.cacheKey(filePath)}.json`);
  }

  /**
   * Check if a file is cached and valid
   * @param {string} filePath - Original file path
   * @param {number} sourceMtime - Source file modification time
   * @returns {boolean} - true if cached and valid
   */
  isCached(filePath, sourceMtime) {
    const entry = this.meta.entries[filePath];
    if (!entry) {
      this.meta.stats.misses++;
      return false;
    }

    // Check TTL
    const now = Date.now();
    const ageMs = now - entry.cachedAt;
    if (ageMs > this.config.ttlSeconds * 1000) {
      this.meta.stats.misses++;
      return false;
    }

    // Check if source is newer than cache
    if (sourceMtime && sourceMtime > entry.sourceMtime) {
      this.meta.stats.misses++;
      return false;
    }

    this.meta.stats.hits++;
    return true;
  }

  /**
   * Get cached data
   * @param {string} filePath - Original file path
   * @returns {any|null} - Cached data or null
   */
  get(filePath) {
    if (!this.isCached(filePath)) {
      return null;
    }

    try {
      const cacheFile = this.cachePath(filePath);
      return JSON.parse(readFileSync(cacheFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Put data into cache
   * @param {string} filePath - Original file path
   * @param {any} data - Data to cache
   * @param {number} sourceMtime - Source file modification time
   */
  put(filePath, data, sourceMtime) {
    // Enforce limits
    this.enforceLimits();

    const cacheFile = this.cachePath(filePath);
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(data, null, 2));

    this.meta.entries[filePath] = {
      cacheFile: basename(cacheFile),
      cachedAt: Date.now(),
      sourceMtime: sourceMtime || 0,
      sizeBytes: statSync(cacheFile).size,
    };

    this.saveMeta();
  }

  /**
   * Invalidate cache entries
   * @param {string} pattern - Glob pattern to match (or null for all)
   */
  invalidate(pattern) {
    const entries = Object.keys(this.meta.entries);
    let count = 0;

    for (const filePath of entries) {
      if (!pattern || filePath.includes(pattern)) {
        const cacheFile = this.cachePath(filePath);
        try {
          unlinkSync(cacheFile);
        } catch {}
        delete this.meta.entries[filePath];
        count++;
      }
    }

    this.saveMeta();
    return count;
  }

  /**
   * Enforce cache size limits
   */
  enforceLimits() {
    const entries = Object.entries(this.meta.entries);

    // Sort by cachedAt (oldest first)
    entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt);

    // Remove entries if over limit
    let totalSize = entries.reduce((sum, [, e]) => sum + (e.sizeBytes || 0), 0);

    while (entries.length > this.config.maxEntries || totalSize > this.config.maxSizeBytes) {
      const [filePath, entry] = entries.shift();
      const cacheFile = this.cachePath(filePath);
      try {
        unlinkSync(cacheFile);
      } catch {}
      delete this.meta.entries[filePath];
      totalSize -= entry.sizeBytes || 0;
      this.meta.stats.evictions++;
    }

    this.saveMeta();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const entries = Object.values(this.meta.entries);
    const totalSize = entries.reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
    const totalRequests = this.meta.stats.hits + this.meta.stats.misses;
    const hitRate = totalRequests > 0
      ? (this.meta.stats.hits / totalRequests * 100).toFixed(1)
      : 0;

    return {
      entries: entries.length,
      totalSizeBytes: totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      hits: this.meta.stats.hits,
      misses: this.meta.stats.misses,
      evictions: this.meta.stats.evictions,
      hitRate: `${hitRate}%`,
      ttlSeconds: this.config.ttlSeconds,
    };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help') {
    process.stderr.write(
      'Usage: node cache-ttl.mjs <command> <cacheDir> [args...]\n' +
      '\n' +
      'Commands:\n' +
      '  check <cacheDir> <file>              Check if file is cached\n' +
      '  put <cacheDir> <file> <dataFile>     Cache file data\n' +
      '  get <cacheDir> <file>                Retrieve cached data\n' +
      '  invalidate <cacheDir> [pattern]      Invalidate cache entries\n' +
      '  stats <cacheDir>                     Show cache statistics\n' +
      '\n' +
      'Options:\n' +
      '  --ttl=<seconds>      Cache TTL (default: 3600)\n' +
      '  --max-size=<bytes>   Max cache size (default: 104857600)\n' +
      '  --max-entries=<n>    Max entries (default: 1000)\n'
    );
    process.exit(1);
  }

  const cacheDir = args[1];
  if (!cacheDir) {
    process.stderr.write('Error: cacheDir required\n');
    process.exit(1);
  }

  // Parse options
  const config = {};
  for (const a of args.slice(2)) {
    if (a.startsWith('--ttl=')) config.ttlSeconds = parseInt(a.slice(6), 10);
    else if (a.startsWith('--max-size=')) config.maxSizeBytes = parseInt(a.slice(11), 10);
    else if (a.startsWith('--max-entries=')) config.maxEntries = parseInt(a.slice(14), 10);
  }

  const cache = new CacheManager(cacheDir, config);

  switch (command) {
    case 'check': {
      const file = args[2];
      if (!file) {
        process.stderr.write('Error: file required\n');
        process.exit(1);
      }
      const mtime = existsSync(file) ? statSync(file).mtimeMs : 0;
      const cached = cache.isCached(file, mtime);
      console.log(JSON.stringify({ file, cached, mtime }));
      process.exit(cached ? 0 : 1);
    }

    case 'put': {
      const file = args[2];
      const dataFile = args[3];
      if (!file || !dataFile) {
        process.stderr.write('Error: file and dataFile required\n');
        process.exit(1);
      }
      const data = JSON.parse(readFileSync(dataFile, 'utf-8'));
      const mtime = existsSync(file) ? statSync(file).mtimeMs : 0;
      cache.put(file, data, mtime);
      console.log(JSON.stringify({ file, cached: true }));
      break;
    }

    case 'get': {
      const file = args[2];
      if (!file) {
        process.stderr.write('Error: file required\n');
        process.exit(1);
      }
      const data = cache.get(file);
      if (data) {
        console.log(JSON.stringify(data));
      } else {
        process.stderr.write('Cache miss\n');
        process.exit(1);
      }
      break;
    }

    case 'invalidate': {
      const pattern = args[2] || null;
      const count = cache.invalidate(pattern);
      console.log(JSON.stringify({ invalidated: count }));
      break;
    }

    case 'stats': {
      const stats = cache.getStats();
      console.log(JSON.stringify(stats, null, 2));
      break;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.exit(1);
  }
}

// Export for programmatic use
export { CacheManager, DEFAULT_CONFIG };

main();
