import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { SessionJournal } from './session-journal.mjs'
import { decodeSessionJournal } from './session-journal-format.mjs'

function pathSegment(value, fallback) {
  const text = String(value || '').trim()
  if (!text) return fallback
  // Injective and traversal-safe: unlike replacing punctuation with '_', this
  // cannot make two distinct owner/session ids share a journal directory.
  return Buffer.from(text, 'utf8').toString('base64url')
}


// 会话历史列表用得到的两种记录。任务事件不算「说过话」，只有它们的会话不列出来。
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])
const TITLE_MAX_CHARS = 80

// 标题取用户说的第一句话。不另起一套「给会话命名」的机制，也就没有第二份需要
// 维护、会和日志对不上的真相。
function sessionTitle(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim()
  if (text.length <= TITLE_MAX_CHARS) return text
  return `${text.slice(0, TITLE_MAX_CHARS - 1)}…`
}

/** Owns per-owner/per-session journals without coupling them to a domain model. */
export class SessionJournalRegistry {
  constructor({ directory, logger = null } = {}) {
    if (!directory) throw new TypeError('directory is required')
    this.directory = resolve(directory)
    this.logger = logger
    this.journals = new Map()
  }

  key(ownerId, sessionId) {
    return `${String(ownerId || 'personal')}\u0000${String(sessionId || 'main')}`
  }

  get(ownerId, sessionId = 'main') {
    const key = this.key(ownerId, sessionId)
    let journal = this.journals.get(key)
    if (!journal) {
      const owner = pathSegment(ownerId, 'personal')
      const session = pathSegment(sessionId, 'main')
      journal = new SessionJournal({
        filePath: resolve(this.directory, owner, session, 'session.jsonl'),
        sessionId: String(sessionId || 'main'),
        metadata: { ownerId: String(ownerId || 'personal') },
      })
      this.journals.set(key, journal)
    }
    return journal
  }

  append({ ownerId, sessionId = 'main', event } = {}) {
    const journal = this.get(ownerId, sessionId)
    return journal.append(event).catch(error => {
      this.logger?.warn('session_journal.append_failed', {
        ownerId,
        sessionId,
        eventType: event?.type,
        error,
      })
      return null
    })
  }

  // 只扫这一个 Owner 的目录：别人的会话既不该出现在列表里，也不该被读进来。
  listSessions(ownerId) {
    const ownerDirectory = resolve(this.directory, pathSegment(ownerId, 'personal'))
    let entries = []
    try {
      entries = readdirSync(ownerDirectory, { withFileTypes: true })
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn('session_journal.list_failed', { path: ownerDirectory, error })
      }
      return []
    }
    const sessions = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = resolve(ownerDirectory, entry.name, 'session.jsonl')
      let records = []
      try {
        records = decodeSessionJournal(readFileSync(path)).records || []
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.logger?.warn('session_journal.read_failed', { path, error })
        }
        continue
      }
      const header = records.find(record => record?.type === 'session')
      const sessionId = String(header?.sessionId || '')
      if (!sessionId) continue
      const messages = records.filter(record => MESSAGE_TYPES.has(record?.type))
      // 建了但没说过话的会话不列出来：每次连接都会开一个日志，全列出来的话
      // 历史里会塞满空条目。
      if (!messages.length) continue
      const first = messages.find(record => record.type === 'user/message')
      sessions.push({
        sessionId,
        createdAt: header.createdAt || null,
        updatedAt: messages[messages.length - 1]?.time || header.createdAt || null,
        messages: messages.length,
        title: sessionTitle(first?.payload?.content),
      })
    }
    return sessions.sort((left, right) => (
      String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    ))
  }

  // 目录名是 base64url 编码的 id，拼不出 '..'，所以这里删的一定是这个 Owner
  // 自己的那一个会话目录。
  removeSession(ownerId, sessionId) {
    if (!String(sessionId || '').trim()) return false
    this.journals.delete(this.key(ownerId, sessionId))
    rmSync(
      resolve(
        this.directory,
        pathSegment(ownerId, 'personal'),
        pathSegment(sessionId, 'main'),
      ),
      { recursive: true, force: true },
    )
    return true
  }

  async flush() {
    await Promise.all([...this.journals.values()].map(journal => journal.flush()))
  }

  async read(ownerId, sessionId = 'main') {
    const journal = this.get(ownerId, sessionId)
    await journal.flush()
    await journal.open()
    return journal.list()
  }

  readAllSync() {
    return [...this.iterateSync()]
  }

  *paths(directory = this.directory, onError = (error, path) => this.logger?.warn('session_journal.scan_failed', { path, error })) {
    let entries = []
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch (error) {
      if (error.code !== 'ENOENT') onError(error, directory)
      return
    }
    for (const entry of entries) {
      const target = resolve(directory, entry.name)
      if (entry.isDirectory()) yield* this.paths(target, onError)
      else if (entry.isFile() && entry.name === 'session.jsonl') {
        yield target
      }
    }
  }

  // Startup projections consume one file at a time, rather than retaining
  // every parsed journal simultaneously. The array API remains for callers
  // that explicitly need a materialized snapshot.
  *iterateSync() {
    for (const target of this.paths()) {
      try {
        const decoded = decodeSessionJournal(readFileSync(target))
        if (decoded.discardedBytes) {
          this.logger?.warn('session_journal.torn_tail', {
            path: target,
            discardedBytes: decoded.discardedBytes,
          })
        }
        yield { path: target, records: decoded.records }
      } catch (error) {
        this.logger?.warn('session_journal.read_failed', { path: target, error })
      }
    }
  }

  taskSnapshotsSync() {
    const snapshots = new Map()
    const revisions = new Map()
    for (const journalFile of this.iterateSync()) {
      for (const event of journalFile.records || []) {
        const task = event?.payload?.task
        if (event?.type !== 'qwaudio/task/event' || !task?.id) continue
        // seq is local to a journal, not a global revision. In particular, a
        // recycled short ID must not resurrect an older task from a long log.
        const revision = [Number(task.createdAt) || 0, Date.parse(event.time) || 0, event.seq]
        const previous = revisions.get(task.id)
        const different = previous ? revision.findIndex((value, index) => value !== previous[index]) : -1
        if (!previous || (different !== -1 && revision[different] > previous[different])) {
          snapshots.set(task.id, { ...task, journalSeq: event.seq })
          revisions.set(task.id, revision)
        }
      }
    }
    return [...snapshots.values()]
  }
}
