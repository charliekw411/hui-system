import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['workers/api.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  write: false,
});
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const trusteeId = '00000000-0000-4000-8000-000000000001';
const huiId = '00000000-0000-4000-8000-000000000002';
const driveFileId = 'drive-file-id-1234567890';
const env = {
  SUPABASE_URL: 'https://supabase.test.invalid',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  GOOGLE_DRIVE_CLIENT_ID: 'drive-client-id',
  GOOGLE_DRIVE_CLIENT_SECRET: 'drive-client-secret',
  GOOGLE_DRIVE_REFRESH_TOKEN: 'drive-refresh-token',
};
const profile = {
  userId: trusteeId,
  email: 'trustee@example.test',
  name: 'Test trustee',
  role: 'Trustee',
  isBreakGlass: false,
};
const hui = {
  id: huiId,
  title: 'September 2026 Hui',
  scheduled_at: '2026-09-14T22:00:00Z',
};

function portalRequest(path, method = 'GET', body, contentType) {
  const headers = new Headers({ Authorization: 'Bearer test-user-token' });
  if (contentType) headers.set('Content-Type', contentType);
  return new Request(`https://api.example.test/api${path}`, { method, headers, body });
}

function supabaseResponse(url, init) {
  if (url.pathname === '/auth/v1/user') {
    return Response.json({
      id: trusteeId,
      email: profile.email,
      aud: 'authenticated',
      created_at: '2026-01-01',
      app_metadata: { provider: 'google' },
      user_metadata: {},
    });
  }
  if (url.pathname === '/rest/v1/rpc/current_portal_access') return Response.json(profile);
  if (url.pathname === '/rest/v1/hui') {
    const single = new Headers(init.headers).get('Accept')?.includes('object');
    return Response.json(single ? hui : [hui]);
  }
  throw new Error(`Unexpected Supabase request: ${url.pathname}`);
}

function mockServices(t, driveHandler, testEnv = env) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push({ url, init });
    if (url.origin === testEnv.SUPABASE_URL) return supabaseResponse(url, init);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: `access-${testEnv.GOOGLE_DRIVE_REFRESH_TOKEN}`, expires_in: 3600 });
    }
    if (url.origin === 'https://www.googleapis.com') return driveHandler(url, init, calls);
    throw new Error(`Unexpected upstream request: ${url.href}`);
  });
  return calls;
}

test('meeting records require portal authorization before Drive access', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push(url);
    if (url.pathname === '/auth/v1/user') {
      return Response.json({
        id: trusteeId,
        email: profile.email,
        aud: 'authenticated',
        created_at: '2026-01-01',
        app_metadata: {},
        user_metadata: {},
      });
    }
    if (url.pathname === '/rest/v1/rpc/current_portal_access') return Response.json(null);
    throw new Error(`Unexpected upstream request: ${url.href}`);
  });

  const response = await worker.fetch(portalRequest('/meeting-records'), env);
  assert.equal(response.status, 403);
  assert.equal(calls.some((url) => url.origin === 'https://www.googleapis.com'), false);
});

test('meeting records fail clearly when Drive credentials are not configured', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin === env.SUPABASE_URL) return supabaseResponse(url, init);
    throw new Error(`Unexpected upstream request: ${url.href}`);
  });
  const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN, ...noDriveEnv } = env;
  const response = await worker.fetch(portalRequest('/meeting-records'), noDriveEnv);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'Google Drive storage is not configured.');
});

test('lists private Drive documents against existing hui', async (t) => {
  mockServices(t, async (url) => {
    assert.equal(url.pathname, '/drive/v3/files');
    assert.match(url.searchParams.get('q'), /meetingDocument/);
    return Response.json({
      files: [{
        id: driveFileId,
        name: 'Approved Minutes.pdf',
        mimeType: 'application/pdf',
        size: '2048',
        createdTime: '2026-09-20T01:02:03.000Z',
        appProperties: {
          huiSystemKind: 'meetingDocument',
          huiId,
          documentType: 'minutes',
        },
      }],
    });
  });

  const response = await worker.fetch(portalRequest('/meeting-records'), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.meetings, [{
    id: huiId,
    title: hui.title,
    meetingDate: '2026-09-15',
  }]);
  assert.deepEqual(body.documents, [{
    id: driveFileId,
    meetingId: huiId,
    documentType: 'minutes',
    fileName: 'Approved Minutes.pdf',
    fileUrl: `/meeting-records/${driveFileId}/content`,
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    createdAt: '2026-09-20T01:02:03.000Z',
  }]);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('streams a validated upload through a Google resumable session', async (t) => {
  const uploadBytes = 'test';
  let folderSearches = 0;
  let uploadedBody = '';
  const calls = mockServices(t, async (url, init) => {
    if (url.pathname === '/drive/v3/files' && init.method !== 'POST') {
      folderSearches += 1;
      return Response.json({ files: [] });
    }
    if (url.pathname === '/drive/v3/files' && init.method === 'POST') {
      const metadata = JSON.parse(init.body);
      return Response.json({
        id: folderSearches === 1 ? 'root-folder-id-12345' : 'hui-folder-id-12345',
        name: metadata.name,
      });
    }
    if (url.pathname === '/upload/drive/v3/files' && init.method === 'POST') {
      const metadata = JSON.parse(init.body);
      assert.equal(metadata.appProperties.huiId, huiId);
      assert.equal(metadata.appProperties.documentType, 'notes');
      assert.equal(metadata.appProperties.uploadedBy, trusteeId);
      assert.deepEqual(metadata.parents, ['hui-folder-id-12345']);
      return new Response(null, {
        status: 200,
        headers: { Location: 'https://www.googleapis.com/upload-session/meeting-document' },
      });
    }
    if (url.pathname === '/upload-session/meeting-document' && init.method === 'PUT') {
      uploadedBody = await new Response(init.body).text();
      return Response.json({
        id: driveFileId,
        name: 'Meeting Notes.pdf',
        mimeType: 'application/pdf',
        size: String(uploadBytes.length),
        createdTime: '2026-09-20T02:03:04.000Z',
        appProperties: {
          huiSystemKind: 'meetingDocument',
          huiId,
          documentType: 'notes',
        },
      });
    }
    throw new Error(`Unexpected Drive request: ${init.method ?? 'GET'} ${url.pathname}`);
  }, { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: 'upload-refresh-token' });

  const query = new URLSearchParams({
    meetingId: huiId,
    documentType: 'notes',
    fileName: 'Meeting Notes.pdf',
    sizeBytes: String(uploadBytes.length),
  });
  const response = await worker.fetch(
    portalRequest(`/meeting-records?${query}`, 'POST', uploadBytes, 'application/pdf'),
    { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: 'upload-refresh-token' },
  );
  assert.equal(response.status, 201);
  assert.equal(uploadedBody, uploadBytes);
  assert.equal((await response.json()).document.fileName, 'Meeting Notes.pdf');
  assert.equal(
    calls.some(({ init }) => new Headers(init.headers).get('Authorization')?.startsWith('Bearer access-')),
    true,
  );
});

test('rejects unsafe upload types before contacting Drive', async (t) => {
  const calls = mockServices(t, async (url) => {
    throw new Error(`Drive must not be called: ${url.href}`);
  }, { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: 'invalid-file-refresh-token' });
  const query = new URLSearchParams({
    meetingId: huiId,
    documentType: 'minutes',
    fileName: 'minutes.html',
    sizeBytes: '4',
  });
  const response = await worker.fetch(
    portalRequest(`/meeting-records?${query}`, 'POST', 'test', 'text/html'),
    { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: 'invalid-file-refresh-token' },
  );
  assert.equal(response.status, 415);
  assert.equal(calls.some(({ url }) => url.origin.includes('google')), false);
});

test('proxies only app-owned meeting documents with private download headers', async (t) => {
  mockServices(t, async (url) => {
    if (url.pathname === `/drive/v3/files/${driveFileId}` && url.searchParams.get('alt') === 'media') {
      return new Response('private minutes');
    }
    if (url.pathname === `/drive/v3/files/${driveFileId}`) {
      return Response.json({
        id: driveFileId,
        name: 'Approved Minutes.pdf',
        mimeType: 'application/pdf',
        size: '15',
        createdTime: '2026-09-20T01:02:03.000Z',
        trashed: false,
        appProperties: {
          huiSystemKind: 'meetingDocument',
          huiId,
          documentType: 'minutes',
        },
      });
    }
    throw new Error(`Unexpected Drive request: ${url.href}`);
  }, { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: 'download-refresh-token' });

  const response = await worker.fetch(
    portalRequest(`/meeting-records/${driveFileId}/content?download=1`),
    { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: 'download-refresh-token' },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'private minutes');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('refuses to proxy other files from the connected Drive account', async (t) => {
  let mediaRequested = false;
  mockServices(t, async (url) => {
    if (url.searchParams.get('alt') === 'media') {
      mediaRequested = true;
      return new Response('must not be returned');
    }
    return Response.json({
      id: driveFileId,
      name: 'Unrelated private file.pdf',
      mimeType: 'application/pdf',
      size: '20',
      createdTime: '2026-09-20T01:02:03.000Z',
      trashed: false,
      appProperties: {},
    });
  }, { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: 'unrelated-file-refresh-token' });

  const response = await worker.fetch(
    portalRequest(`/meeting-records/${driveFileId}/content`),
    { ...env, GOOGLE_DRIVE_REFRESH_TOKEN: 'unrelated-file-refresh-token' },
  );
  assert.equal(response.status, 404);
  assert.equal(mediaRequested, false);
});
