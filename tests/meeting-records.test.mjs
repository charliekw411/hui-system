import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/lib/meeting-records.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  write: false,
});
const { getMeetingRecords, sortMeetings, formatMeetingDate } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('mock meetings are newest first with the requested dates and documents', async () => {
  const { meetings, documents } = await getMeetingRecords();
  assert.deepEqual(meetings.map(({ title, meetingDate }) => [title, formatMeetingDate(meetingDate)]), [
    ['September 2026 Hui', '15 September 2026'],
    ['August 2026 Hui', '18 August 2026'],
    ['July 2026 Hui', '20 July 2026'],
  ]);
  assert.equal(new Set(documents.map(({ id }) => id)).size, 6);
  for (const meeting of meetings) {
    assert.deepEqual(
      documents.filter(({ meetingId }) => meetingId === meeting.id)
        .map(({ documentType, fileName, fileUrl }) => [documentType, fileName, fileUrl]),
      [['minutes', 'Approved Minutes.pdf', ''], ['notes', 'Meeting Notes.pdf', '']],
    );
  }
});

test('sorting handles empty records and does not mutate its input', () => {
  assert.deepEqual(sortMeetings([]), []);
  const input = [{ meetingDate: '2026-07-20' }, { meetingDate: '2026-09-15' }];
  assert.equal(sortMeetings(input)[0].meetingDate, '2026-09-15');
  assert.equal(input[0].meetingDate, '2026-07-20');
});

test('mock records are isolated between requests', async () => {
  const first = await getMeetingRecords();
  first.meetings[0].title = 'Changed';
  first.documents[0].fileName = 'Changed';
  const second = await getMeetingRecords();
  assert.equal(second.meetings[0].title, 'September 2026 Hui');
  assert.equal(second.documents[0].fileName, 'Approved Minutes.pdf');
});
