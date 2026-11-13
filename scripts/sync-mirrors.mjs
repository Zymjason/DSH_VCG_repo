#!/usr/bin/env node
/* ============================================================================
 * VCG 镜像同步器 / Mirror synchronizer（CONTRACT §16.2）
 *
 * 枚举源仓库全部分支与 tag，对比目标仓库：
 *   - 目标缺失（missing）或目标落后（behind：目标 tip 是源 tip 的祖先）→
 *     `git push --force-with-lease`
 *   - 目标领先（target-ahead）或分叉（diverged）→ 跳过并报告（由反方向的同步任务处理，
 *     默认不覆盖目标上多出来的提交；--force-diverged 可强制覆盖分叉）
 *   - 单个分支/tag 失败不阻塞其它项，最后汇总退出码
 *
 * 每日 22:00 Asia/Shanghai（cron `0 14 * * *` UTC）由 GitHub/Gitea Actions 调用：
 *   GitHub → Gitea（secrets.GITEA_TOKEN）
 *   Gitea  → GitHub（secrets.GH_TOKEN）
 *
 * 退出码：0 = 同步完成且无失败；1 = 至少一项失败；2 = 参数/环境错误。
 *
 * 用法：
 *   node scripts/sync-mirrors.mjs --target <url|remote> --json-out sync.json
 *   node scripts/sync-mirrors.mjs --source . --target /tmp/mirror.git --dry-run
 *
 * 说明：--dry-run 不会 push、不会更新分支/tag 引用，但仍会 fetch 到
 * refs/vcg-mirror/* 临时命名空间以判断目标是否真的"落后"。
 * ==========================================================================*/
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SYNC_VERSION = '1.0.0'
const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

const VALUE_FLAGS = new Set(['repo-root', 'source', 'target', 'branches', 'json-out'])
const BOOL_FLAGS = new Set(['tags', 'no-tags', 'dry-run', 'json', 'force-diverged', 'help'])

function usage(message) {
  return [
    message ? `错误: ${message}` : '',
    '',
    '用法: node scripts/sync-mirrors.mjs --target <url|remote> [选项]',
    '',
    '选项:',
    '  --source <url|remote>   源仓库（默认 origin）',
    '  --target <url|remote>   目标仓库（必填；可写 https URL，CI 中带 token）',
    '  --branches <a,b>        只同步指定分支（默认全部分支）',
    '  --no-tags               不同步 tag（默认同步）',
    '  --force-diverged        分叉时也强制覆盖目标（默认跳过，由反向同步处理）',
    '  --dry-run               只报告不 push（仍会 fetch 临时引用）',
    '  --json / --json-out <p> JSON 报告输出（- 为 stdout）',
    '  --repo-root <path>      仓库根目录（默认当前目录 / 脚本上级目录）',
    '  --help                  显示帮助',
    '',
    '退出码: 0 无失败 / 1 至少一项失败 / 2 参数环境错误',
  ].join('\n')
}

function parseArgv(argv) {
  const parsed = { flags: new Set(), values: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`无法识别的参数: ${token}`)
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
    parsed.values[name] = value
  }
  return parsed
}

function splitList(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function sanitizeUrl(value) {
  return String(value || '')
    .replace(/\/\/[^/\s@]+@/g, '//***@')
    .replace(/([?&](?:token|access_token|private_token)=)[^&\s]+/gi, '$1***')
}

function sanitizeText(value, limit = 500) {
  const text = sanitizeUrl(String(value || '').trim())
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

async function git(repoRoot, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch (error) {
    if (allowFail) return null
    throw new Error(sanitizeText(error && error.stderr ? error.stderr : (error && error.message) || 'git 命令失败'))
  }
}

async function gitExitCode(repoRoot, args) {
  try {
    await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return 0
  } catch (error) {
    return typeof error.code === 'number' ? error.code : -1
  }
}

async function resolveRemote(repoRoot, spec) {
  if (!spec) return null
  if (/^[a-z]+:\/\//i.test(spec) || /^[^/@\s]+@[^/\s]+:/.test(spec) || existsSync(spec)) {
    return path.isAbsolute(spec) ? spec : spec
  }
  const remoteUrl = await git(repoRoot, ['remote', 'get-url', spec], { allowFail: true })
  if (remoteUrl && remoteUrl.trim()) return remoteUrl.trim()
  if (existsSync(path.resolve(repoRoot, spec))) return path.resolve(repoRoot, spec)
  return null
}

async function listRemote(repoRoot, url, { tags = false } = {}) {
  const args = tags ? ['ls-remote', '--tags', url] : ['ls-remote', '--heads', url]
  const output = await git(repoRoot, args)
  const refs = new Map()
  for (const line of String(output).split('\n')) {
    const match = /^([0-9a-f]{40,64})\t(.+)$/.exec(line.trim())
    if (!match) continue
    const [, sha, ref] = match
    if (ref.endsWith('^{}')) continue // 跳过 peeled annotated tag 行
    refs.set(ref, sha)
  }
  return refs
}

async function fetchNamespace(repoRoot, url, kind, namespace) {
  const spec = kind === 'heads'
    ? `+refs/heads/*:refs/vcg-mirror/${namespace}/heads/*`
    : `+refs/tags/*:refs/vcg-mirror/${namespace}/tags/*`
  await git(repoRoot, ['fetch', '--force', '--no-tags', url, spec])
}

async function commitExists(repoRoot, sha) {
  const output = await git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })
  return output !== null
}

/**
 * 判断 older 是否为 newer 的祖先（需要两个对象都在本地）。
 * 返回 true / false / null（对象缺失无法判断）。
 */
async function isAncestor(repoRoot, older, newer) {
  if (!(await commitExists(repoRoot, older)) || !(await commitExists(repoRoot, newer))) return null
  const code = await gitExitCode(repoRoot, ['merge-base', '--is-ancestor', older, newer])
  if (code === 0) return true
  if (code === 1) return false
  return null
}

/** 两个 commit 的树是否完全相同（内容一致、仅历史不同）。对象缺失返回 null。 */
async function sameTree(repoRoot, a, b) {
  if (!(await commitExists(repoRoot, a)) || !(await commitExists(repoRoot, b))) return null
  const left = (await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${a}^{tree}`], { allowFail: true }))?.trim()
  const right = (await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${b}^{tree}`], { allowFail: true }))?.trim()
  if (!left || !right) return null
  return left === right
}

async function classify(repoRoot, sourceSha, targetSha, forceDiverged) {
  if (!targetSha) return { action: 'push', reason: 'missing' }
  if (sourceSha === targetSha) return { action: 'up-to-date', reason: 'same' }
  // 内容一致但历史不同（例如一端通过 API 重建提交）：无需镜像，避免误报分叉。
  if ((await sameTree(repoRoot, sourceSha, targetSha)) === true) return { action: 'up-to-date', reason: 'same-tree' }
  const targetBehind = await isAncestor(repoRoot, targetSha, sourceSha)
  if (targetBehind === true) return { action: 'push', reason: 'behind' }
  if (targetBehind === false) {
    const sourceBehind = await isAncestor(repoRoot, sourceSha, targetSha)
    if (sourceBehind === true) return { action: 'skip', reason: 'target-ahead' }
    if (sourceBehind === false) {
      return forceDiverged ? { action: 'push', reason: 'diverged-forced' } : { action: 'skip', reason: 'diverged' }
    }
    return { action: 'skip', reason: 'unknown-ancestry' }
  }
  // 本地没有目标提交（fetch 失败），只能按 sha 不同处理
  return forceDiverged ? { action: 'push', reason: 'sha-differs' } : { action: 'skip', reason: 'sha-differs-no-fetch' }
}

function describeTargetSha(targetSha) {
  return targetSha ? targetSha.slice(0, 10) : '(none)'
}

async function pushRef({ repoRoot, targetUrl, kind, name, sourceSha, targetSha, dryRun, forceDiverged }) {
  const entry = {
    kind,
    name,
    sourceSha,
    targetSha: targetSha || null,
    action: 'skip',
    reason: null,
    pushed: false,
    error: null,
  }
  if (targetSha === sourceSha) {
    entry.action = 'up-to-date'
    entry.reason = 'same'
    return entry
  }
  const verdict = await classify(repoRoot, sourceSha, targetSha, forceDiverged)
  if (dryRun) {
    entry.action = verdict.action === 'push' ? 'would-push' : verdict.action
    entry.reason = verdict.reason
    return entry
  }
  if (verdict.action === 'skip') {
    entry.action = 'skip'
    entry.reason = verdict.reason
    return entry
  }
  const refPath = kind === 'heads' ? `refs/heads/${name}` : `refs/tags/${name}`
  const lease = `--force-with-lease=${refPath}:${targetSha || ''}`
  try {
    await git(repoRoot, ['push', lease, targetUrl, `${sourceSha}:${refPath}`])
    entry.action = 'pushed'
    entry.reason = verdict.reason
    entry.pushed = true
  } catch (error) {
    entry.action = 'failed'
    entry.reason = verdict.reason
    entry.error = sanitizeText(error.message)
  }
  return entry
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
  const forceDiverged = parsed.flags.has('force-diverged')
  const syncTags = !parsed.flags.has('no-tags')
  const branchFilter = splitList(parsed.values.branches)

  let repoRoot = parsed.values['repo-root'] || process.env.AUDIT_ROOT || null
  if (!repoRoot) {
    const detected = await git(process.cwd(), ['rev-parse', '--show-toplevel'], { allowFail: true })
    repoRoot = detected && detected.trim() ? detected.trim() : SCRIPT_ROOT
  }
  repoRoot = path.resolve(repoRoot)
  if (!existsSync(repoRoot)) {
    console.error(`错误: 仓库根目录不存在: ${repoRoot}`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (!existsSync(path.join(repoRoot, '.git'))) {
    console.error(`错误: ${repoRoot} 不是 git 仓库`)
    process.exitCode = EXIT_USAGE
    return
  }

  const sourceSpec = parsed.values.source || 'origin'
  const targetSpec = parsed.values.target
  if (!targetSpec) {
    console.error(usage('缺少 --target'))
    process.exitCode = EXIT_USAGE
    return
  }
  const sourceUrl = await resolveRemote(repoRoot, sourceSpec)
  const targetUrl = await resolveRemote(repoRoot, targetSpec)
  if (!sourceUrl) {
    console.error(`错误: 无法解析源仓库 ${sourceSpec}（既不是 URL / 本地路径，也不是已配置的 remote）`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (!targetUrl) {
    console.error(`错误: 无法解析目标仓库 ${targetSpec}`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (sourceUrl === targetUrl) {
    console.error('错误: 源仓库与目标仓库相同，拒绝空同步')
    process.exitCode = EXIT_USAGE
    return
  }

  const errors = []
  const warnings = []
  const report = {
    ok: false,
    syncVersion: SYNC_VERSION,
    generatedAt: new Date().toISOString(),
    dryRun,
    forceDiverged,
    source: sanitizeUrl(sourceUrl),
    target: sanitizeUrl(targetUrl),
    branches: [],
    tags: [],
    errors,
    warnings,
    summary: {
      branches: { pushed: 0, upToDate: 0, skipped: 0, failed: 0 },
      tags: { pushed: 0, upToDate: 0, skipped: 0, failed: 0 },
    },
  }

  // 1) 枚举两端 refs
  let sourceHeads
  let sourceTags = new Map()
  let targetHeads
  let targetTags = new Map()
  try {
    sourceHeads = await listRemote(repoRoot, sourceUrl)
  } catch (error) {
    errors.push(`读取源仓库分支失败: ${sanitizeText(error.message)}`)
  }
  if (sourceHeads && syncTags) {
    try {
      sourceTags = await listRemote(repoRoot, sourceUrl, { tags: true })
    } catch (error) {
      warnings.push(`读取源仓库 tag 失败: ${sanitizeText(error.message)}`)
    }
  }
  try {
    targetHeads = await listRemote(repoRoot, targetUrl)
  } catch (error) {
    errors.push(`读取目标仓库分支失败: ${sanitizeText(error.message)}`)
  }
  if (targetHeads && syncTags) {
    try {
      targetTags = await listRemote(repoRoot, targetUrl, { tags: true })
    } catch (error) {
      warnings.push(`读取目标仓库 tag 失败: ${sanitizeText(error.message)}`)
    }
  }
  if (errors.length > 0) {
    // 无法读取 refs 时直接失败（通常 token/网络问题）
    report.summary.failed = 1
    await finish(report, parsed)
    return
  }

  // 2) fetch 到临时命名空间（push 需要本地对象；判断落后也需要目标提交）
  let sourceObjectsReady = false
  let targetObjectsReady = false
  try {
    await fetchNamespace(repoRoot, sourceUrl, 'heads', 'src')
    if (syncTags) await fetchNamespace(repoRoot, sourceUrl, 'tags', 'src')
    sourceObjectsReady = true
  } catch (error) {
    errors.push(`fetch 源仓库失败（无法 push 缺失分支）: ${sanitizeText(error.message)}`)
  }
  try {
    await fetchNamespace(repoRoot, targetUrl, 'heads', 'dst')
    if (syncTags) await fetchNamespace(repoRoot, targetUrl, 'tags', 'dst')
    targetObjectsReady = true
  } catch (error) {
    warnings.push(`fetch 目标仓库失败（无法判断 ahead/behind，只按 sha 比较）: ${sanitizeText(error.message)}`)
  }
  if (!targetObjectsReady) {
    // 目标对象缺失时降级为 sha 比较：无法证明"落后"时保守跳过，避免覆盖目标上多出的提交
    warnings.push('目标仓库对象未 fetch 成功，ancestry 判定降级为 sha 比较（分叉/领先的分支将跳过）')
  }

  // 3) 分支
  const headEntries = [...(sourceHeads || new Map())].map(([ref, sha]) => [ref.replace(/^refs\/heads\//, ''), sha])
  const headMap = new Map(headEntries)
  const filterSet = new Set(branchFilter)
  for (const [name, sourceSha] of headMap) {
    if (filterSet.size > 0 && !filterSet.has(name)) continue
    const targetRef = `refs/heads/${name}`
    const targetSha = targetHeads.get(targetRef) || null
    const entry = await pushRef({ repoRoot, targetUrl, kind: 'heads', name, sourceSha, targetSha, dryRun, forceDiverged })
    if (sourceObjectsReady === false && entry.action !== 'skip' && entry.action !== 'up-to-date') {
      entry.action = 'failed'
      entry.error = entry.error || '源仓库对象未准备好，无法 push'
    }
    report.branches.push(entry)
    tally(report.summary.branches, entry)
  }
  for (const name of branchFilter) {
    if (!headMap.has(name)) {
      report.branches.push({ kind: 'heads', name, sourceSha: null, targetSha: null, action: 'missing-source', reason: null, pushed: false, error: null })
      report.summary.branches.skipped += 1
    }
  }

  // 4) tags
  if (syncTags) {
    const tagEntries = [...(sourceTags || new Map())].map(([ref, sha]) => [ref.replace(/^refs\/tags\//, ''), sha])
    for (const [name, sourceSha] of tagEntries) {
      const targetRef = `refs/tags/${name}`
      const targetSha = targetTags.get(targetRef) || null
      const entry = await pushRef({ repoRoot, targetUrl, kind: 'tags', name, sourceSha, targetSha, dryRun, forceDiverged })
      if (sourceObjectsReady === false && entry.action !== 'skip' && entry.action !== 'up-to-date') {
        entry.action = 'failed'
        entry.error = entry.error || '源仓库对象未准备好，无法 push'
      }
      report.tags.push(entry)
      tally(report.summary.tags, entry)
    }
  }

  const failed = report.summary.branches.failed + report.summary.tags.failed + errors.length
  report.ok = failed === 0
  await finish(report, parsed)
}

function tally(summary, entry) {
  if (entry.action === 'pushed' || entry.action === 'would-push') summary.pushed += 1
  else if (entry.action === 'up-to-date') summary.upToDate += 1
  else if (entry.action === 'failed') summary.failed += 1
  else summary.skipped += 1
}

async function finish(report, parsed) {
  const jsonOut = parsed.values['json-out'] || null
  const jsonStdout = parsed.flags.has('json') || jsonOut === '-'
  const reportJson = `${JSON.stringify(report, null, 2)}\n`
  if (jsonOut && jsonOut !== '-') await writeFile(path.resolve(jsonOut), reportJson, 'utf8')
  if (jsonStdout) process.stdout.write(reportJson)

  const printf = (label, entry) => {
    const targetSha = describeTargetSha(entry.targetSha)
    const action = String(entry.action || '').toUpperCase()
    console.log(`  [${action}] ${label}/${entry.name}  src ${entry.sourceSha ? entry.sourceSha.slice(0, 10) : '-'}  dst ${targetSha}${entry.reason ? `  (${entry.reason})` : ''}`)
    if (entry.error) console.log(`        ✗ ${entry.error}`)
  }
  console.log(`VCG 镜像同步 / Mirror sync${report.dryRun ? '（dry-run）' : ''}`)
  console.log('='.repeat(46))
  console.log(`  源 source:   ${report.source}`)
  console.log(`  目标 target: ${report.target}`)
  for (const entry of report.branches) printf('heads', entry)
  for (const entry of report.tags) printf('tags', entry)
  for (const message of report.errors) console.log(`  ✗ ${message}`)
  for (const message of report.warnings) console.log(`  ! ${message}`)
  const { branches, tags } = report.summary
  console.log('')
  console.log(`  分支 branches: push ${branches.pushed} / 已同步 ${branches.upToDate} / 跳过 ${branches.skipped} / 失败 ${branches.failed}`)
  console.log(`  tag    tags:   push ${tags.pushed} / 已同步 ${tags.upToDate} / 跳过 ${tags.skipped} / 失败 ${tags.failed}`)
  console.log('')
  console.log(report.ok ? '结果: PASS' : '结果: FAIL')
  if (jsonOut && jsonOut !== '-') console.log(`JSON 报告: ${path.resolve(jsonOut)}`)
  process.exitCode = report.ok ? EXIT_PASS : EXIT_FAIL
}

main().catch((error) => {
  console.error('同步器内部错误:', error && error.stack ? error.stack : error)
  process.exitCode = EXIT_USAGE
})