import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// fs.allow: the console imports ABIs and the deployments record from the repo root.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, fs: { allow: ['..'] } },
  define: { global: 'globalThis' },
});
