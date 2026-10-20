import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * React Fast Refresh injects an inline script in development, which the
 * strict Content-Security-Policy blocks. Allow inline scripts on the dev
 * server only; packaged builds keep the strict policy.
 */
function devCsp(): Plugin {
  return {
    name: 'looit-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
  };
}

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), devCsp()],
  // Pre-bundle heavy dependencies at dev-server start so the first page load
  // doesn't trigger a dependency re-optimization and reload.
  optimizeDeps: {
    include: [
      'three',
      'three/addons/controls/TransformControls.js',
      'mediabunny',
      'react',
      'react-dom/client',
      'zustand',
      'immer',
      'lucide-react',
    ],
  },
});
