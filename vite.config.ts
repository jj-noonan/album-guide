import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative base: the same build works at jj-noonan.github.io/album-guide/ and at
  // a custom domain later, with no rebuild and no path juggling.
  base: './',
  plugins: [react()],
})
