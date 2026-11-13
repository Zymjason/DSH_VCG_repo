#!/usr/bin/env node
/* ============================================================================
 * VCG 节点 / 工作流仓库校验器
 * Validator for the VCG node & workflow repository.
 *
 * 零依赖，node scripts/validate.mjs 运行。校验逻辑已抽取到
 * scripts/lib/validate-core.mjs，供 scripts/audit-submission.mjs 复用同一套规则。
 * 校验：
 *   - 所有 JSON 可解析，manifest 与目录内容一一对应
 *   - 节点 schema（CONTRACT §1 + §11 + §16.3 models）：id / 文件名、executor.fn、
 *     cloud、ComfyUI map、可选 models[] 模型声明
 *   - 工作流 schema（CONTRACT §2 + §11 + §16.3）：节点 type 存在、端口存在、类型兼容、
 *     必需输入不悬空、单输入单连线、无环、参数默认值 / 覆写值类型正确、可选 models[]
 *   - trusted-sources.json 可信模型源清单（存在性 / 结构）
 *   - DSH_VCG/nodes 与 DSH_VCG/workflows 与仓库副本字节一致（若插件目录存在）
 *
 * 退出码：0 = 全部通过；1 = 有错误。
 * ==========================================================================*/
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRepository } from './lib/validate-core.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.resolve(ROOT, '..', 'DSH_VCG')

function report({ stats, checks, warnings, errors }) {
  const lines = []
  lines.push('VCG 节点仓库校验 / Node repository validation')
  lines.push('='.repeat(58))
  if (stats) {
    lines.push(`  节点定义 nodes/*.json      ${stats.nodes} 个`)
    lines.push(`  工作流   workflows/*.json ${stats.workflows} 个（连线 ${stats.edges} 条）`)
  }
  lines.push(`  检查项 assertions         ${checks}`)
  if (warnings.length > 0) {
    lines.push('')
    lines.push(`警告 (${warnings.length}):`)
    for (const message of warnings) lines.push(`  ! ${message}`)
  }
  if (errors.length > 0) {
    lines.push('')
    lines.push(`错误 (${errors.length}):`)
    for (const message of errors) lines.push(`  ✗ ${message}`)
    lines.push('')
    lines.push('结果: FAIL')
    console.log(lines.join('\n'))
    process.exitCode = 1
    return
  }
  lines.push('')
  lines.push('结果: PASS — 所有节点 / 工作流 JSON 合法且互相一致')
  console.log(lines.join('\n'))
  process.exitCode = 0
}

async function main() {
  const result = await validateRepository({ root: ROOT, pluginRoot: PLUGIN })
  report(result)
}

main().catch((error) => {
  console.error('校验器内部错误:', error)
  process.exitCode = 1
})