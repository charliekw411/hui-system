import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { breakGlassAccess, isPortalUser, type PortalUser } from '../src/lib/auth-policy';
import {
  isMeetingDocumentType,
  MAX_MEETING_DOCUMENT_BYTES,
  meetingDocumentMimeType,
  type Meeting,
} from '../src/lib/meeting-records';
import {
  getMeetingDocumentContent,
  GoogleDriveError,
  isGoogleDriveConfigured,
  listMeetingDocuments,
  trashMeetingFolders,
  uploadMeetingDocument,
  type GoogleDriveEnv,
} from './google-drive';

export interface Env extends GoogleDriveEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const HUI_STATUSES = ['draft', 'published', 'cancelled'] as const;
type HuiStatus = (typeof HUI_STATUSES)[number];

interface HuiInput {
  title?: unknown;
  description?: unknown;
  scheduled_at?: unknown;
  location?: unknown;
  zoom_link?: unknown;
  zoom_passcode?: unknown;
  status?: unknown;
  documents?: unknown;
}

interface DocumentInput {
  name: string;
  url: string;
  type: 'agenda' | 'document';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

function error(message: string, status = 400, details?: unknown): Response {
  return json({ error: message, details }, status);
}

function serviceClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function requirePortalAccess(request: Request, env: Env): Promise<PortalUser | Response> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';

  if (!token) {
    return error('Unauthorized: missing bearer token', 401);
  }

  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error: authError } = await client.auth.getUser(token);
  if (authError || !data?.user) {
    return error('Unauthorized: invalid or expired token', 401);
  }

  const breakGlass = breakGlassAccess(data.user);
  if (breakGlass) return breakGlass;

  const { data: profile, error: accessError } = await client.rpc('current_portal_access');
  if (accessError) {
    console.error('Portal authorization lookup failed', accessError.code);
    return error('Portal access is temporarily unavailable. Please contact the trust administrator.', 503);
  }
  if (profile === null) {
    return error('Access denied. Sign in with the Google account registered for an active trustee.', 403);
  }
  if (!isPortalUser(profile) || profile.userId !== data.user.id || profile.isBreakGlass) {
    console.error('Invalid portal access profile');
    return error('Portal access configuration is invalid. Please contact the trust administrator.', 503);
  }
  return profile;
}

async function requireAuth(request: Request, env: Env): Promise<Response | null> {
  const access = await requirePortalAccess(request, env);
  return access instanceof Response ? access : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return !Number.isNaN(time);
}

function normaliseString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Validate documents array if present.
function validateDocuments(value: unknown): { ok: true; docs: DocumentInput[] } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, docs: [] };
  if (!Array.isArray(value)) return { ok: false, message: 'documents must be an array' };

  const docs: DocumentInput[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, message: 'each document must be an object' };
    }
    const d = raw as Record<string, unknown>;
    if (!isNonEmptyString(d.name)) return { ok: false, message: 'document.name is required' };
    if (!isNonEmptyString(d.url)) return { ok: false, message: 'document.url is required' };
    if (d.type !== 'agenda' && d.type !== 'document') {
      return { ok: false, message: "document.type must be 'agenda' or 'document'" };
    }
    docs.push({ name: d.name.trim(), url: d.url.trim(), type: d.type });
  }
  return { ok: true, docs };
}

// Build a validated record for create.
function validateCreate(body: HuiInput): { ok: true; record: Record<string, unknown>; docs: DocumentInput[] } | { ok: false; message: string } {
  if (!isNonEmptyString(body.title)) return { ok: false, message: 'title is required' };
  if (!isValidIsoDate(body.scheduled_at)) return { ok: false, message: 'scheduled_at must be a valid ISO 8601 datetime' };

  let status: HuiStatus = 'draft';
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !HUI_STATUSES.includes(body.status as HuiStatus)) {
      return { ok: false, message: "status must be one of 'draft', 'published', 'cancelled'" };
    }
    status = body.status as HuiStatus;
  }

  const docsResult = validateDocuments(body.documents);
  if (!docsResult.ok) return { ok: false, message: docsResult.message };

  return {
    ok: true,
    record: {
      title: body.title.trim(),
      description: normaliseString(body.description),
      scheduled_at: new Date(body.scheduled_at as string).toISOString(),
      location: normaliseString(body.location),
      zoom_link: normaliseString(body.zoom_link),
      zoom_passcode: normaliseString(body.zoom_passcode),
      status,
    },
    docs: docsResult.docs,
  };
}

// Build a validated partial record for update.
function validateUpdate(body: HuiInput): { ok: true; record: Record<string, unknown>; docs: DocumentInput[] | null } | { ok: false; message: string } {
  const record: Record<string, unknown> = {};

  if (body.title !== undefined) {
    if (!isNonEmptyString(body.title)) return { ok: false, message: 'title cannot be empty' };
    record.title = body.title.trim();
  }
  if (body.scheduled_at !== undefined) {
    if (!isValidIsoDate(body.scheduled_at)) return { ok: false, message: 'scheduled_at must be a valid ISO 8601 datetime' };
    record.scheduled_at = new Date(body.scheduled_at as string).toISOString();
  }
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !HUI_STATUSES.includes(body.status as HuiStatus)) {
      return { ok: false, message: "status must be one of 'draft', 'published', 'cancelled'" };
    }
    record.status = body.status;
  }
  if (body.description !== undefined) record.description = normaliseString(body.description);
  if (body.location !== undefined) record.location = normaliseString(body.location);
  if (body.zoom_link !== undefined) record.zoom_link = normaliseString(body.zoom_link);
  if (body.zoom_passcode !== undefined) record.zoom_passcode = normaliseString(body.zoom_passcode);

  let docs: DocumentInput[] | null = null;
  if (body.documents !== undefined) {
    const docsResult = validateDocuments(body.documents);
    if (!docsResult.ok) return { ok: false, message: docsResult.message };
    docs = docsResult.docs;
  }

  return { ok: true, record, docs };
}

async function parseBody(request: Request): Promise<HuiInput | null> {
  try {
    const body = await request.json();
    if (typeof body !== 'object' || body === null) return null;
    return body as HuiInput;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_FILE_ID_RE = /^[a-zA-Z0-9_-]{10,200}$/;

// -----------------------------------------------------------------------------
// Route handlers
// -----------------------------------------------------------------------------

// GET /api/hui/next — next published hui with documents (public)
async function getNextHui(env: Env): Promise<Response> {
  const supabase = serviceClient(env);
  const nowIso = new Date().toISOString();

  const { data, error: dbError } = await supabase
    .from('hui')
    .select('*, documents(*)')
    .eq('status', 'published')
    .gte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (dbError) return error('Failed to fetch next hui', 500, dbError.message);
  return json({ hui: data ?? null });
}

// GET /api/hui — all hui (authenticated)
async function listHui(env: Env): Promise<Response> {
  const supabase = serviceClient(env);
  const { data, error: dbError } = await supabase
    .from('hui')
    .select('*, documents(*)')
    .order('scheduled_at', { ascending: false });

  if (dbError) return error('Failed to fetch hui', 500, dbError.message);
  return json({ hui: data ?? [] });
}

async function getHui(id: string, env: Env): Promise<Response> {
  if (!UUID_RE.test(id)) return error('Invalid hui id', 400);
  const { data, error: dbError } = await serviceClient(env)
    .from('hui')
    .select('*, documents(*)')
    .eq('id', id)
    .maybeSingle();
  if (dbError) return error('Failed to fetch hui', 500, dbError.message);
  if (!data) return error('Hui not found', 404);
  return json({ hui: data });
}

function nzCalendarDate(isoDate: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Pacific/Auckland',
  }).formatToParts(new Date(isoDate));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

async function listMeetingRecords(env: Env): Promise<Response> {
  const { data, error: dbError } = await serviceClient(env)
    .from('hui')
    .select('id,title,scheduled_at')
    .order('scheduled_at', { ascending: false });
  if (dbError) return error('Failed to fetch hui for meeting records', 500, dbError.message);

  const meetings: Meeting[] = (data ?? []).map((hui) => ({
    id: hui.id,
    title: hui.title,
    meetingDate: nzCalendarDate(hui.scheduled_at),
  }));
  const meetingIds = new Set(meetings.map((meeting) => meeting.id));
  const documents = (await listMeetingDocuments(env))
    .filter((document) => meetingIds.has(document.meetingId));
  return json({ meetings, documents });
}

function validUploadFileName(value: string | null): value is string {
  return Boolean(
    value
    && value === value.trim()
    && value.length <= 180
    && !/[\u0000-\u001f/\\]/.test(value),
  );
}

async function createMeetingDocument(
  request: Request,
  env: Env,
  user: PortalUser,
): Promise<Response> {
  const url = new URL(request.url);
  const meetingId = url.searchParams.get('meetingId') ?? '';
  const documentType = url.searchParams.get('documentType');
  const fileName = url.searchParams.get('fileName');
  const sizeValue = url.searchParams.get('sizeBytes') ?? '';
  const sizeBytes = Number(sizeValue);

  if (!UUID_RE.test(meetingId)) return error('A valid hui is required.', 422);
  if (!isMeetingDocumentType(documentType)) {
    return error("documentType must be 'minutes' or 'notes'.", 422);
  }
  if (!validUploadFileName(fileName)) {
    return error('The file name is invalid or too long.', 422);
  }
  const mimeType = meetingDocumentMimeType(fileName);
  if (!mimeType) {
    return error('Unsupported file type. Upload a PDF, document, text file, or image.', 415);
  }
  if (!/^\d+$/.test(sizeValue) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    return error('The uploaded file is empty or has an invalid size.', 422);
  }
  if (sizeBytes > MAX_MEETING_DOCUMENT_BYTES) {
    return error('Meeting documents must be no larger than 100 MB.', 413);
  }
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) !== sizeBytes) {
    return error('The uploaded file size did not match the request.', 400);
  }
  if (!request.body) return error('The uploaded file is missing.', 400);

  const { data: hui, error: dbError } = await serviceClient(env)
    .from('hui')
    .select('id,title,scheduled_at')
    .eq('id', meetingId)
    .maybeSingle();
  if (dbError) return error('Failed to find the selected hui', 500, dbError.message);
  if (!hui) return error('The selected hui was not found.', 404);

  const document = await uploadMeetingDocument(
    env,
    {
      meetingId,
      meetingTitle: hui.title,
      meetingDate: nzCalendarDate(hui.scheduled_at),
      documentType,
      fileName,
      mimeType,
      sizeBytes,
      uploadedBy: user.userId,
    },
    request.body,
  );
  return json({ document }, 201);
}

function contentDisposition(fileName: string, disposition: 'inline' | 'attachment'): string {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function readMeetingDocument(
  id: string,
  request: Request,
  env: Env,
): Promise<Response> {
  if (!DRIVE_FILE_ID_RE.test(id)) return error('Invalid meeting document id.', 400);
  const { document, response } = await getMeetingDocumentContent(env, id);
  const { data: hui, error: dbError } = await serviceClient(env)
    .from('hui')
    .select('id')
    .eq('id', document.meetingId)
    .maybeSingle();
  if (dbError || !hui) {
    await response.body?.cancel();
    if (dbError) return error('Failed to verify the meeting document', 500, dbError.message);
    return error('Meeting document not found.', 404);
  }
  const forceDownload = new URL(request.url).searchParams.get('download') === '1';
  const previewable = document.mimeType === 'application/pdf'
    || document.mimeType === 'text/plain'
    || document.mimeType.startsWith('image/');
  const disposition = !forceDownload && previewable ? 'inline' : 'attachment';

  return new Response(response.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'private, no-store',
      'Content-Type': document.mimeType,
      'Content-Length': String(document.sizeBytes),
      'Content-Disposition': contentDisposition(document.fileName, disposition),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// POST /api/hui — create (authenticated)
async function createHui(request: Request, env: Env): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return error('Invalid JSON body', 400);

  const result = validateCreate(body);
  if (!result.ok) return error(result.message, 422);

  const supabase = serviceClient(env);
  const { data, error: dbError } = await supabase
    .from('hui')
    .insert(result.record)
    .select()
    .single();

  if (dbError || !data) return error('Failed to create hui', 500, dbError?.message);

  if (result.docs.length > 0) {
    const rows = result.docs.map((d) => ({ ...d, hui_id: data.id }));
    const { error: docError } = await supabase.from('documents').insert(rows);
    if (docError) return error('Hui created but documents failed', 500, docError.message);
  }

  const { data: full } = await supabase
    .from('hui')
    .select('*, documents(*)')
    .eq('id', data.id)
    .single();

  return json({ hui: full ?? data }, 201);
}

// PATCH /api/hui/:id — update (authenticated)
async function updateHui(id: string, request: Request, env: Env): Promise<Response> {
  if (!UUID_RE.test(id)) return error('Invalid hui id', 400);

  const body = await parseBody(request);
  if (!body) return error('Invalid JSON body', 400);

  const result = validateUpdate(body);
  if (!result.ok) return error(result.message, 422);

  const supabase = serviceClient(env);

  if (Object.keys(result.record).length > 0) {
    const { data, error: dbError } = await supabase
      .from('hui')
      .update(result.record)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (dbError) return error('Failed to update hui', 500, dbError.message);
    if (!data) return error('Hui not found', 404);
  } else {
    // Ensure the hui exists even if only documents are being replaced.
    const { data: exists } = await supabase.from('hui').select('id').eq('id', id).maybeSingle();
    if (!exists) return error('Hui not found', 404);
  }

  // If documents provided, replace the full set.
  if (result.docs !== null) {
    const { error: delError } = await supabase.from('documents').delete().eq('hui_id', id);
    if (delError) return error('Failed to replace documents', 500, delError.message);

    if (result.docs.length > 0) {
      const rows = result.docs.map((d) => ({ ...d, hui_id: id }));
      const { error: insError } = await supabase.from('documents').insert(rows);
      if (insError) return error('Failed to insert documents', 500, insError.message);
    }
  }

  const { data: full } = await supabase
    .from('hui')
    .select('*, documents(*)')
    .eq('id', id)
    .single();

  return json({ hui: full });
}

// DELETE /api/hui/:id — delete (authenticated)
async function deleteHui(id: string, env: Env): Promise<Response> {
  if (!UUID_RE.test(id)) return error('Invalid hui id', 400);

  const supabase = serviceClient(env);
  const { data, error: dbError } = await supabase
    .from('hui')
    .delete()
    .eq('id', id)
    .select()
    .maybeSingle();

  if (dbError) return error('Failed to delete hui', 500, dbError.message);
  if (!data) return error('Hui not found', 404);

  let warning: string | undefined;
  if (isGoogleDriveConfigured(env)) {
    try {
      await trashMeetingFolders(env, id);
    } catch (driveError) {
      console.error(
        'Deleted hui but could not trash its Google Drive meeting folder',
        driveError instanceof GoogleDriveError ? driveError.status : 'unknown',
      );
      warning = 'The hui was deleted, but its Google Drive meeting folder could not be moved to the bin.';
    }
  }

  return json({ success: true, id, ...(warning ? { warning } : {}) });
}

// POST /api/hui/:id/publish — publish (authenticated)
async function publishHui(id: string, env: Env): Promise<Response> {
  if (!UUID_RE.test(id)) return error('Invalid hui id', 400);

  const supabase = serviceClient(env);
  const { data, error: dbError } = await supabase
    .from('hui')
    .update({ status: 'published' })
    .eq('id', id)
    .select('*, documents(*)')
    .maybeSingle();

  if (dbError) return error('Failed to publish hui', 500, dbError.message);
  if (!data) return error('Hui not found', 404);

  return json({ hui: data });
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
      return error('Server misconfigured: missing Supabase environment variables', 500);
    }

    const url = new URL(request.url);
    const segments = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    // Expect: ['api', 'hui', ...]
    if (segments[0] !== 'api') return error('Not found', 404);

    const method = request.method;

    try {
      if (segments[1] === 'auth' && segments[2] === 'me' && segments.length === 3) {
        if (method !== 'GET') return error('Method not allowed', 405);
        const access = await requirePortalAccess(request, env);
        return access instanceof Response ? access : json({ user: access });
      }

      // /api/meeting-records and /api/meeting-records/:id/content (authenticated)
      if (segments[1] === 'meeting-records') {
        const access = await requirePortalAccess(request, env);
        if (access instanceof Response) return access;

        if (segments.length === 2) {
          if (method === 'GET') return await listMeetingRecords(env);
          if (method === 'POST') return await createMeetingDocument(request, env, access);
          return error('Method not allowed', 405);
        }

        if (segments.length === 4 && segments[3] === 'content') {
          if (method !== 'GET') return error('Method not allowed', 405);
          return await readMeetingDocument(segments[2], request, env);
        }
        return error('Not found', 404);
      }

      // /api/hui/next (public)
      if (segments[1] === 'hui' && segments[2] === 'next' && segments.length === 3) {
        if (method !== 'GET') return error('Method not allowed', 405);
        return await getNextHui(env);
      }

      // /api/hui (collection)
      if (segments[1] === 'hui' && segments.length === 2) {
        if (method === 'GET') {
          const auth = await requireAuth(request, env);
          if (auth) return auth;
          return await listHui(env);
        }
        if (method === 'POST') {
          const auth = await requireAuth(request, env);
          if (auth) return auth;
          return await createHui(request, env);
        }
        return error('Method not allowed', 405);
      }

      // /api/hui/:id and /api/hui/:id/publish
      if (segments[1] === 'hui' && segments.length >= 3) {
        const id = segments[2];

        // /api/hui/:id/publish
        if (segments.length === 4 && segments[3] === 'publish') {
          if (method !== 'POST') return error('Method not allowed', 405);
          const auth = await requireAuth(request, env);
          if (auth) return auth;
          return await publishHui(id, env);
        }

        // /api/hui/:id
        if (segments.length === 3) {
          if (method === 'GET') {
            const auth = await requireAuth(request, env);
            if (auth) return auth;
            return await getHui(id, env);
          }
          if (method === 'PATCH') {
            const auth = await requireAuth(request, env);
            if (auth) return auth;
            return await updateHui(id, request, env);
          }
          if (method === 'DELETE') {
            const auth = await requireAuth(request, env);
            if (auth) return auth;
            return await deleteHui(id, env);
          }
          return error('Method not allowed', 405);
        }
      }

      return error('Not found', 404);
    } catch (err) {
      if (err instanceof GoogleDriveError) return error(err.message, err.status);
      return error('Internal server error', 500, err instanceof Error ? err.message : String(err));
    }
  },
};
