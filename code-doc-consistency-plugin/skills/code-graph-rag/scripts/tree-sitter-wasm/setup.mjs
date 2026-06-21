#!/usr/bin/env node
/**
 * setup.mjs — Setup tree-sitter WASM files for CDC plugin
 *
 * Downloads and installs the required WASM files for tree-sitter Java parsing.
 * Run this once to enable tree-sitter in the pipeline.
 *
 * Usage:
 *   node setup.mjs [--wasm-dir=<path>]
 *
 * If --wasm-dir is not specified, files are installed to the current directory.
 */

import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
let wasmDir = process.cwd();

for (const a of args) {
  if (a.startsWith('--wasm-dir=')) wasmDir = a.slice(11);
}

console.log('Setting up tree-sitter WASM for CDC plugin...');
console.log(`Target directory: ${wasmDir}\n`);

// Check if npm is available
try {
  execSync('npm --version', { stdio: 'ignore' });
} catch {
  console.error('Error: npm is not available. Please install Node.js with npm.');
  process.exit(1);
}

// Create target directory
mkdirSync(wasmDir, { recursive: true });

// Check if already set up
const treeSitterWasm = join(wasmDir, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
if (existsSync(treeSitterWasm)) {
  console.log('tree-sitter WASM already installed.');
  console.log(`Location: ${treeSitterWasm}`);
  process.exit(0);
}

console.log('Installing web-tree-sitter...');
try {
  execSync(`npm install web-tree-sitter@^0.24.0`, {
    cwd: wasmDir,
    stdio: 'inherit',
  });
} catch (e) {
  console.error('Failed to install web-tree-sitter:', e.message);
  process.exit(1);
}

// Try to download Java grammar WASM
const javaGrammarUrl = 'https://github.com/tree-sitter/tree-sitter-java/releases/latest/download/tree-sitter-java.wasm';
const javaGrammarPath = join(wasmDir, 'tree-sitter-java.wasm');

if (!existsSync(javaGrammarPath)) {
  console.log('\nDownloading tree-sitter-java grammar WASM...');
  try {
    execSync(`curl -L -o "${javaGrammarPath}" "${javaGrammarUrl}"`, {
      stdio: 'inherit',
    });
    console.log('Java grammar downloaded successfully.');
  } catch {
    console.log('\nCould not download Java grammar WASM automatically.');
    console.log('Please download manually from:');
    console.log(`  ${javaGrammarUrl}`);
    console.log(`And save to: ${javaGrammarPath}`);
  }
}

// Verify installation
console.log('\nVerifying installation...');
const treeSitterExists = existsSync(join(wasmDir, 'node_modules', 'web-tree-sitter', 'tree-sitter.js'));
const grammarExists = existsSync(javaGrammarPath);

if (treeSitterExists && grammarExists) {
  console.log('\n✅ tree-sitter WASM setup complete!');
  console.log('\nUsage with CDC plugin:');
  console.log(`  node extract-structure.mjs input.json output.json --wasm-dir="${wasmDir}"`);
  console.log(`\nOr set the environment variable:`);
  console.log(`  export CDC_WASM_DIR="${wasmDir}"`);
} else {
  console.log('\n⚠️  Setup completed with warnings:');
  if (!treeSitterExists) console.log('  - web-tree-sitter WASM not found');
  if (!grammarExists) console.log('  - Java grammar WASM not found');
  console.log('\nThe plugin will fall back to regex parsing for Java files.');
}
