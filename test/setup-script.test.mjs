import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadRuntimeEnvironment } from '../shared/runtime-environment.mjs'

// bin/setup and bin/desktop are bash scripts for macOS and Linux.
const skip = process.platform === 'win32' ? 'bash installer scripts run on macOS and Linux only' : false
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const REAL_TOOLS = [
  'awk', 'basename', 'bash', 'cat', 'chmod', 'cp', 'cut', 'dirname', 'env', 'find',
  'grep', 'head', 'ln', 'ls', 'mkdir', 'mktemp', 'mv', 'rm', 'sed', 'seq', 'sh',
  'sha256sum', 'shasum', 'sleep', 'tail', 'touch', 'tr',
]

function which(tool) {
  return spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
}

const shellcheck = skip ? '' : which('shellcheck')

// A throwaway HOME, and a PATH that holds only basic tools plus stubs that log
// their calls, so a run can neither see nor change this machine's real setup.
// curl, tar and unzip are stubs by default; leave one out to make it "missing".
function sandbox({ os = 'Linux', arch = 'x86_64', commands = ['curl', 'tar', 'unzip'] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'qwaudio-setup-'))
  const home = join(base, 'home')
  const bin = join(base, 'bin')
  const log = join(base, 'calls.log')
  mkdirSync(home)
  mkdirSync(bin)
  for (const tool of REAL_TOOLS) {
    const path = which(tool)
    if (path && !commands.includes(tool)) symlinkSync(path, join(bin, tool))
  }
  const stub = (name, body = '', directory = bin) => {
    mkdirSync(directory, { recursive: true })
    const path = join(directory, name)
    // Remove first: writing to a symlinked real tool would overwrite the real binary.
    rmSync(path, { force: true })
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }
  stub('uname', `case "$1" in -m) echo ${arch} ;; *) echo ${os} ;; esac`)
  stub('sw_vers', 'echo 14.5')
  stub('getconf', 'echo glibc 2.41')
  for (const name of commands) stub(name)
  return { base, home, bin, log, stub, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

function setup(box, { args = [], env = {} } = {}) {
  return spawnSync('/bin/bash', [join(repo, 'bin/setup'), ...args], {
    encoding: 'utf8',
    env: { HOME: box.home, PATH: box.bin, QWAUDIO_DIR: repo, ...env },
  })
}

// Calls one function from bin/setup without running the installer.
function setupFunction(box, name, { args = [], env = {} } = {}) {
  return spawnSync('/bin/bash', ['-c', 'source "$0"; "$@"', join(repo, 'bin/setup'), name, ...args], {
    encoding: 'utf8',
    env: { HOME: box.home, PATH: box.bin, QWAUDIO_DIR: repo, QWAUDIO_SETUP_SOURCE_ONLY: '1', ...env },
  })
}

function assertIncludes(text, piece) {
  assert.ok(text.includes(piece), `expected to find:\n${piece}\nin:\n${text}`)
}

test('a dry run on Linux names each install step and changes nothing', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'would run: install_node')
  assertIncludes(result.stdout, 'would run: install_bun_and_omp')
  assertIncludes(result.stdout, 'would run: stop_gateway')
  assertIncludes(result.stdout, 'would run: fetch_code')
  assertIncludes(result.stdout, `would run: in_dir ${repo} env ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund`)
  assert.deepEqual(readdirSync(box.home), [])
})

test('a dry run on macOS checks the version and changes nothing', { skip }, t => {
  const box = sandbox({ os: 'Darwin', arch: 'arm64', commands: ['curl'] })
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, '==> macOS 14.5 on arm64')
  assertIncludes(result.stdout, 'would run: install_node')
  assert.deepEqual(readdirSync(box.home), [])
})

test('QWAUDIO_SETUP_SOURCE_ONLY=1 defines the functions without running setup', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const target = join(box.home, 'made')
  const result = setupFunction(box, 'run', { args: ['touch', target], env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `    would run: touch ${target}\n`)
  assert.deepEqual(readdirSync(box.home), [])
})

test('the installer scripts pass shellcheck', { skip: skip || (!shellcheck && 'shellcheck is not installed') }, () => {
  const result = spawnSync(shellcheck, ['-e', 'SC1091', join(repo, 'bin/setup'), join(repo, 'bin/desktop')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout)
})

test('on Arch a missing base tool is installed with pacman', { skip }, t => {
  const box = sandbox({ commands: ['curl', 'tar', 'sudo', 'pacman'] })
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'would run: sudo pacman -S --needed --noconfirm unzip')
})

test('on Arch the media tools come from pacman', { skip }, t => {
  const box = sandbox({ commands: ['curl', 'tar', 'unzip', 'sudo', 'pacman'] })
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'would run: sudo pacman -S --needed --noconfirm yt-dlp deno playerctl')
})

test('media tools already on the machine are not installed again', { skip }, t => {
  const box = sandbox({ commands: ['curl', 'tar', 'unzip', 'sudo', 'pacman', 'yt-dlp', 'deno', 'playerctl'] })
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /pacman -S/)
})

test('on Debian and Ubuntu playerctl comes from apt, yt-dlp and deno from their releases', { skip }, t => {
  const box = sandbox({ commands: ['curl', 'tar', 'unzip', 'sudo', 'apt-get'] })
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'would run: sh -c sudo apt-get update -qq && sudo apt-get install -y -qq playerctl')
  assertIncludes(result.stdout, 'would run: install_user_binary yt-dlp')
  assertIncludes(result.stdout, 'would run: install_user_binary deno')
})

test('on macOS with Homebrew the media tools come from brew', { skip }, t => {
  const box = sandbox({ os: 'Darwin', arch: 'arm64', commands: ['curl', 'brew'] })
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, `would run: ${join(box.bin, 'brew')} install yt-dlp deno media-control`)
})

const systemHomebrew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].some(path => existsSync(path))
test('on macOS without Homebrew yt-dlp and deno come from their releases', {
  skip: skip || (systemHomebrew && 'Homebrew is installed on this machine'),
}, t => {
  const box = sandbox({ os: 'Darwin', arch: 'arm64', commands: ['curl'] })
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'would run: install_user_binary yt-dlp')
  assertIncludes(result.stdout, 'would run: install_user_binary deno')
  assertIncludes(result.stdout, 'brew install media-control')
})

// A curl stand-in that serves a fake release asset and the checksum file for it.
function releaseCurl(box, { asset, sums }) {
  box.stub('curl', [
    'out=""; url=""',
    'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done',
    `case "$url" in *SHA2-256SUMS) printf '%s\\n' '${sums}' > "$out" ;; *) printf 'fake ${asset}\\n' > "$out" ;; esac`,
  ].join('\n'))
}

test('a release download is installed only when its checksum matches', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const hash = createHash('sha256').update('fake yt-dlp_linux\n').digest('hex')
  releaseCurl(box, { asset: 'yt-dlp_linux', sums: `${hash}  yt-dlp_linux` })
  const result = setupFunction(box, 'install_user_binary', { args: ['yt-dlp'] })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(box.home, '.local/bin/yt-dlp'), 'utf8'), 'fake yt-dlp_linux\n')
})

test('a release download with a wrong checksum stops setup and installs nothing', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  releaseCurl(box, { asset: 'yt-dlp_linux', sums: `${'0'.repeat(64)}  yt-dlp_linux` })
  const result = setupFunction(box, 'install_user_binary', { args: ['yt-dlp'] })
  assert.equal(result.status, 1)
  assertIncludes(result.stderr, 'setup: yt-dlp download failed its checksum')
  assert.equal(existsSync(join(box.home, '.local/bin/yt-dlp')), false)
})

test('a failed yt-dlp download notes the problem and setup continues', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  box.stub('curl', 'exit 1')
  const result = setupFunction(box, 'install_media_tools')
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'Could not install yt-dlp; playing media by voice needs it.')
  // deno is tried after yt-dlp: proof the failure did not abort install_media_tools.
  assertIncludes(result.stdout, 'Could not install deno; playing media by voice needs it.')
})

function writeConfig(box, text) {
  const directory = join(box.home, '.config/qwaudio')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'config.env'), text)
  return join(directory, 'config.env')
}

test('setup points the gateway state at one shared folder, once', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const config = writeConfig(box, 'DASHSCOPE_API_KEY=sk-test\n')
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = setupFunction(box, 'share_gateway_state')
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(
    readFileSync(config, 'utf8'),
    `DASHSCOPE_API_KEY=sk-test\n\nQWAUDIO_STATE_DIR=${join(box.home, '.config/qwaudio/state')}\n`,
  )
})

test('setup keeps a state folder the user already chose', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const config = writeConfig(box, 'QWAUDIO_STATE_DIR=/srv/qwaudio-state\n')
  const result = setupFunction(box, 'share_gateway_state')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(config, 'utf8'), 'QWAUDIO_STATE_DIR=/srv/qwaudio-state\n')
})

test('without a config file setup writes no state folder setting', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const result = setupFunction(box, 'share_gateway_state')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readdirSync(box.home), [])
})

// The desktop main process loads config.env with defaultStateDirectory
// 'state/desktop' (desktop/src/main.mjs). The shared lease depends on
// config.env winning over that default.
test('the desktop app takes the shared state folder from config.env instead of state/desktop', t => {
  const base = mkdtempSync(join(tmpdir(), 'qwaudio-state-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const configDirectory = join(base, 'config')
  mkdirSync(configDirectory)
  writeFileSync(join(configDirectory, 'config.env'), `QWAUDIO_STATE_DIR=${join(configDirectory, 'state')}\n`)
  const environment = loadRuntimeEnvironment({
    root: base,
    env: { QWAUDIO_CONFIG_DIR: configDirectory },
    homeDirectory: base,
    defaultStateDirectory: 'state/desktop',
    readOnly: true,
    generateSecret: false,
    prepareBackendRuntime: false,
  })
  assert.equal(environment.stateDirectory, join(configDirectory, 'state'))
})

test('a dry run on Linux builds the desktop app folder and installs it for this user', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'would run: stop_desktop')
  assertIncludes(result.stdout, `would run: in_dir ${repo} ${repo}/node_modules/.bin/electron-builder --config desktop/electron-builder.yml --linux dir --x64 --publish never`)
  assertIncludes(result.stdout, `would run: cp -R ${repo}/dist/desktop/linux-unpacked ${box.home}/.local/opt/qwen-audio-agent`)
  assertIncludes(result.stdout, `would run: ln -sfn ${box.home}/.local/opt/qwen-audio-agent/qwen-audio-agent ${box.home}/.local/bin/qwen-audio-agent`)
  assertIncludes(result.stdout, `would write ${box.home}/.local/share/applications/qwen-audio-agent.desktop`)
  assert.deepEqual(readdirSync(box.home), [])
})

test('a dry run on ARM Linux builds the arm64 folder', { skip }, t => {
  const box = sandbox({ arch: 'aarch64' })
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, '--linux dir --arm64 --publish never')
  assertIncludes(result.stdout, `would run: cp -R ${repo}/dist/desktop/linux-arm64-unpacked ${box.home}/.local/opt/qwen-audio-agent`)
})

test('a dry run on macOS builds an ad hoc signed app into ~/Applications', { skip }, t => {
  for (const [arch, flag, folder] of [['arm64', '--arm64', 'mac-arm64'], ['x86_64', '--x64', 'mac']]) {
    const box = sandbox({ os: 'Darwin', arch, commands: ['curl', 'brew'] })
    t.after(box.cleanup)
    const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
    assert.equal(result.status, 0, result.stderr)
    assertIncludes(result.stdout, `--mac dir ${flag} --config.mac.identity=- --config.mac.hardenedRuntime=false --config.mac.notarize=false --publish never`)
    assertIncludes(result.stdout, `would run: cp -R ${repo}/dist/desktop/${folder}/Qwen Audio Agent.app ${box.home}/Applications/Qwen Audio Agent.app`)
  }
})

test('QWAUDIO_SETUP_NO_DESKTOP=1 skips the desktop app', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1', QWAUDIO_SETUP_NO_DESKTOP: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /electron-builder/)
})

test('the desktop build is copied into place with a launcher entry and a command', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const fakeRepo = join(box.base, 'repo')
  box.stub('electron-builder', [
    'mkdir -p dist/desktop/linux-unpacked',
    "printf '#!/bin/sh\\n' > dist/desktop/linux-unpacked/qwen-audio-agent",
    'chmod +x dist/desktop/linux-unpacked/qwen-audio-agent',
  ].join('\n'), join(fakeRepo, 'node_modules/.bin'))
  const result = setupFunction(box, 'install_desktop', { env: { QWAUDIO_DIR: fakeRepo } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(readFileSync(box.log, 'utf8'), 'electron-builder --config desktop/electron-builder.yml --linux dir --x64 --publish never')
  const app = join(box.home, '.local/opt/qwen-audio-agent/qwen-audio-agent')
  assert.equal(existsSync(app), true)
  assert.equal(readlinkSync(join(box.home, '.local/bin/qwen-audio-agent')), app)
  const entry = readFileSync(join(box.home, '.local/share/applications/qwen-audio-agent.desktop'), 'utf8')
  assertIncludes(entry, `Exec=/bin/bash "${fakeRepo}/bin/desktop" %U`)
  assertIncludes(entry, `Icon=${fakeRepo}/desktop/build/icon.png`)
  assertIncludes(entry, 'MimeType=x-scheme-handler/qwaudio;')
  assertIncludes(entry, 'StartupWMClass=qwen-audio-agent')
})

test('a failed desktop build keeps setup going and falls back to the web page', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const fakeRepo = join(box.base, 'repo')
  box.stub('electron-builder', 'exit 1', join(fakeRepo, 'node_modules/.bin'))
  const result = setupFunction(box, 'eval', {
    args: ['install_desktop; printf "no desktop: %s\\n" "$QWAUDIO_SETUP_NO_DESKTOP"'],
    env: { QWAUDIO_DIR: fakeRepo },
  })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'The desktop app did not build; opening the web page instead. Run setup again to retry.')
  assertIncludes(result.stdout, 'no desktop: 1')
  assert.equal(existsSync(join(box.home, '.local/opt/qwen-audio-agent')), false)
})

test('setup stops with a message when the desktop app does not quit', { skip }, t => {
  for (const [os, quit, match] of [
    ['Linux', 'pkill -f ^([^ ]*/)?qwen-audio-agent( |$)', 'pgrep -f ^([^ ]*/)?qwen-audio-agent( |$)'],
    ['Darwin', 'osascript -e tell application id "ai.qwenaudio.agent" to quit', 'pgrep -f /Qwen Audio Agent.app/Contents/MacOS/Qwen Audio Agent( |$)'],
  ]) {
    // pgrep always finds the app, and sleep returns at once.
    const box = sandbox({ os, arch: os === 'Darwin' ? 'arm64' : 'x86_64', commands: ['pgrep', 'pkill', 'osascript', 'sleep'] })
    t.after(box.cleanup)
    const result = setupFunction(box, 'stop_desktop')
    assert.equal(result.status, 1)
    assertIncludes(result.stderr, 'setup: the desktop app did not quit; quit it and run this again')
    const calls = readFileSync(box.log, 'utf8')
    assertIncludes(calls, quit)
    assertIncludes(calls, match)
  }
})

test('install-only mode leaves a running desktop app in place', { skip }, t => {
  for (const [os, arch, installed] of [
    ['Linux', 'x86_64', '.local/opt/qwen-audio-agent'],
    ['Darwin', 'arm64', 'Applications/Qwen Audio Agent.app'],
  ]) {
    // pgrep always finds the app, and a build would succeed.
    const box = sandbox({ os, arch, commands: ['pgrep', 'pkill', 'osascript'] })
    t.after(box.cleanup)
    const fakeRepo = join(box.base, 'repo')
    box.stub('electron-builder', [
      "mkdir -p dist/desktop/linux-unpacked 'dist/desktop/mac-arm64/Qwen Audio Agent.app'",
      "printf '#!/bin/sh\\n' > dist/desktop/linux-unpacked/qwen-audio-agent",
      'chmod +x dist/desktop/linux-unpacked/qwen-audio-agent',
    ].join('\n'), join(fakeRepo, 'node_modules/.bin'))
    const app = join(box.home, installed)
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'old-build'), '')
    const result = setupFunction(box, 'install_desktop', { env: { QWAUDIO_DIR: fakeRepo, QWAUDIO_SETUP_NO_START: '1' } })
    assert.equal(result.status, 0, result.stderr)
    assertIncludes(result.stdout, 'The desktop app is running; quit it and run setup again to update it.')
    assert.deepEqual(readdirSync(app), ['old-build'])
    const calls = readFileSync(box.log, 'utf8')
    assertIncludes(calls, 'pgrep -f')
    assert.doesNotMatch(calls, /electron-builder|pkill|osascript/)
  }
})

// A copy of bin/desktop next to a bin/restart stand-in, so a test never restarts
// the real gateway on this machine.
function desktopScript(box, restartBody = '') {
  const bin = join(box.base, 'repo/bin')
  mkdirSync(bin, { recursive: true })
  copyFileSync(join(repo, 'bin/desktop'), join(bin, 'desktop'))
  box.stub('restart', restartBody, bin)
  return join(bin, 'desktop')
}

// SHELL is a stand-in login shell that prints loginPath, so a test never reads this
// machine's shell profile or puts this machine's PATH ahead of the stubs.
function runDesktop(box, { args = [], loginPath = '', restartBody = '' } = {}) {
  const shell = box.stub('login-shell', `printf '\\n%s' '${loginPath}'`, join(box.base, 'shell'))
  const script = desktopScript(box, restartBody)
  return spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: { HOME: box.home, PATH: box.bin, SHELL: shell },
  })
}

test('bin/desktop opens the app on a running gateway without restarting it', { skip }, t => {
  const box = sandbox({ commands: [] })
  t.after(box.cleanup)
  box.stub('curl', `printf '%s' '{"status":"ok"}'`)
  box.stub('qwen-audio-agent', '', join(box.home, '.local/opt/qwen-audio-agent'))
  const result = runDesktop(box, { args: ['qwaudio://pair?code=1'] })
  assert.equal(result.status, 0, result.stderr)
  const calls = readFileSync(box.log, 'utf8')
  assert.doesNotMatch(calls, /^restart/m)
  assertIncludes(calls, 'qwen-audio-agent qwaudio://pair?code=1')
})

test('bin/desktop starts the gateway first when it is not running', { skip }, t => {
  const box = sandbox({ commands: ['curl', 'node'] })
  t.after(box.cleanup)
  box.stub('qwen-audio-agent', '', join(box.home, '.local/opt/qwen-audio-agent'))
  const result = runDesktop(box)
  assert.equal(result.status, 0, result.stderr)
  const order = readFileSync(box.log, 'utf8').split('\n').map(line => line.split(' ')[0])
  assert.deepEqual(order.filter(name => name === 'restart' || name === 'qwen-audio-agent'), ['restart', 'qwen-audio-agent'])
})

test('bin/desktop opens the app bundle on macOS', { skip }, t => {
  const box = sandbox({ os: 'Darwin', arch: 'arm64', commands: ['open'] })
  t.after(box.cleanup)
  box.stub('curl', `printf '%s' '{"status":"ok"}'`)
  const result = runDesktop(box)
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(readFileSync(box.log, 'utf8'), `open -a ${box.home}/Applications/Qwen Audio Agent.app --args`)
})

// A login item starts with launchd's bare PATH. A Node from Homebrew is only on the
// login shell's PATH, and bin/setup does not install its own Node then.
test('bin/desktop starts the gateway with a Node that only the login shell PATH has', { skip }, t => {
  const box = sandbox({ commands: ['curl'] })
  t.after(box.cleanup)
  const brew = join(box.base, 'brew')
  box.stub('node', '', brew)
  box.stub('qwen-audio-agent', '', join(box.home, '.local/opt/qwen-audio-agent'))
  const result = runDesktop(box, { loginPath: brew, restartBody: `command -v node >> "${box.log}"` })
  assert.equal(result.status, 0, result.stderr)
  const lines = readFileSync(box.log, 'utf8').split('\n')
  const node = lines.indexOf(join(brew, 'node'))
  assert.notEqual(node, -1, lines.join('\n'))
  assert.ok(node < lines.findIndex(line => line.startsWith('qwen-audio-agent')), lines.join('\n'))
})

test('bin/desktop adds the shared state folder to a config.env made after setup, once', { skip }, t => {
  const box = sandbox({ commands: [] })
  t.after(box.cleanup)
  box.stub('curl', `printf '%s' '{"status":"ok"}'`)
  box.stub('qwen-audio-agent', '', join(box.home, '.local/opt/qwen-audio-agent'))
  const config = writeConfig(box, 'DASHSCOPE_API_KEY=sk-test\n')
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = runDesktop(box)
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(
    readFileSync(config, 'utf8'),
    `DASHSCOPE_API_KEY=sk-test\n\nQWAUDIO_STATE_DIR=${join(box.home, '.config/qwaudio/state')}\n`,
  )
})

test('setup starts the gateway, then opens the desktop app instead of the web page', { skip }, t => {
  const box = sandbox({ os: 'Darwin', arch: 'arm64', commands: ['curl', 'brew'] })
  t.after(box.cleanup)
  writeConfig(box, 'DASHSCOPE_API_KEY=sk-test\n')
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, `would run: bash ${repo}/bin/restart\n    would run: bash ${repo}/bin/desktop`)
  assert.doesNotMatch(result.stdout, /open_url/)
})

test('in a Linux desktop session setup opens the app in the background', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  writeConfig(box, 'DASHSCOPE_API_KEY=sk-test\n')
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1', WAYLAND_DISPLAY: 'wayland-1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, `would run: detach ${repo}/bin/desktop`)
})

test('without the desktop app setup opens the web page as before', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  writeConfig(box, 'DASHSCOPE_API_KEY=sk-test\n')
  const result = setup(box, { env: { QWAUDIO_SETUP_DRY_RUN: '1', QWAUDIO_SETUP_NO_DESKTOP: '1' } })
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(result.stdout, 'would run: open_url http://127.0.0.1:3101')
})

function writeHyprland(box, name, text) {
  const directory = join(box.home, '.config/hypr')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), text)
  return directory
}

const count = (text, piece) => text.split(piece).length - 1

// The conversation panel is the same Electron window class as the orb, with the
// title qwen-audio-agent-panel. No pin or no_initial_focus rule may match it.
function assertOrbOnly(titles) {
  assert.ok(titles.length > 0, 'no pin or no_initial_focus rule found')
  for (const title of titles) {
    assert.ok(title, 'a pin or no_initial_focus rule has no title match')
    assert.match('qwen-audio-agent', new RegExp(title))
    assert.doesNotMatch('qwen-audio-agent-panel', new RegExp(title))
  }
}

test('with a Lua Hyprland config (Omarchy 4) setup writes qwaudio.lua and loads it once', { skip }, t => {
  const box = sandbox({ commands: ['hyprctl'] })
  t.after(box.cleanup)
  const hypr = writeHyprland(box, 'hyprland.lua', '-- personal config\n')
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = setupFunction(box, 'install_hyprland_rules', { env: { HYPRLAND_INSTANCE_SIGNATURE: 'test' } })
    assert.equal(result.status, 0, result.stderr)
  }
  const config = readFileSync(join(hypr, 'hyprland.lua'), 'utf8')
  assert.equal(count(config, `pcall(dofile, "${hypr}/qwaudio.lua")`), 1)
  const rules = readFileSync(join(hypr, 'qwaudio.lua'), 'utf8')
  assertIncludes(rules, 'match = { class = "^qwen-audio-agent$", title = "^qwen-audio-agent$" },\n  float = true,\n  pin = true,\n  no_initial_focus = true,')
  const focusRules = rules.split('hl.window_rule({').filter(rule => /(?:pin|no_initial_focus) = true/.test(rule))
  assertOrbOnly(focusRules.map(rule => rule.match(/title = "([^"]*)"/)?.[1]))
  assertIncludes(rules, 'match = { class = "^qwaudio-player$" },\n  suppress_event = "fullscreen",\n  maximize = true,')
  assertIncludes(readFileSync(box.log, 'utf8'), 'hyprctl reload')
})

test('with a hyprland.conf config setup writes qwaudio.conf and sources it once', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const hypr = writeHyprland(box, 'hyprland.conf', '# personal config\n')
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = setupFunction(box, 'install_hyprland_rules')
    assert.equal(result.status, 0, result.stderr)
  }
  const config = readFileSync(join(hypr, 'hyprland.conf'), 'utf8')
  assert.equal(count(config, `source = ${hypr}/qwaudio.conf`), 1)
  const rules = readFileSync(join(hypr, 'qwaudio.conf'), 'utf8')
  const orb = 'match:class ^(qwen-audio-agent)$, match:title ^(qwen-audio-agent)$'
  assertIncludes(rules, `windowrule = float on, ${orb}`)
  assertIncludes(rules, `windowrule = pin on, ${orb}`)
  assertIncludes(rules, `windowrule = no_initial_focus on, ${orb}`)
  const focusRules = rules.split('\n').filter(line => /^windowrule = (?:pin|no_initial_focus) on,/.test(line))
  assertOrbOnly(focusRules.map(line => line.match(/match:title (\S+)/)?.[1]))
  assertIncludes(rules, 'windowrule = suppress_event fullscreen, match:class ^(qwaudio-player)$')
  assertIncludes(rules, 'windowrule = maximize on, match:class ^(qwaudio-player)$')
})

test('without a Hyprland config setup adds no window rules', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const result = setupFunction(box, 'install_hyprland_rules')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readdirSync(box.home), [])
})

const luac = skip ? '' : which('luac')
test('the Hyprland Lua rules are valid Lua', { skip: skip || (!luac && 'luac is not installed') }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const hypr = writeHyprland(box, 'hyprland.lua', '')
  const result = setupFunction(box, 'install_hyprland_rules')
  assert.equal(result.status, 0, result.stderr)
  const parsed = spawnSync(luac, ['-p', join(hypr, 'qwaudio.lua')], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
})

test('on macOS setup adds a login item that opens the app through bin/desktop', { skip }, t => {
  const box = sandbox({ os: 'Darwin', arch: 'arm64' })
  t.after(box.cleanup)
  const result = setupFunction(box, 'install_autostart')
  assert.equal(result.status, 0, result.stderr)
  const plist = join(box.home, 'Library/LaunchAgents/com.qwen-audio-agent.desktop.plist')
  const text = readFileSync(plist, 'utf8')
  assertIncludes(text, '<string>com.qwen-audio-agent.desktop</string>')
  assertIncludes(text, `<string>/bin/bash</string>\n    <string>${repo}/bin/desktop</string>`)
  assertIncludes(text, '<key>RunAtLoad</key>\n  <true/>')
  assertIncludes(text, '<key>AbandonProcessGroup</key>\n  <true/>')
  if (process.platform === 'darwin') {
    const lint = spawnSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' })
    assert.equal(lint.status, 0, lint.stdout)
  }
})

// A launchd job gets no access to the folders macOS privacy protection guards,
// so a login item there would fail at login or raise a prompt that names bash.
test('on macOS setup adds no login item for a checkout in a guarded folder, and says why', { skip }, t => {
  const box = sandbox({ os: 'Darwin', arch: 'arm64' })
  t.after(box.cleanup)
  for (const folder of [
    'Documents/Projects/qwen-audio-agent',
    'Desktop/qwen-audio-agent',
    'Downloads/qwen-audio-agent',
    'Library/Mobile Documents/com~apple~CloudDocs/qwen-audio-agent',
  ]) {
    const result = setupFunction(box, 'install_autostart', { env: { QWAUDIO_DIR: join(box.home, folder) } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(box.home, 'Library/LaunchAgents')), false, folder)
    assertIncludes(result.stdout, 'QWAUDIO_DIR=~/qwen-audio-agent')
  }
  // A folder that only starts with the same letters is not guarded.
  const result = setupFunction(box, 'install_autostart', { env: { QWAUDIO_DIR: join(box.home, 'DocumentsArchive/qwen-audio-agent') } })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(box.home, 'Library/LaunchAgents/com.qwen-audio-agent.desktop.plist')), true)
})

test('on a Linux desktop without Hyprland setup adds an XDG autostart entry', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const result = setupFunction(box, 'install_autostart')
  assert.equal(result.status, 0, result.stderr)
  const entry = readFileSync(join(box.home, '.config/autostart/qwen-audio-agent.desktop'), 'utf8')
  assertIncludes(entry, `Exec=/bin/bash "${repo}/bin/desktop" %U`)
})

test('on Omarchy Hyprland opens the app through uwsm-app at start, not XDG autostart', { skip }, t => {
  const box = sandbox({ commands: ['uwsm-app'] })
  t.after(box.cleanup)
  const hypr = writeHyprland(box, 'hyprland.lua', '-- personal config\n')
  for (const name of ['install_hyprland_rules', 'install_autostart']) {
    const result = setupFunction(box, name)
    assert.equal(result.status, 0, result.stderr)
  }
  assertIncludes(
    readFileSync(join(hypr, 'qwaudio.lua'), 'utf8'),
    `hl.on("hyprland.start", function()\n  hl.exec_cmd("uwsm-app -- '${repo}/bin/desktop'")\nend)`,
  )
  assert.equal(existsSync(join(box.home, '.config/autostart')), false)
})

test('a hyprland.conf setup opens the app with exec-once', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const hypr = writeHyprland(box, 'hyprland.conf', '# personal config\n')
  const result = setupFunction(box, 'install_hyprland_rules')
  assert.equal(result.status, 0, result.stderr)
  assertIncludes(readFileSync(join(hypr, 'qwaudio.conf'), 'utf8'), `exec-once = '${repo}/bin/desktop'`)
})

test('QWAUDIO_SETUP_NO_DESKTOP=1 adds nothing that starts at login', { skip }, t => {
  const box = sandbox()
  t.after(box.cleanup)
  const hypr = writeHyprland(box, 'hyprland.lua', '')
  for (const name of ['install_hyprland_rules', 'install_autostart']) {
    const result = setupFunction(box, name, { env: { QWAUDIO_SETUP_NO_DESKTOP: '1' } })
    assert.equal(result.status, 0, result.stderr)
  }
  assert.doesNotMatch(readFileSync(join(hypr, 'qwaudio.lua'), 'utf8'), /hyprland\.start/)
  assert.equal(existsSync(join(box.home, '.config/autostart')), false)
})
