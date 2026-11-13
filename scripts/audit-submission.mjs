#!/usr/bin/env node
/* ============================================================================
 * VCG 提交审计器 / Submission auditor（CONTRACT §16.1 + §16.3）
 *
 * 对一次 PR / Issue 提交做审计，输出 JSON 报告 + 退出码：
 *   1. 声明解析：正文中的 `type:` / `files:` / `submitter:` / `supersedes:`
 *      （兼容 PR 模板的 `key: value` 与 Issue 表单的 `### 标题` 两种格式）
 *   2. 文件路径与声明类型匹配：node → 只能 1 个 nodes/*.json；
 *      workflow → 只能 1 个 workflows/*.json
 *   3. 结构与规范校验：复用 scripts/lib/validate-core.mjs（与 validate.mjs 同一套规则）
 *   4. 跨分支重复检测：对比 main/dev/bug/recheck 的 id / 文件名 / 内容 sha256
 *      （本地无分支或非 git 仓库时优雅降级并在报告注明）
 *   5. models[] 声明安全审计（CONTRACT §16.3）：https / filename / format / size / sha256；
 *      不可信 host、缺 sha256、非 https 只 warning，不阻止上传
 *   6. 输出 JSON 报告（--json-out）与 Markdown 评论（--md-out）
 *
 * 退出码：0 = 审计通过；1 = 审计不通过（有 error）；2 = 参数/环境错误。
 *
 * 用法：
 *   node scripts/audit-submission.mjs \
 *     --files nodes/my-node.json workflows/my-flow.json \
 *     --body-file pr-body.md --author alice --pr 42 --base-ref dev \
 *     --json-out audit-report.json --md-out audit-comment.md
 *
 * 环境变量覆盖（CI 友好）：
 *   AUDIT_TYPE / AUDIT_FILES / PR_BODY|ISSUE_BODY|AUDIT_BODY / AUDIT_ROOT /
 *   AUDIT_REFS / AUDIT_TRUSTED_SOURCES / AUDIT_JSON_OUT / AUDIT_MD_OUT /
 *   AUDIT_PR / AUDIT_AUTHOR / AUDIT_BASE_REF / AUDIT_COMMIT / AUDIT_SKIP_REFS
 * ==========================================================================*/
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditModels,
  createValidator,
  isObject,
  isNonEmptyString,
  loadTrustedSources,
} from './lib/validate-core.mjs'

const execFileAsync = promisify(execFile)
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUDIT_VERSION = '1.0.0'
const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

const TYPES = ['node', 'workflow']
const DIR_BY_TYPE = { node: 'nodes', workflow: 'workflows' }
const PATH_PATTERN = {
  node: /^nodes\/[A-Za-z0-9._-]+\.json$/,
  workflow: /^workflows\/[A-Za-z0-9._-]+\.json$/,
}
const DEFAULT_REFS = ['main', 'dev', 'bug', 'recheck']

const VALUE_FLAGS = new Set([
  'type', 'files', 'body', 'body-file', 'repo-root', 'refs', 'trusted',
  'json-out', 'md-out', 'pr', 'author', 'base-ref', 'commit', 'reason',
])
const BOOL_FLAGS = new Set([
  'json', 'json-stdout', 'skip-refs', 'offline', 'strict-duplicates', 'allow-duplicates', 'help',
])

/* ------------------------------------------------------------------ 工具 */

function usage(message) {
  const text = [
    message ? `错误: ${message}` : '',
    '',
    '用法: node scripts/audit-submission.mjs --files <path...> [选项]',
    '',
    '选项:',
    '  --type <node|workflow>   声明类型（省略时从正文 type: 解析）',
    '  --files <a,b>            本次变更文件（可重复；CI 传 git diff 结果）',
    '  --body <text>             PR/Issue 正文（含声明字段）',
    '  --body-file <path>        从文件读取正文',
    '  --repo-root <path>        仓库根目录（默认当前 git 仓库 / 脚本上级目录）',
    '  --refs <main,dev,...>     重复检测对比的分支（默认 main,dev,bug,recheck）',
    '  --trusted <path>          trusted-sources.json 路径（默认 <repo>/trusted-sources.json）',
    '  --json-out <path|->       JSON 报告输出路径（- 为 stdout）',
    '  --md-out <path>           Markdown 评论输出路径',
    '  --pr <number>             PR / Issue 编号（写入报告）',
    '  --author <login>          PR/Issue 作者（校验 submitter 一致性）',
    '  --base-ref <ref>          PR 目标分支（必须 dev）',
    '  --commit <sha>            被审计提交 sha（写入报告）',
    '  --skip-refs               跳过跨分支重复检测（离线审计）',
    '  --strict-duplicates       兼容旧参数（重复默认已经是 error，无需指定）',
    '  --allow-duplicates        Issue 复核场景：重复降级为 warning（普通 PR 默认重复=error）',
    '  --json                    以 JSON 打印到 stdout（默认打印摘要）',
    '  --help                    显示本帮助',
    '',
    '环境变量: AUDIT_TYPE / AUDIT_FILES / PR_BODY / ISSUE_BODY / AUDIT_BODY /',
    '  AUDIT_ROOT / AUDIT_REFS / AUDIT_TRUSTED_SOURCES / AUDIT_JSON_OUT /',
    '  AUDIT_MD_OUT / AUDIT_PR / AUDIT_AUTHOR / AUDIT_BASE_REF / AUDIT_COMMIT /',
    '  AUDIT_SKIP_REFS / AUDIT_ALLOW_DUPLICATES（=1 时重复降级为 warning）',
  ].filter((line) => line !== undefined).join('\n')
  return text
}

function parseArgv(argv) {
  const parsed = { files: [], refs: [], flags: new Set(), values: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      // 位置参数视为 --files 的延续（支持 --files a.json b.json）
      parsed.files.push(...splitList(token))
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    const name = eq === -1 ? body : body.slice(0, eq)
    const inline = eq === -1 ? undefined : body.slice(eq + 1)
    if (BOOL_FLAGS.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} 不接受取值`)
      parsed.flags.add(name)
      continue
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`未知选项: --${name}`)
    let value = inline
    if (value === undefined) {
      if (index + 1 >= argv.length) throw new Error(`--${name} 缺少取值`)
      index += 1
      value = argv[index]
    }
    if (name === 'files') parsed.files.push(...splitList(value))
    else if (name === 'refs') parsed.refs.push(...splitList(value))
    else parsed.values[name] = value
  }
  return parsed
}

function splitList(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeRepoPath(raw) {
  let value = String(raw || '').trim()
  value = value.replace(/^[`'"\s]+|[`'"\s]+$/g, '')
  value = value.replace(/\\/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  return value
}

function safeRelative(repoRoot, relPath) {
  const segments = relPath.split('/')
  if (relPath.startsWith('/') || /^[A-Za-z]:\//.test(relPath) || segments.includes('..') || segments.includes('')) {
    return null
  }
  const absolute = path.resolve(repoRoot, relPath)
  const relative = path.relative(repoRoot, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sanitizeText(value, limit = 400) {
  const text = String(value || '').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

async function git(cwd, args, { allowFail = false, buffer = false } = {}) {
  try {
    const options = {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }
    if (buffer) options.encoding = 'buffer'
    const { stdout } = await execFileAsync('git', args, options)
    return stdout
  } catch (error) {
    if (allowFail) return null
    throw error
  }
}

function gitErrorMessage(error) {
  const stderr = error && error.stderr ? String(error.stderr) : ''
  return sanitizeText(stderr || (error && error.message) || 'git 命令失败')
}

async function resolveCommit(repoRoot, ref) {
  const candidates = [ref, `refs/heads/${ref}`, `refs/remotes/origin/${ref}`]
  for (const candidate of candidates) {
    const sha = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], { allowFail: true })
    if (sha && String(sha).trim()) return String(sha).trim()
  }
  return null
}

/* ---------------------------------------------------------- 声明解析 */

const FIELD_ALIASES = {
  type: ['type', 'kind', '类型', '提交类型'],
  files: ['files', 'file', 'path', 'paths', '文件', '文件路径', '被引用文件'],
  submitter: ['submitter', 'author', '提交者', '提交人'],
  supersedes: ['supersedes', 'supersede', 'replaces', '重新提交', '替代'],
}

const EMPTY_SENTINELS = new Set(['_no response_', 'no response', 'n/a', 'na', '无', '没有', '-'])

function isEmptyFieldValue(value) {
  return EMPTY_SENTINELS.has(String(value || '').trim().toLowerCase())
}

function fieldKey(label) {
  const normalized = String(label || '')
    .toLowerCase()
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[\s*`]/g, '')
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const target = alias.toLowerCase().replace(/[\s*`]/g, '')
      if (normalized === target || normalized.includes(target)) return key
    }
  }
  return null
}

function parseDeclaration(body) {
  const declaration = {
    type: null,
    files: [],
    submitter: null,
    supersedes: null,
    supersedesRaw: null,
    errors: [],
    warnings: [],
    format: null,
  }
  const source = String(body || '')
  if (!source.trim()) {
    declaration.errors.push('PR/Issue 正文为空，缺少提交声明（type / files / submitter）')
    return declaration
  }

  const sections = new Map()
  const lines = source.split(/\r?\n/)
  // 1) Issue 表单：### 标题 后跟一段内容
  let current = null
  for (const line of lines) {
    const heading = /^#{1,4}\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = fieldKey(heading[1])
      if (current) {
        declaration.format = declaration.format || 'issue-form'
        if (!sections.has(current)) sections.set(current, [])
      }
      continue
    }
    if (current) sections.get(current).push(line)
  }
  for (const [key, sectionLines] of sections) {
    const value = sectionLines.join('\n').trim()
    if (!value || isEmptyFieldValue(value)) continue
    if (key === 'type') {
      if (!declaration.type) declaration.type = value.split(/\s+/)[0].toLowerCase()
    } else if (key === 'files') {
      declaration.files.push(...extractFiles(value))
    } else if (key === 'submitter') {
      if (!declaration.submitter) declaration.submitter = value.split(/\s+/)[0]
    } else if (key === 'supersedes') {
      if (declaration.supersedesRaw === null) declaration.supersedesRaw = value
    }
  }

  // 2) PR 模板：key: value / key：value（可带 - 列表前缀与 ** 加粗）
  for (const line of lines) {
    const cleaned = line
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/\*\*/g, '')
      .trim()
    const match = /^([A-Za-z][A-Za-z0-9 _-]*?)\s*[:：]\s*(.*)$/.exec(cleaned)
    if (!match) continue
    const key = fieldKey(match[1])
    if (!key) continue
    const value = match[2].trim()
    if (!value) continue
    declaration.format = declaration.format || 'pr-template'
    if (key === 'type') {
      const type = value.split(/\s+/)[0].toLowerCase()
      if (declaration.type && declaration.type !== type) {
        declaration.warnings.push(`正文中 type 声明重复且不一致：${declaration.type} / ${type}`)
      }
      declaration.type = declaration.type || type
    } else if (key === 'files') {
      const files = extractFiles(value)
      for (const file of files) if (!declaration.files.includes(file)) declaration.files.push(file)
    } else if (key === 'submitter') {
      const submitter = value.split(/\s+/)[0]
      if (declaration.submitter && declaration.submitter !== submitter) {
        declaration.warnings.push(`正文中 submitter 声明重复且不一致：${declaration.submitter} / ${submitter}`)
      }
      declaration.submitter = declaration.submitter || submitter
    } else if (key === 'supersedes') {
      if (declaration.supersedesRaw === null) declaration.supersedesRaw = value
    }
  }

  // 3) supersedes: #N
  if (declaration.supersedesRaw !== null) {
    const numbers = [...String(declaration.supersedesRaw).matchAll(/#?(\d+)/g)].map((match) => Number(match[1]))
    if (numbers.length === 0) {
      declaration.errors.push(`supersedes 声明无法解析为 PR 编号: ${JSON.stringify(declaration.supersedesRaw)}（格式应为 #N）`)
    } else {
      declaration.supersedes = numbers[0]
      if (numbers.length > 1) declaration.warnings.push(`supersedes 声明包含多个编号，只处理第一个 #${numbers[0]}`)
    }
  }
  if (declaration.submitter) declaration.submitter = declaration.submitter.replace(/^@/, '')
  return declaration
}

function extractFiles(value) {
  const lines = String(value || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*+]\s+/, '').replace(/\s+#.*$/, '').trim())
    .filter((line) => line && !isEmptyFieldValue(line))
  return lines
    .flatMap((line) => line.split(/[\s,;]+/))
    .map((item) => normalizeRepoPath(item))
    .filter((item) => item && item !== '-' && item.toLowerCase() !== 'none' && !isEmptyFieldValue(item))
}

/* ------------------------------------------------------------ 文件解析 */

async function readNodeDefs(repoRoot, warnings) {
  const nodesDir = path.join(repoRoot, 'nodes')
  const defs = new Map()
  if (!existsSync(nodesDir)) {
    warnings.push('仓库 nodes/ 目录不存在，工作流节点类型无法校验')
    return defs
  }
  const names = (await readdir(nodesDir)).filter((name) => name.endsWith('.json')).sort()
  for (const name of names) {
    try {
      const def = JSON.parse(await readFile(path.join(nodesDir, name), 'utf8'))
      if (isObject(def) && isNonEmptyString(def.id)) defs.set(def.id, def)
    } catch (error) {
      warnings.push(`nodes/${name} 无法解析，工作流节点类型校验可能误报：${error.message}`)
    }
  }
  return defs
}

async function resolveSubmittedFile(repoRoot, relPath, refCandidates) {
  const absolute = safeRelative(repoRoot, relPath)
  if (!absolute) return { content: null, source: null, error: `路径不安全或越出仓库: ${relPath}` }
  if (existsSync(absolute)) {
    const info = await stat(absolute)
    if (info.isFile()) {
      return { content: await readFile(absolute), source: 'worktree', error: null }
    }
  }
  for (const ref of refCandidates) {
    const sha = await resolveCommit(repoRoot, ref)
    if (!sha) continue
    const content = await git(repoRoot, ['show', `${sha}:${relPath}`], { allowFail: true, buffer: true })
    if (content && content.length > 0) return { content, source: `ref:${ref}`, error: null }
  }
  return { content: null, source: null, error: `文件不存在: ${relPath}（工作区与分支 ${refCandidates.join('/')} 均未找到）` }
}

function extractEntityId(parsed) {
  if (!isObject(parsed)) return null
  return isNonEmptyString(parsed.id) ? parsed.id : null
}

/* ---------------------------------------------------------- 重复检测 */

function duplicateMessage(entry, type) {
  const kind = type === 'workflow' ? '工作流' : '节点'
  const where = `${entry.ref} 分支 ${entry.path}`
  if (entry.sameContent) return `内容与 ${where} 完全相同（重复提交或 recheck 复核）`
  if (entry.sameId) return `${kind} id "${entry.id}" 已存在于 ${where}（内容不同，可能是更新已有${kind}）`
  return `文件 ${entry.path} 已存在于 ${where}（内容不同）`
}

function duplicateDetail(entry) {
  const kind = entry.sameContent
    ? '内容与本次提交完全相同'
    : entry.sameId
      ? `id "${entry.id}" 已存在`
      : '文件已存在（内容不同）'
  return `${entry.ref} 分支 ${entry.path}（id=${entry.id || '-'}, sha256=${entry.sha256 || '-'}）：${kind}`
}

async function detectDuplicates({ repoRoot, type, submitted, refs, warnings }) {
  const result = {
    mode: 'git',
    checkedRefs: [],
    missingRefs: [],
    degraded: false,
    note: '',
    entries: [],
  }
  if (!existsSync(path.join(repoRoot, '.git'))) {
    result.mode = 'unavailable'
    result.degraded = true
    result.note = '仓库根不是 git 仓库，跳过跨分支重复检测'
    warnings.push(result.note)
    return result
  }
  const dir = submitted ? DIR_BY_TYPE[type] : null
  for (const ref of refs) {
    const sha = await resolveCommit(repoRoot, ref)
    if (!sha) {
      result.missingRefs.push(ref)
      warnings.push(`分支 ${ref} 不存在，跳过该分支的重复检测（优雅降级）`)
      continue
    }
    result.checkedRefs.push(ref)
    if (!submitted) continue
    const listing = await git(repoRoot, ['ls-tree', '-r', '--name-only', sha, '--', dir], { allowFail: true })
    if (listing === null) {
      result.degraded = true
      warnings.push(`无法读取 ${ref} 分支的 ${dir}/ 目录，跳过该分支的重复检测`)
      continue
    }
    const files = String(listing).split('\n').map((line) => line.trim()).filter(Boolean)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const content = await git(repoRoot, ['show', `${sha}:${file}`], { allowFail: true, buffer: true })
      if (!content) continue
      let entityId = null
      try {
        entityId = extractEntityId(JSON.parse(content.toString('utf8')))
      } catch {
        entityId = null
      }
      const contentSha = sha256(content)
      const entry = {
        ref,
        path: file,
        id: entityId,
        sha256: contentSha,
        sameFilename: path.posix.basename(file) === path.posix.basename(submitted.path),
        sameId: Boolean(entityId && submitted.id && entityId === submitted.id),
        sameContent: contentSha === submitted.sha256,
      }
      if (!entry.sameFilename && !entry.sameId && !entry.sameContent) continue
      entry.message = duplicateMessage(entry, type)
      result.entries.push(entry)
    }
  }
  const missingNote = result.missingRefs.length ? `；缺失: ${result.missingRefs.join(', ')}` : ''
  if (result.checkedRefs.length === 0) {
    result.degraded = true
    result.note = '没有任何可用的对比分支（main/dev/bug/recheck），重复检测已跳过'
    warnings.push(result.note)
  } else if (!submitted) {
    result.degraded = result.missingRefs.length > 0
    result.note = `仅检查分支可用性: ${result.checkedRefs.join(', ')}${missingNote}（缺少可审计文件，未做内容对比）`
  } else {
    result.degraded = result.degraded || result.missingRefs.length > 0
    result.note = `已对比分支: ${result.checkedRefs.join(', ')}${missingNote}`
  }
  return result
}

/* ------------------------------------------------------------ 报告生成 */

function buildMarkdown(report) {
  const lines = []
  const badge = report.ok ? '✅ 审计通过' : '❌ 审计未通过'
  lines.push('<!-- vcg-audit-report -->')
  lines.push(`## VCG 提交审计：${badge}`)
  lines.push('')
  lines.push(`- 声明类型：\`${report.declaredType || '未声明'}\``)
  if (report.declaration && report.declaration.files && report.declaration.files.length) {
    lines.push(`- 文件：${report.declaration.files.map((file) => `\`${file}\``).join('、')}`)
  }
  if (report.declaration && report.declaration.submitter) {
    lines.push(`- 提交者：@${report.declaration.submitter}`)
  }
  if (report.declaration && report.declaration.supersedes) {
    lines.push(`- 重新提交自：#${report.declaration.supersedes}`)
  }
  if (report.metadata && report.metadata.commit) lines.push(`- 提交：\`${report.metadata.commit}\``)
  lines.push(`- 审计时间：${report.generatedAt}`)
  lines.push('')
  lines.push('### 文件')
  lines.push('')
  lines.push('| 文件 | 来源 | 大小 | sha256 | 结构校验 |')
  lines.push('|---|---|---|---|---|')
  for (const file of report.files) {
    const valid = file.valid ? '通过' : '失败'
    const digest = file.sha256 ? `\`${file.sha256.slice(0, 16)}…\`` : '-'
    lines.push(`| \`${file.path}\` | ${file.source || '-'} | ${file.size ?? '-'} B | ${digest} | ${valid} |`)
  }
  lines.push('')
  if (report.errors.length > 0) {
    lines.push(`### 错误 (${report.errors.length})`)
    lines.push('')
    for (const message of report.errors) lines.push(`- ❌ ${message}`)
    lines.push('')
  }
  if (report.warnings.length > 0) {
    lines.push(`### 警告 (${report.warnings.length})`)
    lines.push('')
    for (const message of report.warnings) lines.push(`- ⚠️ ${message}`)
    lines.push('')
  }
  if (report.duplicates.length > 0) {
    lines.push(`### 跨分支重复 / 已存在 (${report.duplicates.length})`)
    lines.push('')
    for (const entry of report.duplicates) {
      const flags = [
        entry.sameContent ? '内容相同' : null,
        entry.sameId ? `id 相同 (${entry.id})` : null,
        entry.sameFilename ? '文件名相同' : null,
      ].filter(Boolean).join('，')
      lines.push(`- \`${entry.ref}\` 分支 \`${entry.path}\`（id=${entry.id || '-'}，sha256=\`${entry.sha256 || '-'}\`）：${flags}`)
    }
    lines.push('')
  }
  if (report.trust && report.trust.models && report.trust.models.length > 0) {
    lines.push('### 模型声明 (models[])')
    lines.push('')
    lines.push('| 文件 | filename | host | 可信源 | sha256 | format | size |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const model of report.trust.models) {
      lines.push(`| \`${model.file}\` | \`${model.filename || '-'}\` | ${model.host || '-'} | ${model.trusted === true ? '是' : model.trusted === false ? '否（需二次确认）' : '未比对'} | ${model.sha256 ? '有' : '缺失'} | ${model.format || '-'} | ${model.size ?? '-'} |`)
    }
    lines.push('')
  }
  lines.push('---')
  lines.push(`审计器 v${AUDIT_VERSION} · 规则见 CONTRACT §16.1/§16.3、\`docs/review-policy.md\`、\`docs/submission.md\``)
  return lines.join('\n') + '\n'
}

function buildHumanSummary(report) {
  const lines = []
  lines.push('VCG 提交审计 / Submission audit')
  lines.push('='.repeat(40))
  lines.push(`  声明类型 declaredType: ${report.declaredType || '未声明'}`)
  for (const file of report.files) {
    lines.push(`  文件: ${file.path} (${file.source || '未知来源'}, ${file.size ?? '?'} B, sha256 ${file.sha256 ? `${file.sha256.slice(0, 16)}…` : '-'})`)
  }
  lines.push(`  跨分支重复: ${report.duplicates.length} 项 — ${report.refs.note || ''}`)
  lines.push(`  模型声明: ${report.trust && report.trust.models ? report.trust.models.length : 0} 项`)
  lines.push(`  错误 errors: ${report.errors.length}`)
  for (const message of report.errors) lines.push(`    ✗ ${message}`)
  lines.push(`  警告 warnings: ${report.warnings.length}`)
  for (const message of report.warnings) lines.push(`    ! ${message}`)
  lines.push('')
  lines.push(report.ok ? '结果: PASS — 审计通过' : '结果: FAIL — 审计未通过（见 errors）')
  return lines.join('\n')
}

/* ---------------------------------------------------------------- main */

async function main() {
  let argv
  let parsed
  try {
    parsed = parseArgv(process.argv.slice(2))
    argv = parsed
  } catch (error) {
    console.error(usage(error.message))
    process.exitCode = EXIT_USAGE
    return
  }
  if (parsed.flags.has('help')) {
    console.log(usage())
    process.exitCode = EXIT_PASS
    return
  }

  const env = process.env
  // 仓库根：显式参数 > 环境变量 > 当前 git 仓库 > 脚本上级目录
  let repoRoot = parsed.values['repo-root'] || env.AUDIT_ROOT || env.REPO_ROOT || null
  if (!repoRoot) {
    const detected = await git(process.cwd(), ['rev-parse', '--show-toplevel'], { allowFail: true })
    repoRoot = detected && String(detected).trim() ? String(detected).trim() : SCRIPT_ROOT
  }
  repoRoot = path.resolve(repoRoot)
  if (!existsSync(repoRoot)) {
    console.error(`错误: 仓库根目录不存在: ${repoRoot}`)
    process.exitCode = EXIT_USAGE
    return
  }

  const trustFile = path.resolve(parsed.values.trusted || env.AUDIT_TRUSTED_SOURCES || path.join(repoRoot, 'trusted-sources.json'))
  const trust = await loadTrustedSources(trustFile, { root: repoRoot })

  const refs = parsed.refs.length > 0
    ? parsed.refs
    : splitList(env.AUDIT_REFS || '').length > 0
      ? splitList(env.AUDIT_REFS)
      : DEFAULT_REFS
  const skipRefs = parsed.flags.has('skip-refs') || parsed.flags.has('offline') || env.AUDIT_SKIP_REFS === '1'
  // §16.1: normal PR submissions treat duplicates as blocking errors; the
  // issue/recheck flow passes --allow-duplicates because it intentionally
  // references content that already exists on another branch.
  const allowDuplicates = parsed.flags.has('allow-duplicates')
    || env.AUDIT_ALLOW_DUPLICATES === '1'
    || env.AUDIT_ALLOW_DUPLICATES === 'true'

  // 正文：--body / --body-file / env
  let body = parsed.values.body
  if (body === undefined && parsed.values['body-file']) {
    try {
      body = await readFile(path.resolve(parsed.values['body-file']), 'utf8')
    } catch (error) {
      console.error(`错误: 无法读取 --body-file: ${error.message}`)
      process.exitCode = EXIT_USAGE
      return
    }
  }
  if (body === undefined) body = env.PR_BODY || env.ISSUE_BODY || env.AUDIT_BODY || ''
  const declaration = parseDeclaration(body)

  const metadata = {
    pr: parsed.values.pr || env.AUDIT_PR || env.PR_NUMBER || null,
    author: parsed.values.author || env.AUDIT_AUTHOR || env.PR_AUTHOR || null,
    baseRef: parsed.values['base-ref'] || env.AUDIT_BASE_REF || null,
    commit: parsed.values.commit || env.AUDIT_COMMIT || env.GITHUB_SHA || null,
    reason: parsed.values.reason || null,
  }
  if (metadata.pr !== null) metadata.pr = Number(metadata.pr)
  if (metadata.author) metadata.author = String(metadata.author).replace(/^@/, '')

  // 实际变更文件：--files / env；若都没有则用正文声明
  let actualFiles = parsed.files.length > 0 ? parsed.files : splitList(env.AUDIT_FILES || '')
  actualFiles = [...new Set(actualFiles.map(normalizeRepoPath).filter(Boolean))]
  const declaredFiles = [...new Set(declaration.files.map(normalizeRepoPath).filter(Boolean))]
  const filesToAudit = actualFiles.length > 0 ? actualFiles : declaredFiles

  const errors = []
  const warnings = []
  const fileReports = []
  if (declaration.errors.length > 0) errors.push(...declaration.errors)
  if (declaration.warnings.length > 0) warnings.push(...declaration.warnings)
  if (!trust.loaded) warnings.push(`trusted-sources.json 不可用（${trust.error}），模型声明跳过了可信源比对`)

  // 声明类型：--type 优先，其次正文；不一致报错
  let declaredType = parsed.values.type || env.AUDIT_TYPE || null
  declaredType = declaredType ? String(declaredType).toLowerCase() : null
  if (declaredType && !TYPES.includes(declaredType)) {
    errors.push(`--type 非法: ${JSON.stringify(declaredType)}（允许 node|workflow）`)
  }
  if (declaredType && declaration.type && declaration.type !== declaredType) {
    errors.push(`--type=${declaredType} 与正文声明 type=${declaration.type} 不一致`)
  }
  if (!declaredType && declaration.type) declaredType = declaration.type
  if (!declaration.type) errors.push('PR/Issue 正文缺少 `type: node|workflow` 声明')
  else if (!TYPES.includes(declaration.type)) errors.push(`正文声明 type 非法: ${JSON.stringify(declaration.type)}（允许 node|workflow）`)

  // 声明字段校验
  if (declaredFiles.length === 0) errors.push('正文缺少 `files:` 声明（1 个节点或工作流 JSON 路径）')
  const declarationFiles = actualFiles.length > 0 ? actualFiles : declaredFiles
  if (declaredFiles.length > 0 && actualFiles.length > 0) {
    const declaredSet = new Set(declaredFiles)
    const actualSet = new Set(actualFiles)
    const missing = declaredFiles.filter((file) => !actualSet.has(file))
    const extra = actualFiles.filter((file) => !declaredSet.has(file))
    if (missing.length > 0 || extra.length > 0) {
      errors.push(`正文声明 files 与本次变更文件不一致（声明: ${declaredFiles.join(', ') || '-'}；变更: ${actualFiles.join(', ') || '-'}${missing.length ? `；声明但未变更: ${missing.join(', ')}` : ''}${extra.length ? `；变更但未声明: ${extra.join(', ')}` : ''}）`)
    }
  }
  if (!declaration.submitter) {
    errors.push('正文缺少 `submitter:` 声明')
  } else if (metadata.author && declaration.submitter.toLowerCase() !== String(metadata.author).toLowerCase()) {
    errors.push(`submitter @${declaration.submitter} 与 PR/Issue 作者 @${metadata.author} 不一致`)
  }
  if (metadata.baseRef && metadata.baseRef !== 'dev') {
    errors.push(`PR 目标分支必须是 dev（当前 ${metadata.baseRef}）；禁止直接向 main 提交`)
  }
  if (metadata.pr !== null && declaration.supersedes !== null && Number(metadata.pr) === declaration.supersedes) {
    errors.push(`supersedes 不能引用当前 PR #${metadata.pr} 自身`)
  }

  // 文件路径与类型匹配
  if (declaredType && TYPES.includes(declaredType)) {
    const pattern = PATH_PATTERN[declaredType]
    if (declarationFiles.length !== 1) {
      errors.push(`${declaredType} 提交必须且只能包含 1 个文件（收到 ${declarationFiles.length} 个：${declarationFiles.join(', ') || '无'}）`)
    }
    for (const file of declarationFiles) {
      if (file.split('/').includes('..') || path.posix.isAbsolute(file)) {
        errors.push(`文件路径非法（不得包含 ".." 或绝对路径）：${file}`)
      } else if (!pattern.test(file)) {
        errors.push(`${declaredType} 提交的文件路径不匹配：${file}（只允许 ${DIR_BY_TYPE[declaredType]}/<id>.json）`)
      }
    }
  }

  // 结构 / 规范校验（复用 validate-core）
  const validator = createValidator({ root: repoRoot, trust })
  const nodeDefs = declaredType === 'workflow' ? await readNodeDefs(repoRoot, warnings) : new Map()
  const refCandidates = [...new Set([...refs, 'dev', 'main', 'bug', 'recheck'])]
  let submitted = null
  const trustModels = []

  const pathOkByFile = new Map()
  if (declaredType && TYPES.includes(declaredType)) {
    for (const file of declarationFiles) {
      const pattern = PATH_PATTERN[declaredType]
      pathOkByFile.set(file, pattern.test(file) && !file.split('/').includes('..') && !path.posix.isAbsolute(file))
    }
  }
  for (const file of declarationFiles) {
    const entry = {
      path: file,
      source: null,
      exists: false,
      pathMatches: pathOkByFile.get(file) === true,
      size: null,
      sha256: null,
      id: null,
      valid: false,
      schemaErrors: [],
      schemaWarnings: [],
      models: [],
    }
    const resolved = await resolveSubmittedFile(repoRoot, file, refCandidates)
    if (!resolved.content) {
      errors.push(resolved.error || `无法读取提交文件: ${file}`)
      fileReports.push(entry)
      continue
    }
    entry.source = resolved.source
    entry.exists = true
    entry.size = resolved.content.length
    entry.sha256 = sha256(resolved.content)
    let parsedJson = null
    try {
      parsedJson = JSON.parse(resolved.content.toString('utf8'))
    } catch (error) {
      errors.push(`${file} 不是合法 JSON: ${error.message}`)
      fileReports.push(entry)
      continue
    }
    entry.id = extractEntityId(parsedJson)

    const errorStart = validator.errors.length
    const warningStart = validator.warnings.length
    const absolute = safeRelative(repoRoot, file) || path.join(repoRoot, file)
    if (entry.pathMatches && declaredType === 'node') validator.checkNodeDef(absolute, parsedJson)
    else if (entry.pathMatches && declaredType === 'workflow') validator.checkWorkflow(absolute, parsedJson, nodeDefs)
    entry.schemaErrors = validator.errors.slice(errorStart)
    entry.schemaWarnings = validator.warnings.slice(warningStart)
    entry.valid = entry.pathMatches && entry.schemaErrors.length === 0
    errors.push(...entry.schemaErrors)
    warnings.push(...entry.schemaWarnings)

    // 模型声明明细（错误/警告已由 schema 校验写入，这里只收集 trust 明细）
    if (isObject(parsedJson) && parsedJson.models !== undefined) {
      const modelResult = auditModels(parsedJson.models, trust, `${file} models`)
      entry.models = modelResult.entries
      for (const modelEntry of modelResult.entries) {
        trustModels.push({ file, ...modelEntry })
      }
    }
    if (entry.pathMatches) submitted = { path: file, sha256: entry.sha256, id: entry.id }
    fileReports.push(entry)
  }

  // 跨分支重复检测
  let duplicates = []
  let refsReport = { mode: 'disabled', checkedRefs: [], missingRefs: [], degraded: false, note: skipRefs ? '已跳过（--skip-refs）' : '未执行（缺少可审计的文件或声明类型）' }
  if (!skipRefs) {
    if (TYPES.includes(declaredType)) {
      const result = await detectDuplicates({ repoRoot, type: declaredType || 'node', submitted, refs, warnings })
      duplicates = result.entries
      refsReport = { mode: result.mode, checkedRefs: result.checkedRefs, missingRefs: result.missingRefs, degraded: result.degraded, note: result.note }
      if (duplicates.length > 0) {
        // main/dev 是待并入的正式分支：重复提交 / 重复内容直接打回；
        // bug/recheck 只是失败与复核留档，不能反过来阻断修正后的重新提交。
        const blockingRefs = ['main', 'dev']
        const blocking = duplicates.filter((entry) => blockingRefs.includes(entry.ref))
        const archived = duplicates.filter((entry) => !blockingRefs.includes(entry.ref))
        if (allowDuplicates) {
          // Issue 复核（recheck）场景：引用内容本来就来自已有分支，重复只提示
          for (const entry of duplicates) warnings.push(`${duplicateDetail(entry)}（仅警告：--allow-duplicates）`)
        } else {
          for (const entry of blocking) errors.push(`跨分支重复（自动审计不通过）：${duplicateDetail(entry)}`)
          for (const entry of archived) warnings.push(`${duplicateDetail(entry)}（留档分支，仅警告）`)
        }
      }
    }
  }

  const report = {
    ok: errors.length === 0,
    auditVersion: AUDIT_VERSION,
    generatedAt: new Date().toISOString(),
    declaredType: declaredType || null,
    declaration: {
      format: declaration.format,
      type: declaration.type,
      files: declaredFiles,
      submitter: declaration.submitter,
      supersedes: declaration.supersedes,
    },
    metadata,
    files: fileReports,
    duplicates,
    refs: refsReport,
    trust: {
      registry: {
        path: trust.loaded ? trust.path : null,
        loaded: trust.loaded,
        version: trust.version,
        updatedAt: trust.updatedAt,
        hosts: trust.hosts,
        error: trust.error,
      },
      models: trustModels,
    },
    errors,
    warnings,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      duplicates: duplicates.length,
      models: trustModels.length,
      files: fileReports.length,
      duplicatesBlocking: !allowDuplicates,
      allowDuplicates,
    },
  }

  const jsonOut = parsed.values['json-out'] || env.AUDIT_JSON_OUT || null
  const mdOut = parsed.values['md-out'] || env.AUDIT_MD_OUT || null
  const jsonToStdout = parsed.flags.has('json') || parsed.flags.has('json-stdout') || jsonOut === '-'
  const reportJson = `${JSON.stringify(report, null, 2)}\n`
  if (jsonOut && jsonOut !== '-') {
    await writeFile(path.resolve(jsonOut), reportJson, 'utf8')
  }
  if (mdOut) {
    await writeFile(path.resolve(mdOut), buildMarkdown(report), 'utf8')
  }
  if (jsonToStdout) process.stdout.write(reportJson)
  else {
    console.log(buildHumanSummary(report))
    if (jsonOut && jsonOut !== '-') console.log(`\nJSON 报告: ${path.resolve(jsonOut)}`)
    if (mdOut) console.log(`Markdown 评论: ${path.resolve(mdOut)}`)
  }
  process.exitCode = report.ok ? EXIT_PASS : EXIT_FAIL
}

main().catch((error) => {
  console.error('审计器内部错误:', error && error.stack ? error.stack : error)
  process.exitCode = EXIT_USAGE
})