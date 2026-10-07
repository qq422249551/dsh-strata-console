/**
 * The tunable settings, their validation, and the metadata the panel renders.
 *
 * This module is the single source of truth for the parameter list: the host
 * validates with it, the browser half *renders from it* (`GET /strata/api/settings`
 * returns `fields`), so adding a parameter here adds it to the panel with no
 * second edit. `root` and `port` are deliberately absent — they have dedicated
 * controls because they carry their own checks (a directory convention, a free
 * port, provider rewrites) rather than being written straight through.
 *
 * Imports only Node built-ins, so the checks run anywhere.
 *
 * @module dsh-strata-console/settings
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * A parameter that only takes effect at the next launch: changing it under a
 * running server would strand the process the plugin is tracking, because the
 * new plugin instance starts with no child handle.
 */
export const RESTART_REQUIRED_KEYS = Object.freeze([
  'python',
  'config',
  'host',
  'extraArgs',
  'idleUnloadSeconds',
])

/** The panel's form description: order, labels, kinds, bounds, and hints. */
export const SETTINGS_FIELDS = Object.freeze([
  Object.freeze({
    key: 'python',
    label: 'Python 解释器',
    kind: 'path',
    hint: '留空则用检出目录里的 .venv 解释器，再退回 PATH 上的 python',
  }),
  Object.freeze({
    key: 'config',
    label: '运行配置',
    kind: 'path',
    hint: 'setup.py 写出的 JSON；留空则用检出目录里的 strata-q2_0.json',
  }),
  Object.freeze({
    key: 'host',
    label: '监听地址',
    kind: 'text',
    hint: '127.0.0.1 只服务本机；0.0.0.0 也开放给局域网（这时建议同时设置 --api-key）',
  }),
  Object.freeze({
    key: 'extraArgs',
    label: '附加参数',
    kind: 'lines',
    hint: '一行一个，直接追加到启动命令后面，例如 --lazy、--api-key xxx',
  }),
  Object.freeze({
    key: 'readyTimeoutSeconds',
    label: '就绪等待（秒）',
    kind: 'number',
    min: 10,
    max: 3600,
    hint: 'strata_start 工具等待 /health 的上限；面板按钮不受它限制',
  }),
  Object.freeze({
    key: 'idleUnloadSeconds',
    label: '闲置卸载（秒）',
    kind: 'number',
    min: 0,
    max: 86400,
    hint: '0 = 从不卸载；大于 0 会在闲置该秒数后释放显存，下次请求再加载',
  }),
  Object.freeze({
    key: 'installArgs',
    label: '安装参数',
    kind: 'lines',
    hint: '传给 setup.py 的额外参数（一行一个）；「首次安装」区的选择会填到这里。留空即全部采用推荐值',
  }),
  Object.freeze({
    key: 'updateArgs',
    label: '更新参数',
    kind: 'lines',
    hint: '手动更新时附加到 setup.py --update 后面的参数（一行一个），例如 --build、--cuda 13',
  }),
  Object.freeze({
    key: 'defaultModelOnReady',
    label: '就绪后切换默认模型',
    kind: 'boolean',
    hint: 'Strata 报告就绪后，把推理模型的默认值切到它（只改默认选中项，不往模型列表里加任何东西）',
  }),
  Object.freeze({
    key: 'stopOnExit',
    label: 'DSH 退出时停止服务',
    kind: 'boolean',
    hint: '默认开启：退出 DeepSeek Harness 会一并停止服务、释放显存；关掉则保留已加载的模型，下次启动直接复用',
  }),
])

/** One field's metadata by key. */
const FIELD_BY_KEY = new Map(SETTINGS_FIELDS.map((field) => [field.key, field]))

/** Whether a path points at an existing file. */
function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/** Coerce a list of argv strings from an array or a newline-separated block. */
function toLines(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string')
  if (typeof value === 'string') return value.split(/\r?\n/u)
  return []
}

/**
 * Validate one submitted settings payload.
 *
 * Every field is required in the result, so a save always writes the complete
 * set rather than leaving stale keys behind.
 *
 * @param raw - the submitted values, however malformed.
 * @param current - the values an omitted or rejected field keeps.
 * @returns the normalized values plus one entry per rejected field.
 */
export function normalizeSettings(raw, current) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const values = {}
  const errors = []

  for (const field of SETTINGS_FIELDS) {
    const submitted = input[field.key]
    const fallback = current[field.key]
    const value = submitted === undefined ? fallback : submitted

    if (field.kind === 'boolean') {
      values[field.key] = value === true
      continue
    }

    if (field.kind === 'number') {
      const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim())
      if (!Number.isInteger(parsed) || parsed < field.min || parsed > field.max) {
        errors.push({ key: field.key, message: `必须是 ${field.min} 到 ${field.max} 之间的整数` })
        values[field.key] = fallback
        continue
      }
      values[field.key] = parsed
      continue
    }

    if (field.kind === 'lines') {
      const lines = toLines(value).map((entry) => entry.trim()).filter((entry) => entry !== '')
      if (lines.length > 64) {
        errors.push({ key: field.key, message: '最多 64 个参数' })
        values[field.key] = fallback
        continue
      }
      const tooLong = lines.find((entry) => entry.length > 512)
      if (tooLong !== undefined) {
        errors.push({ key: field.key, message: '单个参数不能超过 512 个字符' })
        values[field.key] = fallback
        continue
      }
      values[field.key] = lines
      continue
    }

    const text = typeof value === 'string' ? value.trim() : ''
    if (field.kind === 'path') {
      if (text === '') {
        values[field.key] = ''
        continue
      }
      if (!isAbsolute(text)) {
        errors.push({ key: field.key, message: '要填绝对路径，例如 D:\\strata\\Strata-main\\...' })
        values[field.key] = fallback
        continue
      }
      if (!isFile(text)) {
        errors.push({ key: field.key, message: `找不到文件：${text}` })
        values[field.key] = fallback
        continue
      }
      values[field.key] = text
      continue
    }

    // `host`: a bare bind address, never a URL.
    if (text === '') {
      errors.push({ key: field.key, message: '不能为空；只服务本机请填 127.0.0.1' })
      values[field.key] = fallback
      continue
    }
    if (text !== '::' && !/^[A-Za-z0-9.:-]+$/u.test(text)) {
      errors.push({ key: field.key, message: '只填地址本身，不要带端口、协议或路径' })
      values[field.key] = fallback
      continue
    }
    values[field.key] = text
  }

  return { values, errors }
}

/**
 * Read the stored configuration as display values, without rejecting anything:
 * the panel must be able to show a config that a future version no longer
 * accepts, and let the user fix it.
 * @param config - the effective plugin configuration.
 * @param defaults - the effective defaults.
 * @returns one display value per field.
 */
export function displaySettings(config, defaults) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const values = {}
  for (const field of SETTINGS_FIELDS) {
    const raw = source[field.key]
    if (field.kind === 'boolean') values[field.key] = raw === true
    else if (field.kind === 'number') values[field.key] = Number.isInteger(raw) ? raw : defaults[field.key]
    else if (field.kind === 'lines') values[field.key] = toLines(raw).map((entry) => entry.trim()).filter((entry) => entry !== '')
    else values[field.key] = typeof raw === 'string' ? raw : ''
  }
  return values
}

/**
 * The concrete paths an empty `python` / `config` field falls back to, so the
 * panel can show them as the placeholder instead of a vague hint.
 * @param root - the configured Strata directory.
 * @returns the derived interpreter and run-config paths.
 */
export function fallbacksFor(root) {
  const win = process.platform === 'win32'
  return {
    python: win ? `${root}\\.venv\\Scripts\\python.exe` : `${root}/.venv/bin/python`,
    config: win ? `${root}\\strata-q2_0.json` : `${root}/strata-q2_0.json`,
  }
}

/** Whether one field exists at all (a guard for malformed payloads). */
export function isSettingKey(key) {
  return FIELD_BY_KEY.has(key)
}
