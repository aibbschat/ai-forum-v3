// server/llm/client.js
// 统一模型路由层：把全站 LLM 调用收口到一处，支持多供应商可插拔 + 自动降级。
// 设计目标（呼应 ROADMAP D4「大脑可拔插」）：换模型 / 换供应商 / 控成本 = 改 llm/config.js + .env，
// 业务代码（聊天 / 洞察 / 配图 / 记忆 / 联网感知 / 写稿大脑）一律只调 chat()，不关心底层是谁。
import { PROVIDERS, FALLBACK_ORDER, resolvePurpose } from './config.js';

/**
 * 统一聊天接口。
 * @param {object} opts
 * @param {string}  [opts.purpose]   场景：chat/insight/vision/perceive/memory/writing
 * @param {string}  [opts.model]     直接指定模型（覆盖 purpose 默认）
 * @param {Array}   opts.messages    OpenAI 格式消息 [{role, content}]
 * @param {boolean} [opts.json]      要求 JSON 返回（response_format.json_object）
 * @param {number}  [opts.temperature]
 * @param {number}  [opts.maxTokens]
 * @returns {Promise<{content:string, provider:string, model:string}|null>}
 *   成功返回 {content, provider, model}；全部供应商不可用/失败时返回 null（绝不抛错中断业务）。
 */
export async function chat(opts = {}) {
  const { purpose = 'chat', model: modelOverride, messages, json = false, temperature, maxTokens } = opts;
  if (!Array.isArray(messages) || !messages.length) return null;

  const target = resolvePurpose(purpose);
  const model = modelOverride ?? target.model;

  // 尝试顺序：主用供应商在前，其余按降级链（去重）
  const order = [target.provider, ...FALLBACK_ORDER.filter((p) => p !== target.provider)];

  let lastErr;
  for (const pname of order) {
    const prov = PROVIDERS[pname];
    if (!prov) continue;
    const key = prov.apiKey();
    if (!key) {
      // 该供应商未配置密钥，跳过（自动降级到下一个）
      continue;
    }
    try {
      const res = await callOpenAI(prov, key, { model, messages, json, temperature, maxTokens });
      if (res.usage) {
        console.info(`[llm] ${pname}/${model} tokens=${JSON.stringify(res.usage)}`);
      }
      return { content: res.content, provider: pname, model };
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${pname} 调用失败，尝试下一家供应商: ${e?.message || e}`);
    }
  }
  if (lastErr) console.error(`[llm] 全部供应商失败: ${lastErr?.message || lastErr}`);
  return null;
}

/** 单次 OpenAI 兼容 /chat/completions 调用。失败（网络/HTTP/空响应）统一抛错，由上层决定是否降级。 */
async function callOpenAI(prov, key, { model, messages, json, temperature, maxTokens }) {
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
      signal: AbortSignal.timeout(60_000),
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
