import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/lib/hui-timing.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  write: false,
});
const { getHuiArchiveCutoff } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('hui remains featured through six hours after its New Zealand start time', () => {
  const scheduledAt = '2026-11-13T19:56:00.000Z'; // 14 November, 8:56 am NZDT.
  const start = Date.parse(scheduledAt);
  for (const elapsed of [-1, 4 * 60 * 1000, 6 * 60 * 60 * 1000]) {
    assert.ok(scheduledAt >= getHuiArchiveCutoff(start + elapsed));
  }
  assert.ok(scheduledAt < getHuiArchiveCutoff(start + 6 * 60 * 60 * 1000 + 1));
});

test('the six-hour window measures elapsed time across New Zealand daylight saving', () => {
  assert.equal(
    getHuiArchiveCutoff(Date.parse('2026-09-27T06:00:00+13:00')),
    new Date('2026-09-26T23:00:00+12:00').toISOString(),
  );
});
