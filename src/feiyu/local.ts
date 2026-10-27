// Local files for the Feiyu voice integration: the API key (kept out of
// cordis.patch.yml, 0600) and the folders the model may read from / write to.

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export function dshHome(): string {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

export interface FeiyuPaths {
  keyFile: string
  inbox: string
  outbox: string
}

export function feiyuPaths(cfg: { keyFile: string; inputDir: string; outputDir: string }): FeiyuPaths {
  const base = join(dshHome(), 'bili-fish')
  return {
    keyFile: cfg.keyFile.trim() || join(base, 'feiyu.json'),
    inbox: cfg.inputDir.trim() || join(base, 'voice-inbox'),
    outbox: cfg.outputDir.trim() || join(base, 'voice-out'),
  }
}

export async function readApiKey(path: string): Promise<string> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'))
    const key = (data as { apiKey?: unknown } | null)?.apiKey
    return typeof key === 'string' ? key : ''
  } catch {
    return ''
  }
}

const KEY = /^[\x21-\x7e]{8,512}$/

export function validApiKey(key: unknown): key is string {
  return typeof key === 'string' && KEY.test(key)
}

/** Atomically write { apiKey } with 0600 inside a 0700 directory. */
export async function saveApiKey(path: string, apiKey: string): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.feiyu-${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, JSON.stringify({ apiKey }) + '\n', { mode: 0o600 })
    await rename(tmp, path)
    await chmod(path, 0o600)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

export async function clearApiKey(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

/**
 * Resolve a model-supplied file name or path to a real file inside `inbox`.
 * Relative names resolve against the inbox; symlinks are followed and the
 * real target must still be inside it. Only the given suffixes are allowed.
 * This keeps the model from uploading arbitrary local files to the service.
 */
export async function resolveInboxFile(inbox: string, input: string, suffixes: readonly string[]): Promise<string> {
  const wanted = input.trim()
  if (wanted === '') throw new Error('没有给文件名')
  const suffix = extname(wanted).toLowerCase()
  if (!suffixes.includes(suffix)) throw new Error(`只支持 ${suffixes.join('、')} 文件`)
  await mkdir(inbox, { recursive: true, mode: 0o700 })
  const root = await realpath(inbox)
  let real: string
  try {
    real = await realpath(isAbsolute(wanted) ? wanted : resolve(root, wanted))
  } catch {
    throw new Error(`在收件夹 ${inbox} 里找不到 ${wanted}`)
  }
  const rel = relative(root, real)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`只能使用收件夹 ${inbox} 里的文件`)
  }
  if (!(await stat(real)).isFile()) throw new Error(`${wanted} 不是文件`)
  return real
}
