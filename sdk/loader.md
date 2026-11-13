# 节点包拉取约定（SDK / Loader）

本文档说明插件（以及第三方工具）如何从 **DSH_VCG_repo** 拉取节点与工作流包，包括 URL 约定、加载顺序、校验、缓存与版本兼容。

## 1. 仓库地址

默认提供两个同步源（可在设置中切换 / 自定义）：

| 源 | raw base |
|---|---|
| GitHub | `https://raw.githubusercontent.com/Zymjason/DSH_VCG_repo/main` |
| Gitea | `https://gitea.com/ZymJason_DSH/DSH_VCG_repo/raw/branch/main` |

base URL 由设置项 `state.nodeRepo.githubBase` / `state.nodeRepo.giteaBase` 提供；同步完成后把结果写入 `state.nodeRepo.lastSyncAt` 与 `state.nodeRepo.source`（记录来源标识）。

自定义镜像只需提供相同的目录结构，base 指向仓库根即可：

```
<base>/manifest.json
<base>/nodes/<id>.json
<base>/workflows/<name>.json
```

## 2. 包结构

```
manifest.json
nodes/<id>.json          # id 与文件名一致
workflows/<name>.json    # id 形如 wf-<name>
```

`manifest.json`：

```json
{
  "version": "1.0.0",
  "nodes": ["prompt-input", "text-input", "…"],
  "workflows": ["wf-txt2img", "wf-txt2video", "wf-product-shot", "wf-example"],
  "minPluginVersion": "1.0.0"
}
```

| 字段 | 说明 |
|---|---|
| `version` | 仓库版本（语义化版本） |
| `nodes` | 全部节点 id，必须与 `nodes/` 目录文件一一对应 |
| `workflows` | 全部工作流 id，必须与 `workflows/` 目录文件一一对应 |
| `minPluginVersion` | 加载本仓库所需的最低插件版本；低于该版本的插件应回退内置副本 |

## 3. 加载流程

1. `GET <base>/manifest.json`（带 `cache: 'no-store'`），解析并校验字段。
2. 比较 `manifest.minPluginVersion` 与当前插件版本；不满足则中止并保留内置副本。
3. 并行 `GET <base>/nodes/<id>.json`（按 `manifest.nodes` 顺序）。
4. 并行 `GET <base>/workflows/<id>.json`（文件名为 `id` 或去掉 `wf-` 前缀的 id；优先直接 `<id>.json`，404 时尝试 `<name>.json`）。
5. 对每个拉取结果执行与 `scripts/validate.mjs` 等价的校验（节点 schema、id 唯一、工作流引用完整性）。
6. **全部成功**才整体替换当前节点包；任何文件失败 / 校验失败 → 整体回退内置副本，并在返回结果中带可读错误，不保留半新半旧状态。
7. 写回 `state.nodeRepo.lastSyncAt`、`state.nodeRepo.source`。

同步结果的返回结构（`syncNodeRepo` RPC）：

```json
{ "nodes": [ /* 节点定义数组 */ ], "workflows": [ /* 工作流数组 */ ], "syncedAt": "2026-11-13T02:40:00.000Z" }
```

节点列表（`listNodes`）额外返回 `{ syncedAt, source, builtinCount }`，便于设置页显示"内置 15 + 仓库同步"。

## 4. 缓存与降级

- 同步结果缓存在宿主数据目录（`data/dsh-vcg/`）下，插件启动时优先读缓存，其次读内置副本 `DSH_VCG/nodes` / `DSH_VCG/workflows`。
- 网络不可用 / 仓库 404 / 校验失败：使用缓存或内置副本，不阻塞插件启动。
- 内置副本由发布流程保证与仓库字节一致（`node scripts/validate.mjs` 校验）。
- 离线环境可把仓库整个目录放到本地并用 `file://` 之外的自建 HTTP 服务提供；插件只支持 `http(s)` 源。

## 5. 拉取示例（Node / 浏览器通用）

```js
const base = 'https://raw.githubusercontent.com/Zymjason/DSH_VCG_repo/main'

const res = await fetch(`${base}/manifest.json`, { cache: 'no-store' })
if (!res.ok) throw new Error(`manifest 拉取失败: HTTP ${res.status}`)
const manifest = await res.json()

const nodes = await Promise.all(manifest.nodes.map(async (id) => {
  const response = await fetch(`${base}/nodes/${id}.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`节点 ${id} 拉取失败: HTTP ${response.status}`)
  return response.json()
}))

const workflows = await Promise.all(manifest.workflows.map(async (id) => {
  const name = id.replace(/^wf-/, '')
  let response = await fetch(`${base}/workflows/${id}.json`, { cache: 'no-store' })
  if (response.status === 404) response = await fetch(`${base}/workflows/${name}.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`工作流 ${id} 拉取失败: HTTP ${response.status}`)
  return response.json()
}))

// 校验：id 唯一、manifest 与文件一致、工作流引用完整（见 scripts/validate.mjs）
```

注意：浏览器直连 GitHub raw 可能受 CORS 限制；插件侧建议由 Host 发起拉取（Node `fetch`），或使用支持 CORS 的镜像。

## 6. 校验约定

拉取后的节点 / 工作流必须通过与 [scripts/validate.mjs](../scripts/validate.mjs) 等价的检查：

- 节点：schema 完整、id / 文件名一致且唯一、端口与参数类型合法、`executor` 合法、ComfyUI map 引用存在。
- 工作流：`version === 1`、节点 `type` 存在、连线端口存在且类型兼容、必需输入不悬空、无环。
- 包级：manifest 与目录一一对应。

第三方工具可直接复用该脚本：

```bash
node scripts/validate.mjs        # 退出码 0 表示通过
```

## 7. 自定义节点导入（专业模式）

- 设置中打开「专业模式」后，可导入单个节点 JSON（`importNode` RPC）。
- 导入要求 `executor.kind === "http"` 且 `url` 为 http(s)；其余 schema 校验同内置节点。
- `id` 冲突时需显式覆盖（`overwrite: true`），内置节点建议保留原 id 前缀避免冲突。
- 导入节点只保存在宿主数据目录，不写回本仓库；不建议把含真实 API Key 的节点 JSON 提交到仓库。

## 8. 发布流程

1. 修改 `nodes/` / `workflows/` 与 `docs/`。
2. `node scripts/validate.mjs` 必须通过。
3. 同步内置副本：
   ```bash
   cp -a DSH_VCG_repo/nodes/. DSH_VCG/nodes/
   cp -a DSH_VCG_repo/workflows/. DSH_VCG/workflows/
   ```
4. 更新 `manifest.json` 的 `version`（新增节点 / 工作流 bump 小版本；改名 / 删端口等破坏性变更 bump 主版本并同步 `minPluginVersion`）。
5. 提交并推送到 GitHub 主仓库，同时镜像到 Gitea 源（两个 raw base 内容一致）。
6. 打 tag（如 `v1.1.0`），发布说明列出新增 / 变更节点与工作流。

## 9. 版本兼容

- 插件启动时比较自身版本与 `minPluginVersion`；不满足则使用内置副本并在设置页提示"节点仓库需要更新插件"。
- 新增节点属于向后兼容变更；删除 / 重命名节点 `id`、端口名、参数名属于破坏性变更，插件必须在加载时对未知 `type` 给出可读错误而不是崩溃。
- 工作流文件可跨仓库小版本复用；破坏性变更时建议新增工作流文件而不是原地修改。
