# 节点定义规范（nodes/*.json）

本文档是 `DSH_VCG_repo/nodes/*.json` 的完整规范，等价于插件契约 `DSH_VCG/CONTRACT.md` §1、§3、§11 的落地说明；两者冲突时以 `CONTRACT.md` 为准。

节点定义是**纯数据**：插件 Host 半部分按 `executor` 执行，画布按字段渲染。仓库文件与插件内置副本 `DSH_VCG/nodes/*.json` 必须字节一致。

---

## 1. 文件与命名

- 一个节点一个文件：`nodes/<id>.json`，文件名必须严格等于 `<id>.json`。
- `id`：小写 kebab-case（`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`），全局唯一。
- `params[].id`、`inputs[].id` 与 `outputs[].id` 使用小写 snake_case（`^[a-z][a-z0-9_]*$`），在各自数组内唯一。
  - 参数 id 会成为模板占位符 `${params.<id>}` 与 `local.comfyui.map` 的引用目标，因此不要使用大写或连字符。
- 建议 `order` 以 10 递增，为后续插入留出空间；节点库按 `category` 分组、组内按 `order` 升序排列。

## 2. 顶层字段

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 小写 kebab-case，全局唯一，= 文件名 |
| `name` | string | ✅ | 英文名（节点库 / 画布英文环境显示） |
| `nameZh` | string | ✅ | 中文名（中文环境显示） |
| `category` | enum | ✅ | `input` `model` `latent` `sampling` `decode` `video` `utility` `custom` 之一 |
| `order` | number | ✅ | 同分类排序权重，越小越靠前 |
| `description` | string | ✅ | 一句话说明用途；画布用于悬浮提示 |
| `engine` | enum | ✅ | `cloud` 仅云端 / `local` 仅本地 / `both` 两者皆可（默认云端优先） |
| `inputs` | array | ✅ | 输入端口，可为 `[]` |
| `outputs` | array | ✅ | 输出端口，可为 `[]` |
| `params` | array | ✅ | 参数，可为 `[]` |
| `executor` | object | ✅ | 执行器声明，见 §6 |
| `cloud` | object | ✅ | 云端能力声明，见 §7 |
| `local` | object | 可选 | 本地 ComfyUI 映射，见 §8 |
| `ui` | object | ✅ | `{ accent: "#rrggbb", width: number }` |

`engine` 的语义：

- `cloud`：只能云端运行。`local.mode = true` 时该节点在翻译阶段报错（例如 `video-sampler`、`example-node`、`model-loader`）。
- `local`：只能本地运行（当前仓库未使用）。
- `both`：云端有执行器、本地有 ComfyUI 映射或可被翻译器解析（例如 `ksampler`、`checkpoint-loader`）。

工作流实例的 `engineOverride`（`"cloud"|"local"`）可覆盖节点默认引擎，用于在混合工作流里强制某个节点走某条路径。

## 3. 端口（inputs / outputs）

```json
{ "id": "positive", "label": "POSITIVE", "type": "conditioning", "optional": true }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 小写 snake_case，节点内唯一 |
| `label` | string | 端口显示名（画布端口标签），习惯用大写（MODEL / IMAGE / LATENT…） |
| `type` | enum | 见端口类型表 |
| `optional` | boolean | **仅输入端口**；`true` 表示允许悬空（见 §3.2）。输出端口禁止该字段 |

### 3.1 端口类型

| type | 语义 | 常见来源 → 去向 |
|---|---|---|
| `model` | 模型 / 检查点 / CLIP / VAE 句柄 | `model-loader`、`checkpoint-loader` → `ksampler`、`clip-text-encoder.clip`、`vae-decode.vae` |
| `conditioning` | 已编码条件 | `clip-text-encoder` → `ksampler.positive/negative`；也接受 `text`（兼容对） |
| `latent` | 潜空间 | `empty-latent-image` → `ksampler.latent` |
| `image` | 图像（URL 或本地路径） | `ksampler`、`vae-decode`、`example-node` → `image-output`、`video-sampler.image` |
| `video` | 视频（URL 或本地路径） | `video-sampler` → `video-output` |
| `text` | 文本 | `prompt-input`、`text-input` → `clip-text-encoder.text`、`text-output`、http 节点 |
| `number` | 数字 | `image-props` → `empty-latent-image.width/height` |
| `any` | 任意（通配） | 仅用于确实无法静态定型的扩展节点 |

**CLIP / VAE 复用 `model`**：契约 §1 的类型表没有独立 `clip` / `vae` 类型，因此 `checkpoint-loader` 的 `clip` / `vae` 输出与 `clip-text-encoder.clip` / `vae-decode.vae` 输入都声明为 `model`（契约 §11.4）。语义上仍是不同子类型，由本地翻译器按 ComfyUI 端口语义处理。

### 3.2 可选输入 `optional: true`（契约 §11.1）

- 未标记的输入端口**必须恰好有一条入边**，否则工作流校验失败（画布显示警告徽章，但允许编辑）。
- `optional: true` 的输入允许悬空；执行器在未连线时回退到 `params` / `undefined`：
  - `empty-latent-image.width/height?` → 回退 `params.width` / `params.height`
  - `clip-text-encoder.clip?` / `.text?` → `text` 回退 `params.text`，`clip` 云端忽略
  - `vae-decode.vae?` → 云端忽略
  - `video-sampler.image?` → 文生视频时为空
  - `example-node.text?` / `.image?` → 按 http 模板替换为空字符串 / 不发送
- 该字段是契约 §11.1 对 §1 的增量扩展；`CONTRACT.md` 正文未列出的其它字段不得使用。

## 4. 参数（params）

| 字段 | 适用类型 | 说明 |
|---|---|---|
| `id` | 全部 | 小写 snake_case，节点内唯一，模板中写作 `${params.<id>}` |
| `label` | 全部 | 中文标签（画布控件标题） |
| `type` | 全部 | `text` `textarea` `number` `select` `toggle` `model` |
| `default` | 全部 | 必需；类型必须与 `type` 匹配 |
| `min` / `max` | number | 可选，闭区间；`default` 必须落在区间内 |
| `step` | number | 可选，数字输入步进 |
| `options` | select | 必需，非空字符串数组；`default` 必须是其中之一 |

类型映射：

| type | 控件 | `default` 类型 |
|---|---|---|
| `text` | 单行输入框 | string |
| `textarea` | 多行文本域 | string |
| `number` | 数字输入 | number |
| `select` | 下拉 | string，且 ∈ `options` |
| `toggle` | 开关 | boolean |
| `model` | 模型下拉（选项由设置中的模型映射动态提供） | string（空串 = 使用设置默认模型） |

约定：工作流实例的 `params` 只写需要覆盖的键；未覆盖的键取节点定义的 `default`。执行器读取参数时，未传值一律按定义默认值补齐。

## 5. 执行器与内置函数（executor.kind = "builtin"）

```json
"executor": { "kind": "builtin", "fn": "ksampler" }
```

`fn` 只能取以下固定值（契约 §4），每个函数读取的端口 / 参数是**约定**，Host `lib/engine.js` 必须按此实现：

| fn | 节点 | 读取输入 | 读取参数 | 产出输出 | 云端行为 |
|---|---|---|---|---|---|
| `promptInput` | prompt-input | — | `positive`、`negative` | `positive`、`negative`（text） | 直通 |
| `textInput` | text-input | — | `text` | `text` | 直通 |
| `modelLoader` | model-loader、checkpoint-loader | — | `model`（checkpoint-loader 也读 `ckpt_name`，仅本地用） | model-loader：`model`；checkpoint-loader：`model`、`clip`、`vae` | 校验模型存在，返回 `{providerId, model, clip, vae}` |
| `clipTextEncode` | clip-text-encoder | `text` | `text`（回退）、`rewrite` | `conditioning` | 直通；`rewrite=true` 时调文本模型润色 |
| `emptyLatent` | empty-latent-image | `width`、`height`（可选） | `width`、`height`、`batch_size` | `latent` = `{width,height,batch_size}` | 生成潜空间描述对象 |
| `imageProps` | image-props | — | `width`、`height` | `width`、`height`（number） | 直通 |
| `ksampler` | ksampler | `model`、`positive`、`negative`、`latent` | `seed`、`steps`、`cfg`、`sampler`、`scheduler`、`denoise` | `image`（URL） | 调生图 API，返回图片 URL + usage |
| `vaeDecode` | vae-decode | `image` | — | `image` | 直通 / 下载落盘 |
| `imageOutput` | image-output | `image` | `filename`、`format`、`open_after` | —（写 `results[nodeId]`） | 保存到输出目录，返回本地路径 |
| `videoSampler` | video-sampler | `positive`、`image`（可选） | `seed`、`duration`、`fps`、`size` | `video` | 调视频 API |
| `videoOutput` | video-output | `video` | `filename`、`format` | — | 保存视频 |
| `textOutput` | text-output | `text` | `label` | —（写 `results.text`） | 返回文本 |
| `note` | note | — | `text` | — | 不参与运算，直接跳过 |

输入取值优先级约定：**有连线的输入端口值优先；未连线时回退到同名参数**（如 `clip-text-encoder` 的 `text`、`empty-latent-image` 的 `width/height`）。`ksampler` 的云端适配器由工作流中上游 `empty-latent-image` 的 `latent.width/height` 组装 API `size`（`"W*H"`）。

## 6. 自定义 API 节点（executor.kind = "http"，契约 §3）

专业模式导入的节点必须使用 `executor.kind = "http"`，并在 `params` 中声明所需 API（`api` 字段）或 `cloud.api` 中声明。

```json
{
  "id": "example-node",
  "name": "Example API Node",
  "nameZh": "示例 API 节点",
  "category": "custom",
  "order": 100,
  "description": "专业模式自定义节点示例",
  "engine": "cloud",
  "inputs": [
    { "id": "text", "label": "PROMPT", "type": "text", "optional": true }
  ],
  "outputs": [{ "id": "image", "label": "IMAGE", "type": "image" }],
  "params": [
    { "id": "api", "label": "API 名称", "type": "select", "options": ["example-generate-image"], "default": "example-generate-image" },
    { "id": "size", "label": "尺寸", "type": "select", "options": ["1024*1024"], "default": "1024*1024" }
  ],
  "executor": {
    "kind": "http",
    "request": {
      "url": "https://api.example.com/v1/images/generations",
      "method": "POST",
      "headers": {
        "Authorization": "Bearer ${settings.apiKey}",
        "Content-Type": "application/json"
      },
      "body": { "model": "${params.api}", "prompt": "${inputs.text}", "size": "${params.size}", "n": 1 },
      "timeoutMs": 120000
    },
    "response": { "images": "$.data[*].url", "text": "$.text", "error": "$.error.message" }
  },
  "cloud": { "capability": "image", "api": "example-generate-image", "notes": "演示用占位地址" },
  "ui": { "accent": "#f59e0b", "width": 300 }
}
```

### 6.1 request

| 字段 | 必需 | 说明 |
|---|---|---|
| `url` | ✅ | 必须是 `http://` 或 `https://` URL；Host 侧强制校验 |
| `method` | ✅ | `GET` `POST` `PUT` `PATCH` `DELETE` |
| `headers` | 可选 | 对象；值支持占位符 |
| `body` | 可选 | 对象或字符串；对象内的字符串值支持占位符 |
| `timeoutMs` | 可选 | 正整数，默认 120000 |

占位符（请求时替换）：

| 占位符 | 含义 |
|---|---|
| `${inputs.<portId>}` | 上游连线值；可选输入悬空时为空字符串 / 不发送该键 |
| `${params.<paramId>}` | 节点参数（实例覆盖值或定义默认值） |
| `${settings.apiKey}` | 当前 provider 的 API Key（由设置注入，不写入节点 JSON） |

### 6.2 response（极简 JSONPath）

| 字段 | 说明 |
|---|---|
| `images` | 图片结果取值表达式，如 `$.data[*].url` |
| `text` | 文本结果取值表达式 |
| `error` | 错误信息取值表达式，如 `$.error.message` |

JSONPath 仅支持 `$.a.b`、`$.a[*].b` 两种形式；取到的数组按图片 URL 列表处理，字符串按单值处理。响应体无法匹配 `images` 时按 `error` 表达式取错误信息，取不到则使用 HTTP 状态码与截断响应体生成可读错误。

### 6.3 导入与安全

- 导入节点要求设置中开启「专业模式」，且 Host 校验 `executor.kind === "http"`、`url` 为 http(s)。
- 导入节点与内置节点同 schema；`id` 冲突时需显式覆盖（`importNode` 的 `overwrite`）。
- 节点 JSON 只描述请求形状，**不得**写入真实密钥；密钥统一由 provider 保存并在请求时注入。演示地址 `api.example.com` 不可用，替换为真实 API 后使用。
- 自定义节点不提供 ComfyUI 映射（`local` 字段不支持 `executor.kind="http"` 的节点）。

## 7. cloud 声明

```json
"cloud": { "capability": "image", "api": "example-generate-image", "notes": "……" }
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `capability` | ✅ | `image` `video` `text` `none`：该节点需要的云端能力。`none` = 不发 API 请求（直通 / 保存 / 注释） |
| `api` | 可选 | 自定义节点所需 API 名称 / 模型标识（http 节点建议同时写进 params 的 `api`） |
| `notes` | 可选 | 人类可读备注，画布 / 文档展示 |

能力约定：`ksampler` = `image`；`video-sampler` = `video`；`example-node` = `image`；加载器与输出节点 = `none`（加载器只做选择校验，输出只做本地保存）。

## 8. local.comfyui（本地 ComfyUI 映射）

```json
"local": {
  "comfyui": {
    "class_type": "KSampler",
    "map": {
      "seed": "params.seed",
      "sampler_name": "params.sampler",
      "scheduler": "params.scheduler",
      "denoise": "params.denoise",
      "model": "inputs.model",
      "positive": "inputs.positive",
      "negative": "inputs.negative",
      "latent_image": "inputs.latent"
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `class_type` | ComfyUI 节点类名，用于构造 API prompt |
| `map` | ComfyUI 输入字段 → 取值来源，非空对象 |

`map` 的值只允许三种形式：

1. `"params.<paramId>"` —— 取节点参数（参数必须真实存在）。
2. `"inputs.<portId>"` —— 取输入端口解析后的值（端口必须真实存在）；有连线取上游节点输出引用，未连线时该 ComfyUI 字段省略并产生告警（`optional !== true` 时告警，可选输入静默），因此本地工作流建议显式连线（`params.x` 形式则直接取参数）。
3. `{ "value": <string|number|boolean> }` —— 字面量。

补充规则：

- `map` 只描述**输入字段**；节点输出与 ComfyUI 输出的对应关系按 class 输出顺序（如 `CheckpointLoaderSimple` 的 `0=MODEL / 1=CLIP / 2=VAE`）。
- `ksampler` 的 `scheduler`、`denoise` 是 ComfyUI `KSampler` 的必需输入，因此必须声明进 `map`（契约 §11.5）。
- 未声明 `local.comfyui` 的节点无法在本地模式翻译：`engine="cloud"` 的节点会让整张工作流在本地模式报错（可读提示），`engine="both"` 但无映射的节点（如 `prompt-input`）由翻译器作为"预处理节点"先行求值，只取其文本 / 数值结果注入下游字段。
- 本地模式的翻译流程、支持范围与限制见 [comfyui-compat.md](comfyui-compat.md)。

## 9. ui

```json
"ui": { "accent": "#7c5cff", "width": 264 }
```

- `accent`：节点标题 / 端口强调色，`#rrggbb`。
- `width`：画布节点默认宽度（像素），建议 240 ~ 320。

## 10. 校验清单

`node scripts/validate.mjs` 对每个节点执行：

- [x] JSON 可解析；文件名 = `<id>.json`；id 为小写 kebab-case 且全局唯一
- [x] `name` / `nameZh` / `description` 非空；`category` / `engine` 枚举合法
- [x] `order` 数字、`ui.accent` 为 `#rrggbb`、`ui.width` 为正数
- [x] 端口 id 唯一、`label` 非空、`type` 枚举合法；`optional` 只出现在输入且只能为 `true`
- [x] 参数 id 唯一、type 枚举合法；`number` 的 `default` 在 `min`/`max` 内；`select` 的 `default` ∈ `options`；`toggle` 为布尔；其余为字符串
- [x] `executor.kind` 合法；`builtin` 的 `fn` ∈ §4 固定列表；`http` 节点 URL 为 http(s) 且声明 API
- [x] `cloud.capability` 合法；`local.comfyui.class_type` 非空；`map` 非空且每个 `params.x` / `inputs.x` 引用真实存在、字面量合法
- [x] `node scripts/validate.mjs` 同时校验工作流引用与仓库一致性（见 [workflow-spec.md](workflow-spec.md)）

## 11. 版本与兼容

- `manifest.json` 的 `version` 为仓库版本（语义化版本），`minPluginVersion` 为可加载本仓库的最低插件版本。
- 新增节点 / 工作流属于小版本；修改既有节点 `id`、端口名、参数名属于破坏性变更，必须同步 bump 主版本，并同步更新插件内置副本与本文档。
- 插件按 `manifest.nodes` / `manifest.workflows` 校验拉取完整性；清单与文件不一致的仓库视为无效包。
