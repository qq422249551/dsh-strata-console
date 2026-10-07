/**
 * The plugin's browser API: the HTTP routes the Strata buttons call.
 *
 * The Web client authenticates with the signed cookie `ctx.connection` sets on
 * the index response, so a same-origin `fetch('/strata/api/...')` from the
 * client half already carries the session. These routes additionally apply the
 * same cross-site fence the `/api` gateway uses — Host must name this machine,
 * `Sec-Fetch-Site` must not be `cross-site`, and an attached `Origin` must match
 * the request hostname. That is a DNS-rebinding and cross-site defense, not
 * authentication: the cookie remains the authentication.
 *
 * The module imports only Node built-ins, so it can be exercised directly.
 *
 * @module dsh-strata-console/http-api
 */

/** Route prefix owned by this plugin. */
export const STRATA_API_PREFIX = '/strata/api'

/** Largest accepted request body; every request here carries a small JSON object. */
const BODY_LIMIT_BYTES = 8 * 1024

/** Read one request header as a plain string. */
function header(headers, name) {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a hostname names the local loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches one configured trusted host. */
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one browser request may reach the Strata routes.
 * @param request - Node HTTP request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours and the browser markers are same-origin.
 */
export function isTrustedBrowserRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Collect a bounded request body as UTF-8 text. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error(`request body exceeds ${BODY_LIMIT_BYTES} bytes`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Write one JSON response. */
function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Coerce a query parameter to a bounded positive integer. */
function asCount(value, fallback, max) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback
}

/**
 * Read and validate one JSON object body, answering the caller directly when it
 * is malformed.
 * @param request - Node incoming request.
 * @param response - Node server response, written only on failure.
 * @returns the parsed object, or `undefined` when a response was already sent.
 */
async function readJsonBody(request, response) {
  let raw
  try {
    raw = await readBody(request)
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
  let body
  try {
    body = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    sendJson(response, 400, { ok: false, error: 'the request body must be JSON' })
    return undefined
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { ok: false, error: 'the request body must be a JSON object' })
    return undefined
  }
  return body
}

/**
 * Build the route this plugin registers on `ctx.webServer`.
 *
 * Endpoints:
 *   GET  /strata/api/state                          current status snapshot
 *   GET  /strata/api/layout[?root=]                 the directory-convention report
 *   POST /strata/api/config {root}                  check, persist, and live-apply a directory
 *   GET  /strata/api/provider                       LLM providers pointed at this port
 *   POST /strata/api/port {port, updateProviders}   check, persist, and live-apply a port
 *   GET  /strata/api/settings                       the tunable parameters, their bounds and defaults
 *   POST /strata/api/settings {values}              validate, persist, and live-apply every parameter
 *   GET  /strata/api/runconfig                      the active run config and every candidate
 *   POST /strata/api/runconfig {maxContext, modelName, modelsRoot, dataRoot, syncProvider}
 *                                                   edit the engine's own config file
 *   GET  /strata/api/setup                          the first-run checklist and install progress
 *   POST /strata/api/setup {action, modelsDir, dataDir, pull}
 *                                                   install | update | install-python | stop
 *   GET  /strata/api/logs?source=&lines=            captured output or engine log
 *   POST /strata/api/action {action,force,...}      start | stop | restart
 *   GET  /strata/api/diagnostics                    where this plugin is mounted
 *
 * `start` never blocks for the model load: it spawns and returns, and the
 * buttons poll `state`, which is what makes the UI responsive either way.
 *
 * `config` refuses a directory that misses a required convention entry, so a
 * stray pick can never leave the plugin pointed at nothing; the report comes
 * back either way and is what the panel renders. `port` refuses a port that is
 * taken, and refuses outright while a server is running — a supervisor cannot
 * follow a server it did not restart to a new port.
 *
 * @param options - the supervisor to drive, this deployment's trusted hosts, the
 * convention check, the port check, the config writers, and an optional
 * diagnostics provider.
 * @returns a `WebRoute` for `ctx.webServer.register`.
 */
export function createStrataApi({
  supervisor,
  trustedHosts = [],
  diagnostics,
  inspect,
  applyRoot,
  checkPort,
  inspectProviders,
  applyPort,
  inspectSettings,
  applySettings,
  inspectRunConfig,
  applyRunConfig,
  setup,
  onStarted,
  inspectModel,
  applyModel,
}) {
  /** Run one action and answer with the resulting snapshot. */
  async function act(body) {
    const action = typeof body.action === 'string' ? body.action : ''
    const force = body.force === true
    const timeoutSeconds = Number.isFinite(body.timeoutSeconds) ? body.timeoutSeconds : undefined
    const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000
    switch (action) {
      case 'start': {
        const snapshot = await supervisor.start({ wait: body.wait === true, timeoutMs })
        // A start that has not answered /health yet is watched by the host, so
        // the default model still switches when the weights finish loading.
        onStarted?.(snapshot)
        return snapshot
      }
      case 'stop':
        return supervisor.stop({ force, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      case 'restart': {
        await supervisor.stop({ force })
        const snapshot = await supervisor.start({ wait: body.wait === true, timeoutMs })
        onStarted?.(snapshot)
        return snapshot
      }
      default:
        throw new Error(`unknown action ${JSON.stringify(action)}; expected start, stop, or restart`)
    }
  }

  return {
    kind: 'prefix',
    path: STRATA_API_PREFIX,
    /** @param request - Node incoming request. @param response - Node server response. */
    async handler(request, response) {
      try {
        if (!isTrustedBrowserRequest(request, trustedHosts)) {
          sendJson(response, 403, { ok: false, error: 'this request did not come from this machine\'s DeepSeek Harness page' })
          return
        }
        const url = new URL(request.url ?? '/', 'http://localhost')
        const endpoint = url.pathname.slice(STRATA_API_PREFIX.length).replace(/\/+$/, '')

        if (endpoint === '/state' && request.method === 'GET') {
          sendJson(response, 200, { ok: true, value: await supervisor.status() })
          return
        }

        if (endpoint === '/diagnostics' && request.method === 'GET') {
          sendJson(response, 200, { ok: true, value: diagnostics === undefined ? {} : diagnostics() })
          return
        }

        if (endpoint === '/layout' && request.method === 'GET') {
          const candidate = url.searchParams.get('root')
          const report = inspect(candidate === null || candidate.trim() === '' ? undefined : candidate.trim())
          sendJson(response, 200, { ok: true, value: report })
          return
        }

        if (endpoint === '/config' && request.method === 'POST') {
          const body = await readJsonBody(request, response)
          if (body === undefined) return
          const root = typeof body.root === 'string' ? body.root.trim() : ''
          if (root === '') {
            sendJson(response, 200, { ok: false, error: '缺少 root：请选择一个 Strata 目录' })
            return
          }
          const report = inspect(root)
          if (!report.valid) {
            // Refuse the write, but hand back the report so the panel can show
            // exactly which convention entry is missing (and any suggestion).
            sendJson(response, 200, {
              ok: false,
              error: `这个目录不符合 Strata 目录规范：缺少 ${report.missingRequired.join('、')}`,
              value: report,
            })
            return
          }
          await applyRoot(report.root)
          sendJson(response, 200, { ok: true, value: { root: report.root, layout: report } })
          return
        }

        if (endpoint === '/provider' && request.method === 'GET') {
          sendJson(response, 200, { ok: true, value: await inspectProviders() })
          return
        }

        if (endpoint === '/port' && request.method === 'POST') {
          const body = await readJsonBody(request, response)
          if (body === undefined) return
          const port = Number(body.port)
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            sendJson(response, 200, { ok: false, error: '端口必须是 1 到 65535 之间的整数' })
            return
          }
          const current = await supervisor.status()
          if (current.port === port) {
            sendJson(response, 200, { ok: true, value: { port, changed: false, message: `端口本来就是 ${port}` } })
            return
          }
          if (current.running || current.owned) {
            sendJson(response, 200, {
              ok: false,
              error: `Strata 正在运行（当前端口 ${current.port}）。切换端口不会迁移已经跑起来的实例，请先“停止”，再改端口。`,
            })
            return
          }
          if (!(await checkPort(port))) {
            sendJson(response, 200, { ok: false, error: `端口 ${port} 已被其它程序占用，换一个再试` })
            return
          }
          const report = await applyPort(port, body.updateProviders === true)
          sendJson(response, 200, { ok: true, value: report })
          return
        }

        if (endpoint === '/settings' && request.method === 'GET') {
          sendJson(response, 200, { ok: true, value: await inspectSettings() })
          return
        }

        if (endpoint === '/settings' && request.method === 'POST') {
          const body = await readJsonBody(request, response)
          if (body === undefined) return
          const result = await applySettings(body.values)
          if (result.errors.length > 0) {
            // Field-level rejections come back with the payload so the panel can
            // mark each offending input rather than one global error.
            sendJson(response, 200, {
              ok: false,
              error: result.errors.map((entry) => `${entry.key}: ${entry.message}`).join('；'),
              value: { errors: result.errors },
            })
            return
          }
          sendJson(response, 200, { ok: true, value: result })
          return
        }

        if (endpoint === '/runconfig' && request.method === 'GET') {
          sendJson(response, 200, { ok: true, value: await inspectRunConfig() })
          return
        }

        if (endpoint === '/runconfig' && request.method === 'POST') {
          const body = await readJsonBody(request, response)
          if (body === undefined) return
          const result = await applyRunConfig({
            ...(body.maxContext === undefined ? {} : { maxContext: body.maxContext }),
            ...(body.modelName === undefined ? {} : { modelName: body.modelName }),
            ...(body.modelsRoot === undefined ? {} : { modelsRoot: body.modelsRoot }),
            ...(body.dataRoot === undefined ? {} : { dataRoot: body.dataRoot }),
            syncProvider: body.syncProvider === true,
          })
          if (result.errors.length > 0) {
            sendJson(response, 200, {
              ok: false,
              error: result.errors.map((entry) => entry.message).join('；'),
              value: { errors: result.errors },
            })
            return
          }
          sendJson(response, 200, { ok: true, value: result })
          return
        }

        if (endpoint === '/model' && request.method === 'GET') {
          sendJson(response, 200, { ok: true, value: await inspectModel() })
          return
        }

        if (endpoint === '/model' && request.method === 'POST') {
          const body = await readJsonBody(request, response)
          if (body === undefined) return
          // Without an explicit pair this means "make Strata the default".
          const explicit = typeof body.provider === 'string' && typeof body.model === 'string'
            ? {
              provider: body.provider,
              model: body.model,
              ...(typeof body.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort } : {}),
            }
            : null
          const result = await applyModel({ force: true, ...(explicit === null ? {} : { target: explicit }) })
          sendJson(response, 200, result.applied === true
            ? { ok: true, value: { ...result, model: await inspectModel() } }
            : { ok: false, error: result.reason, value: { ...result, model: await inspectModel() } })
          return
        }

        if (endpoint === '/setup' && request.method === 'GET') {
          sendJson(response, 200, { ok: true, value: await setup.state() })
          return
        }

        if (endpoint === '/setup' && request.method === 'POST') {
          const body = await readJsonBody(request, response)
          if (body === undefined) return
          const action = typeof body.action === 'string' ? body.action : 'start'
          if (action === 'stop') {
            sendJson(response, 200, { ok: true, value: await setup.stop() })
            return
          }
          if (action === 'install-python') {
            // Installing an interpreter is the user's explicit choice; the panel
            // only offers the button when no usable Python was found.
            const result = await setup.installPython()
            if (result.ok === true) {
              sendJson(response, 200, { ok: true, value: await setup.state() })
              return
            }
            sendJson(response, 200, { ok: false, error: result.error, value: await setup.state() })
            return
          }
          if (action === 'check-latest') {
            // Reads the repository's newest release, caching the answer; the
            // panel uses it only to *report*, since upstream replaces an engine
            // when this release needs a newer one, not whenever one exists.
            await setup.checkLatest({ force: true })
            sendJson(response, 200, { ok: true, value: await setup.state() })
            return
          }
          if (action === 'update') {
            // UPDATE.bat's chain: pull the newest code when this is a git clone,
            // then `setup.py --update`. `pull: false` is the manual path, for a
            // checkout git cannot update (the panel offers it as 按参数更新).
            // A running model keeps its engine, so upstream asks for it to be
            // closed first — refusing here is clearer than failing halfway.
            const status = await supervisor.status()
            if (status.running || status.owned) {
              sendJson(response, 200, {
                ok: false,
                error: `更新要求模型没在运行（当前端口 ${status.port}）：先停止，再更新。`,
                value: await setup.state(),
              })
              return
            }
            try {
              const state = await setup.startUpdate({ pull: body.pull !== false })
              sendJson(response, 200, { ok: true, value: state })
            } catch (error) {
              sendJson(response, 200, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
                value: await setup.state(),
              })
            }
            return
          }
          if (action !== 'start') {
            sendJson(response, 400, { ok: false, error: `未知的安装动作：${action}` })
            return
          }
          try {
            const state = await setup.start({ modelsDir: body.modelsDir, dataDir: body.dataDir })
            sendJson(response, 200, { ok: true, value: state })
          } catch (error) {
            sendJson(response, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
              value: await setup.state(),
            })
          }
          return
        }

        if (endpoint === '/logs' && request.method === 'GET') {
          const requested = url.searchParams.get('source')
          if (requested === 'setup') {
            // The install's console output, which the panel follows live.
            const lines = asCount(url.searchParams.get('lines'), 200, 2_000)
            const collected = setup.logs()
            const text = collected.text.split(/\r?\n/u).slice(-lines).join('\n')
            sendJson(response, 200, { ok: true, value: { text, note: collected.note } })
            return
          }
          const source = requested === 'engine' ? 'engine' : 'process'
          const lines = asCount(url.searchParams.get('lines'), 60, 500)
          sendJson(response, 200, { ok: true, value: await supervisor.logs({ source, lines }) })
          return
        }

        if (endpoint === '/action' && request.method === 'POST') {
          const body = await readJsonBody(request, response)
          if (body === undefined) return
          sendJson(response, 200, { ok: true, value: await act(body) })
          return
        }

        sendJson(response, 404, { ok: false, error: `no strata endpoint for ${request.method} ${url.pathname}` })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
