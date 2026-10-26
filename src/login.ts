// B 站 login values for bilibili-mcp-server, entered on the settings page.
//
// They are written to the cookie file bilibili-mcp-server 1.2.0 reads through
// BILIBILI_COOKIE_FILE ({ sessdata, bili_jct, dede_user_id, ... }) — the same
// file it rewrites when it auto-refreshes the login — not into cordis.patch.yml.
// The file is created 0600 inside a 0700 directory and replaced atomically.
// Secret values are never sent back to the browser.

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface LoginInput {
  sessdata?: string
  biliJct?: string
  dedeUserId?: string
}

export interface LoginStatus {
  path: string
  sessdata: boolean
  biliJct: boolean
  dedeUserId: string | null
  updatedAt: number | null
}

/** Default: <DSH_HOME or ~/.dsh>/bili-fish/cookie.json. */
export function cookieFilePath(configured: string): string {
  if (configured.trim() !== '') return configured
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'bili-fish', 'cookie.json')
}

const SESSDATA = /^[A-Za-z0-9%,*._-]{20,512}$/
const BILI_JCT = /^[0-9a-f]{32}$/i
const UID = /^\d{1,20}$/

/** Validate the three fields; empty strings mean "leave unchanged". */
export function validateLogin(input: unknown): { value: LoginInput } | { problems: string[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { problems: ['请求格式不正确'] }
  const raw = input as Record<string, unknown>
  const problems: string[] = []
  const value: LoginInput = {}
  for (const key of Object.keys(raw)) {
    if (!['sessdata', 'biliJct', 'dedeUserId'].includes(key)) problems.push(`不认识的字段 ${key}`)
  }
  const take = (key: keyof LoginInput, pattern: RegExp, label: string) => {
    const v = raw[key]
    if (v === undefined || v === '') return
    if (typeof v !== 'string' || !pattern.test(v.trim())) {
      problems.push(`${label} 格式不对`)
      return
    }
    value[key] = v.trim()
  }
  take('sessdata', SESSDATA, 'SESSDATA')
  take('biliJct', BILI_JCT, 'bili_jct（应为 32 位十六进制）')
  take('dedeUserId', UID, 'DedeUserID（应为纯数字 uid）')
  if (problems.length === 0 && Object.keys(value).length === 0) problems.push('三个值都是空的，没有要保存的内容')
  return problems.length > 0 ? { problems } : { value }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export async function readLoginStatus(path: string): Promise<LoginStatus> {
  const data = await readJson(path)
  let updatedAt: number | null = null
  try {
    updatedAt = (await stat(path)).mtimeMs
  } catch {
    // no file yet
  }
  const str = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  return {
    path,
    sessdata: str(data.sessdata),
    biliJct: str(data.bili_jct),
    dedeUserId: str(data.dede_user_id) ? String(data.dede_user_id) : null,
    updatedAt,
  }
}

/** Merge the given fields into the cookie file, keeping anything else the server stored (e.g. lastRefresh). */
export async function saveLogin(path: string, input: LoginInput): Promise<void> {
  const data = await readJson(path)
  if (input.sessdata) data.sessdata = input.sessdata
  if (input.biliJct) data.bili_jct = input.biliJct
  if (input.dedeUserId) data.dede_user_id = input.dedeUserId
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.cookie-${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, path)
    await chmod(path, 0o600)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

export async function clearLogin(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

/** The dsh-mcp-client entry that makes bilibili-mcp-server use this file. */
export function mcpEntrySnippet(path: string): string {
  return [
    '- insert:',
    '    - id: mcp-bilibili',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: bilibili',
    '        transport: stdio',
    '        command: npx',
    "        args: ['-y', 'bilibili-mcp-server@1.2.0']",
    '        env:',
    `          BILIBILI_COOKIE_FILE: '${path}'`,
  ].join('\n')
}
