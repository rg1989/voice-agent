#!/usr/bin/env node
// Carry this machine's voice-agent setup to another Mac in one encrypted file.
//
//   node bin/setup-bundle.mjs export [file]   default: ~/Desktop/voice-agent-setup.qwsetup
//   node bin/setup-bundle.mjs import <file>
//
// What travels: the gateway config (API keys, voice, brain, turn taking, computer
// control), the assistant's persona and memory notes, and Oh My Pi's providers,
// keys, logins and skills. What does not: conversation history, the gateway's
// device identity (each machine makes its own), node_modules, and the Claude Code
// login, which lives in the macOS Keychain.
//
// The passphrase is read from QWAUDIO_SETUP_PASSPHRASE, or asked for on the terminal.
import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { gunzipSync, gzipSync } from 'node:zlib'

const MAGIC = Buffer.from('QWSETUP1')
const HOME = homedir()
const ROOTS = {
  qwaudio: process.env.QWAUDIO_CONFIG_DIR || join(HOME, '.config/qwaudio'),
  omp: join(HOME, '.omp/agent'),
}
const PICK = {
  qwaudio: ['config.env', 'ASSISTANT.md', 'USER.md', 'MEMORY.md', 'data/MEMORY.md', 'data/USER.md'],
  omp: ['.env', 'config.yml', 'models.yml', 'AGENTS.md', 'agent.db', 'skills'],
}

function key(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

function seal(plain, passphrase) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(passphrase, salt), iv)
  cipher.setAAD(MAGIC)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

function unseal(sealed, passphrase) {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('this is not a voice-agent setup file')
  }
  const at = MAGIC.length
  const decipher = createDecipheriv(
    'aes-256-gcm', key(passphrase, sealed.subarray(at, at + 16)), sealed.subarray(at + 16, at + 28),
  )
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(sealed.subarray(at + 28, at + 44))
  try {
    return Buffer.concat([decipher.update(sealed.subarray(at + 44)), decipher.final()])
  } catch {
    throw new Error('wrong passphrase, or the file is damaged')
  }
}

function hidden(prompt) {
  process.stdout.write(prompt)
  spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] })
  const rl = createInterface({ input: process.stdin })
  return new Promise(resolve => rl.once('line', line => {
    rl.close()
    spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] })
    process.stdout.write('\n')
    resolve(line)
  }))
}

async function passphrase({ confirm }) {
  const fromEnv = process.env.QWAUDIO_SETUP_PASSPHRASE
  if (fromEnv) return fromEnv
  if (!process.stdin.isTTY) throw new Error('run this in a terminal, or set QWAUDIO_SETUP_PASSPHRASE')
  const first = await hidden('Passphrase for the setup file: ')
  if (!confirm) return first
  if (first.length < 10) throw new Error('use a passphrase of at least 10 characters')
  if (first !== await hidden('Type it again: ')) throw new Error('the passphrases do not match')
  return first
}

// SQLite keeps recent writes in a -wal file next to the database; copying the
// .db alone can lose the logins that were just saved. .backup gives one
// consistent file even while Oh My Pi is running.
function snapshotDatabase(path) {
  const scratch = mkdtempSync(join(tmpdir(), 'qwsetup-'))
  const copy = join(scratch, 'copy.db')
  try {
    const result = spawnSync('sqlite3', [path, `.backup '${copy}'`], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`could not read ${path}: ${result.stderr || result.error}`)
    return readFileSync(copy)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function collect(root, relativePath, into) {
  const path = join(ROOTS[root], relativePath)
  if (!existsSync(path)) return
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) collect(root, join(relativePath, name), into)
    return
  }
  const data = relativePath.endsWith('.db') ? snapshotDatabase(path) : readFileSync(path)
  into.push({ root, path: relativePath, data: data.toString('base64') })
}

async function exportBundle(output = join(HOME, 'Desktop/voice-agent-setup.qwsetup')) {
  const files = []
  for (const [root, paths] of Object.entries(PICK)) {
    for (const path of paths) collect(root, path, files)
  }
  if (!files.some(file => file.root === 'qwaudio' && file.path === 'config.env')) {
    throw new Error(`no config.env in ${ROOTS.qwaudio}; nothing to carry`)
  }
  const manifest = { version: 1, createdAt: new Date().toISOString(), sourceHome: HOME, roots: ROOTS, files }
  const sealed = seal(gzipSync(Buffer.from(JSON.stringify(manifest))), await passphrase({ confirm: true }))
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, sealed, { mode: 0o600 })
  for (const file of files) console.log(`  + ${file.root === 'omp' ? '~/.omp/agent' : '~/.config/qwaudio'}/${file.path}`)
  console.log(`Wrote ${output} (${Math.ceil(sealed.length / 1024)} KB). It holds your API keys: copy it by AirDrop or USB, not a shared cloud folder.`)
}

function unquote(value) {
  return value.replace(/^(["'])(.*)\1$/, '$2')
}

// Paths in config.env point into the old home folder. Move them to this one,
// and switch off a working folder that does not exist here rather than letting
// the gateway fail to start.
function adaptConfig(text, sourceHome, notes) {
  return text.split('\n').map(line => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (!match) return line
    const name = match[1]
    let value = match[2]
    if (sourceHome && sourceHome !== HOME) value = value.split(sourceHome).join(HOME)
    const path = unquote(value.trim())
    if (name === 'QWAUDIO_WORKSPACE' && path && !existsSync(path)) {
      notes.push(`Working folder ${path} does not exist on this Mac; choose one in Settings.`)
      return `# ${name}=${value}`
    }
    if (name === 'ACP_COMMAND' && path.startsWith('/') && !existsSync(path)) {
      notes.push(`The brain command ${path} is not installed yet (bin/setup-mac installs Oh My Pi).`)
    }
    return `${name}=${value}`
  }).join('\n')
}

function moveAside(path) {
  if (existsSync(path)) renameSync(path, `${path}.before-import`)
}

async function importBundle(input) {
  if (!input) throw new Error('usage: node bin/setup-bundle.mjs import <file>')
  const manifest = JSON.parse(gunzipSync(unseal(readFileSync(input), await passphrase({ confirm: false }))))
  if (manifest.version !== 1) throw new Error(`unsupported setup file version ${manifest.version}`)
  const notes = []
  for (const file of manifest.files) {
    if (!ROOTS[file.root] || file.path.split(/[\\/]/).includes('..')) {
      throw new Error(`refusing unexpected path in setup file: ${file.root}/${file.path}`)
    }
    const target = join(ROOTS[file.root], file.path)
    let data = Buffer.from(file.data, 'base64')
    if (file.root === 'qwaudio' && file.path === 'config.env') {
      data = Buffer.from(adaptConfig(data.toString('utf8'), manifest.sourceHome, notes))
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    if (existsSync(target) && readFileSync(target).equals(data)) continue
    moveAside(target)
    // A leftover -wal from an older database would be replayed onto the new one.
    if (target.endsWith('.db')) { moveAside(`${target}-wal`); moveAside(`${target}-shm`) }
    writeFileSync(target, data, { mode: 0o600 })
    console.log(`  restored ${target}`)
  }
  for (const note of notes) console.log(`  note: ${note}`)
  console.log('Setup restored. Files that were replaced were kept next to them as *.before-import.')
}

const [command, file] = process.argv.slice(2)
const run = { export: exportBundle, import: importBundle }[command]
if (!run) {
  console.error('usage: node bin/setup-bundle.mjs export [file] | import <file>')
  process.exit(2)
}
run(file).catch(error => {
  spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] })
  console.error(`setup-bundle: ${error.message}`)
  process.exit(1)
})
