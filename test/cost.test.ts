import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFor, hasKnownPrice } from '../src/llm/cost.js';

test('step-5-preview has its built-in USD price for bare and provider-prefixed model ids', () => {
  assert.equal(hasKnownPrice('step-5-preview'), true);
  assert.equal(hasKnownPrice('stepfun/step-5-preview'), true);
  assert.equal(costFor('step-5-preview', 1_000_000, 0), 1);
  assert.equal(costFor('step-5-preview', 0, 1_000_000), 2.7);
  assert.equal(costFor('stepfun/step-5-preview', 1_000_000, 1_000_000), 3.7);
});
