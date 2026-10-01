import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  console.error(
    'Set GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET before running this command.',
  );
  process.exit(1);
}

const base64Url = (value) => value.toString('base64url');
const state = base64Url(randomBytes(24));
const codeVerifier = base64Url(randomBytes(64));
const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());

let settleAuthorization;
const authorization = new Promise((resolve, reject) => {
  settleAuthorization = { resolve, reject };
});

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/oauth2/callback') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const returnedState = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (returnedState !== state) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('The OAuth state did not match. Close this tab and run the command again.');
    settleAuthorization.reject(new Error('Google OAuth state validation failed.'));
    return;
  }
  if (oauthError || !code) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Google Drive authorization was not granted. You can close this tab.');
    settleAuthorization.reject(new Error(`Google OAuth failed: ${oauthError ?? 'missing code'}`));
    return;
  }

  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><title>Google Drive connected</title>'
    + '<main style="font:16px system-ui;max-width:38rem;margin:4rem auto;padding:1rem">'
    + '<h1>Google Drive authorization complete</h1>'
    + '<p>You can close this tab and return to the terminal.</p></main>',
  );
  settleAuthorization.resolve(code);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start OAuth callback.');
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  console.log('\nOpen this URL and sign in as pehiawerib1b@gmail.com:\n');
  console.log(authorizationUrl.toString());
  console.log('\nWaiting for Google to redirect back to this computer…\n');

  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Authorization timed out after five minutes.')),
      5 * 60 * 1000,
    );
    timer.unref();
  });
  const code = await Promise.race([authorization, timeout]);

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const tokenBody = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(
      `Google token exchange failed (${tokenResponse.status}): ${tokenBody.error_description ?? tokenBody.error ?? 'unknown error'}`,
    );
  }
  if (typeof tokenBody.refresh_token !== 'string' || !tokenBody.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Revoke the app connection in the Google account and run this command again.',
    );
  }

  console.log('Authorization complete. Store this value as GOOGLE_DRIVE_REFRESH_TOKEN:\n');
  console.log(tokenBody.refresh_token);
  console.log('\nDo not commit or share this token.');
} finally {
  server.close();
}
