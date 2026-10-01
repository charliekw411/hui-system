import {
  type MeetingDocument,
  type MeetingDocumentType,
} from '../src/lib/meeting-records';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const ROOT_FOLDER_NAME = 'Pehiāweri B1B Meeting Records';
const APP_PROPERTY_KEY = 'huiSystemKind';
const ROOT_PROPERTY_VALUE = 'meetingRecordsRoot';
const MEETING_FOLDER_PROPERTY_VALUE = 'meetingFolder';
const DOCUMENT_PROPERTY_VALUE = 'meetingDocument';

export interface GoogleDriveEnv {
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_REFRESH_TOKEN?: string;
}

interface GoogleDriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

interface DriveFileList {
  files?: DriveFile[];
  nextPageToken?: string;
}

interface UploadInput {
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  documentType: MeetingDocumentType;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
}

interface CachedAccessToken {
  clientId: string;
  refreshToken: string;
  value: string;
  expiresAt: number;
}

let cachedAccessToken: CachedAccessToken | undefined;

export class GoogleDriveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GoogleDriveError';
  }
}

export function isGoogleDriveConfigured(env: GoogleDriveEnv): boolean {
  return Boolean(
    env.GOOGLE_DRIVE_CLIENT_ID?.trim()
    && env.GOOGLE_DRIVE_CLIENT_SECRET?.trim()
    && env.GOOGLE_DRIVE_REFRESH_TOKEN?.trim(),
  );
}

function requireGoogleDriveConfig(env: GoogleDriveEnv): GoogleDriveConfig {
  if (!isGoogleDriveConfigured(env)) {
    throw new GoogleDriveError('Google Drive storage is not configured.', 503);
  }
  return {
    clientId: env.GOOGLE_DRIVE_CLIENT_ID!.trim(),
    clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET!.trim(),
    refreshToken: env.GOOGLE_DRIVE_REFRESH_TOKEN!.trim(),
  };
}

async function getAccessToken(env: GoogleDriveEnv, forceRefresh = false): Promise<string> {
  const config = requireGoogleDriveConfig(env);
  const now = Date.now();
  if (
    !forceRefresh
    && cachedAccessToken?.clientId === config.clientId
    && cachedAccessToken.refreshToken === config.refreshToken
    && cachedAccessToken.expiresAt > now + 30_000
  ) {
    return cachedAccessToken.value;
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    console.error('Google Drive token refresh failed', response.status);
    throw new GoogleDriveError(
      'Google Drive authorization failed. Reconnect the storage account.',
      503,
    );
  }

  const body: unknown = await response.json();
  if (
    typeof body !== 'object'
    || body === null
    || !('access_token' in body)
    || typeof body.access_token !== 'string'
  ) {
    console.error('Google Drive token response was invalid');
    throw new GoogleDriveError('Google Drive returned an invalid authorization response.', 502);
  }

  const expiresIn = 'expires_in' in body && typeof body.expires_in === 'number'
    ? body.expires_in
    : 3600;
  cachedAccessToken = {
    clientId: config.clientId,
    refreshToken: config.refreshToken,
    value: body.access_token,
    expiresAt: now + Math.max(60, expiresIn) * 1000,
  };
  return body.access_token;
}

async function googleFetch(
  env: GoogleDriveEnv,
  input: string,
  init: RequestInit = {},
  retryAuthorization = true,
): Promise<Response> {
  const token = await getAccessToken(env);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });

  if (response.status === 401 && retryAuthorization) {
    const refreshedToken = await getAccessToken(env, true);
    headers.set('Authorization', `Bearer ${refreshedToken}`);
    return fetch(input, { ...init, headers });
  }
  return response;
}

async function throwGoogleError(response: Response, action: string): Promise<never> {
  console.error(`Google Drive ${action} failed`, response.status);
  if (response.status === 404) {
    throw new GoogleDriveError('Meeting document not found.', 404);
  }
  throw new GoogleDriveError(`Google Drive could not ${action}.`, 502);
}

async function driveJson<T>(
  env: GoogleDriveEnv,
  input: string,
  init: RequestInit = {},
  action = 'complete the request',
): Promise<T> {
  const response = await googleFetch(env, input, init);
  if (!response.ok) await throwGoogleError(response, action);
  try {
    return await response.json() as T;
  } catch {
    console.error(`Google Drive ${action} returned invalid JSON`);
    throw new GoogleDriveError('Google Drive returned an invalid response.', 502);
  }
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function driveFilesUrl(query: string, fields: string, pageToken?: string): string {
  const params = new URLSearchParams({
    q: query,
    spaces: 'drive',
    pageSize: '1000',
    orderBy: 'createdTime',
    fields,
  });
  if (pageToken) params.set('pageToken', pageToken);
  return `${DRIVE_API_BASE}/files?${params}`;
}

async function findFolders(
  env: GoogleDriveEnv,
  propertyValue: string,
  meetingId?: string,
  parentId?: string,
): Promise<DriveFile[]> {
  const clauses = [
    `mimeType='${FOLDER_MIME_TYPE}'`,
    'trashed=false',
    `appProperties has { key='${APP_PROPERTY_KEY}' and value='${propertyValue}' }`,
  ];
  if (meetingId) {
    clauses.push(
      `appProperties has { key='huiId' and value='${escapeDriveQueryValue(meetingId)}' }`,
    );
  }
  if (parentId) clauses.push(`'${escapeDriveQueryValue(parentId)}' in parents`);

  const result = await driveJson<DriveFileList>(
    env,
    driveFilesUrl(clauses.join(' and '), 'files(id,name,createdTime)'),
    {},
    'find its meeting folder',
  );
  return result.files ?? [];
}

async function createFolder(
  env: GoogleDriveEnv,
  name: string,
  appProperties: Record<string, string>,
  parentId?: string,
): Promise<DriveFile> {
  const result = await driveJson<DriveFile>(
    env,
    `${DRIVE_API_BASE}/files?fields=id,name`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME_TYPE,
        appProperties,
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    },
    'create its meeting folder',
  );
  if (!result.id) {
    console.error('Google Drive folder creation returned no id');
    throw new GoogleDriveError('Google Drive returned an invalid folder response.', 502);
  }
  return result;
}

async function ensureRootFolder(env: GoogleDriveEnv): Promise<string> {
  const existing = await findFolders(env, ROOT_PROPERTY_VALUE);
  if (existing.length > 1) {
    console.warn('Multiple Google Drive meeting-record roots found; using the oldest result');
  }
  if (existing[0]?.id) return existing[0].id;

  const created = await createFolder(env, ROOT_FOLDER_NAME, {
    [APP_PROPERTY_KEY]: ROOT_PROPERTY_VALUE,
  });
  return created.id!;
}

function meetingFolderName(title: string, meetingDate: string): string {
  const cleanTitle = title
    .replace(/[\u0000-\u001f/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${meetingDate} - ${cleanTitle || 'Hui'}`.slice(0, 200);
}

async function ensureMeetingFolder(
  env: GoogleDriveEnv,
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
): Promise<string> {
  const rootId = await ensureRootFolder(env);
  const expectedName = meetingFolderName(meetingTitle, meetingDate);
  const existing = await findFolders(env, MEETING_FOLDER_PROPERTY_VALUE, meetingId, rootId);
  if (existing.length > 1) {
    console.warn('Multiple Google Drive folders found for hui', meetingId);
  }
  const folder = existing[0];
  if (!folder?.id) {
    const created = await createFolder(
      env,
      expectedName,
      { [APP_PROPERTY_KEY]: MEETING_FOLDER_PROPERTY_VALUE, huiId: meetingId },
      rootId,
    );
    return created.id!;
  }

  if (folder.name !== expectedName) {
    await driveJson<DriveFile>(
      env,
      `${DRIVE_API_BASE}/files/${encodeURIComponent(folder.id)}?fields=id,name`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: expectedName }),
      },
      'update its meeting folder',
    );
  }
  return folder.id;
}

function mapMeetingDocument(file: DriveFile): MeetingDocument | null {
  const meetingId = file.appProperties?.huiId;
  const documentType = file.appProperties?.documentType;
  const sizeBytes = Number(file.size);
  if (
    !file.id
    || !file.name
    || !meetingId
    || (documentType !== 'minutes' && documentType !== 'notes')
    || !file.mimeType
    || !file.createdTime
    || !Number.isSafeInteger(sizeBytes)
    || sizeBytes < 0
  ) {
    console.warn('Ignoring invalid Google Drive meeting document metadata', file.id ?? 'unknown');
    return null;
  }
  return {
    id: file.id,
    meetingId,
    documentType,
    fileName: file.name,
    fileUrl: `/meeting-records/${encodeURIComponent(file.id)}/content`,
    mimeType: file.mimeType,
    sizeBytes,
    createdAt: file.createdTime,
  };
}

export async function listMeetingDocuments(env: GoogleDriveEnv): Promise<MeetingDocument[]> {
  const query = [
    'trashed=false',
    `appProperties has { key='${APP_PROPERTY_KEY}' and value='${DOCUMENT_PROPERTY_VALUE}' }`,
  ].join(' and ');
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const result = await driveJson<DriveFileList>(
      env,
      driveFilesUrl(
        query,
        'nextPageToken,files(id,name,mimeType,size,createdTime,appProperties)',
        pageToken,
      ),
      {},
      'list meeting documents',
    );
    files.push(...(result.files ?? []));
    pageToken = result.nextPageToken;
  } while (pageToken);

  return files
    .map(mapMeetingDocument)
    .filter((document): document is MeetingDocument => document !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function uploadMeetingDocument(
  env: GoogleDriveEnv,
  input: UploadInput,
  body: ReadableStream<Uint8Array>,
): Promise<MeetingDocument> {
  const folderId = await ensureMeetingFolder(
    env,
    input.meetingId,
    input.meetingTitle,
    input.meetingDate,
  );
  const metadata = {
    name: input.fileName,
    parents: [folderId],
    appProperties: {
      [APP_PROPERTY_KEY]: DOCUMENT_PROPERTY_VALUE,
      huiId: input.meetingId,
      documentType: input.documentType,
      uploadedBy: input.uploadedBy,
    },
  };
  const sessionResponse = await googleFetch(
    env,
    `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,mimeType,size,createdTime,appProperties`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': input.mimeType,
        'X-Upload-Content-Length': String(input.sizeBytes),
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!sessionResponse.ok) await throwGoogleError(sessionResponse, 'start the document upload');

  const sessionUrl = sessionResponse.headers.get('Location');
  if (!sessionUrl) {
    console.error('Google Drive resumable upload response had no Location header');
    throw new GoogleDriveError('Google Drive returned an invalid upload response.', 502);
  }

  const uploadResponse = await googleFetch(
    env,
    sessionUrl,
    {
      method: 'PUT',
      headers: {
        'Content-Type': input.mimeType,
        'Content-Length': String(input.sizeBytes),
      },
      body,
    },
    false,
  );
  if (!uploadResponse.ok) await throwGoogleError(uploadResponse, 'upload the meeting document');

  let uploaded: DriveFile;
  try {
    uploaded = await uploadResponse.json() as DriveFile;
  } catch {
    console.error('Google Drive upload returned invalid JSON');
    throw new GoogleDriveError('Google Drive returned an invalid upload response.', 502);
  }
  const document = mapMeetingDocument(uploaded);
  if (!document) {
    throw new GoogleDriveError('Google Drive returned incomplete file metadata.', 502);
  }
  return document;
}

function isSystemMeetingDocument(file: DriveFile): boolean {
  return file.appProperties?.[APP_PROPERTY_KEY] === DOCUMENT_PROPERTY_VALUE
    && Boolean(mapMeetingDocument(file));
}

export async function getMeetingDocumentContent(
  env: GoogleDriveEnv,
  fileId: string,
): Promise<{ document: MeetingDocument; response: Response }> {
  const fields = 'id,name,mimeType,size,createdTime,trashed,appProperties';
  const metadata = await driveJson<DriveFile>(
    env,
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=${fields}`,
    {},
    'find the meeting document',
  );
  if (metadata.trashed || !isSystemMeetingDocument(metadata)) {
    throw new GoogleDriveError('Meeting document not found.', 404);
  }
  const document = mapMeetingDocument(metadata)!;
  const response = await googleFetch(
    env,
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    {},
  );
  if (!response.ok) await throwGoogleError(response, 'download the meeting document');
  return { document, response };
}

export async function trashMeetingFolders(
  env: GoogleDriveEnv,
  meetingId: string,
): Promise<void> {
  const folders = await findFolders(env, MEETING_FOLDER_PROPERTY_VALUE, meetingId);
  for (const folder of folders) {
    if (!folder.id) continue;
    await driveJson<DriveFile>(
      env,
      `${DRIVE_API_BASE}/files/${encodeURIComponent(folder.id)}?fields=id,trashed`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      },
      'move a deleted hui folder to the bin',
    );
  }
}
