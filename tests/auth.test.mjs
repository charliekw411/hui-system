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
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const breakGlassId = '0a84ad22-04a1-4778-8c2e-84c87c297461';
const trusteeId = '00000000-0000-4000-8000-000000000001';
const huiId = '00000000-0000-4000-8000-000000000002';
const env = {
  SUPABASE_URL: 'https://supabase.test.invalid',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
};
const profile = {
  userId: trusteeId, email: 'trustee@example.test', name: 'Test trustee',
  role: 'Trustee', isBreakGlass: false,
};
const hui = {
  id: huiId, title: 'Test hui', scheduled_at: '2027-01-15T00:00:00Z',
  status: 'draft', documents: [],
};

function mockSupabase(t, { userId = trusteeId, email = profile.email, access = profile, authStatus = 200, rpcStatus = 200 } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    assert.equal(url.origin, env.SUPABASE_URL, 'Tests must not access live services');
    calls.push({ path: url.pathname, method: init.method ?? 'GET', headers: new Headers(init.headers) });
    if (url.pathname === '/auth/v1/user') {
      return Response.json(authStatus === 200 ? {
        id: userId, email, aud: 'authenticated', created_at: '2026-01-01',
        app_metadata: { provider: 'email' }, user_metadata: {},
      } : { message: 'Invalid token' }, { status: authStatus });
    }
    if (url.pathname === '/rest/v1/rpc/current_portal_access') {
      return Response.json(rpcStatus === 200 ? access : {
        code: 'PGRST202', message: 'Function unavailable',
      }, { status: rpcStatus });
    }
    if (url.pathname === '/rest/v1/hui') {
      const single = new Headers(init.headers).get('Accept')?.includes('object');
      return Response.json(single ? hui : [hui]);
    }
    if (url.pathname === '/rest/v1/documents') return Response.json([]);
    throw new Error(`Unexpected upstream request: ${url.pathname}`);
  });
  return calls;
}

function request(path, method = 'GET', body, token = 'test-user-token') {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`https://api.example.test/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('missing and invalid bearer tokens cannot access the portal', async (t) => {
  const calls = mockSupabase(t, { authStatus: 401 });
  assert.equal((await worker.fetch(request('/auth/me', 'GET', undefined, ''), env)).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await worker.fetch(request('/auth/me'), env)).status, 401);
  assert.equal(calls.some((call) => call.path.startsWith('/rest/')), false);
});

test('existing immutable break-glass user bypasses trustee lookup entirely', async (t) => {
  const calls = mockSupabase(t, { userId: breakGlassId, email: 'trust@pehiaweri.local', rpcStatus: 500 });
  const response = await worker.fetch(request('/auth/me'), env);
  assert.equal(response.status, 200);
  const { user } = await response.json();
  assert.equal(user.role, 'Admin');
  assert.equal(user.isBreakGlass, true);
  assert.equal(user.userId, breakGlassId);
  assert.equal(calls.length, 1);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('matching the break-glass email does not grant the exception to a different user', async (t) => {
  mockSupabase(t, { email: 'trust@pehiaweri.local', access: null });
  assert.equal((await worker.fetch(request('/auth/me'), env)).status, 403);
});

for (const role of ['Admin', 'Chair', 'Secretary', 'Treasurer', 'Trustee']) {
  test(`active authorized ${role} has portal access`, async (t) => {
    const calls = mockSupabase(t, { access: { ...profile, role } });
    const response = await worker.fetch(request('/auth/me'), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.role, role);
    const rpc = calls.find((call) => call.path.includes('/rpc/'));
    assert.equal(rpc.headers.get('Authorization'), 'Bearer test-user-token');
    assert.equal(rpc.headers.get('apikey'), env.SUPABASE_ANON_KEY);
  });
}

const routes = [
  ['/hui', 'GET'],
  [`/hui/${huiId}`, 'GET'],
  ['/hui', 'POST', { title: hui.title, scheduled_at: hui.scheduled_at }],
  [`/hui/${huiId}`, 'PATCH', { title: 'Updated title' }],
  [`/hui/${huiId}`, 'DELETE'],
  [`/hui/${huiId}/publish`, 'POST'],
];

for (const [path, method, body] of routes) {
  test(`${method} ${path} denies non-allowlisted sessions before accessing data`, async (t) => {
    const calls = mockSupabase(t, { access: null });
    assert.equal((await worker.fetch(request(path, method, body), env)).status, 403);
    assert.equal(calls.some((call) => call.path === '/rest/v1/hui'), false);
  });

  test(`${method} ${path} remains available to an authorized trustee`, async (t) => {
    mockSupabase(t);
    const response = await worker.fetch(request(path, method, body), env);
    assert.equal(response.status, method === 'POST' && path === '/hui' ? 201 : 200);
  });

  test(`${method} ${path} remains available to break-glass without the trustee RPC`, async (t) => {
    const calls = mockSupabase(t, { userId: breakGlassId, rpcStatus: 500 });
    const response = await worker.fetch(request(path, method, body), env);
    assert.equal(response.status, method === 'POST' && path === '/hui' ? 201 : 200);
    assert.equal(calls.some((call) => call.path.includes('/rpc/')), false);
  });
}

test('authorization lookup failures fail closed', async (t) => {
  mockSupabase(t, { rpcStatus: 404 });
  const response = await worker.fetch(request('/hui'), env);
  assert.equal(response.status, 503);
});

for (const access of [
  { ...profile, role: 'Owner' },
  { ...profile, userId: 'different-user' },
  { ...profile, isBreakGlass: true },
  {},
]) {
  test(`invalid authorization profile is rejected: ${JSON.stringify(access)}`, async (t) => {
    mockSupabase(t, { access });
    assert.equal((await worker.fetch(request('/hui'), env)).status, 503);
  });
}

test('public next-hui route remains anonymous', async (t) => {
  const calls = mockSupabase(t, { access: null });
  assert.equal((await worker.fetch(request('/hui/next', 'GET', undefined, ''), env)).status, 200);
  assert.equal(calls.some((call) => call.path === '/auth/v1/user'), false);
});

test('read responses for private hui are never cacheable', async (t) => {
  mockSupabase(t);
  const response = await worker.fetch(request(`/hui/${huiId}`), env);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
