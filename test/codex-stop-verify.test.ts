import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const source = resolve(import.meta.dir, '..');
const gate = join(source, 'bin/gstack-verify-gate');
const hook = join(source, 'hosts/codex/hooks/stop-verify');
let project: string;
let home: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'gstack-codex-project-'));
  home = mkdtempSync(join(tmpdir(), 'gstack-codex-home-'));
  expect(spawnSync('git', ['init', '--quiet', project]).status).toBe(0);
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function declareCheck(command = './check.sh') {
  writeFileSync(join(project, 'AGENTS.md'), `# Fixture\n\n<!-- gstack:verify: ${command} -->\n`);
}

function check(body = 'echo check failed; exit 1') {
  const file = join(project, 'check.sh');
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function trust() {
  return spawnSync(gate, ['--codex', '--trust'], {
    cwd: project, env: { ...process.env, GSTACK_HOME: home }, encoding: 'utf8', timeout: 5000,
  });
}

function stop(active = false, session = 'session-1', extraEnv: Record<string, string> = {}) {
  const result = spawnSync(hook, {
    cwd: project,
    env: { ...process.env, GSTACK_HOME: home, ...extraEnv },
    input: JSON.stringify({ hook_event_name: 'Stop', cwd: project, session_id: session, turn_id: 'turn-1', stop_hook_active: active }),
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function logs(): string[] {
  const root = join(home, 'verify-gate-codex');
  return existsSync(root) ? readdirSync(root).flatMap(key => readdirSync(join(root, key)).filter(name => name.endsWith('.log')).map(name => join(root, key, name))) : [];
}

describe('Codex Stop adapter using the existing gate', () => {
  test('a user-declared, trusted passing command allows Stop and keeps a result log', () => {
    declareCheck(); check('echo check passed; exit 0');
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    const trusted = trust(); expect(trusted.status, trusted.stderr).toBe(0);
    expect(stop()).toEqual({});
    expect(logs()).toHaveLength(1);
    expect(readFileSync(logs()[0], 'utf8')).toContain('check passed');
  });

  test('failure continues the turn; after the user fixes the command it passes', () => {
    declareCheck(); check();
    expect(trust().status).toBe(0);
    const failed = stop();
    expect(failed.decision).toBe('block');
    expect(failed.reason).toContain('check failed');
    expect(failed.reason).toContain('Full log:');
    check('echo fixed; exit 0');
    expect(stop(true)).toEqual({});
    expect(logs()).toHaveLength(2);
  });

  test('a previous pass is not reused after project code changes', () => {
    declareCheck(); check('echo first pass; exit 0');
    expect(trust().status).toBe(0);
    expect(stop()).toEqual({});
    check('echo changed failure; exit 1');
    expect(stop(false).reason).toContain('changed failure');
  });

  test('persistent failure stops automatic continuation after three attempts and reports RED', () => {
    declareCheck(); check();
    expect(trust().status).toBe(0);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = stop(attempt > 1);
      expect(response.decision).toBe('block');
      expect(response.reason).toContain(`(${attempt}/3)`);
    }
    const final = stop(true);
    expect(final.decision).toBeUndefined();
    expect(final.systemMessage).toContain('RED after 3 continuations');
    expect(logs()).toHaveLength(4);
    expect(stop(false).decision).toBe('block'); // new user turn
  });

  test('missing configuration never counts as a pass', () => {
    expect(stop().decision).toBe('block');
    declareCheck('');
    expect(stop().decision).toBe('block');
  });

  test('untrusted or edited commands do not execute', () => {
    declareCheck('touch sentinel');
    expect(stop().decision).toBe('block');
    expect(existsSync(join(project, 'sentinel'))).toBe(false);
    expect(trust().status).toBe(0);
    declareCheck('touch changed-sentinel');
    expect(stop().decision).toBe('block');
    expect(existsSync(join(project, 'changed-sentinel'))).toBe(false);
  });

  test('sessions have separate retry episodes', () => {
    declareCheck(); check();
    expect(trust().status).toBe(0);
    expect(stop(false, 'first').reason).toContain('(1/3)');
    expect(stop(true, 'first').reason).toContain('(2/3)');
    expect(stop(false, 'second').reason).toContain('(1/3)');
  });

  test('a non-Git directory cannot loop forever or run the declared command', () => {
    declareCheck('touch sentinel');
    rmSync(join(project, '.git'), { recursive: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(stop(attempt > 1).decision).toBe('block');
    }
    expect(stop(true).systemMessage).toContain('RED after 3 continuations');
    expect(existsSync(join(project, 'sentinel'))).toBe(false);
  });

  test('a timed-out check is blocked and logged', () => {
    declareCheck(); check('sleep 1; exit 0');
    expect(trust().status).toBe(0);
    const response = stop(false, 'timeout', { GSTACK_VERIFY_TIMEOUT_MS: '50' });
    expect(response.decision).toBe('block');
    expect(readFileSync(logs()[0], 'utf8')).toContain('ETIMEDOUT');
  });
});
