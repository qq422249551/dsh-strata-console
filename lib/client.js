/**
 * dsh-strata-console's browser half: the buttons that run the Strata model
 * server, and the directory picker that tells it where Strata lives.
 *
 * DSH serves a client half as a CommonJS-style factory registered on
 * `window.__ModuleLoader__.load`, so this file is written as one — no build
 * step, no JSX, no ES module syntax. `require` resolves the platform modules the
 * shell seeds (`react`, `react/jsx-runtime`, `@deepseek-ai/dsh-client-ui-*`);
 * nothing here requests another plugin's client half, so `dsh.client` needs no
 * `external` list.
 *
 * Two seats, one data layer:
 *
 *   - `conversation.input.left` (list) — a compact control in the composer tool
 *     row: a state dot plus one button that starts or stops the server.
 *   - `plugins.bundle.config` (keyed by `dsh-strata-console`) — the full panel on
 *     this bundle's page in Settings → Plugins: state, actions, the Strata
 *     directory with its convention check, facts, and the log.
 *
 * Both poll the host routes in `lib/http-api.js` while mounted; the start action
 * returns immediately and the poll reports readiness, which is what keeps the
 * buttons responsive across a model load that takes a minute.
 *
 * @module dsh-strata-console/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-strata-console',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Modal, StateDot, Tag } = primitives
    const el = React.createElement

    /**
     * The primitives' `Modal` is a 380px card (`width: min(380px, 100%)`) sized
     * for a confirm dialog, which truncates every path this panel shows. Its
     * stylesheet invites consumers to pass their own `className`, so the panel
     * injects one rule set and widens its own dialog only. Injected here, in the
     * factory body, because that is where the module system claims plugin styles
     * for teardown.
     */
    const STYLE_ELEMENT_ID = 'dsh-strata-console-panel-style'
    if (document.getElementById(STYLE_ELEMENT_ID) === null) {
      const style = document.createElement('style')
      style.id = STYLE_ELEMENT_ID
      // Doubled class: equal-specificity rules would otherwise depend on
      // injection order against the module's own stylesheet. 640px is a
      // settings-panel width: wide enough for a checkout path, still a card.
      style.textContent = [
        '.dsh-strata-console-dialog.dsh-strata-console-dialog { width: min(640px, 100%); }',
        // The dialog is a flex column whose items keep `min-height: auto`; this
        // lets the scrolling body actually shrink instead of overflowing.
        '.dsh-strata-console-dialog .dsh-strata-console-scroll { min-height: 0; }',
        '.dsh-strata-console-dialog .dsh-strata-console-grid { grid-template-columns: minmax(96px, auto) minmax(0, 1fr); }',
        '.dsh-strata-console-dialog .dsh-strata-console-grid input { min-width: 0; }',
        // The sidebar's footer action slot is `display: flex; width: 100%`,
        // so the control reads as a full-width entry beside Settings instead of
        // a pill as wide as its own label. In the 56px rail the owner centers a
        // content-sized box, so the dot keeps its size there.
        '.dsh-strata-console-footer.dsh-strata-console-footer { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }',
        // A column: the button must not stretch on the main (vertical) axis.
        '.dsh-strata-console-footer .dsh-strata-console-launcher { flex: none; width: 100%; min-width: 0; justify-content: flex-start; }',
        '.dsh-strata-console-footer .dsh-strata-console-launcher > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      ].join('\n')
      document.head.append(style)
    }

    /** The host routes this half drives. */
    const API = '/strata/api'

    /** How often a mounted control re-reads the host snapshot. */
    const POLL_MS = 3000

    /** Trailing log lines the panel asks for. */
    const LOG_LINES = 120

    /**
     * Deadline for one request. Stopping a server may legitimately take the
     * stop-grace budget, so this is generous — it exists to break a hung
     * connection, not to hurry a slow action.
     */
    const REQUEST_TIMEOUT_MS = 60_000

    /** One line of human text from an unknown thrown value. */
    function reason(error) {
      if (error === null || error === undefined) return 'unknown error'
      return typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
    }

    /**
     * Call one host endpoint and unwrap its envelope.
     * @param path - absolute route path.
     * @param init - fetch init.
     * @returns the endpoint's value.
     */
    async function call(path, init) {
      const body = await exchange(path, init)
      if (body.ok !== true) throw new Error(typeof body.error === 'string' ? body.error : `HTTP failure from ${path}`)
      return body.value
    }

    /**
     * Send one request and return the whole envelope, so a caller that needs the
     * payload of a refusal (the directory report) can read it.
     * @param path - absolute route path.
     * @param init - fetch init.
     * @returns the parsed `{ ok, value?, error? }` envelope.
     */
    async function exchange(path, init) {
      // A request that never settles would wedge every button behind `loading`
      // forever — a replaced plugin instance can leave one hanging — so each one
      // carries its own deadline.
      const response = await fetch(path, Object.assign({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, init))
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status} from ${path}`)
      }
      if (body === null || typeof body !== 'object') throw new Error(`HTTP ${response.status} from ${path}`)
      return body
    }

    /**
     * The one data layer both seats share: the latest host snapshot, the action
     * in flight, and a poll that runs only while something is mounted.
     * @returns the snapshot plus `act` and `refresh`.
     */
    function useStrata() {
      const [snapshot, setSnapshot] = React.useState({ loading: true, value: null, error: null })
      const [busy, setBusy] = React.useState(null)

      const refresh = React.useCallback(async () => {
        try {
          const value = await call(`${API}/state`, { headers: { accept: 'application/json' } })
          setSnapshot({ loading: false, value, error: null })
        } catch (error) {
          setSnapshot((previous) => ({ loading: false, value: previous.value, error: reason(error) }))
        }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        const tick = () => {
          if (!cancelled && document.visibilityState !== 'hidden') void refresh()
        }
        void refresh()
        const timer = window.setInterval(tick, POLL_MS)
        document.addEventListener('visibilitychange', tick)
        return () => {
          cancelled = true
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', tick)
        }
      }, [refresh])

      const act = React.useCallback(async (action, extra) => {
        setBusy(action)
        try {
          const value = await call(`${API}/action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, extra || {})),
          })
          setSnapshot({ loading: false, value: value, error: null })
          // An action's own verdict, not just the dot: a stop that only reported
          // "left alone" looked exactly like a dead button.
          return value
        } catch (error) {
          setSnapshot((previous) => ({ loading: false, value: previous.value, error: reason(error) }))
          return null
        } finally {
          setBusy(null)
        }
      }, [])

      return { loading: snapshot.loading, value: snapshot.value, error: snapshot.error, busy: busy, act: act, refresh: refresh }
    }

    /** The presentation facts of one host snapshot. */
    function factsOf(value) {
      const state = value !== null && typeof value.state === 'string' ? value.state : 'unknown'
      if (state === 'ready') return { state: state, dot: 'done', word: '已就绪', running: true }
      if (state === 'starting') return { state: state, dot: 'ongoing', word: '启动中', running: true }
      if (state === 'exited') return { state: state, dot: 'error', word: '已退出', running: false }
      if (state === 'stopped') return { state: state, dot: 'idle', word: '已停止', running: false }
      return { state: state, dot: 'idle', word: '未知', running: false }
    }

    /** One fact line's label/value pair. */
    function facts(value) {
      if (value === null) return []
      const rows = []
      if (typeof value.model === 'string') rows.push(['模型', value.model])
      if (typeof value.maxContext === 'number') rows.push(['上下文', `${value.maxContext} tokens`])
      if (typeof value.loaded === 'boolean') rows.push(['权重', value.loaded ? '已载入显存' : '未载入'])
      if (typeof value.images === 'boolean') rows.push(['图片输入', value.images ? '可用' : '不可用'])
      if (typeof value.pid === 'number') rows.push(['进程', String(value.pid)])
      if (typeof value.uptimeSeconds === 'number') rows.push(['运行时长', `${value.uptimeSeconds}s`])
      if (value.lastExit !== undefined && value.lastExit !== null) {
        rows.push(['上次退出', `code=${String(value.lastExit.exitCode)} signal=${String(value.lastExit.signal)}`])
      }
      return rows
    }

    /** How long the stop action must be held before it fires. */
    const HOLD_TO_STOP_MS = 3000

    /**
     * The composer-row control: a dot and one button.
     *
     * Starting is a plain click, but stopping is a **three-second hold**. The
     * button sits under the cursor in the tool row while a long turn streams, and
     * a stray click there would drop the model mid-answer; the panel's own 停止
     * stays a single click, because pressing it is deliberate.
     */
    function StrataControl() {
      const strata = useStrata()
      const shape = factsOf(strata.value)
      const busy = strata.busy !== null
      const [holding, setHolding] = React.useState(false)
      const [remaining, setRemaining] = React.useState(0)
      const timerRef = React.useRef(null)
      const tickRef = React.useRef(null)
      /**
       * Set when a completed hold stops the server, and consumed by the click the
       * browser synthesizes from that same press. Stopping is fast, so by the time
       * the pointer comes up the state already reads `stopped` — without this the
       * release would immediately start the server again.
       */
      const swallowClickRef = React.useRef(false)

      const cancelHold = React.useCallback(() => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        if (tickRef.current !== null) window.clearInterval(tickRef.current)
        timerRef.current = null
        tickRef.current = null
        setHolding(false)
        setRemaining(0)
      }, [])

      // A hold that outlives the component (state change, unmount) must not fire.
      React.useEffect(() => cancelHold, [cancelHold])

      const beginHold = () => {
        if (busy || strata.loading || timerRef.current !== null) return
        const deadline = Date.now() + HOLD_TO_STOP_MS
        setHolding(true)
        setRemaining(Math.ceil(HOLD_TO_STOP_MS / 1000))
        tickRef.current = window.setInterval(() => {
          setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
        }, 200)
        timerRef.current = window.setTimeout(() => {
          cancelHold()
          // Only this press's click may be swallowed; a new press clears it.
          swallowClickRef.current = true
          void strata.act('stop')
        }, HOLD_TO_STOP_MS)
      }

      const stopPath = shape.running
      const label = busy
        ? (strata.busy === 'stop' || strata.busy === 'restart' ? 'Strata 停止中' : 'Strata 启动中')
        : holding ? `松手取消 ${remaining}s`
          : shape.state === 'ready' ? 'Strata'
            : shape.state === 'starting' ? 'Strata 启动中'
              : shape.state === 'exited' ? 'Strata 已退出'
                : 'Strata'
      const title = strata.error !== null
        ? `Strata：${strata.error}（点击刷新状态）`
        : strata.value !== null
          ? `${strata.value.message}（${stopPath ? `按住 ${HOLD_TO_STOP_MS / 1000} 秒停止` : '点击启动'}）`
          : '正在读取 Strata 状态…'
      return el(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'sm',
          disabled: busy || strata.loading,
          title: title,
          'aria-label': title,
          onClick: () => {
            // The click a completed hold leaves behind belongs to that press: a
            // release must never restart what the hold just stopped.
            if (swallowClickRef.current) {
              swallowClickRef.current = false
              return
            }
            // A click owns two paths: retrying the status poll after a failure,
            // and starting. Stopping is the hold below.
            if (busy) return
            if (strata.error !== null) return void strata.refresh()
            if (stopPath) return
            void strata.act('start')
          },
          onPointerDown: () => {
            // A fresh press always precedes a fresh click, so a suppression that
            // was never consumed (the pointer left the button before release)
            // cannot leak into the next interaction.
            swallowClickRef.current = false
            if (strata.error !== null || !shape.running) return
            beginHold()
          },
          onPointerUp: cancelHold,
          onPointerLeave: cancelHold,
          onPointerCancel: cancelHold,
        },
        el(StateDot, { state: busy ? 'ongoing' : strata.error !== null ? 'error' : holding ? 'ongoing' : shape.dot, size: 8 }),
        el('span', null, label),
      )
    }

    /**
     * The whole control surface. The bundle page in Settings and the sidebar
     * popup both render this, so the two seats can never drift apart.
     *
     * `bounded` caps the body to the viewport and scrolls it: the popup is a
     * dialog with a fixed frame, so the content must never grow past the window.
     * The settings page passes nothing and lets the page scroll instead.
     */
    function StrataBody(props) {
      const pickDirectory = props !== null && props !== undefined ? props.pickDirectory : undefined
      const bounded = props !== null && props !== undefined && props.bounded === true
      const strata = useStrata()
      const shape = factsOf(strata.value)
      const busy = strata.busy !== null

      const [source, setSource] = React.useState('process')
      const [log, setLog] = React.useState(null)
      const [logBusy, setLogBusy] = React.useState(false)
      const [layout, setLayout] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [portDraft, setPortDraft] = React.useState('')
      const [updateProviders, setUpdateProviders] = React.useState(true)
      const [providers, setProviders] = React.useState(null)
      const [settings, setSettings] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [fieldErrors, setFieldErrors] = React.useState({})
      const [runConfig, setRunConfig] = React.useState(null)
      const [ctxDraft, setCtxDraft] = React.useState('')
      const [modelDraft, setModelDraft] = React.useState('')
      const [modelsDraft, setModelsDraft] = React.useState('')
      const [dataDraft, setDataDraft] = React.useState('')
      const [syncProvider, setSyncProvider] = React.useState(true)
      const [setup, setSetup] = React.useState(null)
      const [setupModels, setSetupModels] = React.useState('')
      const [setupData, setSetupData] = React.useState('')
      const [setupLog, setSetupLog] = React.useState('')
      const [updateArgs, setUpdateArgs] = React.useState(null)
      const [choice, setChoice] = React.useState({})
      const [installArgs, setInstallArgs] = React.useState(null)
      const [model, setModel] = React.useState(null)
      const logRef = React.useRef(null)
      const setupLogRef = React.useRef(null)
      const stickRef = React.useRef(true)
      const setupStickRef = React.useRef(true)
      const [notice, setNotice] = React.useState(null)
      const [pending, setPending] = React.useState(false)
      // 检查最新版本 runs on its own flag: it is a read-only query to GitHub, so
      // it must not grey out the run controls, the directory row, or the install
      // and update buttons. Only the update button ever reports it (see below).
      const [checkingLatest, setCheckingLatest] = React.useState(false)

      const currentRoot = strata.value !== null && typeof strata.value.root === 'string' ? strata.value.root : undefined
      const currentPort = strata.value !== null && typeof strata.value.port === 'number' ? strata.value.port : undefined
      const occupied = shape.running || (strata.value !== null && strata.value.owned === true)

      const loadLog = React.useCallback(async (which) => {
        setLogBusy(true)
        try {
          const value = await call(`${API}/logs?source=${which}&lines=${LOG_LINES}`, { headers: { accept: 'application/json' } })
          setLog({ text: typeof value.text === 'string' ? value.text : '', note: typeof value.note === 'string' ? value.note : null })
        } catch (error) {
          setLog({ text: '', note: reason(error) })
        } finally {
          setLogBusy(false)
        }
      }, [])

      const loadLayout = React.useCallback(async (root) => {
        try {
          return await call(`${API}/layout${root === undefined ? '' : `?root=${encodeURIComponent(root)}`}`, {
            headers: { accept: 'application/json' },
          })
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
          return null
        }
      }, [])

      /** Rows that would follow this server to a new port. */
      const loadProviders = React.useCallback(async () => {
        try {
          setProviders(await call(`${API}/provider`, { headers: { accept: 'application/json' } }))
        } catch {
          setProviders(null)
        }
      }, [])

      /** One editable value per parameter, as the host describes them. */
      const formOf = (values) => Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : value]),
      )

      const loadSettings = React.useCallback(async () => {
        try {
          const value = await call(`${API}/settings`, { headers: { accept: 'application/json' } })
          setSettings(value)
          setForm(formOf(value.values))
          setInstallArgs((current) => (current === null ? (value.values.installArgs ?? []).join('\n') : current))
          setUpdateArgs((current) => (current === null ? (value.values.updateArgs ?? []).join('\n') : current))
          setFieldErrors({})
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        }
      }, [])

      /**
       * The default inference model: which provider and model new sessions use,
       * and whether it points at Strata.
       */
      const loadModel = React.useCallback(async () => {
        try {
          setModel(await call(`${API}/model`, { headers: { accept: 'application/json' } }))
        } catch {
          setModel(null)
        }
      }, [])

      /** Point the default model at Strata, or back where it was. */
      const setDefaultModel = React.useCallback(async (target) => {
        setPending(true)
        setNotice(null)
        try {
          const body = await exchange(`${API}/model`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(target ?? {}),
          })
          if (body.ok === true) {
            const next = body.value.model
            setNotice({
              kind: 'ok',
              text: body.value.already === true
                ? '默认模型本来就是它'
                : `默认推理模型已改为 ${next.current.provider} · ${next.current.model}`,
            })
          } else {
            setNotice({ kind: 'error', text: typeof body.error === 'string' ? body.error : '切换失败' })
          }
          await loadModel()
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        } finally {
          setPending(false)
        }
      }, [loadModel])

      /**
       * The engine's own run config: it, not the plugin, owns the model files,
       * the model id, and the served context window.
       */      const loadRunConfig = React.useCallback(async () => {
        try {
          const value = await call(`${API}/runconfig`, { headers: { accept: 'application/json' } })
          setRunConfig(value)
          setCtxDraft(value.active.ok === true && value.active.maxContext !== undefined ? String(value.active.maxContext) : '')
          setModelDraft(value.active.ok === true ? value.active.modelName : '')
          setModelsDraft(value.active.ok === true ? value.active.roots.models : '')
          setDataDraft(value.active.ok === true ? value.active.roots.data : '')
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        }
      }, [])

      /** Write a directory into the profile patch and let the host re-apply it. */
      const applyRoot = React.useCallback(async (root) => {
        setPending(true)
        setNotice(null)
        try {
          const body = await exchange(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ root: root }),
          })
          if (body.ok === true) {
            setLayout(body.value.layout)
            setNotice({ kind: 'ok', text: `已保存：${body.value.root}` })
            setDraft('')
            await strata.refresh()
          } else {
            if (body.value !== undefined) setLayout(body.value)
            setNotice({ kind: 'error', text: typeof body.error === 'string' ? body.error : '保存失败' })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        } finally {
          setPending(false)
        }
      }, [strata.refresh])

      /** Open the OS chooser, then follow a nested-checkout suggestion. */
      const choose = React.useCallback(async () => {
        if (typeof pickDirectory !== 'function') {
          setNotice({ kind: 'error', text: '这个环境没有目录选择器，请在下面直接填写路径' })
          return
        }
        setPending(true)
        setNotice(null)
        try {
          const picked = await pickDirectory()
          if (picked === null || picked === undefined || picked === '') {
            setPending(false)
            return
          }
          const report = await loadLayout(picked)
          if (report === null) {
            setPending(false)
            return
          }
          if (report.valid) {
            setLayout(report)
            setPending(false)
            await applyRoot(report.root)
            return
          }
          const suggestion = report.suggestion
          if (suggestion !== undefined) {
            const nested = await loadLayout(suggestion.root)
            if (nested !== null && nested.valid) {
              setLayout(nested)
              setPending(false)
              await applyRoot(nested.root)
              return
            }
          }
          setLayout(report)
          setNotice({ kind: 'error', text: `选择的是 ${report.root}，缺少 ${report.missingRequired.join('、')}` })
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        } finally {
          setPending(false)
        }
      }, [pickDirectory, loadLayout, applyRoot])

      React.useEffect(() => {
        // The body is mounted only while its seat is visible, so polling needs
        // no further gate.
        void loadLog(source)
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') void loadLog(source)
        }, POLL_MS * 5)
        return () => window.clearInterval(timer)
      }, [source, loadLog])

      React.useEffect(() => {
        void loadLayout()
      }, [currentRoot, loadLayout])

      React.useEffect(() => {
        void loadProviders()
      }, [currentPort, loadProviders])

      React.useEffect(() => {
        void loadSettings()
      }, [loadSettings])

      // Keep the log pane pinned to its end while the reader is already there,
      // so the automatic refresh never yanks the view back to the top.
      React.useEffect(() => {
        const node = logRef.current
        if (node !== null && stickRef.current) node.scrollTop = node.scrollHeight
      }, [log])

      React.useEffect(() => {
        void loadRunConfig()
      }, [loadRunConfig])

      React.useEffect(() => {
        void loadModel()
      }, [loadModel])

      /** Write the model id / context into the engine's run config. */
      const saveRunConfig = React.useCallback(async () => {
        setPending(true)
        setNotice(null)
        try {
          const parsed = Number(ctxDraft)
          const body = await exchange(`${API}/runconfig`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              maxContext: Number.isFinite(parsed) ? parsed : ctxDraft,
              modelName: modelDraft,
              modelsRoot: modelsDraft,
              dataRoot: dataDraft,
              syncProvider: syncProvider,
            }),
          })
          if (body.ok === true) {
            const parts = [`已写入 ${body.value.config.name}`]
            if (typeof body.value.backup === 'string') parts.push(`备份 ${body.value.backup.split(/[\\/]/u).pop()}`)
            if (Array.isArray(body.value.providersUpdated) && body.value.providersUpdated.length > 0) {
              parts.push(`同步了 ${body.value.providersUpdated.length} 个模型提供方`)
            }
            setNotice({ kind: 'ok', text: parts.join(' · ') })
            await loadRunConfig()
            await loadProviders()
            await strata.refresh()
          } else {
            setNotice({ kind: 'error', text: typeof body.error === 'string' ? body.error : '写入运行配置失败' })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        } finally {
          setPending(false)
        }
      }, [ctxDraft, modelDraft, modelsDraft, dataDraft, syncProvider, loadRunConfig, loadProviders, strata.refresh])

      /** The first-run checklist: what exists, and what an install would do. */
      const loadSetup = React.useCallback(async () => {
        try {
          const value = await call(`${API}/setup`, { headers: { accept: 'application/json' } })
          setSetup(value)
          setSetupModels((current) => (current === '' ? value.dirs.models : current))
          setSetupData((current) => (current === '' ? value.dirs.data : current))
          return value
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
          return null
        }
      }, [])

      /** The install's console output, read every few seconds while it runs. */
      const loadSetupLog = React.useCallback(async () => {
        try {
          const value = await call(`${API}/logs?source=setup&lines=400`, { headers: { accept: 'application/json' } })
          setSetupLog(typeof value.text === 'string' ? value.text : '')
        } catch {
          /* the install may be starting; the next tick tries again */
        }
      }, [])

      const startSetup = React.useCallback(async (action, extra) => {
        // A check for the latest release is a read-only network query: it sets its
        // own flag instead of `pending`, so nothing else in the panel is disabled
        // while it runs. Every other action here changes the install, so those
        // still block each other.
        const readOnlyCheck = action === 'check-latest'
        if (readOnlyCheck) setCheckingLatest(true)
        else setPending(true)
        setNotice(null)
        try {
          // The install and the update read their argument list from the plugin's
          // settings, so a click writes the form's answers first: one source.
          if (action === 'start' || action === 'update') {
            const values = action === 'start'
              ? { installArgs: String(installArgs ?? '').split('\n') }
              : { updateArgs: String(updateArgs ?? '').split('\n') }
            const saved = await exchange(`${API}/settings`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ values: values }),
            })
            if (saved.ok !== true) {
              setNotice({ kind: 'error', text: typeof saved.error === 'string' ? saved.error : '参数保存失败' })
              return
            }
          }
          const body = await exchange(`${API}/setup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ action: action }, extra ?? {})),
          })
          if (body.ok === true) {
            setSetup(body.value)
            if (action === 'start') setNotice({ kind: 'ok', text: '安装已开始，下面会持续输出进度' })
            if (action === 'update') {
              setNotice({
                kind: 'ok',
                text: extra !== undefined && extra.pull === false
                  ? '手动更新已开始（只跑 setup.py --update）'
                  : '更新已开始，下面会持续输出进度',
              })
              void loadSetupLog()
            }
            if (action === 'install-python') setNotice({ kind: 'ok', text: 'Python 安装完成，请重新检测' })
            // 检查最新版本 has no banner of its own: `setSetup` above has already
            // written the answer into `engine.latest`, and the version line under
            // the action row is the one place that reports it. A notice here would
            // print the same sentence a second time, far from the button it came from.
            if (action === 'stop') setNotice({ kind: 'info', text: '已停止' })
          } else {
            setNotice({ kind: 'error', text: typeof body.error === 'string' ? body.error : '安装/更新操作失败' })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        } finally {
          if (readOnlyCheck) setCheckingLatest(false)
          else setPending(false)
        }
      }, [installArgs, updateArgs, loadSetupLog])

      React.useEffect(() => {
        void loadSetup()
      }, [loadSetup])

      React.useEffect(() => {
        if (setup === null) return undefined
        const running = setup.running === true
        const timer = window.setInterval(() => {
          if (document.visibilityState === 'hidden') return
          void loadSetupLog()
          if (!running) return
          // While the chain runs, refresh the checklist too: the venv appears
          // partway through, and the phase moves from venv to setup.py.
          void call(`${API}/setup`, { headers: { accept: 'application/json' } })
            .then((value) => setSetup(value))
            .catch(() => {})
        }, running ? 2500 : 12000)
        return () => window.clearInterval(timer)
      }, [setup, loadSetupLog])

      React.useEffect(() => {
        const node = setupLogRef.current
        if (node !== null && setupStickRef.current) node.scrollTop = node.scrollHeight
      }, [setupLog])

      /** The flags a form selection produces, in the order the form lists them. */
      const flagsOf = (selection) => {
        const choices = setup !== null && setup.options !== undefined ? setup.options.choices : []
        const out = []
        for (const entry of choices) {
          const value = selection[entry.key]
          if (value === undefined || value === null || String(value).trim() === '') continue
          out.push(entry.flag, String(value).trim())
        }
        return out
      }

      /**
       * Rewrite the argument list from the form.
       *
       * The textarea is the single source of what gets passed, so a flag the form
       * manages is replaced while anything typed by hand is kept: that keeps the
       * escape hatch open for options this form does not ask about (and for
       * flags a newer `setup.py` adds).
       */
      const syncArgs = (selection) => {
        const choices = setup !== null && setup.options !== undefined ? setup.options.choices : []
        const managed = new Set(choices.map((entry) => entry.flag))
        const kept = []
        const lines = String(installArgs ?? '').split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index].trim()
          if (line === '') continue
          if (managed.has(line)) {
            index += 1 // its value follows on the next line
            continue
          }
          kept.push(line)
        }
        return [...flagsOf(selection), ...kept].join('\n')
      }

      /**
       * One install question's control. The label and its flag are rendered by
       * the grid cell beside this, so this returns the control alone.
       */
      const choiceRow = (entry) => {
        const locked = pending || (setup !== null && setup.running === true)
        const value = choice[entry.key] === undefined ? '' : String(choice[entry.key])
        const familyChosen = choice.family !== undefined && choice.family !== ''
        // `setup.py` picks the size *within* a family (`names` is filtered by it),
        // so a size is only offered once a family is chosen — otherwise the list
        // shows sizes the installer would refuse.
        const waitingForFamily = entry.key === 'model' && !familyChosen
        const items = waitingForFamily
          ? []
          : (entry.items ?? []).filter((item) => entry.key !== 'model'
            || item.families === undefined
            || item.families.includes(choice.family))
        const selected = items.find((item) => String(item.value) === value)
        const control = waitingForFamily
          ? el('span', { style: Object.assign({}, muted, { paddingTop: 6 }) }, '选模型家族后才能指定尺寸；都留「推荐」就由 setup.py 决定')
          : entry.kind === 'number'
            ? el('input', {
              type: 'number',
              min: entry.min,
              max: entry.max,
              value: value,
              disabled: locked,
              placeholder: '推荐',
              style: Object.assign({}, input, { flex: 'none', width: 130 }),
              onChange: (event) => {
                const next = Object.assign({}, choice, { [entry.key]: event.target.value })
                setChoice(next)
                setInstallArgs(syncArgs(next))
              },
            })
            : items.length > 0
              ? el(
                'select',
                {
                  value: value,
                  disabled: locked,
                  style: Object.assign({}, input, { flex: 'none', width: '100%' }),
                  onChange: (event) => {
                    const next = Object.assign({}, choice, { [entry.key]: event.target.value })
                    // A family change can invalidate the size: drop it rather than
                    // pass setup.py a pair it will refuse.
                    if (entry.key === 'family') next.model = ''
                    setChoice(next)
                    setInstallArgs(syncArgs(next))
                  },
                },
                el('option', { value: '' }, '推荐（默认）'),
                ...items.map((item) => el('option', { key: String(item.value), value: String(item.value) },
                  item.note === undefined ? item.label : `${item.label} — ${item.note}`)),
              )
              : el('input', {
                type: 'text',
                value: value,
                disabled: locked,
                spellCheck: false,
                placeholder: '推荐（默认）',
                style: Object.assign({}, input, { flex: 'none', width: '100%' }),
                onChange: (event) => {
                  const next = Object.assign({}, choice, { [entry.key]: event.target.value })
                  setChoice(next)
                  setInstallArgs(syncArgs(next))
                },
              })
        return el(
          'div',
          { key: entry.key, style: { display: 'flex', flexDirection: 'column', gap: 3 } },
          control,
          selected !== undefined && selected.warn !== undefined
            ? el('span', { style: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 11 } }, selected.warn)
            : null,
        )
      }

      /** Switch which run config the plugin launches (its `config` setting). */
      const useRunConfig = React.useCallback(async (path) => {
        setPending(true)
        setNotice(null)
        try {
          const body = await exchange(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ values: { config: path } }),
          })
          if (body.ok === true) {
            setNotice({ kind: 'ok', text: `已改用 ${path.split(/[\\/]/u).pop()}` })
            await loadSettings()
            await loadRunConfig()
          } else {
            setNotice({ kind: 'error', text: typeof body.error === 'string' ? body.error : '切换失败' })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        } finally {
          setPending(false)
        }
      }, [loadSettings, loadRunConfig])

      /** Submit every parameter; the host validates and writes the set. */
      const saveSettings = React.useCallback(async () => {
        if (form === null) return
        setPending(true)
        setNotice(null)
        setFieldErrors({})
        try {
          const values = Object.fromEntries((settings?.fields ?? []).map((field) => {
            const raw = form[field.key]
            if (field.kind === 'boolean') return [field.key, raw === true]
            if (field.kind === 'number') return [field.key, Number(raw)]
            if (field.kind === 'lines') return [field.key, String(raw ?? '').split('\n')]
            return [field.key, String(raw ?? '')]
          }))
          const body = await exchange(`${API}/settings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ values: values }),
          })
          if (body.ok === true) {
            setNotice({ kind: 'ok', text: body.value.needsRestart === true ? '已保存，下次启动生效' : '已保存' })
            await loadSettings()
            await strata.refresh()
          } else {
            const errors = body.value !== undefined && Array.isArray(body.value.errors) ? body.value.errors : []
            setFieldErrors(Object.fromEntries(errors.map((entry) => [entry.key, entry.message])))
            setNotice({ kind: 'error', text: typeof body.error === 'string' ? body.error : '保存失败' })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        } finally {
          setPending(false)
        }
      }, [form, settings, loadSettings, strata.refresh])

      /** Put every field back to the host's default for a review, not a write. */
      const resetSettings = React.useCallback(() => {
        if (settings === null) return
        setForm(formOf(settings.defaults))
        setFieldErrors({})
        setNotice({ kind: 'info', text: '已填入默认值，点“保存参数”才会写入' })
      }, [settings])

      React.useEffect(() => {
        if (currentPort !== undefined) setPortDraft(String(currentPort))
      }, [currentPort])

      /** Move the server to another port, optionally taking the providers along. */
      const applyPort = React.useCallback(async () => {
        const value = Number(portDraft)
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          setNotice({ kind: 'error', text: '端口必须是 1 到 65535 之间的整数' })
          return
        }
        setPending(true)
        setNotice(null)
        try {
          const body = await exchange(`${API}/port`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ port: value, updateProviders: updateProviders }),
          })
          if (body.ok === true) {
            setNotice({ kind: 'ok', text: body.value.message })
            await strata.refresh()
            await loadProviders()
          } else {
            setNotice({ kind: 'error', text: typeof body.error === 'string' ? body.error : '改端口失败' })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: reason(error) })
        } finally {
          setPending(false)
        }
      }, [portDraft, updateProviders, strata.refresh, loadProviders])

      const muted = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 }
      const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11 }
      const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
      const grid = { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: '4px 0 0', fontSize: 12 }
      const input = {
        flex: '1 1 260px',
        minWidth: 200,
        padding: '5px 8px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 11,
      }
      const noticeColor = notice === null
        ? 'var(--dsw-alias-label-secondary)'
        : notice.kind === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : notice.kind === 'info'
            ? 'var(--dsw-alias-label-secondary)'
            : 'var(--dsw-alias-state-success-primary)'

      /** One parameter row, rendered from the host's field description. */
      const settingRow = (field) => {
        const value = form === null ? '' : form[field.key]
        const locked = pending || (occupied && settings !== null && settings.restartRequiredKeys.includes(field.key))
        const control = field.kind === 'boolean'
          ? el('input', {
            type: 'checkbox',
            checked: value === true,
            disabled: locked,
            onChange: (event) => setForm(Object.assign({}, form, { [field.key]: event.target.checked })),
          })
          : field.kind === 'lines'
            ? el('textarea', {
              rows: 3,
              value: value === undefined || value === null ? '' : String(value),
              disabled: locked,
              spellCheck: false,
              placeholder: '一行一个参数',
              style: Object.assign({}, input, { minHeight: 54, resize: 'vertical', flex: '1 1 100%' }),
              onChange: (event) => setForm(Object.assign({}, form, { [field.key]: event.target.value })),
            })
            : el('input', {
              type: field.kind === 'number' ? 'number' : 'text',
              value: value === undefined || value === null ? '' : String(value),
              min: field.min,
              max: field.max,
              disabled: locked,
              spellCheck: false,
              placeholder: field.kind === 'path' && settings !== null ? (settings.fallbacks[field.key] ?? '') : '',
              style: input,
              onChange: (event) => setForm(Object.assign({}, form, { [field.key]: event.target.value })),
            })
        return el(
          'div',
          { key: field.key, style: { display: 'contents' } },
          el('span', { style: Object.assign({}, muted, { paddingTop: 6 }), title: field.hint }, field.label),
          el(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            control,
            field.key === 'host'
              ? el(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: locked, onClick: () => setForm(Object.assign({}, form, { host: '0.0.0.0' })) }, '0.0.0.0')
              : null,
            fieldErrors[field.key] !== undefined
              ? el('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, fieldErrors[field.key])
              : null,
          ),
        )
      }

      /**
       * A path needs the whole card width: in the two-column grid its label
       * squeezes the value down to a few characters, which is exactly what makes
       * a long checkout path unreadable.
       *
       * The base input style carries `flex: 1 1 260px` for horizontal rows; in
       * this column layout that basis would become a 260px *height*, so the flex
       * sizing is reset here and the fields keep their natural height.
       */
      const wideSettingRow = (field) => {
        const locked = pending || (occupied && settings !== null && settings.restartRequiredKeys.includes(field.key))
        const value = form === null ? '' : form[field.key]
        const base = Object.assign({}, input, { flex: 'none', width: '100%' })
        const control = field.kind === 'lines'
          ? el('textarea', {
            rows: 2,
            value: value === undefined || value === null ? '' : String(value),
            disabled: locked,
            spellCheck: false,
            placeholder: '一行一个参数',
            style: Object.assign(base, { height: 52, minHeight: 40, resize: 'vertical' }),
            onChange: (event) => setForm(Object.assign({}, form, { [field.key]: event.target.value })),
          })
          : el('input', {
            type: 'text',
            value: value === undefined || value === null ? '' : String(value),
            disabled: locked,
            spellCheck: false,
            placeholder: settings !== null ? (settings.fallbacks[field.key] ?? '留空则自动推导') : '',
            style: base,
            onChange: (event) => setForm(Object.assign({}, form, { [field.key]: event.target.value })),
          })
        return el(
          'div',
          { key: field.key, style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: 4 } },
          el(
            'span',
            { style: Object.assign({}, muted, { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }) },
            el('span', { title: field.hint }, field.label),
            fieldErrors[field.key] !== undefined
              ? el('span', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, fieldErrors[field.key])
              : null,
          ),
          control,
        )
      }

      const action = (name, label, variant, extra) => el(
        Button,
        {
          type: 'button',
          variant: variant,
          size: 'sm',
          disabled: busy || strata.loading,
          onClick: () => {
            void strata.act(name, extra).then((result) => {
              if (result === null) return
              setNotice({
                kind: typeof result.message === 'string' && /free|stopped|ready|starting/i.test(result.message) ? 'ok' : 'info',
                text: typeof result.message === 'string' ? result.message : `${label}：已完成`,
              })
            })
          },
        },
        strata.busy === name ? `${label}…` : label,
      )

      // The panel's only busy label, on the button the wait is *for*. A
      // 检查最新版本 query is read-only, so it never joins `pending` and never
      // touches any other button's enabled state or text.
      const updateBusy = pending === true || checkingLatest === true

      const conventionRow = (entry) => el(
        'div',
        { key: entry.key, style: Object.assign({}, row, { gap: 6 }) },
        el('span', { style: { color: entry.present ? 'var(--dsw-alias-state-success-primary)' : entry.required ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)' } },
          entry.present ? '✓' : entry.required ? '✗' : '!'),
        el('span', null, entry.label),
        el('span', { style: Object.assign({}, muted, mono), title: entry.absolute }, entry.relative),
        entry.present ? null : el('span', { style: muted }, entry.hint),
      )

      return el(
        'div',
        {
          className: bounded ? 'dsh-strata-console-scroll' : undefined,
          style: Object.assign(
            { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' },
            bounded
              ? {
                // The dialog caps itself against the overlay's padding box, so
                // the body scrolls inside that frame instead of pushing the card
                // off-screen. The viewport calc keeps a floor under the card's
                // own chrome (title row and padding).
                maxHeight: 'min(64vh, 620px)',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
                paddingRight: 6,
              }
              : {},
          ),
        },

        el(
          'div',
          { style: row },
          el(StateDot, { state: busy ? 'ongoing' : strata.error !== null ? 'error' : shape.dot, size: 8 }),
          el('strong', null, `Strata ${shape.word}`),
          strata.value !== null && typeof strata.value.baseUrl === 'string'
            ? el(Tag, { tone: 'quiet' }, strata.value.baseUrl)
            : null,
          strata.value !== null && typeof strata.value.model === 'string'
            ? el(Tag, { tone: 'quiet' }, strata.value.model)
            : null,
        ),

        el('div', { style: muted }, strata.error !== null ? `错误：${strata.error}` : (strata.value !== null ? strata.value.message : '正在读取状态…')),

        el(
          'div',
          { style: row },
          action('start', '启动', 'primary'),
          action('stop', '停止', 'outline'),
          shape.running ? action('restart', '重启', 'outline') : null,
          shape.running ? action('stop', '强制停止', 'ghost', { force: true }) : null,
          // 刷新 only reads the model server, so it belongs with the run controls
          // at the front of the row. The two engine actions come after it, at the
          // end of the row — still directly above the version line they act on.
          el(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: strata.loading, onClick: () => void strata.refresh() }, '刷新'),
          // The update button only runs when this release wants a newer engine —
          // `setup.py`'s own rule — so an up-to-date install cannot be "updated"
          // into a pointless re-download. It is also the panel's only busy label:
          // a greyed-out 已是最新 looks like nothing was clicked, while a
          // 处理中… on every other button would say the same thing from too many
          // places at once. A 检查最新版本 query reads GitHub and changes nothing
          // on disk, so it blocks this one button and nothing else.
          setup !== null
            ? el(Button, {
              type: 'button',
              variant: setup.engine.needsUpdate === true ? 'primary' : 'ghost',
              size: 'sm',
              disabled: updateBusy || setup.running === true || occupied || setup.engine.needsUpdate !== true,
              title: updateBusy
                ? '正在处理，请稍候'
                : setup.engine.needsUpdate === true
                  ? setup.updateCommand
                  : `当前引擎 ${setup.engine.ok === true ? setup.engine.version : '未知'} 已满足本版本要求`
                    + `（≥ ${setup.engine.required ?? '?'}），无需更新。要强制刷新依赖与配置，用下面的「按参数更新」。`,
              onClick: () => void startSetup('update', { pull: setup.gitCheckout === true }),
            }, updateBusy
              ? '处理中…'
              : setup.running === true && (setup.phase === 'git' || setup.phase === 'update')
                ? '更新中…'
                : setup.engine.needsUpdate === true ? '更新' : '已是最新')
            : null,
          // Checking the release page is read-only, so it stays clickable whatever
          // the model is doing, and its own button never changes text: the answer
          // belongs on the version line below, the wait on the update button.
          setup !== null
            ? el(Button, {
              type: 'button',
              variant: 'ghost',
              size: 'sm',
              title: '读取仓库发布的最新引擎版本（网络）',
              onClick: () => void startSetup('check-latest'),
            }, '检查最新版本')
            : null,
        ),
        setup === null
          ? null
          : el(
            'div',
            { style: Object.assign({}, muted, { display: 'flex', gap: 12, flexWrap: 'wrap' }) },
            el('span', null, `当前引擎 ${setup.engine.ok === true ? setup.engine.version : '（读不到）'}`),
            el('span', null, `本版本要求 ≥ ${setup.engine.required ?? '?'}`),
            setup.engine.latest !== undefined
              ? el(
                'span',
                {
                  title: setup.engine.latest.ok === true
                    ? `${setup.engine.latest.repo ?? '发布仓库'} 的最新发布`
                      + (typeof setup.engine.latest.publishedAt === 'string'
                        ? `（发布于 ${setup.engine.latest.publishedAt.slice(0, 10)}）`
                        : '')
                    : setup.engine.latest.note ?? '远端查询失败',
                },
                `远端最新 ${setup.engine.latest.ok === true ? setup.engine.latest.tag : '（查不到）'}`,
              )
              : el('span', { style: { opacity: 0.7 } }, '远端最新：未检查'),
            el(
              'span',
              {
                style: {
                  color: setup.engine.ok !== true || setup.engine.latest !== undefined && setup.engine.latest.ok !== true
                    ? 'var(--dsw-alias-label-secondary)'
                    : setup.engine.needsUpdate === true
                      ? 'var(--dsw-alias-state-warn-primary)'
                      : 'var(--dsw-alias-state-success-primary)',
                },
              },
              setup.engine.ok !== true
                ? '版本未知'
                : setup.engine.needsUpdate === true
                  ? `需要更新到 ${setup.engine.required}`
                  : setup.engine.remoteNewer === true
                    ? '已满足要求（远端更新，但本版本不要求换引擎）'
                    // A failed query is not "up to date": the reason the banner used
                    // to carry goes here instead, so the line never lies.
                    : setup.engine.latest !== undefined && setup.engine.latest.ok !== true
                      ? `远端查询失败：${setup.engine.latest.note ?? '未知原因'}`
                      : '已是最新，无需更新',
            ),
          ),

        // ---- Strata directory -------------------------------------------------
        el('div', { style: Object.assign({}, row, { marginTop: 4 }) }, el('span', { style: muted }, 'Strata 目录')),
        el('div', { style: Object.assign({}, muted, mono) }, currentRoot === undefined ? '（未知）' : currentRoot),
        el(
          'div',
          { style: row },
          el(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: pending, onClick: () => void choose() }, '选择目录…'),
          el('input', {
            type: 'text',
            value: draft,
            placeholder: '或直接填写路径，例如 D:\\strata\\Strata-main',
            spellCheck: false,
            style: input,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || pending) return
              const value = draft.trim()
              if (value !== '') void applyRoot(value)
            },
          }),
          el(Button, {
            type: 'button',
            variant: 'primary',
            size: 'sm',
            disabled: pending || draft.trim() === '',
            onClick: () => void applyRoot(draft.trim()),
          }, '应用'),
        ),
        notice !== null ? el('div', { style: { color: noticeColor, fontSize: 12 } }, notice.text) : null,
        layout !== null && layout.suggestion !== undefined
          ? el(
            'div',
            { style: row },
            el('span', { style: muted }, layout.suggestion.reason),
            el(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: pending, onClick: () => void applyRoot(layout.suggestion.root) }, `用 ${layout.suggestion.root}`),
          )
          : null,
        el(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)' } },
          el('div', { style: Object.assign({}, muted, { marginBottom: 2 }) }, '目录规范（✓ 必需 / ! 建议 / ✗ 缺失）'),
          layout === null
            ? el('div', { style: muted }, '正在检查…')
            : layout.entries.map(conventionRow),
        ),

        // ---- Model and context window -----------------------------------------
        el('div', { style: Object.assign({}, row, { marginTop: 4 }) }, el('span', { style: muted }, '模型与上下文')),
        runConfig === null
          ? el('div', { style: muted }, '正在读取运行配置…')
          : runConfig.active.ok !== true
            ? el('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, runConfig.active.error)
            : el(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              el(
                'div',
                { style: Object.assign({}, muted, mono) },
                `${runConfig.active.name}　${runConfig.active.modelName || '(未命名)'}　${runConfig.active.maxContext === undefined ? '上下文未声明' : `${runConfig.active.maxContext} tokens`}`,
              ),
              el(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                ...[
                  ['权重', runConfig.active.files.native],
                  ['PLE', runConfig.active.files.ple],
                  ['pack', runConfig.active.files.pack],
                  ['tokenizer', runConfig.active.files.tokenizer],
                ]
                  .filter((pair) => pair[1] !== '')
                  .map((pair) => el(
                    'div',
                    { key: pair[0], style: Object.assign({}, muted, mono, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }), title: pair[1] },
                    `${pair[0]}：${pair[1]}`,
                  )),
              ),
              el(
                'div',
                { style: row },
                el('span', { style: muted }, '上下文'),
                el('input', {
                  type: 'number',
                  min: 2048,
                  max: 1048576,
                  value: ctxDraft,
                  disabled: pending || occupied,
                  style: Object.assign({}, input, { flex: '0 0 130px', minWidth: 110 }),
                  onChange: (event) => setCtxDraft(event.target.value),
                }),
                el('span', { style: muted }, '模型 id'),
                el('input', {
                  type: 'text',
                  value: modelDraft,
                  disabled: pending || occupied,
                  spellCheck: false,
                  style: Object.assign({}, input, { flex: '0 1 240px', minWidth: 160 }),
                  onChange: (event) => setModelDraft(event.target.value),
                }),
              ),
              // Relocating a root rewrites every path the config carries under it,
              // which is what `setup.py --gguf-dir/--data-dir` established.
              el(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                el('span', { style: Object.assign({}, muted, { display: 'flex', gap: 8 }) }, '模型目录', el('span', { style: { opacity: 0.75 } }, '改它会重写配置里所有模型文件路径')),
                el('input', {
                  type: 'text',
                  value: modelsDraft,
                  disabled: pending || occupied,
                  spellCheck: false,
                  placeholder: '例如 D:\\strata\\Strata-Models',
                  style: Object.assign({}, input, { flex: 'none', width: '100%' }),
                  onChange: (event) => setModelsDraft(event.target.value),
                }),
              ),
              el(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                el('span', { style: Object.assign({}, muted, { display: 'flex', gap: 8 }) }, '数据目录', el('span', { style: { opacity: 0.75 } }, 'packs / mtp / tokenizer 都在它下面')),
                el('input', {
                  type: 'text',
                  value: dataDraft,
                  disabled: pending || occupied,
                  spellCheck: false,
                  placeholder: '例如 D:\\strata\\Strata-data',
                  style: Object.assign({}, input, { flex: 'none', width: '100%' }),
                  onChange: (event) => setDataDraft(event.target.value),
                }),
              ),
              el(
                'div',
                { style: row },
                el(Button, {
                  type: 'button',
                  variant: 'primary',
                  size: 'sm',
                  disabled: pending || occupied,
                  onClick: () => void saveRunConfig(),
                }, pending ? '写入中…' : '保存到运行配置'),
                el(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: pending, onClick: () => void loadRunConfig() }, '重新读取'),
                el(
                  'label',
                  { style: Object.assign({}, muted, { display: 'flex', alignItems: 'center', gap: 6 }) },
                  el('input', {
                    type: 'checkbox',
                    checked: syncProvider,
                    disabled: pending || occupied,
                    onChange: (event) => setSyncProvider(event.target.checked),
                  }),
                  '同时同步模型提供方的 id 与上下文',
                ),
              ),
              occupied
                ? el('div', { style: muted }, `运行配置只在启动时读取，Strata 正在运行：先停止再改。`)
                : null,
              runConfig.candidates.length > 1
                ? el(
                  'div',
                  { style: row },
                  el('span', { style: muted }, '切换运行配置'),
                  ...runConfig.candidates.map((candidate) => el(
                    Button,
                    {
                      key: candidate.path,
                      type: 'button',
                      variant: candidate.path === runConfig.active.path ? 'primary' : 'outline',
                      size: 'sm',
                      disabled: pending || occupied || candidate.path === runConfig.active.path,
                      title: candidate.path,
                      onClick: () => void useRunConfig(candidate.path),
                    },
                    `${candidate.name}（${candidate.modelName || '未命名'}）`,
                  )),
                )
                : null,
            ),


        facts(strata.value).length > 0
          ? el(
            'div',
            { style: grid },
            facts(strata.value).flatMap((pair) => [
              el('span', { key: `${pair[0]}-k`, style: muted }, pair[0]),
              el('span', { key: `${pair[0]}-v` }, pair[1]),
            ]),
          )
          : null,

        // ---- Listen port ------------------------------------------------------
        el('div', { style: Object.assign({}, row, { marginTop: 4 }) }, el('span', { style: muted }, '监听端口')),
        el(
          'div',
          { style: row },
          el('input', {
            type: 'number',
            min: 1,
            max: 65535,
            value: portDraft,
            disabled: occupied || pending,
            spellCheck: false,
            style: Object.assign({}, input, { flex: '0 0 110px', minWidth: 90 }),
            onChange: (event) => setPortDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' || pending || occupied) return
              void applyPort()
            },
          }),
          el(Button, {
            type: 'button',
            variant: 'primary',
            size: 'sm',
            disabled: pending || occupied || portDraft === '',
            onClick: () => void applyPort(),
          }, '改端口'),
          el(
            'label',
            { style: Object.assign({}, muted, { display: 'flex', alignItems: 'center', gap: 6 }) },
            el('input', {
              type: 'checkbox',
              checked: updateProviders,
              disabled: occupied || pending,
              onChange: (event) => setUpdateProviders(event.target.checked),
            }),
            '同时更新指向该端口的模型提供方',
          ),
        ),
        occupied
          ? el('div', { style: muted }, `Strata 正在运行（端口 ${String(currentPort ?? '?')}）：切换端口不会迁移已启动的实例，请先停止。`)
          : null,
        providers === null || providers.matching.length === 0
          ? null
          : el(
            'div',
            { style: Object.assign({}, muted, mono) },
            providers.matching
              .map((entry) => `${entry.entryId} · ${entry.provider} → ${entry.baseURL}`)
              .join('　'),
          ),

            // ---- The default inference model ---------------------------------
            model === null
              ? null
              : el(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                el(
                  'span',
                  { style: Object.assign({}, muted, { display: 'flex', gap: 8, flexWrap: 'wrap' }) },
                  '推理模型默认值',
                  el(
                    'span',
                    { style: mono, title: 'DSH 的 agentDefaultModel 选择，只改默认选中项，不往模型列表里加东西' },
                    model.current === null ? '（读不到）' : `${model.current.provider} · ${model.current.model}`,
                  ),
                  model.isStrata === true
                    ? el('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '就是 Strata')
                    : null,
                ),
                el(
                  'div',
                  { style: row },
                  el(Button, {
                    type: 'button',
                    variant: model.isStrata === true ? 'ghost' : 'primary',
                    size: 'sm',
                    disabled: pending || model.available !== true || model.target === null,
                    title: model.target === null ? '这个 profile 里没有指向该端口的提供方' : `${model.target.provider} · ${model.target.model}`,
                    onClick: () => void setDefaultModel(null),
                  }, '设为默认（Strata）'),
                  model.previous !== null && model.previous !== undefined && model.isStrata === true
                    ? el(Button, {
                      type: 'button',
                      variant: 'ghost',
                      size: 'sm',
                      disabled: pending,
                      onClick: () => void setDefaultModel(model.previous),
                    }, `切回 ${model.previous.provider} · ${model.previous.model}`)
                    : null,
                  el(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: pending, onClick: () => void loadModel() }, '刷新'),
                ),
                el('div', { style: muted },
                  model.automatic === true
                    ? 'Strata 报告就绪后会自动切到它；不需要就把「其他参数」里的「就绪后切换默认模型」关掉。'
                    : '自动切换已关闭，只能用上面的按钮手动切。'),
                model.isStrata === true && shape.running !== true
                  ? el('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12 } },
                    '默认模型指向 Strata，但它现在没在运行：新会话会连不上，先启动或切回原来的模型。')
                  : null,
                model.available !== true
                  ? el('div', { style: muted }, '这个组合没有 agentDefaultModel 服务，只能手动在模型选择器里切。')
                  : null,
              ),

        // ---- Every other parameter --------------------------------------------
        el('div', { style: Object.assign({}, row, { marginTop: 4 }) }, el('span', { style: muted }, '其他参数')),
        settings !== null && settings.editable === false
          ? el('div', { style: muted }, '这个组合没有 configEditor，参数只能在 profile 的 cordis.patch.yml 里改。')
          : null,
        el(
          'div',
          { className: 'dsh-strata-console-grid', style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', alignItems: 'start' } },
          settings === null
            ? el('div', { style: muted }, '正在读取…')
            : (form === null
              ? []
              : settings.fields.map((field) => (field.kind === 'path' || field.kind === 'lines' ? wideSettingRow(field) : settingRow(field)))),
        ),
        occupied
          ? el('div', { style: muted }, '标灰的参数只在下次启动时生效，所以运行中不可改；其余随时可改。')
          : null,
        el(
          'div',
          { style: row },
          el(Button, {
            type: 'button',
            variant: 'primary',
            size: 'sm',
            disabled: pending || form === null || (settings !== null && settings.editable === false),
            onClick: () => void saveSettings(),
          }, pending ? '保存中…' : '保存参数'),
          el(Button, {
            type: 'button',
            variant: 'ghost',
            size: 'sm',
            disabled: pending || settings === null,
            onClick: () => resetSettings(),
          }, '填入默认值'),
          el(Button, {
            type: 'button',
            variant: 'ghost',
            size: 'sm',
            disabled: pending,
            onClick: () => void loadSettings(),
          }, '重新读取'),
        ),

        el(
          'div',
          { style: Object.assign({}, row, { marginTop: 4 }) },
          el('span', { style: muted }, '日志'),
          el(Button, { type: 'button', variant: source === 'process' ? 'primary' : 'ghost', size: 'sm', onClick: () => setSource('process') }, '进程输出'),
          el(Button, { type: 'button', variant: source === 'engine' ? 'primary' : 'ghost', size: 'sm', onClick: () => setSource('engine') }, '引擎日志'),
          el(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: logBusy, onClick: () => void loadLog(source) }, logBusy ? '读取中…' : '刷新'),
        ),

        el(
          'pre',
          {
            ref: logRef,
            onScroll: () => {
              const node = logRef.current
              if (node === null) return
              // Follow new output only while the reader is already at the end.
              stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
            },
            style: {
              margin: 0,
              // A real box, not just a cap: a log pane that hugs one line is
              // useless, and the reader can always scroll it.
              height: bounded ? 220 : 300,
              minHeight: 90,
              overflow: 'auto',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            },
          },
          log === null ? '正在读取…' : log.text !== '' ? log.text : (log.note !== null ? log.note : '（没有输出）'),
        ),

        // ---- First-run installation -------------------------------------------
        el(
          'div',
          { style: Object.assign({}, row, { marginTop: 4 }) },
          el('span', { style: muted }, '首次安装'),
          setup === null
            ? null
            : el('span', { style: { color: setup.ready === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)', fontSize: 12 } },
              setup.ready === true ? '环境已就绪' : '环境不完整'),
          el(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: pending, onClick: () => void loadSetup() }, '重新检测'),
        ),
        setup === null
          ? el('div', { style: muted }, '正在检测…')
          : el(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            el(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', alignItems: 'start' } },
              ...[
                ['Python', setup.interpreter.ok === true
                  ? `${setup.interpreter.source}${setup.interpreter.version === undefined ? '' : `（${setup.interpreter.version}）`}`
                  : (setup.interpreter.reason ?? '未找到')],
                ['虚拟环境', setup.venv.present ? setup.venv.path : `缺少 ${setup.venv.path}`],
                ['运行配置', setup.config.present ? setup.config.path : `缺少 ${setup.config.path}`],
                ['模型文件', setup.missingModelFiles.length === 0
                  ? '齐全'
                  : `缺 ${setup.missingModelFiles.length} 个，例如 ${setup.missingModelFiles[0]}`],
              ].flatMap((pair) => [
                el('span', { key: `${pair[0]}-k`, style: muted }, pair[0]),
                el('span', { key: `${pair[0]}-v`, style: Object.assign({}, mono, { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' }), title: pair[1] }, pair[1]),
              ]),
            ),
            el(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              el('span', { style: Object.assign({}, muted, { display: 'flex', gap: 8 }) }, '模型目录', el('span', { style: { opacity: 0.75 } }, '传给 setup.py --gguf-dir')),
              el('input', {
                type: 'text',
                value: setupModels,
                disabled: pending || setup.running === true,
                spellCheck: false,
                placeholder: setup.dirs.models,
                style: Object.assign({}, input, { flex: 'none', width: '100%' }),
                onChange: (event) => setSetupModels(event.target.value),
              }),
            ),
            el(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              el('span', { style: Object.assign({}, muted, { display: 'flex', gap: 8 }) }, '数据目录', el('span', { style: { opacity: 0.75 } }, '传给 setup.py --data-dir')),
              el('input', {
                type: 'text',
                value: setupData,
                disabled: pending || setup.running === true,
                spellCheck: false,
                placeholder: setup.dirs.data,
                style: Object.assign({}, input, { flex: 'none', width: '100%' }),
                onChange: (event) => setSetupData(event.target.value),
              }),
            ),
            el(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              el('span', { style: muted }, '会执行'),
              el('span', { style: Object.assign({}, mono, { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' }) }, setup.command),
            ),
            // ---- The questions START-HERE.bat asks, asked here too ------------
            setup.options !== undefined && setup.options.choices.length > 0
              ? el(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 } },
                el(
                  'span',
                  { style: Object.assign({}, muted, { display: 'flex', gap: 8, flexWrap: 'wrap' }) },
                  '安装选项',
                  el('span', { style: { opacity: 0.75 } },
                    setup.options.source === 'setup.py'
                      ? `清单读自已安装的 setup.py（内存 ${setup.options.memoryGb} GB）`
                      : '读不到 setup.py 的选项表，用的是内置清单'),
                  el('span', { style: { opacity: 0.75 } }, '· 留「推荐」即交给 setup.py 自己决定'),
                ),
                el(
                  'div',
                  { style: { display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) minmax(0, 1fr)', gap: '6px 12px', alignItems: 'start' } },
                  ...setup.options.choices.map((entry) => el(
                    'div',
                    { key: entry.key, style: { display: 'contents' } },
                    el(
                      'span',
                      { style: Object.assign({}, muted, { paddingTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }) },
                      entry.label,
                      el('span', { style: Object.assign({}, mono, { opacity: 0.6 }), title: entry.hint }, entry.flag),
                    ),
                    choiceRow(entry),
                  )),
                ),
                el(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                  el('span', { style: Object.assign({}, muted, { display: 'flex', gap: 8, flexWrap: 'wrap' }) },
                    '最终参数',
                    el('span', { style: { opacity: 0.75 } }, '一行一个，直接追加到 setup.py 后面；可手写清单里没有的参数')),
                  el('textarea', {
                    rows: 2,
                    value: installArgs === null ? '' : installArgs,
                    disabled: pending || setup.running === true,
                    spellCheck: false,
                    placeholder: '留空即全部采用推荐值',
                    style: Object.assign({}, input, { flex: 'none', width: '100%', height: 54, minHeight: 40, resize: 'vertical' }),
                    onChange: (event) => setInstallArgs(event.target.value),
                  }),
                ),
              )
              : null,
            setup.interpreter.ok !== true
              ? el('div', { style: Object.assign({}, muted, { color: 'var(--dsw-alias-state-warn-primary)' }) },
                '没有可用的 Python。可以先安装：')
              : null,
            el(
              'div',
              { style: row },
              el(Button, {
                type: 'button',
                variant: 'primary',
                size: 'sm',
                disabled: pending || setup.running === true,
                onClick: () => void startSetup('start', { modelsDir: setupModels, dataDir: setupData }),
              }, setup.running === true ? `安装中（${setup.phase}）…` : '开始安装'),
              setup.running === true
                ? el(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: pending, onClick: () => void startSetup('stop') }, '停止安装')
                : null,
              setup.interpreter.ok !== true && setup.venv.present !== true
                ? el(Button, {
                  type: 'button',
                  variant: 'outline',
                  size: 'sm',
                  disabled: pending || setup.running === true,
                  title: 'winget install -e --id Python.Python.3.12 --scope user --silent',
                  onClick: () => void startSetup('install-python'),
                }, '安装 Python 3.12')
                : null,
            ),
            setup.error !== null && setup.error !== undefined
              ? el('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, setup.error)
              : null,
            // ---- Manual update (the advanced path; 更新 itself is up top) ------
            el(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
              el(
                'div',
                { style: Object.assign({}, muted, { display: 'flex', gap: 8, flexWrap: 'wrap' }) },
                '手动更新',
                el('span', { style: { opacity: 0.75 } }, '只跑 setup.py --update（附上下面的参数），不拉取代码 —— git 无法更新的 checkout 该走这条路'),
              ),
              el(
                'div',
                { style: row },
                el(Button, {
                  type: 'button',
                  variant: 'outline',
                  size: 'sm',
                  disabled: pending || setup.running === true || occupied,
                  title: occupied ? '更新要求模型没在运行：先停止' : `会执行：${setup.updateCommand}`,
                  onClick: () => void startSetup('update', { pull: false }),
                }, setup.running === true && (setup.phase === 'git' || setup.phase === 'update') ? '更新中…' : '按参数更新'),
                setup.running === true
                  ? el(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: pending, onClick: () => void startSetup('stop') }, '停止')
                  : null,
              ),
              el(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                el('span', { style: Object.assign({}, muted, { display: 'flex', gap: 8, flexWrap: 'wrap' }) },
                  '手动更新参数',
                  el('span', { style: { opacity: 0.75 } }, '一行一个，追加到 setup.py --update 后面，例如 --build、--cuda 13')),
                el('textarea', {
                  rows: 2,
                  value: updateArgs === null ? '' : updateArgs,
                  disabled: pending || setup.running === true,
                  spellCheck: false,
                  placeholder: '留空即用默认更新流程',
                  style: Object.assign({}, input, { flex: 'none', width: '100%', height: 50, minHeight: 38, resize: 'vertical' }),
                  onChange: (event) => setUpdateArgs(event.target.value),
                }),
              ),
              el(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                el('span', { style: muted }, '会执行'),
                el('span', { style: Object.assign({}, mono, { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' }) }, setup.updateCommand),
              ),
              occupied
                ? el('div', { style: muted }, '更新要求模型没在运行：上游会把"模型还在跑"的引擎留到下次，所以先停止再更新。')
                : null,
              setup.gitCheckout !== true
                ? el('div', { style: muted },
                  '这个检出不是 git 克隆，所以无法自己拉取新代码。更新仍会更新引擎、依赖与配置；要拿新代码请下载最新包，' +
                  '解压到任意位置后运行里面的 START-HERE.bat（它会找到 Strata-data 里的模型文件，不会重新下载大文件）：' +
                  'https://github.com/Niko1221/Strata/archive/refs/heads/main.zip')
                : el('div', { style: muted }, '这个检出是 git 克隆：更新会先跑 git pull --ff-only，再跑 setup.py --update。拉取失败就停下并显示原因，不会假报"已更新"。'),
            ),
            el('div', { style: muted },
              '首次安装会创建 .venv、装依赖、下载引擎与模型（可能几十 GB、很久），并写出运行配置。' +
              '上面没选的选项都会采用 setup.py 的推荐答案。' +
              (setup.phase === 'done' ? '上次安装已完成。' : '')),
            setupLog !== ''
              ? el('pre', {
                ref: setupLogRef,
                onScroll: () => {
                  const node = setupLogRef.current
                  if (node === null) return
                  setupStickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
                },
                style: {
                  margin: 0,
                  height: bounded ? 200 : 260,
                  overflow: 'auto',
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                },
              }, setupLog)
              : null,
          ),
      )
    }

    /** The bundle page's one-liner (`view: 'summary'`). */
    function StrataSummary() {
      const strata = useStrata()
      const shape = factsOf(strata.value)
      const baseUrl = strata.value !== null && typeof strata.value.baseUrl === 'string' ? ` · ${strata.value.baseUrl}` : ''
      return `Strata ${shape.word}${baseUrl}`
    }

    /** The panel on this bundle's page in Settings → Plugins. */
    function StrataPanel(props) {
      const view = props !== null && props !== undefined ? props.view : undefined
      if (view === 'summary') return el(StrataSummary)
      if (view !== 'page') return null
      return el(StrataBody, { pickDirectory: props.pickDirectory })
    }

    /**
     * The supervised process's own output, live, below the sidebar button.
     *
     * The host tails the lines, so each poll carries a few dozen lines, not the
     * whole collected stream. Rendered only when the sidebar is wide: the 56px
     * rail has no room for a log.
     */
    function StrataProcessOutput() {
      const [text, setText] = React.useState(null)
      const boxRef = React.useRef(null)
      const stickRef = React.useRef(true)

      const load = React.useCallback(async () => {
        try {
          const value = await call(`${API}/logs?source=process&lines=40`, { headers: { accept: 'application/json' } })
          setText(typeof value.text === 'string' ? value.text : '')
        } catch {
          // A replaced plugin instance can drop one poll; the next tick retries.
        }
      }, [])

      React.useEffect(() => {
        void load()
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') void load()
        }, 4000)
        return () => window.clearInterval(timer)
      }, [load])

      React.useEffect(() => {
        const node = boxRef.current
        if (node !== null && stickRef.current) node.scrollTop = node.scrollHeight
      }, [text])

      return el(
        'div',
        { className: 'dsh-strata-console-output', style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
        el(
          'pre',
          {
            ref: boxRef,
            onScroll: () => {
              const node = boxRef.current
              if (node === null) return
              stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24
            },
            style: {
              margin: 0,
              height: 84,
              overflow: 'auto',
              padding: '6px 8px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-2)',
              color: 'var(--dsw-alias-label-secondary)',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              fontSize: 10,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            },
          },
          text === null ? '正在读取…' : text !== '' ? text : '（还没有输出）',
        ),
      )
    }

    /**
     * The sidebar-foot action: the button that pops the control panel, with the
     * process output beneath it. The owner passes `wide` (false = the 56px rail),
     * so the rail keeps the dot alone.
     */
    function StrataLauncher(props) {
      const wide = props === null || props === undefined || props.wide !== false
      const pickDirectory = props !== null && props !== undefined ? props.pickDirectory : undefined
      const [open, setOpen] = React.useState(false)
      const strata = useStrata()
      const shape = factsOf(strata.value)
      const dot = strata.busy !== null ? 'ongoing' : strata.error !== null ? 'error' : shape.dot
      return el(
        React.Fragment,
        null,
        el(
          'div',
          { className: 'dsh-strata-console-footer' },
          el(
            Button,
            {
              type: 'button',
              variant: 'ghost',
              size: 'sm',
              className: 'dsh-strata-console-launcher',
              title: `Strata 控制面板 · ${shape.word}`,
              'aria-label': 'Strata 控制面板',
              onClick: () => setOpen(true),
            },
            el(StateDot, { state: dot, size: 8 }),
            wide ? el('span', null, 'Strata 控制面板') : null,
          ),
          wide ? el(StrataProcessOutput) : null,
        ),
        open
          ? el(
            Modal,
            {
              open: true,
              title: 'Strata 控制面板',
              closeLabel: '关闭',
              className: 'dsh-strata-console-dialog',
              onClose: () => setOpen(false),
            },
            el(StrataBody, { pickDirectory: pickDirectory, bounded: true }),
          )
          : null,
      )
    }

    exports.inject = ['slots']

    /**
     * Register every seat. `ctx.slots.inject` waits for each slot's declaration,
     * so registration order does not depend on which owner loads first.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      // The desktop shell exposes the OS chooser directly; a browser composition
      // answers through the workspace UI service instead. Resolved per call so a
      // service that activates later is still found.
      const pickDirectory = () => {
        const desktop = globalThis.__DSH_DIRECTORY_PICKER__
        if (desktop !== undefined && typeof desktop.pick === 'function') return desktop.pick()
        const workspace = ctx.get('uiWorkspace')
        if (workspace !== undefined && typeof workspace.pickDirectory === 'function') return workspace.pickDirectory()
        throw new Error('这个环境没有可用的目录选择器')
      }

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'strata',
        order: 20,
      }, StrataControl))

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'strata',
        order: 20,
        label: 'Strata',
        inject: () => ({ pickDirectory: pickDirectory }),
      }, StrataLauncher))

      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-strata-console',
        inject: () => ({ pickDirectory: pickDirectory }),
      }, StrataPanel))
    }

    exports.apply = apply
    return module.exports
  },
})
