// server/llm/client.js
// 统一模型路由层：把全站 LLM 调用收口到一处，支持多供应商可插拔 + 自动降级。
// 设计目标（呼应 ROADMAP D4「大脑可拔插」）：换模型 / 换供应商 / 控成本 = 改 llm/config.js + .env，
// 业务代码（聊天 / 洞察 / 配图 / 记忆 / 联网感知 / 写稿大脑）一律只调 chat()，不关心底层是谁。
import { PROVIDERS, FALLBACK_ORDER, resolvePurpose } from './config.js';

/**
 * 各场景超时（ms）。火山 Agent Plan 的自主联网任务（perceive/写稿）本就要几十秒，
 * 统一 60s 会误杀慢请求（实测 node fetch 需 68s+）。超时可经 LLM_TIMEOUT_<PURPOSE> 覆盖。
 */
const TIMEOUT_BY_PURPOSE = {
  chat: 60_000,
  insight: 60_000,
  vision: 60_000,
  perceive: 180_000, // 联网检索慢任务
  memory: 120_000,
  writing: 180_000,
  companion: 90_000, // 伴侣聊天/轻润色（§10.3：聊天 60s 够用，轻润色 90s 起）
};

function timeoutFor(purpose) {
  const key = `LLM_TIMEOUT_${String(purpose || 'chat').toUpperCase()}`;
  const v = Number(process.env[key]);
  if (Number.isFinite(v) && v > 0) return v;
  return TIMEOUT_BY_PURPOSE[purpose] ?? TIMEOUT_BY_PURPOSE.chat;
}

/**
 * 统一聊天接口。
 * @param {object} opts
 * @param {string}  [opts.purpose]   场景：chat/insight/vision/perceive/memory/writing
 * @param {string}  [opts.model]     直接指定模型（覆盖 purpose 默认）
 * @param {Array}   opts.messages    OpenAI 格式消息 [{role, content}]
 * @param {boolean} [opts.json]      要求 JSON 返回（response_format.json_object）
 * @param {number}  [opts.temperature]
 * @param {number}  [opts.maxTokens]
 * @param {number}  [opts.timeout]   本次调用超时（ms），默认按 purpose
 * @returns {Promise<{content:string, provider:string, model:string, usage:object|null}|null>}
 *   成功返回 {content, provider, model, usage}；全部供应商不可用/失败时返回 null（绝不抛错中断业务）。
 *   usage 为模型返回的 token 统计（{prompt_tokens, completion_tokens, total_tokens} 或 null）。
 */
export async function chat(opts = {}) {
  const { purpose = 'chat', model: modelOverride, messages, json = false, temperature, maxTokens, timeout } = opts;
  if (!Array.isArray(messages) || !messages.length) return null;

  const target = resolvePurpose(purpose);
  const requestedModel = modelOverride ?? target.model;
  const callTimeout = timeout ?? timeoutFor(purpose);

  // 尝试顺序：目标供应商在前，其余按降级链（去重）
  const order = [target.provider, ...FALLBACK_ORDER.filter((p) => p !== target.provider)];

  let lastErr;
  let skippedTargetForKey = false;
  for (const pname of order) {
    const prov = PROVIDERS[pname];
    if (!prov) continue;
    const key = prov.apiKey();
    if (!key) {
      // 目标供应商缺 key 是配置问题（成本路由会被静默打乱），必须显式告警；
      // 降级链上其余缺 key 的供应商则安静跳过。
      if (pname === target.provider) {
        skippedTargetForKey = true;
        console.error(
          `[llm] 目标供应商 "${pname}" 未配置 API key（检查 LLM_${pname.toUpperCase()}_API_KEY）；` +
            `将尝试降级链，注意这可能产生非预期供应商费用`
        );
      }
      continue;
    }
    // 跨供应商降级时模型名要跟随供应商切换：目标供应商用请求的模型，
    // 其余降级供应商用它自己的默认模型（否则会带着 ark-code-latest 去打小米接口必然 400）。
    const model = pname === target.provider ? requestedModel : prov.modelId();
    try {
      const res = await callOpenAI(prov, key, { model, messages, json, temperature, maxTokens, timeout: callTimeout });
      if (res.usage) {
        console.info(`[llm] ${pname}/${model} tokens=${JSON.stringify(res.usage)}`);
      }
      if (skippedTargetForKey) {
        console.warn(`[llm] 目标供应商 ${target.provider} 缺 key，本次实际由 ${pname} 承接`);
      }
      // M3 前置：回填 usage（成本监控需要），向后兼容现有 6 个 purpose 调用方。
      return { content: res.content, provider: pname, model, usage: res.usage ?? null };
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${pname} 调用失败，尝试下一家供应商: ${e?.message || e}`);
    }
  }
  if (lastErr) console.error(`[llm] 全部供应商失败: ${lastErr?.message || lastErr}`);
  return null;
}

/** 单次 OpenAI 兼容 /chat/completions 调用。失败（网络/HTTP/空响应）统一抛错，由上层决定是否降级。 */
async function callOpenAI(prov, key, { model, messages, json, temperature, maxTokens, timeout }) {
  const body = {
    model,
    messages,
    temperature: temperature ?? 0.5,
    max_tokens: maxTokens ?? 1500,
  };
  if (json) body.response_format = { type: 'json_object' };

  let resp;
  try {
    resp = await fetch(prov.chatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout ?? 60_000),
    });
  } catch (e) {
    throw new Error(`网络请求失败: ${e?.message || e}`);
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('模型返回内容为空');
  return { content, usage: data?.usage };
}

/**
 * 流式聊天接口（SSE）。
 * 按 SSE 规范逐行推送事件，客户端可实时渲染思考过程 + 答案。
 *
 * SSE 事件格式（每行 `event:<type>\ndata:<json>\n\n`）：
 *   event:reasoning  data:{ "text": "思考片段" }
 *   event:content    data:{ "text": "答案片段" }
 *   event:done       data:{ "usage": {...} }
 *   event:error      data:{ "message": "错误描述" }
 *
 * 回调 `onEvent({ type, data })` 在收到每种事件时被调用。
 * @returns {Promise<{content:string, reasoningChunks:string[], usage:object|null}|null>}
 */
export async function chatStream(opts = {}, onEvent) {
  const { purpose = 'chat', model: modelOverride, messages, temperature, maxTokens, timeout } = opts;
  if (!Array.isArray(messages) || !messages.length) return null;

  const target = resolvePurpose(purpose);
  const requestedModel = modelOverride ?? target.model;
  const callTimeout = timeout ?? timeoutFor(purpose);
  const order = [target.provider, ...FALLBACK_ORDER.filter((p) => p !== target.provider)];

  let lastErr;
  let skippedTargetForKey = false;
  for (const pname of order) {
    const prov = PROVIDERS[pname];
    if (!prov) continue;
    const key = prov.apiKey();
    if (!key) {
      if (pname === target.provider) {
        skippedTargetForKey = true;
        console.error(
          `[llm-stream] 目标供应商 "${pname}" 未配置 API key（检查 LLM_${pname.toUpperCase()}_API_KEY）；将尝试降级链`
        );
      }
      continue;
    }
    const model = pname === target.provider ? requestedModel : prov.modelId();
    try {
      const result = await streamOpenAI(prov, key, { model, messages, temperature, maxTokens, timeout: callTimeout }, onEvent);
      if (skippedTargetForKey) {
        console.warn(`[llm-stream] 目标供应商 ${target.provider} 缺 key，本次实际由 ${pname} 承接`);
      }
      return { ...result, provider: pname, model };
    } catch (e) {
      lastErr = e;
      console.warn(`[llm-stream] ${pname} 调用失败: ${e?.message || e}`);
    }
  }
  if (lastErr) {
    onEvent?.({ type: 'error', data: { message: lastErr.message } });
    console.error(`[llm-stream] 全部供应商失败: ${lastErr?.message || lastErr}`);
  }
  return null;
}

/** OpenAI 兼容流式调用，逐 chunk 解析 SSE，回调 onEvent。 */
async function streamOpenAI(prov, key, { model, messages, temperature, maxTokens, timeout }, onEvent) {
  const body = { model, messages, temperature: temperature ?? 0.5, max_tokens: maxTokens ?? 2500, stream: true };

  let resp;
  try {
    resp = await fetch(prov.chatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout ?? 120_000),
    });
  } catch (e) {
    throw new Error(`网络请求失败: ${e?.message || e}`);
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const reasoningChunks = [];
  const contentChunks = [];
  let usage = null;
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // SSE: lines starting with "data:"
    const lines = buf.split('\n');
    buf = lines.pop() || ''; // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const delta = obj.choices?.[0]?.delta || {};
      if (delta.reasoning_content) {
        reasoningChunks.push(delta.reasoning_content);
        onEvent?.({ type: 'reasoning', data: { text: delta.reasoning_content } });
      }
      if (delta.content) {
        contentChunks.push(delta.content);
        onEvent?.({ type: 'content', data: { text: delta.content } });
      }
      if (obj.usage) usage = obj.usage;
    }
  }

  const content = contentChunks.join('').trim();
  onEvent?.({ type: 'done', data: { usage } });
  console.info(`[llm-stream] ${model} reasoning=${reasoningChunks.length} chunks, content=${contentChunks.length} chunks`);
  return { content, reasoningChunks, usage };
}
