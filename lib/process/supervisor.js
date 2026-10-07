/**
 * Framework-free lifecycle management for the local Strata model server.
 *
 * The supervisor owns exactly one child process. It is deliberately free of any
 * Cordis/DSH import so it can be exercised by plain Node: the only host
 * capability it needs is a `spawn` function with the `ctx.subprocess`
 * `SubprocessHandle` shape (see `@deepseek-ai/dsh-subprocess`).
 *
 * Strata is launched the way `run-q2_0.bat` launches it:
 *
 *   <root>\.venv\Scripts\python.exe <root>\serve\server.py `
 *     --engine strata --config <root>\strata-q2_0.json --port 8080
 *
 * Readiness is the server's own `GET /health`, which answers `{status:"ok"}`
 * only once the HTTP listener is up. The `loaded` field in that payload reports
 * whether the weights are resident, which is what a `/v1` client actually needs.
 *
 * @module dsh-strata-console/supervisor
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'

/** Launch defaults mirroring the shipped `D:\strata` layout. */
export const STRATA_DEFAULTS = Object.freeze({
  root: 'D:\\strata\\Strata-main',
  python: '',
  config: '',
  port: 8080,
  host: '127.0.0.1',
  extraArgs: [],
  readyTimeoutMs: 300_000,
  pollIntervalMs: 1_500,
  stopGraceMs: 20_000,
  logTailBytes: 262_144,
})

/** How long a single readiness probe may take before the server counts as unreachable. */
const PROBE_TIMEOUT_MS = 2_500

/** Bounded in-memory tail kept for each piped stream of the child process. */
const STREAM_TAIL_BYTES = 1 << 20

/** Bounded spill file holding the complete stream once the tail overflows. */
const STREAM_SPILL_BYTES = 16 << 20

/**
 * Whether nothing is listening on a TCP port.
 *
 * A refused connection is the answer we want, so `error` means free; only a
 * completed connect (or a hang past the budget, which no refused socket
 * produces) counts as taken.
 * @param host - the address to dial; a wildcard bind is checked on loopback.
 * @param port - the port to check.
 * @param timeoutMs - budget before the check reports the port as free.
 * @returns whether the port can be bound.
 */
export function isPortFree(host, port, timeoutMs = 1_500) {
  const target = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host
  return new Promise((resolveFree) => {
    const socket = createConnection({ host: target, port })
    let settled = false
    const finish = (free) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveFree(free)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(false))
    socket.once('timeout', () => finish(true))
    socket.once('error', () => finish(true))
  })
}

/** Sleep that rejects as soon as the caller's signal aborts. */
function delay(ms, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(signal.reason ?? new Error('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      rejectDelay(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveDelay()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Resolve the concrete files and argv one launch uses. Absolute path spellings
 * only; nothing here touches the filesystem, so a missing install is reported by
 * {@link StrataSupervisor#start} with a message naming the exact path.
 * @param config - effective configuration, already merged over {@link STRATA_DEFAULTS}.
 * @returns the launch facts for one start attempt.
 */
export function resolveLaunch(config) {
  const root = resolve(config.root)
  const python = config.python
    ? resolve(config.python)
    : process.platform === 'win32'
      ? join(root, '.venv', 'Scripts', 'python.exe')
      : join(root, '.venv', 'bin', 'python')
  const configPath = config.config ? resolve(config.config) : join(root, 'strata-q2_0.json')
  const serverScript = join(root, 'serve', 'server.py')
  return {
    root,
    python,
    configPath,
    serverScript,
    port: config.port,
    host: config.host,
    argv: [
      python,
      serverScript,
      '--engine', 'strata',
      '--config', configPath,
      '--port', String(config.port),
      '--host', config.host,
      ...(config.extraArgs ?? []),
    ],
  }
}

/**
 * The process listening on a TCP port, resolved synchronously with `netstat`.
 *
 * Used only on the way out, where nothing async can settle. A busy port is
 * refused at start, so whatever listens here is the server this plugin manages.
 *
 * @param port - the configured port.
 * @returns the listening pid, or null when there is none.
 */
function portOwnerSync(port) {
  try {
    const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    if (typeof result.stdout !== 'string') return null
    const suffix = `:${port}`
    for (const line of result.stdout.split(/\r?\n/u)) {
      const columns = line.trim().split(/\s+/u)
      if (columns.length < 5) continue
      if (columns[0].toUpperCase() !== 'TCP') continue
      if (!columns[1].endsWith(suffix)) continue
      if (columns[3].toUpperCase() !== 'LISTENING') continue
      const pid = Number(columns[4])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch {}
  return null
}

/**
 * The engine's own log file, read out of the strata config JSON's `log` field.
 * @param configPath - absolute path of the strata config JSON.
 * @returns the absolute log path, or `undefined` when the config names none.
 */
export async function readEngineLogPath(configPath) {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return typeof parsed.log === 'string' && parsed.log.length > 0 ? resolve(parsed.log) : undefined
  } catch {
    return undefined
  }
}

/** Keep only the last `count` lines of a text block. */
function tailLines(text, count) {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length <= count ? lines.join('\n') : lines.slice(lines.length - count).join('\n')
}

/**
 * Drop every `undefined` member, recursively.
 *
 * Tool results must be lossless JSON, and `undefined` survives property access
 * while vanishing from `JSON.stringify`, so a snapshot with absent optional
 * fields (no pid yet, no engine log path) would round-trip to a different value
 * and be rejected before the model ever sees it. Absent means absent here.
 *
 * Exported because the plugin applies it again at the tool boundary: the
 * model-facing contract belongs to the tool layer, and this way a snapshot stays
 * correct even if only part of the plugin is reloaded.
 * @param value - any value a tool may return.
 * @returns the same shape with `undefined` members removed.
 */
export function prune(value) {
  if (Array.isArray(value)) return value.map(prune)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    out[key] = prune(entry)
  }
  return out
}

/**
 * Owns one Strata server process and reports its state in DSH-friendly terms.
 *
 * States: `stopped` (no listener, no child), `starting` (child spawned, the
 * listener has not answered yet), `ready` (the listener answered `/health`),
 * `exited` (a child ran, ended, and nothing listens now).
 */
export class StrataSupervisor {
  #spawn
  #log
  #config
  #child = null
  #pid = null
  #startedAt = null
  #lastExit = null
  #starting = null

  /**
   * @param options - the host spawn seam, an optional logger, and the configuration.
   * @param options.spawn - `ctx.subprocess.spawn` or any equivalent implementation.
   * @param options.log - diagnostic sink for lifecycle events that no tool result carries.
   * @param options.config - configuration already merged over {@link STRATA_DEFAULTS}.
   */
  constructor(options) {
    if (typeof options?.spawn !== 'function') throw new TypeError('StrataSupervisor needs a spawn function')
    this.#spawn = options.spawn
    this.#log = options.log ?? (() => {})
    this.#config = { ...STRATA_DEFAULTS, ...(options.config ?? {}) }
  }

  /** The effective configuration. */
  get config() {
    return this.#config
  }

  /** The launch facts for the current configuration. */
  get launch() {
    return resolveLaunch(this.#config)
  }

  /** The OpenAI-compatible base URL a DSH LLM provider points at. */
  get baseUrl() {
    return `http://${this.#config.host}:${this.#config.port}`
  }

  /** The host a probe dials: a wildcard bind address is probed on loopback. */
  get #probeHost() {
    const host = this.#config.host
    return host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host
  }

  /** A cwd that is guaranteed to exist, for helper commands only. */
  #workdir() {
    const root = this.launch.root
    return existsSync(root) ? root : process.cwd()
  }

  /**
   * Ask the server's own `/health` endpoint whether the listener is up.
   * @param timeoutMs - per-attempt budget.
   * @returns whether the listener answered, and either its payload or the miss reason.
   */
  async probe(timeoutMs = PROBE_TIMEOUT_MS) {
    const url = `http://${this.#probeHost}:${this.#config.port}/health`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) return { reachable: false, error: `HTTP ${response.status} from ${url}` }
      return { reachable: true, health: await response.json() }
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Run one short-lived helper command to completion and collect its output.
   * @param argv - exact argv, `argv[0]` being a bare PATH name or an absolute path.
   * @param timeoutMs - wall-clock budget before the helper is terminated.
   * @returns exit facts and both collected streams.
   */
  async #run(argv, timeoutMs = 20_000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
    try {
      const handle = this.#spawn({
        argv,
        cwd: this.#workdir(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STREAM_TAIL_BYTES },
          stderr: { maxBytes: STREAM_TAIL_BYTES },
        },
        graceMs: 5_000,
        signal: controller.signal,
        env: process.env,
      })
      const outcome = await handle.done
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: handle.collected?.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected?.stderr?.readFrom(0).text ?? '',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The process ids listening on the configured port, resolved with `netstat -ano`.
   * @returns the listening process ids, possibly empty.
   */
  async findPortOwners() {
    try {
      const result = await this.#run(['netstat', '-ano', '-p', 'tcp'])
      const suffix = `:${this.#config.port}`
      const owners = new Set()
      for (const line of result.stdout.split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/)
        if (columns.length < 5) continue
        if (columns[0].toUpperCase() !== 'TCP') continue
        if (!columns[1].endsWith(suffix)) continue
        if (columns[3].toUpperCase() !== 'LISTENING') continue
        const pid = Number(columns[4])
        if (Number.isInteger(pid) && pid > 0) owners.add(pid)
      }
      return [...owners]
    } catch (error) {
      this.#log('strata: could not inspect the port owner', error)
      return []
    }
  }

  /** Terminate one process tree. */
  async #killTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    if (process.platform === 'win32') {
      const result = await this.#run(['taskkill', '/PID', String(pid), '/T', '/F'])
      return result.exitCode === 0
    }
    try {
      process.kill(pid, 'SIGTERM')
      return true
    } catch {
      return false
    }
  }

  /**
   * Start the server unless something already answers on the port.
   *
   * Concurrent calls share one attempt. A listener this supervisor did not spawn
   * is adopted rather than duplicated: `server.py` refuses a busy port anyway, so
   * a second spawn could only produce a confusing error after a failed bind.
   *
   * @param options - wait policy and per-call readiness budget.
   * @param options.wait - when true, resolve only once `/health` answers or the budget ends.
   * @param options.timeoutMs - readiness budget; defaults to `readyTimeoutMs`.
   * @param options.signal - caller cancellation; it stops waiting, never the server.
   * @returns the status after the attempt.
   */
  async start(options = {}) {
    if (this.#starting !== null) return this.#starting
    this.#starting = this.#startOnce(options).finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async #startOnce({ wait = true, timeoutMs, signal } = {}) {
    const facts = this.launch

    const existing = await this.probe()
    if (existing.reachable) {
      return this.status({
        health: existing.health,
        message: this.#child === null
          ? `Strata already answers at ${this.baseUrl} but was not started by DeepSeek Harness; it was adopted, not duplicated.`
          : `Strata already answers at ${this.baseUrl}.`,
      })
    }

    for (const [label, path] of [
      ['root', facts.root],
      ['python interpreter', facts.python],
      ['server script', facts.serverScript],
      ['run config', facts.configPath],
    ]) {
      if (!existsSync(path)) {
        throw new Error(`Strata ${label} not found: ${path} — set it in this plugin's config.`)
      }
    }

    const budget = timeoutMs ?? this.#config.readyTimeoutMs
    const handle = this.#spawn({
      argv: facts.argv,
      cwd: facts.root,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STREAM_TAIL_BYTES, spill: { maxBytes: STREAM_SPILL_BYTES } },
        stderr: { maxBytes: STREAM_TAIL_BYTES, spill: { maxBytes: STREAM_SPILL_BYTES } },
      },
      graceMs: this.#config.stopGraceMs,
      env: process.env,
    })

    this.#child = handle
    this.#startedAt = Date.now()
    // Recorded here, not only when the wait path resolves the port owner: the
    // exit hook needs a pid even for a start that returned immediately.
    this.#pid = typeof handle.pid === 'number' ? handle.pid : null
    this.#log(`strata: spawned ${facts.argv.join(' ')}`)

    let exit = null
    const settle = (record) => {
      exit = record
      this.#lastExit = record
      if (this.#child === handle) {
        this.#child = null
        this.#pid = null
        this.#startedAt = null
      }
    }
    handle.done.then(
      (outcome) => {
        settle({ exitCode: outcome.exitCode, signal: outcome.signal, at: Date.now() })
        this.#log(`strata: exited code=${outcome.exitCode} signal=${outcome.signal}`)
      },
      (error) => {
        settle({ exitCode: null, signal: null, at: Date.now(), error: String(error) })
        this.#log('strata: spawn failed', error)
      },
    )

    if (!wait) {
      return this.status({ message: `Strata is starting on ${this.baseUrl}; the weights can take a minute.` })
    }

    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      if (exit !== null) {
        const tail = this.#processTail(25)
        throw new Error(
          `Strata exited during startup (code=${exit.exitCode} signal=${exit.signal}).` +
            (tail.length > 0 ? `\n\n${tail}` : ''),
        )
      }
      const attempt = await this.probe()
      if (attempt.reachable) {
        const owners = await this.findPortOwners()
        if (owners.length > 0) this.#pid = owners[0]
        return this.status({ health: attempt.health, message: `Strata is ready at ${this.baseUrl}.` })
      }
      try {
        await delay(this.#config.pollIntervalMs, signal)
      } catch {
        return this.status({ message: `Stopped waiting; Strata is still starting on ${this.baseUrl}.` })
      }
    }

    return this.status({
      message:
        `Strata is still starting after ${Math.round(budget / 1000)} s on ${this.baseUrl}. ` +
        'A cold load can take minutes; poll strata_status.',
    })
  }

  /**
   * Stop the server.
   *
   * A process this supervisor spawned is terminated through its handle. A
   * listener it did not spawn is still the Strata server this plugin serves —
   * typically one a *previous* plugin instance started, because a config change
   * or an HMR edit re-applies the plugin and the new instance has no child
   * handle — so it is stopped the only way available, by terminating the tree
   * that holds the configured port. `force` skips straight to that.
   *
   * @param options - force policy and termination budget.
   * @param options.force - terminate the port owner without waiting on a handle.
   * @param options.timeoutMs - budget for the listener to leave.
   * @returns the status after the attempt, including a `stopped` verdict.
   */
  async stop({ force = false, timeoutMs = this.#config.stopGraceMs + 5_000 } = {}) {
    // Whether this run spawned it, kept for the report: `force` bypasses the
    // handle, so the branch taken no longer says it.
    const owned = this.#child !== null
    const child = force ? null : this.#child
    if (child !== null) {
      this.#log('strata: terminating the supervised process')
      try {
        child.terminate()
      } catch (error) {
        this.#log('strata: terminate failed', error)
      }
      const exited = await Promise.race([
        child.waitForExit().then(() => true),
        delay(timeoutMs).then(() => false),
      ])
      if (this.#child === child) {
        this.#child = null
        this.#pid = null
        this.#startedAt = null
      }
      return {
        ...(await this.status({
          message: exited
            ? `Strata stopped; ${this.baseUrl} is free.`
            : `Strata did not exit within ${timeoutMs} ms; check the engine log.`,
        })),
        stopped: exited,
      }
    }

    const before = await this.probe()
    if (!before.reachable) {
      return {
        ...(await this.status({ message: `Nothing answers at ${this.baseUrl}; Strata is already stopped.` })),
        stopped: false,
      }
    }

    const owners = await this.findPortOwners()
    if (owners.length === 0) {
      return {
        ...(await this.status({
          message: `Strata answers at ${this.baseUrl} but no listening process could be resolved for the port.`,
        })),
        stopped: false,
      }
    }
    this.#log(`strata: terminating the port owner${owners.length > 1 ? 's' : ''} ${owners.join(', ')}`)
    let killed = 0
    for (const pid of owners) if (await this.#killTree(pid)) killed += 1

    const deadline = Date.now() + timeoutMs
    let after = await this.probe()
    while (after.reachable && Date.now() < deadline) {
      await delay(500)
      after = await this.probe()
    }
    this.#pid = null
    return {
      ...(await this.status({
        message: after.reachable
          ? `Strata still answers at ${this.baseUrl} after terminating ${killed} process(es); check the engine log.`
          : `Strata stopped; ${this.baseUrl} is free.` +
            (owned
              ? ''
              : ' (It was not started by this plugin run, so the tree holding the port was terminated.)'),
      })),
      stopped: !after.reachable,
      adopted: true,
    }
  }

  /** The last few lines of combined child output, for failure reports. */
  #processTail(lines) {
    const child = this.#child
    if (child === null) return ''
    const out = child.collected?.stdout?.readFrom(0).text ?? ''
    const err = child.collected?.stderr?.readFrom(0).text ?? ''
    return tailLines([out, err].filter((part) => part.length > 0).join('\n'), lines)
  }

  /**
   * A complete snapshot for the model and the `/strata` command.
   * @param overrides - fields to prefer over freshly observed ones.
   * @returns the status object every tool result shares.
   */
  async status(overrides = {}) {
    const probed = await this.probe()
    const health = overrides.health ?? (probed.reachable ? probed.health : undefined)
    const running = probed.reachable
    const owned = this.#child !== null
    const state = running ? 'ready' : owned ? 'starting' : this.#lastExit !== null ? 'exited' : 'stopped'

    return prune({
      state,
      running,
      ready: running && health?.loaded !== false,
      owned,
      external: running && !owned,
      pid: owned ? this.#pid : undefined,
      port: this.#config.port,
      host: this.#config.host,
      baseUrl: this.baseUrl,
      root: this.launch.root,
      configPath: this.launch.configPath,
      model: typeof health?.model === 'string' ? health.model : undefined,
      loaded: typeof health?.loaded === 'boolean' ? health.loaded : undefined,
      images: typeof health?.images === 'boolean' ? health.images : undefined,
      maxContext: typeof health?.max_context === 'number' ? health.max_context : undefined,
      uptimeSeconds: this.#startedAt === null ? undefined : Math.round((Date.now() - this.#startedAt) / 100) / 10,
      lastExit: this.#lastExit ?? undefined,
      message:
        overrides.message ??
        (running
          ? `Strata is serving at ${this.baseUrl}.`
          : owned
            ? `Strata is starting on ${this.baseUrl}.`
            : `Strata is not running; ${this.baseUrl} is free.`),
    })
  }
  /**
   * Read recent output.
   * @param options - which source to read and how much of it.
   * @param options.source - `process` for the piped child streams, `engine` for the engine's log file.
   * @param options.stream - `both`, `stdout`, or `stderr`; process source only.
   * @param options.lines - maximum number of trailing lines.
   * @returns the text plus truncation and spill facts.
   */
  async logs({ source = 'process', stream = 'both', lines = 80 } = {}) {
    if (source === 'engine') {
      const logPath = await readEngineLogPath(this.launch.configPath)
      if (logPath === undefined || !existsSync(logPath)) {
        return prune({
          source: 'engine',
          truncated: false,
          text: '',
          note: `The strata run config names no readable engine log (${logPath ?? 'no "log" field'}).`,
        })
      }
      const info = await stat(logPath)
      const start = Math.max(0, info.size - this.#config.logTailBytes)
      const length = info.size - start
      const handle = await open(logPath, 'r')
      try {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, start)
        return prune({
          source: 'engine',
          path: logPath,
          bytes: info.size,
          truncated: start > 0,
          text: tailLines(buffer.toString('utf8'), lines),
        })
      } finally {
        await handle.close()
      }
    }

    const child = this.#child
    if (child === null) {
      return prune({
        source: 'process',
        truncated: false,
        text: '',
        note: 'No supervised Strata process is running, so no output was captured. Use source="engine" for the model log.',
      })
    }
    const parts = []
    const spillPaths = []
    const wanted = stream === 'both' ? ['stdout', 'stderr'] : [stream]
    for (const name of wanted) {
      const read = child.collected?.[name]?.readFrom(0)
      if (read === undefined) continue
      if (read.text.length > 0) parts.push(read.text)
      if (read.spillPath !== undefined) spillPaths.push(read.spillPath)
    }
    return prune({
      source: 'process',
      pid: this.#pid,
      truncated: spillPaths.length > 0,
      spillPaths: spillPaths.length > 0 ? spillPaths : undefined,
      text: tailLines(parts.join('\n'), lines),
    })
  }

  /** Terminate the supervised process, if any. */
  async dispose() {
    if (this.#child === null) return
    this.#log('strata: disposing the supervisor')
    await this.stop().catch((error) => this.#log('strata: dispose failed', error))
  }

  /**
   * Terminate the process this supervisor spawned, without waiting for anything.
   *
   * Meant for `process.on('exit')`, where no promise can settle: it goes straight
   * to the OS — `taskkill /T /F`, so the whole tree goes and not just the server
   * process — and reports whether it had something to kill. A server started
   * outside this plugin is never touched.
   *
   * @param reason - recorded in the log line.
   * @returns whether a process tree was terminated.
   */
  killTreeSync(reason = 'shutting down') {
    // Only a process this supervisor spawned is ever killed.
    if (this.#child === null) return false
    // The subprocess handle does not expose the child's pid synchronously, so a
    // start that returned before /health left `#pid` empty: fall back to whoever
    // is listening on the port, resolved with a synchronous `netstat`.
    const pid = this.#pid ?? (process.platform === 'win32' ? portOwnerSync(this.#config.port) : null)
    if (pid === null) return false
    this.#log(`strata: killing process tree ${pid} (${reason})`)
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        process.kill(pid, 'SIGKILL')
      }
      return true
    } catch (error) {
      this.#log('strata: could not kill the process tree', error)
      return false
    }
  }
}
