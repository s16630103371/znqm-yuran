# ZNQM - AI Generation Studio

AI 驱动的图片与视频生成平台，赛博朋克风格个人网站。

## Features

- AI 图片生成（文生图 / 图生图）
- AI 视频生成（图生视频，异步任务）
- AI 图片描述（视觉模型自动填写提示词）
- 赛博朋克视觉风格
- 响应式设计

## Tech Stack

- 纯 HTML/CSS/JS，零依赖
- GitHub Pages 部署（前端）
- Cloudflare Worker（`/api/*` 后端代理）
- 上游 API: https://api.agnes-ai.cn/v1 (Agnes AI, OpenAI 兼容)

## 部署

### 1. 前端 (GitHub Pages)

1. 在 Settings → Pages 中启用 GitHub Pages
2. 设置自定义域名 znqm.cloud
3. 等待 DNS 生效

### 2. 后端 (Cloudflare Worker)

```bash
cd worker
npm i -g wrangler        # 首次安装
wrangler login           # 登录 Cloudflare 账号
wrangler secret put AGNES_API_KEY   # 粘贴你的 Agnes API Key（不会写入代码/仓库）
wrangler deploy          # 部署, 路由自动匹配 znqm.cloud/api/*
```

要求: znqm.cloud 的 DNS 在 Cloudflare 托管（橙云代理）。Worker 路由
`znqm.cloud/api/*` 会优先于 GitHub Pages 响应 `/api/` 请求，其余路径仍走 Pages。

### 验证

- 访问 https://znqm.cloud ，在「文生图」输入描述点「开始生成」
- 若返回"服务器未配置 AGNES_API_KEY"，说明 secret 未设置成功

## API 端点（Worker 内部）

| 端点 | 说明 | 上游 |
| --- | --- | --- |
| POST /api/generate | 文生图 | /v1/images/generations (agnes-image-2.1-flash) |
| POST /api/img2img | 图生图 | /v1/images/generations + extra_body.image |
| POST /api/img2video | 图生视频 (异步轮询) | /v1/videos (agnes-video-v2.0) |
| POST /api/describe | AI 图片描述 | /v1/chat/completions (agnes-2.5-flash) |
| GET /api/file?url= | 下载代理 (绕过 CORS) | 直连上游 CDN |

## 注意

- API Key 通过 `wrangler secret put AGNES_API_KEY` 注入，请勿提交到仓库
- 视频生成为异步任务，Worker 轮询最长 180 秒；前端超时 200 秒

---

Built with ❤️ by [s16630103371](https://github.com/s16630103371)
