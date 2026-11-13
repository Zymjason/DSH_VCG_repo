/* ============================================================================
 * VCG 节点 / 工作流仓库校验核心
 * Shared validation core for scripts/validate.mjs and scripts/audit-submission.mjs.
 *
 * 零依赖。本文件只导出纯逻辑，不打印、不设置退出码：
 *   - createValidator({ root, trust }) 创建带错误/警告收集器的校验上下文
 *   - ctx.checkNodeDef(file, json) / ctx.checkWorkflow(file, json, nodeDefs)
 *   - auditModels(models, trust, where) 校验 CONTRACT §16.3 / docs/*-spec §12 的
 *     `models[]` 声明（不可信 host / 缺 sha256 / 非 https 仅 warning）
 *   - loadTrustedSources(file) 读取仓库根 trusted-sources.json
 *   - validateRepository({ root, pluginRoot }) 整仓校验（validate.mjs 使用）
 *
 * 校验规则来源：DSH_VCG/CONTRACT.md §1、§2、§11、§16.3，
 * docs/node-spec.md、docs/workflow-spec.md。
 * ==========================================================================*/
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const PORT_TYPES = ['model', 'conditioning', 'latent', 'image', 'video', 'text', 'number', 'any']
export const PARAM_TYPES = ['text', 'textarea', 'number', 'select', 'toggle', 'model']
export const ENGINES = ['cloud', 'local', 'both']
export const CAPABILITIES = ['image', 'video', 'text', 'none']
export const CATEGORIES = ['input', 'model', 'latent', 'sampling', 'decode', 'video', 'utility', 'custom']
export const BUILTIN_FNS = [
  'promptInput', 'modelLoader', 'clipTextEncode', 'emptyLatent', 'imageProps',
  'ksampler', 'vaeDecode', 'imageOutput', 'videoSampler', 'videoOutput',
  'textInput', 'textOutput', 'note', 'safetensorsInspect',
]
export const EXECUTOR_KINDS = ['builtin', 'http', 'comfy', 'local']
export const MODEL_FORMATS = ['safetensors', 'ckpt', 'pt', 'pth', 'bin', 'gguf']
export const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
// 参数 id 使用小写 snake_case（如 ckpt_name / batch_size），便于 ${params.x} 模板替换与 ComfyUI 字段命名
export const PARAM_ID = /^[a-z][a-z0-9_]*$/
export const NODE_ID = /^n[0-9]+$/
export const EDGE_ID = /^e[0-9]+$/
export const WORKFLOW_ID = /^wf-[a-z0-9]+(-[a-z0-9]+)*$/
// 模型文件名：只允许字母数字 . _ -，禁止路径分隔符与 ..
export const MODEL_FILENAME = /^[A-Za-z0-9._-]+$/
export const SHA256_HEX = /^[0-9a-fA-F]{64}$/

export function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
export function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}
export function isString(value) {
  return typeof value === 'string'
}
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}
export function sameSet(a, b) {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== a.length || setB.size !== b.length) return false
  for (const item of setA) if (!setB.has(item)) return false
  return true
}

/* ------------------------------------------------------- 模型声明校验 §16.3 */

function safeModelFilename(filename) {
  return isNonEmptyString(filename)
    && MODEL_FILENAME.test(filename)
    && !filename.includes('..')
    && filename !== '.'
}

function hostTrusted(host, hosts) {
  if (!host) return false
  return hosts.some((entry) => host === entry || host.endsWith(`.${entry}`))
}

/**
 * 审计节点/工作流顶层 `models[]` 声明（CONTRACT §16.3，docs/node-spec.md §12）。
 *
 * 阻断项（error）：filename 不安全/缺失、url 缺失或非法、format 缺失或不在白名单、
 * size 非法、sha256 非 64 位 hex、声明不是数组/对象。
 * 仅警告（warning）：url 非 https、不可信 host、缺 sha256、缺 size、缺 name、
 * 可选字段类型不正确。警告不阻止上传（审计报告列出）。
 *
 * @returns {{ok:boolean, errors:string[], warnings:string[], entries:object[]}}
 */
export function auditModels(models, trust = {}, where = 'models') {
  const errors = []
  const warnings = []
  const entries = []
  const hosts = Array.isArray(trust.hosts) ? trust.hosts.map((host) => String(host).toLowerCase()) : []
  const registryLoaded = trust.loaded !== false
  if (!Array.isArray(models)) {
    const message = `${where} 必须是数组`
    errors.push(message)
    return { ok: false, errors, warnings, entries }
  }
  const filenames = new Map()
  models.forEach((model, index) => {
    const at = `${where}[${index}]`
    const entry = {
      index,
      name: isString(model && model.name) ? model.name : null,
      filename: isString(model && model.filename) ? model.filename : null,
      url: isString(model && model.url) ? model.url : null,
      host: null,
      trusted: null,
      format: isString(model && model.format) ? model.format : null,
      size: isNumber(model && model.size) ? model.size : null,
      sha256: isString(model && model.sha256) ? model.sha256 : null,
      source: isString(model && model.source) ? model.source : null,
      license: isString(model && model.license) ? model.license : null,
      required: typeof (model && model.required) === 'boolean' ? model.required : null,
      errors: [],
      warnings: [],
    }
    const fail = (message) => {
      errors.push(`${at}${message}`)
      entry.errors.push(message.replace(/^\./, ''))
    }
    const warn = (message) => {
      warnings.push(`${at}${message}`)
      entry.warnings.push(message.replace(/^\./, ''))
    }
    if (!isObject(model)) {
      fail(' 必须是对象')
      entries.push(entry)
      return
    }
    if (model.name === undefined) warn('.name 缺失（建议填写，仅提示）')
    else if (!isNonEmptyString(model.name)) fail('.name 必须是非空字符串')

    if (model.filename === undefined) fail('.filename 缺失（必填）')
    else if (!safeModelFilename(model.filename)) {
      fail('.filename 只允许 A-Z a-z 0-9 . _ -，且不得包含路径分隔符或 ".."')
    } else {
      if (filenames.has(model.filename)) warn(`.filename 与 models[${filenames.get(model.filename)}] 重复：${model.filename}`)
      else filenames.set(model.filename, index)
    }

    if (model.url === undefined) {
      fail('.url 缺失（必填）')
    } else if (!isNonEmptyString(model.url)) {
      fail('.url 必须是非空字符串')
    } else {
      let parsed = null
      try {
        parsed = new URL(model.url)
      } catch {
        fail('.url 不是合法 URL')
      }
      if (parsed) {
        entry.host = parsed.hostname.toLowerCase()
        if (parsed.protocol !== 'https:') {
          warn(`.url 不是 https（当前 ${parsed.protocol}//${entry.host}），不安全，仅警告`)
        }
        if (registryLoaded) {
          entry.trusted = hostTrusted(entry.host, hosts)
          if (!entry.trusted) {
            warn(`.url 主机 ${entry.host} 不在 trusted-sources.json 中，下载时需二次确认（仅警告）`)
          }
        } else {
          entry.trusted = null
          warn('.url 未做可信源比对：trusted-sources.json 不可用（仅警告）')
        }
        const urlFilename = path.posix.basename(parsed.pathname)
        if (urlFilename && model.filename && urlFilename !== model.filename) {
          warn(`.url 路径文件名 ${urlFilename} 与 filename ${model.filename} 不一致（仅提示）`)
        }
      }
    }

    if (model.format === undefined) fail('.format 缺失（必填）')
    else if (!MODEL_FORMATS.includes(model.format)) {
      fail(`.format 非法：${JSON.stringify(model.format)}（允许 ${MODEL_FORMATS.join('|')}）`)
    }

    if (model.size === undefined) warn('.size 缺失（建议填写字节数，仅提示）')
    else if (!(isNumber(model.size) && Number.isInteger(model.size) && model.size > 0)) {
      fail('.size 必须是正整数（字节）')
    }

    if (model.sha256 === undefined) warn('.sha256 缺失（无法校验下载完整性，仅警告）')
    else if (!(isString(model.sha256) && SHA256_HEX.test(model.sha256))) {
      fail('.sha256 必须是 64 位十六进制字符串')
    }

    if (model.source !== undefined && !isNonEmptyString(model.source)) warn('.source 必须是非空字符串（仅提示）')
    if (model.license !== undefined && !isString(model.license)) warn('.license 必须是字符串（仅提示）')
    if (model.required !== undefined && typeof model.required !== 'boolean') warn('.required 必须是布尔值（仅提示）')
    entries.push(entry)
  })
  return { ok: errors.length === 0, errors, warnings, entries }
}

/* --------------------------------------------------------- 校验上下文工厂 */

/**
 * 创建校验上下文。root 用于把绝对路径转成仓库相对路径（报告/日志可读）。
 * trust: { hosts: string[], loaded: boolean, version?, updatedAt? }
 */
export function createValidator({ root = process.cwd(), trust = {} } = {}) {
  const errors = []
  const warnings = []
  let checks = 0
  const rel = (file) => path.relative(root, file)

  const ctx = {
    root,
    trust,
    get errors() {
      return errors
    },
    get warnings() {
      return warnings
    },
    get checks() {
      return checks
    },
    fail(message) {
      errors.push(message)
    },
    warn(message) {
      warnings.push(message)
    },
    check(condition, message) {
      checks += 1
      if (!condition) errors.push(message)
      return Boolean(condition)
    },

    async readJson(file) {
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        errors.push(`无法读取 ${file}: ${error.message}`)
        return null
      }
      try {
        return JSON.parse(text)
      } catch (error) {
        errors.push(`${rel(file)} 不是合法 JSON: ${error.message}`)
        return null
      }
    },

    async listJson(dir) {
      if (!existsSync(dir)) return []
      const names = await readdir(dir)
      return names.filter((name) => name.endsWith('.json')).sort()
    },

    checkModels(where, models) {
      const result = auditModels(models, trust, where)
      errors.push(...result.errors)
      warnings.push(...result.warnings)
      return result
    },

    checkNodeDef(file, node) {
      const where = `节点 ${rel(file)}`
      if (!ctx.check(isObject(node), `${where} 必须是 JSON 对象`)) return null
      const id = node.id
      if (!ctx.check(isNonEmptyString(id) && KEBAB.test(id), `${where}.id 必须是 kebab-case`)) return null
      ctx.check(path.basename(file) === `${id}.json`, `${where} 文件名必须等于 <id>.json`)
      ctx.check(isNonEmptyString(node.name), `${where}.name 必须是非空字符串`)
      ctx.check(isNonEmptyString(node.nameZh), `${where}.nameZh 必须是非空字符串`)
      ctx.check(CATEGORIES.includes(node.category), `${where}.category 非法: ${JSON.stringify(node.category)}`)
      ctx.check(isNumber(node.order), `${where}.order 必须是数字`)
      ctx.check(isNonEmptyString(node.description), `${where}.description 必须是非空字符串`)
      ctx.check(ENGINES.includes(node.engine), `${where}.engine 非法: ${JSON.stringify(node.engine)}`)
      ctx.check(Array.isArray(node.inputs), `${where}.inputs 必须是数组`)
      ctx.check(Array.isArray(node.outputs), `${where}.outputs 必须是数组`)
      ctx.check(Array.isArray(node.params), `${where}.params 必须是数组`)

      if (Array.isArray(node.inputs)) node.inputs.forEach((port, index) => checkPort(ctx, id, port, index, 'inputs'))
      if (Array.isArray(node.outputs)) node.outputs.forEach((port, index) => checkPort(ctx, id, port, index, 'outputs'))
      if (Array.isArray(node.params)) node.params.forEach((param, index) => checkParam(ctx, id, param, index))

      for (const [listName, list] of [['inputs', node.inputs], ['outputs', node.outputs], ['params', node.params]]) {
        if (!Array.isArray(list)) continue
        const ids = list.map((item) => item && item.id)
        ctx.check(new Set(ids).size === ids.length, `${where}.${listName} 存在重复 id`)
      }

      checkExecutor(ctx, id, node)

      if (!ctx.check(isObject(node.cloud), `${where}.cloud 必须是对象`)) {
        // 继续校验其余字段
      } else {
        ctx.check(CAPABILITIES.includes(node.cloud.capability), `${where}.cloud.capability 非法: ${JSON.stringify(node.cloud.capability)}`)
        if (node.cloud.api !== undefined) ctx.check(isNonEmptyString(node.cloud.api), `${where}.cloud.api 必须是非空字符串`)
        if (node.cloud.notes !== undefined) ctx.check(isString(node.cloud.notes), `${where}.cloud.notes 必须是字符串`)
      }

      checkComfyMap(ctx, id, node)

      // CONTRACT §16.3：节点顶层可选 models[] 声明
      if (node.models !== undefined) ctx.checkModels(`${where}.models`, node.models)

      if (!ctx.check(isObject(node.ui), `${where}.ui 必须是对象`)) {
        // 继续
      } else {
        ctx.check(isString(node.ui.accent) && /^#[0-9a-fA-F]{6}$/.test(node.ui.accent), `${where}.ui.accent 必须是 #rrggbb`)
        ctx.check(isNumber(node.ui.width) && node.ui.width > 0, `${where}.ui.width 必须是正数`)
      }
      return node
    },

    checkWorkflow(file, workflow, nodeDefs) {
      const where = `工作流 ${rel(file)}`
      if (!ctx.check(isObject(workflow), `${where} 必须是 JSON 对象`)) return null
      ctx.check(workflow.version === 1, `${where}.version 必须是 1`)
      const fileBase = path.basename(file, '.json')
      if (ctx.check(isNonEmptyString(workflow.id) && WORKFLOW_ID.test(workflow.id), `${where}.id 必须形如 wf-xxx`)) {
        ctx.check(workflow.id === fileBase || workflow.id === `wf-${fileBase}`, `${where} 文件名必须等于 id 或去掉 wf- 前缀的 id`)
      }
      ctx.check(isNonEmptyString(workflow.name), `${where}.name 必须是非空字符串`)
      ctx.check(isNonEmptyString(workflow.description), `${where}.description 必须是非空字符串`)
      for (const key of ['createdAt', 'updatedAt']) {
        ctx.check(isString(workflow[key]) && !Number.isNaN(Date.parse(workflow[key])), `${where}.${key} 必须是 ISO 时间字符串`)
      }
      if (ctx.check(isObject(workflow.viewport), `${where}.viewport 必须是对象`)) {
        ctx.check(isNumber(workflow.viewport.x), `${where}.viewport.x 必须是数字`)
        ctx.check(isNumber(workflow.viewport.y), `${where}.viewport.y 必须是数字`)
        ctx.check(isNumber(workflow.viewport.scale) && workflow.viewport.scale > 0, `${where}.viewport.scale 必须是正数`)
      }
      if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
        ctx.fail(`${where}.nodes 必须是非空数组`)
        return null
      }
      if (!Array.isArray(workflow.edges)) {
        ctx.fail(`${where}.edges 必须是数组`)
        return null
      }

      const instances = new Map()
      for (const instance of workflow.nodes) {
        if (!ctx.check(isObject(instance), `${where} 节点实例必须是对象`)) continue
        const at = `${where} 节点实例 ${JSON.stringify(instance.id)}`
        if (!ctx.check(isNonEmptyString(instance.id) && NODE_ID.test(instance.id), `${at}.id 必须形如 n1`)) continue
        ctx.check(!instances.has(instance.id), `${at}.id 重复`)
        const def = nodeDefs.get(instance.type)
        ctx.check(Boolean(def), `${at}.type 引用了不存在的节点定义: ${JSON.stringify(instance.type)}`)
        ctx.check(isNumber(instance.x) && isNumber(instance.y), `${at} 的 x/y 必须是数字`)
        if (instance.title !== undefined) ctx.check(isString(instance.title), `${at}.title 必须是字符串`)
        if (instance.engineOverride !== undefined) ctx.check(['cloud', 'local'].includes(instance.engineOverride), `${at}.engineOverride 必须是 cloud|local`)
        const params = instance.params === undefined ? {} : instance.params
        if (ctx.check(isObject(params), `${at}.params 必须是对象`)) {
          if (def && Array.isArray(def.params)) {
            const defs = new Map(def.params.map((param) => [param.id, param]))
            for (const [key, value] of Object.entries(params)) {
              const paramDef = defs.get(key)
              if (ctx.check(Boolean(paramDef), `${at}.params 含未声明的参数 ${JSON.stringify(key)}`)) {
                checkParamValue(ctx, `${at}.params.${key}`, paramDef, value)
              }
            }
            for (const paramDef of def.params) {
              if (paramDef.default === undefined) ctx.fail(`节点定义 ${def.id} 的 params.${paramDef.id} 缺少 default`)
            }
          }
        }
        instances.set(instance.id, { instance, def })
      }

      const occupiedInputs = new Map()
      const edgeIds = new Set()
      for (const edge of workflow.edges) {
        if (!ctx.check(isObject(edge), `${where} 连线必须是对象`)) continue
        const at = `${where} 连线 ${JSON.stringify(edge.id)}`
        if (!ctx.check(isNonEmptyString(edge.id) && EDGE_ID.test(edge.id), `${at}.id 必须形如 e1`)) continue
        ctx.check(!edgeIds.has(edge.id), `${at}.id 重复`)
        edgeIds.add(edge.id)
        if (!ctx.check(isObject(edge.from) && isObject(edge.to), `${at} 必须有 from / to`)) continue
        const fromInstance = instances.get(edge.from.node)
        const toInstance = instances.get(edge.to.node)
        if (!ctx.check(Boolean(fromInstance), `${at}.from.node 不存在: ${JSON.stringify(edge.from.node)}`)) continue
        if (!ctx.check(Boolean(toInstance), `${at}.to.node 不存在: ${JSON.stringify(edge.to.node)}`)) continue
        const fromDef = fromInstance.def
        const toDef = toInstance.def
        if (!fromDef || !toDef) continue
        const fromPort = (fromDef.outputs || []).find((port) => port.id === edge.from.port)
        const toPort = (toDef.inputs || []).find((port) => port.id === edge.to.port)
        if (!ctx.check(Boolean(fromPort), `${at}.from.port 不是 ${fromDef.id} 的输出端口: ${JSON.stringify(edge.from.port)}`)) continue
        if (!ctx.check(Boolean(toPort), `${at}.to.port 不是 ${toDef.id} 的输入端口: ${JSON.stringify(edge.to.port)}`)) continue
        ctx.check(
          portCompatible(fromPort.type, toPort.type),
          `${at} 类型不兼容: ${fromPort.type} → ${toPort.type}`,
        )
        const key = `${edge.to.node}.${edge.to.port}`
        ctx.check(!occupiedInputs.has(key), `${at} 目标输入端口 ${key} 已被 ${occupiedInputs.get(key)} 占用`)
        occupiedInputs.set(key, edge.id)
      }

      // 必需输入不得悬空；可选输入允许悬空
      for (const [id, entry] of instances) {
        if (!entry.def) continue
        for (const port of entry.def.inputs || []) {
          if (port.optional === true) continue
          ctx.check(occupiedInputs.has(`${id}.${port.id}`), `${where} 节点 ${id} 的必需输入 ${port.id} 没有连线（悬空）`)
        }
      }

      const cycle = detectCycle(workflow.nodes, workflow.edges)
      ctx.check(!cycle, `${where} 存在环: ${cycle ? cycle.join(' → ') : ''}`)

      // CONTRACT §16.3：工作流顶层可选 models[] 声明
      if (workflow.models !== undefined) ctx.checkModels(`${where}.models`, workflow.models)
      return workflow
    },
  }
  return ctx
}

/* ------------------------------------------------------------- 字段级校验 */

function checkParam(ctx, nodeId, param, index) {
  const where = `节点 ${nodeId} params[${index}]`
  if (!ctx.check(isObject(param), `${where} 必须是对象`)) return
  ctx.check(isNonEmptyString(param.id) && PARAM_ID.test(param.id), `${where}.id 必须是小写 snake_case`)
  ctx.check(isNonEmptyString(param.label), `${where}.label 必须是非空字符串`)
  ctx.check(PARAM_TYPES.includes(param.type), `${where}.type 非法: ${JSON.stringify(param.type)}`)
  if (param.type === 'number') {
    ctx.check(isNumber(param.default), `${where}.default 必须是数字`)
    for (const key of ['min', 'max', 'step']) {
      if (param[key] !== undefined) ctx.check(isNumber(param[key]), `${where}.${key} 必须是数字`)
    }
    if (isNumber(param.default)) {
      if (isNumber(param.min)) ctx.check(param.default >= param.min, `${where}.default 小于 min`)
      if (isNumber(param.max)) ctx.check(param.default <= param.max, `${where}.default 大于 max`)
    }
  } else if (param.type === 'select') {
    ctx.check(Array.isArray(param.options) && param.options.length > 0, `${where}.options 必须是非空数组`)
    if (Array.isArray(param.options)) {
      ctx.check(param.options.every(isNonEmptyString), `${where}.options 必须全部是字符串`)
      ctx.check(new Set(param.options).size === param.options.length, `${where}.options 有重复项`)
      ctx.check(isString(param.default) && param.options.includes(param.default), `${where}.default 必须是 options 中的一个`)
    }
  } else if (param.type === 'toggle') {
    ctx.check(typeof param.default === 'boolean', `${where}.default 必须是布尔值`)
  } else {
    // text / textarea / model（CONTRACT §16.5 参数类型 model，默认值为已下载模型文件名）
    ctx.check(isString(param.default), `${where}.default 必须是字符串`)
  }
}

function checkPort(ctx, nodeId, port, index, direction) {
  const where = `节点 ${nodeId} ${direction}[${index}]`
  if (!ctx.check(isObject(port), `${where} 必须是对象`)) return
  ctx.check(isNonEmptyString(port.id) && KEBAB.test(port.id), `${where}.id 必须是 kebab-case`)
  ctx.check(isNonEmptyString(port.label), `${where}.label 必须是非空字符串`)
  ctx.check(PORT_TYPES.includes(port.type), `${where}.type 非法: ${JSON.stringify(port.type)}`)
  if (direction === 'outputs' && port.optional !== undefined) {
    ctx.check(false, `${where} 输出端口不允许 optional`)
  }
  if (direction === 'inputs' && port.optional !== undefined) {
    ctx.check(port.optional === true, `${where}.optional 只能是 true（未设置即必需）`)
  }
}

function checkComfyMap(ctx, nodeId, node) {
  if (node.local === undefined) return null
  const where = `节点 ${nodeId} local`
  if (!ctx.check(isObject(node.local), `${where} 必须是对象`)) return null
  const comfy = node.local.comfyui
  if (!ctx.check(isObject(comfy), `${where}.comfyui 必须是对象`)) return null
  ctx.check(isNonEmptyString(comfy.class_type), `${where}.comfyui.class_type 必须是非空字符串`)
  if (!ctx.check(isObject(comfy.map) && Object.keys(comfy.map).length > 0, `${where}.comfyui.map 必须是非空对象`)) return null
  const paramIds = new Set((node.params || []).map((p) => p && p.id))
  const inputIds = new Set((node.inputs || []).map((p) => p && p.id))
  for (const [field, value] of Object.entries(comfy.map)) {
    ctx.check(isNonEmptyString(field), `${where}.comfyui.map 的字段名必须是非空字符串`)
    if (isString(value)) {
      const paramRef = /^params\.([a-z0-9_]+)$/.exec(value)
      const inputRef = /^inputs\.([a-z0-9_]+)$/.exec(value)
      if (paramRef) {
        ctx.check(paramIds.has(paramRef[1]), `${where}.comfyui.map.${field} 引用了不存在的参数 params.${paramRef[1]}`)
      } else if (inputRef) {
        ctx.check(inputIds.has(inputRef[1]), `${where}.comfyui.map.${field} 引用了不存在的输入 inputs.${inputRef[1]}`)
      } else {
        ctx.check(false, `${where}.comfyui.map.${field} 取值必须是 params.x / inputs.x / {value}`)
      }
    } else if (isObject(value)) {
      const keys = Object.keys(value)
      ctx.check(keys.length === 1 && keys[0] === 'value', `${where}.comfyui.map.${field} 对象只能是 {value: ...}`)
      if (keys.length === 1 && keys[0] === 'value') {
        ctx.check(['string', 'number', 'boolean'].includes(typeof value.value), `${where}.comfyui.map.${field}.value 必须是字面量`)
      }
    } else {
      ctx.check(false, `${where}.comfyui.map.${field} 取值类型非法`)
    }
  }
  return comfy
}

function checkExecutor(ctx, nodeId, node) {
  const where = `节点 ${nodeId}`
  const executor = node.executor
  if (!ctx.check(isObject(executor), `${where}.executor 必须是对象`)) return
  ctx.check(EXECUTOR_KINDS.includes(executor.kind), `${where}.executor.kind 非法: ${JSON.stringify(executor.kind)}`)
  if (executor.kind === 'builtin') {
    ctx.check(BUILTIN_FNS.includes(executor.fn), `${where}.executor.fn 不在 §4 固定列表中: ${JSON.stringify(executor.fn)}`)
  } else if (executor.kind === 'local') {
    // CONTRACT §16.6：本地执行节点 fn 白名单，与 builtin 使用同一份固定列表
    ctx.check(BUILTIN_FNS.includes(executor.fn), `${where}.executor.fn 不在本地执行白名单中: ${JSON.stringify(executor.fn)}`)
    ctx.check(isObject(node.cloud), `${where} 本地执行节点仍然需要 cloud 声明（capability 可为 none）`)
  } else if (executor.kind === 'http') {
    const request = executor.request
    if (ctx.check(isObject(request), `${where}.executor.request 必须是对象`)) {
      ctx.check(isString(request.url) && /^https?:\/\//.test(request.url), `${where}.executor.request.url 必须是 http(s) URL`)
      ctx.check(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method), `${where}.executor.request.method 非法`)
      if (request.headers !== undefined) ctx.check(isObject(request.headers), `${where}.executor.request.headers 必须是对象`)
      if (request.body !== undefined) ctx.check(isObject(request.body) || isString(request.body), `${where}.executor.request.body 必须是对象或字符串`)
      if (request.timeoutMs !== undefined) ctx.check(isNumber(request.timeoutMs) && request.timeoutMs > 0, `${where}.executor.request.timeoutMs 必须是正数`)
    }
    ctx.check(isObject(executor.response), `${where}.executor.response 必须是对象`)
    const hasApi = isObject(node.cloud) && isNonEmptyString(node.cloud.api)
    const hasApiParam = (node.params || []).some((p) => p && p.id === 'api')
    ctx.check(hasApi || hasApiParam, `${where} 自定义 http 节点必须在 cloud.api 或 params 中声明所需 API`)
  }
}

function portCompatible(fromType, toType) {
  if (fromType === toType) return true
  if (fromType === 'any' || toType === 'any') return true
  if (fromType === 'text' && toType === 'conditioning') return true // CONTRACT §11.2
  return false
}

function checkParamValue(ctx, where, paramDef, value) {
  if (paramDef.type === 'number') {
    if (!ctx.check(isNumber(value), `${where} 必须是数字`)) return
    if (isNumber(paramDef.min)) ctx.check(value >= paramDef.min, `${where} 小于 min ${paramDef.min}`)
    if (isNumber(paramDef.max)) ctx.check(value <= paramDef.max, `${where} 大于 max ${paramDef.max}`)
  } else if (paramDef.type === 'select') {
    ctx.check(isString(value) && Array.isArray(paramDef.options) && paramDef.options.includes(value), `${where} 必须是定义 options 中的一个`)
  } else if (paramDef.type === 'toggle') {
    ctx.check(typeof value === 'boolean', `${where} 必须是布尔值`)
  } else {
    ctx.check(isString(value), `${where} 必须是字符串`)
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

/* ------------------------------------------------------- 可信源注册表读取 */

/**
 * 读取仓库根 trusted-sources.json（CONTRACT §16.3）。
 * 返回 { loaded, path, version, updatedAt, hosts, error }；不可用时 loaded=false。
 */
export async function loadTrustedSources(file, { root } = {}) {
  const displayPath = root ? path.relative(root, file) : file
  if (!existsSync(file)) {
    return { loaded: false, path: displayPath, version: null, updatedAt: null, hosts: [], error: '文件不存在' }
  }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    const hosts = []
    for (const entry of Array.isArray(parsed.hosts) ? parsed.hosts : []) {
      if (entry && typeof entry.host === 'string' && entry.host.trim() !== '' && entry.trusted !== false) {
        hosts.push(entry.host.trim().toLowerCase())
      }
    }
    return {
      loaded: true,
      path: displayPath,
      version: typeof parsed.version === 'number' ? parsed.version : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      hosts,
      error: hosts.length === 0 ? 'hosts 为空' : null,
    }
  } catch (error) {
    return { loaded: false, path: displayPath, version: null, updatedAt: null, hosts: [], error: error.message }
  }
}

/* ------------------------------------------------------------ 整仓校验入口 */

/**
 * 整仓校验（scripts/validate.mjs 的 main 逻辑）。
 * 返回 { errors, warnings, checks, stats }，由调用方决定打印与退出码。
 */
export async function validateRepository({ root, pluginRoot, comparePlugin = true, trustedSourcesPath } = {}) {
  const trustFile = trustedSourcesPath || path.join(root, 'trusted-sources.json')
  const trust = await loadTrustedSources(trustFile, { root })
  const ctx = createValidator({ root, trust })
  const nodesDir = path.join(root, 'nodes')
  const workflowsDir = path.join(root, 'workflows')
  const manifestFile = path.join(root, 'manifest.json')

  if (!trust.loaded) {
    ctx.warn(`trusted-sources.json 不可用（${trust.error}），模型声明跳过了可信源比对`)
  } else {
    ctx.check(Array.isArray(trust.hosts) && trust.hosts.length > 0, 'trusted-sources.json.hosts 必须是非空数组')
  }

  const manifest = await ctx.readJson(manifestFile)
  if (!manifest) {
    return { errors: ctx.errors, warnings: ctx.warnings, checks: ctx.checks, stats: null }
  }
  ctx.check(isObject(manifest), 'manifest.json 必须是 JSON 对象')
  ctx.check(isNonEmptyString(manifest.version), 'manifest.version 必须是非空字符串')
  ctx.check(isNonEmptyString(manifest.minPluginVersion), 'manifest.minPluginVersion 必须是非空字符串')
  ctx.check(Array.isArray(manifest.nodes) && manifest.nodes.every(isNonEmptyString), 'manifest.nodes 必须是字符串数组')
  ctx.check(Array.isArray(manifest.workflows) && manifest.workflows.every(isNonEmptyString), 'manifest.workflows 必须是字符串数组')

  const nodeFiles = await ctx.listJson(nodesDir)
  const nodeDefs = new Map()
  for (const name of nodeFiles) {
    const node = ctx.checkNodeDef(path.join(nodesDir, name), await ctx.readJson(path.join(nodesDir, name)))
    if (!node) continue
    if (ctx.check(!nodeDefs.has(node.id), `节点 id 重复: ${node.id}`)) nodeDefs.set(node.id, node)
  }

  const workflowFiles = await ctx.listJson(workflowsDir)
  const workflowIds = new Map()
  for (const name of workflowFiles) {
    const workflow = ctx.checkWorkflow(
      path.join(workflowsDir, name),
      await ctx.readJson(path.join(workflowsDir, name)),
      nodeDefs,
    )
    if (!workflow) continue
    if (ctx.check(!workflowIds.has(workflow.id), `工作流 id 重复: ${workflow.id}`)) workflowIds.set(workflow.id, workflow)
  }

  if (Array.isArray(manifest.nodes)) {
    ctx.check(sameSet(manifest.nodes, nodeFiles.map((name) => name.replace(/\.json$/, ''))), 'manifest.nodes 与 nodes/ 目录不一致（缺漏或多出）')
    for (const id of manifest.nodes) ctx.check(nodeDefs.has(id), `manifest.nodes 列出了不存在的节点: ${id}`)
  }
  if (Array.isArray(manifest.workflows)) {
    ctx.check(sameSet(manifest.workflows, workflowFiles.map((name) => {
      const workflow = workflowIds.get(`wf-${name.replace(/\.json$/, '')}`)
      return workflow ? workflow.id : name.replace(/\.json$/, '')
    })), 'manifest.workflows 与 workflows/ 目录不一致')
    for (const id of manifest.workflows) ctx.check(workflowIds.has(id), `manifest.workflows 列出了不存在的工作流: ${id}`)
  }

  // 内置副本一致性（DSH_VCG/nodes、DSH_VCG/workflows 必须与仓库字节一致）
  if (comparePlugin) {
    await compareDirectory(ctx, nodesDir, path.join(pluginRoot, 'nodes'), 'nodes')
    await compareDirectory(ctx, workflowsDir, path.join(pluginRoot, 'workflows'), 'workflows')
  }

  // 覆盖度自检：必需节点 / 示例工作流（与 manifest 对齐后的最低集合）
  const requiredNodes = [
    'checkpoint-loader', 'clip-text-encoder', 'empty-latent-image', 'ksampler', 'vae-decode',
    'prompt-input', 'model-loader', 'image-props', 'image-output', 'video-sampler',
    'video-output', 'text-input', 'text-output', 'note', 'example-node',
    'local-safetensors-inspect',
  ]
  for (const id of requiredNodes) ctx.check(nodeDefs.has(id), `缺少必需节点: ${id}`)
  const requiredWorkflows = ['wf-txt2img', 'wf-txt2video', 'wf-product-shot', 'wf-example', 'wf-local-inspect']
  for (const id of requiredWorkflows) ctx.check(workflowIds.has(id), `缺少必需工作流: ${id}`)

  const stats = {
    nodes: nodeDefs.size,
    workflows: workflowIds.size,
    edges: workflowFiles.length ? (await Promise.all(workflowFiles.map(async (name) => {
      const workflow = await ctx.readJson(path.join(workflowsDir, name))
      return Array.isArray(workflow && workflow.edges) ? workflow.edges.length : 0
    }))).reduce((sum, count) => sum + count, 0) : 0,
  }

  return { errors: ctx.errors, warnings: ctx.warnings, checks: ctx.checks, stats }
}

async function compareDirectory(ctx, repoDir, pluginDir, label) {
  if (!existsSync(pluginDir)) {
    ctx.warn(`${label}: 插件目录不存在，跳过一致性检查（${pluginDir}）`)
    return
  }
  const repoFiles = await ctx.listJson(repoDir)
  const pluginFiles = await ctx.listJson(pluginDir)
  ctx.check(sameSet(repoFiles, pluginFiles), `${label}: 仓库与 DSH_VCG/${label} 文件列表不一致`)
  for (const name of repoFiles) {
    if (!pluginFiles.includes(name)) continue
    const [repoContent, pluginContent] = await Promise.all([
      readFile(path.join(repoDir, name)),
      readFile(path.join(pluginDir, name)),
    ])
    ctx.check(repoContent.equals(pluginContent), `${label}/${name}: 仓库副本与 DSH_VCG 内置副本字节不一致`)
  }
}