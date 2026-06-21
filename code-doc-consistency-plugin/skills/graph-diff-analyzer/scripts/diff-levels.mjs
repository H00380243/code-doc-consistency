#!/usr/bin/env node
/**
 * diff-levels.mjs — Configurable diff severity classification
 *
 * Classifies consistency differences by severity based on configurable
 * rules and thresholds. Supports custom severity mappings and filtering.
 *
 * Usage:
 *   node diff-levels.mjs <diff.json> <output.json> [--config=<config.json>]
 *
 * Input:  05_diff.json + optional severity config
 * Output: { scriptCompleted, classified: [...], stats, config }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Default severity rules ───────────────────────────────────────────────────

const DEFAULT_SEVERITY_CONFIG = {
  // Layer weights (higher = more severe)
  layerWeights: {
    entity_existence: 1.0,
    relationship_coverage: 0.8,
    attribute_drift: 0.6,
    behavior_divergence: 0.9,
  },

  // Issue type multipliers
  typeMultipliers: {
    missing: 1.0,
    extra: 0.5,
    conflict: 1.5,
    drift: 0.8,
  },

  // Severity thresholds
  thresholds: {
    critical: 0.8,
    major: 0.5,
    minor: 0.2,
  },

  // Special rules for specific node types
  nodeTypeRules: {
    endpoint: { multiplier: 1.5, description: 'API endpoint inconsistency' },
    security_filter: { multiplier: 1.3, description: 'Security configuration drift' },
    entity: { multiplier: 1.2, description: 'Data model inconsistency' },
    service: { multiplier: 1.0, description: 'Service implementation drift' },
    configuration: { multiplier: 0.9, description: 'Configuration inconsistency' },
  },

  // Ignore patterns (issues matching these are skipped)
  ignorePatterns: [],

  // Minimum severity to include in output
  minSeverity: 'minor',
};

// ── Severity classifier ──────────────────────────────────────────────────────

class SeverityClassifier {
  constructor(config = {}) {
    this.config = { ...DEFAULT_SEVERITY_CONFIG, ...config };
    this.severityOrder = ['minor', 'major', 'critical'];
  }

  /**
   * Calculate severity score for an issue
   * @param {object} issue - The issue to classify
   * @returns {object} - { severity, score, reason }
   */
  classify(issue) {
    // Check ignore patterns
    if (this.shouldIgnore(issue)) {
      return null;
    }

    let score = 0;
    const reasons = [];

    // Layer weight
    const layerWeight = this.config.layerWeights[issue.layer] || 0.5;
    score += layerWeight;
    reasons.push(`layer:${issue.layer}=${layerWeight}`);

    // Type multiplier
    const typeMultiplier = this.config.typeMultipliers[issue.type] || 1.0;
    score *= typeMultiplier;
    reasons.push(`type:${issue.type}=${typeMultiplier}`);

    // Node type rules
    const nodeType = issue.nodeType || issue.sourceType || '';
    const nodeRule = this.config.nodeTypeRules[nodeType];
    if (nodeRule) {
      score *= nodeRule.multiplier;
      reasons.push(`nodeType:${nodeType}=${nodeRule.multiplier}`);
    }

    // Confidence penalty
    if (issue.confidence === 'low') {
      score *= 0.5;
      reasons.push('confidence:low=0.5');
    }

    // Normalize score to 0-1 range
    score = Math.min(1, Math.max(0, score / 2));

    // Determine severity based on thresholds
    let severity;
    if (score >= this.config.thresholds.critical) {
      severity = 'critical';
    } else if (score >= this.config.thresholds.major) {
      severity = 'major';
    } else {
      severity = 'minor';
    }

    return {
      severity,
      score: Math.round(score * 100) / 100,
      reason: reasons.join(', '),
    };
  }

  /**
   * Check if an issue should be ignored
   */
  shouldIgnore(issue) {
    for (const pattern of this.config.ignorePatterns) {
      if (typeof pattern === 'string') {
        if (issue.description?.includes(pattern) ||
            issue.name?.includes(pattern) ||
            issue.nodeType?.includes(pattern)) {
          return true;
        }
      } else if (pattern instanceof RegExp) {
        if (pattern.test(issue.description) || pattern.test(issue.name)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Classify all issues in a diff
   * @param {object} diff - The diff object with layers
   * @returns {Array} - Classified issues
   */
  classifyAll(diff) {
    const classified = [];
    const layers = diff?.layers || {};

    for (const [layerName, layerData] of Object.entries(layers)) {
      const items = Array.isArray(layerData) ? layerData : (layerData?.items || []);

      for (const item of items) {
        const classification = this.classify({
          ...item,
          layer: layerName,
        });

        if (classification) {
          classified.push({
            ...item,
            layer: layerName,
            severity: classification.severity,
            severityScore: classification.score,
            severityReason: classification.reason,
          });
        }
      }
    }

    // Sort by severity (critical first)
    classified.sort((a, b) => {
      const aIdx = this.severityOrder.indexOf(a.severity);
      const bIdx = this.severityOrder.indexOf(b.severity);
      return aIdx - bIdx;
    });

    return classified;
  }

  /**
   * Filter issues by minimum severity
   * @param {Array} classified - Classified issues
   * @param {string} minSeverity - Minimum severity level
   * @returns {Array} - Filtered issues
   */
  filterBySeverity(classified, minSeverity) {
    const minIdx = this.severityOrder.indexOf(minSeverity);
    return classified.filter(item => {
      const itemIdx = this.severityOrder.indexOf(item.severity);
      return itemIdx >= minIdx;
    });
  }

  /**
   * Generate severity statistics
   */
  getStats(classified) {
    const stats = {
      total: classified.length,
      bySeverity: { critical: 0, major: 0, minor: 0 },
      byLayer: {},
      byType: {},
      avgScore: 0,
    };

    let totalScore = 0;

    for (const item of classified) {
      stats.bySeverity[item.severity]++;
      stats.byLayer[item.layer] = (stats.byLayer[item.layer] || 0) + 1;
      stats.byType[item.type] = (stats.byType[item.type] || 0) + 1;
      totalScore += item.severityScore || 0;
    }

    stats.avgScore = classified.length > 0
      ? Math.round((totalScore / classified.length) * 100) / 100
      : 0;

    return stats;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let diffPath = null;
  let outputPath = null;
  let configPath = null;
  let minSeverity = 'minor';

  for (const a of args) {
    if (a.startsWith('--config=')) configPath = a.slice(9);
    else if (a.startsWith('--min-severity=')) minSeverity = a.slice(15);
    else if (!diffPath) diffPath = a;
    else if (!outputPath) outputPath = a;
  }

  if (!diffPath || !outputPath) {
    process.stderr.write(
      'Usage: node diff-levels.mjs <diff.json> <output.json> [--config=<config.json>] [--min-severity=<level>]\n'
    );
    process.exit(1);
  }

  // Load config
  let config = DEFAULT_SEVERITY_CONFIG;
  if (configPath) {
    try {
      config = { ...DEFAULT_SEVERITY_CONFIG, ...JSON.parse(readFileSync(configPath, 'utf-8')) };
    } catch (e) {
      process.stderr.write(`Warning: could not read config, using defaults: ${e.message}\n`);
    }
  }

  // Load diff
  const diff = JSON.parse(readFileSync(diffPath, 'utf-8'));

  // Classify issues
  const classifier = new SeverityClassifier(config);
  const classified = classifier.classifyAll(diff);

  // Filter by minimum severity
  const filtered = classifier.filterBySeverity(classified, minSeverity);

  // Generate stats
  const stats = classifier.getStats(classified);

  const output = {
    scriptCompleted: true,
    config,
    classified: filtered,
    stats,
    totalBeforeFilter: classified.length,
    totalAfterFilter: filtered.length,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  process.stderr.write(
    `diff-levels: total=${classified.length} filtered=${filtered.length} ` +
    `critical=${stats.bySeverity.critical} major=${stats.bySeverity.major} ` +
    `minor=${stats.bySeverity.minor}\n`
  );
}

// Export for programmatic use
export { SeverityClassifier, DEFAULT_SEVERITY_CONFIG };

main();
