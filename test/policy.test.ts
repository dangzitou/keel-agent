import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import { checkPolicy } from '../src/policy/policy.js';

const cwd = '/tmp/keel-policy-fixture';

function policy(overrides: Partial<ReturnType<typeof defaultConfig>['policy']> = {}) {
  return { ...defaultConfig().policy, ...overrides };
}

test('策略: denyPaths 拦截读写密钥文件', () => {
  const p = policy();
  assert.equal(checkPolicy(p, { tool: 'write', input: { path: '.env' }, cwd }).decision, 'deny');
  assert.equal(checkPolicy(p, { tool: 'read', input: { path: 'config/.env.local' }, cwd }).decision, 'deny');
  assert.equal(checkPolicy(p, { tool: 'write', input: { path: 'server.pem' }, cwd }).decision, 'deny');
  assert.equal(checkPolicy(p, { tool: 'write', input: { path: 'src/index.ts' }, cwd }).decision, 'allow');
});

test('策略: bashDeny 直接拒绝、bashApprove 需要人工', () => {
  const p = policy();
  assert.equal(checkPolicy(p, { tool: 'bash', input: { command: 'sudo rm thing' }, cwd }).decision, 'deny');
  assert.equal(checkPolicy(p, { tool: 'bash', input: { command: 'git push origin main' }, cwd }).decision, 'approve');
  assert.equal(checkPolicy(p, { tool: 'bash', input: { command: 'npm test' }, cwd }).decision, 'allow');
});

test('策略: 只读模式拦截一切写路径', () => {
  const p = policy({ readOnly: true });
  assert.equal(checkPolicy(p, { tool: 'write', input: { path: 'a.txt' }, cwd }).decision, 'deny');
  assert.equal(checkPolicy(p, { tool: 'bash', input: { command: 'ls' }, cwd }).decision, 'deny');
  assert.equal(checkPolicy(p, { tool: 'read', input: { path: 'a.txt' }, cwd }).decision, 'allow');
});
