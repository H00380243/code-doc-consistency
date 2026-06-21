import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMP_DIR = path.join(process.env.TEMP || '/tmp', 'cdc-p3-test');
const SCRIPTS_DIR = path.join(__dirname, '..', 'code-doc-consistency-plugin', 'skills');

describe('P3 Scripts', () => {
  before(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  describe('generate-mermaid.mjs', () => {
    it('should generate Mermaid diagrams from workspace data', () => {
      const workspace = path.join(TMP_DIR, 'mermaid-ws');
      fs.mkdirSync(workspace, { recursive: true });

      const codeGraph = {
        nodes: [
          { id: 'class:UserService', name: 'UserService', type: 'class' },
          { id: 'class:UserController', name: 'UserController', type: 'class' },
        ],
        edges: [
          { source: 'class:UserController', target: 'class:UserService', type: 'calls' },
        ],
      };

      const docGraph = {
        nodes: [
          { id: 'concept:User Service', name: 'User Service', type: 'concept' },
        ],
        edges: [],
      };

      const alignment = {
        matched: [
          { codeNodeId: 'class:UserService', docNodeId: 'concept:User Service', confidence: 'high' },
        ],
        code_only: [{ id: 'class:UserController' }],
        doc_only: [],
      };

      const diff = {
        totalIssues: 2,
        layers: {
          entity_existence: [
            { type: 'missing', severity: 'major', description: 'Missing endpoint in doc' },
          ],
          attribute_drift: [
            { type: 'drift', severity: 'minor', description: 'Name variation' },
          ],
        },
      };

      fs.writeFileSync(path.join(workspace, '01_code_assembled.json'), JSON.stringify(codeGraph));
      fs.writeFileSync(path.join(workspace, '02_doc_assembled.json'), JSON.stringify(docGraph));
      fs.writeFileSync(path.join(workspace, '03_alignment.json'), JSON.stringify(alignment));
      fs.writeFileSync(path.join(workspace, '05_diff.json'), JSON.stringify(diff));

      const outputPath = path.join(TMP_DIR, 'mermaid-output.json');
      execSync(
        `node "${path.join(SCRIPTS_DIR, 'graph-diff-analyzer/scripts/generate-mermaid.mjs')}" "${workspace}" "${outputPath}" --format=all`,
        { encoding: 'utf8', cwd: path.join(__dirname, '..') }
      );

      const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      assert.strictEqual(output.scriptCompleted, true);
      assert.ok(output.diagrams.graph);
      assert.ok(output.diagrams.alignment);
      assert.ok(output.diagrams.issues);
      assert.ok(output.markdown.includes('# CDC Pipeline'));
      assert.ok(output.markdown.includes('```mermaid'));
    });
  });

  describe('diff-levels.mjs', () => {
    it('should classify diff issues by severity', () => {
      const diff = {
        layers: {
          entity_existence: [
            { type: 'missing', description: 'Missing class in doc' },
            { type: 'extra', description: 'Extra class in code' },
          ],
          attribute_drift: [
            { type: 'drift', description: 'Name changed' },
          ],
        },
      };

      const diffPath = path.join(TMP_DIR, 'diff-input.json');
      fs.writeFileSync(diffPath, JSON.stringify(diff));

      const outputPath = path.join(TMP_DIR, 'diff-output.json');
      execSync(
        `node "${path.join(SCRIPTS_DIR, 'graph-diff-analyzer/scripts/diff-levels.mjs')}" "${diffPath}" "${outputPath}"`,
        { encoding: 'utf8', cwd: path.join(__dirname, '..') }
      );

      const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      assert.strictEqual(output.scriptCompleted, true);
      assert.ok(output.classified.length >= 2);
      assert.ok(output.stats.total >= 2);
      assert.ok(output.stats.bySeverity);
    });
  });

  describe('cache-ttl.mjs', () => {
    it('should cache and retrieve data with TTL', () => {
      const cacheDir = path.join(TMP_DIR, 'cache-test');
      fs.mkdirSync(cacheDir, { recursive: true });

      const dataPath = path.join(TMP_DIR, 'cache-data.json');
      fs.writeFileSync(dataPath, JSON.stringify({ foo: 'bar' }));

      execSync(
        `node "${path.join(SCRIPTS_DIR, 'code-graph-rag/scripts/cache-ttl.mjs')}" put "${cacheDir}" "test-file.json" "${dataPath}" --ttl=3600`,
        { encoding: 'utf8', cwd: path.join(__dirname, '..') }
      );

      const result = execSync(
        `node "${path.join(SCRIPTS_DIR, 'code-graph-rag/scripts/cache-ttl.mjs')}" get "${cacheDir}" "test-file.json"`,
        { encoding: 'utf8', cwd: path.join(__dirname, '..') }
      );

      const cached = JSON.parse(result);
      assert.deepStrictEqual(cached, { foo: 'bar' });

      const statsResult = execSync(
        `node "${path.join(SCRIPTS_DIR, 'code-graph-rag/scripts/cache-ttl.mjs')}" stats "${cacheDir}"`,
        { encoding: 'utf8', cwd: path.join(__dirname, '..') }
      );

      const stats = JSON.parse(statsResult);
      assert.strictEqual(stats.entries, 1);
      assert.ok(stats.ttlSeconds > 0);
    });
  });
});
