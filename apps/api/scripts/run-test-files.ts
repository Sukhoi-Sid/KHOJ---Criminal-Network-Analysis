import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

// Node 24 on Windows can terminate Vitest's default worker during an
// integration-heavy file. A fresh VM-thread process per file preserves
// isolation and every assertion while avoiding that runtime issue.
const apiRoot = path.resolve(__dirname, '..');
const testsRoot = path.join(apiRoot, 'src', '__tests__');
const vitestEntry = path.join(apiRoot, 'node_modules', 'vitest', 'vitest.mjs');
const testFiles = readdirSync(testsRoot)
  .filter((name) => name.endsWith('.test.ts'))
  .sort((left, right) => {
    // This suite deliberately restarts the Neo4j driver to exercise a real
    // outage, so leave it last and let the process terminate immediately
    // after its cleanup on Windows.
    if (left === 'brain-workflow.test.ts') return 1;
    if (right === 'brain-workflow.test.ts') return -1;
    return left.localeCompare(right);
  })
  .map((name) => path.join('src', '__tests__', name));

for (const testFile of testFiles) {
  const result = spawnSync(
    process.execPath,
    [vitestEntry, 'run', testFile, '--pool=vmThreads', '--maxWorkers=1'],
    { cwd: apiRoot, env: process.env, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Verified ${testFiles.length} test files in isolated Vitest processes.`);
