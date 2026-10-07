/**
 * The install choices — `START-HERE.bat` asks these questions, so the panel asks
 * them too.
 *
 * The lists are **read out of the installed `setup.py`**, not copied from it:
 * one probe imports the module for `FAMILIES` / `MODELS` / `CONTEXTS`, and reads
 * the argument parser's own help text for the enumerated flags
 * (`--kv {int8,q4_0,k8v4}` and friends). A Strata update that adds a model size
 * or a new KV mode therefore shows up in the panel with no change here; only the
 * curated *selection* of flags — which questions are worth asking — is ours.
 *
 * Anything the form does not ask keeps the installer's own recommended answer,
 * because the install always passes `--yes`.
 *
 * Imports node built-ins only.
 *
 * @module dsh-strata-console/setup-options
 */

/**
 * The model's trained context length, from `setup.py`'s own note: contexts past
 * it need RoPE extension ("Contexts past 262144 (the model's trained length)
 * extend it by rope scaling"). Used to warn, never to restrict.
 */
export const TRAINED_CONTEXT = 262_144

/** The families and sizes to fall back on when `setup.py` cannot be introspected. */
const FALLBACK_TABLES = Object.freeze({
  families: Object.freeze({
    qwen: Object.freeze({ title: 'Qwen3.8-Flash-Next', about: 'the original model' }),
    swift: Object.freeze({ title: 'Swift 1.5', about: '' }),
    coder: Object.freeze({ title: 'Coder', about: '' }),
    unsloth: Object.freeze({ title: 'Unsloth', about: '' }),
  }),
  models: Object.freeze({
    Q2_0: Object.freeze({ about: '2-bit, the fastest', families: Object.freeze(['qwen']) }),
    IQ2_XS: Object.freeze({ about: '2-bit i-quant', families: Object.freeze(['qwen']) }),
    IQ3_XXS: Object.freeze({ about: '3-bit', families: Object.freeze(['qwen']) }),
  }),
  contexts: Object.freeze([8192, 32768, 65536, 131072, 204800, 262144, 393216, 524288]),
})

/** The enumerated flags to fall back on, in argparse's own notation. */
const FALLBACK_ENUMS = Object.freeze({
  '--kv': ['int8', 'q4_0', 'k8v4'],
  '--vision': ['yes', 'no', 'none', 'gpu', 'cpu'],
  '--rope-scaling': ['none', 'linear', 'yarn'],
  '--low-ram': ['auto', 'on', 'off', 'resident', 'mmap'],
})

/** Readable names for the enum values whose own spelling says little. */
const ENUM_LABELS = Object.freeze({
  '--vision': Object.freeze({ yes: '支持（GPU）', gpu: '支持（GPU）', no: '不支持', none: '不支持', cpu: '支持（CPU）' }),
  '--kv': Object.freeze({ int8: 'int8（省显存，默认）', q4_0: 'q4_0（更省）', k8v4: 'k8v4' }),
  '--rope-scaling': Object.freeze({ yarn: 'yarn（默认）', linear: 'linear', none: '不扩展' }),
  '--low-ram': Object.freeze({ auto: 'auto（默认）', on: 'on', off: 'off', resident: 'resident', mmap: 'mmap' }),
})

/**
 * The questions the panel asks, in order. `key` is the field the form holds;
 * `flag` is what the answer becomes on the installer's command line.
 */
export const SETUP_CHOICES = Object.freeze([
  Object.freeze({
    key: 'family',
    flag: '--family',
    label: '模型家族',
    source: 'families',
    hint: 'setup.py 里的 FAMILIES；Swift / Coder / Unsloth 支持哪些尺寸各不相同',
  }),
  Object.freeze({
    key: 'model',
    flag: '--model',
    label: '模型尺寸',
    source: 'models',
    hint: '量化档位；括号里是下载体积与内存需求',
  }),
  Object.freeze({
    key: 'context',
    flag: '--context',
    label: '上下文长度',
    hint: `超过 ${TRAINED_CONTEXT / 1024}K 会启用 RoPE 扩展`,
    source: 'contexts',
  }),
  Object.freeze({
    key: 'ropeScaling',
    flag: '--rope-scaling',
    label: 'RoPE 扩展',
    source: 'enum',
    hint: '只有上下文超过模型训练长度时才生效',
  }),
  Object.freeze({
    key: 'kv',
    flag: '--kv',
    label: 'KV 缓存',
    source: 'enum',
    hint: '上下文大于 8K 时的缓存精度：越省显存，能放进显存的专家层越多',
  }),
  Object.freeze({
    key: 'vision',
    flag: '--vision',
    label: '图像输入',
    source: 'enum',
    hint: '需要多模态编码器；CPU 模式更省显存但更慢',
  }),
  Object.freeze({
    key: 'visionTokens',
    flag: '--vision-tokens',
    label: '图像 token 上限',
    kind: 'number',
    min: 1,
    max: 16_384,
    hint: '一张图最多变成多少 token；默认 GPU 1024 / CPU 300',
  }),
  Object.freeze({
    key: 'gpu',
    flag: '--gpu',
    label: 'GPU',
    source: 'gpus',
    hint: '多卡机器上选择用哪一张（nvidia-smi 的编号）',
  }),
  Object.freeze({
    key: 'lowRam',
    flag: '--low-ram',
    label: '低内存模式',
    source: 'enum',
    hint: '内存吃紧时专家层的放置策略',
  }),
  Object.freeze({
    key: 'parallel',
    flag: '--parallel',
    label: '并行请求数',
    kind: 'number',
    min: 1,
    max: 64,
    hint: '允许多少个请求同时解码；每个槽位都要占用专家缓存',
  }),
  Object.freeze({
    key: 'vramReserve',
    flag: '--vram-reserve-mib',
    label: '保留显存（MiB）',
    kind: 'number',
    min: 0,
    max: 65_536,
    hint: '留给其它程序的显存；引擎默认 700',
  }),
  Object.freeze({
    key: 'host',
    flag: '--host',
    label: '监听地址',
    kind: 'text',
    hint: '写进运行配置，插件启动时也会用它；0.0.0.0 时建议同时设 API 密钥',
  }),
  Object.freeze({
    key: 'apiKey',
    flag: '--api-key',
    label: 'API 密钥',
    kind: 'text',
    hint: '要求客户端携带该密钥；留空则不需要',
  }),
])

/** The probe: import the module for its tables, then read the parser's help. */
function probeSource(root) {
  return [
    'import contextlib, io, json, sys',
    `root = ${JSON.stringify(root)}`,
    'sys.path.insert(0, root)',
    'sys.argv = ["setup.py"]',
    'import setup',
    'tables = {',
    '  "families": {k: {kk: vv for kk, vv in v.items() if kk in ("title", "by", "about", "experimental")}',
    '               for k, v in setup.FAMILIES.items()},',
    '  "models": {k: {kk: vv for kk, vv in v.items()',
    '             if kk in ("about", "download_gb", "ram_gb", "arena_gb", "families", "experimental", "budget")}',
    '             for k, v in setup.MODELS.items()},',
    '  "contexts": list(setup.CONTEXTS),',
    '}',
    'buf = io.StringIO()',
    'sys.argv = ["setup.py", "--help"]',
    'try:',
    '    with contextlib.redirect_stdout(buf):',
    '        setup.main()',
    'except SystemExit:',
    '    pass',
    'print("<<<JSON>>>" + json.dumps(tables) + "<<<END>>>")',
    'print(buf.getvalue())',
  ].join('\n')
}

/** The argv one probe runs, given the interpreter to run it with. */
export function probeArgv(pythonArgv, root) {
  return [...pythonArgv, '-c', probeSource(root)]
}

/**
 * Pull `--flag {a,b,c}` enumerations out of argparse's help text.
 * @param help - the captured `--help` output.
 * @returns one entry per enumerated flag.
 */
export function parseEnums(help) {
  const enums = {}
  for (const line of String(help ?? '').split(/\r?\n/u)) {
    const match = /^\s+(--[a-z0-9-]+)\s+\{([^}]*)\}/u.exec(line)
    if (match === null) continue
    enums[match[1]] = match[2].split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  }
  return enums
}

/** The markers a probe wraps its JSON payload in. */
const JSON_OPEN = '<<<JSON>>>'
const JSON_CLOSE = '<<<END>>>'

/**
 * Read the JSON one probe wrapped in its markers.
 *
 * `setup.py` prints freely around it, so the payload is delimited rather than
 * parsed out of the whole stream.
 * @param stdout - the probe's captured stdout.
 * @returns the parsed payload, or undefined when it is absent or unreadable.
 */
export function parseMarkedJson(stdout) {
  const text = String(stdout ?? '')
  const open = text.indexOf(JSON_OPEN)
  const close = text.indexOf(JSON_CLOSE)
  if (open < 0 || close < 0) return undefined
  try {
    const value = JSON.parse(text.slice(open + JSON_OPEN.length, close))
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse one option probe's output.
 * @param stdout - the probe's captured stdout.
 * @returns the tables and the enumerated flags, or undefined when unreadable.
 */
export function parseProbe(stdout) {
  const tables = parseMarkedJson(stdout)
  if (tables === undefined || !Array.isArray(tables.contexts)) return undefined
  const text = String(stdout ?? '')
  return { tables, enums: parseEnums(text.slice(text.indexOf(JSON_CLOSE))) }
}

/** `48 GB` style, from a number that may be missing. */
function gigabytes(value) {
  return typeof value === 'number' && value > 0 ? `${Math.round(value)} GB` : undefined
}

/**
 * Resolve the panel's choice list: each question with the items it offers.
 *
 * @param parsed - the probe's tables and enums, or undefined for the fallback.
 * @param gpus - the detected GPUs, each `{ index, name, memoryMb }`.
 * @param memoryGb - total system RAM, used to flag sizes that will not fit.
 * @returns the choices, the raw tables, and where they came from.
 */
export function buildOptions(parsed, gpus, memoryGb) {
  const tables = parsed?.tables ?? FALLBACK_TABLES
  const enums = { ...FALLBACK_ENUMS, ...(parsed?.enums ?? {}) }
  const families = tables.families ?? {}
  const models = tables.models ?? {}
  const choices = SETUP_CHOICES.map((choice) => {
    if (choice.source === 'families') {
      return {
        ...choice,
        items: Object.entries(families).map(([value, info]) => ({
          value,
          label: typeof info?.title === 'string' && info.title !== '' ? info.title : value,
          note: [info?.about, info?.experimental === true ? '实验性' : undefined].filter(Boolean).join(' · ') || undefined,
        })),
      }
    }
    if (choice.source === 'models') {
      return {
        ...choice,
        items: Object.entries(models).map(([value, info]) => {
          const size = gigabytes(info?.download_gb)
          const ram = gigabytes(info?.ram_gb)
          const tight = typeof info?.ram_gb === 'number' && typeof memoryGb === 'number' && memoryGb < info.ram_gb
          return {
            value,
            label: value,
            note: [info?.about, size === undefined ? undefined : `下载 ${size}`, ram === undefined ? undefined : `内存 ${ram}`]
              .filter(Boolean)
              .join(' · ') || undefined,
            // `setup.py` reads a size's families as `MODELS[m].get("families",
            // ("qwen", "swift"))`, so a size without the key belongs to both of
            // those and to nothing else. Resolving it here keeps the panel's
            // filter a plain membership test.
            families: Array.isArray(info?.families) && info.families.length > 0
              ? info.families
              : ['qwen', 'swift'],
            warn: tight ? `需要 ${ram} 内存，本机只有 ${Math.round(memoryGb)} GB` : undefined,
            experimental: info?.experimental === true,
          }
        }),
      }
    }
    if (choice.source === 'contexts') {
      const list = Array.isArray(tables.contexts) ? tables.contexts : FALLBACK_TABLES.contexts
      return {
        ...choice,
        valueKind: 'number',
        items: list.map((value) => ({
          value,
          label: `${value / 1024}K tokens`,
          note: value > TRAINED_CONTEXT ? '超过训练长度，需要 RoPE 扩展' : undefined,
        })),
      }
    }
    if (choice.source === 'gpus') {
      return {
        ...choice,
        valueKind: 'number',
        items: (Array.isArray(gpus) ? gpus : []).map((gpu) => ({
          value: gpu.index,
          label: `${gpu.index}: ${gpu.name}`,
          note: gigabytes((gpu.memoryMb ?? 0) / 1024) === undefined ? undefined : `显存 ${gigabytes((gpu.memoryMb ?? 0) / 1024)}`,
        })),
      }
    }
    if (choice.source === 'enum') {
      const values = enums[choice.flag] ?? []
      const labels = ENUM_LABELS[choice.flag] ?? {}
      // argparse lists aliases (`yes` and `gpu`, `no` and `none`); two entries
      // reading "不支持" would look like a bug, so the first spelling wins.
      const seen = new Set()
      const items = []
      for (const value of values) {
        const label = labels[value] ?? value
        if (seen.has(label)) continue
        seen.add(label)
        items.push({ value, label })
      }
      return { ...choice, items }
    }
    return { ...choice, kind: choice.kind ?? 'text', items: [] }
  })
  return {
    source: parsed === undefined ? 'fixed' : 'setup.py',
    trainedContext: TRAINED_CONTEXT,
    memoryGb,
    gpus: Array.isArray(gpus) ? gpus : [],
    choices,
  }
}
