import Schema from '@deepseek-ai/schemastery'

export interface LengthRange {
  min: number
  max: number
}

/**
 * A `.volatile()` config field. The DSH Loader updates it in place when the
 * settings page saves, without remounting the plugin, so rate-limit state and
 * reply dedupe survive a save. Always read through {@link resolveSettings}.
 */
export interface Live<T> {
  get(): T
}

/** Parsed plugin config as apply() receives it. Live<> fields are editable from the web panel. */
export interface Config {
  /** 总发送开关。关闭时任何工具都不会写 B 站。 */
  sendEnabled: Live<boolean>
  /** 工具调用未传 dryRun 时采用的值。 */
  dryRunByDefault: Live<boolean>
  maxCommentsPerDay: Live<number>
  maxRepliesPerDay: Live<number>
  /** 任意两次真实发送之间的最小间隔。 */
  minIntervalMs: Live<number>
  voiceEnabled: Live<boolean>
  /** “当日”按哪个时区切分。 */
  timeZone: string
  /** 同一条评论在这段时间内只回复一次。 */
  replyDedupeWindowMs: Live<number>
  commentLength: LengthRange
  replyLength: LengthRange
  voiceMaxLength: number
  bilibili: {
    /** bilibili-mcp 经 dsh-mcp-client 桥接后的公开工具名。 */
    replyTool: string
    /** 语音评论工具的公开名；留空表示 bilibili-mcp 没有这个能力。 */
    voiceTool: string
    /** 不允许模型直接调用的 B 站写操作工具（回复工具与语音工具总是受保护）。 */
    blockDirect: string[]
    /** 读取视频评论的工具公开名（自动回复巡检用）。 */
    commentsTool: string
    /** 登录信息文件（bilibili-mcp-server 的 BILIBILI_COOKIE_FILE）；留空为 ~/.dsh/bili-fish/cookie.json。 */
    cookieFile: string
    /** 自己逛 / 看视频用到的只读工具公开名。 */
    searchTool: string
    hotTool: string
    userVideosTool: string
    videoInfoTool: string
    subtitleTool: string
    danmakuTool: string
  }
  /** 同一个视频在这段时间内只评论一次（小时）。 */
  commentOncePerVideoHours: Live<number>
  /** 肥鱼声音服务（github.com/Esmerubphire/astrbot_plugin_feiyu_voice 的 server/）。 */
  feiyu: {
    /** 服务地址；留空表示不使用。 */
    baseUrl: Live<string>
    /** 服务里配置的声音 id。 */
    voice: Live<string>
    /** 默认说话风格：cute（可爱）或 gentle（温柔）。 */
    style: Live<string>
    /** 用肥鱼声音给 bili_send_voice 合成语音（代替 ctx.tts）。 */
    useForBiliVoice: Live<boolean>
    /** 工具调用里最多等待生成完成的秒数，超时返回任务编号。 */
    waitSeconds: Live<number>
    /** API Key 文件；留空为 ~/.dsh/bili-fish/feiyu.json。 */
    keyFile: string
    /** 换声 / 唱歌只能读取这个文件夹里的文件；留空为 ~/.dsh/bili-fish/voice-inbox。 */
    inputDir: string
    /** 生成的 WAV 保存位置；留空为 ~/.dsh/bili-fish/voice-out。 */
    outputDir: string
  }
  explore: {
    /** 自己逛总开关，默认关闭。 */
    enabled: Live<boolean>
    /** 感兴趣的关键词，每轮轮流挑一个；为空则逛热门。 */
    interests: Live<string[]>
    /** 两轮之间的间隔（分钟），不低于 30。 */
    intervalMin: Live<number>
    /** 只在这段时间内逛（时区见 timeZone），[from, to) 小时。 */
    activeFrom: Live<number>
    activeTo: Live<number>
    /** 每轮最多看几个视频。 */
    watchPerRound: Live<number>
    /** 每轮最多评论几个视频。 */
    commentsPerRound: Live<number>
    /** 为 true 时以 dryRun:false 真实评论（仍受 sendEnabled 与频率限制约束）；否则只出草稿。 */
    send: Live<boolean>
    sessionId: string
  }
  autoReply: {
    /** 自动回复总开关，默认关闭。 */
    enabled: Live<boolean>
    /** 要巡检的视频 BV 号。 */
    videos: Live<string[]>
    /** 两次巡检的间隔（秒），不低于 60。 */
    intervalSec: Live<number>
    /** 每轮最多交给模型处理的新评论数。 */
    maxPerRound: Live<number>
    /** 为 true 时让模型以 dryRun:false 真实回复（仍受 sendEnabled 与频率限制约束）；否则只出草稿。 */
    send: Live<boolean>
    /** 跳过这些昵称的评论（比如你自己）。 */
    skipNames: Live<string[]>
    /** 每个视频每次读取的评论数。 */
    commentsPerVideo: number
    /** 自动回复使用的 DSH 会话 id。 */
    sessionId: string
  }
  tts: {
    /** 提供 Edge TTS 的 ctx 服务名（由 dsh-plugin-tts 注册）。 */
    service: string
    defaultVoice: Live<string>
    /** 语音文件输出目录；留空用系统临时目录下的 dsh-bili-fish。 */
    outputDir: string
  }
  voiceFallback: {
    enabled: Live<boolean>
    uploadUrl: Live<string>
    headers: Record<string, string>
    fileField: string
    urlField: string
    template: Live<string>
    timeoutMs: number
  }
  persona: {
    /** 非空时整体替换内置的 FISH_PERSONA。 */
    override: Live<string>
    /** 追加在人格末尾的补充说明。 */
    extra: Live<string>
  }
}

/** Config with every Live<> field read to its current value. */
export type Resolved<T> = T extends Live<infer U>
  ? U
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]: Resolved<T[K]> }
      : T

/** Plain snapshot of the effective configuration at one moment. */
export type Settings = Resolved<Config>

function isLive(value: unknown): value is Live<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Live<unknown>).get === 'function'
}

/** Read every live field now. Tools call this per execution so panel edits apply to the next call. */
export function resolveSettings(config: Config): Settings {
  const walk = (value: unknown): unknown => {
    if (isLive(value)) return value.get()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]))
  }
  return walk(config) as Settings
}

const length = (min: number, max: number) => Schema.object({
  min: Schema.natural().min(1).default(min),
  max: Schema.natural().min(1).default(max),
})

/** Write tools of bilibili-mcp-server besides bilibili_reply, under serverName "bilibili". */
export const DEFAULT_BLOCKED_WRITES = [
  'mcp__bilibili__bilibili_delete_comment',
  'mcp__bilibili__bilibili_like_comment',
  'mcp__bilibili__bilibili_send_danmaku',
  'mcp__bilibili__bilibili_video_like',
  'mcp__bilibili__bilibili_video_coin',
  'mcp__bilibili__bilibili_video_favorite',
  'mcp__bilibili__bilibili_user_follow',
  'mcp__bilibili__bilibili_user_unfollow',
] as const

const ConfigSchema = Schema.object({
  sendEnabled: Schema.boolean().default(false).volatile()
    .description('总发送开关，默认关闭。关闭时所有真实发送都返回 send_disabled。'),
  dryRunByDefault: Schema.boolean().default(true).volatile()
    .description('调用未传 dryRun 时的默认值。真实发送仍要求显式 dryRun: false。'),
  maxCommentsPerDay: Schema.natural().max(100).default(5).volatile()
    .description('每日最多真实发送的评论数（语音评论计入此项）。'),
  maxRepliesPerDay: Schema.natural().max(200).default(10).volatile()
    .description('每日最多真实发送的回复数。'),
  minIntervalMs: Schema.natural().min(12000).default(12000).volatile()
    .description('两次真实发送之间的最小间隔（毫秒），不得低于 12000。'),
  voiceEnabled: Schema.boolean().default(true).volatile(),
  timeZone: Schema.string().default('Asia/Shanghai')
    .description('按哪个时区计算“当日”上限。'),
  replyDedupeWindowMs: Schema.natural().min(60000).default(10 * 60 * 1000).volatile()
    .description('同一条评论（parentRpid）在此窗口内不重复回复，不得低于 60000。'),
  commentLength: length(15, 60).description('评论字数范围。'),
  replyLength: length(5, 30).description('回复字数范围。'),
  voiceMaxLength: Schema.natural().min(1).default(200)
    .description('语音文本最大字数。'),
  bilibili: Schema.object({
    replyTool: Schema.string().default('mcp__bilibili__bilibili_reply')
      .description('bilibili-mcp-server 的评论/回复工具公开名（mcp__<serverName>__bilibili_reply）。'),
    voiceTool: Schema.string().default('')
      .description('语音评论工具公开名；bilibili-mcp 不提供时留空。'),
    blockDirect: Schema.array(Schema.string()).default([...DEFAULT_BLOCKED_WRITES])
      .description('禁止模型直接调用的其他 B 站写操作工具。清空则允许模型直接点赞、投币、关注等。'),
    commentsTool: Schema.string().default('mcp__bilibili__bilibili_video_comments')
      .description('读取视频评论的工具公开名（自动回复巡检用）。'),
    cookieFile: Schema.string().default('')
      .description('登录信息文件路径，供 bilibili-mcp-server 的 BILIBILI_COOKIE_FILE 使用；留空为 ~/.dsh/bili-fish/cookie.json。'),
    searchTool: Schema.string().default('mcp__bilibili__bilibili_search'),
    hotTool: Schema.string().default('mcp__bilibili__bilibili_hot'),
    userVideosTool: Schema.string().default('mcp__bilibili__bilibili_user_videos'),
    videoInfoTool: Schema.string().default('mcp__bilibili__bilibili_video_info'),
    subtitleTool: Schema.string().default('mcp__bilibili__bilibili_video_subtitle'),
    danmakuTool: Schema.string().default('mcp__bilibili__bilibili_video_danmaku'),
  }),
  commentOncePerVideoHours: Schema.natural().min(1).max(24 * 365).default(24 * 7).volatile()
    .description('同一个视频在这段时间内只评论一次（小时），默认 7 天。'),
  feiyu: Schema.object({
    baseUrl: Schema.string().default('').volatile()
      .description('肥鱼声音服务地址，例如 http://127.0.0.1:9880；留空表示不使用。'),
    voice: Schema.string().default('feiyu').volatile(),
    style: Schema.string().default('cute').volatile()
      .description('默认说话风格：cute（可爱）或 gentle（温柔）。'),
    useForBiliVoice: Schema.boolean().default(true).volatile()
      .description('配置了肥鱼声音服务时，bili_send_voice 用它合成语音。'),
    waitSeconds: Schema.natural().min(10).max(1800).default(180).volatile()
      .description('工具调用里最多等待生成完成的秒数，超时返回任务编号，可用 feiyu_job 取回。'),
    keyFile: Schema.string().default(''),
    inputDir: Schema.string().default(''),
    outputDir: Schema.string().default(''),
  }),
  explore: Schema.object({
    enabled: Schema.boolean().default(false).volatile()
      .description('自己逛：定时找感兴趣的视频、看完再决定要不要评论。默认关闭。'),
    interests: Schema.array(Schema.string()).default([]).volatile()
      .description('感兴趣的关键词，每轮轮流挑一个；为空则逛热门。'),
    intervalMin: Schema.natural().min(30).max(24 * 60).default(180).volatile()
      .description('两轮之间的间隔（分钟），不低于 30。每轮都会调用模型。'),
    activeFrom: Schema.natural().max(23).default(9).volatile(),
    activeTo: Schema.natural().min(1).max(24).default(23).volatile(),
    watchPerRound: Schema.natural().min(1).max(5).default(3).volatile(),
    commentsPerRound: Schema.natural().min(0).max(3).default(1).volatile(),
    send: Schema.boolean().default(false).volatile()
      .description('真实评论（仍需 sendEnabled 且受每日上限、间隔、每视频一次的限制）；关闭时只出草稿。'),
    sessionId: Schema.string().default('bili-fish-explore'),
  }),
  autoReply: Schema.object({
    enabled: Schema.boolean().default(false).volatile()
      .description('自动回复总开关，默认关闭。'),
    videos: Schema.array(Schema.string()).default([]).volatile()
      .description('要巡检的视频 BV 号。'),
    intervalSec: Schema.natural().min(60).max(86400).default(300).volatile()
      .description('巡检间隔（秒），不低于 60。'),
    maxPerRound: Schema.natural().min(1).max(10).default(3).volatile()
      .description('每轮最多交给模型处理的新评论数，其余留到下一轮。'),
    send: Schema.boolean().default(false).volatile()
      .description('真实回复（仍需 sendEnabled 且受频率限制）；关闭时只生成草稿。'),
    skipNames: Schema.array(Schema.string()).default([]).volatile()
      .description('跳过这些昵称的评论。'),
    commentsPerVideo: Schema.natural().min(1).max(30).default(30)
      .description('每个视频每次读取的评论数（B 站默认按热度排序，新评论不一定在前列）。'),
    sessionId: Schema.string().default('bili-fish-autoreply')
      .description('自动回复使用的 DSH 会话 id。'),
  }),
  tts: Schema.object({
    service: Schema.string().default('tts')
      .description('dsh-plugin-tts 注册的 ctx 服务名。'),
    defaultVoice: Schema.string().default('zh-CN-XiaoxiaoNeural').volatile()
      .description('默认 Edge TTS 音色。'),
    outputDir: Schema.string().default('')
      .description('音频输出目录；留空使用系统临时目录。'),
  }),
  voiceFallback: Schema.object({
    enabled: Schema.boolean().default(false).volatile()
      .description('降级路径：上传音频到你的文件服务，再把链接拼进文字评论。默认关闭。'),
    uploadUrl: Schema.string().default('').volatile()
      .description('接收 multipart/form-data 上传的 http(s) 地址。'),
    headers: Schema.dict(Schema.string()).default({})
      .description('上传请求附加的请求头（如鉴权）。只能在 cordis.patch.yml 中配置。'),
    fileField: Schema.string().default('file'),
    urlField: Schema.string().default('url')
      .description('上传响应 JSON 中音频链接所在字段，支持 a.b.c 路径。'),
    template: Schema.string().default('{text} 语音版：{url}').volatile()
      .description('降级时的评论模板，可用 {text} 与 {url}。'),
    timeoutMs: Schema.natural().min(1).default(30000),
  }),
  persona: Schema.object({
    override: Schema.string().default('').volatile(),
    extra: Schema.string().default('').volatile(),
  }),
})

export const Config = ConfigSchema as unknown as Schema<unknown, Config>

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** Cross-field checks Schemastery cannot express. Returns human-readable problems. */
export function configProblems(settings: Settings): string[] {
  const problems: string[] = []
  for (const [key, range] of [['commentLength', settings.commentLength], ['replyLength', settings.replyLength]] as const) {
    if (range.min > range.max) problems.push(`${key}.min (${range.min}) must not exceed ${key}.max (${range.max})`)
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone })
  } catch {
    problems.push(`timeZone "${settings.timeZone}" is not a valid IANA time zone`)
  }
  if (!TOOL_NAME.test(settings.bilibili.replyTool)) {
    problems.push(`bilibili.replyTool "${settings.bilibili.replyTool}" is not a valid tool name`)
  }
  if (settings.bilibili.voiceTool !== '' && !TOOL_NAME.test(settings.bilibili.voiceTool)) {
    problems.push(`bilibili.voiceTool "${settings.bilibili.voiceTool}" is not a valid tool name`)
  }
  for (const name of settings.bilibili.blockDirect) {
    if (!TOOL_NAME.test(name)) problems.push(`bilibili.blockDirect entry "${name}" is not a valid tool name`)
  }
  for (const key of ['commentsTool', 'searchTool', 'hotTool', 'userVideosTool', 'videoInfoTool', 'subtitleTool', 'danmakuTool'] as const) {
    if (!TOOL_NAME.test(settings.bilibili[key])) problems.push(`bilibili.${key} "${settings.bilibili[key]}" is not a valid tool name`)
  }
  const fy = settings.feiyu
  if (fy.baseUrl.trim() !== '') {
    let url: URL | undefined
    try { url = new URL(fy.baseUrl) } catch { problems.push(`feiyu.baseUrl "${fy.baseUrl}" is not a URL`) }
    if (url && url.protocol !== 'http:' && url.protocol !== 'https:') problems.push('feiyu.baseUrl must be http(s)')
  }
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(fy.voice)) problems.push(`feiyu.voice "${fy.voice}" is not a valid voice id`)
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(fy.style)) problems.push(`feiyu.style "${fy.style}" is not a valid style`)
  const ex = settings.explore
  if (ex.activeFrom >= ex.activeTo) problems.push(`explore.activeFrom (${ex.activeFrom}) must be before explore.activeTo (${ex.activeTo})`)
  if (ex.commentsPerRound > ex.watchPerRound) problems.push('explore.commentsPerRound must not exceed explore.watchPerRound')
  if (ex.interests.length > 30 || ex.interests.some(k => k.trim() === '' || k.length > 30)) {
    problems.push('explore.interests: at most 30 keywords, each 1-30 characters')
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ex.sessionId)) problems.push(`explore.sessionId "${ex.sessionId}" must match [A-Za-z0-9_-]{1,64}`)
  if (ex.sessionId === settings.autoReply.sessionId) problems.push('explore.sessionId must differ from autoReply.sessionId')
  for (const v of settings.autoReply.videos) {
    if (!/^BV[0-9A-Za-z]{10}$/.test(v)) problems.push(`autoReply.videos entry "${v}" is not a BV id`)
  }
  if (settings.autoReply.videos.length > 50) problems.push('autoReply.videos supports at most 50 videos')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(settings.autoReply.sessionId)) {
    problems.push(`autoReply.sessionId "${settings.autoReply.sessionId}" must match [A-Za-z0-9_-]{1,64}`)
  }
  if (settings.tts.service.trim() === '') problems.push('tts.service must not be empty')
  if (settings.voiceFallback.enabled) {
    let url: URL | undefined
    try {
      url = new URL(settings.voiceFallback.uploadUrl)
    } catch {
      problems.push('voiceFallback.enabled requires a valid voiceFallback.uploadUrl')
    }
    if (url && url.protocol !== 'https:' && url.protocol !== 'http:') {
      problems.push('voiceFallback.uploadUrl must be http(s)')
    }
    if (!settings.voiceFallback.template.includes('{url}')) {
      problems.push('voiceFallback.template must contain {url}')
    }
  }
  return problems
}

/** Throws so a bad config fails loudly at load. */
export function assertConfig(settings: Settings): void {
  const problems = configProblems(settings)
  if (problems.length > 0) {
    throw new Error(`dsh-plugin-bili-fish: invalid config:\n- ${problems.join('\n- ')}`)
  }
}
