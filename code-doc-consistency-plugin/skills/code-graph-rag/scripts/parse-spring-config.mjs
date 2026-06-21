#!/usr/bin/env node
/**
 * parse-spring-config.mjs — Spring configuration file analyzer
 *
 * Parses application.yml, application.properties, bootstrap.yml, and
 * profile-specific variants. Extracts infrastructure configuration
 * (datasource, Redis, security, server, messaging) and custom properties.
 *
 * Usage:
 *   node parse-spring-config.mjs <inputJson> <outputJson>
 *
 * Input:  { projectRoot, configPaths?: string[] }  (auto-discovers if not provided)
 * Output: { scriptCompleted, stats, configs: [...] }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

// -- YAML-like parser (minimal, for Spring Boot config) ----------------------

function parseYamlValue(value) {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  return trimmed;
}

function parseYaml(content) {
  const result = {};
  const lines = content.split('\n');
  const stack = [{ obj: result, indent: -1 }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack to find parent
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    // Key: value pair
    const kvMatch = trimmed.match(/^([\w.\-]+)\s*:\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === '' || value === '|' || value === '>') {
        // Nested block or multi-line
        const child = {};
        parent[key] = child;
        stack.push({ obj: child, indent: indent });
      } else if (value.startsWith('[')) {
        // Inline array
        try { parent[key] = JSON.parse(value); }
        catch { parent[key] = value; }
      } else {
        parent[key] = parseYamlValue(value);
      }
    }
  }
  return result;
}

function parseProperties(content) {
  const result = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = parseYamlValue(value);
  }
  return result;
}

// -- Spring config extraction ------------------------------------------------

function extractDatasource(props) {
  const ds = {};
  const keys = [
    'spring.datasource.url', 'spring.datasource.driver-class-name',
    'spring.datasource.username', 'spring.datasource.password',
    'spring.datasource.hikari.maximum-pool-size',
    'spring.datasource.hikari.minimum-idle',
    'spring.datasource.hikari.connection-timeout',
    'spring.jpa.database-platform', 'spring.jpa.hibernate.ddl-auto',
    'spring.jpa.show-sql',
  ];
  for (const key of keys) {
    if (props[key] !== undefined) {
      const shortKey = key.replace(/^spring\.(datasource|jpa)\.?/, '');
      ds[shortKey] = props[key];
    }
  }
  // Check for nested datasource
  if (props.spring?.datasource) {
    Object.assign(ds, props.spring.datasource);
  }
  return Object.keys(ds).length > 0 ? ds : null;
}

function extractRedis(props) {
  const redis = {};
  const keys = [
    'spring.data.redis.host', 'spring.data.redis.port',
    'spring.data.redis.password', 'spring.data.redis.database',
    'spring.redis.host', 'spring.redis.port',
  ];
  for (const key of keys) {
    if (props[key] !== undefined) {
      const shortKey = key.replace(/^spring\.data\.redis\./, '').replace(/^spring\.redis\./, '');
      redis[shortKey] = props[key];
    }
  }
  return Object.keys(redis).length > 0 ? redis : null;
}

function extractServer(props) {
  const server = {};
  const keys = [
    'server.port', 'server.servlet.context-path',
    'server.address', 'server.tomcat.max-threads',
  ];
  for (const key of keys) {
    if (props[key] !== undefined) {
      const shortKey = key.replace('server.', '');
      server[shortKey] = props[key];
    }
  }
  return Object.keys(server).length > 0 ? server : null;
}

function extractSecurity(props) {
  const sec = {};
  const keys = [
    'spring.security.user.name', 'spring.security.user.password',
    'spring.security.oauth2.resourceserver.jwt.issuer-uri',
    'spring.security.oauth2.client.registration.*',
  ];
  for (const key of keys) {
    if (props[key] !== undefined) {
      sec[key.replace('spring.security.', '')] = props[key];
    }
  }
  return Object.keys(sec).length > 0 ? sec : null;
}

function extractMessaging(props) {
  const msg = {};
  // RabbitMQ
  const rabbitKeys = [
    'spring.rabbitmq.host', 'spring.rabbitmq.port',
    'spring.rabbitmq.username', 'spring.rabbitmq.virtual-host',
  ];
  for (const key of rabbitKeys) {
    if (props[key] !== undefined) {
      msg.rabbitmq = msg.rabbitmq || {};
      msg.rabbitmq[key.replace('spring.rabbitmq.', '')] = props[key];
    }
  }
  // Kafka
  const kafkaKeys = [
    'spring.kafka.bootstrap-servers', 'spring.kafka.consumer.group-id',
    'spring.kafka.consumer.auto-offset-reset',
  ];
  for (const key of kafkaKeys) {
    if (props[key] !== undefined) {
      msg.kafka = msg.kafka || {};
      msg.kafka[key.replace('spring.kafka.', '')] = props[key];
    }
  }
  return Object.keys(msg).length > 0 ? msg : null;
}

function extractElasticsearch(props) {
  const es = {};
  const keys = [
    'spring.elasticsearch.uris', 'spring.elasticsearch.username',
    'spring.elasticsearch.password',
  ];
  for (const key of keys) {
    if (props[key] !== undefined) {
      es[key.replace('spring.elasticsearch.', '')] = props[key];
    }
  }
  return Object.keys(es).length > 0 ? es : null;
}

function extractCustomProperties(props) {
  const custom = {};
  const springPrefixes = [
    'spring.datasource', 'spring.data.redis', 'spring.redis',
    'spring.jpa', 'spring.security', 'spring.rabbitmq', 'spring.kafka',
    'spring.elasticsearch', 'server.', 'logging.',
  ];
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'object' && value !== null) continue;
    const isSpring = springPrefixes.some(p => key.startsWith(p));
    if (!isSpring && !key.startsWith('spring.')) {
      custom[key] = value;
    }
  }
  return Object.keys(custom).length > 0 ? custom : null;
}

function extractProfiles(props) {
  const active = props['spring.profiles.active'] || props['spring.profiles.include'];
  if (Array.isArray(active)) return active;
  if (typeof active === 'string') return active.split(',').map(s => s.trim());
  return [];
}

function extractLogging(props) {
  const logging = {};
  const keys = [
    'logging.level.root', 'logging.level.org.springframework',
    'logging.level.org.hibernate', 'logging.file.name',
    'logging.file.path',
  ];
  for (const key of keys) {
    if (props[key] !== undefined) {
      logging[key.replace('logging.', '')] = props[key];
    }
  }
  return Object.keys(logging).length > 0 ? logging : null;
}

// -- Config file discovery ---------------------------------------------------

function discoverConfigFiles(projectRoot) {
  const patterns = [
    'src/main/resources/application.yml',
    'src/main/resources/application.yaml',
    'src/main/resources/application.properties',
    'src/main/resources/bootstrap.yml',
    'src/main/resources/bootstrap.yaml',
    'src/main/resources/bootstrap.properties',
  ];

  const found = [];
  for (const p of patterns) {
    if (existsSync(join(projectRoot, p))) found.push(p);
  }

  // Find profile-specific configs: application-{profile}.yml
  const resDir = join(projectRoot, 'src/main/resources');
  if (existsSync(resDir)) {
    try {
      const files = readdirSync(resDir);
      for (const f of files) {
        const profileMatch = f.match(/^application-(.+)\.(ya?ml|properties)$/);
        if (profileMatch && !found.includes('src/main/resources/' + f)) {
          found.push('src/main/resources/' + f);
        }
      }
    } catch { /* */ }
  }

  return found.sort();
}

// -- Main --------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const outputPath = args[1];

  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: node parse-spring-config.mjs <input.json> <output.json>\n');
    process.exit(1);
  }

  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const { projectRoot, configPaths: userConfigPaths } = input;

  if (!projectRoot) {
    process.stderr.write('Error: input must contain projectRoot\n');
    process.exit(1);
  }

  const configPaths = userConfigPaths || discoverConfigFiles(projectRoot);

  if (configPaths.length === 0) {
    process.stderr.write('parse-spring-config: no Spring config files found\n');
    const out = {
      scriptCompleted: true,
      stats: { configFilesFound: 0 },
      configs: [],
      datasource: null,
      redis: null,
      server: null,
      security: null,
      messaging: null,
      elasticsearch: null,
      logging: null,
      profiles: [],
      customProperties: null,
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(out, null, 2));
    return;
  }

  const configs = [];
  const allProps = {};

  for (const configPath of configPaths) {
    const absPath = join(projectRoot, configPath);
    let content;
    try { content = readFileSync(absPath, 'utf-8'); }
    catch (e) {
      process.stderr.write(`Warning: parse-spring-config: ${configPath} — ${e.message}\n`);
      continue;
    }

    const isYaml = configPath.endsWith('.yml') || configPath.endsWith('.yaml');
    const isProperties = configPath.endsWith('.properties');
    const isProfile = /application-\w+\.(ya?ml|properties)$/.test(configPath);
    const isBootstrap = configPath.startsWith('bootstrap');

    let props;
    try {
      props = isYaml ? parseYaml(content) : parseProperties(content);
    } catch (e) {
      process.stderr.write(`Warning: parse-spring-config: ${configPath} parse error: ${e.message}\n`);
      continue;
    }

    // Flatten nested YAML properties
    function flatten(obj, prefix = '') {
      const flat = {};
      for (const [key, value] of Object.entries(obj || {})) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          Object.assign(flat, flatten(value, fullKey));
        } else {
          flat[fullKey] = value;
        }
      }
      return flat;
    }

    const flatProps = flatten(props);
    Object.assign(allProps, flatProps);

    configs.push({
      path: configPath,
      isProfile,
      isBootstrap,
      profile: isProfile ? configPath.match(/application-(\w+)\./)?.[1] : null,
      properties: flatProps,
    });
  }

  // Extract consolidated infrastructure config
  const datasource = extractDatasource(allProps);
  const redis = extractRedis(allProps);
  const server = extractServer(allProps);
  const security = extractSecurity(allProps);
  const messaging = extractMessaging(allProps);
  const elasticsearch = extractElasticsearch(allProps);
  const logging = extractLogging(allProps);
  const profiles = extractProfiles(allProps);
  const customProperties = extractCustomProperties(allProps);

  const out = {
    scriptCompleted: true,
    stats: {
      configFilesFound: configPaths.length,
      profileConfigs: configs.filter(c => c.isProfile).length,
      hasDatasource: !!datasource,
      hasRedis: !!redis,
      hasSecurity: !!security,
      hasMessaging: !!messaging,
      hasElasticsearch: !!elasticsearch,
    },
    configs,
    datasource,
    redis,
    server,
    security,
    messaging,
    elasticsearch,
    logging,
    profiles,
    customProperties,
    // Flat merged properties for downstream use
    allProperties: allProps,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(out, null, 2));
  process.stderr.write(
    `parse-spring-config: files=${configPaths.length} profiles=${profiles.join(',') || 'none'} ` +
    `datasource=${!!datasource} redis=${!!redis} security=${!!security}\n`
  );
}

main();
