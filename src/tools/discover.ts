import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { matchUploaderVideo, parseFoundVideos, parseUploaderVideos } from '../explore/parse.js'
import { missingTool, type ToolDeps } from './deps.js'

const DISCOVER_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', enum: ['search', 'hot'], required: true },
    keyword: { type: 'string' },
    videos: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          videoId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          author: { type: 'string', required: true },
          alreadyCommented: { type: 'boolean', required: true },
        },
      },
    },
    note: { type: 'string', required: true },
  },
} as const

/**
 * Find candidate videos. bilibili-mcp-server's search and trending lists do
 * not print BV ids, so each candidate's id is recovered from its uploader's
 * latest videos (`bilibili_user_videos`) by title. Paid and live entries are
 * dropped; unmatched ones are skipped.
 */
export function createDiscoverTool({ settings, guard, bili }: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'bili_discover',
    description:
      '找 B 站视频。给 keyword 就按关键词搜索，不给就看当前热门。返回带 BV 号的候选视频列表（已去掉付费和直播），'
      + '以及你最近是否评论过。挑感兴趣的再用 bili_watch_video 去看。只读，不会发任何东西。',
    parameters: {
      keyword: { type: 'string', description: '搜索关键词；不传则看热门' },
      order: { type: 'string', enum: ['totalrank', 'pubdate', 'click'], description: '搜索排序：综合 / 最新 / 播放最多，默认 pubdate' },
      max: { type: 'integer', description: '最多返回几个候选，1～8，默认 5' },
    },
    output: {
      schema: DISCOVER_OUTPUT,
      render: (_args, v) => [{
        type: 'text',
        text: v.videos.length === 0
          ? `没找到合适的视频。${v.note}`
          : `${v.source === 'search' ? `搜索「${v.keyword}」` : '热门'}找到 ${v.videos.length} 个：\n`
            + v.videos.map((x, i) => `${i + 1}. [${x.videoId}] ${x.title} — ${x.author}${x.alreadyCommented ? '（最近评论过）' : ''}`).join('\n')
            + (v.note ? `\n${v.note}` : ''),
      }],
    },
    async execute(args, exec) {
      const s = settings()
      const keyword = args.keyword?.trim()
      const max = Math.min(8, Math.max(1, args.max ?? 5))
      const source: 'search' | 'hot' = keyword ? 'search' : 'hot'
      const listTool = keyword ? s.bilibili.searchTool : s.bilibili.hotTool
      for (const t of [listTool, s.bilibili.userVideosTool]) {
        if (!bili.has(t, exec)) throw new Error(missingTool(t))
      }
      const listText = keyword
        ? await bili.readText(listTool, { keyword, order: args.order ?? 'pubdate' }, exec)
        : await bili.readText(listTool, { max: 20 }, exec)
      const found = parseFoundVideos(listText).filter(v => !v.restricted)

      const videos: { videoId: string; title: string; author: string; alreadyCommented: boolean }[] = []
      // Each uploader is looked up at most once, and at most 2×max lookups per call.
      const uploaders = new Map<string, ReturnType<typeof parseUploaderVideos> | null>()
      const lookupBudget = max * 2
      let unmatched = 0
      for (const f of found) {
        if (videos.length >= max) break
        exec.signal.throwIfAborted()
        let uploads = uploaders.get(f.uid)
        if (uploads === undefined) {
          if (uploaders.size >= lookupBudget) break
          try {
            uploads = parseUploaderVideos(await bili.readText(s.bilibili.userVideosTool, { uid: Number(f.uid), max: 30 }, exec))
          } catch {
            uploads = null
          }
          uploaders.set(f.uid, uploads)
        }
        const hit = uploads ? matchUploaderVideo(f.title, uploads) : undefined
        if (!hit || videos.some(v => v.videoId === hit.videoId)) {
          unmatched++
          continue
        }
        videos.push({ videoId: hit.videoId, title: f.title, author: f.author, alreadyCommented: guard.wasCommented(hit.videoId) })
      }
      const note = unmatched > 0 ? `另有 ${unmatched} 个结果没能确定 BV 号，已跳过。` : ''
      return { source, ...(keyword ? { keyword } : {}), videos, note }
    },
  })
}
