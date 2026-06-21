import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMP_DIR = path.join(process.env.TEMP || '/tmp', 'cdc-scripts-test');
const SCRIPTS_DIR = path.join(__dirname, '..', 'code-doc-consistency-plugin', 'skills', 'code-graph-rag', 'scripts');
const GRAPH_SCRIPTS_DIR = path.join(__dirname, '..', 'code-doc-consistency-plugin', 'skills', 'graph-diff-analyzer', 'scripts');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'java-project');

function run(script, args, opts = {}) {
  const cwd = opts.cwd || path.join(__dirname, '..');
  return execSync(`node "${script}" ${args}`, { encoding: 'utf8', cwd, timeout: 30000 });
}

describe('scan-project.mjs', () => {
  it('should scan project and list files', () => {
    const outputPath = path.join(TMP_DIR, 'scan-output.json');
    const result = run(path.join(SCRIPTS_DIR, 'scan-project.mjs'), `"${FIXTURE_DIR}" "${outputPath}"`);
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.files.length > 0);
    assert.ok(output.files.some(f => f.path.includes('.java')));
    assert.ok(output.files.every(f => f.language));
  });

  it('should set fileCategory correctly', () => {
    const outputPath = path.join(TMP_DIR, 'scan-output2.json');
    run(path.join(SCRIPTS_DIR, 'scan-project.mjs'), `"${FIXTURE_DIR}" "${outputPath}"`);
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const javaFile = output.files.find(f => f.path.endsWith('.java'));
    assert.ok(javaFile);
    assert.strictEqual(javaFile.fileCategory, 'code');
  });
});

describe('compute-batches.mjs', () => {
  it('should create batches from scan results', () => {
    const scanPath = path.join(TMP_DIR, 'batch-scan.json');
    const impPath = path.join(TMP_DIR, 'batch-imp.json');
    const outputPath = path.join(TMP_DIR, 'batch-output.json');

    // Create mock scan data
    const scanData = {
      projectRoot: FIXTURE_DIR,
      files: [
        { path: 'module-a/src/main/java/com/example/service/UserService.java', language: 'Java', fileCategory: 'code', sizeLines: 100 },
        { path: 'module-a/src/main/java/com/example/entity/User.java', language: 'Java', fileCategory: 'code', sizeLines: 50 },
        { path: 'module-b/src/main/java/com/example/common/IdGenerator.java', language: 'Java', fileCategory: 'code', sizeLines: 30 },
      ],
    };
    fs.writeFileSync(scanPath, JSON.stringify(scanData));
    fs.writeFileSync(impPath, JSON.stringify({ importMap: {} }));

    run(path.join(SCRIPTS_DIR, 'compute-batches.mjs'), `"${scanPath}" "${impPath}" "${outputPath}"`);
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.batches.length > 0);
    assert.ok(output.batches.every(b => Array.isArray(b.batchFiles)));
  });
});

describe('validate-graph.mjs', () => {
  it('should validate a correct graph', () => {
    const graphPath = path.join(TMP_DIR, 'valid-graph.json');
    const outputPath = path.join(TMP_DIR, 'valid-output.json');

    const graph = {
      nodes: [
        { id: 'class:UserService', type: 'class', name: 'UserService', summary: 'User service handling business logic', tags: ['service'] },
      ],
      edges: [],
    };
    fs.writeFileSync(graphPath, JSON.stringify(graph));

    run(path.join(GRAPH_SCRIPTS_DIR, 'validate-graph.mjs'), `"${graphPath}" "${outputPath}"`);
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.strictEqual(output.decision, 'pass');
    assert.strictEqual(output.schema_errors.length, 0);
  });

  it('should detect invalid node types', () => {
    const graphPath = path.join(TMP_DIR, 'invalid-graph.json');
    const outputPath = path.join(TMP_DIR, 'invalid-output.json');

    const graph = {
      nodes: [
        { id: 'foo:bar', type: 'foo', name: 'bar', summary: 'test', tags: ['test'] },
      ],
      edges: [],
    };
    fs.writeFileSync(graphPath, JSON.stringify(graph));

    run(path.join(GRAPH_SCRIPTS_DIR, 'validate-graph.mjs'), `"${graphPath}" "${outputPath}"`);
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.schema_errors.length > 0);
  });

  it('should detect dangling edges', () => {
    const graphPath = path.join(TMP_DIR, 'dangle-graph.json');
    const outputPath = path.join(TMP_DIR, 'dangle-output.json');

    const graph = {
      nodes: [
        { id: 'class:A', type: 'class', name: 'A', summary: 'Class A', tags: ['class'] },
      ],
      edges: [
        { source: 'class:A', target: 'class:B', type: 'calls', weight: 0.5 },
      ],
    };
    fs.writeFileSync(graphPath, JSON.stringify(graph));

    run(path.join(GRAPH_SCRIPTS_DIR, 'validate-graph.mjs'), `"${graphPath}" "${outputPath}"`);
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.dangling_edges.length > 0);
  });

  it('should validate Java/Spring fields', () => {
    const graphPath = path.join(TMP_DIR, 'java-graph.json');
    const outputPath = path.join(TMP_DIR, 'java-output.json');

    const graph = {
      nodes: [
        {
          id: 'endpoint:/api/users',
          type: 'endpoint',
          name: '/api/users',
          summary: 'User REST API endpoint',
          tags: ['rest-api'],
          annotations: ['RestController'],
          java_package: 'com.example.controller',
          http_mappings: [{ method: 'GET', path: '/api/users' }],
        },
      ],
      edges: [],
    };
    fs.writeFileSync(graphPath, JSON.stringify(graph));

    run(path.join(GRAPH_SCRIPTS_DIR, 'validate-graph.mjs'), `"${graphPath}" "${outputPath}"`);
    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.strictEqual(output.decision, 'pass');
  });
});

describe('build-symbol-index.mjs', () => {
  it('should build symbol index from scan and import data', () => {
    const scanPath = path.join(TMP_DIR, 'sym-scan.json');
    const impPath = path.join(TMP_DIR, 'sym-imp.json');
    const outputPath = path.join(TMP_DIR, 'sym-output.json');

    const scanData = {
      files: [
        { path: 'module-a/src/main/java/com/example/service/UserService.java', language: 'Java', fileCategory: 'code' },
        { path: 'module-a/src/main/java/com/example/entity/User.java', language: 'Java', fileCategory: 'code' },
      ],
    };
    fs.writeFileSync(scanPath, JSON.stringify(scanData));
    fs.writeFileSync(impPath, JSON.stringify({ importMap: {} }));

    run(path.join(SCRIPTS_DIR, 'build-symbol-index.mjs'),
      `"${scanPath}" "${impPath}" "${outputPath}" --project-root="${FIXTURE_DIR}"`);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.scriptCompleted);
    assert.ok(output.stats.totalSymbols > 0);
    assert.ok(output.stats.uniqueSymbolNames > 0);
    assert.ok(output.symbols);
  });

  it('should include enriched fields (params, extends, fields)', () => {
    const scanPath = path.join(TMP_DIR, 'sym-scan2.json');
    const impPath = path.join(TMP_DIR, 'sym-imp2.json');
    const outputPath = path.join(TMP_DIR, 'sym-output2.json');

    const scanData = {
      files: [
        { path: 'module-a/src/main/java/com/example/entity/User.java', language: 'Java', fileCategory: 'code' },
      ],
    };
    fs.writeFileSync(scanPath, JSON.stringify(scanData));
    fs.writeFileSync(impPath, JSON.stringify({ importMap: {} }));

    run(path.join(SCRIPTS_DIR, 'build-symbol-index.mjs'),
      `"${scanPath}" "${impPath}" "${outputPath}" --project-root="${FIXTURE_DIR}"`);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const userSymbols = output.symbols['User'] || [];
    const userClass = userSymbols.find(s => s.type === 'class');
    assert.ok(userClass, 'User class should exist');
    assert.ok(userClass.fields, 'User class should have fields');
    assert.ok(userClass.fields.length > 0, 'User class should have at least 1 field');
  });
});

describe('compute-file-hashes.mjs', () => {
  it('should compute file hashes for incremental updates', () => {
    const scanPath = path.join(TMP_DIR, 'hash-scan.json');
    const batchPath = path.join(TMP_DIR, 'hash-batch.json');
    const outputPath = path.join(TMP_DIR, 'hash-output.json');

    const scanData = {
      files: [
        { path: 'module-a/src/main/java/com/example/service/UserService.java', language: 'Java', fileCategory: 'code' },
      ],
    };
    const batchData = {
      batches: [
        { batchFiles: [{ path: 'module-a/src/main/java/com/example/service/UserService.java', language: 'Java', fileCategory: 'code' }] },
      ],
    };
    fs.writeFileSync(scanPath, JSON.stringify(scanData));
    fs.writeFileSync(batchPath, JSON.stringify(batchData));

    run(path.join(SCRIPTS_DIR, 'compute-file-hashes.mjs'),
      `"${scanPath}" "${batchPath}" "${outputPath}" --project-root="${FIXTURE_DIR}"`);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.scriptCompleted);
    assert.ok(output.changed);
    assert.ok(output.batchChanges !== undefined);
    assert.ok(output.hashCache);
  });
});

describe('merge-batch-graphs.mjs', () => {
  it('should merge multiple batch graphs', () => {
    const batchDir = path.join(TMP_DIR, 'merge-batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // Create mock batch outputs
    const batch1 = {
      nodes: [
        { id: 'class:UserService', type: 'class', name: 'UserService', summary: 'User service', tags: ['service'] },
      ],
      edges: [],
    };
    const batch2 = {
      nodes: [
        { id: 'class:UserController', type: 'class', name: 'UserController', summary: 'User controller', tags: ['controller'] },
      ],
      edges: [],
    };
    fs.writeFileSync(path.join(batchDir, 'batch-0.json'), JSON.stringify(batch1));
    fs.writeFileSync(path.join(batchDir, 'batch-1.json'), JSON.stringify(batch2));

    const outputPath = path.join(TMP_DIR, 'merged-graph.json');
    run(path.join(SCRIPTS_DIR, 'merge-batch-graphs.mjs'), `"${batchDir}" "${outputPath}" --side=code`);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.nodes.length >= 2);
    assert.ok(output.nodes.some(n => n.name === 'UserService'));
    assert.ok(output.nodes.some(n => n.name === 'UserController'));
  });
});

describe('collect-stats.mjs', () => {
  it('should collect pipeline statistics', () => {
    const workspace = path.join(TMP_DIR, 'stats-ws');
    fs.mkdirSync(workspace, { recursive: true });

    // Create mock workspace files
    fs.writeFileSync(path.join(workspace, '01_code_scan.json'), JSON.stringify({
      files: [
        { path: 'a.java', language: 'Java', fileCategory: 'code' },
        { path: 'b.java', language: 'Java', fileCategory: 'code' },
      ],
    }));
    fs.writeFileSync(path.join(workspace, '01_code_imp_out.json'), JSON.stringify({
      importMap: { 'a.java': ['b.java'] },
    }));
    fs.writeFileSync(path.join(workspace, 'symbol_index.json'), JSON.stringify({
      stats: { totalFiles: 2, totalSymbols: 5, uniqueSymbolNames: 3, byType: { class: 2, function: 3 } },
    }));

    const outputPath = path.join(TMP_DIR, 'stats-output.json');
    run(path.join(GRAPH_SCRIPTS_DIR, 'collect-stats.mjs'), `"${workspace}" "${outputPath}"`);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.scriptCompleted);
    assert.ok(output.stats.totalFiles === 2);
    assert.ok(output.phases.length > 0);
    assert.ok(output.dashboard);
  });
});

describe('concurrency-control.mjs', () => {
  it('should process tasks with concurrency limits', () => {
    const tasksPath = path.join(TMP_DIR, 'concurrency-tasks.json');
    const configPath = path.join(TMP_DIR, 'concurrency-config.json');
    const outputPath = path.join(TMP_DIR, 'concurrency-output.json');

    fs.writeFileSync(tasksPath, JSON.stringify({
      tasks: [
        { id: 't1', agent: 'worker', input: { data: 1 } },
        { id: 't2', agent: 'worker', input: { data: 2 } },
        { id: 't3', agent: 'worker', input: { data: 3 } },
      ],
    }));
    fs.writeFileSync(configPath, JSON.stringify({ maxConcurrency: 2, retryAttempts: 1, timeoutMs: 10000 }));

    run(path.join(SCRIPTS_DIR, 'concurrency-control.mjs'),
      `--tasks="${tasksPath}" --output="${outputPath}" --config="${configPath}"`);

    const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.ok(output.scriptCompleted);
    assert.strictEqual(output.results.length, 3);
    assert.ok(output.config.maxConcurrency === 2);
  });
});
