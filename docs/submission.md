# 提交节点 / 工作流（submission）

本文面向投稿者，说明如何把新的节点或工作流通过 Pull Request 提交到
`DSH_VCG_repo`。分支模型、标签、权限与管理员配置见
[review-policy.md](./review-policy.md)；字段规范见
[node-spec.md](./node-spec.md)、[workflow-spec.md](./workflow-spec.md)。

---

## 1. 一句话规则

> **一次 PR 只提交 1 个文件**：节点 → `nodes/<id>.json`，工作流 → `workflows/<id>.json`；
> **PR 目标分支是 `dev`**；**不要改 `manifest.json`**（维护者合并后统一维护）；
> 正文按 PR 模板声明 `type` / `files` / `submitter` / 可选 `supersedes`。

`manifest.json` 由维护者在审核通过后更新；投稿 PR 修改 manifest 会被审计判为
“文件路径与声明类型不匹配”而失败。

## 2. 提交前本地校验

需要 Node.js ≥ 18（仓库零依赖，无需 `npm install`）：

```bash
node scripts/validate.mjs
```

输出 `结果: PASS` 即可。若失败，按 `错误 (N)` 逐条修复（文件名必须等于 `<id>.json`、
端口/参数/连线/默认值等规则见 node-spec / workflow-spec）。

可选：本地模拟 CI 审计（不 push、不联网）：

```bash
cat > /tmp/pr-body.md <<'EOF'
type: node
files: nodes/my-node.json
submitter: @my-login
EOF

node scripts/audit-submission.mjs \
  --files nodes/my-node.json \
  --body-file /tmp/pr-body.md \
  --author my-login --pr 1 --base-ref dev \
  --skip-refs \
  --json-out /tmp/audit-report.json --md-out /tmp/audit-comment.md
```

> 本地仓库通常没有 `dev`/`bug`/`recheck` 分支，跨分支重复检测会优雅降级；
> CI 会对比全部治理分支。

## 3. 节点 JSON 要点

- 必填：`id`（kebab-case，与文件名一致）、`name`、`nameZh`、`category`、`order`、
  `description`、`engine`、`inputs`、`outputs`、`params`、`executor`、`cloud`、`ui`。
- `executor.kind ∈ builtin|http|comfy|local`；`builtin` 与 `local` 的 `fn` 必须在固定白名单
  （见 `docs/node-spec.md` §4 与 CONTRACT §16.6）。
- `params[].type ∈ text|textarea|number|select|toggle|model`。
- 本地执行节点（`engine: "local"` / `executor.kind: "local"`）仍需要 `cloud.capability`（可为 `none`）。
- 可选 `models[]` 模型声明，见 §6。

参考：`nodes/note.json`（最小节点）、`nodes/local-safetensors-inspect.json`（本地节点 + 模型声明）。

## 4. 工作流 JSON 要点

- 顶层字段：`version: 1`、`id`（`wf-` 前缀，且与文件名对应）、`name`、`description`、
  `createdAt`/`updatedAt`（ISO）、`viewport`、`nodes`、`edges`；可选顶层 `models[]`。
- `nodes[].type` 必须是仓库中已存在的节点 `id`（工作流不能“自带”节点定义）。
- 每个必需输入端口必须且只能有一条入边；禁止环；端口类型必须兼容。
- 节点实例 id 形如 `n1`、`n2`；连线 id 形如 `e1`。

参考：`workflows/txt2img.json`、`workflows/local-inspect.json`（含顶层 `models[]`）。

## 5. 创建 PR

1. 从最新 `main` 建分支（或 fork）：

   ```bash
   git fetch origin
   git checkout -b submit/my-node origin/main
   # 只放 1 个目标文件
   git add nodes/my-node.json
   git commit -m "feat(nodes): add my-node"
   git push origin submit/my-node
   ```

2. 在 GitHub / Gitea 创建 **目标分支 `dev`** 的 Pull Request，正文保留声明字段：

   ```
   type: node
   files: nodes/my-node.json
   submitter: @my-login
   supersedes:
   ```

   - `type`：`node` 或 `workflow`；
   - `files`：本次唯一变更文件，必须与类型匹配；
   - `submitter`：你的用户名（必须与 PR 作者一致，防止代提交）；
   - `supersedes`：仅重新提交时填写旧 PR 编号（如 `#12`）。

3. 等 CI 自动审计（约 1 分钟）。评论中会显示：
   - 结果（通过 / 未通过）；
   - 文件 sha256、结构校验结果；
   - 错误（必须修复）与警告（仅提示）；
   - 跨分支重复（`main`/`dev`/`bug`/`recheck`；普通 PR 与 `main`/`dev` **内容完全相同**即 **error** 打回 `bug`；同 id/文件名但内容不同视为更新仅 warning；`bug`/`recheck` 留档仅 warning）；
   - `models[]` 的可信源/完整性信息。
   

## 6. 模型声明 `models[]`（可选）

节点或工作流顶层可声明运行所需/推荐权重（字段与规范见
[node-spec.md §12](./node-spec.md) / [workflow-spec.md §8](./workflow-spec.md)）：

```json
"models": [
  {
    "name": "VCG 示例权重",
    "filename": "vcg-tiny.safetensors",
    "url": "https://github.com/Zymjason/DSH_VCG_repo/raw/main/assets/tiny-safetensors/vcg-tiny.safetensors",
    "sha256": "fa2216793dde3860c83fdd207c4a67a5e60265d32f14fd9fc4ccfad49e12542d",
    "size": 88,
    "format": "safetensors",
    "license": "MIT",
    "required": false
  }
]
```

审计规则：

| 字段 | 规则 | 违反后果 |
|---|---|---|
| `filename` | 只允许 `A-Z a-z 0-9 . _ -`，禁止 `/`、`\`、`..` | **error（阻断）** |
| `url` | 必须存在；非 https 会标记不安全 | 缺失/非法 = error；非 https = **warning** |
| `format` | `safetensors` `ckpt` `pt` `pth` `bin` `gguf` | error（阻断） |
| `size` | 正整数（字节） | 非法 = error；缺失 = warning |
| `sha256` | 64 位十六进制 | 非法 = error；缺失 = **warning** |
| 主机 | 与仓库根 `trusted-sources.json` 比对（huggingface.co / modelscope.cn / civitai.com / github.com） | 不可信 = **warning（不阻断）** |

- 警告**不会阻止上传**，但客户端下载不可信来源权重时会二次确认；强烈建议提供 `sha256`。
- 不要把权重文件直接提交进仓库（示例小文件 `assets/tiny-safetensors/` 除外）；用 https 链接 + 校验值。
- 缺失 `sha256` / 不可信主机不会导致 PR 失败，但维护者可能要求补充。

## 7. 审计失败怎么办

- PR 会保留打开状态，文件被自动复制到 `bug` 分支留档（不会影响你的分支）。
- 按评论里的 **错误** 逐条修复（不要只改评论里没提的字段），本地跑
  `node scripts/validate.mjs` 确认后，在**同一个 PR 分支**继续 `git push`：
  CI 收到 `synchronize` 事件后重新审计并更新评论。
- 注意：普通 PR 中与 **`main`/`dev` 内容完全相同即 error**（重复提交/重复内容）；同 id/文件名
  但内容不同视为更新，仅 warning 交人工审查。`bug`/`recheck` 只是留档，命中时仅 warning，
  因此修正后可在新 PR 重新提交；
  **Issue 复核流程**（§9，自动 `--allow-duplicates`），或先与维护者确认清理 `bug` 留档。
- 常见错误速查：

| 评论里的错误 | 修复方法 |
|---|---|
| `提交必须且只能包含 1 个文件` | 把 PR 缩小到单个 `nodes/*.json` 或 `workflows/*.json`；manifest 等改动拆走 |
| `文件路径不匹配` | 检查 `type` 与路径：node → `nodes/<id>.json`；workflow → `workflows/<id>.json` |
| `文件名必须等于 <id>.json` | 文件重命名或改 JSON 里的 `id`，二者必须一致 |
| `正文缺少 type/files/submitter 声明` | 按模板补全声明字段（注意用英文冒号 `:`） |
| `submitter 与 PR/Issue 作者不一致` | 填写 PR 作者本人用户名，或由作者本人提交 |
| `PR 目标分支必须是 dev` | 把 PR base 改成 `dev`（禁止直接向 main 提交） |
| `executor.fn 不在固定列表` | 使用 node-spec §4 白名单里的 fn；本地节点用 §16.6 白名单 |
| `必需输入 ... 没有连线` / `类型不兼容` / `存在环` | 修正 `edges`（端口 id、方向、类型、DAG） |
| `models[x].filename ...` | 去掉路径分隔符/`..`，只保留纯文件名 |
| `models[x].format 非法` | 改用 `safetensors|ckpt|pt|pth|bin|gguf` |
| `models[x].sha256 必须是 64 位...` | 修正为 64 位 hex（`sha256sum 文件` 获取） |
| `重复提交/重复内容（自动审计不通过）` | 普通 PR 不允许与 `main`/`dev` 内容完全相同：确认内容 sha256 未与正式分支相同；更新已有节点（同 id、内容不同）只警告；`bug`/`recheck` 留档重复仅 warning |

## 8. 重新提交与 supersedes

- 同一节点修改后重新提交：新开 PR，正文写 `supersedes: #旧PR号`。
- 若旧 PR 已审计失败（文件已留档 `bug`），新 PR 不会因 `bug` 留档被阻断；修正后可直接重新提交并引用
  `supersedes: #旧PR`。
- CI 校验：旧 PR 作者与新 PR 作者相同、旧 PR 仍未合并且处于 open；通过后自动在旧 PR
  评论并关闭旧 PR，新 PR 重新审计。
- 校验不通过（作者不同 / 已合并 / 已关闭）时，CI 只会在新 PR 评论说明，不会关闭旧 PR。

## 9. Issue 复核（recheck）

如果节点/工作流已在 `bug` 分支、需要重新复核：

1. 用 `.github/ISSUE_TEMPLATE/node-issue.yml`（Gitea 用 `.gitea/ISSUE_TEMPLATE/node-issue.md`）
   创建 Issue，填写提交类型、被引用文件、提交者、复核原因。
2. CI 审计引用文件（自动从 `bug`/`dev` 等分支读取）→ 评论报告 → 复制到 `recheck` →
   打 `recheck:pending`。
3. 维护者打 `recheck:approved`（合并 `recheck` 到 `main`）或 `recheck:rejected`
   （复制到 `bug`）。

## 10. 不要做的事

- ❌ 不要直接 push `main` / `dev`（分支保护会拒绝，且违反 CONTRACT §16.1）。
- ❌ 不要在一个 PR 里混入节点与工作流两个文件，或顺手改 `manifest.json`、文档、脚本。
- ❌ 不要提交可执行代码、脚本、混淆字段；节点/工作流 JSON 只做声明。
- ❌ 不要在 JSON 中写 token、cookie、内网地址等敏感信息。
- ❌ 不要提交大体积权重文件（示例权重除外）。

## 11. 维护者合并后的流程

审计通过 + `status:approved` 后，CI 会自动：

1. 把 PR 合并到 `dev`；
2. 创建/复用 `dev → main` PR 并合并到 `main`；
3. 每日 22:00（北京时间）镜像任务把 `main`、`dev`、`bug`、`recheck` 与所有 tag
   双向同步到 GitHub / Gitea（见 review-policy §7）。

插件默认只读取 `main`；`dev`/`bug`/`recheck` 内容在客户端需要开启开发者模式（`devMode`）
才会出现，并显示“未审核”徽标（CONTRACT §16.4）。