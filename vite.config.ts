import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  const rawSupabaseUrl = (
    process.env.VITE_SUPABASE_URL || 'https://etlvzqrfsvvpzltimxaj.supabase.co'
  ).trim();
  const rawKey = (
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  ).trim();

  // Nunca expõe chaves secretas (sb_secret_) no bundle do navegador; usa proxy seguro do servidor quando necessário
  const clientSafeKey = rawKey.startsWith('sb_secret_') ? 'sb_gateway_proxy' : rawKey;

  return {
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(rawSupabaseUrl),
      ...(rawKey
        ? {
            'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(clientSafeKey),
          }
        : {}),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
