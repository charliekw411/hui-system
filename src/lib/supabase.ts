import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type HuiStatus = 'draft' | 'published' | 'cancelled';

export interface HuiDocument {
  id: string;
  hui_id: string;
  name: string;
  url: string;
  type: 'agenda' | 'document';
  created_at: string;
}

export interface Hui {
  id: string;
  title: string;
  description: string | null;
  scheduled_at: string;
  location: string | null;
  zoom_link: string | null;
  zoom_passcode: string | null;
  status: HuiStatus;
  created_at: string;
  updated_at: string;
  documents?: HuiDocument[];
}

export interface PublicEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  API_BASE: string;
  GOOGLE_SIGN_IN_ENABLED: boolean;
}

/**
 * Resolve the public Supabase config.
 *
 * On the server (Astro SSR / Cloudflare) values come from `import.meta.env`
 * or the Cloudflare runtime env. In the browser we read the values that were
 * injected into `window.__PUBLIC_ENV__` by the page (see Layout).
 */
export function getPublicEnv(runtimeEnv?: Record<string, unknown>): PublicEnv {
  const fromRuntime = (key: string): string | undefined => {
    if (runtimeEnv && typeof runtimeEnv[key] === 'string') return runtimeEnv[key] as string;
    // import.meta.env is statically replaced at build time for prefixed vars,
    // but we also reference unprefixed names for SSR via the CF adapter.
    const metaEnv = import.meta.env as Record<string, unknown>;
    if (typeof metaEnv[key] === 'string') return metaEnv[key] as string;
    return undefined;
  };

  const url = fromRuntime('SUPABASE_URL') ?? fromRuntime('PUBLIC_SUPABASE_URL');
  const anonKey = fromRuntime('SUPABASE_ANON_KEY') ?? fromRuntime('PUBLIC_SUPABASE_ANON_KEY');

  if (!url || !anonKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables');
  }

  return {
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: anonKey,
    API_BASE: fromRuntime('PUBLIC_API_BASE') ?? '/api',
    GOOGLE_SIGN_IN_ENABLED: fromRuntime('PUBLIC_GOOGLE_SIGN_IN_ENABLED') === 'true',
  };
}

/**
 * Create a Supabase client using the public anon key.
 * Used in the browser for auth (login) and direct Storage uploads.
 */
const browserClients = new Map<string, SupabaseClient>();

export function createBrowserClient(url: string, anonKey: string): SupabaseClient {
  const key = `${url}:${anonKey}`;
  if (typeof window !== 'undefined') {
    const existing = browserClients.get(key);
    if (existing) return existing;
  }
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'hui-admin-auth',
      flowType: 'pkce',
    },
  });
  if (typeof window !== 'undefined') browserClients.set(key, client);
  return client;
}

export const STORAGE_BUCKET = 'hui-documents';
