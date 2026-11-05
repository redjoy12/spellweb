import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: { port: 5173, proxy: { '^/api/': `http://localhost:${process.env.API_PORT ?? 8787}` } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
