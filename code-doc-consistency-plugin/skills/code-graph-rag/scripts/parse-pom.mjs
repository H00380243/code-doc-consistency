#!/usr/bin/env node
/**
 * parse-pom.mjs — Maven POM XML parser (Phase A supplement)
 *
 * Zero-dependency regex-based extraction from pom.xml files. Extracts:
 *   - Project coordinates (groupId, artifactId, version, packaging)
 *   - Module list (multi-module projects)
 *   - Dependencies with scope and version
 *   - Parent POM reference
 *   - Properties (version variables)
 *   - Spring Boot starter detection
 *   - Build source directory configuration
 *
 * Usage:
 *   node parse-pom.mjs <inputJson> <outputJson>
 *
 * Input:  { projectRoot, pomPaths?: string[] }  (auto-discovers pom.xml if not provided)
 * Output: { scriptCompleted, stats, modules: [...], project: {...}, dependencies: [...], ... }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, sep, posix } from 'node:path';

// -- XML regex helpers -------------------------------------------------------

function xmlText(xml, tag) {
  // Extract text content from <tag>value</tag> or <tag /> (self-closing)
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlAttr(xml, tag, attr) {
  // Extract attribute from <tag attr="value" ...> or <tag attr='value' ...>
  const re = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlBlock(xml, tag) {
  // Extract inner content of <tag>...</tag> (non-greedy, supports nested via depth counting)
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`);
  const openMatch = xml.match(openRe);
  if (!openMatch) return null;
  const startIdx = openMatch.index + openMatch[0].length;

  // Find matching close tag with depth tracking
  let depth = 1;
  let idx = startIdx;
  const openRe2 = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  const closeRe = new RegExp(`</${tag}>`, 'g');

  while (depth > 0 && idx < xml.length) {
    openRe2.lastIndex = idx;
    closeRe.lastIndex = idx;
    const nextOpen = openRe2.exec(xml);
    const nextClose = closeRe.exec(xml);

    if (!nextClose) break;

    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      idx = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      if (depth === 0) return xml.slice(startIdx, nextClose.index);
      idx = nextClose.index + nextClose[0].length;
    }
  }
  return null;
}

function xmlBlocks(xml, tag) {
  // Extract all top-level <tag>...</tag> blocks
  const results = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const startIdx = m.index + m[0].length;
    let depth = 1;
    let idx = startIdx;
    const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g');
    const closeRe = new RegExp(`</${tag}>`, 'g');

    while (depth > 0 && idx < xml.length) {
      openRe.lastIndex = idx;
      closeRe.lastIndex = idx;
      const nextOpen = openRe.exec(xml);
      const nextClose = closeRe.exec(xml);

      if (!nextClose) break;

      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        idx = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        if (depth === 0) {
          results.push(xml.slice(startIdx, nextClose.index));
          break;
        }
        idx = nextClose.index + nextClose[0].length;
      }
    }
  }
  return results;
}

// -- POM parsing -------------------------------------------------------------

function parseProperties(xml) {
  const props = {};
  const block = xmlBlock(xml, 'properties');
  if (!block) return props;

  // Extract all <key>value</key> entries
  const re = /<(\w[\w.\-]*)>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(block))) {
    props[m[1]] = m[2].trim();
  }
  return props;
}

function resolveProperty(value, properties) {
  if (!value || !value.startsWith('${')) return value;
  const key = value.slice(2, -1);
  return properties[key] || value;
}

function parseProjectCoordinates(xml, properties) {
  // Strip the <parent>...</parent> block to avoid matching parent's coordinates
  const parentEnd = xml.indexOf('</parent>');
  const projectXml = parentEnd >= 0 ? xml.slice(parentEnd + 9) : xml;

  return {
    groupId: resolveProperty(xmlText(projectXml, 'groupId'), properties),
    artifactId: resolveProperty(xmlText(projectXml, 'artifactId'), properties),
    version: resolveProperty(xmlText(projectXml, 'version'), properties),
    packaging: xmlText(projectXml, 'packaging') || 'jar',
  };
}

function parseDependencies(xml, properties) {
  const deps = [];
  const depBlocks = xmlBlocks(xml, 'dependency');
  for (const block of depBlocks) {
    const groupId = resolveProperty(xmlText(block, 'groupId'), properties);
    const artifactId = resolveProperty(xmlText(block, 'artifactId'), properties);
    const version = resolveProperty(xmlText(block, 'version'), properties);
    const scope = xmlText(block, 'scope') || 'compile';
    const optional = xmlText(block, 'optional') === 'true';

    if (groupId && artifactId) {
      deps.push({ groupId, artifactId, version, scope, optional });
    }
  }
  return deps;
}

function parseModules(xml) {
  const modules = [];
  const re = /<module>([^<]*)<\/module>/g;
  let m;
  while ((m = re.exec(xml))) {
    const mod = m[1].trim();
    if (mod) modules.push(mod);
  }
  return modules;
}

function parseParent(xml, properties) {
  const block = xmlBlock(xml, 'parent');
  if (!block) return null;
  return {
    groupId: resolveProperty(xmlText(block, 'groupId'), properties),
    artifactId: resolveProperty(xmlText(block, 'artifactId'), properties),
    version: resolveProperty(xmlText(block, 'version'), properties),
    relativePath: xmlText(block, 'relativePath') || '../pom.xml',
  };
}

function parseBuild(xml, properties) {
  const block = xmlBlock(xml, 'build');
  if (!block) return null;

  const sourceDir = xmlText(block, 'sourceDirectory');
  const testSourceDir = xmlText(block, 'testSourceDirectory');

  // Also check for maven-compiler-plugin configuration
  const compilerBlock = xmlBlock(block, 'maven-compiler-plugin');
  let source = null;
  let target = null;
  if (compilerBlock) {
    source = xmlText(compilerBlock, 'source');
    target = xmlText(compilerBlock, 'target');
  }

  return {
    sourceDirectory: sourceDir || 'src/main/java',
    testSourceDirectory: testSourceDir || 'src/test/java',
    javaSource: source ? resolveProperty(source, properties) : null,
    javaTarget: target ? resolveProperty(target, properties) : null,
  };
}

function detectSpringBoot(dependencies) {
  const starters = dependencies
    .filter(d => d.artifactId.startsWith('spring-boot-starter'))
    .map(d => d.artifactId);

  const bootVersion = dependencies
    .find(d => d.groupId === 'org.springframework.boot' && d.artifactId === 'spring-boot-dependencies');

  const springCloud = dependencies
    .filter(d => d.groupId === 'org.springframework.cloud')
    .map(d => d.artifactId);

  return {
    isSpringBoot: starters.length > 0,
    starters,
    springCloudDependencies: springCloud,
  };
}

function detectFrameworks(dependencies) {
  const frameworks = new Set();

  const frameworkIndicators = [
    ['org.springframework.boot', 'spring-boot-starter-web', 'Spring MVC'],
    ['org.springframework.boot', 'spring-boot-starter-data-jpa', 'Spring Data JPA'],
    ['org.springframework.boot', 'spring-boot-starter-security', 'Spring Security'],
    ['org.springframework.boot', 'spring-boot-starter-cache', 'Spring Cache'],
    ['org.springframework.boot', 'spring-boot-starter-amqp', 'Spring AMQP'],
    ['org.springframework.boot', 'spring-boot-starter-kafka', 'Spring Kafka'],
    ['org.springframework.boot', 'spring-boot-starter-data-redis', 'Spring Data Redis'],
    ['org.springframework.boot', 'spring-boot-starter-data-elasticsearch', 'Spring Data Elasticsearch'],
    ['org.springframework.boot', 'spring-boot-starter-data-mongodb', 'Spring Data MongoDB'],
    ['org.springframework.boot', 'spring-boot-starter-webflux', 'Spring WebFlux'],
    ['org.springframework.boot', 'spring-boot-starter-validation', 'Bean Validation'],
    ['org.mybatis.spring.boot', 'mybatis-spring-boot-starter', 'MyBatis'],
    ['org.mybatis.spring.boot', 'mybatis-spring-boot-autoconfigure', 'MyBatis'],
    ['com.baomidou', 'mybatis-plus-boot-starter', 'MyBatis Plus'],
    ['org.hibernate', 'hibernate-core', 'Hibernate'],
    ['io.grpc', 'grpc-spring-boot-starter', 'gRPC'],
    ['net.devh', 'grpc-spring-boot-starter', 'gRPC'],
    ['org.springframework.cloud', 'spring-cloud-starter-netflix-eureka-client', 'Eureka'],
    ['org.springframework.cloud', 'spring-cloud-starter-openfeign', 'Feign'],
    ['org.springframework.cloud', 'spring-cloud-starter-gateway', 'Spring Cloud Gateway'],
    ['org.springframework.cloud', 'spring-cloud-starter-config', 'Spring Cloud Config'],
    ['org.springframework.cloud', 'spring-cloud-starter-consul-discovery', 'Consul'],
  ];

  for (const [gid, aid, name] of frameworkIndicators) {
    if (dependencies.some(d => d.groupId === gid && d.artifactId === aid)) {
      frameworks.add(name);
    }
  }

  return [...frameworks];
}

function discoverPomPaths(projectRoot) {
  const paths = [];

  // Root pom.xml
  if (existsSync(join(projectRoot, 'pom.xml'))) {
    paths.push('pom.xml');
  }

  // Scan one level deep for module pom.xml files
  try {
    const entries = readdirSync(projectRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'target') {
        const modPom = join(projectRoot, e.name, 'pom.xml');
        if (existsSync(modPom)) {
          paths.push(e.name + '/pom.xml');
        }
      }
    }
  } catch { /* */ }

  return paths.sort();
}

// -- Main --------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const outputPath = args[1];

  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: node parse-pom.mjs <input.json> <output.json>\n');
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const { projectRoot, pomPaths: userPomPaths } = input;

  if (!projectRoot) {
    process.stderr.write('Error: input must contain projectRoot\n');
    process.exit(1);
  }

  const pomPaths = userPomPaths || discoverPomPaths(projectRoot);

  if (pomPaths.length === 0) {
    process.stderr.write('parse-pom: no pom.xml files found\n');
    const out = {
      scriptCompleted: true,
      stats: { pomFilesFound: 0 },
      project: null,
      modules: [],
      allModules: [],
      dependencies: [],
      allDependencies: [],
      frameworks: [],
      springBoot: { isSpringBoot: false, starters: [], springCloudDependencies: [] },
      build: null,
      properties: {},
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(out, null, 2));
    return;
  }

  // Parse each pom.xml
  const parsedModules = [];
  const allDependencies = [];
  const allFrameworks = new Set();
  let rootProject = null;
  let rootBuild = null;
  let rootProperties = {};
  let springBootInfo = { isSpringBoot: false, starters: [], springCloudDependencies: [] };

  for (const pomPath of pomPaths) {
    const absPath = join(projectRoot, pomPath);
    let xml;
    try {
      xml = readFileSync(absPath, 'utf-8');
    } catch (e) {
      process.stderr.write(`Warning: parse-pom: ${pomPath} — ${e.message}\n`);
      continue;
    }

    const properties = parseProperties(xml);
    const mergedProps = { ...properties }; // module-level properties override

    const parent = parseParent(xml, mergedProps);
    const project = parseProjectCoordinates(xml, mergedProps);
    if (parent) project.parent = parent;

    // Inherit groupId from parent if not specified
    if (!project.groupId && parent) project.groupId = parent.groupId;

    const modules = parseModules(xml);
    const dependencies = parseDependencies(xml, mergedProps);
    const build = parseBuild(xml, mergedProps);
    const frameworks = detectFrameworks(dependencies);

    const moduleInfo = {
      pomPath,
      project,
      modules,
      dependencies,
      build,
      frameworks,
      properties: mergedProps,
    };

    parsedModules.push(moduleInfo);

    // Collect root POM info
    if (pomPath === 'pom.xml') {
      rootProject = project;
      rootBuild = build;
      rootProperties = mergedProps;
    }

    // Collect all dependencies (excluding test/provided scope for main analysis)
    allDependencies.push(...dependencies.map(d => ({ ...d, module: pomPath })));
    frameworks.forEach(f => allFrameworks.add(f));
  }

  // Detect Spring Boot from ALL dependencies (across all modules)
  springBootInfo = detectSpringBoot(allDependencies);

  // Build module hierarchy
  const rootModules = parsedModules.find(m => m.pomPath === 'pom.xml');
  const moduleNames = rootModules ? rootModules.modules : [];

  // Find sub-module POMs
  const allModules = moduleNames.map(modName => {
    const subPom = parsedModules.find(m => m.pomPath === modName + '/pom.xml');
    return {
      name: modName,
      pomPath: modName + '/pom.xml',
      project: subPom ? subPom.project : null,
      frameworks: subPom ? subPom.frameworks : [],
    };
  });

  // Resolve source directories
  const sourceDirs = {};
  for (const mod of parsedModules) {
    const modName = mod.pomPath === 'pom.xml' ? '.' : mod.pomPath.replace('/pom.xml', '');
    sourceDirs[modName] = {
      main: mod.build?.sourceDirectory || 'src/main/java',
      test: mod.build?.testSourceDirectory || 'src/test/java',
    };
  }

  const out = {
    scriptCompleted: true,
    stats: {
      pomFilesFound: pomPaths.length,
      totalDependencies: allDependencies.length,
      frameworksDetected: [...allFrameworks],
    },
    // Root project info
    project: rootProject,
    // Module list (direct children of root)
    modules: moduleNames,
    // Detailed module info
    allModules,
    // Source directory layout
    sourceDirs,
    // All dependencies (flat)
    dependencies: allDependencies.filter(d => d.scope !== 'test' && d.scope !== 'provided'),
    // All dependencies including test/provided
    allDependencies,
    // Detected frameworks
    frameworks: [...allFrameworks],
    // Spring Boot info
    springBoot: springBootInfo,
    // Build config
    build: rootBuild,
    // Root properties
    properties: rootProperties,
    // Per-module info
    parsedModules: parsedModules.map(m => ({
      pomPath: m.pomPath,
      project: m.project,
      modules: m.modules,
      frameworkCount: m.frameworks.length,
    })),
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(
    `parse-pom: pomFiles=${pomPaths.length} modules=${moduleNames.length} ` +
    `deps=${allDependencies.length} frameworks=${[...allFrameworks].join(',') || 'none'}\n`
  );
}

main();
