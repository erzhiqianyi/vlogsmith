import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import path from 'path'

// https://vite.dev/config/
// API_ORIGIN lets a second copy of the backend (e.g. on another port) sit behind the
// dev server without touching the one already running.
const API_ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:5001'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    strictPort: false,
    proxy: {
      // Flask still owns /api/* (JSON) and /job/<id>/file|theater/* (raw files + the
      // standalone theater page). The SPA itself uses /jobs/:id (plural) for the React
      // job detail route, so there's no overlap with Flask's /job/<id>/... paths.
      '/api': API_ORIGIN,
      // NOTE: a plain '/job' key would prefix-match '/jobs/...' (the SPA route) too,
      // so this must stay a regex anchored with a trailing slash.
      '^/job/': API_ORIGIN,
    },
  },
})
