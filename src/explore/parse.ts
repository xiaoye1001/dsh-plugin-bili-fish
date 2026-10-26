/** One search or trending result, before its BV id is known. */
export interface FoundVideo {
  title: string
  author: string
  uid: string
  /** Paid or live-room entries; exploration skips them. */
  restricted: boolean
}

const PAY = ' [付费]'
const LIVE = ' [直播]'

/**
 * Parse bilibili-mcp-server 1.2.0 `bilibili_search` and `bilibili_hot` text.
 * Both print, per entry:
 *
 *   1. 标题 [付费]
 *      UP主: 名字 (uid:123)
 *      ...
 *
 * Neither prints the BV id; see `matchUploaderVideo`.
 */
export function parseFoundVideos(text: string): FoundVideo[] {
  const out: FoundVideo[] = []
  const entry = /(?:^|\n)\d+\. ([^\n]*)\n\s+UP主: ([^\n]*?) \(uid:(\d+)\)/g
  for (const m of text.matchAll(entry)) {
    let title = (m[1] ?? '').trim()
    let restricted = false
    for (const tag of [PAY, LIVE]) {
      while (title.endsWith(tag)) {
        title = title.slice(0, -tag.length).trimEnd()
        restricted = true
      }
    }
    out.push({ title, author: (m[2] ?? '').trim(), uid: m[3] ?? '', restricted })
  }
  return out
}

export interface UploaderVideo {
  videoId: string
  title: string
}

/** Parse `bilibili_user_videos` text: `1. [BV1xx411c7mD] 标题 (123播放)`. */
export function parseUploaderVideos(text: string): UploaderVideo[] {
  const out: UploaderVideo[] = []
  for (const m of text.matchAll(/(?:^|\n)\d+\. \[(BV[0-9A-Za-z]{10})\] ([^\n]*?) \([^()\n]*播放\)/g)) {
    out.push({ videoId: m[1] ?? '', title: (m[2] ?? '').trim() })
  }
  return out
}

function normalize(title: string): string {
  return title
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
}

/** Find the uploader's video whose title matches a search/trending title. */
export function matchUploaderVideo(title: string, videos: UploaderVideo[]): UploaderVideo | undefined {
  const want = normalize(title)
  if (want === '') return undefined
  return videos.find(v => normalize(v.title) === want)
    ?? videos.find(v => {
      const got = normalize(v.title)
      return got.length >= 6 && want.length >= 6 && (got.includes(want) || want.includes(got))
    })
}

/** Keep the first `max` characters, marking the cut. */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text]
  return chars.length <= max ? { text, truncated: false } : { text: chars.slice(0, max).join('') + '…（已截断）', truncated: true }
}
