# @xiaoye1001/dsh-plugin-bili-fish

“大肥鱼” B 站评论 / 回复 / 语音工具插件，面向 DeepSeek Harness（DSH）0.2.1-rc.2。

函数插件形态（`name` / `inject = ['tools']` / `Config` / `apply`），注册 4 个模型工具。**默认只出草稿，不会写 B 站。**

## 工具

| 工具 | 作用 | 输出 |
| --- | --- | --- |
| `bili_build_prompt` | 返回大肥鱼人格与当前长度约束；模型写正文前先调它 | `{ kind, persona, task, minLength, maxLength, context? }` |
| `bili_comment` | 视频下发评论（15～60 字） | `{ rpid, message }` 或 `{ skipped: true, reason, message? }` |
| `bili_reply` | 回复评论（5～30 字），同一 `parentRpid` 10 分钟内只回一次；楼中楼回复另传 `rootRpid` | 同上；重复时 `{ rpid: "", message: "skipped: already replied" }` |
| `bili_send_voice` | Edge TTS 生成语音并作为语音评论发送 | `{ audioPath, rpid?, message }` 或 `{ skipped: true, reason, message?, audioPath? }` |

`reason` 取值：`rate_limited`、`send_disabled`、`dry_run_not_explicit`、`dependency_missing`、`voice_disabled`、`voice_unsupported`。这些都是正常返回值，不会抛异常。参数错误（字数超限、BV 号不合法）和底层失败（bilibili-mcp 报错、TTS 服务缺失）会抛异常，工具结果标为 `isError`。

## 发送纪律

真实写 B 站需要同时满足：

1. 配置 `sendEnabled: true`（默认 `false`）；
2. 调用时显式传 `dryRun: false`（仅靠 `dryRunByDefault: false` 不够）；
3. 当日未超上限（评论 5 / 回复 10，语音评论计入评论），且距上次真实发送 ≥ `minIntervalMs`（默认且最低 12000）。

计数和去重在插件内存里，**宿主重启后会清零**（在设置页保存不会清零）。真实发送失败时已占用的额度不退回（失败的请求可能已经发出去了）。

## 依赖

- **B 站 MCP 服务**：使用 [`bilibili-mcp-server`](https://www.npmjs.com/package/bilibili-mcp-server)（[GitHub](https://github.com/Iseenope/bilibili-mcp-server)，MIT，已验证 1.2.0）。它是 npm 上唯一能发评论的 B 站 MCP 服务。经 `@deepseek-ai/dsh-mcp-client` 以 `serverName: bilibili` 接入后，本插件调用 `mcp__bilibili__bilibili_reply`（参数 `videoId`、`message`，回复时加 `parentRpid` 和 `rootRpid`）。本插件不自己发 HTTP 请求，登录和 Cookie 由该服务管理，需要环境变量 `BILIBILI_SESSDATA`、`BILIBILI_BILI_JCT`、`BILIBILI_DEDE_USER_ID`（见 `cordis.patch.yml`）。它没有语音评论工具，所以 `bilibili.voiceTool` 默认留空。
- **防止绕过**：插件注册了一个工具守卫，模型不能直接调用 `bilibili_reply`（以及默认列表里的删评论、点赞、投币、收藏、关注、发弹幕等写操作），只能经本插件的工具调用，从而始终受发送开关和频率限制约束。要放开其他写操作，清空 `bilibili.blockDirect`；回复工具始终受保护。
- **TTS**：通过 `ctx.get(tts.service)` 获取一个提供 `synthesize({ text, voice, provider, signal }) => { audio, mime? }` 的服务（契约见 `src/tts.ts`）。找不到时 `bili_send_voice` 抛出“依赖缺失”错误，不会引入第三方 TTS 库。
- `apply()` 时探测上述依赖，缺失只打 warn；草稿功能不受影响。

## 语音发送路径

1. `bilibili.voiceTool` 已配置且可见 → 调它，参数 `{ videoId, audioPath, message }`。
2. 否则若 `voiceFallback.enabled: true`（默认关闭）→ 把音频以 multipart 上传到 `voiceFallback.uploadUrl`，从响应 JSON 的 `urlField` 取链接，按 `template` 拼进文字评论发出。
3. 都不满足 → `{ skipped: true, reason: "voice_unsupported" }`，不会白白合成音频。

## 自动回复（定时巡检）

默认关闭，在设置页「自动回复」里开启。

- **怎么巡检**：每隔一段时间（默认 5 分钟，最短 1 分钟），插件自己调用 `bilibili-mcp-server` 的 `bilibili_video_comments` 读取你填写的视频的评论。这一步不调用模型，不消耗额度。
- **第一次只记录**：某个视频第一次被读取时，只记下已有评论，不会回复积压的旧评论。之后新出现的评论才会处理。插件重启后会重新记录一次，停机期间出现的评论可能被跳过。
- **交给模型**：有新评论时，唤醒一个专用 DSH 会话（默认 id `bili-fish-autoreply`，可以在 DSH 里打开查看），把新评论以 JSON 交给大肥鱼，由它决定回不回、回什么。每轮最多交 3 条，多的留到下一轮；会话还在忙时就等下一轮。
- **安全**：
  - 评论是陌生人写的，可能藏着指令。唤醒前会把这个会话的工具限制成只有 `bili_build_prompt` 和 `bili_reply`；限制不上就不唤醒。
  - 回复仍走 `bili_reply`，所以发送总开关、每日上限、发送间隔和 10 分钟去重全部照常生效。
  - 「真实回复」默认关闭，只生成草稿；打开它并且打开「允许真实发送」才会真的发出去，开启时会弹确认框。
  - 插件自己发的评论、以及「跳过这些昵称」里的昵称不会被回复。
- **限制**：
  - `bilibili_video_comments` 按 B 站默认的热度排序返回，每次最多 30 条。评论多的视频，新评论不一定在第一页，可能被漏掉。
  - `bilibili-mcp-server` 的 `bilibili_detect_replies`（回复通知）不返回评论 id，没法用来定位回复，所以目前只能按视频巡检顶层评论，不处理楼中楼。

## 网页设置页

DSH Web 的设置面板里会多出一页「大肥鱼 · B 站」：

- **今日**：评论 / 回复已用额度、上次真实发送时间、去重中的评论数，以及 bilibili-mcp、TTS、语音评论工具是否可用（每 15 秒刷新）。
- **可直接改**：真实发送总开关（开启时弹确认框）、默认只出草稿、每日上限、发送间隔（≥12 秒）、去重窗口（≥1 分钟）、语音开关与默认音色、降级上传地址与模板、人格补充说明 / 整体替换。
- **只读展示**：时区、字数范围、工具名、TTS 服务名、上传鉴权头——这些仍在 `cordis.patch.yml` 里改。

工作方式：

- 浏览器半在 `src/client/`，打包成 `lib/client.js`，由 `package.json` 的 `dsh.client` 声明加载，注册到 `settings.section` 插槽。
- 主进程半在 `src/panel/host.ts`，用 `ctx.connection.fetch.register` 在 DSH 自己的 `/api` 下注册两个接口：`POST /api/bili-fish/state`、`/save` 和 `/check`（立即巡检一次），复用 DSH 网页的登录态。业务失败一律返回 `{ ok: false, error: { code, message, details } }`。
- 没有用 `connection.rpc.handle` 新开顶层通道：那需要插件能看到 `webServer` 服务，而 profile 里安装的插件看不到它（启动时报 `cannot get property "webServer" without inject`，页面得到 405）。
- 保存经 `ctx.settings.update(<entry id>, patch, revision)` 写入当前 profile 的 `cordis.patch.yml`。可编辑的字段都是 `.volatile()`，保存后原地生效、**不重载插件**，所以当日计数和去重不会被清零。
- 主进程对 patch 做白名单 + 类型 + 下限校验，客户端也会提前提示；revision 不一致时返回 `conflict`，页面会重新加载。
- 缺少 `@deepseek-ai/dsh-settings`，或条目被 home 层 / `--patch` 覆盖时，页面变为只读并说明原因。工具本身不依赖设置页。

## 人格

`src/persona.ts` 导出 `FISH_PERSONA` 字符串常量，由 `bili_build_prompt` 交给模型。不改代码也能调语气：`persona.override` 整体替换，`persona.extra` 追加。

## 开发

```bash
npm install
npm test             # 构建 + 36 个测试（真实 Cordis + dsh-tools 注册表，假 MCP / TTS / settings；
                     # 设置页在 Chromium 里用真实 React 跑一遍，截图在 artifacts/）
npm run typecheck
```

本地联调：把 `cordis.patch.yml` 里的 `/ABSOLUTE/PATH` 改成你的路径，导出上面三个 `BILIBILI_*` 环境变量，然后：

```bash
npm run build
dsh web --patch /absolute/path/to/dsh-plugin-bili-fish/cordis.patch.yml
```

打包安装：`bundle.patch.yml` 是 `dsh.bundle` 层（按包名引用）。

```bash
dsh plugin --profile web add ./dsh-plugin-bili-fish   # 或 npm pack 后 add .tgz
dsh --profile web --dump-config                        # 确认出现 bili-fish 行
```

## 配置

完整字段与默认值见 `src/config.ts`。常用：

```yaml
- id: bili-fish
  config:
    sendEnabled: false
    dryRunByDefault: true
    maxCommentsPerDay: 5
    maxRepliesPerDay: 10
    minIntervalMs: 12000
    voiceEnabled: true
    timeZone: Asia/Shanghai
```

注意 patch 是整行替换 `config`，覆盖时要写全你需要的键。
