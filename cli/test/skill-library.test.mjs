import assert from 'node:assert/strict'
import test from 'node:test'
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  addSkills,
  ensureBackendSkills,
  ensureBundledSkills,
  listSkills,
  presentInstallerAgents,
  readSkillLock,
  removeSkill,
  runSkillsCli,
  skillsCliPackage,
  updateSkills,
} from '../../shared/skill-library.mjs'
import {
  backendDefinitions,
  backendSkillsSpec,
  skillsInstallerAgents,
  validateBackendSkillsSpec,
} from '../../shared/backend/catalog.mjs'

function fakeSpawn({ status = 0, stdout = '', stderr = '', error } = {}) {
  const calls = []
  const spawn = args => {
    calls.push(args)
    return { status, stdout, stderr, error }
  }
  return { calls, spawn }
}

test('runs the pinned skills.sh package through npx argv', () => {
  const target = fakeSpawn({ stdout: 'ok\n' })
  const result = runSkillsCli(['list', '-g'], { spawn: target.spawn })
  assert.deepEqual(target.calls, [['-y', skillsCliPackage(), 'list', '-g']])
  assert.equal(result.stdout, 'ok\n')

  // 版本可用环境变量覆盖（对齐 *_PACKAGE 惯例）。
  assert.equal(
    skillsCliPackage({ QWEN_AUDIO_AGENT_SKILLS_CLI_PACKAGE: 'skills@9.9.9' }),
    'skills@9.9.9',
  )
  assert.match(skillsCliPackage({}), /^skills@\d/)
})

test('surfaces skills.sh failures with stderr detail', () => {
  const failed = fakeSpawn({ status: 1, stderr: 'repository not found' })
  assert.throws(
    () => runSkillsCli(['add', 'missing/repo'], { spawn: failed.spawn }),
    /repository not found/,
  )
  const broken = fakeSpawn({ error: new Error('spawn npx ENOENT') })
  assert.throws(
    () => runSkillsCli(['list'], { spawn: broken.spawn }),
    /skills CLI 启动失败/,
  )
})

test('installs to every backend installer agent explicitly', () => {
  const target = fakeSpawn({ stdout: 'installed\n' })
  addSkills('alirezarezvani/claude-skills', {
    skills: ['skill-security-auditor', 'playwright-pro'],
    spawn: target.spawn,
  })
  const args = target.calls[0]
  assert.equal(args[2], 'add')
  assert.equal(args[3], 'alirezarezvani/claude-skills')
  // 技能多选。
  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '--skill'),
    ['skill-security-auditor', 'playwright-pro'],
  )
  // 全局安装、拷贝模式（规避 symlink 兼容性问题）、非交互。
  for (const flag of ['-g', '--copy', '-y']) {
    assert.ok(args.includes(flag), `missing ${flag}`)
  }
  // 缺省回退 catalog installer 全名单。
  const agents = args.filter((value, index) => args[index - 1] === '-a')
  assert.deepEqual(agents.sort(), [...skillsInstallerAgents()].sort())
  assert.ok(agents.includes('hermes-agent'))
  assert.ok(agents.includes('openclaw'))
  assert.ok(agents.includes('pi'))
  // deepseek 暂无 skills.sh 安装器（经 ~/.agents/skills 被动受益）。
  assert.equal(agents.length, 10)

  // 传入 agents 时只装给指定后台（“本机存在 ∪ 当前”名单）。
  const narrowed = fakeSpawn({ stdout: 'installed\n' })
  addSkills('owner/repo', {
    skills: ['review'],
    agents: ['claude-code'],
    spawn: narrowed.spawn,
  })
  assert.deepEqual(
    narrowed.calls[0].filter((value, index) => (
      narrowed.calls[0][index - 1] === '-a'
    )),
    ['claude-code'],
  )
})

test('lists remote skills without installing', () => {
  const target = fakeSpawn({ stdout: 'skill-a\nskill-b\n' })
  const result = addSkills('vercel-labs/skills', {
    list: true,
    spawn: target.spawn,
  })
  assert.deepEqual(
    target.calls,
    [['-y', skillsCliPackage(), 'add', 'vercel-labs/skills', '--list']],
  )
  assert.match(result.stdout, /skill-a/)
})

test('requires --skill for installs and a non-empty source', () => {
  const target = fakeSpawn()
  assert.throws(
    () => addSkills('owner/repo', { spawn: target.spawn }),
    /--skill/,
  )
  assert.throws(() => addSkills('', { spawn: target.spawn }), /来源/)
  assert.equal(target.calls.length, 0)
})

test('passes list, remove and update straight through in global scope', () => {
  const target = fakeSpawn({ stdout: 'done\n' })
  listSkills({ spawn: target.spawn })
  removeSkill('pdf-tools', { spawn: target.spawn })
  updateSkills({ spawn: target.spawn })
  assert.deepEqual(target.calls.map(args => args.slice(2)), [
    ['list', '-g'],
    ['remove', 'pdf-tools', '-g', '-y'],
    ['update', '-g'],
  ])
  assert.throws(() => removeSkill('', { spawn: target.spawn }), /名称/)
})

test('every backend definition declares its skills contract', () => {
  for (const definition of backendDefinitions()) {
    assert.doesNotThrow(() => validateBackendSkillsSpec(definition))
  }
  // acp 是通用接入方式无技能约定；deepseek 暂无 skills.sh 安装器。
  assert.equal(backendSkillsSpec('acp'), null)
  assert.deepEqual(backendSkillsSpec('deepseek'), { installer: null })
  assert.deepEqual(backendSkillsSpec('claude'), { installer: 'claude-code' })
  assert.deepEqual(backendSkillsSpec('pi'), { installer: 'pi' })

  assert.throws(
    () => validateBackendSkillsSpec({ id: 'future' }),
    /缺少 skills 声明/,
  )
  for (const installer of ['', 'Bad Name', 'UPPER', 'has space', '-lead', 'a--b']) {
    assert.throws(
      () => validateBackendSkillsSpec({ id: 'future', skills: { installer } }),
      /installer 无效/,
    )
  }
  assert.doesNotThrow(() => validateBackendSkillsSpec({
    id: 'future',
    skills: { installer: 'new-agent-cli' },
  }))
})

function lockFixture(skills) {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'qwaudio-skill-home-'))
  if (skills) {
    mkdirSync(resolve(homeDirectory, '.agents'), { recursive: true })
    writeFileSync(
      resolve(homeDirectory, '.agents/.skill-lock.json'),
      JSON.stringify({ version: 3, skills }),
    )
  }
  return homeDirectory
}

function placeSkill(homeDirectory, directory, name) {
  const skillDirectory = resolve(homeDirectory, directory, name)
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(resolve(skillDirectory, 'SKILL.md'), '---\nname: x\n---\n')
}

test('reads the skills.sh lockfile defensively', () => {
  const empty = lockFixture(null)
  assert.deepEqual(readSkillLock({ homeDirectory: empty }), {})
  const filled = lockFixture({ review: { source: 'owner/repo' } })
  assert.deepEqual(
    Object.keys(readSkillLock({ homeDirectory: filled })),
    ['review'],
  )
})

test('backfills missing skills for the active backend synchronously', () => {
  const homeDirectory = lockFixture({
    review: { source: 'owner/repo' },
    'pdf-tools': { source: 'owner/repo' },
    remote: { sourceUrl: 'https://github.com/o/r.git' },
  })
  // 当前后台（qwen → ~/.qwen/skills）已有 review，缺另外两个。
  placeSkill(homeDirectory, '.qwen/skills', 'review')

  const target = fakeSpawn({ stdout: 'ok\n' })
  const result = ensureBackendSkills({
    protocol: 'qwen',
    homeDirectory,
    spawn: target.spawn,
  })
  assert.equal(result.refreshed, true)
  assert.equal(result.installer, 'qwen-code')
  assert.deepEqual(result.installed.sort(), ['pdf-tools', 'remote'])
  // 按来源分组：两个来源各一条命令，均只面向当前后台。
  assert.equal(target.calls.length, 2)
  for (const args of target.calls) {
    assert.deepEqual(
      args.filter((value, index) => args[index - 1] === '-a'),
      ['qwen-code'],
    )
  }
  assert.deepEqual(
    target.calls[0].filter((value, index) => (
      target.calls[0][index - 1] === '--skill'
    )),
    ['pdf-tools'],
  )
})

test('isolates per-source backfill failures with cleanup guidance', () => {
  const homeDirectory = lockFixture({
    gone: { source: 'owner/stale-repo' },
    review: { source: 'owner/live-repo' },
  })
  const calls = []
  const spawn = args => {
    calls.push(args)
    // 旧源里的技能已被上游移除 → 该源失败；另一源正常。
    return args.includes('owner/stale-repo')
      ? { status: 1, stdout: '', stderr: 'No matching skills found' }
      : { status: 0, stdout: 'ok\n', stderr: '' }
  }
  const result = ensureBackendSkills({ protocol: 'claude', homeDirectory, spawn })
  assert.equal(result.refreshed, true)
  assert.deepEqual(result.installed, ['review'])
  assert.equal(result.failures.length, 1)
  assert.deepEqual(result.failures[0].names, ['gone'])
  assert.match(result.failures[0].hint, /skill remove/)
  assert.equal(calls.length, 2)
})

test('skips backfill when nothing is missing or unsupported', () => {
  const target = fakeSpawn()
  // 无安装器（deepseek/纯前台）。
  assert.equal(
    ensureBackendSkills({ protocol: 'deepseek', spawn: target.spawn }).reason,
    'no-installer',
  )
  assert.equal(
    ensureBackendSkills({ protocol: '', spawn: target.spawn }).reason,
    'no-installer',
  )
  // lock 为空。
  const empty = lockFixture(null)
  assert.equal(
    ensureBackendSkills({
      protocol: 'qwen',
      homeDirectory: empty,
      spawn: target.spawn,
    }).reason,
    'up-to-date',
  )
  // 技能齐全。
  const ready = lockFixture({ review: { source: 'owner/repo' } })
  placeSkill(ready, '.claude/skills', 'review')
  assert.equal(
    ensureBackendSkills({
      protocol: 'claude',
      homeDirectory: ready,
      spawn: target.spawn,
    }).reason,
    'up-to-date',
  )
  assert.equal(target.calls.length, 0)
})

test('uses Pi\'s global skill directory for backfill checks', () => {
  const homeDirectory = lockFixture({ review: { source: 'owner/repo' } })
  placeSkill(homeDirectory, '.pi/agent/skills', 'review')
  const target = fakeSpawn()
  assert.equal(
    ensureBackendSkills({ protocol: 'pi', homeDirectory, spawn: target.spawn }).reason,
    'up-to-date',
  )
  assert.equal(target.calls.length, 0)
})

test('builds the present-backend installer list with fallback', () => {
  // 检测到的后台 ∪ 当前后台，去重且排除无安装器后台。
  assert.deepEqual(
    presentInstallerAgents({
      readyBackends: ['claude', 'opencode', 'deepseek', 'acp'],
      currentProtocol: 'opencode',
    }).sort(),
    ['claude-code', 'opencode'],
  )
  // 当前后台未装 CLI 也必须在名单（openclaw npx 托管场景）。
  assert.deepEqual(
    presentInstallerAgents({ readyBackends: [], currentProtocol: 'openclaw' }),
    ['openclaw'],
  )
  // 一个都没有时回退全名单。
  assert.deepEqual(
    presentInstallerAgents({ readyBackends: [], currentProtocol: '' }).sort(),
    [...skillsInstallerAgents()].sort(),
  )
})

const repositoryRoot = resolve(import.meta.dirname, '../..')

test('the bundled media-playback skill names itself and covers each service and the privacy rules', () => {
  const text = readFileSync(resolve(repositoryRoot, 'skills/media-playback/SKILL.md'), 'utf8')
  const frontmatter = text.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/)
  assert.ok(frontmatter, 'SKILL.md starts with name and description frontmatter')
  assert.equal(frontmatter[1], 'media-playback')
  assert.ok(frontmatter[2].length <= 1024)
  for (const required of [
    'qwen_audio_agent_media_play',
    'qwen_audio_agent_media_control',
    'TMDB_API_READ_TOKEN',
    'URL reading tool',
    'may ask the user for permission',
    'TMDB_WATCH_REGION',
    'results.<TMDB_WATCH_REGION>.flatrate',
    'ask the user which country',
    'P1874',
    'https://www.netflix.com/watch/',
    'open.spotify.com',
    'spotify:<type>:<id>',
    'Never use the Spotify Web API',
    'v3-cinemeta.strem.io',
    'stremio:///detail/',
    'share the link',
    'Never read browser cookies',
  ]) {
    assert.ok(text.includes(required), `SKILL.md mentions ${required}`)
  }
  // The skill is public: the Netflix region is a setting, never one country.
  assert.equal(/results\.[A-Z]{2}\./.test(text), false, 'SKILL.md reads no fixed region code')
  assert.ok(/^## Netflix\n/m.test(text), 'the Netflix heading names no country')
})

function bundledRoot(skills) {
  const root = mkdtempSync(join(tmpdir(), 'qwaudio-bundled-root-'))
  for (const [name, files] of Object.entries(skills)) {
    for (const [file, content] of Object.entries(files)) {
      const path = resolve(root, 'skills', name, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
  }
  return root
}

test('copies repository skills into ~/.agents/skills, which omp reads, and skips unchanged copies', () => {
  const root = bundledRoot({
    'media-playback': {
      'SKILL.md': '---\nname: media-playback\n---\n',
      'references/netflix.md': 'ids',
    },
  })
  const homeDirectory = lockFixture(null)
  const target = resolve(homeDirectory, '.agents/skills/media-playback')
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'acp', homeDirectory }),
    { installed: [target], skipped: [] },
  )
  assert.equal(readFileSync(resolve(target, 'SKILL.md'), 'utf8'), '---\nname: media-playback\n---\n')
  assert.equal(readFileSync(resolve(target, 'references/netflix.md'), 'utf8'), 'ids')
  // Never ~/.omp/agent/skills: setup-bundle imports would roll it back.
  assert.equal(existsSync(resolve(homeDirectory, '.omp')), false)
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'acp', homeDirectory }),
    { installed: [], skipped: [] },
  )
})

test('also installs into the active backend\'s own skill folder, once per folder', () => {
  const root = bundledRoot({ 'media-playback': { 'SKILL.md': 'v1' } })
  const claudeHome = lockFixture(null)
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'claude', homeDirectory: claudeHome }).installed,
    [
      resolve(claudeHome, '.agents/skills/media-playback'),
      resolve(claudeHome, '.claude/skills/media-playback'),
    ],
  )
  // Codex already reads ~/.agents/skills.
  const codexHome = lockFixture(null)
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'codex', homeDirectory: codexHome }).installed,
    [resolve(codexHome, '.agents/skills/media-playback')],
  )
})

test('rewrites its own copy when the repository skill changes and leaves a user folder of the same name alone', () => {
  const root = bundledRoot({ 'media-playback': { 'SKILL.md': 'v1', 'old.md': 'removed later' } })
  const homeDirectory = lockFixture(null)
  const target = resolve(homeDirectory, '.agents/skills/media-playback')
  ensureBundledSkills({ root, protocol: 'acp', homeDirectory })
  writeFileSync(resolve(root, 'skills/media-playback/SKILL.md'), 'v2')
  rmSync(resolve(root, 'skills/media-playback/old.md'))
  assert.deepEqual(ensureBundledSkills({ root, protocol: 'acp', homeDirectory }).installed, [target])
  assert.equal(readFileSync(resolve(target, 'SKILL.md'), 'utf8'), 'v2')
  assert.equal(existsSync(resolve(target, 'old.md')), false)

  const userHome = lockFixture(null)
  placeSkill(userHome, '.agents/skills', 'media-playback')
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'acp', homeDirectory: userHome }),
    { installed: [], skipped: [resolve(userHome, '.agents/skills/media-playback')] },
  )
  assert.equal(
    readFileSync(resolve(userHome, '.agents/skills/media-playback/SKILL.md'), 'utf8'),
    '---\nname: x\n---\n',
  )
})

test('does nothing without a skills folder and ignores folders without SKILL.md', () => {
  const homeDirectory = lockFixture(null)
  const empty = mkdtempSync(join(tmpdir(), 'qwaudio-bundled-empty-'))
  assert.deepEqual(
    ensureBundledSkills({ root: empty, protocol: 'acp', homeDirectory }),
    { installed: [], skipped: [] },
  )
  const notes = bundledRoot({ drafts: { 'README.md': 'not a skill' } })
  assert.deepEqual(
    ensureBundledSkills({ root: notes, protocol: 'acp', homeDirectory }),
    { installed: [], skipped: [] },
  )
  assert.equal(existsSync(resolve(homeDirectory, '.agents/skills')), false)
})

test('installs the media-playback skill that ships in this repository', () => {
  const homeDirectory = lockFixture(null)
  ensureBundledSkills({ root: repositoryRoot, protocol: 'acp', homeDirectory })
  assert.equal(
    readFileSync(resolve(homeDirectory, '.agents/skills/media-playback/SKILL.md'), 'utf8'),
    readFileSync(resolve(repositoryRoot, 'skills/media-playback/SKILL.md'), 'utf8'),
  )
})

test('refreshes its stale copy in another backend\'s folder, which omp ranks above ~/.agents', () => {
  const root = bundledRoot({ 'media-playback': { 'SKILL.md': 'v1' } })
  const homeDirectory = lockFixture(null)
  ensureBundledSkills({ root, protocol: 'claude', homeDirectory })
  writeFileSync(resolve(root, 'skills/media-playback/SKILL.md'), 'v2')
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'acp', homeDirectory }),
    {
      installed: [
        resolve(homeDirectory, '.agents/skills/media-playback'),
        resolve(homeDirectory, '.claude/skills/media-playback'),
      ],
      skipped: [],
    },
  )
  assert.equal(
    readFileSync(resolve(homeDirectory, '.claude/skills/media-playback/SKILL.md'), 'utf8'),
    'v2',
  )
  // Folders of backends that never had a copy are not created.
  assert.equal(existsSync(resolve(homeDirectory, '.pi')), false)
  assert.equal(existsSync(resolve(homeDirectory, '.qwen')), false)

  // A user folder of the same name in another backend's folder is neither
  // touched nor reported.
  placeSkill(homeDirectory, '.qwen/skills', 'media-playback')
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'acp', homeDirectory }),
    { installed: [], skipped: [] },
  )
  assert.equal(
    readFileSync(resolve(homeDirectory, '.qwen/skills/media-playback/SKILL.md'), 'utf8'),
    '---\nname: x\n---\n',
  )
})

test('marks its copy before writing files, so a copy that fails partway is rewritten on the next start', () => {
  const root = bundledRoot({
    'media-playback': { 'SKILL.md': 'v1', 'references/netflix.md': 'ids' },
  })
  const homeDirectory = lockFixture(null)
  const target = resolve(homeDirectory, '.agents/skills/media-playback')
  const realWriteFileSync = fs.writeFileSync
  fs.writeFileSync = (path, ...rest) => {
    if (String(path).endsWith('netflix.md')) {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    return realWriteFileSync(path, ...rest)
  }
  syncBuiltinESMExports()
  try {
    assert.throws(() => ensureBundledSkills({ root, protocol: 'acp', homeDirectory }), /ENOSPC/)
  } finally {
    fs.writeFileSync = realWriteFileSync
    syncBuiltinESMExports()
  }
  assert.equal(existsSync(resolve(target, 'SKILL.md')), true)
  assert.equal(existsSync(resolve(target, 'references/netflix.md')), false)
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'acp', homeDirectory }),
    { installed: [target], skipped: [] },
  )
  assert.equal(readFileSync(resolve(target, 'references/netflix.md'), 'utf8'), 'ids')

  // A marked folder whose marker holds a wrong digest and that lacks a file.
  writeFileSync(resolve(target, '.qwaudio-bundled'), 'wrong\n')
  rmSync(resolve(target, 'references'), { recursive: true })
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'acp', homeDirectory }),
    { installed: [target], skipped: [] },
  )
  assert.equal(readFileSync(resolve(target, 'references/netflix.md'), 'utf8'), 'ids')
  assert.deepEqual(
    ensureBundledSkills({ root, protocol: 'acp', homeDirectory }),
    { installed: [], skipped: [] },
  )
})
