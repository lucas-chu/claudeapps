import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // No dev proxy and no API routes: the browser calls the Anthropic API
  // directly with the user's own key, so the build is plain static files.
  server: { port: 5173 },
  test: { globals: true, environment: 'node' },
})
