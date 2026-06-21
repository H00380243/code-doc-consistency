#!/usr/bin/env node
/**
 * concurrency-control.mjs — Manage parallel worker execution with limits
 *
 * Provides a worker pool implementation for running multiple LLM workers
 * in parallel while respecting concurrency limits. Tracks worker status,
 * handles failures, and supports graceful shutdown.
 *
 * Usage:
 *   node concurrency-control.mjs --config=<config.json> --tasks=<tasks.json> --output=<output.json>
 *
 * Input config:  { maxConcurrency, retryAttempts, timeoutMs, queueStrategy }
 * Input tasks:   [{ id, agent, input, priority }]
 * Output:        { scriptCompleted, results: [{ id, status, output, error }], stats }
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Default configuration ────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  maxConcurrency: 4,
  retryAttempts: 2,
  timeoutMs: 300000, // 5 minutes
  queueStrategy: 'fifo', // fifo, lifo, priority
};

// ── Worker pool implementation ───────────────────────────────────────────────

class WorkerPool {
  constructor(config) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.running = new Map(); // taskId -> { worker, startTime }
    this.queue = []; // pending tasks
    this.results = new Map(); // taskId -> { status, output, error, attempts }
    this.stats = {
      totalTasks: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      avgDurationMs: 0,
    };
  }

  /**
   * Add tasks to the pool
   * @param {Array} tasks - [{ id, agent, input, priority }]
   */
  addTasks(tasks) {
    this.stats.totalTasks = tasks.length;

    // Sort based on strategy
    switch (this.config.queueStrategy) {
      case 'priority':
        tasks.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        break;
      case 'lifo':
        tasks.reverse();
        break;
      default: // fifo - no sort
        break;
    }

    for (const task of tasks) {
      this.queue.push(task);
      this.results.set(task.id, {
        status: 'pending',
        output: null,
        error: null,
        attempts: 0,
      });
    }
  }

  /**
   * Process the next task from the queue
   * @param {Function} workerFn - async (task) => output
   * @returns {Promise<boolean>} - true if a task was started
   */
  async processNext(workerFn) {
    if (this.running.size >= this.config.maxConcurrency) {
      return false;
    }

    const task = this.queue.shift();
    if (!task) {
      return false;
    }

    const result = this.results.get(task.id);
    result.attempts++;

    const startTime = Date.now();
    this.running.set(task.id, { startTime, task });

    try {
      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Task timeout')), this.config.timeoutMs);
      });

      // Run worker with timeout
      const outputPromise = workerFn(task);
      const output = await Promise.race([outputPromise, timeoutPromise]);

      result.status = 'completed';
      result.output = output;
      result.durationMs = Date.now() - startTime;
      this.stats.completed++;
    } catch (error) {
      result.error = error.message;
      result.durationMs = Date.now() - startTime;

      if (result.attempts < this.config.retryAttempts) {
        // Retry
        result.status = 'pending';
        this.queue.unshift(task); // Add to front of queue
        this.stats.retried++;
      } else {
        result.status = 'failed';
        this.stats.failed++;
      }
    } finally {
      this.running.delete(task.id);
    }

    return true;
  }

  /**
   * Run all tasks with concurrency control
   * @param {Function} workerFn - async (task) => output
   * @returns {Promise<Map>} - results map
   */
  async runAll(workerFn) {
    let active = true;

    while (active) {
      // Try to start new tasks
      while (this.running.size < this.config.maxConcurrency && this.queue.length > 0) {
        await this.processNext(workerFn);
      }

      // Wait for a running task to complete
      if (this.running.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      } else if (this.queue.length === 0) {
        active = false;
      }
    }

    // Calculate average duration
    let totalDuration = 0;
    let count = 0;
    for (const result of this.results.values()) {
      if (result.durationMs) {
        totalDuration += result.durationMs;
        count++;
      }
    }
    this.stats.avgDurationMs = count > 0 ? Math.round(totalDuration / count) : 0;

    return this.results;
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      running: this.running.size,
      queued: this.queue.length,
      completed: this.stats.completed,
      failed: this.stats.failed,
    };
  }
}

// ── Task executor (simulated) ────────────────────────────────────────────────

/**
 * Execute a worker task. In production, this would invoke the actual
 * LLM agent via the Claude Code API or subprocess.
 *
 * @param {object} task - { id, agent, input, priority }
 * @returns {Promise<object>} - worker output
 */
async function executeWorker(task) {
  // Simulate worker execution
  // In production, this would:
  // 1. Load the agent definition
  // 2. Prepare the input context
  // 3. Invoke the LLM (via Claude Code API or subprocess)
  // 4. Parse and return the output

  const { id, agent, input } = task;

  // Simulate processing time based on input size
  const inputSize = JSON.stringify(input).length;
  const processingTime = Math.min(1000 + inputSize / 100, 5000);
  await new Promise(resolve => setTimeout(resolve, processingTime));

  return {
    taskId: id,
    agent,
    status: 'completed',
    output: {
      nodes: [],
      edges: [],
      summary: `Processed by ${agent}`,
    },
    processedAt: new Date().toISOString(),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let configPath = null;
  let tasksPath = null;
  let outputPath = null;

  for (const a of args) {
    if (a.startsWith('--config=')) configPath = a.slice(9);
    else if (a.startsWith('--tasks=')) tasksPath = a.slice(8);
    else if (a.startsWith('--output=')) outputPath = a.slice(9);
  }

  if (!tasksPath || !outputPath) {
    process.stderr.write(
      'Usage: node concurrency-control.mjs --tasks=<tasks.json> --output=<output.json> [--config=<config.json>]\n'
    );
    process.exit(1);
  }

  // Load config
  let config = DEFAULT_CONFIG;
  if (configPath) {
    try {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath, 'utf-8')) };
    } catch (e) {
      process.stderr.write(`Warning: could not read config, using defaults: ${e.message}\n`);
    }
  }

  // Load tasks
  const tasksData = JSON.parse(readFileSync(tasksPath, 'utf-8'));
  const tasks = tasksData.tasks || tasksData;

  if (!Array.isArray(tasks) || tasks.length === 0) {
    process.stderr.write('Error: no tasks provided\n');
    process.exit(1);
  }

  process.stderr.write(
    `concurrency-control: tasks=${tasks.length} maxConcurrency=${config.maxConcurrency} ` +
    `retryAttempts=${config.retryAttempts} timeout=${config.timeoutMs}ms\n`
  );

  // Create worker pool and run tasks
  const pool = new WorkerPool(config);
  pool.addTasks(tasks);

  // Run with simulated workers
  pool.runAll(executeWorker).then(results => {
    const output = {
      scriptCompleted: true,
      config,
      results: Array.from(results.entries()).map(([id, result]) => ({
        id,
        ...result,
      })),
      stats: pool.stats,
    };

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(output, null, 2));

    process.stderr.write(
      `concurrency-control: completed=${pool.stats.completed} failed=${pool.stats.failed} ` +
      `retried=${pool.stats.retried} avgDuration=${pool.stats.avgDurationMs}ms\n`
    );
  }).catch(error => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  });
}

// Export for programmatic use
export { WorkerPool, executeWorker, DEFAULT_CONFIG };

main();
