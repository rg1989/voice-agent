# 后台 Skills


后台 Agent 负责执行实际任务，因此标准 Agent Skills（开放格式的
`SKILL.md` 目录）是为后台安装的。`qwenaudio skill` 是社区标准
[skills.sh](https://skills.sh) 安装器（`npx skills`）的品牌入口：每条命令都是
1:1 透传，只有一点不同——安装目标是本机实际存在的后台（CLI 探测）加上
当前配置的后台，而不是依赖 skills.sh 自己的 Agent 探测。

```bash
qwenaudio skill install <来源> --skill <名称>   # 安装到各后台
qwenaudio skill install <来源> --list           # 列出来源中的技能
qwenaudio skill list                            # 列出已安装技能
qwenaudio skill remove <名称>                   # 移除技能
qwenaudio skill update                          # 更新已安装技能
```

支持的来源形式与 skills.sh 一致：

| 来源形式 | 示例 |
| --- | --- |
| GitHub 简写 | `qwenaudio skill install vercel-labs/agent-skills --skill web-design-guidelines` |
| 仓库 URL（GitHub/GitLab/任意 git） | `qwenaudio skill install https://github.com/alirezarezvani/claude-skills --skill skill-security-auditor` |
| Tree URL（技能子目录） | `qwenaudio skill install https://github.com/o/r/tree/main/skills/x --skill x` |
| Hub 技能页 URL | `qwenaudio skill install https://clawhub.ai/thcjp/skills/excel-formula-tool-free --skill excel-formula-tool-free` |
| 本地目录 | `qwenaudio skill install ./my-skill --skill my-skill` |

多技能仓库必须带 `--skill`（重复可装多个）；先用 `--list` 查看来源提供的技能。
刻意不支持一次安装整个大型目录——每个技能描述都会注入后台系统提示词。

技能落到已声明 skills.sh 安装器的后台 CLI 自己的用户级目录（`~/.claude/skills/`、
`~/.qwen/skills/`、`~/.openclaw/skills/`、`~/.agents/skills/` 等），因此直接使用这些
CLI 时也生效，桌面版与 CLI 共享同一套技能。MiniMax Code 的 Skill/Plugin 存储由
其自身管理，当前不会由 `qwenaudio skill` 写入其私有目录。

切换到——或新安装——缺少已安装技能的后台时，Gateway 会在启动时同步补齐：
先对 skills.sh 锁文件（`~/.agents/.skill-lock.json`）做毫秒级本地检查，仅在确实
缺失时才在后台进程启动前跑一次 skills.sh（数秒），保证后台首次扫描即看到完整
技能集。失败（例如离线）只记日志，绝不阻塞语音网关。

Qwen Audio Agent 自带的技能放在仓库的 `skills/` 目录，例如 `media-playback`，
它教后台为 Gateway 媒体工具查找 Netflix、Spotify 和 Stremio 链接。Gateway 每次
启动时不经 skills.sh、不联网，直接把它们复制到 `~/.agents/skills/`（Oh My Pi (omp)、
Codex、OpenCode、Kimi Code 和 DeepSeek 读取该目录）；当前后台有自己的目录时
（`~/.claude/skills/`、`~/.pi/agent/skills/` 等）也复制一份。仅当仓库版本变化时才
重写副本，其他后台目录中由它创建的旧副本也会一并更新；你自己创建的同名目录永远不会被覆盖。

`media-playback` 可以用 TMDB 查询某部影片能否在你所在地区的 Netflix 上观看。要启用这项检查，
在 `~/.config/qwaudio/config.env` 中加入 TMDB API 读取令牌和你所在地区的两位国家代码
（ISO 3166-1，例如 `US`）：

```bash
TMDB_API_READ_TOKEN=<你的 TMDB API 读取令牌>
TMDB_WATCH_REGION=<你的国家代码>
QWEN_AUDIO_AGENT_ACP_FORWARD_ENV=TMDB_API_READ_TOKEN,TMDB_WATCH_REGION
```

未设置 `TMDB_WATCH_REGION` 时，后台会先问你要查询哪个国家。

最后一行供 Oh My Pi (omp) 等通用 ACP 后台使用：Gateway 只把后台目录项允许的环境变量传给后台，
通用 ACP 允许的是 `ACP_*` 以及 `QWEN_AUDIO_AGENT_ACP_FORWARD_ENV` 中列出的名称。其他后台
收不到这个令牌，技能会跳过这项检查。TMDB 查询通过 `curl` 运行，因此在默认的 `native`
权限模式下，后台可能会先询问你。

钉住的 skills.sh 版本可用 `QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE` 覆盖（例如
`skills@latest`）。如果新后台尚未被 skills.sh 支持，可以向它的 `src/agents.ts`
提交 Agent 定义——那是官方扩展点。

### 技能何时生效

文件立即同步，但各后台按自己的节奏发现新技能：

| 后台 | 发现机制 | 新技能可见时机 |
| --- | --- | --- |
| Claude Code、Qwen Code、Hermes、DeepSeek | 热加载（watcher 或按需读取） | 立即，无需操作 |
| Qoder | 会话开始时；原生会话内可 `/skills reload` | 下一个后台会话 |
| OpenCode、OpenClaw、Kimi Code、CodeBuddy、Codex | 进程或会话启动时快照 | 后台进程重启后 |

如果新装的技能没被发现，按[实际运行方式重启 Gateway](../operations/gateway.zh.md#修改配置后生效)，让后台重新加载技能。

### 共享后台 workspace

所有后台现在共享同一个默认工作目录 `<data-dir>/workspace`，切换后台时
无缝衔接同一批文件。按后台覆盖（例如 `OPENCODE_WORKSPACE`）在显式设置时仍然
可以隔离特定后台。
