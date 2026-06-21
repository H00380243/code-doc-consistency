#!/usr/bin/env node
/**
 * align-graphs.mjs — Pre-compute node alignment between code and doc graphs.
 *
 * v2.0: Token-based similarity with 4-tier matching:
 *   Tier 1: Exact ID match (highest confidence)
 *   Tier 2: User-provided aliases (high confidence)
 *   Tier 3: Same kind + identical token set (high confidence)
 *   Tier 4: Same kind + token overlap above threshold (configurable confidence)
 *
 * Usage:
 *   node align-graphs.mjs <code.json> <doc.json> <output.json>
 *                          [--aliases=<map.json>]
 *                          [--symbol-index=<symbol-index.json>]
 *                          [--threshold=0.6]
 *                          [--whitelist=<whitelist.json>]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ── ID parsing ──────────────────────────────────────────────────────────────

const ID_PREFIX_RE = /^([a-z_]+):(.+)$/;

function splitId(nid) {
  if (typeof nid !== 'string') return [null, nid];
  const m = ID_PREFIX_RE.exec(nid);
  return m ? [m[1], m[2]] : [null, nid];
}

function lastSegment(qname) {
  // The ID format is prefix:path:name. After splitId removes the prefix,
  // the qname still contains the full path. We need the LAST segment.
  //
  // Separator priority (most specific first):
  //   1. :: (C++ namespaces) — e.g., "std::vector" → "vector"
  //   2. :  (ID format separator, Java package/class) — e.g., "com.example:UserService" → "UserService"
  //      BUT skip if colon is at position 1 (Windows drive letter like "C:")
  //   3. /  (file paths) — e.g., "src/main/UserService" → "UserService"
  //   4. .  (dot notation) — e.g., "module.class" → "class"
  for (const sep of ['::']) {
    const idx = qname.lastIndexOf(sep);
    if (idx >= 0) return qname.slice(idx + sep.length);
  }
  // Colon separator (skip Windows drive letters at position 1)
  const colonIdx = qname.lastIndexOf(':');
  if (colonIdx >= 0 && colonIdx !== 1) {
    return qname.slice(colonIdx + 1);
  }
  // Slash separator (file paths)
  const slashIdx = qname.lastIndexOf('/');
  if (slashIdx >= 0) return qname.slice(slashIdx + 1);
  // Dot separator (fallback)
  const dotIdx = qname.lastIndexOf('.');
  if (dotIdx >= 0) return qname.slice(dotIdx + 1);
  return qname;
}

// ── Token-based name normalization ──────────────────────────────────────────
// Splits camelCase, snake_case, kebab-case into a normalized token set.
// "getUserInfo" → ["get", "user", "info"]
// "user-service" → ["user", "service"]
// "get_user_info" → ["get", "user", "info"]

function tokenize(name) {
  if (!name) return [];
  // Split on word boundaries: camelCase, underscores, hyphens, dots, colons
  const raw = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → camel Case
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2') // XMLParser → XML Parser
    .replace(/[_\-./:]/g, ' ')                // separators → space
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 0);
  // Deduplicate while preserving order
  return [...new Set(raw)];
}

function tokenSetEqual(tokensA, tokensB) {
  if (tokensA.length !== tokensB.length) return false;
  const setA = new Set(tokensA);
  for (const t of tokensB) {
    if (!setA.has(t)) return false;
  }
  return true;
}

function tokenOverlap(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const unionSize = setA.size + setB.size - intersection;
  return unionSize > 0 ? intersection / unionSize : 0;
}

// ── Legacy normalizeName (kept for backward compat in indexing) ──────────────

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Kind compatibility mapping ──────────────────────────────────────────────
// Code kinds and doc kinds that represent similar entities.
// Used for cross-kind matching in Tier 4 (fuzzy).

const KIND_COMPAT = {
  function: ['concept', 'endpoint', 'function', 'method'],
  method: ['concept', 'endpoint', 'function', 'method'],
  class: ['concept', 'service', 'class', 'interface'],
  interface: ['concept', 'service', 'class', 'interface'],
  enum: ['concept', 'class', 'enum'],
  type: ['concept', 'schema', 'type'],
  endpoint: ['concept', 'endpoint', 'function'],
  service: ['concept', 'service', 'class'],
  entity: ['concept', 'table', 'entity'],
  table: ['concept', 'entity', 'table'],
  constant: ['concept', 'config', 'constant'],
  configuration: ['concept', 'config'],
  annotation: ['concept', 'annotation'],
  // Doc kinds that can match code kinds
  concept: ['function', 'method', 'class', 'interface', 'enum', 'type', 'endpoint', 'service', 'entity', 'constant', 'configuration'],
  service: ['class', 'interface', 'service'],
  endpoint: ['function', 'method', 'endpoint'],
  table: ['entity', 'table'],
  schema: ['type', 'schema'],
};

function kindsCompatible(kindA, kindB) {
  if (kindA === kindB) return true;
  const compat = KIND_COMPAT[kindA];
  return compat ? compat.includes(kindB) : false;
}

// ── Node indexing ───────────────────────────────────────────────────────────

function indexByKind(nodes) {
  const idx = {};
  for (const n of nodes) {
    const [kind, qname] = splitId(n.id);
    if (!kind) continue;
    const name = lastSegment(qname);
    const tokens = tokenize(name);
    const norm = normalizeName(name);
    if (!idx[kind]) idx[kind] = [];
    idx[kind].push({ id: n.id, name, tokens, norm, qname });
  }
  // Sort by token count descending (more specific matches first)
  for (const kind of Object.keys(idx)) {
    idx[kind].sort((a, b) => b.tokens.length - a.tokens.length);
  }
  return idx;
}

// ── Config loading ──────────────────────────────────────────────────────────

function loadAliases(path) {
  if (!path || !existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = [v];
    else if (Array.isArray(v)) out[k] = v;
  }
  return out;
}

function loadWhitelist(path) {
  if (!path || !existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  // Expected format: [{ code_id, doc_id, reason? }]
  if (Array.isArray(raw)) return raw;
  // Also accept { code_id: doc_id } format
  return Object.entries(raw).map(([c, d]) => ({ code_id: c, doc_id: d }));
}

function loadSymbolIndex(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ── Confidence calculation ──────────────────────────────────────────────────

function computeConfidence(tier, tokenOverlap, exactQname) {
  if (tier === 1) return { confidence: 'high', align_confidence: 1.0 };
  if (tier === 2) return { confidence: 'high', align_confidence: 0.95 };

  // Tier 3: identical token sets
  if (tier === 3) {
    if (exactQname) return { confidence: 'high', align_confidence: 0.95 };
    return { confidence: 'high', align_confidence: 0.90 };
  }

  // Tier 4: token overlap
  if (tokenOverlap >= 0.8) return { confidence: 'medium', align_confidence: 0.75 };
  if (tokenOverlap >= 0.6) return { confidence: 'medium', align_confidence: 0.65 };
  return { confidence: 'low', align_confidence: Math.max(0.3, tokenOverlap) };
}

// ── Main alignment logic ───────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const [codePath, docPath, outputPath] = args;

  let aliasPath = null;
  let symbolIndexPath = null;
  let threshold = 0.6;
  let whitelistPath = null;

  for (const a of args.slice(3)) {
    if (a.startsWith('--aliases=')) aliasPath = a.slice(10);
    else if (a.startsWith('--symbol-index=')) symbolIndexPath = a.slice(15);
    else if (a.startsWith('--threshold=')) threshold = parseFloat(a.slice(12));
    else if (a.startsWith('--whitelist=')) whitelistPath = a.slice(12);
  }

  if (!codePath || !docPath || !outputPath) {
    process.stderr.write(
      'Usage: node align-graphs.mjs <code.json> <doc.json> <output.json>\n' +
      '  [--aliases=<path>] [--symbol-index=<path>] [--threshold=0.6] [--whitelist=<path>]\n'
    );
    process.exit(1);
  }

  const codeGraph = JSON.parse(readFileSync(codePath, 'utf-8'));
  const docGraph = JSON.parse(readFileSync(docPath, 'utf-8'));

  const codeNodes = codeGraph.nodes || [];
  const docNodes = docGraph.nodes || [];
  const codeIds = new Set(codeNodes.map(n => n.id).filter(x => typeof x === 'string'));
  const docIds = new Set(docNodes.map(n => n.id).filter(x => typeof x === 'string'));

  const matched = [];
  const matchedCode = new Set();
  const matchedDoc = new Set();
  const ambiguous = [];

  // ── Whitelist: forced matches (highest priority after exact ID) ─────────
  const whitelist = loadWhitelist(whitelistPath);
  const whitelistCodeIds = new Set(whitelist.map(w => w.code_id));
  const whitelistDocIds = new Set(whitelist.map(w => w.doc_id));

  for (const w of whitelist) {
    if (codeIds.has(w.code_id) && docIds.has(w.doc_id)) {
      matched.push({
        code_id: w.code_id, doc_id: w.doc_id,
        tier: 0, confidence: 'high', align_confidence: 1.0,
        reason: w.reason || 'whitelist',
      });
      matchedCode.add(w.code_id);
      matchedDoc.add(w.doc_id);
    }
  }

  // ── Tier 1: Exact ID match ─────────────────────────────────────────────
  for (const cid of codeIds) {
    if (matchedCode.has(cid)) continue;
    if (docIds.has(cid)) {
      matched.push({
        code_id: cid, doc_id: cid, tier: 1, confidence: 'high', align_confidence: 1.0,
      });
      matchedCode.add(cid);
      matchedDoc.add(cid);
    }
  }

  // ── Tier 2: User-provided aliases ──────────────────────────────────────
  const aliases = loadAliases(aliasPath);
  for (const [cid, candidates] of Object.entries(aliases)) {
    if (matchedCode.has(cid) || !codeIds.has(cid)) continue;
    for (const did of candidates) {
      if (docIds.has(did) && !matchedDoc.has(did)) {
        matched.push({
          code_id: cid, doc_id: did, tier: 2, confidence: 'high', align_confidence: 0.95,
        });
        matchedCode.add(cid);
        matchedDoc.add(did);
        break;
      }
    }
  }

  // ── Tier 3 & 4: Token-based similarity matching ────────────────────────
  const codeIdx = indexByKind(codeNodes);
  const docIdx = indexByKind(docNodes);

  // Tier 3: same kind + identical token set (exact match)
  for (const [kind, codeEntries] of Object.entries(codeIdx)) {
    if (!docIdx[kind]) continue;
    const docEntries = docIdx[kind];

    // Build token-set buckets for code side
    const codeTokenBuckets = {};
    for (const entry of codeEntries) {
      if (matchedCode.has(entry.id)) continue;
      const key = entry.tokens.slice().sort().join('|');
      if (!codeTokenBuckets[key]) codeTokenBuckets[key] = [];
      codeTokenBuckets[key].push(entry);
    }

    // Build token-set buckets for doc side
    const docTokenBuckets = {};
    for (const entry of docEntries) {
      if (matchedDoc.has(entry.id)) continue;
      const key = entry.tokens.slice().sort().join('|');
      if (!docTokenBuckets[key]) docTokenBuckets[key] = [];
      docTokenBuckets[key].push(entry);
    }

    // Match identical token sets
    for (const [key, codeBucket] of Object.entries(codeTokenBuckets)) {
      if (!docTokenBuckets[key]) continue;
      const availCode = codeBucket.filter(c => !matchedCode.has(c.id));
      const availDoc = docTokenBuckets[key].filter(d => !matchedDoc.has(d.id));
      if (!availCode.length || !availDoc.length) continue;

      if (availCode.length === 1 && availDoc.length === 1) {
        const c = availCode[0];
        const d = availDoc[0];
        const exactQname = c.qname === d.qname;
        const conf = computeConfidence(3, 1.0, exactQname);
        matched.push({
          code_id: c.id, doc_id: d.id, tier: 3, ...conf,
        });
        matchedCode.add(c.id);
        matchedDoc.add(d.id);
      } else {
        // Multiple candidates — try to disambiguate by qname similarity
        for (const c of availCode) {
          if (matchedCode.has(c.id)) continue;
          let bestDoc = null;
          let bestOverlap = 0;
          for (const d of availDoc) {
            if (matchedDoc.has(d.id)) continue;
            const overlap = tokenOverlap(c.tokens, d.tokens);
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              bestDoc = d;
            }
          }
          if (bestDoc && bestOverlap >= threshold) {
            const conf = computeConfidence(3, bestOverlap, c.qname === bestDoc.qname);
            matched.push({
              code_id: c.id, doc_id: bestDoc.id, tier: 3, ...conf,
            });
            matchedCode.add(c.id);
            matchedDoc.add(bestDoc.id);
          }
        }

        // Remaining unmatched go to ambiguous
        const stillCode = availCode.filter(c => !matchedCode.has(c.id));
        const stillDoc = availDoc.filter(d => !matchedDoc.has(d.id));
        if (stillCode.length && stillDoc.length) {
          ambiguous.push({
            name: availCode[0].name, kind,
            candidates_code: stillCode.map(c => c.id),
            candidates_doc: stillDoc.map(d => d.id),
            match_type: 'token_set',
          });
        }
      }
    }
  }

  // Tier 4: compatible kinds + token overlap above threshold (fuzzy cross-kind match)
  for (const [codeKind, codeEntries] of Object.entries(codeIdx)) {
    for (const [docKind, docEntries] of Object.entries(docIdx)) {
      if (!kindsCompatible(codeKind, docKind)) continue;

      for (const c of codeEntries) {
        if (matchedCode.has(c.id)) continue;

        let bestDoc = null;
        let bestOverlap = 0;

        for (const d of docEntries) {
          if (matchedDoc.has(d.id)) continue;
          const overlap = tokenOverlap(c.tokens, d.tokens);
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestDoc = d;
          }
        }

        if (bestDoc && bestOverlap >= threshold) {
          // Verify this isn't a false positive (e.g., "get" matching "getUser")
          // Require at least 2 tokens or exact single-token match
          if (c.tokens.length === 1 && bestDoc.tokens.length > 1 && bestOverlap < 1.0) continue;
          if (bestDoc.tokens.length === 1 && c.tokens.length > 1 && bestOverlap < 1.0) continue;

          // Cross-kind matches get slightly lower confidence
          const kindPenalty = codeKind === docKind ? 0 : 0.05;
          const conf = computeConfidence(4, bestOverlap - kindPenalty, c.qname === bestDoc.qname);
          matched.push({
            code_id: c.id, doc_id: bestDoc.id, tier: 4, ...conf,
          });
          matchedCode.add(c.id);
          matchedDoc.add(bestDoc.id);
        }
      }
    }
  }

  // ── Build output ───────────────────────────────────────────────────────
  const codeOnly = [...codeIds].filter(c => !matchedCode.has(c)).sort();
  const docOnly = [...docIds].filter(d => !matchedDoc.has(d)).sort();
  matched.sort((a, b) => a.code_id.localeCompare(b.code_id));
  ambiguous.sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name));

  const tierCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let totalConfidence = 0;
  for (const m of matched) {
    tierCounts[m.tier] = (tierCounts[m.tier] || 0) + 1;
    totalConfidence += m.align_confidence || 0;
  }

  const out = {
    schema_version: '2.0',
    matched, code_only: codeOnly, doc_only: docOnly, ambiguous,
    stats: {
      matched_count: matched.length,
      whitelist_count: tierCounts[0] || 0,
      tier1_count: tierCounts[1] || 0,
      tier2_count: tierCounts[2] || 0,
      tier3_count: tierCounts[3] || 0,
      tier4_count: tierCounts[4] || 0,
      code_only_count: codeOnly.length,
      doc_only_count: docOnly.length,
      ambiguous_count: ambiguous.length,
      code_total: codeIds.size,
      doc_total: docIds.size,
      avg_confidence: matched.length > 0 ? (totalConfidence / matched.length).toFixed(3) : 0,
      low_confidence_count: matched.filter(m => m.align_confidence < 0.6).length,
    },
    config: { threshold, alias_count: Object.keys(aliases).length, whitelist_count: whitelist.length },
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));

  const s = out.stats;
  process.stderr.write(
    `align-graphs: matched=${s.matched_count} ` +
    `(w=${s.whitelist_count} t1=${s.tier1_count} t2=${s.tier2_count} t3=${s.tier3_count} t4=${s.tier4_count}) ` +
    `code_only=${s.code_only_count} doc_only=${s.doc_only_count} ambiguous=${s.ambiguous_count} ` +
    `avg_conf=${s.avg_confidence} low_conf=${s.low_confidence_count}\n`
  );
}

main();
