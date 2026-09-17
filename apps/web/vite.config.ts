import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Environment the browser bundle cannot work without.
 *
 * `src/lib/supabase.ts` throws at module scope when these are missing. In a
 * production build that throw is provably unconditional, so the minifier
 * treats the ENTIRE application as dead code and eliminates it: the build
 * succeeds, emits a bundle containing nothing but vendor code and one `throw`,
 * and the deployed site is a blank page.
 *
 * That failure is invisible — a green build log, a plausible bundle size, no
 * warning anywhere. It was found by grepping a local `dist` for a string from
 * the app and getting zero hits. See D-052 and landmine 5.
 *
 * Failing here converts it into the loud error it should always have been.
 */
const REQUIRED_CLIENT_ENV = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'] as const;

function requireClientEnv(): Plugin {
  return {
    name: 'asc:require-client-env',
    apply: 'build',
    configResolved(config) {
      const missing = REQUIRED_CLIENT_ENV.filter((key) => !config.env[key]);
      if (missing.length === 0) return;
      throw new Error(
        `Missing required client environment: ${missing.join(', ')}.\n` +
          `Vite inlines VITE_* at BUILD time, so a build without them produces a bundle ` +
          `that throws on load and renders nothing — with a successful build log.\n` +
          `Set them in apps/web/.env.local for a local build, or in the Vercel project ` +
          `settings for a deploy (changing one there needs a redeploy, not just a save).\n` +
          `See .env.example.`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), requireClientEnv()],
  // The repo keeps one .env at the root — the API and worker read it with
  // `node --env-file=.env`. Without this, Vite looks only in apps/web/ and a
  // local build silently produces the dead bundle described above.
  //
  // Only VITE_-prefixed keys are exposed to the browser, so the service role
  // key sitting in the same file is not reachable from here. That is Vite's
  // guarantee, but it is also why .env.example spells the rule out: a secret
  // renamed to VITE_* would be published.
  envDir: '../../',
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: true },
});
