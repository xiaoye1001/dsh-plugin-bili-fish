# @xiaoye1001/dsh-plugin-bili-fish

“大肥鱼” B 站评论 / 回复 / 语音工具插件，面向 DeepSeek Harness（DSH）0.2.1-rc.3。

函数插件形态（`name` / `inject = ['tools']` / `Config` / `apply`），注册 4 个模型工具。**默认只出草稿，不会写 B 站。**

## 工具

| 工具 | 作用 | 输出 |
| --- | --- | --- |
| `bili_build_prompt` | 返回大肥鱼人格与当前长度约束；模型写正文前先调它 | `{ kind, persona, task, minLength, maxLength, context? }` |
| `bili_comment` | 视频下发评论（15～60 字） | `{ rpid, message }` 或 `{ skipped: true, reason, message? }` |
| `bili_reply` | 回复评论（5～30 字），同一 `parentRpid` 10 分钟内只回一次 | 同上；重复时 `{ rpid: "", message: "skipped: already replied" }` |
| `bili_send_voice` | Edge TTS 生成语音并作为语音评论发送 | `{ audioPath, rpid?, message }` 或 `{ skipped: true, reason, message?, audioPath? }` |

`reason` 取值：`rate_limited`、`send_disabled`、`dry_run_not_explicit`、`dependency_missing`、`voice_disabled`、`voice_unsupported`。这些都是正常返回值，不会抛异常。参数错误（字数超限、BV 号不合法）和底层失败（bilibili-mcp 报错、TTS 服务缺失）会抛异常，工具结果标为 `isError`。

## 发送纪律

真实写 B 站需要同时满足：

1. 配置 `sendEnabled: true`（默认 `false`）；
2. 调用时显式传 `dryRun: false`（仅靠 `dryRunByDefault: false` 不够）；
3. 当日未超上限（评论 5 / 回复 10，语音评论计入评论），且距上次真实发送 ≥ `minIntervalMs`（默认且最低 12000）。

计数和去重在插件内存里，**宿主重启后会清零**（在设置页保存不会清零）。真实发送失败时已占用的额度不退回（失败的请求可能已经发出去了）。

## 依赖

- **bilibili-mcp**：本插件不自己发 HTTP 请求，所有 B 站写操作都经 `ctx.tools.execute()` 调用 `@deepseek-ai/dsh-mcp-client` 桥接出来的 `mcp__bilibili__bili_reply`（参数 `videoId`、`message`、可选 `parentRpid`）。工具名可通过 `bilibili.replyTool` 改。
- **TTS**：通过 `ctx.get(tts.service)` 获取一个提供 `synthesize({ text, voice, provider, signal }) => { audio, mime? }` 的服务（契约见 `src/tts.ts`）。找不到时 `bili_send_voice` 抛出“依赖缺失”错误，不会引入第三方 TTS 库。
- `apply()` 时探测上述依赖，缺失只打 warn；草稿功能不受影响。

## 语音发送路径

1. `bilibili.voiceTool` 已配置且可见 → 调它，参数 `{ videoId, audioPath, message }`。
2. 否则若 `voiceFallback.enabled: true`（默认关闭）→ 把音频以 multipart 上传到 `voiceFallback.uploadUrl`，从响应 JSON 的 `urlField` 取链接，按 `template` 拼进文字评论发出。
3. 都不满足 → `{ skipped: true, reason: "voice_unsupported" }`，不会白白合成音频。

## 网页设置页

DSH Web 的设置面板里会多出一页「大肥鱼 · B 站」：

- **今日**：评论 / 回复已用额度、上次真实发送时间、去重中的评论数，以及 bilibili-mcp、TTS、语音评论工具是否可用（每 15 秒刷新）。
- **可直接改**：真实发送总开关（开启时弹确认框）、默认只出草稿、每日上限、发送间隔（≥12 秒）、去重窗口（≥1 分钟）、语音开关与默认音色、降级上传地址与模板、人格补充说明 / 整体替换。
- **只读展示**：时区、字数范围、工具名、TTS 服务名、上传鉴权头——这些仍在 `cordis.patch.yml` 里改。

工作方式：

- 浏览器半在 `src/client/`，打包成 `lib/client.js`，由 `package.json` 的 `dsh.client` 声明加载，注册到 `settings.section` 插槽。
- 主进程半在 `src/panel/host.ts`，通过 Connection RPC 通道 `/bili-fish` 提供 `state` / `save` 两个端点，失败一律返回 `{ ok: false, error: { code, message, details } }`。
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

本地联调：把 `cordis.patch.yml` 里的 `/ABSOLUTE/PATH` 和 bilibili-mcp 包名改成你的，然后：

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
