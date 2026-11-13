# VCG 仓库审查与自动化策略（review-policy）

本文实现 `DSH_VCG/CONTRACT.md` §16.1–§16.3：分支模型、上传审计、人工审查标签、
Issue 复核与每日镜像同步。所有命令均在仓库根目录运行，零外部依赖（Node.js ≥ 18、
git、bash、curl）。

---

## 1. 分支模型

| 分支 | 用途 | 谁能写入 | 保护建议 |
|---|---|---|---|
| `main` | 人工审核通过的稳定内容；插件默认只读取该分支 | 仅 CI（`status:approved` / `recheck:approved` 合并） | 保护：禁止直接 push、要求 PR + 至少 1 人 review、允许 CI bot 合并 |
| `dev` | 已提交、待人工审核（PR 目标分支） | 投稿者通过 PR、CI 自动合并 | 保护：禁止直接 push、要求 CI 检查 `audit:passed` |
| `bug` | 审计不通过 / 人工拒绝（打回区） | 仅 CI | 一般不保护 |
| `recheck` | Issue 触发的复核暂存区 | 仅 CI | 一般不保护 |

- **所有上传只能走 Pull Request**，目标分支必须是 `dev`。直接 push `main` 或 `dev` 都会被 CI/分支保护拒绝。
- 人类审查在 `dev` 上完成；`status:approved` 后 CI 先把 PR 合入 `dev`，再把 `dev` 合并到 `main`。
- `bug` / `recheck` 是**收集区**，用于保留不合规或被拒绝的内容，避免丢失投稿；它们不会进入插件可用的 `main`。

## 2. 自动化工作流清单

| 文件 | 触发 | 作用 |
|---|---|---|
| `.github/workflows/audit-pr.yml` | PR opened/edited/synchronize/reopened/labeled（目标 `dev`） | 解析声明 → 审计 → 评论报告 → `audit:passed`/`audit:failed`；失败复制到 `bug`；处理 `supersedes`；`status:approved` 合并到 `main`；`status:rejected` 复制 `bug` |
| `.github/workflows/audit-issue.yml` | Issue opened/edited/labeled | 解析模板引用 → 审计 → 评论 → `recheck:pending` → 复制到 `recheck`；`recheck:approved` 合并 `main`；`recheck:rejected` 复制 `bug` |
| `.github/workflows/sync-gitea.yml` | cron `0 14 * * *`（UTC，北京 22:00）+ 手动 | GitHub → Gitea 全部分支 + tag 镜像 |
| `.gitea/workflows/audit-pr.yml` | 同上（Gitea） | Gitea Actions 等价实现 |
| `.gitea/workflows/audit-issue.yml` | 同上（Gitea） | Gitea Actions 等价实现 |
| `.gitea/workflows/sync-github.yml` | cron `0 14 * * *` UTC + 手动 | Gitea → GitHub 全部分支 + tag 镜像 |

所有平台 API 调用都用 `curl` 完成（评论、标签、合并、关闭 PR），不依赖
`actions/github-script` 等 marketplace action；只使用官方 `actions/checkout` 取代码。

### 2.1 审计/路由脚本从 base 分支运行

PR 审计时，`audit-submission.mjs` / `route-branch.mjs` 优先从 **PR 目标分支（base）** 的
worktree 运行，而不是 PR head 上的版本。这样可以避免投稿者在 PR 里篡改审计逻辑来绕过
检查（只影响 CI，不影响本地脚本）。若 base 分支还没有这两个脚本（首次引入 PR），回退到
PR head 版本。

### 2.2 Issue 文件来源

Issue 复核引用的文件可能只存在于 `bug` / `dev` 分支：`audit-submission.mjs` 会先查工作区，
再依次用 `git show` 从 `dev`/`main`/`bug`/`recheck` 读取（报告 `files[].source` 会注明来源）。

## 3. 标签（labels）

CI 与人工都通过标签驱动流程。首次使用时 CI 会尝试自动创建标签；若 token 权限不足，
请按下表手动创建：

| 标签 | 颜色建议 | 谁设置 | 含义 / 动作 |
|---|---|---|---|
| `audit:passed` | 绿 `#0e8a16` | CI | 自动审计通过，等待人工审查 |
| `audit:failed` | 红 `#b60205` | CI | 自动审计失败；文件已复制到 `bug`，PR 保持打开 |
| `status:approved` | 深绿 `#1a7f37` | 维护者 | 人工通过：CI 合并 PR 到 `dev`，再把 `dev` 合并到 `main` |
| `status:rejected` | 深红 `#a40e26` | 维护者 | 人工拒绝：CI 复制文件到 `bug`，**不自动关闭 PR** |
| `recheck:pending` | 黄 `#fbca04` | CI | Issue 复核已受理，等待人工 |
| `recheck:approved` | 绿 `#0e8a16` | 维护者 | Issue 复核通过：CI 合并 `recheck` 到 `main` |
| `recheck:rejected` | 红 `#b60205` | 维护者 | Issue 复核拒绝：CI 复制文件到 `bug` |

CI 只维护 `audit:*` / `recheck:pending`，不会清除人工的 `status:*` / `recheck:approved|rejected`。

## 4. Pull Request 审查流程

1. **投稿**：fork 或在仓库内新建分支（不要直接改 `main`），只提交 1 个文件
   （`nodes/<id>.json` 或 `workflows/<id>.json`），**不要改 `manifest.json`**。
   按 `.github/PULL_REQUEST_TEMPLATE.md` / `.gitea/PULL_REQUEST_TEMPLATE.md` 填写声明。
2. **CI 审计**（`audit-pr.yml`）：
   - 解析 `type` / `files` / `submitter` / `supersedes`；
   - 校验路径与类型匹配（node 只允许 1 个 `nodes/*.json`；workflow 只允许 1 个 `workflows/*.json`）；
   - 复用 `scripts/lib/validate-core.mjs` 做结构与规范校验（与 `node scripts/validate.mjs` 同规则）；
   - 跨分支重复检测（对比 `main`/`dev`/`bug`/`recheck` 的 id、文件名、内容 sha256；普通 PR 与 `main`/`dev` **内容完全相同**即 error；同 id/文件名但内容不同视为更新、仅 warning 交人工审查；`bug`/`recheck` 留档命中仅 warning）；
   - `models[]` 声明安全审计（见 §6）；
   - 评论 Markdown 报告；打 `audit:passed` 或 `audit:failed`。
3. **审计失败**：文件复制到 `bug` 分支，PR 保持打开。投稿者修正后在同一 PR push 新提交，
   `synchronize` 事件会重新审计并覆盖评论。
4. **人工审查**：
   - 通过 → 打 `status:approved`：CI 先把 PR 合入 `dev`，再创建/复用 `dev → main` PR 合并到 `main`；
   - 拒绝 → 打 `status:rejected`：CI 评论并复制文件到 `bug`，**不自动关闭 PR**。
5. **重新提交（supersedes）**：新 PR 正文写 `supersedes: #N`。
   CI 校验 `#N` 与新 PR **作者相同**且 **未合并、仍 open**；通过后在旧 PR 评论并关闭旧 PR，
   新 PR 正常重新审计。校验不通过会在新 PR 评论说明原因（不会误关旧 PR）。
   注意：审计失败的文件会留档 `bug`，但 `bug`/`recheck` 命中重复只提示不阻断，因此修正后
   可在新 PR（带 `supersedes: #N`）重新提交并重新审计。

> 标签操作需要写权限：手动添加/删除 `status:*` / `recheck:*` 需要维护者权限。

## 5. Issue 复核流程（recheck）

1. 用 `.github/ISSUE_TEMPLATE/node-issue.yml`（或 `.gitea/ISSUE_TEMPLATE/node-issue.md`）创建 Issue，
   填写：提交类型、被引用文件、提交者、可选 `supersedes`、复核原因。
2. CI 审计引用文件（此流程固定加 `--allow-duplicates`，重复只警告不阻断）→ 评论报告 →
   复制到 `recheck` 分支 → 打 `recheck:pending`。
3. 维护者复核：`recheck:approved` → 合并 `recheck` 到 `main`；`recheck:rejected` → 复制到 `bug`。
4. Issue 的 `submitter` 必须与 Issue 作者一致（防止代提交）。

## 6. 审计规则（errors vs warnings）

阻断项（`audit:failed`）：

- 声明缺失/非法：`type` 不是 `node|workflow`，`files` 缺失或多于 1 个，路径与类型不匹配，
  `submitter` 缺失或与 PR/Issue 作者不一致，PR 目标分支不是 `dev`，`supersedes` 格式非法；
- 结构/规范：违反 `docs/node-spec.md` / `docs/workflow-spec.md`（id、文件名、executor.fn、
  ports、params、连线、悬空必需输入、环、manifest 一致性等）；
- `models[]` 硬错误：`filename` 缺失/含路径分隔符或 `..`、`url` 缺失或非法 URL、`format` 缺失或不在
  `safetensors|ckpt|pt|pth|bin|gguf`、`size` 非正整数、`sha256` 非 64 位 hex；
- **重复提交 / 重复内容（普通 PR）**：提交的文件内容与 `main`/`dev` 已有文件**完全相同**
  （sha256 一致）→ **error**，报告逐项列出 `分支 / 文件 / id / sha256`，CI 打 `audit:failed`
  并把文件打回 `bug` 分支。这是 §16.1 的“自动审核重复提交/重复内容”要求。
- **更新已有节点/工作流**：id 或文件名已存在于 `main`/`dev` 但内容不同 → 仅 warning
  （“更新已有内容，交人工审查”），不阻断正常维护与迭代。
- **命中 `bug`/`recheck` 留档**：只提示 warning，不阻断——否则审计失败被打回后，修正版本
  将永远无法重新提交。

仅警告（**不阻止上传**，报告列出）：

- URL 非 https；URL 主机不在 `trusted-sources.json`；缺 `sha256`；缺 `size`；缺 `name`；
- **Issue 复核（`--allow-duplicates` / `AUDIT_ALLOW_DUPLICATES=1`）场景下的跨分支重复**：
  复核本来就是把已有内容移入 `recheck`，因此重复只提示不阻断；
- 缺失对比分支、非 git 仓库等降级提示。

> 重复检查只针对“内容完全相同”的重复提交；更新已有节点/工作流（同 id、内容不同）只提示，
> `bug`/`recheck` 留档命中也不阻断，因此修正后可以正常重新提交（建议带 `supersedes: #N`）。

模型声明规范见 `docs/node-spec.md` §12、`docs/workflow-spec.md` §8；可信源清单见根目录
`trusted-sources.json`，由维护者审核更新。

## 7. 每日镜像同步

- 时间：`0 14 * * *` UTC = **每天 22:00 Asia/Shanghai**；GitHub Actions 与 Gitea Actions 各一个。
- 方向：GitHub → Gitea（`secrets.GITEA_TOKEN`）；Gitea → GitHub（`secrets.GH_TOKEN`）。Gitea 仓库的审计/合并使用内置 `github.token`（Gitea 不允许创建 `GITEA_*`/`GITHUB_*` 名称的 secret）。
- 内容：**所有分支 + tag**。规则（`scripts/sync-mirrors.mjs`）：
  - 目标缺失（`missing`）或目标落后（`behind`：目标 tip 是源 tip 的祖先）→ `git push --force-with-lease`；
  - 目标领先（`target-ahead`）或分叉（`diverged`）→ 跳过并在报告注明（由反方向任务处理），
    避免覆盖对端多出的提交；确需强制覆盖分叉时用 `--force-diverged`；
  - 单个分支/tag 失败不阻塞其它项，汇总后以退出码反映（1 = 有失败）。
- CI 日志输出逐分支摘要；`--json-out sync-report.json` 可获取机器可读报告。
- 手动触发：GitHub Actions → `sync-gitea` → Run workflow；Gitea Actions → `sync-github` → Run。
- 本地演练：

```bash
# 只报告不推送（仍会 fetch 到 refs/vcg-mirror/* 判断落后/分叉）
node scripts/sync-mirrors.mjs --source origin --target /tmp/mirror.git --dry-run

# 用本地 bare 仓库做端到端演练（不会碰远端）
git init --bare /tmp/mirror.git
node scripts/sync-mirrors.mjs --source . --target /tmp/mirror.git
```

## 8. 权限、Secrets 与分支保护配置

以下配置**必须由仓库管理员在平台网页上手动完成**（仓库代码中不包含任何真实 token）：

### GitHub（`ZymJason/DSH_VCG_repo` 或实际仓库）

1. **Actions 权限**：Settings → Actions → General → Workflow permissions → 选择
   **Read and write permissions**（评论/标签/推送 `bug`/合并 PR 需要）。
2. **Secrets**：Settings → Secrets and variables → Actions → New repository secret：
   - `GITEA_TOKEN`：Gitea 访问令牌（scope 需能 push 该仓库的所有分支/tag），供 `sync-gitea` 使用。
3. **Variables（可选，均有默认值）**：`GITEA_HOST`（默认 `gitea.com`）、`GITEA_OWNER`
   （默认 `ZymJason_DSH`）、`GITEA_REPO`（默认 `DSH_VCG_repo`）、`GITEA_USER`
   （默认同 `GITEA_OWNER`，用于 HTTPS basic auth 用户名）。
4. **分支保护**：Settings → Branches → Add rule：
   - `main`：Require a pull request before merging（≥1 approval）、Require status checks（job 名 `audit`，工作流 `audit-pr`）、
     Do not allow bypassing（或把 CI bot 加入 bypass 列表，否则 `status:approved` 自动合并会失败）；
   - `dev`：Require a pull request、Require status checks（job 名 `audit`，工作流 `audit-pr`）、禁止直接 push。
5. **标签**：建议按 §3 手动预建（CI 在权限足够时也会自动创建）。

### Gitea（`gitea.com/ZymJason_DSH/DSH_VCG_repo` 或实际仓库）

1. **Secrets**：仓库 → Settings → Actions → Secrets：
   - 审计/合并使用内置 `github.token`（无需 `GITEA_TOKEN`；Gitea 禁止该 secret 名）；如需自定义请用其它名称并改工作流。原 `GITEA_TOKEN` 说明（repo 写权限，若 `github.token` 已具备可省略，
     工作流会自动回退到 `github.token`）；
   - `GH_TOKEN`：GitHub PAT（`repo` scope），供 `sync-github` 使用。
2. **Variables（可选）**：`GH_OWNER`（默认 `ZymJason`）、`GH_REPO`（默认 `DSH_VCG_repo`）、
   `GITEA_USER`；Gitea 版本较旧不支持 vars 时，可直接修改 `.gitea/workflows/sync-github.yml`
   中的默认值。
3. **分支保护**：仓库 → Settings → Branches：保护 `main`（禁止直接 push、要求 PR 审查）；
   `dev` 建议要求 PR 且通过 Actions 检查。
4. **Actions 仓库权限**：确保 Actions 有写权限（Settings → Actions → 允许 workflow 写仓库内容）。

### Token 安全

- 只在平台 Secrets 中保存；工作流中用环境变量传递，脚本输出的 URL 会做 `***` 脱敏。
- 日志中若出现疑似 token，请立即轮换。建议 token 使用最小权限、定期轮换。
- 审计脚本不会执行投稿 JSON 里的任何代码（只做 schema/字段校验）。

## 9. 本地验证命令

```bash
# 整仓校验（投稿前后都应通过）
node scripts/validate.mjs

# 模拟一次 PR 审计（--repo-root 指向待测仓库；不 push）
node scripts/audit-submission.mjs \
  --files nodes/my-node.json \
  --body-file /tmp/pr-body.md \
  --author alice --pr 42 --base-ref dev \
  --json-out /tmp/audit-report.json --md-out /tmp/audit-comment.md

# 模拟 Issue 复核（引用已有内容，重复只警告）
node scripts/audit-submission.mjs \
  --body-file /tmp/issue-body.md --allow-duplicates \
  --author alice --pr 77 --json-out /tmp/issue-report.json

# 分支路由（本地只写分支，不 push；验证后可重置）
node scripts/route-branch.mjs --target bug --files nodes/my-node.json \
  --ref auto --no-push --dry-run

# 镜像同步演练
node scripts/sync-mirrors.mjs --source . --target /tmp/mirror.git --dry-run
```

审计器退出码：`0` 通过、`1` 未通过、`2` 参数/环境错误；报告 JSON 字段：
`{ok, declaredType, declaration, files, duplicates, refs, trust, errors, warnings, summary}`。

## 10. 已知限制

1. **fork PR 的只读 token**：GitHub `pull_request` 事件对 fork PR 只给只读 token，
   评论/贴标签/推送 `bug` 分支会失败（日志有 `::warning::`）。处理方式：维护者在同仓库
   建分支后重新提交，或先合并/手动执行审计（`node scripts/audit-submission.mjs ...`）。
2. **审计脚本以 base 分支版本运行**：这是安全设计，但也意味着“修改审计器”的 PR 不会用
   自己版本做验证；合并后下一次 PR 才会生效。
3. **Gitea 版本差异**：Gitea Actions 的 `pull_request` 事件名/字段在不同版本略有差异，
   `.gitea/workflows/*` 未指定 `types` 而是在 step 里过滤 `github.event.action`；
   `vars` 上下文在较旧 Gitea 不可用，此时改用文件中的默认值。Gitea 实例若无法拉取
   `actions/checkout`，可把 checkout step 换成 `git clone`（见下方片段）。
4. **重复只阻断“完全相同”的内容**：普通 PR 与 `main`/`dev` 内容 sha256 完全相同才 error 并
   打回 `bug`；同 id/文件名但内容不同视为更新（warning，交人工审查）；`bug`/`recheck`
   留档命中仅 warning，因此修正后可直接在新 PR 重新提交。Issue 复核流程仍显式使用
   `--allow-duplicates`（天然与已有内容重复）。
5. **分叉/领先的镜像分支会被跳过**：为了不覆盖对端多出的提交，`diverged` 与 `target-ahead`
   只报告不推送；需要强制收敛时手动在目标端处理或使用 `--force-diverged`（谨慎）。
6. **tag 比较基于 tag 引用 sha**（annotated tag 为 tag 对象 sha），不比较 peeled commit；
   tag 被移动（force update）时会按 `--force-with-lease` 更新目标。
7. **`status:approved` 自动合并需要 bot 有合并权限**：若 `main` 分支保护禁止 Actions 合并，
   CI 会评论失败原因并退出非零，需要管理员把 CI bot 加入 bypass 或改用 PAT。
8. **Issue 审计的 `--pr` 是 Issue 编号**（仅写入报告元数据）；Issue 的 `supersedes` 校验只解析
   格式，不做作者/合并状态 API 校验（由 PR 流程处理）。

Gitea 无法使用 `actions/checkout` 时的替代写法：

```yaml
      - name: Checkout (git clone)
        run: |
          set -euo pipefail
          HOST="${GITHUB_SERVER_URL#https://}"
          git clone "https://${GITHUB_REPOSITORY_OWNER}:${GITHUB_TOKEN}@${HOST}/${GITHUB_REPOSITORY}.git" .
```