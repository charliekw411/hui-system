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
const {
  formatMeetingDate,
  isMeetingDocumentType,
  MAX_MEETING_DOCUMENT_BYTES,
  MEETING_DOCUMENT_ACCEPT,
  meetingDocumentMimeType,
  sortMeetings,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('meetings are sorted newest first without mutating the source', () => {
  const meetings = [
    { id: 'july', title: 'July 2026 Hui', meetingDate: '2026-07-20' },
    { id: 'september', title: 'September 2026 Hui', meetingDate: '2026-09-15' },
    { id: 'august', title: 'August 2026 Hui', meetingDate: '2026-08-18' },
  ];
  assert.deepEqual(sortMeetings(meetings).map(({ title, meetingDate }) => [title, formatMeetingDate(meetingDate)]), [
    ['September 2026 Hui', '15 September 2026'],
    ['August 2026 Hui', '18 August 2026'],
    ['July 2026 Hui', '20 July 2026'],
  ]);
  assert.deepEqual(sortMeetings([]), []);
  assert.equal(meetings[0].id, 'july');
});

test('meeting document types and supported file extensions are explicit', () => {
  assert.equal(isMeetingDocumentType('minutes'), true);
  assert.equal(isMeetingDocumentType('notes'), true);
  assert.equal(isMeetingDocumentType('agenda'), false);
  assert.equal(meetingDocumentMimeType('Approved Minutes.PDF'), 'application/pdf');
  assert.equal(
    meetingDocumentMimeType('Meeting notes.docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.equal(meetingDocumentMimeType('unsafe.html'), null);
  assert.match(MEETING_DOCUMENT_ACCEPT, /\.pdf/);
  assert.equal(MAX_MEETING_DOCUMENT_BYTES, 100_000_000);
});
