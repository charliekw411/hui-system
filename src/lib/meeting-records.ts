export interface Meeting {
  id: string;
  title: string;
  meetingDate: string;
}

export interface MeetingDocument {
  id: string;
  meetingId: string;
  documentType: 'minutes' | 'notes';
  fileName: string;
  fileUrl: string;
}

export interface MeetingRecords {
  meetings: Meeting[];
  documents: MeetingDocument[];
}

const mockMeetings: Meeting[] = [
  { id: 'hui-july-2026', title: 'July 2026 Hui', meetingDate: '2026-07-20' },
  { id: 'hui-september-2026', title: 'September 2026 Hui', meetingDate: '2026-09-15' },
  { id: 'hui-august-2026', title: 'August 2026 Hui', meetingDate: '2026-08-18' },
];

const mockDocuments: MeetingDocument[] = mockMeetings.flatMap((meeting) =>
  (['minutes', 'notes'] as const).map((documentType) => ({
    id: `${meeting.id}-${documentType}`,
    meetingId: meeting.id,
    documentType,
    fileName: documentType === 'minutes' ? 'Approved Minutes.pdf' : 'Meeting Notes.pdf',
    // Mock documents have no downloadable URL. A future storage provider will supply it.
    fileUrl: '',
  })),
);

export function sortMeetings(meetings: Meeting[]): Meeting[] {
  return [...meetings].sort((a, b) => b.meetingDate.localeCompare(a.meetingDate));
}

export function formatMeetingDate(meetingDate: string): string {
  return new Intl.DateTimeFormat('en-NZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${meetingDate}T00:00:00Z`));
}

export async function getMeetingRecords(): Promise<MeetingRecords> {
  // Replace this local source with a storage provider later, keeping the UI's data contract.
  return {
    meetings: sortMeetings(mockMeetings).map((meeting) => ({ ...meeting })),
    documents: mockDocuments.map((document) => ({ ...document })),
  };
}
