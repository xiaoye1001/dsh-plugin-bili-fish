// Bundle src/client into lib/client.js in the format the DSH client module
// loader expects: one `window.__ModuleLoader__.load({ id, factory })` call
// whose factory resolves platform modules (react, …) through `require`.
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Provided by the DSH web shell's shared module table — never bundle these.
const EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

await build({
  entryPoints: [new URL('../src/client/index.tsx', import.meta.url).pathname],
  outfile: new URL('../lib/client.js', import.meta.url).pathname,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNALS,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
})
console.log(`built lib/client.js (${pkg.name})`)
