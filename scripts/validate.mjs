#!/usr/bin/env node
/* ============================================================================
 * VCG 节点 / 工作流仓库校验器
 * Validator for the VCG node & workflow repository.
 *
 * 零依赖，node scripts/validate.mjs 运行。校验：
 *   - 所有 JSON 可解析，manifest 与目录内容一一对应
 *   - 节点 schema（CONTRACT §1 + §11）、id / 文件名、executor.fn、cloud、ComfyUI map
 *   - 工作流 schema（CONTRACT §2 + §11）：节点 type 存在、端口存在、类型兼容、
 *     必需输入不悬空、单输入单连线、无环、参数默认值 / 覆写值类型正确
 *   - DSH_VCG/nodes 与 DSH_VCG/workflows 与仓库副本字节一致（若插件目录存在）
 *
 * 退出码：0 = 全部通过；1 = 有错误。
 * ==========================================================================*/
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = path.resolve(ROOT, '..', 'DSH_VCG')

const PORT_TYPES = ['model', 'conditioning', 'latent', 'image', 'video', 'text', 'number', 'any']
const PARAM_TYPES = ['text', 'textarea', 'number', 'select', 'toggle', 'model']
const ENGINES = ['cloud', 'local', 'both']
const CAPABILITIES = ['image', 'video', 'text', 'none']
const CATEGORIES = ['input', 'model', 'latent', 'sampling', 'decode', 'video', 'utility', 'custom']
const BUILTIN_FNS = [
  'promptInput', 'modelLoader', 'clipTextEncode', 'emptyLatent', 'imageProps',
  'ksampler', 'vaeDecode', 'imageOutput', 'videoSampler', 'videoOutput',
  'textInput', 'textOutput', 'note',
]
const EXECUTOR_KINDS = ['builtin', 'http', 'comfy']
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
// 参数 id 使用小写 snake_case（如 ckpt_name / batch_size），便于 ${params.x} 模板替换与 ComfyUI 字段命名
const PARAM_ID = /^[a-z][a-z0-9_]*$/
const NODE_ID = /^n[0-9]+$/
const EDGE_ID = /^e[0-9]+$/
const WORKFLOW_ID = /^wf-[a-z0-9]+(-[a-z0-9]+)*$/

const errors = []
const warnings = []
let checks = 0

function fail(message) {
  errors.push(message)
}
function warn(message) {
  warnings.push(message)
}
function check(condition, message) {
  checks += 1
  if (!condition) fail(message)
  return Boolean(condition)
}
function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}
function isString(value) {
  return typeof value === 'string'
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}
function sameSet(a, b) {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== a.length || setB.size !== b.length) return false
  for (const item of setA) if (!setB.has(item)) return false
  return true
}

async function readJson(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    fail(`无法读取 ${file}: ${error.message}`)
    return null
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    fail(`${path.relative(ROOT, file)} 不是合法 JSON: ${error.message}`)
    return null
  }
}

async function listJson(dir) {
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  return names.filter((name) => name.endsWith('.json')).sort()
}

/* --------------------------------------------------------- 节点 schema 校验 */

function checkParam(nodeId, param, index) {
  const where = `节点 ${nodeId} params[${index}]`
  if (!check(isObject(param), `${where} 必须是对象`)) return
  check(isNonEmptyString(param.id) && PARAM_ID.test(param.id), `${where}.id 必须是小写 snake_case`)
  check(isNonEmptyString(param.label), `${where}.label 必须是非空字符串`)
  check(PARAM_TYPES.includes(param.type), `${where}.type 非法: ${JSON.stringify(param.type)}`)
  if (param.type === 'number') {
    check(isNumber(param.default), `${where}.default 必须是数字`)
    for (const key of ['min', 'max', 'step']) {
      if (param[key] !== undefined) check(isNumber(param[key]), `${where}.${key} 必须是数字`)
    }
    if (isNumber(param.default)) {
      if (isNumber(param.min)) check(param.default >= param.min, `${where}.default 小于 min`)
      if (isNumber(param.max)) check(param.default <= param.max, `${where}.default 大于 max`)
    }
  } else if (param.type === 'select') {
    check(Array.isArray(param.options) && param.options.length > 0, `${where}.options 必须是非空数组`)
    if (Array.isArray(param.options)) {
      check(param.options.every(isNonEmptyString), `${where}.options 必须全部是字符串`)
      check(new Set(param.options).size === param.options.length, `${where}.options 有重复项`)
      check(isString(param.default) && param.options.includes(param.default), `${where}.default 必须是 options 中的一个`)
    }
  } else if (param.type === 'toggle') {
    check(typeof param.default === 'boolean', `${where}.default 必须是布尔值`)
  } else {
    check(isString(param.default), `${where}.default 必须是字符串`)
  }
}

function checkPort(nodeId, port, index, direction) {
  const where = `节点 ${nodeId} ${direction}[${index}]`
  if (!check(isObject(port), `${where} 必须是对象`)) return
  check(isNonEmptyString(port.id) && KEBAB.test(port.id), `${where}.id 必须是 kebab-case`)
  check(isNonEmptyString(port.label), `${where}.label 必须是非空字符串`)
  check(PORT_TYPES.includes(port.type), `${where}.type 非法: ${JSON.stringify(port.type)}`)
  if (direction === 'outputs' && port.optional !== undefined) {
    check(false, `${where} 输出端口不允许 optional`)
  }
  if (direction === 'inputs' && port.optional !== undefined) {
    check(port.optional === true, `${where}.optional 只能是 true（未设置即必需）`)
  }
}

function checkComfyMap(nodeId, node) {
  if (node.local === undefined) return null
  const where = `节点 ${nodeId} local`
  if (!check(isObject(node.local), `${where} 必须是对象`)) return null
  const comfy = node.local.comfyui
  if (!check(isObject(comfy), `${where}.comfyui 必须是对象`)) return null
  check(isNonEmptyString(comfy.class_type), `${where}.comfyui.class_type 必须是非空字符串`)
  if (!check(isObject(comfy.map) && Object.keys(comfy.map).length > 0, `${where}.comfyui.map 必须是非空对象`)) return null
  const paramIds = new Set((node.params || []).map((p) => p && p.id))
  const inputIds = new Set((node.inputs || []).map((p) => p && p.id))
  for (const [field, value] of Object.entries(comfy.map)) {
    check(isNonEmptyString(field), `${where}.comfyui.map 的字段名必须是非空字符串`)
    if (isString(value)) {
      const paramRef = /^params\.([a-z0-9_]+)$/.exec(value)
      const inputRef = /^inputs\.([a-z0-9_]+)$/.exec(value)
      if (paramRef) {
        check(paramIds.has(paramRef[1]), `${where}.comfyui.map.${field} 引用了不存在的参数 params.${paramRef[1]}`)
      } else if (inputRef) {
        check(inputIds.has(inputRef[1]), `${where}.comfyui.map.${field} 引用了不存在的输入 inputs.${inputRef[1]}`)
      } else {
        check(false, `${where}.comfyui.map.${field} 取值必须是 params.x / inputs.x / {value}`)
      }
    } else if (isObject(value)) {
      const keys = Object.keys(value)
      check(keys.length === 1 && keys[0] === 'value', `${where}.comfyui.map.${field} 对象只能是 {value: ...}`)
      if (keys.length === 1 && keys[0] === 'value') {
        check(['string', 'number', 'boolean'].includes(typeof value.value), `${where}.comfyui.map.${field}.value 必须是字面量`)
      }
    } else {
      check(false, `${where}.comfyui.map.${field} 取值类型非法`)
    }
  }
  return comfy
}

function checkExecutor(nodeId, node) {
  const where = `节点 ${nodeId}`
  const executor = node.executor
  if (!check(isObject(executor), `${where}.executor 必须是对象`)) return
  check(EXECUTOR_KINDS.includes(executor.kind), `${where}.executor.kind 非法: ${JSON.stringify(executor.kind)}`)
  if (executor.kind === 'builtin') {
    check(BUILTIN_FNS.includes(executor.fn), `${where}.executor.fn 不在 §4 固定列表中: ${JSON.stringify(executor.fn)}`)
  } else if (executor.kind === 'http') {
    const request = executor.request
    if (check(isObject(request), `${where}.executor.request 必须是对象`)) {
      check(isString(request.url) && /^https?:\/\//.test(request.url), `${where}.executor.request.url 必须是 http(s) URL`)
      check(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method), `${where}.executor.request.method 非法`)
      if (request.headers !== undefined) check(isObject(request.headers), `${where}.executor.request.headers 必须是对象`)
      if (request.body !== undefined) check(isObject(request.body) || isString(request.body), `${where}.executor.request.body 必须是对象或字符串`)
      if (request.timeoutMs !== undefined) check(isNumber(request.timeoutMs) && request.timeoutMs > 0, `${where}.executor.request.timeoutMs 必须是正数`)
    }
    check(isObject(executor.response), `${where}.executor.response 必须是对象`)
    const hasApi = isObject(node.cloud) && isNonEmptyString(node.cloud.api)
    const hasApiParam = (node.params || []).some((p) => p && p.id === 'api')
    check(hasApi || hasApiParam, `${where} 自定义 http 节点必须在 cloud.api 或 params 中声明所需 API`)
  }
}

function checkNodeDef(file, node) {
  const where = `节点 ${path.relative(ROOT, file)}`
  if (!check(isObject(node), `${where} 必须是 JSON 对象`)) return null
  const id = node.id
  if (!check(isNonEmptyString(id) && KEBAB.test(id), `${where}.id 必须是 kebab-case`)) return null
  check(path.basename(file) === `${id}.json`, `${where} 文件名必须等于 <id>.json`)
  check(isNonEmptyString(node.name), `${where}.name 必须是非空字符串`)
  check(isNonEmptyString(node.nameZh), `${where}.nameZh 必须是非空字符串`)
  check(CATEGORIES.includes(node.category), `${where}.category 非法: ${JSON.stringify(node.category)}`)
  check(isNumber(node.order), `${where}.order 必须是数字`)
  check(isNonEmptyString(node.description), `${where}.description 必须是非空字符串`)
  check(ENGINES.includes(node.engine), `${where}.engine 非法: ${JSON.stringify(node.engine)}`)
  check(Array.isArray(node.inputs), `${where}.inputs 必须是数组`)
  check(Array.isArray(node.outputs), `${where}.outputs 必须是数组`)
  check(Array.isArray(node.params), `${where}.params 必须是数组`)

  if (Array.isArray(node.inputs)) node.inputs.forEach((port, index) => checkPort(id, port, index, 'inputs'))
  if (Array.isArray(node.outputs)) node.outputs.forEach((port, index) => checkPort(id, port, index, 'outputs'))
  if (Array.isArray(node.params)) node.params.forEach((param, index) => checkParam(id, param, index))

  for (const [listName, list] of [['inputs', node.inputs], ['outputs', node.outputs], ['params', node.params]]) {
    if (!Array.isArray(list)) continue
    const ids = list.map((item) => item && item.id)
    check(new Set(ids).size === ids.length, `${where}.${listName} 存在重复 id`)
  }

  checkExecutor(id, node)

  if (!check(isObject(node.cloud), `${where}.cloud 必须是对象`)) {
    // 继续校验其余字段
  } else {
    check(CAPABILITIES.includes(node.cloud.capability), `${where}.cloud.capability 非法: ${JSON.stringify(node.cloud.capability)}`)
    if (node.cloud.api !== undefined) check(isNonEmptyString(node.cloud.api), `${where}.cloud.api 必须是非空字符串`)
    if (node.cloud.notes !== undefined) check(isString(node.cloud.notes), `${where}.cloud.notes 必须是字符串`)
  }

  checkComfyMap(id, node)

  if (!check(isObject(node.ui), `${where}.ui 必须是对象`)) {
    // 继续
  } else {
    check(isString(node.ui.accent) && /^#[0-9a-fA-F]{6}$/.test(node.ui.accent), `${where}.ui.accent 必须是 #rrggbb`)
    check(isNumber(node.ui.width) && node.ui.width > 0, `${where}.ui.width 必须是正数`)
  }
  return node
}

/* ------------------------------------------------------- 工作流 schema 校验 */

function portCompatible(fromType, toType) {
  if (fromType === toType) return true
  if (fromType === 'any' || toType === 'any') return true
  if (fromType === 'text' && toType === 'conditioning') return true // CONTRACT §11.2
  return false
}

function checkParamValue(where, paramDef, value) {
  if (paramDef.type === 'number') {
    if (!check(isNumber(value), `${where} 必须是数字`)) return
    if (isNumber(paramDef.min)) check(value >= paramDef.min, `${where} 小于 min ${paramDef.min}`)
    if (isNumber(paramDef.max)) check(value <= paramDef.max, `${where} 大于 max ${paramDef.max}`)
  } else if (paramDef.type === 'select') {
    check(isString(value) && Array.isArray(paramDef.options) && paramDef.options.includes(value), `${where} 必须是定义 options 中的一个`)
  } else if (paramDef.type === 'toggle') {
    check(typeof value === 'boolean', `${where} 必须是布尔值`)
  } else {
    check(isString(value), `${where} 必须是字符串`)
  }
}

function detectCycle(instances, edges) {
  const adjacency = new Map(instances.map((item) => [item.id, []]))
  for (const edge of edges) {
    if (!edge || !edge.from || !edge.to) continue
    if (!adjacency.has(edge.from.node) || !adjacency.has(edge.to.node)) continue
    adjacency.get(edge.from.node).push(edge.to.node)
  }
  const state = new Map() // 0 未访问 1 访问中 2 完成
  const stack = []
  function visit(id) {
    state.set(id, 1)
    stack.push(id)
    for (const next of adjacency.get(id) || []) {
      if (state.get(next) === 1) return stack.slice(stack.indexOf(next)).concat(next)
      if (state.get(next) !== 2) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const item of instances) {
    if (state.get(item.id) === 2) continue
    const found = visit(item.id)
    if (found) return found
  }
  return null
}

function checkWorkflow(file, workflow, nodeDefs) {
  const where = `工作流 ${path.relative(ROOT, file)}`
  if (!check(isObject(workflow), `${where} 必须是 JSON 对象`)) return null
  check(workflow.version === 1, `${where}.version 必须是 1`)
  const fileBase = path.basename(file, '.json')
  if (check(isNonEmptyString(workflow.id) && WORKFLOW_ID.test(workflow.id), `${where}.id 必须形如 wf-xxx`)) {
    check(workflow.id === fileBase || workflow.id === `wf-${fileBase}`, `${where} 文件名必须等于 id 或去掉 wf- 前缀的 id`)
  }
  check(isNonEmptyString(workflow.name), `${where}.name 必须是非空字符串`)
  check(isNonEmptyString(workflow.description), `${where}.description 必须是非空字符串`)
  for (const key of ['createdAt', 'updatedAt']) {
    check(isString(workflow[key]) && !Number.isNaN(Date.parse(workflow[key])), `${where}.${key} 必须是 ISO 时间字符串`)
  }
  if (check(isObject(workflow.viewport), `${where}.viewport 必须是对象`)) {
    check(isNumber(workflow.viewport.x), `${where}.viewport.x 必须是数字`)
    check(isNumber(workflow.viewport.y), `${where}.viewport.y 必须是数字`)
    check(isNumber(workflow.viewport.scale) && workflow.viewport.scale > 0, `${where}.viewport.scale 必须是正数`)
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    fail(`${where}.nodes 必须是非空数组`)
    return null
  }
  if (!Array.isArray(workflow.edges)) {
    fail(`${where}.edges 必须是数组`)
    return null
  }

  const instances = new Map()
  for (const instance of workflow.nodes) {
    if (!check(isObject(instance), `${where} 节点实例必须是对象`)) continue
    const at = `${where} 节点实例 ${JSON.stringify(instance.id)}`
    if (!check(isNonEmptyString(instance.id) && NODE_ID.test(instance.id), `${at}.id 必须形如 n1`)) continue
    check(!instances.has(instance.id), `${at}.id 重复`)
    const def = nodeDefs.get(instance.type)
    check(Boolean(def), `${at}.type 引用了不存在的节点定义: ${JSON.stringify(instance.type)}`)
    check(isNumber(instance.x) && isNumber(instance.y), `${at} 的 x/y 必须是数字`)
    if (instance.title !== undefined) check(isString(instance.title), `${at}.title 必须是字符串`)
    if (instance.engineOverride !== undefined) check(['cloud', 'local'].includes(instance.engineOverride), `${at}.engineOverride 必须是 cloud|local`)
    const params = instance.params === undefined ? {} : instance.params
    if (check(isObject(params), `${at}.params 必须是对象`)) {
      if (def && Array.isArray(def.params)) {
        const defs = new Map(def.params.map((param) => [param.id, param]))
        for (const [key, value] of Object.entries(params)) {
          const paramDef = defs.get(key)
          if (check(Boolean(paramDef), `${at}.params 含未声明的参数 ${JSON.stringify(key)}`)) {
            checkParamValue(`${at}.params.${key}`, paramDef, value)
          }
        }
        for (const paramDef of def.params) {
          if (paramDef.default === undefined) fail(`节点定义 ${def.id} 的 params.${paramDef.id} 缺少 default`)
        }
      }
    }
    instances.set(instance.id, { instance, def })
  }

  const occupiedInputs = new Map()
  const edgeIds = new Set()
  for (const edge of workflow.edges) {
    if (!check(isObject(edge), `${where} 连线必须是对象`)) continue
    const at = `${where} 连线 ${JSON.stringify(edge.id)}`
    if (!check(isNonEmptyString(edge.id) && EDGE_ID.test(edge.id), `${at}.id 必须形如 e1`)) continue
    check(!edgeIds.has(edge.id), `${at}.id 重复`)
    edgeIds.add(edge.id)
    if (!check(isObject(edge.from) && isObject(edge.to), `${at} 必须有 from / to`)) continue
    const fromInstance = instances.get(edge.from.node)
    const toInstance = instances.get(edge.to.node)
    if (!check(Boolean(fromInstance), `${at}.from.node 不存在: ${JSON.stringify(edge.from.node)}`)) continue
    if (!check(Boolean(toInstance), `${at}.to.node 不存在: ${JSON.stringify(edge.to.node)}`)) continue
    const fromDef = fromInstance.def
    const toDef = toInstance.def
    if (!fromDef || !toDef) continue
    const fromPort = (fromDef.outputs || []).find((port) => port.id === edge.from.port)
    const toPort = (toDef.inputs || []).find((port) => port.id === edge.to.port)
    if (!check(Boolean(fromPort), `${at}.from.port 不是 ${fromDef.id} 的输出端口: ${JSON.stringify(edge.from.port)}`)) continue
    if (!check(Boolean(toPort), `${at}.to.port 不是 ${toDef.id} 的输入端口: ${JSON.stringify(edge.to.port)}`)) continue
    check(
      portCompatible(fromPort.type, toPort.type),
      `${at} 类型不兼容: ${fromPort.type} → ${toPort.type}`,
    )
    const key = `${edge.to.node}.${edge.to.port}`
    check(!occupiedInputs.has(key), `${at} 目标输入端口 ${key} 已被 ${occupiedInputs.get(key)} 占用`)
    occupiedInputs.set(key, edge.id)
  }

  // 必需输入不得悬空；可选输入允许悬空
  for (const [id, entry] of instances) {
    if (!entry.def) continue
    for (const port of entry.def.inputs || []) {
      if (port.optional === true) continue
      check(occupiedInputs.has(`${id}.${port.id}`), `${where} 节点 ${id} 的必需输入 ${port.id} 没有连线（悬空）`)
    }
  }

  const cycle = detectCycle(workflow.nodes, workflow.edges)
  check(!cycle, `${where} 存在环: ${cycle ? cycle.join(' → ') : ''}`)
  return workflow
}

/* ------------------------------------------------------------- 目录一致性 */

async function compareDirectory(repoDir, pluginDir, label) {
  if (!existsSync(pluginDir)) {
    warn(`${label}: 插件目录不存在，跳过一致性检查（${pluginDir}）`)
    return
  }
  const repoFiles = await listJson(repoDir)
  const pluginFiles = await listJson(pluginDir)
  check(sameSet(repoFiles, pluginFiles), `${label}: 仓库与 DSH_VCG/${label} 文件列表不一致`)
  for (const name of repoFiles) {
    if (!pluginFiles.includes(name)) continue
    const [repoContent, pluginContent] = await Promise.all([
      readFile(path.join(repoDir, name)),
      readFile(path.join(pluginDir, name)),
    ])
    check(repoContent.equals(pluginContent), `${label}/${name}: 仓库副本与 DSH_VCG 内置副本字节不一致`)
  }
}

/* --------------------------------------------------------------------- main */

async function main() {
  const nodesDir = path.join(ROOT, 'nodes')
  const workflowsDir = path.join(ROOT, 'workflows')
  const manifestFile = path.join(ROOT, 'manifest.json')

  const manifest = await readJson(manifestFile)
  if (!manifest) {
    report()
    return
  }
  check(isObject(manifest), 'manifest.json 必须是 JSON 对象')
  check(isNonEmptyString(manifest.version), 'manifest.version 必须是非空字符串')
  check(isNonEmptyString(manifest.minPluginVersion), 'manifest.minPluginVersion 必须是非空字符串')
  check(Array.isArray(manifest.nodes) && manifest.nodes.every(isNonEmptyString), 'manifest.nodes 必须是字符串数组')
  check(Array.isArray(manifest.workflows) && manifest.workflows.every(isNonEmptyString), 'manifest.workflows 必须是字符串数组')

  const nodeFiles = await listJson(nodesDir)
  const nodeDefs = new Map()
  for (const name of nodeFiles) {
    const node = checkNodeDef(path.join(nodesDir, name), await readJson(path.join(nodesDir, name)))
    if (!node) continue
    if (check(!nodeDefs.has(node.id), `节点 id 重复: ${node.id}`)) nodeDefs.set(node.id, node)
  }

  const workflowFiles = await listJson(workflowsDir)
  const workflowIds = new Map()
  for (const name of workflowFiles) {
    const workflow = checkWorkflow(path.join(workflowsDir, name), await readJson(path.join(workflowsDir, name)), nodeDefs)
    if (!workflow) continue
    if (check(!workflowIds.has(workflow.id), `工作流 id 重复: ${workflow.id}`)) workflowIds.set(workflow.id, workflow)
  }

  if (Array.isArray(manifest.nodes)) {
    check(sameSet(manifest.nodes, nodeFiles.map((name) => name.replace(/\.json$/, ''))), 'manifest.nodes 与 nodes/ 目录不一致（缺漏或多出）')
    for (const id of manifest.nodes) check(nodeDefs.has(id), `manifest.nodes 列出了不存在的节点: ${id}`)
  }
  if (Array.isArray(manifest.workflows)) {
    check(sameSet(manifest.workflows, workflowFiles.map((name) => {
      const workflow = workflowIds.get(`wf-${name.replace(/\.json$/, '')}`)
      return workflow ? workflow.id : name.replace(/\.json$/, '')
    })), 'manifest.workflows 与 workflows/ 目录不一致')
    for (const id of manifest.workflows) check(workflowIds.has(id), `manifest.workflows 列出了不存在的工作流: ${id}`)
  }

  // 内置副本一致性（DSH_VCG/nodes、DSH_VCG/workflows 必须与仓库字节一致）
  await compareDirectory(nodesDir, path.join(PLUGIN, 'nodes'), 'nodes')
  await compareDirectory(workflowsDir, path.join(PLUGIN, 'workflows'), 'workflows')

  // 覆盖度自检：必需节点 / 示例工作流
  const requiredNodes = [
    'checkpoint-loader', 'clip-text-encoder', 'empty-latent-image', 'ksampler', 'vae-decode',
    'prompt-input', 'model-loader', 'image-props', 'image-output', 'video-sampler',
    'video-output', 'text-input', 'text-output', 'note', 'example-node',
  ]
  for (const id of requiredNodes) check(nodeDefs.has(id), `缺少必需节点: ${id}`)
  for (const id of ['wf-txt2img', 'wf-txt2video', 'wf-product-shot', 'wf-example']) {
    check(workflowIds.has(id), `缺少必需工作流: ${id}`)
  }

  const stats = {
    nodes: nodeDefs.size,
    workflows: workflowIds.size,
    edges: workflowFiles.length ? (await Promise.all(workflowFiles.map(async (name) => {
      const workflow = await readJson(path.join(workflowsDir, name))
      return Array.isArray(workflow && workflow.edges) ? workflow.edges.length : 0
    }))).reduce((sum, count) => sum + count, 0) : 0,
  }

  report(stats)
}

function report(stats) {
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

main().catch((error) => {
  console.error('校验器内部错误:', error)
  process.exitCode = 1
})
