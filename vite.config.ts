import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      // V2: No Gemini API key needed client-side (STT is server-side or Web Speech API)
      // API_BASE_URL: empty for browser (relative paths), set for Capacitor builds
      '__API_BASE_URL__': JSON.stringify(
        process.env.API_BASE_URL || env.API_BASE_URL || ''
      ),
    },
    resolve: {
      alias: { '@': path.resolve(__dirname, '.') },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: { '/api': 'http://localhost:3001' },
    },
  };
});
