import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const SCRIPTS_DIR = join(import.meta.dirname, '../code-doc-consistency-plugin/skills/code-graph-rag/scripts');
const FIXTURE_DIR = join(import.meta.dirname, 'fixtures/java-project');
const TMP_DIR = join(import.meta.dirname, '../.tmp');

function ensureTmp() {
  mkdirSync(TMP_DIR, { recursive: true });
}

function cleanupTmp() {
  try { rmSync(TMP_DIR, { recursive: true }); } catch { /* */ }
}

function runScript(scriptName, args) {
  const cmd = `node ${join(SCRIPTS_DIR, scriptName)} ${args.join(' ')}`;
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('parse-pom.mjs', () => {
  it('should parse multi-module Maven project', () => {
    ensureTmp();
    const inputPath = join(TMP_DIR, 'pom-input.json');
    const outputPath = join(TMP_DIR, 'pom-output.json');

    writeFileSync(inputPath, JSON.stringify({ projectRoot: FIXTURE_DIR }));

    runScript('parse-pom.mjs', [inputPath, outputPath]);

    const result = JSON.parse(readFileSync(outputPath, 'utf-8'));

    assert.equal(result.scriptCompleted, true);
    assert.equal(result.stats.pomFilesFound, 3); // root + module-a + module-b
    assert.deepEqual(result.modules, ['module-a', 'module-b']);
    assert.equal(result.project.groupId, 'com.example');
    assert.equal(result.project.artifactId, 'demo-project');
    assert.equal(result.project.version, '1.0.0-SNAPSHOT');
    assert.ok(result.project.parent);
    assert.equal(result.project.parent.artifactId, 'spring-boot-starter-parent');

    // Check frameworks detection
    assert.ok(result.frameworks.includes('Spring MVC'));
    assert.ok(result.frameworks.includes('Spring Data JPA'));
    assert.ok(result.frameworks.includes('Spring Security'));
    assert.ok(result.frameworks.includes('Spring Cache'));
    assert.ok(result.frameworks.includes('Spring AMQP'));
    assert.ok(result.frameworks.includes('MyBatis Plus'));

    // Check Spring Boot detection
    assert.equal(result.springBoot.isSpringBoot, true);
    assert.ok(result.springBoot.starters.length > 0);

    cleanupTmp();
  });

  it('should handle non-Maven project gracefully', () => {
    ensureTmp();
    const inputPath = join(TMP_DIR, 'pom-input2.json');
    const outputPath = join(TMP_DIR, 'pom-output2.json');

    writeFileSync(inputPath, JSON.stringify({ projectRoot: TMP_DIR }));

    runScript('parse-pom.mjs', [inputPath, outputPath]);

    const result = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.equal(result.scriptCompleted, true);
    assert.equal(result.stats.pomFilesFound, 0);
    assert.equal(result.modules.length, 0);

    cleanupTmp();
  });
});

describe('extract-structure.mjs - Java parser', () => {
  it('should extract Java class with annotations and fields', () => {
    ensureTmp();
    const inputPath = join(TMP_DIR, 'struct-input.json');
    const outputPath = join(TMP_DIR, 'struct-output.json');

    writeFileSync(inputPath, JSON.stringify({
      projectRoot: FIXTURE_DIR,
      batchFiles: [{
        path: 'module-a/src/main/java/com/example/entity/User.java',
        language: 'java',
        sizeLines: 50,
        fileCategory: 'code',
      }],
    }));

    runScript('extract-structure.mjs', [inputPath, outputPath]);

    const result = JSON.parse(readFileSync(outputPath, 'utf-8'));
    assert.equal(result.scriptCompleted, true);
    assert.equal(result.filesAnalyzed, 1);

    const userFile = result.results[0];
    assert.equal(userFile.language, 'java');
    assert.equal(userFile.javaPackage, 'com.example.entity');

    // Should have 1 class (User)
    assert.ok(userFile.classes.length >= 1);
    const userClass = userFile.classes.find(c => c.name === 'User');
    assert.ok(userClass, 'User class should be found');
    assert.ok(userClass.annotations.includes('Entity'));
    assert.ok(userClass.fields && userClass.fields.length > 0);

    // Should have methods (Java methods are inside class.methodDetails)
    assert.ok(userClass.methodDetails.length > 0);

    cleanupTmp();
  });

  it('should extract Spring MVC endpoints', () => {
    ensureTmp();
    const inputPath = join(TMP_DIR, 'struct-input2.json');
    const outputPath = join(TMP_DIR, 'struct-output2.json');

    writeFileSync(inputPath, JSON.stringify({
      projectRoot: FIXTURE_DIR,
      batchFiles: [{
        path: 'module-a/src/main/java/com/example/controller/UserController.java',
        language: 'java',
        sizeLines: 80,
        fileCategory: 'code',
      }],
    }));

    runScript('extract-structure.mjs', [inputPath, outputPath]);

    const result = JSON.parse(readFileSync(outputPath, 'utf-8'));
    const controllerFile = result.results[0];

    // Should detect Spring endpoints
    assert.ok(controllerFile.springEndpoints.length > 0,
      'Should detect Spring MVC endpoints');

    const getEndpoint = controllerFile.springEndpoints.find(
      e => e.methodName === 'getUser'
    );
    assert.ok(getEndpoint, 'Should find getUser endpoint');
    assert.ok(getEndpoint.mappings.some(m => m.path.includes('/{id}')),
      'Should extract path variable');

    cleanupTmp();
  });

  it('should extract interfaces separately from classes', () => {
    ensureTmp();
    const inputPath = join(TMP_DIR, 'struct-input3.json');
    const outputPath = join(TMP_DIR, 'struct-output3.json');

    writeFileSync(inputPath, JSON.stringify({
      projectRoot: FIXTURE_DIR,
      batchFiles: [{
        path: 'module-a/src/main/java/com/example/repository/UserRepository.java',
        language: 'java',
        sizeLines: 15,
        fileCategory: 'code',
      }],
    }));

    runScript('extract-structure.mjs', [inputPath, outputPath]);

    const result = JSON.parse(readFileSync(outputPath, 'utf-8'));
    const repoFile = result.results[0];

    // Should have interface, not class
    assert.ok(repoFile.interfaces.length > 0, 'Should extract interfaces');
    const userRepo = repoFile.interfaces.find(i => i.name === 'UserRepository');
    assert.ok(userRepo, 'UserRepository interface should be found');
    assert.ok(userRepo.annotations.includes('Repository'));
    assert.ok(userRepo.extends, 'Should have extends (JpaRepository)');

    cleanupTmp();
  });

  it('should extract enums', () => {
    ensureTmp();
    const inputPath = join(TMP_DIR, 'struct-input4.json');
    const outputPath = join(TMP_DIR, 'struct-output4.json');

    writeFileSync(inputPath, JSON.stringify({
      projectRoot: FIXTURE_DIR,
      batchFiles: [{
        path: 'module-a/src/main/java/com/example/entity/UserStatus.java',
        language: 'java',
        sizeLines: 10,
        fileCategory: 'code',
      }],
    }));

    runScript('extract-structure.mjs', [inputPath, outputPath]);

    const result = JSON.parse(readFileSync(outputPath, 'utf-8'));
    const enumFile = result.results[0];

    assert.ok(enumFile.enums.length > 0, 'Should extract enums');
    const status = enumFile.enums.find(e => e.name === 'UserStatus');
    assert.ok(status, 'UserStatus enum should be found');
    assert.ok(status.constants.length >= 4, 'Should have 4 constants');

    cleanupTmp();
  });

  it('should detect JPA entities', () => {
    ensureTmp();
    const inputPath = join(TMP_DIR, 'struct-input5.json');
    const outputPath = join(TMP_DIR, 'struct-output5.json');

    writeFileSync(inputPath, JSON.stringify({
      projectRoot: FIXTURE_DIR,
      batchFiles: [{
        path: 'module-a/src/main/java/com/example/entity/User.java',
        language: 'java',
        sizeLines: 50,
        fileCategory: 'code',
      }],
    }));

    runScript('extract-structure.mjs', [inputPath, outputPath]);

    const result = JSON.parse(readFileSync(outputPath, 'utf-8'));
    const userFile = result.results[0];

    assert.ok(userFile.jpaEntities.length > 0, 'Should detect JPA entities');
    const entity = userFile.jpaEntities[0];
    assert.equal(entity.className, 'User');
    assert.equal(entity.tableName, 't_user');
    assert.ok(entity.fields.length > 0, 'Should extract entity fields');

    cleanupTmp();
  });
});

describe('extract-import-map.mjs - Java resolver', () => {
  it('should resolve Java imports across modules', () => {
    ensureTmp();
    const scanPath = join(TMP_DIR, 'scan-output.json');
    const importPath = join(TMP_DIR, 'import-output.json');

    // First run scan-project
    runScript('scan-project.mjs', [FIXTURE_DIR, scanPath]);

    // Then run extract-import-map
    const scanData = JSON.parse(readFileSync(scanPath, 'utf-8'));
    const importInput = join(TMP_DIR, 'import-input.json');
    writeFileSync(importInput, JSON.stringify({
      projectRoot: FIXTURE_DIR,
      files: scanData.files,
    }));

    runScript('extract-import-map.mjs', [importInput, importPath]);

    const result = JSON.parse(readFileSync(importPath, 'utf-8'));
    assert.equal(result.scriptCompleted, true);

    // UserController.java should import UserService and User
    const controllerImports = result.importMap['module-a/src/main/java/com/example/controller/UserController.java'];
    assert.ok(controllerImports, 'Controller should have imports');
    assert.ok(controllerImports.length > 0, 'Controller should have resolved imports');

    cleanupTmp();
  });
});
