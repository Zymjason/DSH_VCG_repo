# 工作流规范（workflows/*.json）

本文档描述 `DSH_VCG_repo/workflows/*.json` 的文件格式、校验规则与执行语义，对应插件契约 `DSH_VCG/CONTRACT.md` §2、§11。工作流文件与画布持久化格式**同构**：画布保存的 JSON 与仓库里的示例文件结构完全一致。

---

## 1. 文件与命名

- 一个工作流一个文件：`workflows/<name>.json`。
- `id` 形如 `wf-<name>`（`^wf-[a-z0-9]+(-[a-z0-9]+)*$`），全仓库唯一；文件名可以是 `id` 或去掉 `wf-` 前缀的 id（本仓库使用后者，如 `wf-txt2img` ↔ `txt2img.json`）。
- 工作流不含可执行代码；节点实现全部来自节点定义（`nodes/*.json`）。

## 2. 顶层字段

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `version` | number | ✅ | 固定 `1`（格式版本） |
| `id` | string | ✅ | `wf-xxx`，全局唯一 |
| `name` | string | ✅ | 工作流显示名 |
| `description` | string | ✅ | 一句话说明用途 |
| `createdAt` | string | ✅ | ISO 8601 时间 |
| `updatedAt` | string | ✅ | ISO 8601 时间 |
| `viewport` | object | ✅ | `{ x, y, scale }`，画布平移 / 缩放（`scale > 0`） |
| `nodes` | array | ✅ | 节点实例，至少一个 |
| `edges` | array | ✅ | 连线，可为 `[]` |
| `zones` | array | 可选 | 画布分区（视觉分组，不参与执行），见插件 CONTRACT §14.1 |
| `models` | array | 可选 | 推荐模型下载声明（字段同 `docs/node-spec.md` §12），见下 |

## 3. 节点实例

```json
{ "id": "n4", "type": "ksampler", "x": 800, "y": 240, "params": { "seed": 42 }, "title": "采样", "engineOverride": "cloud" }
```

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 画布内唯一，形如 `n1` `n2`…（`^n[0-9]+$`） |
| `type` | string | ✅ | 必须等于某个节点定义的 `id` |
| `x` / `y` | number | ✅ | 画布坐标（节点左上角） |
| `params` | object | ✅ | 参数覆写：键必须是该节点已声明的参数，值类型必须与参数类型一致 |
| `title` | string | 可选 | 覆盖节点标题（默认 `nameZh` / `name`） |
| `engineOverride` | string | 可选 | `"cloud"` 或 `"local"`，覆盖节点 `engine` 默认值 |

- 未写入 `params` 的参数取节点定义的 `default`。
- 节点运行结果**不写入**工作流文件：由宿主返回 `results[nodeId]`，Client 仅在内存中展示。
- `x`/`y` 允许负数与小数；拖动结束后由画布回写。

## 4. 连线

```json
{ "id": "e1", "from": { "node": "n1", "port": "positive" }, "to": { "node": "n4", "port": "positive" } }
```

| 字段 | 说明 |
|---|---|
| `id` | 画布内唯一，形如 `e1` `e2`…（`^e[0-9]+$`） |
| `from.node` | 源节点实例 id，其定义必须有 `port` 这个**输出**端口 |
| `from.port` | 源输出端口 id |
| `to.node` | 目标节点实例 id，其定义必须有 `port` 这个**输入**端口 |
| `to.port` | 目标输入端口 id |

规则：

1. **一条边只连一个输出端口 → 一个输入端口**；不允许一对多或多对一。
2. **一个输入端口最多一条入边**（重复连接应替换旧边，而不是新增）。
3. 输出端口可以有多条出边（如 `prompt-input.positive` 可同时接多个节点）。
4. 类型兼容（契约 §11.2）：`from.type === to.type`，或任一端为 `any`，或 `text → conditioning`（提示词文本可直接进采样器，等价于已编码）。其它组合禁止连线。
5. **不得悬空必需输入**：节点定义中 `optional !== true` 的输入端口必须有且只有一条入边。
6. **无环**：工作流必须是 DAG（DFS 拓扑排序可完成）。自连、环都会在校验阶段报错。
7. 不禁止节点存在未使用的输出（例如调试用 `text-output` 只接不接）。

## 5. 校验清单

`node scripts/validate.mjs` 对每个工作流执行：

- [x] JSON 可解析；`version === 1`；`id` 唯一且与文件名匹配；`name` / `description` 非空；时间戳可解析
- [x] `viewport` 三个字段均为数字且 `scale > 0`
- [x] `nodes` 非空；实例 id 唯一且形如 `n1`；`type` 指向已定义节点；`x`/`y` 数字；`title` 字符串；`engineOverride` ∈ `cloud|local`
- [x] 实例 `params` 的键均已声明，值类型 / 取值范围与参数定义一致
- [x] `edges` 的 `id` 唯一；`from`/`to` 节点存在；端口存在且方向正确；类型兼容；输入端口不重复占用；必需输入不悬空
- [x] 图无环
- [x] manifest 中列出的每个工作流 id 都能找到文件，反之亦然

也可以在工作流文件被 AI 自动建流 / 手工导入时复用同一套校验（插件 `buildWorkflow` / `saveCanvas` 使用等价规则）。

## 6. 执行语义（云端模式）

1. **解析节点定义**：按 `type` 在节点表中取定义；未知 type 直接报错。
2. **引擎解析**：节点实例 `engineOverride` → 节点定义 `engine` → 全局 `state.local.enabled`。本工作流整体走云端时，`engine === "local"` 的节点不可运行（报可读错误）。
3. **拓扑排序**：按边构建 DAG 并拓扑排序，得到执行顺序 `order`；同层节点按实例在 `nodes` 中的顺序稳定执行（宿主可并行，结果与顺序无关）。
4. **输入解析**：对每个节点的每个输入端口，取上游节点对应输出端口的运行结果；未连线的可选输入回退参数 / `undefined`。若必需输入缺失或上游节点失败，该节点标记失败并中止其下游。
5. **参数解析**：实例 `params` 覆盖定义 `default`；数值型参数做范围裁剪提示而不是静默改值。
6. **执行**：按 `executor.kind` 分派（`builtin` / `http`），结果写入 `results[nodeId]`。
7. **结果结构**（契约 §6 `runWorkflow`）：

```json
{
  "runId": "run_x",
  "order": ["n1", "n2", "n3"],
  "results": {
    "n4": {
      "status": "done",
      "images": [{ "url": "https://…png", "path": "/abs/vcg-output/…png", "label": "IMAGE" }],
      "text": "",
      "error": "",
      "ms": 8123
    }
  }
}
```

- `status`：`idle` `running` `done` `error`。
- `images[]`：图片 / 视频结果（`url` 为远端或本地 `file://`，`path` 为落盘路径）。
- `text`：文本类节点（`text-output`、http 节点 `response.text`）的结果。
- `error`：失败可读信息；失败不抛出未捕获异常，由宿主汇总。
- 运行结果**不写回**工作流文件；画布刷新后结果清空，只有 `image-output` / `video-output` 落盘文件与宿主输出列表持久化。

8. **单节点运行**（`runNode`）：只执行目标节点及其必需上游子图，返回该节点 `result`；已缓存的上游结果可复用（由宿主决定）。
9. **停止**：`runWorkflow` 支持中止（`Stop`），已完成的节点结果保留；正在进行的网络请求尽力中断。
10. **输出目录**：`image-output` / `video-output` 写入 `baseDir/outputDir`（默认 `vcg-output`）；`baseDir` 优先级为项目目录 > 会话工作目录 > 宿主 cwd。

### 云端 / 本地差异

- 云端模式：整张工作流按节点逐个调用云端 API（生图 / 生视频 / 文本），`ksampler` 一次调用即完成采样 + 解码。
- 本地模式（`state.local.enabled === true` 且配置了 ComfyUI URL）：整张工作流**翻译**为 ComfyUI API prompt 一次性提交，轮询 `/history` 取图，见 [comfyui-compat.md](comfyui-compat.md)。
- 无论哪种模式，工作流 JSON 与端口语义保持一致。

## 7. 示例：默认文生图

`workflows/txt2img.json`（与插件画布 fallback 同构，契约 §11.6）：

```json
{
  "version": 1,
  "id": "wf-txt2img",
  "name": "基础文生图",
  "description": "正向/负向提示词 → 模型 → 空潜空间 → 采样 → 解码 → 输出",
  "createdAt": "2026-11-13T02:40:00.000Z",
  "updatedAt": "2026-11-13T02:40:00.000Z",
  "viewport": { "x": 0, "y": 0, "scale": 1 },
  "nodes": [
    { "id": "n1", "type": "prompt-input", "x": 60, "y": 120, "params": { "positive": "a cyberpunk corgi, neon rain", "negative": "lowres, watermark" }, "title": "提示词" },
    { "id": "n2", "type": "model-loader", "x": 420, "y": 120, "params": { "model": "" }, "title": "模型" },
    { "id": "n3", "type": "empty-latent-image", "x": 420, "y": 440, "params": { "width": 1280, "height": 720, "batch_size": 1 }, "title": "空潜空间" },
    { "id": "n4", "type": "ksampler", "x": 800, "y": 240, "params": { "seed": 42, "steps": 20, "cfg": 7, "sampler": "euler", "scheduler": "normal", "denoise": 1 }, "title": "采样" },
    { "id": "n5", "type": "vae-decode", "x": 1140, "y": 240, "params": {}, "title": "解码" },
    { "id": "n6", "type": "image-output", "x": 1420, "y": 240, "params": { "filename": "vcg-txt2img", "format": "png", "open_after": false }, "title": "图像输出" }
  ],
  "edges": [
    { "id": "e1", "from": { "node": "n1", "port": "positive" }, "to": { "node": "n4", "port": "positive" } },
    { "id": "e2", "from": { "node": "n1", "port": "negative" }, "to": { "node": "n4", "port": "negative" } },
    { "id": "e3", "from": { "node": "n2", "port": "model" }, "to": { "node": "n4", "port": "model" } },
    { "id": "e4", "from": { "node": "n3", "port": "latent" }, "to": { "node": "n4", "port": "latent" } },
    { "id": "e5", "from": { "node": "n4", "port": "image" }, "to": { "node": "n5", "port": "image" } },
    { "id": "e6", "from": { "node": "n5", "port": "image" }, "to": { "node": "n6", "port": "image" } }
  ]
}
```

说明：

- `e1`/`e2` 是 `text → conditioning` 兼容连线：引擎把提示词文本当作已编码条件。
- `empty-latent-image` 的 `width?`/`height?` 未连线，回退参数 `1280`/`720`。
- `vae-decode.vae?` 未连线（云端不需要 VAE）；本地模式需显式连接 `checkpoint-loader` 的 VAE 输出，见 `wf-product-shot`。

## 8. AI 自动建工作流（buildWorkflow）约束

插件主面板的「AI 自动组建工作流」由 `buildWorkflow` 把提示词转成工作流 JSON。产物必须满足：

1. 顶层字段完整（§2），`viewport` 使用合理初始值（`{x:0,y:0,scale:1}` 或按节点排布给 `0.8`）。
2. 只使用节点表中已存在的 `type`；节点实例 id 从 `n1` 连续编号，`x`/`y` 按列布局避免重叠。
3. 边从输出端口指向输入端口，类型兼容；每个必需输入都有且只有一条入边；图为 DAG。
4. `params` 只覆盖已声明的参数且类型正确。
5. 引擎可用性：视频节点需要视频 provider；本地模式下的节点必须都有 ComfyUI 映射。
6. 若模型返回不合法结构，宿主必须校验失败并给出可读错误（保留上一次画布内容），不得把非法工作流写进画布。

## 9. 画布持久化

- 画布状态以工作流 JSON 为准；宿主按 key 保存：`session:<sessionId>`（会话画布）或 `project:<projectId>`（项目画布）。
- `getCanvas` 返回 `{workflow, updatedAt}`；无历史时返回内置 `txt2img` 作为 fallback。
- 运行结果、选中节点、缩放以外的临时 UI 状态不写入持久化 JSON。
- 节点坐标允许负值；画布 `fit` 时以节点包围盒为准。


---

## 8. 推荐模型声明（`models`，可选）

工作流可在顶层声明整条流程推荐/需要的权重文件，字段与节点定义 `models` 完全一致（见 `docs/node-spec.md` §12）：

```json
"models": [
  {
    "name": "VCG 示例权重",
    "filename": "vcg-tiny.safetensors",
    "url": "https://github.com/Zymjason/DSH_VCG_repo/raw/main/assets/tiny-safetensors/vcg-tiny.safetensors",
    "sha256": "…",
    "size": 88,
    "format": "safetensors",
    "required": true
  }
]
```

客户端在打开工作流或运行前会汇总节点级 + 工作流级 `models`，展示下载入口与可信源状态；来自非可信主机的下载需二次确认。`models` 不参与图校验与执行，可安全省略。示例见 `workflows/local-inspect.json`。
