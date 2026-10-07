/**
 * First-run installation — what `START-HERE.bat` does, driven from the panel.
 *
 * The shipped launcher does three things: find a Python, create `.venv` with it,
 * and run `setup.py --gguf-dir … --data-dir …`, which installs the pinned
 * requirements, fetches the engine and the model files, and writes the run
 * config. After that the launcher only ever starts the model.
 *
 * This module reproduces that chain:
 *
 *   1. `python -m venv .venv`                      (only when `.venv` is missing)
 *   2. `.venv\Scripts\python.exe setup.py --gguf-dir <models> --data-dir <data>
 *      --yes --no-start`
 *
 * `--yes` matters as much as anything else here: `setup.py` asks questions, and a
 * process with no terminal would otherwise die on `EOFError`
 * ("input ended before a setup answer was received"). `--no-start` keeps the
 * installer from launching the model itself, so this plugin stays the process's
 * owner instead of adopting a server it did not start.
 *
 * Output is collected the same way the supervisor collects the server's, so the
 * panel can show progress of an install that runs for many minutes.
 *
 * Imports node built-ins and the relative `./runconfig.js` only.
 *
 * @module dsh-strata-console/setup
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { totalmem } from 'node:os'
import { missingRunConfigFiles, readRunConfig } from './runconfig.js'
import { buildOptions, parseMarkedJson, parseProbe as parseProbeOutput, probeArgv } from './setup-options.js'

/** The oldest Python `setup.py` accepts, as `START-HERE.bat` enforces it. */
export const PYTHON_MIN = [3, 10]

/** Bytes of each stream kept in memory for the panel. */
const STREAM_TAIL_BYTES = 262_144

/** Bytes of each stream spilled to disk so nothing is lost mid-install. */
const STREAM_SPILL_BYTES = 8_388_608

/** How long a probe (a version check) may take. */
const PROBE_TIMEOUT_MS = 20_000

/** How long a detected interpreter stays trusted before being re-probed. */
const PROBE_CACHE_MS = 30_000

/** How long the option probe's result (and the GPU list) stays fresh. */
const OPTIONS_CACHE_MS = 300_000

/** How long the engine-version read stays fresh. */
const ENGINE_CACHE_MS = 60_000

/** How long a remote latest-release answer stays fresh. */
const LATEST_CACHE_MS = 300_000

/** Budget for the releases API. */
const LATEST_TIMEOUT_MS = 20_000

/** The engine version probe: `setup.py` owns both numbers. */
function engineProbeSource(root, configPath) {
  return [
    'import json, sys',
    `root = ${JSON.stringify(root)}`,
    `config = ${JSON.stringify(configPath)}`,
    'sys.path.insert(0, root)',
    'sys.argv = ["setup.py"]',
    'import setup',
    'from pathlib import Path',
    'cfg = json.loads(Path(config).read_text(encoding="utf-8-sig"))',
    'have = tuple(setup.engine_version(Path(cfg["exe"])))',
    'want = tuple(getattr(setup, "MIN_ENGINE", (0, 0, 0)))',
    'out = {',
    '  "version": ".".join(str(n) for n in have),',
    '  "required": ".".join(str(n) for n in want),',
    '  "needsUpdate": have < want,',
    '  "engine": str(cfg.get("exe", "")),',
    // Where the ready-made engine comes from: the remote check reads the
    // repository out of it, so a fork is checked against the fork.
    '  "prebuiltUrl": str(getattr(setup, "PREBUILT_URL", "")),',
    '}',
    'print("<<<JSON>>>" + json.dumps(out) + "<<<END>>>")',
  ].join('\n')
}

/** The interpreter inside the checkout's virtual environment. */
export function venvPython(root) {
  return process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python')
}

/** Whether a version pair is at least `PYTHON_MIN`. */
function supportsSetup(major, minor) {
  return major > PYTHON_MIN[0] || (major === PYTHON_MIN[0] && minor >= PYTHON_MIN[1])
}

/**
 * Compare two dotted versions numerically, so `0.1.40.2` beats `0.1.40` while
 * `0.1.9` loses to `0.1.10` (a string compare would get both backwards).
 * @param left - a dotted version.
 * @param right - another.
 * @returns -1, 0, or 1.
 */
function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number.parseInt(part, 10))
  const b = String(right).split('.').map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = Number.isFinite(a[index]) ? a[index] : 0
    const y = Number.isFinite(b[index]) ? b[index] : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Parse `3.12` out of a probe's stdout. */
function parseVersion(text) {  const match = /(\d+)\.(\d+)/u.exec(text ?? '')
  return match === null ? null : [Number(match[1]), Number(match[2])]
}

/**
 * Create the virtual environment and install everything, in the background.
 *
 * One install at a time: the chain is stateful (venv, then `setup.py`), and two
 * concurrent installs would race on the same `.venv`.
 */
export class SetupRunner {
  /** @param options.spawn - the harness subprocess provider. */
  /** @param options.root - the Strata checkout. */
  /** @param options.configPath - the run config the install should produce. */
  /** @param options.logger - optional sink for progress lines. */
  constructor({ spawn, root, configPath, logger }) {
    this.#spawn = spawn
    this.#root = root
    this.#configPath = configPath
    this.#log = logger
    this.#phase = 'idle'
  }

  #spawn

  #root

  #configPath

  #log

  #child = null

  #lastChild = null

  #phase

  #startedAt = null

  #lastExit = null

  #error = null

  #python = null

  #pythonCheckedAt = 0

  #dirs = { models: '', data: '' }

  #installArgs = []

  #updateArgs = []

  #engine = null

  #engineAt = 0

  #latest = null

  #latestAt = 0

  #options = null

  #optionsAt = 0

  /** Whether an install is in flight. */
  get running() {
    return this.#child !== null
  }

  /** Set the extra installer flags the panel's choices produced. */
  setInstallArgs(args) {
    this.#installArgs = Array.isArray(args) ? args.filter((entry) => typeof entry === 'string' && entry !== '') : []
  }

  /** Set the extra flags the manual update passes to `setup.py --update`. */
  setUpdateArgs(args) {
    this.#updateArgs = Array.isArray(args) ? args.filter((entry) => typeof entry === 'string' && entry !== '') : []
  }

  /**
   * The engine's version and the version this checkout requires.
   *
   * Both come from `setup.py` itself — `engine_version` reads `BUILD.json` beside
   * the binary (or the version compiled into it) and `MIN_ENGINE` is what this
   * release needs — so the panel never guesses from a file it happens to find.
   * @returns the two versions and whether an update is needed.
   */
  async engineInfo() {
    const now = Date.now()
    if (this.#engine !== null && now - this.#engineAt < ENGINE_CACHE_MS) return this.#engine
    const python = existsSync(venvPython(this.#root))
      ? { ok: true, argv: [venvPython(this.#root)] }
      : await this.detectPython()
    let info = { ok: false, note: '要读引擎版本，先要有可用的 Python（见下面的环境检查）' }
    if (python.ok !== false && existsSync(this.#configPath)) {
      const result = await this.#runOnce(
        [...(python.argv ?? [python.path]), '-c', engineProbeSource(this.#root, this.#configPath)],
        this.#root,
        60_000,
      )
      const parsed = parseMarkedJson(result.stdout)
      if (parsed !== undefined && typeof parsed.version === 'string') {
        info = { ok: true, ...parsed }
      } else {
        info = {
          ok: false,
          note: result.exitCode === 0
            ? '读不到版本：setup.py 没有输出预期的结果'
            : `读不到版本（退出码 ${result.exitCode}）：${(result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''}`,
        }
      }
    }
    this.#engine = info
    this.#engineAt = now
    return info
  }

  /** Whether this checkout was made with git, which is what an update pulls from. */
  get isGitCheckout() {
    return existsSync(join(this.#root, '.git'))
  }

  /**
   * The engine report the panel shows: the installed version, what this release
   * requires, and — once 检查最新版本 has run — what the repository publishes.
   *
   * `needsUpdate` follows `setup.py`'s own rule (`ver >= MIN_ENGINE` means it
   * keeps the engine it has), so the update button and the launcher agree.
   * @param info - the local engine facts.
   * @returns the report, with the remote comparison filled in when known.
   */
  #engineReport(info) {
    const latest = this.#latest
    let remoteNewer
    if (latest !== null && latest.ok === true && info.ok === true) {
      remoteNewer = compareVersions(latest.version, info.version) > 0
    }
    return {
      ...info,
      latest: latest ?? undefined,
      // The engine is only replaced when this release asks for a newer one.
      needsUpdate: info.ok === true ? info.needsUpdate === true : undefined,
      remoteNewer,
    }
  }

  /** Forget the cached engine version, so the panel can re-read it on demand. */
  invalidateEngine() {
    this.#engine = null
    this.#engineAt = 0
    this.#latest = null
    this.#latestAt = 0
  }

  /**
   * The newest engine the repository publishes — the same source `setup.py`
   * downloads from.
   *
   * The repository is read out of `PREBUILT_URL` in the installed `setup.py`, so a
   * fork is checked against the fork (upstream does the same when it verifies a
   * download). The release tag is `v<version>`, which is what makes it
   * comparable with the engine's own `BUILD.json` version.
   *
   * @param options.force - ignore the cache.
   * @returns the tag, its version, and when it was published — or why not.
   */
  async checkLatest({ force = false } = {}) {
    const now = Date.now()
    if (force !== true && this.#latest !== null && now - this.#latestAt < LATEST_CACHE_MS) return this.#latest
    const engine = await this.engineInfo()
    const url = typeof engine.prebuiltUrl === 'string' ? engine.prebuiltUrl : ''
    const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/releases\//u.exec(url)
    if (match === null) {
      this.#latest = { ok: false, note: url === '' ? '运行配置里没有可用的引擎来源' : `引擎来源不是 GitHub 发布页：${url}` }
      this.#latestAt = now
      return this.#latest
    }
    const api = `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`
    try {
      const response = await fetch(api, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-strata-console' },
        signal: AbortSignal.timeout(LATEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const tag = typeof body?.tag_name === 'string' ? body.tag_name : ''
      if (tag === '') throw new Error('发布信息里没有 tag_name')
      this.#latest = {
        ok: true,
        tag,
        version: tag.replace(/^v/u, ''),
        publishedAt: typeof body?.published_at === 'string' ? body.published_at : undefined,
        url: typeof body?.html_url === 'string' ? body.html_url : undefined,
        repo: `${match[1]}/${match[2]}`,
      }
    } catch (error) {
      this.#latest = {
        ok: false,
        repo: `${match[1]}/${match[2]}`,
        note: `查不到最新版本：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    this.#latestAt = now
    return this.#latest
  }

  /**
   * The questions `START-HERE.bat` asks, with the answers this machine can offer.
   *
   * The lists come from the installed `setup.py` (its tables and its argparse
   * help), so an update that adds a model size shows up here by itself. Cached,
   * because the panel polls the state it is part of.
   * @returns the choice list, the GPUs, and where the tables came from.
   */
  async options() {
    const now = Date.now()
    if (this.#options !== null && now - this.#optionsAt < OPTIONS_CACHE_MS) return this.#options
    const gpus = await this.gpus()
    const memoryGb = Math.round(totalmem() / 1024 ** 3)
    let parsed
    const python = existsSync(venvPython(this.#root))
      ? { argv: [venvPython(this.#root)] }
      : await this.detectPython()
    if (python.ok !== false) {
      const argv = probeArgv(python.argv ?? [python.path], this.#root)
      const result = await this.#runOnce(argv, this.#root, 60_000)
      if (result.exitCode === 0) parsed = parseProbeOutput(result.stdout)
    }
    this.#options = buildOptions(parsed, gpus, memoryGb)
    // A failed probe is worth retrying once the venv or the checkout changes,
    // but not on every poll.
    this.#optionsAt = now
    return this.#options
  }

  /** The GPUs `nvidia-smi` reports, which is what `--gpu` numbers. */
  async gpus() {
    const result = await this.#runOnce(
      ['nvidia-smi', '--query-gpu=index,name,memory.total', '--format=csv,noheader,nounits'],
      this.#root,
    )
    if (result.exitCode !== 0) return []
    const gpus = []
    for (const line of result.stdout.split(/\r?\n/u)) {
      const parts = line.split(',').map((entry) => entry.trim())
      if (parts.length < 3) continue
      const index = Number(parts[0])
      const memoryMb = Number(parts[2])
      if (!Number.isInteger(index)) continue
      gpus.push({ index, name: parts[1], memoryMb: Number.isFinite(memoryMb) ? memoryMb : undefined })
    }
    return gpus
  }

  /**
   * Snapshot the environment: what exists, what is missing, and what an install
   * would do next.
   *
   * The checkout and the run config are captured when the plugin is applied and
   * never cached further, because a settings change re-applies the plugin and
   * builds a new runner.
   * @returns the panel's checklist plus the current install's progress.
   */
  async state() {
    const root = this.#root
    const python = venvPython(root)
    const venv = { path: python, present: existsSync(python) }
    const config = { path: this.#configPath, present: existsSync(this.#configPath) }
    let missing = []
    if (config.present) {
      missing = missingRunConfigFiles(config.path)
      if (missing.length > 0 && !venv.present) {
        // Without a venv nothing can be checked out yet, so the model files are
        // an install target rather than a fault.
        missing = []
      }
    }
    // Only look for an interpreter when one is actually needed, exactly like the
    // shipped launcher: an existing install never probes for Python.
    const interpreter = venv.present ? { source: 'venv', path: python, ok: true } : await this.detectPython()
    const dirs = this.directories()
    return {
      root,
      ready: venv.present && config.present && missing.length === 0,
      venv,
      config,
      interpreter,
      missingModelFiles: missing,
      dirs,
      options: await this.options(),
      engine: this.#engineReport(await this.engineInfo()),
      gitCheckout: this.isGitCheckout,
      installArgs: this.#installArgs,
      updateArgs: this.#updateArgs,
      updateCommand: this.updateCommand(),
      installable: !venv.present || !config.present || missing.length > 0,
      phase: this.#phase,
      running: this.running,
      startedAt: this.#startedAt,
      lastExit: this.#lastExit,
      error: this.#error,
      command: this.command(),
    }
  }

  /**
   * Where an install would put the model and data files, in order of authority:
   * what the user typed for this install, then the roots the run config already
   * records, then the layout the shipped launcher assumes (siblings of the
   * checkout named `Strata-Models` and `Strata-data`).
   * @returns the two directories and which rule produced them.
   */
  directories() {
    if (this.#dirs.models !== '' && this.#dirs.data !== '') return { ...this.#dirs, source: 'typed' }
    const summary = readRunConfig(this.#configPath)
    if (summary.ok === true && summary.roots.models !== '' && summary.roots.data !== '') {
      return { models: summary.roots.models, data: summary.roots.data, source: 'config' }
    }
    const parent = dirname(this.#root)
    return { models: join(parent, 'Strata-Models'), data: join(parent, 'Strata-data'), source: 'default' }
  }

  /** The exact commands the next update would run, for the panel to show. */
  updateCommand() {
    const python = venvPython(this.#root)
    const extra = this.#updateArgs.length === 0 ? '' : ` ${this.#updateArgs.join(' ')}`
    const update = `${python} setup.py --update${extra}`
    return this.isGitCheckout ? `git pull --ff-only  →  ${update}` : update
  }

  /** The exact command the next install would run, for the panel to show. */
  command() {
    const root = this.#root
    const dirs = this.directories()
    const extra = this.#installArgs.length === 0 ? '' : ` ${this.#installArgs.join(' ')}`
    const tail = `${extra} --yes --no-start`
    if (!existsSync(venvPython(root))) {
      return `python -m venv .venv  →  .venv\\Scripts\\python.exe setup.py --gguf-dir "${dirs.models}" --data-dir "${dirs.data}"${tail}`
    }
    return `${venvPython(root)} setup.py --gguf-dir "${dirs.models}" --data-dir "${dirs.data}"${tail}`
  }

  /**
   * Find a Python able to create the environment, the way the launcher does: the
   * `py` launcher first, then `python` on PATH, then a per-user install.
   * @returns the interpreter facts; `ok: false` with a reason when none is usable.
   */
  async detectPython() {
    const now = Date.now()
    if (this.#python !== null && now - this.#pythonCheckedAt < PROBE_CACHE_MS) return this.#python
    const candidates = process.platform === 'win32'
      ? [
        ['py', '-3.13'], ['py', '-3.12'], ['py', '-3.11'], ['py', '-3.10'], ['py', '-3'],
        ['python'],
      ]
      : [['python3'], ['python']]
    const probe = 'import sys;print("%d.%d" % sys.version_info[:2])'
    for (const candidate of candidates) {
      const result = await this.#runOnce([...candidate, '-c', probe], this.#root)
      const version = parseVersion(result.stdout)
      if (result.exitCode === 0 && version !== null && supportsSetup(version[0], version[1])) {
        this.#python = {
          ok: true,
          source: candidate.join(' '),
          path: candidate[0],
          argv: candidate,
          version: `${version[0]}.${version[1]}`,
        }
        this.#pythonCheckedAt = now
        return this.#python
      }
    }
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA
      if (typeof local === 'string' && local !== '') {
        for (const minor of [13, 12, 11, 10]) {
          const path = join(local, 'Programs', 'Python', `Python3${minor}`, 'python.exe')
          if (!existsSync(path)) continue
          const result = await this.#runOnce([path, '-c', probe], this.#root)
          const version = parseVersion(result.stdout)
          if (result.exitCode === 0 && version !== null && supportsSetup(version[0], version[1])) {
            this.#python = { ok: true, source: path, path, argv: [path], version: `${version[0]}.${version[1]}` }
            this.#pythonCheckedAt = now
            return this.#python
          }
        }
      }
    }
    this.#python = {
      ok: false,
      source: '',
      path: '',
      argv: [],
      reason: `没有找到 Python ${PYTHON_MIN.join('.')}+：请先安装 Python，或用下面的按钮安装 Python 3.12`,
    }
    this.#pythonCheckedAt = now
    return this.#python
  }

  /**
   * Install Python 3.12 for the current user with winget — the first thing
   * `START-HERE.bat` tries when it finds no interpreter.
   * @returns the install outcome.
   */
  async installPython() {
    if (this.running) return { ok: false, error: '安装已经在运行' }
    this.#phase = 'python'
    this.#error = null
    this.#startedAt = Date.now()
    const argv = [
      'winget', 'install', '-e', '--id', 'Python.Python.3.12', '--scope', 'user',
      '--silent', '--source', 'winget', '--accept-package-agreements',
      '--accept-source-agreements', '--disable-interactivity',
    ]
    const code = await this.#runToCompletion(argv, this.#root)
    this.#lastExit = { exitCode: code, at: Date.now() }
    this.#python = null
    this.#pythonCheckedAt = 0
    if (code !== 0) {
      this.#phase = 'failed'
      this.#error = 'winget 安装 Python 失败（可能没有 winget）。请到 python.org 安装 Python 3.12，勾选 Add to PATH，然后回来重试。'
      return { ok: false, error: this.#error }
    }
    this.#phase = 'idle'
    return { ok: true }
  }

  /**
   * Run the install chain in the background.
   * @param options.modelsDir - the GGUF folder passed as `--gguf-dir`.
   * @param options.dataDir - the data folder passed as `--data-dir`.
   * @returns once the chain has started, not once it finishes.
   */
  async start({ modelsDir, dataDir }) {
    if (this.running) throw new Error('安装已经在运行')
    if (typeof modelsDir !== 'string' || modelsDir.trim() === '') throw new Error('模型目录不能为空')
    if (typeof dataDir !== 'string' || dataDir.trim() === '') throw new Error('数据目录不能为空')
    if (!existsSync(join(this.#root, 'setup.py'))) {
      throw new Error(`找不到 ${join(this.#root, 'setup.py')}；请先在上面的「Strata 目录」里选对检出目录`)
    }
    this.#dirs = { models: modelsDir.trim(), data: dataDir.trim() }
    this.#phase = 'starting'
    this.#error = null
    this.#lastExit = null
    this.#startedAt = Date.now()
    void this.#drive()
    return this.state()
  }

  /**
   * Run the update chain in the background — what `UPDATE.bat` does.
   *
   * The launcher pulls the newest code first (only when the checkout is a git
   * clone, and with `--ff-only` so a diverged history is reported rather than
   * merged), then runs what `START-HERE.bat` does before a start:
   * `setup.py --update`, which installs the pinned packages, swaps in a newer
   * engine when this release needs one, and upgrades each installed model's
   * config. It never touches model files and never starts the model.
   *
   * A failed pull stops the chain: continuing would report "updated" while the
   * code is still the old one, and the launcher stops there too.
   *
   * @param options.pull - whether to try `git pull` first; defaults to true.
   * @returns once the chain has started, not once it finishes.
   */
  async startUpdate({ pull = true } = {}) {
    if (this.running) throw new Error('已经有一个安装或更新在运行')
    if (!existsSync(join(this.#root, 'setup.py'))) {
      throw new Error(`找不到 ${join(this.#root, 'setup.py')}；请先在上面的「Strata 目录」里选对检出目录`)
    }
    this.#phase = 'starting'
    this.#error = null
    this.#lastExit = null
    this.#startedAt = Date.now()
    void this.#driveUpdate({ pull: pull !== false })
    return this.state()
  }

  /** Terminate a running install (it is not resumable by itself). */
  async stop() {
    const child = this.#child
    if (child === null) return { stopped: true }
    this.#log?.(`strata-setup: terminating install ${child.pid ?? ''}`.trim())
    try {
      child.terminate()
    } catch {}
    await Promise.race([child.waitForExit(), new Promise((resolve) => setTimeout(resolve, 20_000))])
    this.#phase = 'stopped'
    this.#lastExit = { exitCode: null, signal: 'terminated', at: Date.now() }
    return { stopped: true }
  }

  /**
   * The collected output of the install in flight, or of the last one once it
   * has finished — a failed install is exactly when its output matters.
   */
  logs() {
    const child = this.#child ?? this.#lastChild
    if (child === null) return { text: '', note: '还没有运行过安装。' }
    const out = child.collected?.stdout?.readFrom(0).text ?? ''
    const err = child.collected?.stderr?.readFrom(0).text ?? ''
    return { text: err === '' ? out : `${out}${out === '' ? '' : '\n'}[stderr]\n${err}`, note: null }
  }

  /** Release the child when the plugin goes away. */
  async dispose() {
    if (this.running) await this.stop()
  }

  /**
   * The update chain: `git pull --ff-only` (a git clone only), then
   * `setup.py --update`, reporting progress through `#phase`.
   */
  async #driveUpdate({ pull }) {
    try {
      if (pull && this.isGitCheckout) {
        this.#phase = 'git'
        this.#log?.(`strata-update: git pull --ff-only (${this.#root})`)
        const code = await this.#runToCompletion(['git', 'pull', '--ff-only'], this.#root)
        if (code !== 0) {
          // Like the launcher: a failed pull means the code is still the old
          // one, so reporting "updated" would be a lie. Local edits and a
          // rewritten history are the two usual causes.
          this.#lastExit = { exitCode: code, at: Date.now() }
          throw new Error(
            `git pull 退出码 ${code}，代码没有更新（本地改动或历史被重写都可能阻止它；` +
            '上面的输出里有原因，"git status" 会列出被改动的文件）。要跳过拉取只更新引擎与配置，' +
            '就用下面的「按参数更新」并勾掉/关闭拉取。',
          )
        }
      }
      this.#phase = 'update'
      const argv = [venvPython(this.#root), 'setup.py', '--update', ...this.#updateArgs]
      this.#log?.(`strata-update: ${argv.join(' ')}`)
      const code = await this.#runToCompletion(argv, this.#root)
      this.#lastExit = { exitCode: code, at: Date.now() }
      this.invalidateEngine()
      this.#phase = code === 0 ? 'done' : 'failed'
      if (code !== 0) this.#error = `setup.py --update 退出码 ${code}，请看下面的输出`
    } catch (error) {
      this.#phase = 'failed'
      this.#error = error instanceof Error ? error.message : String(error)
      this.#lastExit = this.#lastExit ?? { exitCode: null, signal: null, at: Date.now() }
    } finally {
      this.#child = null
      if (this.#phase !== 'done' && this.#phase !== 'failed') this.#phase = 'idle'
    }
  }

  /** venv, then `setup.py`, reporting progress through `#phase`. */
  async #drive() {
    try {
      const python = venvPython(this.#root)
      if (!existsSync(python)) {
        this.#phase = 'python'
        const interpreter = await this.detectPython()
        if (interpreter.ok !== true) throw new Error(interpreter.reason ?? '没有找到可用的 Python')
        this.#phase = 'venv'
        this.#log?.(`strata-setup: ${interpreter.source} -m venv .venv`)
        const code = await this.#runToCompletion([...interpreter.argv, '-m', 'venv', '.venv'], this.#root)
        if (code !== 0) throw new Error(`创建 .venv 失败（退出码 ${code}）`)
        if (!existsSync(python)) throw new Error(`venv 命令完成但 ${python} 不存在`)
      }
      this.#phase = 'setup'
      const argv = [
        python, 'setup.py',
        '--gguf-dir', this.#dirs.models,
        '--data-dir', this.#dirs.data,
        // The panel's answers first, then `--yes` for every question it did not
        // ask: an unexposed question keeps the installer's recommendation.
        ...this.#installArgs,
        '--yes', '--no-start',
      ]
      this.#log?.(`strata-setup: ${argv.join(' ')}`)
      const code = await this.#runToCompletion(argv, this.#root)
      this.#lastExit = { exitCode: code, at: Date.now() }
      this.#phase = code === 0 ? 'done' : 'failed'
      if (code !== 0) this.#error = `setup.py 退出码 ${code}，请看下面的输出`
    } catch (error) {
      this.#phase = 'failed'
      this.#error = error instanceof Error ? error.message : String(error)
      this.#lastExit = { exitCode: null, signal: null, at: Date.now() }
    } finally {
      this.#child = null
      if (this.#phase !== 'done' && this.#phase !== 'failed') this.#phase = 'idle'
    }
  }

  /** Spawn one command and wait for it, keeping it as the active child. */
  async #runToCompletion(argv, cwd) {
    const handle = this.#spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STREAM_TAIL_BYTES, spill: { maxBytes: STREAM_SPILL_BYTES } },
        stderr: { maxBytes: STREAM_TAIL_BYTES, spill: { maxBytes: STREAM_SPILL_BYTES } },
      },
      graceMs: 10_000,
      env: process.env,
    })
    this.#child = handle
    this.#lastChild = handle
    const outcome = await handle.done
    return outcome.exitCode
  }

  /** Run one short probe and collect its output. */
  async #runOnce(argv, cwd, timeoutMs = PROBE_TIMEOUT_MS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('probe timed out')), timeoutMs)
    try {
      const handle = this.#spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 262_144 }, stderr: { maxBytes: 16_384 } },
        graceMs: 3_000,
        signal: controller.signal,
        env: process.env,
      })
      const outcome = await handle.done
      return {
        exitCode: outcome.exitCode,
        stdout: handle.collected?.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected?.stderr?.readFrom(0).text ?? '',
      }
    } catch (error) {
      return { exitCode: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
    }
  }
}
