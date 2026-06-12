# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## Data proxies (self-hosting)

Live KeepTradeCut, FantasyCalc, and ESPN data is fetched through small
Cloudflare Worker CORS proxies, because those upstream APIs block direct
browser requests. The worker source lives under [`workers/`](workers/) and a
deploy workflow is in
[`.github/workflows/deploy-workers.yml`](.github/workflows/deploy-workers.yml).

By default the app points at the upstream project's workers, so it works as
soon as you clone it. **If you deploy your own copy, stand up your own workers**
(so you don't depend on — or get rate-limited by — someone else's) and override
the URLs via env vars. Copy [`.env.example`](.env.example) to `.env.local` and set:

| Var | Proxies |
| --- | --- |
| `VITE_KTC_PROXY` | KeepTradeCut dynasty values (`workers/ktc-proxy`) |
| `VITE_FC_PROXY` | FantasyCalc values (`workers/fc-proxy`) |
| `VITE_ESPN_NEWS_PROXY` | ESPN player news/overview (`workers/espn-news-proxy`) |

Each falls back to the project's worker when unset. Deploy a worker with
`cd workers/<name> && npx wrangler deploy` (or use the deploy workflow).

## Environments

Two deploy targets, fed by the same codebase:

| Env | URL | Host | Base path | Trigger |
| --- | --- | --- | --- | --- |
| **QA** | `dachhack.github.io/stathead/` | GitHub Pages | `/stathead/` | push to the dev branch ([`deploy.yml`](.github/workflows/deploy.yml)) |
| **Production** | `stathead.app` | Cloudflare Pages | `/` | push to `production` ([`deploy-prod.yml`](.github/workflows/deploy-prod.yml)) |

The base path is set by the `BASE_PATH` env var in
[`vite.config.ts`](vite.config.ts) (default `/stathead/`); the prod
workflow builds with `BASE_PATH=/`. Everything in the app reads
`import.meta.env.BASE_URL`, so that one switch repoints every asset and
data URL.

**Promote QA → prod by merging the dev branch into `production`.** That
push builds for the root domain and uploads to Cloudflare Pages. See the
header of [`deploy-prod.yml`](.github/workflows/deploy-prod.yml) for the
one-time Cloudflare Pages + DNS setup.

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
