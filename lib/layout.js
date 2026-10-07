/**
 * The Strata directory convention, and the check that enforces it.
 *
 * Choosing a Strata checkout is a directory pick, so the plugin has to say what
 * a valid one looks like instead of trusting whatever the picker returned. The
 * convention below is the layout this project ships (`START-HERE.bat` /
 * `run-q2_0.bat`):
 *
 *   <root>/serve/server.py                 the server the plugin launches   (required)
 *   <root>/.venv/Scripts/python.exe        the private interpreter           (expected)
 *   <root>/engine/strata.exe               the GGUF engine
 *   <root>/strata-q2_0.json                the run config written by setup.py
 *   <root>/data/                           auxiliary engine data
 *
 * `serve/server.py` is the only hard requirement: without it there is nothing to
 * launch. Everything else degrades to a warning, because a checkout may use a
 * different interpreter, a differently named run config, or no venv at all —
 * the plugin has its own `python` and `config` settings for those cases.
 *
 * The module imports only Node built-ins so the check runs anywhere.
 *
 * @module dsh-strata-console/layout
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The interpreter path inside a checkout's private environment. */
const VENV_PYTHON = process.platform === 'win32'
  ? ['.venv', 'Scripts', 'python.exe']
  : ['.venv', 'bin', 'python']

/**
 * The convention, in reading order. `relative` is a path segment list so the
 * report can show one spelling on every platform.
 */
export const STRATA_LAYOUT = Object.freeze([
  Object.freeze({
    key: 'server',
    label: '服务脚本',
    relative: Object.freeze(['serve', 'server.py']),
    required: true,
    hint: '启动本地服务的入口，缺它就什么都没法跑',
  }),
  Object.freeze({
    key: 'python',
    label: '私有解释器',
    relative: Object.freeze(VENV_PYTHON),
    required: false,
    hint: '缺失时回退到配置里的 python 或 PATH 上的 python',
  }),
  Object.freeze({
    key: 'config',
    label: '运行配置',
    relative: Object.freeze(['strata-q2_0.json']),
    required: false,
    hint: 'setup.py 写出的引擎参数、模型路径与端口',
  }),
  Object.freeze({
    key: 'engine',
    label: '推理引擎',
    relative: Object.freeze(['engine', process.platform === 'win32' ? 'strata.exe' : 'strata']),
    required: false,
    hint: '真正加载 GGUF 权重的可执行文件',
  }),
  Object.freeze({
    key: 'data',
    label: '数据目录',
    relative: Object.freeze(['data']),
    required: false,
    hint: '引擎的辅助数据（专家画像、控制向量等）',
  }),
])

/** Whether a path exists as either a file or a directory. */
function present(absolute) {
  try {
    return existsSync(absolute) && statSync(absolute) !== undefined
  } catch {
    return false
  }
}

/** Immediate child directories of a path, ignoring unreadable ones. */
function childDirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .slice(0, 64)
  } catch {
    return []
  }
}

/**
 * Check one candidate directory against {@link STRATA_LAYOUT}.
 * @param root - the directory to check, absolute or resolved against the cwd.
 * @returns the report the panel renders and the config route enforces.
 */
export function inspectLayout(root) {
  const absoluteRoot = resolve(root ?? '.')
  const rootExists = present(absoluteRoot)
  const entries = STRATA_LAYOUT.map((row) => {
    const absolute = join(absoluteRoot, ...row.relative)
    return {
      key: row.key,
      label: row.label,
      relative: row.relative.join('/'),
      absolute,
      present: rootExists && present(absolute),
      required: row.required,
      hint: row.hint,
    }
  })
  const missingRequired = entries.filter((entry) => entry.required && !entry.present)
  const missingExpected = entries.filter((entry) => !entry.required && !entry.present)
  const report = {
    root: absoluteRoot,
    rootExists,
    valid: rootExists && missingRequired.length === 0,
    entries,
    missingRequired: missingRequired.map((entry) => entry.label),
    missingExpected: missingExpected.map((entry) => entry.label),
  }
  // A picked directory is often the checkout's parent (`D:\strata` instead of
  // `D:\strata\Strata-main`). Point at the single child that fits, rather than
  // making the user work out why nothing is found.
  if (!report.valid) {
    for (const name of childDirectories(absoluteRoot)) {
      const candidate = join(absoluteRoot, name)
      const fits = STRATA_LAYOUT
        .filter((row) => row.required)
        .every((row) => present(join(candidate, ...row.relative)))
      if (fits) {
        report.suggestion = { root: candidate, reason: `它下面的 ${name} 才是 Strata 检出目录` }
        break
      }
    }
  }
  return report
}

/** A one-line summary of a report, for logs and messages. */
export function describeLayout(report) {
  if (report.valid) {
    const missing = report.missingExpected.length
    return missing === 0
      ? `${report.root}：符合目录规范`
      : `${report.root}：可用，但有 ${missing} 项约定内容缺失（${report.missingExpected.join('、')}）`
  }
  return `${report.root}：不符合目录规范，缺少 ${report.missingRequired.join('、')}`
}
