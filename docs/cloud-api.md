# 云端 API 适配说明

VCG 默认通过云端大模型 API 完成生图 / 生视频 / 文本润色。本文档说明 **provider 类型**、请求与响应格式、错误处理约定，以及节点如何映射到云端调用。实现细节以插件 Host 代码与 `DSH_VCG/CONTRACT.md` §9 为准。

---

## 1. Provider 概览

| kind | 用途 | 默认能力 |
|---|---|---|
| `bailian-chat-image` | 阿里云 Token Plan 兼容模式（`/chat/completions`），生图 / 生视频（视模型） | image（video 视模型） |
| `openai-images` | OpenAI Images 兼容接口（`/v1/images/generations`） | image |
| `openai-video` | OpenAI 视频兼容接口 | video |
| `custom-http` | 专业模式自定义 provider（结合 `executor.kind="http"` 节点） | 节点自行声明 |

Provider 由 Host 自动检测 + 用户手动配置：

- 自动检测：读取全局 LLM provider（`ctx.get('llm').listProviders()` / `listModels()`）与凭证 `ctx.credentials.resolve('BAILIAN_TPP_API_KEY')`，识别可用于 image / video / text 的模型，生成候选 provider。
- 用户可在设置中新增 / 编辑 / 测试 provider，并指定默认图像 / 视频 / 文本模型。
- API Key 只保存在宿主状态与凭证系统，节点 JSON 不包含任何密钥。

## 2. bailian-chat-image（内置生图适配器）

**Base URL**

```
https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

**生图请求**（`POST /chat/completions`）

```json
{
  "model": "wan2.7-image",
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "一只赛博朋克柯基，霓虹雨夜，电影感" }] }
  ],
  "parameters": { "size": "1280*720", "n": 1 }
}
```

**生图响应**

```json
{
  "output": {
    "choices": [
      { "message": { "content": [{ "type": "image", "image": "https://…/xxx.png" }] } }
    ]
  },
  "usage": { "image_count": 1, "size": "1280*720" }
}
```

适配要点：

- 提示词放在 `messages[0].content[0].text`；负向提示词由适配器拼接到同一段文本（例如 `"\n\nNegative prompt: …"`），因为该接口没有独立 negative 字段。
- 尺寸字段 `parameters.size` 为 `"W*H"`（星号分隔，实测生效），由上游 `empty-latent-image` 的 `width`/`height` 组合；未提供时使用默认 1280*720。
- 结果从 `output.choices[*].message.content[*]` 中取 `type === "image"` 的 `image` 字段（URL 列表）；`usage` 原样记录。
- 可选模型：`wan2.7-image`、`wan2.7-image-pro`、`qwen-image-3.0-pro`（以设置中的模型映射为准）。
- 单个 provider 超时建议 120s（图片）；视频请使用视频 provider。

**文本**：同一 endpoint 的标准 OpenAI chat 格式，模型如 `qwen3.8-max`；若该模型不可用，回退 `deepseek-official/deepseek-flash`（经 `ctx.get('llm')` 调用）。用于 `clip-text-encoder.rewrite` 润色与 AI 自动建流。

## 3. openai-images 适配器

用于 OpenAI Images 兼容服务：

```
POST {baseUrl}/v1/images/generations
Authorization: Bearer <apiKey>
{ "model": "<imageModel>", "prompt": "<prompt>", "size": "1024x1024", "n": 1 }
```

- 尺寸为 `"WxH"`（字母 x）——与 bailian 的 `"W*H"` 不同，适配器内部转换。
- 响应取 `data[0].url` 或 `data[0].b64_json`；b64 结果由 Host 落盘为文件。
- 失败时读取 `error.message`。

## 4. 视频适配

- `wan3.0-video` 在 bailian chat endpoint 直连会返回 **400**：Host 必须把该错误翻译成可读提示（"该模型不支持在 chat/completions 直连生视频，请在设置中配置 openai-video 类 provider"）。
- 支持 `openai-video` 类 provider：`video-sampler` 的 `positive`（conditioning 的文本部分）、可选首帧 `image`、`seed`/`duration`/`fps`/`size` 参数映射到 provider 请求。
- 未配置视频 provider 时 `video-sampler` 返回明确错误，而不是静默失败。

## 5. 节点 → 云端调用映射

| 节点 | capability | 云端行为 |
|---|---|---|
| `model-loader` | none | 解析设置中的默认模型 / 用户选择，返回 `{providerId, model}`；不发起请求 |
| `checkpoint-loader` | none | 同上（云端使用"云端模型"参数或默认图像模型） |
| `clip-text-encoder` | none | 直通文本；`rewrite=true` 时调用文本模型 |
| `empty-latent-image` | none | 仅产生 `{width,height,batch_size}`，供 `ksampler` 组装 `size` |
| `ksampler` | image | 调用图像 provider，返回图片 URL + usage |
| `vae-decode` | none | 云端直通 / 下载落盘 |
| `image-output` | none | 保存到 `baseDir/outputDir`，登记输出列表 |
| `video-sampler` | video | 调用视频 provider |
| `video-output` | none | 下载并保存视频 |
| `example-node` | image | 按 `executor.http` 声明式请求第三方 API |

## 6. 自定义 HTTP 节点与 provider 的区别

| | 自定义 provider | `executor.kind="http"` 节点 |
|---|---|---|
| 声明位置 | 设置中的 provider 配置（baseUrl / kind / apiKey） | 节点 JSON 的 `executor.request` / `response` |
| 适用 | 复用内置适配器的通用服务 | 任意形状的第三方 API（专业模式导入） |
| 密钥 | provider 保存，节点用 `${settings.apiKey}` 引用 | 同左 |
| 校验 | 设置页测试连接 | 导入时校验 schema + URL |

两者可以组合：provider 提供密钥与基础地址，http 节点声明具体请求形状。

## 7. 错误处理与重试

- **重试**：网络错误 / HTTP 429 / 5xx 重试 2 次，指数退避（约 1s、2s，带抖动）。
- **不重试**：4xx（除 429）直接抛可读错误，包含 HTTP 状态与响应体截断信息。
- 错误文案要求：包含"哪个节点 / 哪个 provider / 什么原因 / 怎么修"四要素，例如：
  - `未配置生图 API：请在「设置 → VCG 视觉控制生成器」中添加 provider 并选择默认图像模型。`
  - `生图失败（provider=bailian-tpp, model=wan2.7-image）：HTTP 401，API Key 无效或已过期。`
  - `该模型不支持生视频：wan3.0-video 在 chat/completions 返回 400。请配置 openai-video 类 provider。`
- 节点级失败写入 `results[nodeId].error`，不抛出未捕获异常；下游节点标记为失败并中止。

## 8. 结果与落盘

- 云端返回的图片 / 视频 URL 由 `image-output` / `video-output` 下载到 `baseDir/outputDir`（默认 `vcg-output`）。
- 输出记录（`state.outputs[]`）包含 `{id, ts, path, kind, providerId, model, prompt}`，供输出画廊展示。
- 图片结果同时保留远端 URL（`images[].url`）与本地路径（`images[].path`）；画布缩略图优先使用本地路径。
- 使用宿主 `readOutput(path)` 可把本地文件读为 `dataUrl` 预览；`readOutput` 必须限制在允许的输出根目录内，防止路径穿越。

## 9. 安全约定

- 密钥来源优先级：settings 中 provider 的 `apiKey` → 环境凭证（如 `BAILIAN_TPP_API_KEY`）。
- `state` RPC 返回的 provider 必须掩码 `apiKey`（只显示尾 4 位或 `已配置`）。
- 节点 JSON、工作流 JSON、日志中不得出现明文密钥；http 节点只允许 `${settings.apiKey}` 占位。
- 只在 `http(s)` 下发起请求；禁止 `file://`、`ftp://` 等协议。
