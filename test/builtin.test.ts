import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bashTool } from '../src/tools/builtin.js';
import type { ToolCtx } from '../src/tools/types.js';

const toolContext = { cwd: process.cwd() } as unknown as ToolCtx;

for (const streamName of ['stdout', 'stderr'] as const) {
  test('bash preserves UTF-8 split across ' + streamName + ' chunks', async () => {
    const nodeCode = [
      'const stream = process[' + JSON.stringify(streamName) + '];',
      'const bytes = Buffer.from([0xe9, 0xbe, 0x99]);',
      'stream.write(Buffer.concat([Buffer.alloc(70_000, 0x61), bytes.subarray(0, 2)]), () => {',
      '  setTimeout(() => stream.write(bytes.subarray(2)), 50);',
      '});',
    ].join('');

    const result = await bashTool.run({ command: "node -e '" + nodeCode + "'" }, toolContext);

    assert.equal(result.ok, true);
    assert.equal(result.output.includes('\uFFFD'), false, result.output.slice(-100));
    assert.ok(result.output.endsWith('\u9f99\n[exit 0]'), result.output.slice(-100));
  });
}
