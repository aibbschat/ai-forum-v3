// server/llm/config.js
// 统一模型路由层配置：多供应商可插拔 + 按场景路由 + 自动降级。
// 换模型 / 换供应商 / 控成本 = 改这里 + .env，业务代码零改动。
//
// 新增供应商：在 PROVIDERS 登记（apiKey()/chatUrl() 读取对应 env），并加入 FALLBACK_ORDER。
// 各场景(purpose)默认映射到 (provider, model)，可经 LLM_MODEL_<PURPOSE> 覆盖。

/**
 * 供应商定义。apiKey()/chatUrl() 为函数，读取 env（便于测试与热切换）。
 * chatUrl 为完整 /chat/completions POST 地址（OpenAI 兼容）。
 */
export const PROVIDERS = {
  // 主用：火山引擎 Agent Plan（ark-code-latest，Auto 路由，自带多模态 + 自主联网）
  volcengine: {
    label: 'Volcengine Agent Plan (ark-code-latest · Auto)',
    apiKey: () => process.env.DEEPSEEK_API_KEY,
    chatUrl: () =>
      process.env.DEEPSEEK_ENDPOINT ?? 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions',
  },
  // 备用：DeepSeek（主用限流/宕机时自动接管，密钥须经 LLM_DEEPSEEK_API_KEY 显式注入；
  //       未配则该供应商被视为「未启用」自动跳过，绝不会拿主用 key 误打备用端点）。
  deepseek: {
    label: 'DeepSeek',
    apiKey: () => process.env.LLM_DEEPSEEK_API_KEY,
    chatUrl: () => process.env.LLM_DEEPSEEK_ENDPOINT ?? 'https://api.deepseek.com/chat/completions',
  },
};

// 降级顺序：主用在前，备用在后。无密钥的供应商自动跳过（不报错、用户无感）。
export const FALLBACK_ORDER = ['volcengine', 'deepseek'];

// 各场景默认路由（不改 env 时的兜底）。可经 LLM_MODEL_<PURPOSE> 覆盖为供应商别名，
// 并用 LLM_MODEL_<PURPOSE>_MODEL 指定该场景的具体模型。
const DEFAULT_PURPOSE = {
  chat: { provider: 'volcengine', model: 'ark-code-latest' },
  insight: { provider: 'volcengine', model: 'ark-code-latest' },
  vision: { provider: 'volcengine', model: 'ark-code-latest' },
  perceive: { provider: 'volcengine', model: 'ark-code-latest' },
  memory: { provider: 'volcengine', model: 'ark-code-latest' },
  writing: { provider: 'volcengine', model: 'ark-code-latest' },
};

/** 解析某场景应使用的 (provider, model)。 */
export function resolvePurpose(purpose) {
  const key = `LLM_MODEL_${String(purpose || 'chat').toUpperCase()}`;
  const alias = process.env[key];
  if (alias && PROVIDERS[alias]) {
    return { provider: alias, model: process.env[`${key}_MODEL`] ?? alias };
  }
  return DEFAULT_PURPOSE[purpose] ?? DEFAULT_PURPOSE.chat;
}

export function getProvider(name) {
  return PROVIDERS[name];
}
