import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
const gitHash = execSync('git rev-parse --short HEAD').toString().trim()

// Base path is environment-driven so the same build serves two homes:
//   - QA  → GitHub Pages project site at /stathead/ (the default).
//   - Prod → stathead.app on Cloudflare Pages, served from the root, set
//            by BASE_PATH=/ in the prod deploy workflow.
// Everything in the app reads import.meta.env.BASE_URL, so this single
// switch repoints every asset/data URL — no other code changes needed.
const base = process.env.BASE_PATH ?? '/stathead/'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify(gitHash),
  },
})
