#!/usr/bin/env node
/* ============================================================================
 * 更新 manifest.json / Sync manifest with nodes/ and workflows/ directories.
 *
 * 由 CI 在审计通过后自动执行：把新提交的节点/工作流 id 登记进清单，
 * 并按原顺序保留已有条目（新增条目按 order / id 追加），避免手动改 manifest。
 *
 * 用法：
 *   node scripts/update-manifest.mjs [--repo-root DIR] [--check] [--version X.Y.Z]
 *   --check   只检查是否需要更新（需要更新时退出码 1，不写文件）
 *   --version 指定新版号（默认需要变更时 patch +1）
 * ==========================================================================*/
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DEFAULT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  const values = {}
  const flags = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    if (key === 'check' || key === 'help') {
      flags.add(key)
      continue
    }
    values[key] = argv[i + 1]
    i += 1
  }
  return { values, flags }
}

function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''))
  if (!m) return '1.0.1'
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

async function listJsonIds(dir) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const ids = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const fallback = name.slice(0, -'.json'.length)
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
      ids.push(typeof parsed.id === 'string' && parsed.id ? parsed.id : fallback)
    } catch {
      ids.push(fallback)
    }
  }
  return ids.sort()
}

async function nodeOrder(root, id) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, 'nodes', `${id}.json`), 'utf8'))
    return Number.isFinite(Number(parsed.order)) ? Number(parsed.order) : 9999
  } catch {
    return 9999
  }
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2))
  if (flags.has('help')) {
    console.log('用法: node scripts/update-manifest.mjs [--repo-root DIR] [--check] [--version X.Y.Z]')
    return
  }
  const root = path.resolve(values['repo-root'] || ROOT_DEFAULT)
  const manifestPath = path.join(root, 'manifest.json')
  let manifest = { version: '1.0.0', nodes: [], workflows: [], minPluginVersion: '1.0.0' }
  let raw = ''
  try {
    raw = await readFile(manifestPath, 'utf8')
    manifest = JSON.parse(raw)
  } catch (error) {
    console.error(`警告: 无法读取 manifest.json（${error.message}），将重新生成`)
  }
  const fileNodes = await listJsonIds(path.join(root, 'nodes'))
  const fileWorkflows = await listJsonIds(path.join(root, 'workflows'))
  const existingNodes = Array.isArray(manifest.nodes) ? manifest.nodes.map(String) : []
  const existingWorkflows = Array.isArray(manifest.workflows) ? manifest.workflows.map(String) : []
  const missingNodes = fileNodes.filter((id) => !existingNodes.includes(id))
  missingNodes.sort(async () => 0)
  const withOrder = []
  for (const id of missingNodes) withOrder.push({ id, order: await nodeOrder(root, id) })
  withOrder.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const nodes = [...existingNodes.filter((id) => fileNodes.includes(id)), ...withOrder.map((item) => item.id)]
  const workflows = [...existingWorkflows.filter((id) => fileWorkflows.includes(id)), ...fileWorkflows.filter((id) => !existingWorkflows.includes(id))]
  const next = {
    version: typeof values.version === 'string' && values.version ? values.version : manifest.version,
    nodes,
    workflows,
    minPluginVersion: manifest.minPluginVersion ?? '1.0.0',
  }
  const changed = JSON.stringify(next) !== JSON.stringify({ version: manifest.version, nodes: existingNodes, workflows: existingWorkflows, minPluginVersion: manifest.minPluginVersion })
  if (!changed) {
    console.log('manifest.json 已是最新，无需更新')
    return
  }
  if (flags.has('check')) {
    console.error('manifest.json 需要更新（缺少条目或顺序变化）')
    process.exitCode = 1
    return
  }
  if (!(typeof values.version === 'string' && values.version)) next.version = bumpPatch(manifest.version)
  const text = `${JSON.stringify(next, null, 2)}\n`
  await writeFile(manifestPath, text, 'utf8')
  const addedNodes = nodes.filter((id) => !existingNodes.includes(id))
  const addedWorkflows = workflows.filter((id) => !existingWorkflows.includes(id))
  const summary = [...addedNodes.map((id) => `node:${id}`), ...addedWorkflows.map((id) => `workflow:${id}`)].join(', ')
  console.log(`已更新 manifest.json → v${next.version}（新增/登记: ${summary || '无新增，仅清理条目'}）`)
}

await main()
