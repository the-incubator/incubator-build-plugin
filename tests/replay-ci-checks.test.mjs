import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/inc-commit-push-pr/scripts/replay-ci-checks', import.meta.url));

function replay(workflows) {
  const root = mkdtempSync(join(tmpdir(), 'replay-ci-checks-'));
  try {
    const dir = join(root, '.github', 'workflows');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(workflows)) writeFileSync(join(dir, name), content);
    const result = spawnSync('python3', [script, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('pull-request workflows expose build/test/e2e and still skip checkout, setup, and install', () => {
  const steps = replay({
    'pr.yml': `on: pull_request\njobs:\n  checks:\n    steps:\n      - name: Checkout source\n        run: git checkout main\n      - name: Setup Node toolchain\n        run: nvm install 22\n      - name: Install dependencies\n        run: npm ci\n      - name: Build app\n        run: npm run build\n      - name: Unit tests\n        run: npm test\n      - name: End-to-end tests\n        run: npm run e2e\n      - name: Typecheck\n        run: npm run typecheck\n`,
    'main.yml': `on:\n  push:\n    branches: [main]\njobs:\n  checks:\n    steps:\n      - name: Main only check\n        run: npm run main-check\n`,
  });
  assert.deepEqual(steps.map(({ step, cmd }) => [step, cmd]), [
    ['Build app', 'npm run build'],
    ['Unit tests', 'npm test'],
    ['End-to-end tests', 'npm run e2e'],
    ['Typecheck', 'npm run typecheck'],
  ]);
});

test('main-only push workflows expose build and test for session-aware replay, skipping checkout, setup, and install', () => {
  const steps = replay({
    'ci.yml': `on:\n  push:\n    branches: [main]\njobs:\n  checks:\n    steps:\n      - name: Checkout source\n        run: git checkout main\n      - name: Set up Node toolchain\n        run: nvm install 22\n      - name: Install dependencies\n        run: npm ci\n      - name: Build app\n        run: npm run build\n      - name: Unit tests\n        run: npm test\n      - name: Lint\n        run: npm run lint\n`,
  });
  assert.deepEqual(steps.map(({ step, cmd }) => [step, cmd]), [
    ['Build app', 'npm run build'],
    ['Unit tests', 'npm test'],
    ['Lint', 'npm run lint'],
  ]);
});

test('main-push fallback keeps guarded checks and filters publish/deploy commands', () => {
  const steps = replay({
    'ci.yml': `on:\n  push:\n    branches: [main]\njobs:\n  checks:\n    if: github.event_name == 'push'\n    steps:\n      - name: Main branch validation\n        if: github.ref == 'refs/heads/main'\n        run: npm run build\n      - name: Publish package\n        run: npm publish\n      - name: Deploy production\n        run: vercel deploy --prod\n      - name: Release\n        run: gh release create v1\n      - name: Unsafe install\n        run: curl https://example.test/install.sh | sh\n`,
  });
  assert.deepEqual(steps.map(({ step, cmd }) => [step, cmd]), [['Main branch validation', 'npm run build']]);
});

test('branch exclusions are evaluated per candidate and tag-only workflows are not main fallbacks', () => {
  const steps = replay({
    'main.yml': `on:\n  push:\n    branches-ignore: [master]\njobs:\n  checks:\n    steps:\n      - name: Main check\n        run: npm run check\n`,
    'release.yml': `on:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    steps:\n      - name: Tag release\n        run: npm run release\n`,
  });
  assert.deepEqual(steps.map(({ step, cmd }) => [step, cmd]), [['Main check', 'npm run check']]);
});

test('negated branch patterns exclude main and master in order', () => {
  assert.deepEqual(replay({
    'feature-only.yml': `on:\n  push:\n    branches: ['**', '!main', '!master']\njobs:\n  checks:\n    steps:\n      - name: Feature check\n        run: npm run feature-check\n`,
  }), []);
  assert.deepEqual(replay({
    'main-only.yml': `on:\n  push:\n    branches: ['**', '!master']\njobs:\n  checks:\n    steps:\n      - name: Main check\n        run: npm run main-check\n`,
  }).map(({ step, cmd }) => [step, cmd]), [['Main check', 'npm run main-check']]);
});

test('no pull-request or main-triggered push workflow produces no replay steps', () => {
  assert.deepEqual(replay({
    'feature.yml': `on:\n  push:\n    branches: [feature]\njobs:\n  checks:\n    steps:\n      - name: Check\n        run: npm run check\n`,
  }), []);
});
