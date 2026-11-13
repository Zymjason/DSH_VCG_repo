# 本地 ComfyUI 兼容与限制

VCG 支持把整张工作流**翻译**为 ComfyUI API prompt，提交到用户自建的 ComfyUI 服务端执行（本地显卡运算）。本文档说明启用条件、翻译规则、支持的节点、取图流程与限制。

---

## 1. 启用条件

- 设置中「本地运算模式」开启（`state.local.enabled = true`）。
- `state.local.comfyuiUrl` 已填写（形如 `http://127.0.0.1:8188`，不带结尾斜杠）。
- `state.local.timeoutMs`（默认 600000 = 10 分钟）为轮询总超时。

未配置时按下述可读错误处理，**不会**静默回退云端：

```
本地运算模式已开启，但未配置 ComfyUI 服务端地址。
请到「设置 → VCG 视觉控制生成器 → 本地运算」填写 ComfyUI 地址后重试。
```

开启本地模式时，设置页需明确提示：**所有运算将在本地运行，请注意硬件性能**。

## 2. 翻译流程

1. **预处理非 ComfyUI 节点**：按拓扑序先求值 `engine="both"` 但无 `local.comfyui` 映射的纯数据节点（`prompt-input`、`text-input`、`image-props`、`empty-latent-image` 等），得到它们输出的文本 / 数字值。
2. **建立节点映射**：每个实例分配 ComfyUI 图节点 id（字符串数字，如 `"1"`、`"2"`…），并记录 `instanceId → comfyId`。
3. **解析 map**：对每个带 `local.comfyui` 的节点，按 `class_type` 建节点，遍历 `map` 逐字段解析取值：
   - `params.x` → 实例参数（覆盖值或定义默认值）；
   - `inputs.x` → 若该输入有连线，取上游节点对应的 ComfyUI 输出引用 `[comfyId, outputIndex]`；若无连线，该字段省略并产生告警（可选输入静默），由 ComfyUI class 默认值兜底；
   - `{ "value": … }` → 字面量。
4. **填充输出引用**：边从输出端口连到输入端口，翻译器把 `edge.to.port` 的 map 字段填成 `[源 comfyId, 输出索引]`。输出索引按 class 输出顺序（见 §3）。
5. **补全必需字段**：ComfyUI 的 class 有的字段不在 map 中时，使用 ComfyUI 该 class 的默认值（若无法确定则报"缺少必需字段"错误）。
6. **提交**：`POST {comfyuiUrl}/prompt`，body `{ "prompt": <graph>, "client_id": "<uuid>" }`，返回 `{ prompt_id }`。
7. **轮询**：`GET {comfyuiUrl}/history/{prompt_id}`，直到状态完成或超过 `timeoutMs`（轮询间隔约 1s）。
8. **取图**：从 history 输出中取 `{ filename, subfolder, type }`，用 `GET {comfyuiUrl}/view?filename=…&subfolder=…&type=output` 下载图片。
9. **结果映射**：把下载的图片写回对应节点的 `results[nodeId].images`，并交给 `image-output` 落盘到 `outputDir`。

## 3. 支持的 ComfyUI 节点

| 节点 id | class_type | map（输入字段） | 输出索引 |
|---|---|---|---|
| `checkpoint-loader` | `CheckpointLoaderSimple` | `ckpt_name ← params.ckpt_name` | 0=MODEL、1=CLIP、2=VAE |
| `clip-text-encoder` | `CLIPTextEncode` | `clip ← inputs.clip`、`text ← inputs.text` | 0=CONDITIONING |
| `empty-latent-image` | `EmptyLatentImage` | `width ← params.width`、`height ← params.height`、`batch_size ← params.batch_size` | 0=LATENT |
| `ksampler` | `KSampler` | `seed/steps/cfg/sampler_name/scheduler/denoise ← params.*`、`model/positive/negative/latent_image ← inputs.*` | 0=LATENT |
| `vae-decode` | `VAEDecode` | `samples ← inputs.image`、`vae ← inputs.vae` | 0=IMAGE |
| `image-output` | —（宿主保存） | — | — |

`ksampler` 的 ComfyUI 必需输入 `scheduler`、`denoise` 已在节点定义中声明并映射（契约 §11.5）；缺失会导致 ComfyUI 拒收 API prompt。

### 端口类型 ≠ ComfyUI 类型

| VCG 端口类型 | ComfyUI 类型 | 说明 |
|---|---|---|
| `model` | `MODEL` / `CLIP` / `VAE` | 复用同一 VCG 类型，翻译器按 class 输出索引区分 |
| `conditioning` | `CONDITIONING` | 直接对应 |
| `latent` | `LATENT` | 直接对应 |
| `image` | `IMAGE` | 云端是图片 URL；本地是解码后的 IMAGE |
| `text` / `number` | 无对应 | 由预处理节点求值后填入 map 字段 |

## 4. 关键桥接：ksampler 输出与 vae-decode

- 云端：`ksampler` 输出**图像**（生图 API 已完成采样 + 解码）。
- 本地：ComfyUI `KSampler` 输出 **LATENT**，需要 `VAEDecode` 才能得到 IMAGE。

翻译器按以下方式桥接：

1. `ksampler` 实例的 `image` 输出端口 → 对应 ComfyUI 的 `[ksamplerComfyId, 0]`（LATENT）。
2. `vae-decode` 的 `image` 输入（在 map 中写作 `samples`）接收该 LATENT 引用。
3. `vae-decode` 的 `vae` 输入（可选）建议显式连接 `checkpoint-loader` 的 `vae` 输出（`wf-product-shot` 已连接）；若未连线，`VAEDecode` 会缺少 `vae` 字段而被 ComfyUI 拒收，因此本地工作流要求存在 `checkpoint-loader` 并连接其 VAE 输出。
4. `vae-decode` 的 `image` 输出 → 对应 ComfyUI `VAEDecode` 的 IMAGE 输出 `[vaeComfyId, 0]`。
5. `image-output` 不再映射为 `SaveImage`：宿主直接下载 `/view` 结果并落盘，避免依赖 ComfyUI 的保存节点与目录权限。

> 因此本地模式要求工作流至少包含一个 `checkpoint-loader`（或等价的模型来源）、一个 `ksampler`、一个 `vae-decode`；`wf-product-shot` 是符合该形态的示例。`wf-txt2img` 使用 `model-loader`（`engine="cloud"`），切到本地模式会提示把模型节点换成 `checkpoint-loader`。

## 5. 限制清单

- **只支持已声明映射的 class**：当前为 `CheckpointLoaderSimple`、`CLIPTextEncode`、`EmptyLatentImage`、`KSampler`、`VAEDecode`。LoRA、ControlNet、Upscale、IPAdapter 等需要先在节点仓库新增节点定义并实现映射。
- **不查询 ComfyUI 自定义节点列表**：工作流里出现无 `local.comfyui` 映射且 `engine !== "both"` 的节点时，直接报"节点 X 不支持本地运算"。
- **`checkpoint-loader.ckpt_name` 需要手填**：插件不调用 ComfyUI 的 `/object_info` 拉取 checkpoint 列表（避免不同版本 API 差异）；文件名为 ComfyUI `models/checkpoints/` 下的文件名。
- **视频节点不支持本地**：`video-sampler` 为 `engine="cloud"`；本地模式含视频节点的工作流会报错。
- **http 自定义节点不支持本地**：`executor.kind="http"` 只能云端执行。
- **专业模式导入的 ComfyUI 节点**：可声明 `executor.kind="comfy"` + `local.comfyui`，由翻译器原样提交；不保证正确性，专业模式开关的提示文案已包含"不保证工作流正常运行"。
- **精度 / 分辨率**：`KSampler` 的 `denoise` 默认 1；`batch_size` 上限由节点定义约束（1~4）。本地显存不足时由 ComfyUI 自行报错，插件翻译为可读提示。
- **并发**：一次 `runWorkflow` 对应一次 ComfyUI 提交；不共享队列。停止操作只停止轮询，不保证取消 ComfyUI 已入队任务。
- **网络**：ComfyUI 地址必须在浏览器 / 宿主可达（通常为本机或局域网）；远程地址需自行保证安全（插件不做鉴权）。

## 6. 示例：`wf-product-shot` 的翻译结果（节选）

```json
{
  "prompt": {
    "1": {
      "class_type": "CheckpointLoaderSimple",
      "inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" }
    },
    "2": {
      "class_type": "CLIPTextEncode",
      "inputs": { "clip": ["1", 1], "text": "a matte black wireless headphone on a white marble podium, …" }
    },
    "3": {
      "class_type": "CLIPTextEncode",
      "inputs": { "clip": ["1", 1], "text": "lowres, busy background, text, watermark, …" }
    },
    "4": {
      "class_type": "EmptyLatentImage",
      "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }
    },
    "5": {
      "class_type": "KSampler",
      "inputs": {
        "seed": 2026, "steps": 32, "cfg": 6.5,
        "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1,
        "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0]
      }
    },
    "6": {
      "class_type": "VAEDecode",
      "inputs": { "samples": ["5", 0], "vae": ["1", 2] }
    }
  }
}
```

> `image-output` 不进入 ComfyUI 图；宿主下载 `VAEDecode` 的结果并落盘。

## 7. 失败对照表

| 现象 | 可读错误 |
|---|---|
| 未开本地模式 | 使用云端运算；无需 ComfyUI |
| 开了本地模式但无地址 | 提示去设置填写 ComfyUI 地址 |
| 工作流含 `engine="cloud"` 节点 | `节点 <type> 仅支持云端运算，本地模式无法运行；可改用 checkpoint-loader 等本地节点` |
| 无 checkpoint-loader | `本地模式缺少模型来源：请添加 checkpoint-loader 节点` |
| ComfyUI 拒收 | `ComfyUI 拒绝了工作流（HTTP 400）：<节点错误信息>`，并提示检查 ckpt_name |
| 超时 | `ComfyUI 执行超时（<timeoutMs> ms）：任务可能仍在其队列中` |
| 连接失败 | `无法连接 ComfyUI 服务端 <url>：请确认服务已启动且地址正确` |
