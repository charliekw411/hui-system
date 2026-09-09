/// <reference path="../.astro/types.d.ts" />

type CloudflareRuntime = import('@astrojs/cloudflare').Runtime;
type PublicEnv = import('./lib/supabase').PublicEnv;

declare namespace App {
  interface Locals extends CloudflareRuntime {}
}

interface Window {
  __PUBLIC_ENV__?: PublicEnv;
}