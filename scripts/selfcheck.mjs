/**
 * Standalone self-check for the Strata supervisor and the directory convention.
 *
 * `lib/process/supervisor.js` and `lib/layout.js` import no Cordis/DSH module,
 * so both can be exercised with plain Node. This script supplies the one host
 * capability the supervisor needs — `ctx.subprocess.spawn` — through a small
 * adapter over `node:child_process` that reproduces the `SubprocessHandle`
 * surface: collected tail readers, `done`, `waitForExit()`, and tree-killing
 * `terminate()`.
 *
 * Usage:
 *   node scripts/selfcheck.mjs [start|status|logs|layout|cycle] [--root <path>] [--port <n>]
 *
 * `layout` prints the directory-convention report for `--root` (or the default)
 * and starts nothing.
 *
 * `cycle` (the default) starts the server, waits for /health, prints status and
 * logs, then stops it again. Run it while DeepSeek Harness is closed to avoid
 * two supervisors competing for the same port.
 *
 * @module dsh-strata-console/selfcheck
 */

import { spawn as spawnProcess, spawnSync } from 'node:child_process'
import { mkdtempSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StrataSupervisor } from '../lib/process/supervisor.js'
import { describeLayout, inspectLayout } from '../lib/layout.js'
import { SetupRunner } from '../lib/setup.js'

/**
 * Bounded in-memory tail with an optional spill file, matching the collection
 * contract of `@deepseek-ai/dsh-subprocess-local` closely enough for the
 * supervisor's reads.
 */
class Collector {
  constructor(maxBytes, spillDir, label) {
    this.maxBytes = maxBytes
    this.spillDir = spillDir
    this.label = label
    this.chunks = []
    this.bytes = 0
    this.total = 0
    this.spillFd = undefined
    this.spillFile = undefined
  }

  push(chunk) {
    this.total += chunk.length
    if (this.spillDir !== undefined && (this.bytes + chunk.length > this.maxBytes || this.spillFd !== undefined)) {
      if (this.spillFd === undefined) {
        this.spillFile = join(this.spillDir, `${this.label}.log`)
        this.spillFd = openSync(this.spillFile, 'w')
        for (const prior of this.chunks) writeSync(this.spillFd, prior)
      }
      writeSync(this.spillFd, chunk)
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0]
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
    }
  }

  readFrom(fromByte) {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    return {
      text: (lossy ? buffer : buffer.subarray(fromByte - windowStart)).toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...(this.spillFile === undefined ? {} : { spillPath: this.spillFile }),
    }
  }

  seal() {
    if (this.spillFd === undefined) return
    closeSync(this.spillFd)
    this.spillFd = undefined
  }
}

/** Terminate a whole process tree, as the local provider's Windows path does. */
function killTree(pid) {
  if (pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
}

/**
 * The `ctx.subprocess.spawn` seam, backed by `node:child_process`.
 * @param spillDir - directory spill files are written to, or `undefined` for tail-only.
 * @returns a function with the `SubprocessHandle`-producing signature.
 */
function makeSpawn(spillDir) {
  return (spec) => {
    const readMode = (mode) => {
      if (mode === 'inherit') return 'inherit'
      if (mode === 'pipe') return 'pipe'
      return 'pipe'
    }
    const child = spawnProcess(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: [spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore', readMode(spec.stdio.stdout), readMode(spec.stdio.stderr)],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })

    const stdout = new Collector(spec.stdio.stdout.maxBytes ?? 1 << 20, spec.stdio.stdout.spill === undefined ? undefined : spillDir, 'stdout')
    const stderr = new Collector(spec.stdio.stderr.maxBytes ?? 1 << 20, spec.stdio.stderr.spill === undefined ? undefined : spillDir, 'stderr')
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))

    let settled = false
    const done = new Promise((resolveDone, rejectDone) => {
      child.once('error', (error) => {
        if (settled) return
        settled = true
        stdout.seal()
        stderr.seal()
        rejectDone(error)
      })
      child.once('exit', (exitCode, signal) => {
        if (settled) return
        settled = true
        stdout.seal()
        stderr.seal()
        resolveDone({ exitCode, signal })
      })
    })
    done.catch(() => {})

    const onAbort = () => killTree(child.pid)
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    return {
      pid: child.pid,
      stdin: child.stdin ?? undefined,
      stdout: child.stdout ?? undefined,
      stderr: child.stderr ?? undefined,
      control: undefined,
      collected: { stdout, stderr },
      done,
      terminate() {
        killTree(child.pid)
      },
      waitForExit(signal) {
        return new Promise((resolveExit) => {
          if (settled) {
            resolveExit(true)
            return
          }
          const finish = () => {
            signal?.removeEventListener('abort', onSignalAbort)
            resolveExit(true)
          }
          const onSignalAbort = () => {
            child.removeListener('exit', finish)
            resolveExit(false)
          }
          child.once('exit', finish)
          signal?.addEventListener('abort', onSignalAbort, { once: true })
        })
      },
    }
  }
}

/** Parse `--key value` pairs. */
function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) options[key] = true
    else {
      options[key] = key === 'port' ? Number(next) : next
      index += 1
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const verb = process.argv[2]?.startsWith('--') ? 'cycle' : (process.argv[2] ?? 'cycle')
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-strata-console-selfcheck-'))

const supervisor = new StrataSupervisor({
  spawn: makeSpawn(spillDir),
  log: (...args) => console.error('[supervisor]', ...args),
  config: {
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.port === undefined ? {} : { port: options.port }),
    readyTimeoutMs: Number(options.timeout ?? 300) * 1000,
  },
})

/** Print one status snapshot. */
function show(status) {
  console.log(JSON.stringify(status, null, 2))
}

try {
  if (verb === 'status') {
    show(await supervisor.status())
  } else if (verb === 'logs') {
    const logs = await supervisor.logs({ source: options.source ?? 'engine', lines: Number(options.lines ?? 20) })
    console.log(logs.text.length > 0 ? logs.text : (logs.note ?? 'no output'))
  } else if (verb === 'start') {
    show(await supervisor.start())
  } else if (verb === 'stop') {
    show(await supervisor.stop({ force: options.force === true }))
  } else if (verb === 'cycle') {
    console.log('--- start')
    show(await supervisor.start())
    console.log('--- process log tail')
    const processLogs = await supervisor.logs({ source: 'process', lines: 15 })
    console.log(processLogs.text.length > 0 ? processLogs.text : (processLogs.note ?? 'no output'))
    console.log('--- engine log tail')
    const engineLogs = await supervisor.logs({ source: 'engine', lines: 5 })
    console.log(engineLogs.text.length > 0 ? engineLogs.text : (engineLogs.note ?? 'no output'))
    console.log('--- stop')
    show(await supervisor.stop())
  } else if (verb === 'layout') {
    // The convention check is framework-free, so it runs without DSH too. With
    // no --root it checks the supervisor's own configured directory, not the cwd.
    const report = inspectLayout(supervisor.config.root)
    show(report)
    console.log(describeLayout(report))
  } else if (verb === 'setup') {
    // The first-run checklist, without installing anything: which pieces exist,
    // which interpreter an install would use, and the exact command it would run.
    const runner = new SetupRunner({
      spawn: (spec) => provider.spawn(spec),
      root: supervisor.config.root,
      configPath: supervisor.launch.configPath,
    })
    const state = await runner.state()
    show(state)
    console.log(state.ready ? 'environment is ready' : 'an install is needed')
  } else {
    console.error(`unknown verb ${JSON.stringify(verb)}; expected start, stop, status, logs, layout, setup, or cycle`)
    process.exitCode = 2
  }
} catch (error) {
  console.error('self-check failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
  try {
    await supervisor.stop({ force: true })
  } catch {}
} finally {
  for (const name of ['stdout.log', 'stderr.log']) {
    try {
      unlinkSync(join(spillDir, name))
    } catch {}
  }
}
