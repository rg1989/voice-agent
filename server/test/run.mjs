import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// 测试跑的是「出厂默认」，不是跑测试那台机器上的配置。
//
// Gateway 启动时会读 ~/.config/qwaudio/config.env 和 ASSISTANT.md，而测试进程
// 走的是同一条加载路径。于是开发者把模型换成 Qwen3.5 Omni、把人设文件改成英文
// 之后，断言出厂 Qwen Audio Realtime 行为的用例就开始失败 —— 代码没问题，是
// 这台机器的配置漏进来了。给每次运行一个空的配置目录，套件就只看得到默认值。

const directory = mkdtempSync(join(tmpdir(), 'qwaudio-test-config-'))
try {
  const result = spawnSync(
    process.execPath,
    ['--test', ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, QWAUDIO_CONFIG_DIR: directory } },
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(directory, { recursive: true, force: true })
}
