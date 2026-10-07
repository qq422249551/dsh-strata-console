/**
 * dsh-strata-console — run the local Strata model server from DeepSeek Harness.
 *
 * Strata (`D:\strata`) is a GGUF inference server: `engine\strata.exe` loads
 * `Strata-Models\*.gguf` and serves an OpenAI-compatible endpoint on
 * `http://127.0.0.1:8080/v1`. A DSH profile can already point an LLM provider at
 * that URL, so the missing half is process lifecycle: nothing starts the server.
 *
 * This is the **host half**. It contributes:
 *
 *   - `strata_start`  spawn the server and wait for `/health`
 *   - `strata_stop`   terminate the server this plugin started
 *   - `strata_status` report readiness, model, context window, and load state
 *   - `strata_logs`   read the captured process output or the engine log
 *   - `/strata/api`   the routes the browser buttons call (`lib/client.js`)
 *
 * It also publishes the supervisor as the `strata` service so another plugin can
 * drive the server without going through a tool call.
 *
 * ## Why this module imports nothing but its siblings
 *
 * DSH installs a per-module resolution interception layer for paths under the
 * profiles tree and under a linked profile root, and that is how plugins import
 * `@deepseek-ai/*` peers. The layer is computed from the runtime resolution; a
 * plugin mounted by a *live* profile-patch change (configuration HMR) is
 * imported before the new resolution replaces the old one, so a freshly linked
 * root has no interception layer yet and every bare import from it fails with
 * `ERR_MODULE_NOT_FOUND`. The entry then sits inactive with no user-visible
 * reason. Importing only `./process/supervisor.js` and `./http-api.js` keeps this
 * plugin independent of that machinery: it mounts at boot and on a live patch
 * alike, from a linked directory or from a plain path, and it needs no
 * `peerDependencies` at all.
 *
 * The cost is that `defineTool` and a schemastery `Config` are unavailable, so
 * this module registers raw `ToolDefinition`s with JSON-Schema parameters and
 * normalizes its own configuration.
 *
 * The client half is a separate module because the browser module system loads
 * `lib/client.js` as a CommonJS-style factory (`window.__ModuleLoader__.load`),
 * not as an ES module.
 *
 * @module dsh-strata-console/host
 */

import { existsSync } from 'node:fs'
import { StrataSupervisor, STRATA_DEFAULTS, prune, isPortFree } from './process/supervisor.js'
import { createStrataApi } from './http-api.js'
import { describeLayout, inspectLayout } from './layout.js'
import {
  RESTART_REQUIRED_KEYS,
  SETTINGS_FIELDS,
  displaySettings,
  fallbacksFor,
  normalizeSettings,
} from './settings.js'
import { listRunConfigs, readRunConfig, writeRunConfig } from './runconfig.js'
import { SetupRunner, venvPython } from './setup.js'

export const name = 'strata'

/** Tool registration and the process seam; the browser half needs no host service of ours. */
export const inject = ['tools', 'subprocess']

/** A string config field, falling back when absent or empty. */
function text(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/** A boolean config field, falling back when absent. */
function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** A positive finite number config field, falling back when absent. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** A non-negative finite number config field, falling back when absent. */
function nonNegative(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** A list of strings, dropping anything else. */
function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

/**
 * Normalize the profile patch's `config` block into the supervisor's options.
 * @param raw - the loader-supplied configuration object, possibly empty.
 * @returns the effective configuration, documented in the README.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const idleUnloadSeconds = nonNegative(input.idleUnloadSeconds, 0)
  return {
    root: text(input.root, STRATA_DEFAULTS.root),
    python: text(input.python, ''),
    config: text(input.config, ''),
    port: positive(input.port, STRATA_DEFAULTS.port),
    host: text(input.host, STRATA_DEFAULTS.host),
    extraArgs: stringList(input.extraArgs),
    readyTimeoutMs: positive(input.readyTimeoutSeconds, 300) * 1000,
    idleUnloadSeconds,
    installArgs: stringList(input.installArgs),
    updateArgs: stringList(input.updateArgs),
    defaultModelOnReady: flag(input.defaultModelOnReady, true),
    stopOnExit: flag(input.stopOnExit, true),
  }
}

/** The JSON projection of one status snapshot, shared by every strata tool. */
function statusSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      state: { type: 'string', description: 'stopped | starting | ready | exited' },
      running: { type: 'boolean', description: 'Whether /health answered on the configured port.' },
      ready: { type: 'boolean', description: 'Whether the listener is up and the weights are resident.' },
      owned: { type: 'boolean', description: 'Whether DeepSeek Harness started this process.' },
      external: { type: 'boolean', description: 'Running, but started outside DeepSeek Harness.' },
      stopped: { type: 'boolean', description: 'strata_stop only: whether the port is free afterwards.' },
      adopted: {
        type: 'boolean',
        description:
          'strata_stop only: the listener was not spawned by this plugin run (a reload loses the child handle), ' +
          'so its process tree was terminated by port.',
      },
      pid: { type: 'integer', description: 'The listening process id, when it could be resolved.' },
      port: { type: 'integer' },
      host: { type: 'string' },
      baseUrl: { type: 'string', description: 'The OpenAI-compatible base URL, e.g. http://127.0.0.1:8080.' },
      root: { type: 'string' },
      configPath: { type: 'string' },
      model: { type: 'string', description: 'The model id the server reports.' },
      loaded: { type: 'boolean', description: 'Whether the weights are in VRAM right now.' },
      images: { type: 'boolean', description: 'Whether the vision encoder is available.' },
      maxContext: { type: 'integer', description: 'The served context window in tokens.' },
      uptimeSeconds: { type: 'number', description: 'Seconds since this plugin spawned the process.' },
      lastExit: {
        type: 'object',
        additionalProperties: false,
        description: 'The last observed exit of a process this plugin spawned.',
        properties: {
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          at: { type: 'integer', description: 'Epoch milliseconds of the exit.' },
          error: { type: 'string', description: 'Present when the process could not be spawned at all.' },
        },
      },
      message: { type: 'string', description: 'One line for the user.' },
      logTail: { type: 'string', description: 'Recent output, when the caller asked for it.' },
    },
    required: ['state', 'running', 'ready', 'owned', 'external', 'port', 'host', 'baseUrl', 'root', 'configPath', 'message'],
  }
}

/** One human-readable line for a status snapshot. */
function describeStatus(value) {
  const bits = [`Strata is ${value.state}`]
  if (value.running) {
    bits.push(`on ${value.baseUrl}`)
    if (value.model !== undefined) bits.push(`model ${value.model}`)
    if (value.loaded === false) bits.push('weights not loaded yet')
    if (value.maxContext !== undefined) bits.push(`${value.maxContext} token context`)
    if (value.external === true) bits.push('(started outside DeepSeek Harness)')
  }
  return `${bits.join(', ')}. ${value.message}`
}

/** Present one status snapshot as model-visible text. */
function renderStatus(_args, value) {
  return [{ type: 'text', text: describeStatus(value) }]
}

/** Coerce a model-supplied integer permission. */
function asCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * Mount the supervisor, its tools, and the `/strata` command.
 * @param ctx - registrant context carrying the tool, subprocess, and command registries.
 * @param config - the raw configuration from the profile patch.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const supervisor = new StrataSupervisor({
    spawn: (spec) => ctx.subprocess.spawn(spec),
    log: (...args) => ctx.logger?.debug?.(...args),
    config: {
      root: settings.root,
      python: settings.python,
      config: settings.config,
      port: settings.port,
      host: settings.host,
      readyTimeoutMs: settings.readyTimeoutMs,
      extraArgs: [
        ...settings.extraArgs,
        ...(settings.idleUnloadSeconds > 0 ? ['--idle-unload', String(settings.idleUnloadSeconds)] : []),
      ],
    },
  })

  ctx.provide('strata', supervisor)

  // First-run installation: the same chain START-HERE.bat runs, so a checkout
  // without a venv, a run config, or model files can be set up from the panel.
  const setup = new SetupRunner({
    spawn: (spec) => ctx.subprocess.spawn(spec),
    root: settings.root,
    configPath: supervisor.launch.configPath,
    logger: (...args) => ctx.logger?.info?.(...args),
  })
  setup.setInstallArgs(settings.installArgs)
  setup.setUpdateArgs(settings.updateArgs)

  ctx.tools.register({
    name: 'strata_start',
    description:
      'Start the local Strata model server and wait until it answers /health. The server is the GGUF engine under the ' +
      'Strata checkout and it serves an OpenAI-compatible API on the configured port, which this profile already ' +
      'registers as the qwen3.8-flash-next model. Call this before asking for that model, or when a request fails with ' +
      'a connection error. A server that already listens is adopted rather than started twice.',
    parameters: {
      type: 'object',
      properties: {
        wait: { type: 'boolean', description: 'Wait for /health before returning. Default true.' },
        timeoutSeconds: { type: 'integer', description: 'Readiness budget in seconds; overrides the configured 300.' },
      },
    },
    output: { schema: statusSchema(), render: renderStatus },
    async execute(args, exec) {
      const budget = asCount(args?.timeoutSeconds)
      const snapshot = await supervisor.start({
        wait: args?.wait !== false,
        timeoutMs: budget === undefined ? undefined : budget * 1000,
        signal: exec?.signal,
      })
      // Reaching /health here means the model is usable: switch the default to
      // it. A start that returns early is watched instead.
      if (snapshot.ready === true) {
        try {
          await applyModel()
        } catch (error) {
          ctx.logger?.warn?.(`strata: default model not switched: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else if (snapshot.state === 'starting') {
        watchForReady()
      }
      return prune(snapshot)
    },
    presentCall: (args) => ({ card: 'generic', title: 'Start Strata', kind: 'other', rawInput: args ?? {} }),
  })

  ctx.tools.register({
    name: 'strata_stop',
    description:
      'Stop the Strata model server, freeing its port and the VRAM the weights hold. It stops whatever serves the ' +
      'configured port — including an instance a previous plugin run or START-HERE.bat started, which is reported as ' +
      'adopted. Pass force to skip the child handle and terminate the port owner directly.',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'Also terminate a server this plugin did not start. Default false.' },
        timeoutSeconds: { type: 'integer', description: 'How long to wait for the port to free up.' },
      },
    },
    output: {
      schema: statusSchema(),
      render: (_args, value) => [{ type: 'text', text: (value.stopped === true ? 'Stopped. ' : '') + value.message }],
    },
    async execute(args) {
      const budget = asCount(args?.timeoutSeconds)
      return prune(await supervisor.stop({
        force: args?.force === true,
        ...(budget === undefined ? {} : { timeoutMs: budget * 1000 }),
      }))
    },
    presentCall: (args) => ({ card: 'generic', title: 'Stop Strata', kind: 'other', rawInput: args ?? {} }),
  })

  ctx.tools.register({
    name: 'strata_status',
    description:
      'Report whether the local Strata model server is running, whether its weights are loaded, which model and context ' +
      'window it serves, and where. Use it to poll a start that has not finished yet.',
    parameters: {
      type: 'object',
      properties: {
        includeLog: { type: 'boolean', description: 'Append the most recent captured output.' },
        logLines: { type: 'integer', description: 'How many trailing log lines to append. Default 20.' },
      },
    },
    output: { schema: statusSchema(), render: renderStatus },
    async execute(args) {
      const status = prune(await supervisor.status())
      if (args?.includeLog !== true) return status
      const logs = await supervisor.logs({ source: 'process', lines: asCount(args.logLines) ?? 20 })
      return { ...status, logTail: logs.text.length > 0 ? logs.text : (logs.note ?? '') }
    },
    presentCall: () => ({ card: 'generic', title: 'Strata status', kind: 'other', rawInput: {} }),
  })

  ctx.tools.register({
    name: 'strata_logs',
    description:
      'Read recent Strata output. source="process" returns the stdout/stderr DeepSeek Harness captured from the server ' +
      'it started; source="engine" returns the tail of the engine log file named by the Strata run config, where token ' +
      'rates and expert-cache statistics are written.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['process', 'engine'], description: 'Which output to read. Default process.' },
        stream: { type: 'string', enum: ['both', 'stdout', 'stderr'], description: 'Process source only. Default both.' },
        lines: { type: 'integer', description: 'How many trailing lines to return. Default 80.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string' },
          path: { type: 'string', description: 'The engine log path, for the engine source.' },
          pid: { type: 'integer' },
          bytes: { type: 'integer', description: 'Total size of the engine log file.' },
          truncated: { type: 'boolean' },
          spillPaths: { type: 'array', items: { type: 'string' }, description: 'Files holding the complete stream when the in-memory tail overflowed.' },
          note: { type: 'string', description: 'Why the text is empty, when it is.' },
          text: { type: 'string' },
        },
        required: ['source', 'truncated', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text.length > 0 ? value.text : (value.note ?? 'no output') }],
    },
    async execute(args) {
      return prune(await supervisor.logs({
        source: args?.source === 'engine' ? 'engine' : 'process',
        stream: args?.stream === 'stdout' || args?.stream === 'stderr' ? args.stream : 'both',
        lines: asCount(args?.lines) ?? 80,
      }))
    },
    presentCall: (args) => ({ card: 'generic', title: 'Strata logs', kind: 'other', rawInput: args ?? {} }),
  })

  // The browser buttons drive the same supervisor through these routes. A
  // composition without a web server (headless, SDK, ACP) simply has no buttons
  // and keeps the tools.
  // Routes and the settings panel need the web server, which may mount *after*
  // this plugin: `ctx.get` only returns a service whose provider is already
  // active, so a bare lookup skipped every route silently while the tools kept
  // working — nothing looked wrong until the panel answered 404. `ctx.inject`
  // starts a nested plugin body that waits for the service instead of assuming
  // it, and in a composition with no web server the body simply never runs.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    if (webServer === undefined) return
    /**
     * This plugin's own Loader entry, which is what `configEditor` addresses:
     * `edit` writes the value into the profile patch and reconciles through the
     * Loader, so a change takes effect without a restart.
     * @returns the editor and this entry.
     */
    const ownEntry = () => {
      const editor = ctx.get('configEditor')
      const entry = ctx.fiber?.entry
      if (editor === undefined) {
        throw new Error('这个 DSH 组合没有 configEditor，无法保存设置；请直接改 profile 的 cordis.patch.yml')
      }
      if (entry === undefined) throw new Error('找不到当前插件条目，无法保存设置')
      return { editor, entry }
    }

    /** Every LLM provider row whose baseURL dials a loopback port. */
    const providerRows = () => {
      const editor = ctx.get('configEditor')
      if (editor === undefined) return []
      const rows = []
      for (const item of editor.configuration()) {
        const providers = item.entry.options.config?.providers
        if (providers === null || typeof providers !== 'object') continue
        for (const [key, value] of Object.entries(providers)) {
          const baseURL = value?.baseURL
          if (typeof baseURL !== 'string') continue
          let url
          try {
            url = new URL(baseURL)
          } catch {
            continue
          }
          if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) continue
          rows.push({
            entryId: item.entry.options.id,
            entry: item.entry,
            provider: key,
            baseURL,
            port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
            // The ids this provider offers, so a default selection can name one.
            models: Array.isArray(value.models)
              ? value.models.map((model) => model?.id).filter((id) => typeof id === 'string')
              : [],
          })
        }
      }
      return rows
    }

    /**
     * The provider and model a default selection should name to reach this
     * server: the row that dials the configured port, with the model the run
     * config reports when it has one, else that provider's first model.
     *
     * Nothing is added to the model list — this only picks from what the profile
     * already declares.
     */
    const modelTarget = () => {
      const row = providerRows().find((candidate) => candidate.port === settings.port)
      if (row === undefined) return null
      const configured = readRunConfig(supervisor.launch.configPath)
      const wanted = configured.ok === true ? configured.modelName : ''
      const model = row.models.includes(wanted) ? wanted : (row.models[0] ?? wanted)
      if (model === '') return null
      return { entryId: row.entryId, provider: row.provider, model, baseURL: row.baseURL }
    }

    /**
     * Point the default inference model somewhere, through the service that owns
     * that selection — never by adding a model to the list.
     * @param options.force - apply even when the automatic switch is off.
     * @param options.target - an explicit `{provider, model}`; defaults to Strata.
     * @returns what happened, for the panel and the tools to report.
     */
    const applyModel = async ({ force = false, target: explicit = null } = {}) => {
      const target = explicit ?? modelTarget()
      if (target === null) {
        return { applied: false, reason: '这个 profile 里没有指向该端口的模型提供方，先在设置里加上它', target: null }
      }
      const service = ctx.get('agentDefaultModel')
      if (service === undefined) {
        return { applied: false, reason: '这个组合没有 agentDefaultModel 服务', target }
      }
      let current = null
      try {
        current = service.currentSelection()
      } catch {
        current = null
      }
      const same = current !== null && current.provider === target.provider && current.model === target.model
      if (same) return { applied: true, already: true, target, current, previous: lastDefault }
      if (force === false && settings.defaultModelOnReady !== true) {
        return { applied: false, reason: '「就绪后切换默认模型」是关闭的', target, current }
      }      try {
        // The complete selection is replaced. `reasoningEffort` is only carried
        // when the caller names one: an explicit null would be stored as the
        // *string* "null" (the profile writer quotes it), and the local model has
        // no such knob anyway.
        const payload = { provider: target.provider, model: target.model }
        if (target.reasoningEffort !== undefined) payload.reasoningEffort = target.reasoningEffort
        await service.saveSelection(payload)
      } catch (error) {
        return {
          applied: false,
          reason: error instanceof Error ? error.message : String(error),
          target,
          current,
        }
      }
      // Kept in memory only, so the panel can offer the way back. The selection
      // service reports provider and model alone, so the reasoning effort comes
      // from the row that stores it.
      if (current !== null && typeof current.provider === 'string' && typeof current.model === 'string') {
        const stored = defaultModelRow()
        const effort = typeof current.reasoningEffort === 'string'
          ? current.reasoningEffort
          : (typeof stored?.reasoningEffort === 'string' ? stored.reasoningEffort : undefined)
        lastDefault = {
          provider: current.provider,
          model: current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        }
      }
      ctx.logger?.info?.(`strata: default model → ${target.provider} · ${target.model}`)
      return { applied: true, target, current, previous: lastDefault }
    }

    /**
     * The selection the last switch replaced, remembered in memory so the panel
     * can offer the way back.
     */
    let lastDefault = null

    /** The configured default-model row, which is where its reasoning effort lives. */
    const defaultModelRow = () => {
      const editor = ctx.get('configEditor')
      if (editor === undefined) return undefined
      const item = editor.configuration().find((candidate) => (
        candidate.entry.options.name === '@deepseek-ai/dsh-agent-default-model'
        || candidate.entry.options.id === 'agent-default-model'
      ))
      const config = item?.entry.options.config
      return config !== null && typeof config === 'object' ? config : undefined
    }

    /**
     * Watch a start through to readiness, then switch the default model.
     *
     * The panel's button returns as soon as the process is spawned, so readiness
     * has to be observed rather than awaited: this polls the status until the
     * server answers `/health`, and gives up when it stops or the budget runs out.
     */
    let readyWatch = null
    const watchForReady = () => {
      if (readyWatch !== null) return
      const startedAt = Date.now()
      readyWatch = (async () => {
        try {
          while (Date.now() - startedAt < 15 * 60_000) {
            const status = await supervisor.status()
            if (status.ready === true) {
              const outcome = await applyModel()
              if (outcome.applied === true && outcome.already !== true) {
                ctx.logger?.info?.(`strata: switched the default model to ${outcome.target.provider} · ${outcome.target.model}`)
              }
              return
            }
            // Anything but a start in progress means it will never become ready.
            if (status.state !== 'starting') return
            await new Promise((resolve) => setTimeout(resolve, 3_000))
          }
        } catch (error) {
          ctx.logger?.warn?.(`strata: could not watch the start: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          readyWatch = null
        }
      })()
    }

    const api = createStrataApi({
      supervisor,
      setup,
      trustedHosts: ctx.get('webRuntime')?.trustedHosts ?? [],
      onStarted: (snapshot) => {
        // `running` is false until /health answers, so the state is what tells a
        // fresh start apart from a failed one.
        if (snapshot?.ready === true) {
          void applyModel().catch(() => {})
          return
        }
        if (snapshot?.state === 'starting') watchForReady()
      },
      inspectModel: async () => {
        const target = modelTarget()
        const service = ctx.get('agentDefaultModel')
        let current = null
        if (service !== undefined) {
          try {
            current = service.currentSelection()
          } catch {
            current = null
          }
        }
        return {
          available: service !== undefined,
          automatic: settings.defaultModelOnReady === true,
          current,
          target,
          isStrata: target !== null && current !== null
            && current.provider === target.provider
            && current.model === target.model,
        }
      },
      applyModel: (options) => applyModel(options ?? { force: true }),
      inspect: (candidate) => inspectLayout(candidate ?? settings.root),
      applyRoot: async (nextRoot) => {
        const { editor, entry } = ownEntry()
        await editor.edit(entry, (current) => ({ ...current, root: nextRoot }))
        ctx.logger?.info?.(`strata: root → ${describeLayout(inspectLayout(nextRoot))}`)
      },
      checkPort: (port) => isPortFree(settings.host, port),
      inspectProviders: async () => {
        const status = await supervisor.status()
        const rows = providerRows()
        return {
          port: status.port,
          all: rows.map(({ entry, ...rest }) => rest),
          matching: rows.filter((row) => row.port === status.port).map(({ entry, ...rest }) => rest),
        }
      },
      inspectSettings: async () => {
        const editor = ctx.get('configEditor')
        const entry = ctx.fiber?.entry
        const stored = entry?.options.config
        const item = editor === undefined || entry === undefined
          ? undefined
          : editor.configuration().find((candidate) => candidate.entry === entry)
        return {
          fields: SETTINGS_FIELDS,
          values: displaySettings(stored, resolveConfig({})),
          defaults: displaySettings({}, resolveConfig({})),
          fallbacks: fallbacksFor(settings.root),
          overridden: Object.keys(item?.override ?? {}),
          restartRequiredKeys: RESTART_REQUIRED_KEYS,
          editable: editor !== undefined && entry !== undefined,
        }
      },
      applySettings: async (submitted) => {
        const defaults = resolveConfig({})
        // An omitted or rejected field keeps its current value: a partial payload
        // can never silently reset the rest, and a failed validation never
        // changes anything.
        const current = displaySettings(ctx.fiber?.entry?.options.config, defaults)
        const { values, errors } = normalizeSettings(submitted, current)
        if (errors.length > 0) return { errors, values }
        const stored = current
        const changed = RESTART_REQUIRED_KEYS.filter((key) => JSON.stringify(stored[key]) !== JSON.stringify(values[key]))
        if (changed.length > 0) {
          const status = await supervisor.status()
          if (status.running || status.owned) {
            return {
              errors: changed.map((key) => ({
                key,
                message: `只在下次启动时生效；Strata 正在运行（端口 ${status.port}），请先停止`,
              })),
              values,
            }
          }
        }
        const { editor, entry } = ownEntry()
        // `root` and `port` are owned by their own controls and are not part of
        // this payload, so spreading keeps them untouched.
        await editor.edit(entry, (current) => ({ ...current, ...values }))
        ctx.logger?.info?.(`strata: settings saved (${changed.length > 0 ? changed.join(', ') : 'no restart-scoped change'})`)
        return { errors: [], values, changed, needsRestart: changed.length > 0 }
      },
      inspectRunConfig: async () => {
        const active = readRunConfig(supervisor.launch.configPath)
        return {
          active,
          candidates: listRunConfigs(settings.root),
          running: (await supervisor.status()).running,
          venv: existsSync(venvPython(settings.root)),
        }
      },
      applyRunConfig: async (change) => {
        const status = await supervisor.status()
        if (status.running || status.owned) {
          return {
            errors: [{ key: 'runconfig', message: `运行配置在启动时读取；Strata 正在运行（端口 ${status.port}），请先停止` }],
            changed: [],
          }
        }
        const path = supervisor.launch.configPath
        const before = readRunConfig(path)
        if (before.ok !== true) return { errors: [{ key: 'runconfig', message: before.error }], changed: [] }
        let result
        try {
          result = writeRunConfig(path, {
            ...(change.maxContext === undefined ? {} : { maxContext: change.maxContext }),
            ...(change.modelName === undefined ? {} : { modelName: change.modelName }),
            ...(change.modelsRoot === undefined ? {} : { modelsRoot: change.modelsRoot }),
            ...(change.dataRoot === undefined ? {} : { dataRoot: change.dataRoot }),
          })
        } catch (error) {
          return { errors: [{ key: 'runconfig', message: error instanceof Error ? error.message : String(error) }], changed: [] }
        }
        const updated = []
        // The model id and the context window are what a DSH LLM provider has to
        // agree with, exactly like a port's baseURL: an unsynced provider offers
        // a model the server no longer reports.
        if (change.syncProvider === true && result.changed.length > 0 && providerRows().some((row) => row.port === status.port)) {
          const editor = ctx.get('configEditor')
          const seen = new Set()
          for (const row of providerRows()) {
            if (row.port !== status.port || seen.has(row.entryId)) continue
            seen.add(row.entryId)
            await editor.edit(row.entry, (current) => ({
              ...current,
              providers: Object.fromEntries(Object.entries(current.providers ?? {}).map(([key, value]) => {
                if (key !== row.provider || value === null || typeof value !== 'object') return [key, value]
                const models = Array.isArray(value.models) ? value.models : []
                return [key, {
                  ...value,
                  models: models.map((model) => {
                    if (model === null || typeof model !== 'object') return model
                    const matchesOld = result.changed.includes('modelName') === false
                      || model.id === before.modelName
                      || model.name === before.modelName
                    if (!matchesOld) return model
                    return {
                      ...model,
                      ...(result.changed.includes('modelName') ? { id: result.config.modelName, name: result.config.modelName } : {}),
                      ...(result.changed.includes('maxContext') ? { contextWindow: result.config.maxContext } : {}),
                    }
                  }),
                }]
              })),
            }))
            updated.push({ entryId: row.entryId, provider: row.provider, model: result.config.modelName, maxContext: result.config.maxContext })
          }
        }
        ctx.logger?.info?.(`strata: run config ${path} updated (${result.changed.join(', ')})`)
        return {
          errors: [],
          changed: result.changed,
          backup: result.backup,
          config: result.config,
          providersUpdated: updated,
        }
      },
      applyPort: async (nextPort, updateProviders) => {
        const before = await supervisor.status()
        const updated = []
        if (updateProviders) {
          // A provider left pointing at the old port would fail the moment the
          // server moves, so the rewrite is offered as part of the same action.
          const seen = new Set()
          for (const row of providerRows()) {
            if (row.port !== before.port || seen.has(row.entryId)) continue
            seen.add(row.entryId)
            const next = new URL(row.baseURL)
            next.port = String(nextPort)
            const target = next.toString()
            const editor = ctx.get('configEditor')
            await editor.edit(row.entry, (current) => ({
              ...current,
              providers: Object.fromEntries(Object.entries(current.providers ?? {}).map(([key, value]) => [
                key,
                key === row.provider && value !== null && typeof value === 'object' ? { ...value, baseURL: target } : value,
              ])),
            }))
            updated.push({ entryId: row.entryId, provider: row.provider, baseURL: target })
          }
        }
        const { editor, entry } = ownEntry()
        await editor.edit(entry, (current) => ({ ...current, port: nextPort }))
        ctx.logger?.info?.(`strata: port → ${nextPort}`)
        return {
          port: nextPort,
          previousPort: before.port,
          changed: true,
          providersUpdated: updated,
          message: updated.length === 0
            ? `端口已改为 ${nextPort}`
            : `端口已改为 ${nextPort}，并更新了 ${updated.length} 个模型提供方`,
        }
      },
      diagnostics: () => {
        const graph = ctx.get('clientModules')?.graph()
        const rows = Array.isArray(graph?.entries) ? graph.entries : []
        return {
          webServer: true,
          clientGraphRev: graph?.rev,
          clientRows: rows.map((row) => row.id),
          clientHalfMounted: rows.some((row) => row.id === 'dsh-strata-console'),
          configEditable: ctx.get('configEditor') !== undefined && ctx.fiber?.entry !== undefined,
          layout: inspectLayout(settings.root),
          port: settings.port,
          providers: providerRows().map(({ entry, ...rest }) => rest),
        }
      },
    })
    ctx.effect(
      () => webServer.register({ kind: api.kind, path: api.path, handler: api.handler }),
      'dsh-strata-console: /strata/api routes',
    )
  })

  // `stopOnExit` must stop the server when DeepSeek Harness exits — but this
  // fiber is also disposed on every *reload*, and a profile patch or a settings
  // save re-applies the plugin. Stopping there would kill a working server each
  // time a setting is saved, so the hook is the process's own exit instead, and
  // it terminates the tree synchronously (nothing async survives that point).
  ctx.effect(() => {
    if (settings.stopOnExit !== true) return undefined
    const onExit = () => {
      if (supervisor.killTreeSync('DeepSeek Harness exited')) {
        ctx.logger?.info?.('strata: stopped the server because DeepSeek Harness is exiting')
      }
    }
    process.once('exit', onExit)
    return () => process.removeListener('exit', onExit)
  }, 'dsh-strata-console: stop the server when the harness exits')
}
