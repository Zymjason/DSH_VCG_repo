# VCG 视觉控制生成器 · 节点与工作流仓库

> GitHub：[Zymjason/DSH_VCG_repo](https://github.com/Zymjason/DSH_VCG_repo)　|　Gitea 镜像：[ZymJason_DSH/DSH_VCG_repo](https://gitea.com/ZymJason_DSH/DSH_VCG_repo)
> 插件仓库：[Zymjason/DSH_VCG](https://github.com/Zymjason/DSH_VCG)　|　[ZymJason_DSH/DSH_VCG](https://gitea.com/ZymJason_DSH/DSH_VCG)

**DSH_VCG_repo** 是 VCG 视觉控制生成器（Visual Control Generator）的官方节点 / 工作流仓库，也是插件内置节点与示例工作流的**唯一事实来源**。插件契约见工作区内的 `DSH_VCG/CONTRACT.md`（本仓库遵循其 §1 / §2 / §3 / §11）。

- 插件内置副本 `DSH_VCG/nodes/*.json` 与 `DSH_VCG/workflows/*.json` 必须与本仓库对应文件**字节一致**（`node scripts/validate.mjs` 会校验）。
- 本仓库只包含数据（JSON）与规范文档，不含可执行插件代码；所有执行器由插件的 Host 半部分实现（契约 §4）。
- 节点 / 工作流文件遵循 `DSH_VCG/CONTRACT.md` §1、§2、§3、§11 的 schema；推荐模型声明见 §16.3 与 `docs/node-spec.md` §12。
- **所有上传只能走 Pull Request**：自动审计 + 人工审查通过后才进入 `main`；未审核进 `dev`、打回进 `bug`、issue 复核进 `recheck`。流程见 [docs/review-policy.md](docs/review-policy.md)，提交方法见 [docs/submission.md](docs/submission.md)。

## 目录结构

```
DSH_VCG_repo/
├── README.md                 本文档：编写规范总览
├── manifest.json             清单：{version, nodes:[id...], workflows:[id...], minPluginVersion}
├── nodes/*.json              节点定义（文件名 = <id>.json，id 小写 kebab-case）
├── workflows/*.json          示例工作流（画布持久化同构，id 形如 wf-xxx）
├── docs/
│   ├── node-spec.md          节点定义完整规范（含 §3 自定义 HTTP 节点）
│   ├── workflow-spec.md      工作流规范与执行语义
│   ├── cloud-api.md          云端 API 适配说明
│   └── comfyui-compat.md     本地 ComfyUI 映射与限制
├── trusted-sources.json      可信模型下载源清单（客户端下载前比对）
├── assets/                   示例权重（1KB safetensors，供本地检查节点演示）
├── sdk/loader.md             如何从本仓库拉取节点包（raw URL / manifest 约定）
├── scripts/
│   ├── validate.mjs          零依赖校验器（node scripts/validate.mjs）
│   ├── audit-submission.mjs  PR/Issue 提交审计（类型/规范/重复/模型来源）
│   ├── route-branch.mjs      按审计结果移动文件到 dev/bug/recheck
│   └── sync-mirrors.mjs      GitHub ↔ Gitea 全分支/tag 镜像同步
├── .github/workflows/        PR/Issue 审计 + 每日 22:00（北京）镜像同步
└── .gitea/workflows/         Gitea Actions 等价自动化
```

## 快速开始

**在插件中同步**：设置 → VCG 视觉控制生成器 → 节点仓库 → 选择 GitHub / Gitea 源 → 同步。插件读取 `manifest.json`，再按清单拉取 `nodes/*.json` 与 `workflows/*.json`，失败时回退到内置副本。拉取约定见 [sdk/loader.md](sdk/loader.md)。

**本地校验**（修改仓库后必跑）：

```bash
cd DSH_VCG_repo
node scripts/validate.mjs     # 退出码 0 = 通过
```

校验内容：JSON 可解析、节点 id 唯一且与文件名一致、schema 字段完整、param 默认值类型与取值范围、`executor.fn` 合法（含本地 `safetensorsInspect`）、ComfyUI `map` 引用存在、`models[]` 声明安全（https/文件名/格式/sha256/可信源，仅警告）、manifest 与目录一一对应、工作流引用的节点类型都存在、每条边端口存在且类型兼容、必需输入不悬空、无环、`DSH_VCG/nodes` 与 `DSH_VCG/workflows` 字节一致。

## 上传审计与分支流程

| 分支 | 含义 |
|---|---|
| `main` | 人工审核通过，客户端默认只显示该分支 |
| `dev` | 已提交、待审核（PR 目标分支） |
| `bug` | 审计或人工审查不通过（打回；PR 保持打开可重新提交） |
| `recheck` | Issue 问题报告触发的复核队列 |

提交方式：fork/分支 → 按 PR 模板声明 `type: node|workflow`、`files`、`submitter`（重新提交加 `supersedes: #旧PR`）→ CI 自动审计并评论报告。审计检查文件类型/路径、节点或工作流规范、跨分支重复（相同 id/文件/内容 sha256 直接打回）、模型来源安全（不可信源/缺 sha256/非 https 仅警告，不阻止上传）。人工添加 `status:approved` 后自动进入 `main`；`status:rejected` 进入 `bug`。

下载安全：节点/工作流可声明 `models[]`（见 `docs/node-spec.md` §12）；客户端下载前会与根目录 `trusted-sources.json` 比对，非权威来源弹窗警告并要求二次确认。

**修改后同步到插件内置副本**：

```bash
cd "MOD Create"
cp -a DSH_VCG_repo/nodes/. DSH_VCG/nodes/
cp -a DSH_VCG_repo/workflows/. DSH_VCG/workflows/
cd DSH_VCG_repo && node scripts/validate.mjs
```

## 数据模型速览

### 节点定义（`nodes/*.json`，详见 [docs/node-spec.md](docs/node-spec.md)）

```json
{
  "id": "ksampler",
  "name": "KSampler",
  "nameZh": "采样器",
  "category": "sampling",
  "order": 40,
  "description": "把条件与潜空间采样成图像……",
  "engine": "both",
  "inputs": [{ "id": "model", "label": "MODEL", "type": "model" }],
  "outputs": [{ "id": "image", "label": "IMAGE", "type": "image" }],
  "params": [{ "id": "seed", "label": "种子", "type": "number", "default": 42, "min": 0, "max": 2147483647 }],
  "executor": { "kind": "builtin", "fn": "ksampler" },
  "cloud": { "capability": "image", "notes": "调用设置中默认生图模型" },
  "local": { "comfyui": { "class_type": "KSampler", "map": { "seed": "params.seed" } } },
  "ui": { "accent": "#7c5cff", "width": 264 }
}
```

关键规则：

| 维度 | 规则 |
|---|---|
| `id` | 小写 kebab-case，全局唯一；文件名必须为 `<id>.json` |
| `category` | 只能取 `input` `model` `latent` `sampling` `decode` `video` `utility` `custom` |
| `engine` | `cloud` 仅云端 / `local` 仅本地 / `both` 两者皆可（默认云端优先） |
| 端口 `type` | `model` `conditioning` `latent` `image` `video` `text` `number` `any` |
| 参数 `type` | `text` `textarea` `number` `select` `toggle` `model`；`select` 必须有 `options` 且默认值属于其中 |
| `executor.kind` | `builtin`（内置执行器 + §4 固定 `fn`）、`http`（专业模式自定义 API 节点）、`comfy`（仅本地 ComfyUI 类节点） |
| `optional: true` | 仅用于 `inputs[]`。未标记的输入必须有且只有一条入边；可选输入可悬空并回退 `params` |
| ComfyUI | `local.comfyui.class_type` + `map`，`map` 值形如 `params.x` / `inputs.x` / `{ "value": 字面量 }` |
| `ui` | `accent` 为 `#rrggbb`，`width` 为节点默认像素宽 |

内置执行器 `fn` 固定为（契约 §4）：
`promptInput` `modelLoader` `clipTextEncode` `emptyLatent` `imageProps` `ksampler` `vaeDecode` `imageOutput` `videoSampler` `videoOutput` `textInput` `textOutput` `note`。

### 工作流（`workflows/*.json`，详见 [docs/workflow-spec.md](docs/workflow-spec.md)）

```json
{
  "version": 1,
  "id": "wf-txt2img",
  "name": "基础文生图",
  "description": "……",
  "createdAt": "2026-11-13T02:40:00.000Z",
  "updatedAt": "2026-11-13T02:40:00.000Z",
  "viewport": { "x": 0, "y": 0, "scale": 1 },
  "nodes": [
    { "id": "n1", "type": "prompt-input", "x": 60, "y": 120, "params": { "positive": "…", "negative": "…" } }
  ],
  "edges": [
    { "id": "e1", "from": { "node": "n1", "port": "positive" }, "to": { "node": "n4", "port": "positive" } }
  ]
}
```

- 节点实例：`id`（`n1`/`n2`…，画布内唯一）、`type`（= 节点定义 id）、`x`/`y`（数字坐标）、`params`（仅覆盖已声明参数）、可选 `title`、可选 `engineOverride`（`"cloud"|"local"`）。
- 连线：一条边只连一个输出端口到一个输入端口；同一输入端口最多一条入边。
- 类型兼容（契约 §11.2）：同类型、任一端 `any`、或 `text → conditioning`（提示词文本可直接进采样器）才允许连接。
- 不得有"悬空必需输入"；可选输入（`optional: true`）允许悬空。
- 工作流必须无环（DAG）。
- 运行结果不写入工作流文件，由宿主以 `results[nodeId]` 返回。

## 内置节点一览

| 节点 id | 中文名 | category | engine | 输入 → 输出 | executor.fn | ComfyUI class_type |
|---|---|---|---|---|---|---|
| `prompt-input` | 提示词输入 | input | both | — → positive/negative (text) | `promptInput` | — |
| `text-input` | 文本输入 | input | both | — → text | `textInput` | — |
| `image-props` | 图像属性 | latent | both | — → width/height (number) | `imageProps` | — |
| `model-loader` | 模型加载器 | model | cloud | — → model | `modelLoader` | — |
| `checkpoint-loader` | 检查点加载器 | model | both | — → model/clip/vae | `modelLoader` | `CheckpointLoaderSimple` |
| `empty-latent-image` | 空潜空间 | latent | both | width?/height? (number) → latent | `emptyLatent` | `EmptyLatentImage` |
| `clip-text-encoder` | CLIP 文本编码器 | model | both | clip?/text? → conditioning | `clipTextEncode` | `CLIPTextEncode` |
| `ksampler` | 采样器 | sampling | both | model/positive/negative/latent → image | `ksampler` | `KSampler` |
| `vae-decode` | VAE 解码 | decode | both | image/vae? → image | `vaeDecode` | `VAEDecode` |
| `image-output` | 图像输出 | decode | both | image → — | `imageOutput` | — |
| `video-sampler` | 视频采样器 | video | cloud | positive/image? → video | `videoSampler` | — |
| `video-output` | 视频输出 | video | cloud | video → — | `videoOutput` | — |
| `text-output` | 文本输出 | decode | both | text → — | `textOutput` | — |
| `note` | 注释 | utility | both | — → — | `note` | — |
| `example-node` | 示例 API 节点 | custom | cloud | text?/image? → image | `http`（§3） | — |

> `?` 表示该输入端口为 `optional: true`（允许悬空，未连线时回退 `params` / `undefined`）。
> CLIP / VAE 端口复用 `model` 类型（契约 §11.4：§1 类型表没有独立 clip/vae 类型）。
> `checkpoint-loader` 本地输出按 ComfyUI 输出顺序 `0=MODEL / 1=CLIP / 2=VAE` 对应。

### 输入 / 输出语义要点

- **prompt-input**：配置正向 / 负向提示词文本；`positive`/`negative` 可直接接 `ksampler` 的 `positive`/`negative`（`text → conditioning` 兼容），也可接 `clip-text-encoder.text`。
- **clip-text-encoder**：条件文本优先取输入 `text`，回退参数 `text`；`rewrite=true` 时调用设置的文本模型润色；云端忽略 `clip` 输入；正 / 负条件各用一个实例。
- **empty-latent-image**：`width`/`height` 输入来自 `image-props` 或其它 number 输出，未连线使用参数；云端用它决定 API 的 `size`。
- **checkpoint-loader**：三输出（model/clip/vae）；云端使用"云端模型"参数或设置默认图像模型，本地使用 `ckpt_name`。
- **ksampler**：`scheduler`（normal/karras/exponential/sgm_uniform）与 `denoise`（0~1）是本地 ComfyUI 必需字段，云端适配器可忽略或映射。
- **image-output / video-output**：保存到宿主输出目录并登记输出列表；`format` / `filename` 控制命名。
- **example-node**：`executor.kind = "http"` 声明式调用第三方 API，地址为演示占位；密钥由 `${settings.apiKey}` 注入，导入需专业模式。

## 内置工作流

| 工作流 id | 文件 | 节点 | 说明 |
|---|---|---|---|
| `wf-txt2img` | `workflows/txt2img.json` | prompt-input、model-loader、empty-latent-image、ksampler、vae-decode、image-output | 默认文生图，与插件画布 fallback 同构；云端 / 本地均可运行 |
| `wf-product-shot` | `workflows/product-shot.json` | checkpoint-loader、image-props、2×clip-text-encoder、empty-latent-image、ksampler、vae-decode、image-output、note | 产品图，ComfyUI 同族全链路，本地模式亦可翻译 |
| `wf-txt2video` | `workflows/txt2video.json` | prompt-input、clip-text-encoder、video-sampler、video-output、note | 文生视频，需配置视频模型 / 视频 API |
| `wf-example` | `workflows/example.json` | text-input、example-node、image-output、note | 自定义 HTTP API 节点示例（专业模式） |

## 编写一个自定义 API 节点（专业模式）

1. 复制 `nodes/example-node.json`，把 `id` 改成新的小写 kebab-case（文件名同名），`category` 用 `custom`。
2. 把 `engine` 设为 `cloud`，`executor.kind` 设为 `"http"`，并保留 `params` 中的 `api` 字段与 `cloud.api` 声明所需 API。
3. 在 `executor.request` 里写 `url` / `method` / `headers` / `body`，用 `${inputs.xxx}`、`${params.xxx}`、`${settings.apiKey}` 占位。
4. 在 `executor.response` 里用极简 JSONPath 声明结果取值：`images`（如 `$.data[*].url`）、`text`、`error`。
5. 打开插件设置 →「专业模式」，在节点仓库面板导入该 JSON；校验不通过会返回可读错误。
6. 完整 schema 与占位符 / JSONPath 规则见 [docs/node-spec.md](docs/node-spec.md) §6。

> 安全：节点 JSON 只声明请求形状，**不得**写入真实 API Key；密钥统一走设置中的 provider（`${settings.apiKey}`）或环境凭证。

## 校验规则清单（`scripts/validate.mjs`）

- 节点：id/文件名一致、kebab-case；`category` / `engine` / 端口与参数类型枚举合法；`select` 默认值属于 `options`；`number` 默认值在 `min`/`max` 内；`executor.fn` 属于 §4 固定列表；http 节点 URL 为 http(s) 且声明 API；`local.comfyui.map` 的 `params.x` / `inputs.x` 引用真实存在。
- 工作流：`version === 1`；实例 id 唯一且形如 `n1`；`type` 指向已定义节点；`x`/`y` 数字；`params` 只含已声明参数且类型正确；连线端口存在、方向正确、类型兼容、输入端口不重复占用；必需输入不悬空；无环。
- 仓库：`manifest.json` 与 `nodes/`、`workflows/` 一一对应；`DSH_VCG/nodes`、`DSH_VCG/workflows` 与仓库副本字节一致（插件目录存在时）。

## English Abstract

**DSH_VCG_repo** is the official node/workflow repository of the VCG (Visual Control Generator) plugin for DeepSeek Harness Web GUI. It is the single source of truth for every built-in node definition and example workflow, and the plugin ships byte-identical copies under `DSH_VCG/nodes` and `DSH_VCG/workflows`.

- `nodes/*.json` follow the node schema in `dsh-vcg` CONTRACT §1/§11: id (lower-kebab-case, file name matches), localized name, category, order, engine (`cloud`/`local`/`both`), typed input/output ports, typed params with defaults, `executor` (`builtin` with one of fourteen fixed functions, or `http` for pro-mode custom API nodes), cloud capability, and optional `local.comfyui.class_type` + field `map` for ComfyUI compatibility.
- `workflows/*.json` follow the canvas persistence schema: `version/id/name/description/createdAt/updatedAt/viewport/nodes/edges`; instance ids `n1..`, node `type` referencing a definition, numeric `x/y`, parameter overrides, and edges `{from:{node,port},to:{node,port}}` with same-type-or-`any` (plus `text → conditioning`) compatibility, no dangling required inputs, no cycles.
- Fifteen built-in nodes (ComfyUI family: checkpoint-loader, clip-text-encoder, empty-latent-image, ksampler, vae-decode; pipeline: prompt-input, model-loader, image-props, image-output, video-sampler, video-output, text-input, text-output, note; custom API demo: example-node) and four workflows (txt2img, txt2video, product-shot, example) are included.
- Everything is validated by the dependency-free `node scripts/validate.mjs`, which also enforces repo/plugin byte identity.
- Documentation: node spec, workflow spec, cloud API adapters, ComfyUI compatibility & limits, and repo loading conventions (`sdk/loader.md`).

## 文档索引

- [节点定义规范 docs/node-spec.md](docs/node-spec.md)
- [工作流规范 docs/workflow-spec.md](docs/workflow-spec.md)
- [云端 API 适配 docs/cloud-api.md](docs/cloud-api.md)
- [ComfyUI 兼容 docs/comfyui-compat.md](docs/comfyui-compat.md)
- [节点包拉取 sdk/loader.md](sdk/loader.md)
- 插件契约 `DSH_VCG/CONTRACT.md`（权威）
