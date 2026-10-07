/**
 * Reading and editing the Strata run config — the file `setup.py` writes.
 *
 * The model and the context length are *not* plugin settings: they live in the
 * run config JSON that the engine is launched with. Its `args` array carries
 * `--max-context N` (and the model files: `--native`, `--ple-gguf`, `--pack`, the
 * tokenizer, `--mtp`), and `model_name` is the id the server reports — the id a
 * DSH LLM provider has to agree with.
 *
 * So this module reads that file, reports what it points at, and can change the
 * two values that are safe to change in place:
 *
 *   - `--max-context N` — the served context window
 *   - `model_name` — the reported model id
 *
 * Everything else (which GGUF files a model is) is `setup.py`'s job: pointing the
 * engine at a different weight set means a different run config, which is why the
 * panel can also switch between configs rather than only edit one.
 *
 * Writes are backed up beside the original and renamed into place, so an
 * interrupted write cannot leave the engine with a half-written config.
 *
 * Imports only Node built-ins.
 *
 * @module dsh-strata-console/runconfig
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** Smallest context window the panel will write. */
export const MIN_CONTEXT = 2_048

/** Largest context window the panel will write; above this a load almost always fails. */
export const MAX_CONTEXT = 1_048_576

/** The engine flag whose following token is the context window. */
const CONTEXT_FLAG = '--max-context'

/** Read a JSON file, tolerating a BOM (Notepad and PowerShell both add one). */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
}

/** The token after a flag in an argv array, supporting `--flag=value` too. */
function flagValue(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === flag) {
      const next = args[index + 1]
      return typeof next === 'string' ? next : undefined
    }
    if (typeof token === 'string' && token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
  }
  return undefined
}

/** Strip trailing separators so prefixes compare cleanly. */
function trimSeparators(path) {
  return path.replace(/[\\/]+$/u, '')
}

/**
 * One comparison form for a path prefix: separators unified, case folded. A
 * pasted `D:/data` and a stored `D:\data` name the same directory and must
 * compare equal.
 */
function canonicalPrefix(path) {
  return trimSeparators(path).replace(/\//gu, '\\').toLowerCase()
}

/** The directory part of a path, on either separator convention. */
function directoryOf(path) {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return cut <= 0 ? '' : path.slice(0, cut)
}

/** The part of a path before a named segment, or undefined when absent. */
function rootBefore(path, segment) {
  const parts = path.split(/[\\/]+/u)
  const at = parts.findIndex((part) => part.toLowerCase() === segment)
  return at <= 0 ? undefined : parts.slice(0, at).join('\\')
}

/**
 * The two roots `setup.py --gguf-dir` / `--data-dir` established, derived from
 * the paths the config actually references. They are what a user means by "the
 * models directory" and "the data directory".
 * @param config - the run config object.
 * @returns the derived roots; an empty string when the config does not show one.
 */
function deriveRoots(config) {
  const args = Array.isArray(config.args) ? config.args.filter((entry) => typeof entry === 'string') : []
  const native = flagValue(args, '--native') ?? flagValue(args, '--ple-gguf') ?? ''
  const pack = flagValue(args, '--pack') ?? ''
  const mtp = flagValue(args, '--mtp') ?? ''
  const models = native === '' ? '' : directoryOf(native)
  const data = rootBefore(pack, 'packs') ?? rootBefore(mtp, 'mtp') ?? ''
  return { models, data }
}

/**
 * Re-root one path onto another directory, keeping its tail.
 * @param value - a candidate path.
 * @param oldRoot - the prefix to replace.
 * @param newRoot - the replacement prefix.
 * @returns the rewritten path, or the original when it is not under `oldRoot`.
 */
function reroot(value, oldRoot, newRoot) {
  if (typeof value !== 'string' || value === '') return value
  const from = trimSeparators(oldRoot)
  const to = trimSeparators(newRoot)
  if (from === '' || to === '' || canonicalPrefix(from) === canonicalPrefix(to)) return value
  if (value.length < from.length) return value
  // Compare canonically, slice the original: the two forms are the same length
  // because the normalization is one character for one.
  if (value.slice(0, from.length).replace(/\//gu, '\\').toLowerCase() !== canonicalPrefix(from)) return value
  const tail = value.slice(from.length)
  // Only a path *inside* the root is rewritten: `D:\data2` must not match `D:\data`.
  if (!/^[\\/]/u.test(tail)) return value
  // Keep the file's own separator convention: pasting `/` must not produce a
  // path that mixes both styles.
  const normalized = tail.startsWith('/') ? to.replace(/\\/gu, '/') : to.replace(/\//gu, '\\')
  return `${normalized}${tail}`
}

/**
 * Summarize one run config.
 * @param path - absolute path of the run config JSON.
 * @returns what the panel shows, or the reason it could not be read.
 */
export function readRunConfig(path) {
  const absolute = resolve(path)
  if (!existsSync(absolute)) return { path: absolute, ok: false, error: `找不到运行配置：${absolute}` }
  let config
  try {
    config = readJson(absolute)
  } catch (error) {
    return { path: absolute, ok: false, error: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (config === null || typeof config !== 'object' || !Array.isArray(config.args)) {
    return { path: absolute, ok: false, error: '不像 Strata 运行配置（缺少 args 数组）' }
  }
  const args = config.args.filter((entry) => typeof entry === 'string')
  const rawContext = flagValue(args, CONTEXT_FLAG)
  const parsedContext = Number(rawContext)
  const roots = deriveRoots(config)
  return {
    path: absolute,
    name: basename(absolute),
    ok: true,
    editable: true,
    modelName: typeof config.model_name === 'string' ? config.model_name : '',
    maxContext: Number.isInteger(parsedContext) ? parsedContext : undefined,
    engine: typeof config.exe === 'string' ? config.exe : '',
    roots,
    files: {
      native: flagValue(args, '--native') ?? '',
      ple: flagValue(args, '--ple-gguf') ?? '',
      pack: flagValue(args, '--pack') ?? '',
      mtp: flagValue(args, '--mtp') ?? '',
      tokenizer: typeof config.tokenizer === 'string' ? config.tokenizer : '',
      expertProfile: flagValue(args, '--expert-profile') ?? '',
    },
    log: typeof config.log === 'string' ? config.log : '',
  }
}

/**
 * Find the run configs a checkout carries.
 *
 * Only the checkout root is scanned: `setup.py` writes its config there, and
 * walking the tree would mostly find package manifests.
 * @param root - the Strata directory.
 * @returns one summary per file that looks like a run config.
 */
export function listRunConfigs(root) {
  const absolute = resolve(root)
  let names
  try {
    names = readdirSync(absolute)
  } catch {
    return []
  }
  const found = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const path = join(absolute, name)
    try {
      if (!statSync(path).isFile()) continue
    } catch {
      continue
    }
    const summary = readRunConfig(path)
    if (summary.ok !== true) continue
    found.push({ path: summary.path, name: summary.name, modelName: summary.modelName, maxContext: summary.maxContext })
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Re-root every path-bearing entry of a config, keeping the rest of the argv
 * untouched.
 * @param config - the run config being edited.
 * @param oldRoot - the root being replaced.
 * @param newRoot - its replacement.
 * @returns the new argv array.
 */
function relocateAll(config, oldRoot, newRoot) {
  const args = Array.isArray(config.args) ? [...config.args] : []
  for (let index = 0; index < args.length; index += 1) args[index] = reroot(args[index], oldRoot, newRoot)
  if (config.vision !== null && typeof config.vision === 'object') {
    config.vision = {
      ...config.vision,
      mmproj: reroot(config.vision.mmproj, oldRoot, newRoot),
      model: reroot(config.vision.model, oldRoot, newRoot),
    }
  }
  return args
}

/**
 * Every file the config points at, so a relocation can be refused before it
 * leaves the engine with paths that do not exist.
 * @param config - the run config to check.
 * @returns the missing paths, in discovery order.
 */
function missingPaths(config) {
  const args = Array.isArray(config.args) ? config.args.filter((entry) => typeof entry === 'string') : []
  const candidates = [
    ...['--native', '--ple-gguf', '--pack', '--mtp', '--expert-profile'].map((flag) => flagValue(args, flag)),
    typeof config.tokenizer === 'string' ? config.tokenizer : undefined,
    config.vision !== null && typeof config.vision === 'object' ? config.vision.mmproj : undefined,
    config.vision !== null && typeof config.vision === 'object' ? config.vision.model : undefined,
  ]
  const missing = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    // A `--flag path:value` pair is checked as the path only.
    const path = candidate.includes(':') && !/^[A-Za-z]:[\\/]/u.test(candidate)
      ? candidate.slice(0, candidate.indexOf(':'))
      : candidate
    // Several flags can name the same file (the vision model repeats --native).
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!existsSync(path)) missing.push(path)
  }
  return missing
}

/**
 * The files a config points at that are not on disk yet — what a first install
 * still has to produce.
 * @param path - the run config to inspect.
 * @returns the missing paths, or an empty list when the config cannot be read.
 */
export function missingRunConfigFiles(path) {
  const summary = readRunConfig(path)
  if (summary.ok !== true) return []
  try {
    return missingPaths(readJson(resolve(path)))
  } catch {
    return []
  }
}

/**
 * Rewrite `--max-context`, `model_name`, and/or the model and data roots in one
 * run config.
 *
 * Re-rooting is the `setup.py --gguf-dir` / `--data-dir` operation: every path
 * the config carries that sits under the old root moves to the same relative
 * place under the new one, so a relocated checkout keeps its layout. Every
 * rewritten path is checked to exist first — a wrong folder is refused instead of
 * written, because the engine would otherwise fail minutes into a load.
 *
 * The original is copied to `<name>.bak-<timestamp>` first, and the replacement
 * is written beside it and renamed into place: the engine either reads the old
 * file or the new one, never a partial write.
 *
 * @param path - the run config to edit.
 * @param change - the values to set; an omitted key is left alone.
 * @returns the changed keys, the backup path, and the re-read summary.
 */
export function writeRunConfig(path, change) {
  const absolute = resolve(path)
  const before = readRunConfig(absolute)
  if (before.ok !== true) throw new Error(before.error)

  const config = readJson(absolute)
  const changed = []

  if (change.modelsRoot !== undefined) {
    const next = String(change.modelsRoot).trim()
    if (next === '') throw new Error('模型目录不能为空')
    if (before.roots.models === '') throw new Error('这个运行配置里没有可重定位的模型目录')
    if (canonicalPrefix(next) !== canonicalPrefix(before.roots.models)) {
      config.args = relocateAll(config, before.roots.models, next)
      changed.push('modelsRoot')
    }
  }

  if (change.dataRoot !== undefined) {
    const next = String(change.dataRoot).trim()
    if (next === '') throw new Error('数据目录不能为空')
    if (before.roots.data === '') throw new Error('这个运行配置里没有可重定位的数据目录')
    if (canonicalPrefix(next) !== canonicalPrefix(before.roots.data)) {
      config.args = relocateAll(config, before.roots.data, next)
      config.tokenizer = reroot(config.tokenizer, before.roots.data, next)
      changed.push('dataRoot')
    }
  }

  if (change.maxContext !== undefined) {
    const next = Number(change.maxContext)
    if (!Number.isInteger(next) || next < MIN_CONTEXT || next > MAX_CONTEXT) {
      throw new Error(`上下文必须是 ${MIN_CONTEXT} 到 ${MAX_CONTEXT} 之间的整数`)
    }
    if (next !== before.maxContext) {
      const args = [...config.args]
      let replaced = false
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === CONTEXT_FLAG) {
          args[index + 1] = String(next)
          replaced = true
          break
        }
        if (typeof args[index] === 'string' && args[index].startsWith(`${CONTEXT_FLAG}=`)) {
          args[index] = `${CONTEXT_FLAG}=${next}`
          replaced = true
          break
        }
      }
      // A config without the flag would silently ignore the change, so add it.
      if (!replaced) args.push(CONTEXT_FLAG, String(next))
      config.args = args
      changed.push('maxContext')
    }
  }

  if (change.modelName !== undefined) {
    const next = String(change.modelName).trim()
    if (next === '') throw new Error('模型 id 不能为空')
    if (next.length > 128) throw new Error('模型 id 不能超过 128 个字符')
    if (next !== before.modelName) {
      config.model_name = next
      changed.push('modelName')
    }
  }

  if (changed.length === 0) return { changed, backup: undefined, config: before }

  if (changed.includes('modelsRoot') || changed.includes('dataRoot')) {
    const missing = missingPaths(config)
    if (missing.length > 0) {
      throw new Error(`新目录里缺少这些文件，没有写入：${missing.slice(0, 4).join('、')}${missing.length > 4 ? ` 等 ${missing.length} 项` : ''}`)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const backup = `${absolute}.bak-${stamp}`
  copyFileSync(absolute, backup)

  const temporary = `${absolute}.tmp-${process.pid}`
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 1)}\n`, 'utf8')
    renameSync(temporary, absolute)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }

  return { changed, backup, config: readRunConfig(absolute) }
}
