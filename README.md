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

- **B 站 MCP 服务**：使用 [`bilibili-mcp-server`](https://www.npmjs.com/package/bilibili-mcp-server)（[GitHub](https://github.com/Iseenope/bilibili-mcp-server)，MIT，已验证 1.2.0）。它是 npm 上唯一能发评论的 B 站 MCP 服务。经 `@deepseek-ai/dsh-mcp-client` 以 `serverName: bilibili` 接入后，本插件调用 `mcp__bilibili__bilibili_reply`（参数 `videoId`、`message`，回复时加 `parentRpid` 和 `rootRpid`）。本插件不自己发 HTTP 请求，登录和 Cookie 由该服务管理，登录信息在设置页「B 站登录」里填写（见下）。它没有语音评论工具，所以 `bilibili.voiceTool` 默认留空。
- **防止绕过**：插件注册了一个工具守卫，模型不能直接调用 `bilibili_reply`（以及默认列表里的删评论、点赞、投币、收藏、关注、发弹幕等写操作），只能经本插件的工具调用，从而始终受发送开关和频率限制约束。要放开其他写操作，清空 `bilibili.blockDirect`；回复工具始终受保护。
- **TTS**：通过 `ctx.get(tts.service)` 获取一个提供 `synthesize({ text, voice, provider, signal }) => { audio, mime? }` 的服务（契约见 `src/tts.ts`）。找不到时 `bili_send_voice` 抛出“依赖缺失”错误，不会引入第三方 TTS 库。
- `apply()` 时探测上述依赖，缺失只打 warn；草稿功能不受影响。

## 语音发送路径

1. `bilibili.voiceTool` 已配置且可见 → 调它，参数 `{ videoId, audioPath, message }`。
2. 否则若 `voiceFallback.enabled: true`（默认关闭）→ 把音频以 multipart 上传到 `voiceFallback.uploadUrl`，从响应 JSON 的 `urlField` 取链接，按 `template` 拼进文字评论发出。
3. 都不满足 → `{ skipped: true, reason: "voice_unsupported" }`，不会白白合成音频。

## 肥鱼声音（说话 / 换声 / 按谱唱歌）

移植自 [Esmerubphire/astrbot_plugin_feiyu_voice](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice) 的 AstrBot 插件：对接同一个**肥鱼声音服务**的 HTTP 接口（`/v1/speech`、`/v1/voice-conversion`、`/v1/singing`、`/v1/jobs`）。这里是按该接口重新编写的 TypeScript 客户端，没有包含原项目的代码；声音服务、模型和它们的授权都留在原项目里，需要按原项目说明另行部署（默认 `http://127.0.0.1:9880`）。

声库原始音频素材来自 B 站 UP 主 [星落落_oi](https://space.bilibili.com/30584746/)，据原项目说明已取得授权用于其声库训练。

| AstrBot 原版 | 本插件 |
|---|---|
| `/肥鱼状态` | 工具 `feiyu_status`；设置页「测试连接」 |
| `feiyu_speak` | `feiyu_speak(text, style)`：等待生成，保存 WAV，返回文件路径 |
| `feiyu_convert`（消息附件） | `feiyu_convert(file)`：只能读取**收件夹**里的 .wav / .flac |
| `feiyu_sing`（消息附件） | `feiyu_sing(file, lyrics)`：只能读取**收件夹**里的 .mid / .midi / .abc |
| `/肥鱼任务` | `feiyu_job(jobId)`：超过等待时间的任务之后取回 |
| — | 作为 `bili_send_voice` 的语音引擎（`feiyu.useForBiliVoice`，默认开） |

- **配置**：设置页「肥鱼声音」填写服务地址、API Key、默认风格（`cute` 可爱 / `gentle` 温柔）、声音 ID（默认 `feiyu`）、最多等待秒数（默认 180）。
- **API Key**：保存在 `~/.dsh/bili-fish/feiyu.json`（权限 600），不回显，不写进 `cordis.patch.yml`。
- **收件夹**：DSH 没有聊天附件，换声和唱歌改为读取 `~/.dsh/bili-fish/voice-inbox/` 里的文件；路径会解析软链接，跑出收件夹的一律拒绝，模型不能把本机其它文件传给服务。生成的音频保存在 `~/.dsh/bili-fish/voice-out/`。
- **校验**：只认 32 位十六进制任务编号；下载的音频必须是 RIFF/WAV 且不超过 128 MB；不跟随重定向。

### 部署声音服务

完整步骤以原项目的 [`server/INSTALL_AGENT.md`](https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice/blob/main/server/INSTALL_AGENT.md) 为准。官方只支持 NVIDIA CUDA 和 AMD ROCm 显卡；最稳的做法是在有显卡的电脑上跑服务，再用 SSH 反向隧道接到服务器：

```bash
# 在有显卡的电脑上执行，把服务器的 127.0.0.1:9880 接到本机服务
ssh -N -R 9880:127.0.0.1:9880 root@你的服务器
```

服务跑起来后，在设置页「肥鱼声音」填 `http://127.0.0.1:9880` 和 `.runtime/voice-service/api_key.txt` 里的 API Key，点「测试连接」。

### 只有 CPU 的服务器（非官方）

原项目的推理代码接受 `backend: "cpu"`，TTS 依赖里也没有显卡专用包；只是安装器没开放这个选项，也没有 CPU 预设。下面的改法**没有经过原项目验证，也没在本插件实测**，出问题请别去原项目报 bug。

**先看机器够不够。** 只装「说话」（TTS），换声和唱歌在 CPU 上太慢，不要装。

| 配置 | 结论 |
|---|---|
| 2 核 / ≤ 4G | 不建议 |
| 4 核 / 4G | 能试，但**必须加 swap**，和 DSH 抢内存，一条语音估计几分钟 |
| 4 核以上 / 8G 以上 | 比较现实，一条短句估计 1～3 分钟 |

服务每个任务都会新起一个进程重新加载模型，所以每条语音都要加上加载时间；代码里固定用 4 个线程，核数再多也不会更快。B 站语音一天只发几条，慢一点能接受。

**1. 4G 内存先加 swap**（已有足够 swap 可跳过）：

```bash
sudo fallocate -l 6G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # Swap 一行应显示 6.0Gi
```

**2. 准备 Python 3.11 和源码**（不要替换系统 Python）：

```bash
sudo apt install -y git git-lfs ffmpeg build-essential
curl -LsSf https://astral.sh/uv/install.sh | sh   # 已装 uv 可跳过
uv python install 3.11.17
git clone https://github.com/Esmerubphire/astrbot_plugin_feiyu_voice.git
cd astrbot_plugin_feiyu_voice/server
```

**3. 让安装器认 CPU**：新建 `runtime_profiles/cpu.json`：

```json
{
  "schema": "feiyu-environment-preset-v1",
  "backend": "cpu",
  "python": "3.11",
  "torch_index": "https://download.pytorch.org/whl/cpu",
  "engines": {
    "tts": {"torch": "2.11.0+cpu", "torchaudio": "2.11.0+cpu", "precision": "float32", "torchcodec": "0.11.0+cpu"}
  },
  "hardware_validation": "CPU, unofficial"
}
```

再把 `cpu` 加进安装器的可选后端（以后 `git pull` 会被覆盖，需要重做）：

```bash
sed -i 's/choices=("cuda", "rocm")/choices=("cuda", "rocm", "cpu")/' scripts/setup_runtime.py
```

**4. 安装 TTS 推理环境**：

```bash
feiyu_python="$(uv python find 3.11.17)"
"$feiyu_python" scripts/setup_runtime.py --backend cpu --engine tts \
  --python "$feiyu_python" --destination "$HOME/.local/share/feiyu-voice/cpu/tts"
cp "$HOME/.local/share/feiyu-voice/cpu/tts/runtime.local.json" configs/runtime.tts.cpu.local.json
```

最后的诊断会在 CPU 上跑一遍矩阵、卷积和 FFT，通过才算装好。

**5. 下载模型**到 `models/FeiyuVoice-CosyVoice3`（[Hugging Face](https://huggingface.co/Esmerubphire/FeiyuVoice-CosyVoice3) / 国内用 [ModelScope](https://modelscope.cn/models/Esmerubphire/FeiyuVoice-CosyVoice3)），保持包内目录结构：

```bash
git lfs install
git clone https://www.modelscope.cn/Esmerubphire/FeiyuVoice-CosyVoice3.git models/FeiyuVoice-CosyVoice3
```

**6. 写服务配置** `configs/voice_service.json`，只留 TTS：

```json
{
  "schema": "feiyu-voice-service-v1",
  "data_dir": ".runtime/voice-service",
  "max_queue": 4,
  "max_upload_mb": 128,
  "tts": {
    "feiyu": {
      "engine": "cosyvoice3_release",
      "package": "models/FeiyuVoice-CosyVoice3",
      "runtime_profile": "configs/runtime.tts.cpu.local.json"
    }
  },
  "rvc": {},
  "singing": null
}
```

**7. 安装并启动 API**（API 自己是单独的轻量环境）：

```bash
"$feiyu_python" -m venv .venv
.venv/bin/python -m pip install -r requirements-service.txt
.venv/bin/python -m feiyu_voice_service --config configs/voice_service.json --host 127.0.0.1 --port 9880
```

只监听 `127.0.0.1`，不要对公网开放。需要常驻可以写成 systemd 服务或放进 `tmux`。

**8. 插件设置页**「肥鱼声音」：

- 服务地址 `http://127.0.0.1:9880`，API Key 填 `.runtime/voice-service/api_key.txt` 的内容，点「测试连接」。
- **最多等待调到 600 秒**（4 核 4G 建议值；默认 180 秒在 CPU 上多半等不完）。超时的任务服务端还会继续跑（上限 30 分钟），之后可以用 `feiyu_job` 取回。
- 先用 `feiyu_speak` 说一句短话试试，看 `.runtime/voice-service/jobs/<任务编号>/worker.log` 有没有内存不足被杀；`dmesg | grep -i oom` 也能看到。

## B 站登录

设置页「B 站登录」有三个输入框：SESSDATA、bili_jct、DedeUserID（浏览器登录 bilibili.com 后，F12 → Application → Cookies 里复制）。

- **存在哪**：写进 `~/.dsh/bili-fish/cookie.json`（若设了 `DSH_HOME` 则在其下；可用 `bilibili.cookieFile` 改路径）。文件权限 600、目录 700，原子替换。格式就是 `bilibili-mcp-server` 读取并在自动刷新时回写的格式，所以刷新后的登录也会留在这里。
- **不回显**：页面只显示每项“已设置 / 未设置”和 uid，密钥值不会发回浏览器，也不写进 `cordis.patch.yml`。留空的输入框表示不修改。
- **让服务读这个文件**（只需一次）：`mcp-bilibili` 条目的 `env` 只写 `BILIBILI_COOKIE_FILE: '<上面的路径>'`，删掉 `BILIBILI_SESSDATA` 等三项（环境变量会覆盖文件）。设置页里有可以直接复制的配置片段。
- **生效**：`bilibili-mcp-server` 只在启动时读取一次登录信息，`dsh-mcp-client` 也没有热重连接口，所以保存或清除后需要重启 DSH。

## 自己逛（找视频、看视频、评论）

默认关闭，在设置页「自己逛」里开启。

- **怎么逛**：每隔一段时间（默认 3 小时，最短 30 分钟），并且只在活跃时段内（默认 9～23 点），唤醒专用 DSH 会话 `bili-fish-explore`。把你填的兴趣关键词轮流交给大肥鱼（留空就逛热门），它自己：
  1. 用 `bili_discover` 找候选视频；
  2. 挑真正好奇的，用 `bili_watch_video` 看（每轮最多 3 个）；
  3. 只在真有话想说时，用 `bili_comment` 评论（每轮最多 1 条，可设为 0 只看不评）。
- **“看视频”是什么**：读取标题简介和数据、字幕（视频里说了什么）、弹幕和热门评论（观众反应）。模型看不到画面；没有字幕的视频只能根据简介、弹幕和评论理解个大概。
- **新工具**：
  - `bili_discover(keyword?)`：搜索或看热门。`bilibili-mcp-server` 的搜索和热门结果不带 BV 号，所以插件会去查对应 UP 主最近的视频，按标题匹配出 BV 号；付费、直播内容和匹配不上的会跳过。每次最多查 2×候选数 个 UP 主。
  - `bili_watch_video(videoId)`：一次取齐信息、字幕、弹幕、热门评论，各自限长；某一部分失败只标注失败，不影响其它部分。
- **安全与克制**：
  - 视频里的文字都是网友写的。唤醒前会把会话工具限制成只有 `bili_discover`、`bili_watch_video`、`bili_build_prompt`、`bili_comment`；限制不上就不唤醒。
  - 「真实评论」默认关闭，只出草稿；打开它且打开「允许真实发送」才会真的发，开启时会弹确认框。
  - 照常受每日评论上限（默认 5 条）和发送间隔约束；另外**同一个视频 7 天内只评论一次**（对所有评论生效，可调）。
  - 自动在陌生人视频下评论可能被 B 站判定为刷屏，导致限流或封号。建议先只出草稿看几天，再小量开启。
- **成本**：和自动回复不同，每一轮都会调用模型，消耗额度。

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
- 主进程半在 `src/panel/host.ts`，用 `ctx.connection.fetch.register` 在 DSH 自己的 `/api` 下注册两个接口：`POST /api/bili-fish/state`、`/save`、`/check`（立即巡检一次）、`/explore`（现在去逛一次）、`/login` 和 `/logout`（保存 / 清除登录信息），复用 DSH 网页的登录态。业务失败一律返回 `{ ok: false, error: { code, message, details } }`。
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
