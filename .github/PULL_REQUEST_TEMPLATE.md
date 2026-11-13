## 提交声明 / Submission declaration

<!--
  必填。CI（.github/workflows/audit-pr.yml）会解析以下字段：
    type       node | workflow
    files      恰好 1 个文件：node → nodes/<id>.json；workflow → workflows/<id>.json
    submitter  你的平台用户名（必须与 PR 作者一致；可带 @）
    supersedes 可选，重新提交时写被替代的旧 PR 编号，如 #12
  注意：不要修改 manifest.json / 节点或工作流以外的文件；所有上传必须 PR 到 dev。
-->

type: node
files: nodes/<你的节点 id>.json
submitter: @<你的用户名>
supersedes:

## 变更说明 / Description

<!-- 这个节点或工作流做什么、依赖哪些模型/节点、为什么现在提交。 -->

## 安全声明 / Security declaration

- [ ] 我没有在 JSON 中放入可执行代码、脚本或混淆内容，只提交声明式节点/工作流定义
- [ ] 若声明了 `models[]`：已填写 https 链接、文件名、格式、大小，并尽量提供 `sha256`
- [ ] 我确认文件路径与 `type` 声明一致（node 只改 1 个 `nodes/*.json`；workflow 只改 1 个 `workflows/*.json`）
- [ ] 我已本地运行 `node scripts/validate.mjs` 并通过

## 本地自测 / Local checks

```
node scripts/validate.mjs
node scripts/audit-submission.mjs --files <files> --body-file pr-body.md --skip-refs
```

<!--
  提交后：
  - 审计通过 → 标签 audit:passed，等待人工审查（dev 分支）
  - 审计失败 → 标签 audit:failed，文件自动复制到 bug 分支，PR 保持打开；修正后重新 push 即可
  - 人工审查通过（status:approved）→ 自动合并 dev 并同步到 main
  - 人工审查拒绝（status:rejected）→ 复制到 bug 分支，不自动关闭 PR
  详见 docs/submission.md 与 docs/review-policy.md。
-->