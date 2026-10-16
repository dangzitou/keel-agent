import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalUi } from '../src/ui/render.js';

type InterruptCase = {
  name: string;
  marker: string;
  interrupt: (ui: TerminalUi) => void;
};

const cases: InterruptCase[] = [
  { name: 'note', marker: 'note-marker', interrupt: (ui) => ui.note('note-marker') },
  { name: 'warning', marker: 'warn-marker', interrupt: (ui) => ui.warn('warn-marker') },
  { name: 'error', marker: 'error-marker', interrupt: (ui) => ui.error('error-marker') },
  { name: 'policy denial', marker: 'denied-marker', interrupt: (ui) => ui.policyDenied('denied-marker', 'denyPaths') },
  {
    name: 'tool start',
    marker: 'tool-marker',
    interrupt: (ui) => ui.toolStart('bash', { command: 'tool-marker' }),
  },
];

function captureOutput(run: (ui: TerminalUi) => void): string {
  const chunks: string[] = [];
  const originalLog = console.log;
  console.log = ((...args: unknown[]) => {
    chunks.push(args.map(String).join(' ') + '\n');
  }) as typeof console.log;
  try {
    run(new TerminalUi((text) => chunks.push(text)));
  } finally {
    console.log = originalLog;
  }
  return chunks.join('');
}


test('TerminalUi clears interrupted stream state before the next response', () => {
  const output = captureOutput((ui) => {
    ui.assistantDelta('partial response');
    ui.error('interrupted');
    ui.spinStart('next request');
    ui.assistantText('next response');
  });

  assert.ok(output.includes('next response' + String.fromCharCode(10)), JSON.stringify(output));
});

for (const { name, marker, interrupt } of cases) {
  test('TerminalUi separates streamed text from ' + name, () => {
    const output = captureOutput((ui) => {
      ui.assistantDelta('partial response');
      interrupt(ui);
      ui.assistantText('partial response');
    });

    assert.ok(output.includes('partial response\n'), JSON.stringify(output));
    assert.ok(output.indexOf(marker) > output.indexOf('partial response'), JSON.stringify(output));
    assert.equal((output.match(/partial response/g) ?? []).length, 1, JSON.stringify(output));
    assert.equal(output.endsWith('\n\n'), false, JSON.stringify(output));
  });
}
