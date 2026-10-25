import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const ID = 'dsh-ssh-workspace'
const CSS_PREFIX = '\0ssh-workspace-css:'
const CSS_SUFFIX = '.mjs'

const cssModulesInline = {
  name: `${ID}-css-modules-inline`,
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    return CSS_PREFIX + (importer === undefined ? source : resolvePath(dirname(importer), source)) + CSS_SUFFIX
  },
  async load(this: { addWatchFile(id: string): void }, virtualId: string) {
    if (!virtualId.startsWith(CSS_PREFIX)) return null
    const fileId = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
    this.addWatchFile(fileId)
    const result = transform({
      filename: fileId,
      code: await readFile(fileId),
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, value] of Object.entries(result.exports ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      classMap[local] = value.name
    }
    const css = result.code.toString()
    const tagId = `${ID}/${basename(fileId)}`
    return [
      `const css=${JSON.stringify(css)};`,
      `const tagId=${JSON.stringify(tagId)};`,
      'if(typeof document!=="undefined"&&!document.querySelector("style[data-plugin-css="+JSON.stringify(tagId)+"]")){const tag=document.createElement("style");tag.dataset.pluginCss=tagId;tag.textContent=css;document.head.appendChild(tag)}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}

export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: true,
    clean: true,
    sourcemap: true,
    external: [/^node:/, /^@deepseek-ai\//, 'ssh2'],
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src-client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    plugins: [cssModulesInline],
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    noExternal: (id: string) => id.startsWith('@deepseek-ai/') ? undefined : true,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
