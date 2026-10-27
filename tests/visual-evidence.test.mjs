import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../skills/inc-commit-push-pr/scripts/visual-evidence.mjs', import.meta.url).pathname;
const run = (mode, args = [], input = '') => spawnSync(process.execPath, [script, mode, ...args], { input, encoding: 'utf8' });

test('UI changes require visual evidence even when mixed with tests or docs', () => {
  const result = run('classify', [], 'docs/usage.md\napps/web/components/Checkout.tsx\ntests/checkout.test.mjs\n');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^visual:/);
  assert.match(result.stdout, /Checkout.tsx/);
});

test('only allowlisted non-visual paths can skip, unknown paths cannot', () => {
  assert.match(run('classify', [], '.github/workflows/ci.yml\nscripts/build.sh\nREADME.md\ntests/fixtures/screen.png\ndocs/screenshots/example.png\nsrc/components/Button.test.tsx\n').stdout, /^non-visual:/);
  assert.match(run('classify', [], 'src/feature.ts\n').stdout, /^visual:/);
  assert.match(run('classify', [], 'src/app/docs/page.tsx\n').stdout, /^visual:/);
  assert.match(run('classify', [], 'app/api/route.ts\n').stdout, /^non-visual:/);
  assert.equal(run('classify').status, 1);
  assert.equal(run('verify', ['--classification', 'visual', '--evidence', 'skip:non-visual']).status, 1);
  assert.equal(run('verify', ['--classification', 'non-visual', '--evidence', 'skip:non-visual']).status, 0);
});

test('blocked visual skip requires a named blocker, fixture fallback and PR disclosure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  try {
    const body = join(dir, 'body.md');
    const base = ['--classification', 'visual', '--evidence', 'skip:blocked:preview auth unavailable', '--body-file', body];
    writeFileSync(body, '### Evidence blocked\npreview auth unavailable; fixture fallback also failed.\n');
    assert.equal(run('verify', base).status, 1);
    assert.equal(run('verify', [...base, '--fixture-attempted']).status, 0);
    writeFileSync(body, '### Evidence blocked\npreview auth unavailable.\n');
    assert.equal(run('verify', [...base, '--fixture-attempted']).status, 1);
    assert.equal(run('verify', ['--classification', 'visual', '--evidence', 'skip:blocked:', '--fixture-attempted', '--body-file', body]).status, 1);
    writeFileSync(body, '### Evidence blocked\ngh attachment unavailable: CLI is too old.\n');
    const attachmentArgs = ['--classification', 'visual', '--evidence', 'skip:blocked:gh attachment unavailable', '--body-file', body];
    assert.equal(run('verify', [...attachmentArgs, '--attachment-blocked']).status, 0);
    assert.equal(run('verify', [...attachmentArgs, '--fixture-attempted']).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshots count only new GitHub attachments under Screenshots, not tests, links or old images', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  try {
    const before = join(dir, 'before.md');
    const body = join(dir, 'body.md');
    writeFileSync(before, '## Screenshots\n![old](https://github.com/user-attachments/assets/old)\n');
    const args = ['--classification', 'visual', '--evidence', 'screenshots', '--body-file', body, '--before-body-file', before, '--expected-count', '1'];
    writeFileSync(body, '## Screenshots\n![old](https://github.com/user-attachments/assets/old)\n## Tests\n![new](https://github.com/user-attachments/assets/new)\n');
    assert.equal(run('verify', args).status, 1);
    writeFileSync(body, '## Screenshots\n![old](https://github.com/user-attachments/assets/old)\n![new](./new.png)\n');
    assert.equal(run('verify', args).status, 1);
    writeFileSync(body, '## Screenshots\n![old](https://github.com/user-attachments/assets/old)\n## Screenshots\n![new](https://github.com/user-attachments/assets/new)\n');
    const result = run('verify', args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /evidence=screenshots/);
    writeFileSync(body, '## Screenshots\n![the \\[Save\\] button](https://github.com/user-attachments/assets/new)\n');
    assert.equal(run('verify', args).status, 0);
    writeFileSync(body, '<details>\n## Screenshots\n![new](https://github.com/user-attachments/assets/new)\n</details>\n');
    assert.equal(run('verify', args).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('demo uses its own section and rejects unsupported evidence tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  try {
    const body = join(dir, 'body.md');
    writeFileSync(body, '## Demo\n![flow](https://github.com/user-attachments/assets/flow)\n');
    assert.equal(run('verify', ['--classification', 'visual', '--evidence', 'demo', '--body-file', body, '--expected-count', '1']).status, 0);
    assert.equal(run('verify', ['--classification', 'visual', '--evidence', 'skip']).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
