import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Router } from '../src/llm/router.js';

const envKeys = ['KEEL_HOME', 'KEEL_MODEL', 'KEEL_FAST_MODEL', 'KEEL_BASE_URL', 'KEEL_API_KEY', 'KEEL_API', 'KEEL_MOCK'];

async function withKeelEnv(overrides: Record<string, string>, run: (cwd: string) => Promise<void> | void): Promise<void> {
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-provider-config-'));
  try {
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, overrides, { KEEL_HOME: home });
    await run(home);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a misspelled provider is rejected even when a generic API key exists', async () => {
  await withKeelEnv(
    {
      KEEL_MODEL: 'typo-provider/nope-model',
      KEEL_API_KEY: 'existing-key',
      KEEL_MOCK: '1',
    },
    async (cwd) => {
      const cfg = loadConfig(cwd).cfg;
      await assert.rejects(
        () => new Router(cfg).chat('main', [{ role: 'user', content: 'hi' }]),
        /provider "typo-provider"/,
      );
    },
  );
});

test('a bare model still uses the explicit custom endpoint configuration', async () => {
  await withKeelEnv(
    {
      KEEL_MODEL: 'custom-model',
      KEEL_BASE_URL: 'https://gateway.example/v1',
      KEEL_API_KEY: 'existing-key',
      KEEL_MOCK: '1',
    },
    (cwd) => {
      const cfg = loadConfig(cwd).cfg;
      assert.equal(cfg.router.main, 'env/custom-model');
      assert.equal(cfg.providers.env?.baseURL, 'https://gateway.example/v1');
      assert.equal(cfg.providers.env?.apiKeyEnv, 'KEEL_API_KEY');
    },
  );
});
