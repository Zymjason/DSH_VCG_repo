#!/usr/bin/env node
/* ============================================================================
 * VCG 分支路由器 / Branch router（CONTRACT §16.1）
 *
 * 把审计结果对应的节点/工作流文件复制并提交到治理分支：
 *   - bug     审计不通过 / 人工 status:rejected
 *   - recheck Issue 复核（recheck:pending）
 *   - dev     已提交未审核（人工补录 / 从 bug 恢复）
 *
 * 实现：git 底层命令（hash-object / read-tree / update-index / write-tree /
 * commit-tree），不切换工作区、不产生脏文件；单个目标分支失败不阻塞其它分支。
 * 默认会 push 到 --remote（CI 使用）；本地测试用 --no-push 或 --dry-run。
 *
 * 退出码：0 = 全部目标成功；1 = 至少一个目标失败；2 = 参数/环境错误。
 *
 * 用法：
 *   node scripts/route-branch.mjs --target bug --files nodes/bad.json \
 *     --reason "audit failed: 3 errors" --json-out route.json
 *   node scripts/route-branch.mjs --target bug,recheck --files nodes/a.json --dry-run
 * ==========================================================================*/
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, stat, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROUTE_VERSION = '1.0.0'
const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

const ALLOWED_TARGETS = ['bug', 'recheck', 'dev']
const SOURCE_REF_CANDIDATES = ['dev', 'main', 'bug', 'recheck']

const VALUE_FLAGS = new Set([
  'target', 'files', 'ref', 'repo-root', 'remote', 'base', 'message', 'reason',
  'author-name', 'author-email', 'json-out',
])
const BOOL_FLAGS = new Set(['dry-run', 'no-push', 'allow-any-path', 'help'])

function usage(message) {
  return [
    message ? `错误: ${message}` : '',
    '',
    '用法: node scripts/route-branch.mjs --target <bug|recheck|dev> --files <path...> [选项]',
    '',
    '选项:',
    '  --target <bug,recheck,dev> 目标分支（可逗号分隔多个）',
    '  --files <a,b>             要复制的文件（可重复）',
    '  --ref <auto|ref>          文件内容来源（默认 auto：工作区优先，其次 dev/main/bug/recheck）',
    '  --repo-root <path>        仓库根目录',
    '  --remote <name>           push 目标远端（默认 origin）',
    '  --base <ref>              目标分支不存在时从该分支创建（默认 main）',
    '  --message <text>          提交标题（默认自动生成）',
    '  --reason <text>           写入提交正文的原因（如审计错误摘要）',
    '  --author-name / --author-email  覆盖提交者身份',
    '  --dry-run                 只校验并输出计划，不写对象/引用，不 push',
    '  --no-push                 提交到本地分支但不 push（本地测试）',
    '  --allow-any-path          允许 nodes/workflows 之外的路径（默认拒绝）',
    '  --json-out <path>         JSON 报告输出路径',
    '  --help                    显示帮助',
    '',
    '退出码: 0 全部成功 / 1 至少一个目标失败 / 2 参数环境错误',
  ].join('\n')
}

function parseArgv(argv) {
  const parsed = { files: [], targets: [], flags: new Set(), values: {} }
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
    if (name === 'target') parsed.targets.push(...splitList(value))
    else if (name === 'files') parsed.files.push(...splitList(value))
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
  let value = String(raw || '').trim().replace(/^[`'"\s]+|[`'"\s]+$/g, '').replace(/\\/g, '/')
  while (value.startsWith('./')) value = value.slice(2)
  return value
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function sanitizeText(value, limit = 500) {
  const text = String(value || '')
    .replace(/\/\/[^/\s@]+@/g, '//***@')
    .trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

async function run(cwd, file, args, { env, input } = {}) {
  if (input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout = []
      const stderr = []
      child.stdout.on('data', (chunk) => stdout.push(chunk))
      child.stderr.on('data', (chunk) => stderr.push(chunk))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
        else reject(new Error(sanitizeText(Buffer.concat(stderr).toString('utf8') || `${file} 退出码 ${code}`)))
      })
      child.stdin.end(input)
    })
  }
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch (error) {
    throw new Error(sanitizeText(error && error.stderr ? error.stderr : (error && error.message) || 'git 命令失败'))
  }
}

const git = (cwd, args, options) => run(cwd, 'git', args, options)

async function gitAllowFail(cwd, args, options) {
  try {
    return await git(cwd, args, options)
  } catch {
    return null
  }
}

async function resolveCommit(cwd, ref) {
  // CI 里只 fetch 出 origin/*（没有本地分支），因此按本地 → origin → refs/remotes 依次解析。
  const candidates = [ref, `origin/${ref}`, `refs/remotes/origin/${ref}`]
  for (const candidate of candidates) {
    if (String(candidate).startsWith('refs/heads/')) continue
    const output = await gitAllowFail(cwd, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`])
    if (output && output.trim()) return output.trim()
  }
  return null
}

async function readFromWorktree(repoRoot, file) {
  const absolute = path.resolve(repoRoot, file)
  const relative = path.relative(repoRoot, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  if (!existsSync(absolute)) return null
  const info = await stat(absolute)
  if (!info.isFile()) return null
  return readFile(absolute)
}

async function readFromRef(repoRoot, ref, file) {
  const content = await gitAllowFail(repoRoot, ['show', `${ref}:${file}`])
  return content === null ? null : Buffer.from(content, 'utf8')
}

async function resolveContent(repoRoot, file, refMode) {
  if (refMode && refMode !== 'auto') {
    const content = await readFromRef(repoRoot, refMode, file)
    if (content === null) return { content: null, source: null, error: `无法从 ${refMode}:${file} 读取内容` }
    return { content, source: `ref:${refMode}`, error: null }
  }
  const worktree = await readFromWorktree(repoRoot, file)
  if (worktree) return { content: worktree, source: 'worktree', error: null }
  for (const ref of SOURCE_REF_CANDIDATES) {
    const sha = await resolveCommit(repoRoot, ref)
    if (!sha) continue
    const content = await readFromRef(repoRoot, ref, file)
    if (content !== null && content.length > 0) return { content, source: `ref:${ref}`, error: null }
  }
  return { content: null, source: null, error: `文件不存在: ${file}（工作区与 ${SOURCE_REF_CANDIDATES.join('/')} 均未找到）` }
}

async function commitToBranch({ repoRoot, target, baseCommit, isNewBranch, files, message, reason, dryRun, noPush, remote, author }) {
  const result = {
    target,
    baseSha: baseCommit,
    commit: null,
    pushed: false,
    dryRun,
    files: [],
    errors: [],
    warnings: [],
  }
  const env = {}
  if (author.name) {
    env.GIT_AUTHOR_NAME = author.name
    env.GIT_COMMITTER_NAME = author.name
  }
  if (author.email) {
    env.GIT_AUTHOR_EMAIL = author.email
    env.GIT_COMMITTER_EMAIL = author.email
  }

  if (dryRun) {
    // 只做内容哈希（不写对象），输出将要提交的计划
    for (const file of files) {
      const { content, ...rest } = file
      const blob = (await run(repoRoot, 'git', ['hash-object', '--stdin'], { input: content })).trim()
      result.files.push({ ...rest, blob })
    }
    result.plan = {
      base: isNewBranch ? '(新建分支)' : baseCommit,
      files: files.map((file) => file.path),
      message,
      push: !noPush ? `${remote} refs/heads/${target}` : '(skipped)',
    }
    return result
  }

  const indexFile = path.join(os.tmpdir(), `vcg-route-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const indexEnv = { ...env, GIT_INDEX_FILE: indexFile }
  try {
    await git(repoRoot, ['read-tree', baseCommit], { env: indexEnv })
    for (const file of files) {
      const blob = (await run(repoRoot, 'git', ['hash-object', '-w', '--stdin'], { input: file.content, env })).trim()
      await git(repoRoot, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`], { env: indexEnv })
      result.files.push({ ...file, blob })
    }
    const tree = (await git(repoRoot, ['write-tree'], { env: indexEnv })).trim()
    const messageArgs = ['-m', message]
    if (reason) messageArgs.push('-m', String(reason))
    const commit = (await git(repoRoot, ['commit-tree', tree, '-p', baseCommit, ...messageArgs], { env: indexEnv })).trim()
    result.commit = commit
    result.tree = tree

    if (noPush) {
      if (isNewBranch) await git(repoRoot, ['update-ref', `refs/heads/${target}`, commit])
      else await git(repoRoot, ['update-ref', `refs/heads/${target}`, commit, baseCommit])
      result.warnings.push('--no-push：仅写入本地分支，未推送到远端')
      return result
    }

    const lease = isNewBranch ? `--force-with-lease=refs/heads/${target}:` : `--force-with-lease=refs/heads/${target}:${baseCommit}`
    try {
      await git(repoRoot, ['push', lease, remote, `${commit}:refs/heads/${target}`], { env })
      result.pushed = true
      if (isNewBranch) await git(repoRoot, ['update-ref', `refs/heads/${target}`, commit])
      else await git(repoRoot, ['update-ref', `refs/heads/${target}`, commit, baseCommit])
    } catch (error) {
      result.errors.push(`push 到 ${remote} ${target} 失败: ${sanitizeText(error.message)}`)
    }
  } catch (error) {
    result.errors.push(`在 ${target} 上创建提交失败: ${sanitizeText(error.message)}`)
  } finally {
    await rm(indexFile, { force: true })
  }
  return result
}

async function main() {
  let parsed
  try {
    parsed = parseArgv(process.argv.slice(2))
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
  const dryRun = parsed.flags.has('dry-run')
  const noPush = parsed.flags.has('no-push')
  const allowAnyPath = parsed.flags.has('allow-any-path')

  let repoRoot = parsed.values['repo-root'] || process.env.AUDIT_ROOT || null
  if (!repoRoot) {
    const detected = await gitAllowFail(process.cwd(), ['rev-parse', '--show-toplevel'])
    repoRoot = detected && detected.trim() ? detected.trim() : SCRIPT_ROOT
  }
  repoRoot = path.resolve(repoRoot)
  if (!existsSync(repoRoot)) {
    console.error(`错误: 仓库根目录不存在: ${repoRoot}`)
    process.exitCode = EXIT_USAGE
    return
  }

  const targets = [...new Set(parsed.targets)]
  const files = [...new Set(parsed.files.map(normalizeRepoPath).filter(Boolean))]
  const errors = []
  const warnings = []
  if (targets.length === 0) errors.push('缺少 --target（bug|recheck|dev）')
  for (const target of targets) {
    if (!ALLOWED_TARGETS.includes(target)) errors.push(`--target 非法: ${target}（允许 ${ALLOWED_TARGETS.join('|')}；main 只能通过 status:approved 合并）`)
  }
  if (files.length === 0) errors.push('缺少 --files')
  for (const file of files) {
    const parts = file.split('/')
    if (file.startsWith('/') || parts.includes('..') || parts.includes('')) errors.push(`文件路径非法：${file}`)
    else if (!allowAnyPath && !/^(nodes|workflows)\/[A-Za-z0-9._-]+\.json$/.test(file)) {
      errors.push(`默认只允许 nodes/*.json 与 workflows/*.json：${file}（如确需其它文件请加 --allow-any-path）`)
    }
  }
  if (errors.length > 0) {
    console.error(errors.map((error) => `错误: ${error}`).join('\n'))
    process.exitCode = EXIT_USAGE
    return
  }

  const remote = parsed.values.remote || 'origin'
  const baseRef = parsed.values.base || 'main'
  const refMode = parsed.values.ref || 'auto'
  const author = {
    name: parsed.values['author-name'] || '',
    email: parsed.values['author-email'] || '',
  }

  // 读取内容（一次），失败则不进入路由
  const filePayloads = []
  for (const file of files) {
    const resolved = await resolveContent(repoRoot, file, refMode)
    if (!resolved.content) {
      errors.push(resolved.error || `无法读取文件: ${file}`)
      continue
    }
    let validJson = true
    try {
      JSON.parse(resolved.content.toString('utf8'))
    } catch {
      validJson = false
      if (!allowAnyPath) errors.push(`${file} 不是合法 JSON，拒绝路由到 ${targets.join('/')}`)
    }
    filePayloads.push({
      path: file,
      content: resolved.content,
      source: resolved.source,
      size: resolved.content.length,
      sha256: sha256(resolved.content),
      validJson,
    })
  }
  if (errors.length > 0) {
    console.error(errors.map((error) => `错误: ${error}`).join('\n'))
    process.exitCode = EXIT_FAIL
    return
  }

  const results = []
  for (const target of targets) {
    const targetCommit = await resolveCommit(repoRoot, target)
    const baseCommit = targetCommit || await resolveCommit(repoRoot, baseRef)
    const isNewBranch = !targetCommit
    if (!baseCommit) {
      results.push({ target, baseSha: null, commit: null, pushed: false, dryRun, files: [], errors: [`目标分支 ${target} 与基准分支 ${baseRef} 都不存在，无法创建提交`], warnings: [] })
      continue
    }
    // 已检出的目标分支不能直接 update-ref（工作区会与索引不一致）
    const currentBranch = (await gitAllowFail(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim()
    if (currentBranch === target) {
      results.push({ target, baseSha: baseCommit, commit: null, pushed: false, dryRun, files: [], errors: [`目标分支 ${target} 当前已检出，拒绝通过底层命令改写；请改用 git 正常提交流程`], warnings: [] })
      continue
    }
    const defaultMessage = `chore(repo): route ${files.join(', ')} to ${target}`
    const message = parsed.values.message || defaultMessage
    const reason = parsed.values.reason || ''
    const result = await commitToBranch({
      repoRoot,
      target,
      baseCommit,
      isNewBranch,
      files: filePayloads,
      message,
      reason,
      dryRun,
      noPush,
      remote,
      author,
    })
    results.push(result)
  }

  const failed = results.filter((result) => result.errors && result.errors.length > 0)
  const report = {
    ok: failed.length === 0 && errors.length === 0,
    routeVersion: ROUTE_VERSION,
    generatedAt: new Date().toISOString(),
    dryRun,
    noPush,
    remote,
    files: filePayloads.map(({ content, ...rest }) => ({ ...rest, contentBytes: content.length })),
    results,
    errors,
    warnings,
  }

  const jsonOut = parsed.values['json-out'] || process.env.AUDIT_JSON_OUT || null
  const reportJson = `${JSON.stringify(report, null, 2)}\n`
  if (jsonOut && jsonOut !== '-') await writeFile(path.resolve(jsonOut), reportJson, 'utf8')
  if (jsonOut === '-' || process.env.AUDIT_JSON_STDOUT === '1') process.stdout.write(reportJson)

  console.log(`VCG 分支路由 / Branch routing${dryRun ? '（dry-run）' : ''}`)
  console.log('='.repeat(40))
  for (const result of results) {
    const state = result.errors.length > 0 ? 'FAIL' : dryRun ? 'PLAN' : result.pushed ? 'PUSHED' : 'COMMITTED'
    console.log(`  [${state}] ${result.target} <- ${result.baseSha ? result.baseSha.slice(0, 10) : '-'}${result.commit ? ` (new commit ${result.commit.slice(0, 10)})` : ''}`)
    for (const file of result.files || []) console.log(`      ${file.path} (${file.size} B, sha256 ${file.sha256 ? file.sha256.slice(0, 16) : '-'}…)`)
    for (const message of result.errors || []) console.log(`      ✗ ${message}`)
    for (const message of result.warnings || []) console.log(`      ! ${message}`)
  }
  for (const message of errors) console.log(`  ✗ ${message}`)
  console.log('')
  console.log(report.ok ? '结果: PASS' : '结果: FAIL')
  process.exitCode = report.ok ? EXIT_PASS : EXIT_FAIL
}

main().catch((error) => {
  console.error('路由内部错误:', error && error.stack ? error.stack : error)
  process.exitCode = EXIT_USAGE
})