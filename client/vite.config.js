import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend-only Vite configuration. There is no API proxy or backend server.
export default defineConfig({
  plugins: [react()],
})
