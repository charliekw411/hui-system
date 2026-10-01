export interface Meeting {
  id: string;
  title: string;
  meetingDate: string;
}

export const MEETING_DOCUMENT_TYPES = ['minutes', 'notes'] as const;
export type MeetingDocumentType = (typeof MEETING_DOCUMENT_TYPES)[number];

export const MAX_MEETING_DOCUMENT_BYTES = 100_000_000;
export const MEETING_DOCUMENT_ACCEPT = '.pdf,.doc,.docx,.odt,.rtf,.txt,.jpg,.jpeg,.png';

const MEETING_DOCUMENT_MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export interface MeetingDocument {
  id: string;
  meetingId: string;
  documentType: MeetingDocumentType;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface MeetingRecords {
  meetings: Meeting[];
  documents: MeetingDocument[];
}

export function sortMeetings(meetings: Meeting[]): Meeting[] {
  return [...meetings].sort((a, b) => b.meetingDate.localeCompare(a.meetingDate));
}

export function isMeetingDocumentType(value: unknown): value is MeetingDocumentType {
  return typeof value === 'string'
    && MEETING_DOCUMENT_TYPES.includes(value as MeetingDocumentType);
}

export function meetingDocumentMimeType(fileName: string): string | null {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return MEETING_DOCUMENT_MIME_TYPES[extension] ?? null;
}

export function formatMeetingDate(meetingDate: string): string {
  return new Intl.DateTimeFormat('en-NZ', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${meetingDate}T00:00:00Z`));
}
