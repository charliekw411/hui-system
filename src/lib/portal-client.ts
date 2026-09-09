import { createBrowserClient, type PublicEnv } from './supabase';
import { isPortalUser, type PortalUser } from './auth-policy';

export class PortalAccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PortalAccessError';
  }
}

export function getBrowserEnv(): PublicEnv {
  const env = window.__PUBLIC_ENV__;
  if (!env?.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error('Configuration error: Supabase environment variables are missing.');
  }
  return env;
}

export function getPortalClient() {
  const env = getBrowserEnv();
  return createBrowserClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
}

export function apiUrl(path: string): string {
  return `${getBrowserEnv().API_BASE.replace(/\/+$/, '')}${path}`;
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      && typeof body.error === 'string' ? body.error : `Request failed (${response.status}).`;
    throw new PortalAccessError(message, response.status);
  }
  return body as T;
}

export async function getAccessToken(): Promise<string> {
  const { data, error } = await getPortalClient().auth.getSession();
  if (error) throw error;
  if (!data.session) throw new PortalAccessError('Please sign in to continue.', 401);
  return data.session.access_token;
}

export async function portalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(apiUrl(path), { ...init, headers, cache: 'no-store' });
}

export async function requirePortalSession(): Promise<PortalUser> {
  const response = await portalFetch('/auth/me');
  const body = await readApiResponse<{ user?: unknown }>(response);
  if (!isPortalUser(body.user)) throw new Error('The server returned an invalid access profile.');
  const profile = document.getElementById('portal-user');
  if (profile) profile.textContent = `${body.user.name} · ${body.user.role}`;
  return body.user;
}

export function showPortalError(error: unknown, target: HTMLElement): void {
  if (error instanceof PortalAccessError && error.status === 401) {
    window.location.replace('/admin/login');
    return;
  }
  target.textContent = error instanceof Error ? error.message : 'Unable to check portal access.';
  target.classList.remove('hidden');
}
