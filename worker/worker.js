/**
 * ZNQM API 代理 Worker
 * 路由: znqm.cloud/api/*
 * 上游: https://api.agnes-ai.cn/v1 (OpenAI 兼容)
 *
 * 端点:
 *   POST /api/generate  文生图 { prompt, count }
 *   POST /api/img2img   图生图 { image, prompt, size, style }
 *   POST /api/img2video 图生视频 { images, prompt, duration } -> 异步任务轮询
 *   POST /api/describe  AI 描述图片 { image }
 *   GET  /api/file?url= 下载代理（仅白名单域名）
 *
 * 站点保护:
 *   - CORS 白名单: 仅 znqm.cloud 域名可跨域调用
 *   - 下载代理域名白名单: 仅 Agnes CDN 域名
 *   - IP 限速: 生成类端点每 IP 每分钟 N 次 (Durable Object)
 *
 * 密钥通过 wrangler secret put AGNES_API_KEY 注入, 不写入代码。
 */

const AGNES_BASE = 'https://api.agnes-ai.cn/v1';
const IMAGE_MODEL = 'agnes-image-2.1-flash';
const VIDEO_MODEL = 'agnes-video-v2.0';
const VISION_MODEL = 'agnes-2.5-flash';

const VIDEO_POLL_INTERVAL_MS = 4000;
const VIDEO_POLL_TIMEOUT_MS = 180000;

/* ===== 站点保护配置 ===== */
const ALLOWED_ORIGINS = new Set([
  'https://znqm.cloud',
  'https://www.znqm.cloud',
  'http://znqm.cloud',
  'http://www.znqm.cloud',
]);

const ALLOWED_FILE_HOSTS = new Set([
  'platform-outputs.agnes-ai.space',
  'cos-platform-outputs.agnes-ai.cn',
]);

const RATE_LIMIT_SCOPE = ['/api/generate', '/api/img2img', '/api/img2video', '/api/describe'];
const RATE_LIMIT_PER_MINUTE = 6;

function corsHeaders(request) {
  const origin = request ? request.headers.get('Origin') : null;
  const headers = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request) },
  });
}

async function agnesFetch(env, path, options = {}) {
  return fetch(AGNES_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + env.AGNES_API_KEY,
      ...(options.headers || {}),
    },
  });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 90 * 1024 * 1024) throw new Error('请求体过大');
  return JSON.parse(text);
}

/* ---------- 文生图 ---------- */
async function handleText2Img(env, body, request) {
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json({ success: false, error: '请输入画面描述' }, 400, request);

  const resp = await agnesFetch(env, '/images/generations', {
    method: 'POST',
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      size: '1K',
      ratio: '1:1',
      extra_body: { response_format: 'url' },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error?.message || `上游错误 (${resp.status})`);
  const url = data.data?.[0]?.url;
  if (!url) throw new Error('上游未返回图片');

  return json({ success: true, images: [url] }, 200, request);
}

/* ---------- 图生图 ---------- */
async function handleImg2Img(env, body, request) {
  const prompt = String(body.prompt || '').trim();
  const image = body.image;
  if (!image) return json({ success: false, error: '请先上传参考图片' }, 400, request);
  if (!prompt) return json({ success: false, error: '请输入画面描述' }, 400, request);

  const resp = await agnesFetch(env, '/images/generations', {
    method: 'POST',
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      size: '1K',
      ratio: '1:1',
      extra_body: { image: [image], response_format: 'url' },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error?.message || `上游错误 (${resp.status})`);
  const url = data.data?.[0]?.url;
  if (!url) throw new Error('上游未返回图片');

  return json({ success: true, images: [url] }, 200, request);
}

/* ---------- 图生视频 (异步任务) ---------- */
async function handleImg2Video(env, body, request) {
  const images = (body.images || []).filter(Boolean);
  const prompt = String(body.prompt || '').trim();
  const duration = Math.min(Number(body.duration) || 12, 18);

  if (images.length < 1) return json({ success: false, error: '请至少上传 1 张图片' }, 400, request);
  if (!prompt) return json({ success: false, error: '请输入视频描述' }, 400, request);

  const frames = Math.min(Math.max(Math.round(duration * 24), 81), 441);
  const numFrames = Math.min(8 * Math.floor(frames / 8) + 1, 441);

  const payload = {
    model: VIDEO_MODEL,
    prompt,
    width: 1152,
    height: 768,
    num_frames: numFrames,
    frame_rate: 24,
  };
  if (images.length === 1) {
    payload.image = images[0];
  } else {
    payload.mode = 'keyframes';
    payload.extra_body = { image: images.slice(0, 9), mode: 'keyframes' };
  }

  const createResp = await agnesFetch(env, '/videos', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const task = await createResp.json().catch(() => ({}));
  if (!createResp.ok) throw new Error(task.error?.message || `创建任务失败 (${createResp.status})`);
  const taskId = task.task_id || task.id;
  const videoId = task.video_id;
  if (!taskId) throw new Error('上游未返回任务 ID');

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
    const pollResp = await agnesFetch(env, '/videos/' + taskId);
    const state = await pollResp.json().catch(() => ({}));
    if (!pollResp.ok) throw new Error(state.error?.message || '查询任务失败');

    if (state.status === 'completed') {
      let videoUrl = state.metadata?.url || state.url || state.remixed_from_video_id;
      if (!videoUrl && videoId) {
        const detailResp = await agnesFetch(env, '/agnesapi?video_id=' + encodeURIComponent(videoId));
        const detail = await detailResp.json().catch(() => ({}));
        videoUrl = detail.url || detail.metadata?.url;
      }
      if (!videoUrl) throw new Error('任务完成但未返回视频地址');
      return json({
        success: true,
        frames: [videoUrl],
        videoUrl,
        duration: parseFloat(state.seconds) || duration,
        provider: 'Agnes Video V2.0',
      }, 200, request);
    }
    if (state.status === 'failed' || state.error) {
      throw new Error(state.error?.message || JSON.stringify(state.error) || '视频生成失败');
    }
  }

  return json({ success: false, error: '视频生成超时，请稍后重试' }, 504, request);
}

/* ---------- AI 描述/优化提示词 ---------- */
async function handleDescribe(env, body, request) {
  const image = body.image;
  const text = String(body.text || '').trim();
  if (!image && !text) return json({ success: false, error: '请先上传图片或输入描述' }, 400, request);

  let content;
  if (text) {
    content = [
      {
        type: 'text',
        text: '请将我提供的画面描述优化为高质量的 AI 绘图提示词：保留核心创意，补充风格、光线、构图、色彩、细节等描述词，用中文，不超过 150 字，直接输出提示词本身，不要任何解释。用户描述：' + text,
      },
    ];
  } else {
    content = [
      {
        type: 'text',
        text: '请用中文描述这张图片的画面内容、风格和光线，作为 AI 绘图提示词，不超过 80 字，直接输出描述本身。',
      },
      { type: 'image_url', image_url: { url: image } },
    ];
  }

  const resp = await agnesFetch(env, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{ role: 'user', content }],
      max_tokens: 400,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error?.message || `上游错误 (${resp.status})`);
  const description = data.choices?.[0]?.message?.content;
  if (!description) throw new Error('AI 未返回描述');

  return json({ success: true, description: description.trim() }, 200, request);
}

/* ---------- 文件下载代理 (仅白名单 CDN 域名) ---------- */
async function handleFile(request) {
  const url = new URL(request.url).searchParams.get('url');
  if (!url || !/^https:\/\//.test(url)) return json({ success: false, error: '无效的下载地址' }, 400, request);

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return json({ success: false, error: '无效的下载地址' }, 400, request);
  }
  if (!ALLOWED_FILE_HOSTS.has(host)) {
    return json({ success: false, error: '该域名不允许代理下载' }, 403, request);
  }

  const resp = await fetch(url);
  if (!resp.ok) return json({ success: false, error: '文件获取失败' }, 502, request);

  const headers = new Headers(resp.headers);
  const origin = request.headers.get('Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  headers.set('Content-Disposition', 'attachment');
  return new Response(resp.body, { status: resp.status, headers });
}

/* ---------- IP 限速器 (Durable Object) ---------- */
export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || 'unknown';
    const limit = parseInt(url.searchParams.get('limit') || '6', 10);
    const current = (await this.state.storage.get(key)) || 0;
    if (current >= limit) {
      return json({ allowed: false, count: current, limit }, 429);
    }
    await this.state.storage.put(key, current + 1, { expirationTtl: 120 });
    return json({ allowed: true, count: current + 1, limit });
  }
}

/* ---------- 主入口 ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const origin = request.headers.get('Origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return json({ success: false, error: 'Forbidden origin' }, 403, request);
    }

    if (!env.AGNES_API_KEY) {
      return json({ success: false, error: '服务器未配置 AGNES_API_KEY' }, 500, request);
    }

    if (request.method === 'POST' && RATE_LIMIT_SCOPE.includes(url.pathname)) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const minute = Math.floor(Date.now() / 60000);
      const id = env.RATE_LIMITER.idFromName('global');
      const stub = env.RATE_LIMITER.get(id);
      const rlResp = await stub.fetch(
        'https://ratelimit/?key=' + encodeURIComponent(`ip:${ip}:${minute}`) + '&limit=' + RATE_LIMIT_PER_MINUTE
      );
      const rl = await rlResp.json();
      if (!rl.allowed) {
        return json({ success: false, error: '请求过于频繁，请一分钟后再试' }, 429, request);
      }
    }

    const routes = {
      '/api/generate': handleText2Img,
      '/api/img2img': handleImg2Img,
      '/api/img2video': handleImg2Video,
      '/api/describe': handleDescribe,
      '/api/file': handleFile,
    };
    if (routes[url.pathname] === handleFile) {
      if (request.method !== 'GET') return json({ success: false, error: 'Method not allowed' }, 405, request);
      return await handleFile(request);
    }
    const handler = routes[url.pathname];
    if (!handler) return json({ success: false, error: 'Not found' }, 404, request);

    try {
      if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405, request);
      const body = await readBody(request);
      return await handler(env, body, request);
    } catch (err) {
      return json({ success: false, error: err.message || '服务器内部错误' }, 500, request);
    }
  },
};