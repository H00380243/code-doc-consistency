#!/usr/bin/env node
/**
 * align-graphs.mjs — Pre-compute node alignment between code and doc graphs.
 *
 * Self-contained Node port of align-graphs.py. Implements the 3-tier
 * alignment strategy (exact ID → kind+name → user aliases) so the
 * consistency-checker LLM sees decisions that are auditable and
 * reproducible.
 *
 * Usage:
 *   node align-graphs.mjs <code.json> <doc.json> <output.json> [--aliases=<map.json>]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const ID_PREFIX_RE = /^([a-z_]+):(.+)$/;

function splitId(nid) {
  if (typeof nid !== 'string') return [null, nid];
  const m = ID_PREFIX_RE.exec(nid);
  return m ? [m[1], m[2]] : [null, nid];
}

function lastSegment(qname) {
  for (const sep of ['::', '/', '.']) {
    const idx = qname.lastIndexOf(sep);
    if (idx >= 0) return qname.slice(idx + sep.length);
  }
  return qname;
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function indexByKindName(nodes) {
  const idx = {};
  for (const n of nodes) {
    const [kind, qname] = splitId(n.id);
    if (!kind) continue;
    const norm = normalizeName(lastSegment(qname));
    if (!idx[kind]) idx[kind] = {};
    if (!idx[kind][norm]) idx[kind][norm] = [];
    idx[kind][norm].push(n.id);
  }
  return idx;
}

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

function main() {
  const args = process.argv.slice(2);
  const [codePath, docPath, outputPath] = args;
  let aliasPath = null;
  for (const a of args.slice(3)) if (a.startsWith('--aliases=')) aliasPath = a.slice(10);
  if (!codePath || !docPath || !outputPath) {
    process.stderr.write('Usage: node align-graphs.mjs <code.json> <doc.json> <output.json> [--aliases=<path>]\n');
    process.exit(1);
  }

  const codeGraph = JSON.parse(readFileSync(codePath, 'utf-8'));
  const docGraph = JSON.parse(readFileSync(docPath, 'utf-8'));

  const codeNodes = codeGraph.nodes || [];
  const docNodes = docGraph.nodes || [];
  const codeIds = new Set(codeNodes.map(n => n.id).filter(x => typeof x === 'string'));
  const docIds = new Set(docNodes.map(n => n.id).filter(x => typeof x === 'string'));

  const matched = [];
  const matchedCode = new Set(); const matchedDoc = new Set();
  const ambiguous = [];

  // Tier 1: exact ID
  for (const cid of codeIds) {
    if (docIds.has(cid)) {
      matched.push({ code_id: cid, doc_id: cid, tier: 1, confidence: 'high' });
      matchedCode.add(cid); matchedDoc.add(cid);
    }
  }

  // Tier 3: aliases
  const aliases = loadAliases(aliasPath);
  for (const [cid, candidates] of Object.entries(aliases)) {
    if (matchedCode.has(cid) || !codeIds.has(cid)) continue;
    for (const did of candidates) {
      if (docIds.has(did) && !matchedDoc.has(did)) {
        matched.push({ code_id: cid, doc_id: did, tier: 3, confidence: 'high' });
        matchedCode.add(cid); matchedDoc.add(did);
        break;
      }
    }
  }

  // Tier 2: same (kind, name)
  const codeIdx = indexByKindName(codeNodes.filter(n => !matchedCode.has(n.id)));
  const docIdx = indexByKindName(docNodes.filter(n => !matchedDoc.has(n.id)));

  for (const [kind, codeBuckets] of Object.entries(codeIdx)) {
    if (!docIdx[kind]) continue;
    const docBuckets = docIdx[kind];
    for (const [norm, codeBucket] of Object.entries(codeBuckets)) {
      if (!docBuckets[norm]) continue;
      const docBucket = docBuckets[norm];
      const availCode = codeBucket.filter(c => !matchedCode.has(c));
      const availDoc = docBucket.filter(d => !matchedDoc.has(d));
      if (!availCode.length || !availDoc.length) continue;

      if (availCode.length === 1 && availDoc.length === 1) {
        const cid = availCode[0]; const did = availDoc[0];
        const [, codeQ] = splitId(cid); const [, docQ] = splitId(did);
        let conf;
        if (codeQ === docQ) conf = 'high';
        else if (lastSegment(codeQ) === lastSegment(docQ)) conf = 'medium';
        else conf = 'low';
        matched.push({ code_id: cid, doc_id: did, tier: 2, confidence: conf });
        matchedCode.add(cid); matchedDoc.add(did);
      } else {
        ambiguous.push({
          name: norm, kind,
          candidates_code: availCode,
          candidates_doc: availDoc,
        });
      }
    }
  }

  const codeOnly = [...codeIds].filter(c => !matchedCode.has(c)).sort();
  const docOnly = [...docIds].filter(d => !matchedDoc.has(d)).sort();
  matched.sort((a, b) => a.code_id.localeCompare(b.code_id));
  ambiguous.sort((a, b) => (a.kind + a.name).localeCompare(b.kind + b.name));

  const out = {
    schema_version: '1.0',
    matched, code_only: codeOnly, doc_only: docOnly, ambiguous,
    stats: {
      matched_count: matched.length,
      tier1_count: matched.filter(m => m.tier === 1).length,
      tier2_count: matched.filter(m => m.tier === 2).length,
      tier3_count: matched.filter(m => m.tier === 3).length,
      code_only_count: codeOnly.length,
      doc_only_count: docOnly.length,
      ambiguous_count: ambiguous.length,
      code_total: codeIds.size,
      doc_total: docIds.size,
    },
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  const s = out.stats;
  process.stderr.write(
    `align-graphs: matched=${s.matched_count} (t1=${s.tier1_count} t2=${s.tier2_count} t3=${s.tier3_count}) ` +
    `code_only=${s.code_only_count} doc_only=${s.doc_only_count} ambiguous=${s.ambiguous_count}\n`
  );
}

main();
