// server/llm/config.js
// 统一模型路由层配置：多供应商可插拔 + 按场景路由 + 自动降级。
//
// 换模型 / 换供应商 / 控成本 = 改这里 + .env，业务代码零改动。
// 所有业务代码（含 memory 巩固）一律走 server/llm/client.js 的 chat()/chatStream()，
// 禁止再直接 fetch /chat/completions 或读 DEEPSEEK_* 变量。
//
// 供应商密钥统一用语义清晰的变量名，消灭"名叫 DEEPSEEK 实际装火山 key"的陷阱：
//   LLM_VOLCENGINE_API_KEY / LLM_VOLCENGINE_BASE_URL / LLM_VOLCENGINE_MODEL
//   LLM_DEEPSEEK_API_KEY  / LLM_DEEPSEEK_BASE_URL  / LLM_DEEPSEEK_MODEL
//   LLM_XIAOMI_API_KEY    / LLM_XIAOMI_BASE_URL    / LLM_XIAOMI_MODEL
// 同时兼容历史变量名 DEEPSEEK_API_KEY/ENDPOINT/MODEL（=火山），平滑迁移不炸现有部署。

/**
 * 供应商定义。apiKey()/chatUrl()/modelId() 为函数，读取 env（便于测试与热切换）。
 * chatUrl 为完整 /chat/completions POST 地址（OpenAI 兼容）。
 */
const env = (key, fallback) => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
};

export const PROVIDERS = {
  // 主用：火山引擎 Agent Plan（ark-code-latest，包月套餐，AFP 额度统一抵扣）
  volcengine: {
    label: 'Volcengine Agent Plan (ark-code-latest)',
    apiKey: () =>
      env('LLM_VOLCENGINE_API_KEY') ||
      env('DEEPSEEK_API_KEY'), // 历史兼容：.env 里 DEEPSEEK_API_KEY 实为此 key
    chatUrl: () =>
      env('LLM_VOLCENGINE_BASE_URL') ||
      env('DEEPSEEK_ENDPOINT') ||
      'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions',
    modelId: () =>
      env('LLM_VOLCENGINE_MODEL') || env('DEEPSEEK_MODEL') || 'ark-code-latest',
  },

  // 备用：DeepSeek 官方按量（主用限流/宕机/套餐打满时接管）。
  // 密钥须经 LLM_DEEPSEEK_API_KEY 显式注入；未配则该供应商被视为「未启用」自动跳过。
  deepseek: {
    label: 'DeepSeek Official (pay-as-you-go)',
    apiKey: () => env('LLM_DEEPSEEK_API_KEY'),
    chatUrl: () =>
      env('LLM_DEEPSEEK_BASE_URL') || 'https://api.deepseek.com/chat/completions',
    modelId: () => env('LLM_DEEPSEEK_MODEL') || 'deepseek-chat',
  },

  // 可选：小米 MiMo Token Plan（包月，OpenAI 兼容）。
  // BASE_URL(OpenAI 兼容): https://token-plan-cn.xiaomimimo.com/v1
  // key 格式 tp-xxxxx；未配 key 则自动跳过。
  xiaomi: {
    label: 'Xiaomi MiMo Token Plan',
    apiKey: () => env('LLM_XIAOMI_API_KEY') || env('XIAOMI_TOKEN_PLAN_CN_API_KEY'),
    chatUrl: () =>
      env('LLM_XIAOMI_BASE_URL') ||
      'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
    modelId: () => env('LLM_XIAOMI_MODEL') || 'mimo-v2.6-pro',
  },
};

// 降级顺序：主用在前，备用在后。无密钥的供应商自动跳过（不报错、用户无感）。
export const FALLBACK_ORDER = ['volcengine', 'deepseek', 'xiaomi'];

// 默认供应商（所有 purpose 的兜底）。可用 LLM_MODEL_<PURPOSE>=供应商别名 单独覆盖某场景。
// 根因修复（AI 伴侣 M3）：不再硬编码，改为读 LLM_MODEL_DEFAULT，由 switch-brain.sh 统一写入，
// 这样新增任何 purpose（如 companion）都自动跟随切换，不必每次记得改脚本（避免静默不一致）。
const DEFAULT_PURPOSE_PROVIDER = process.env.LLM_MODEL_DEFAULT || 'volcengine';

/** 解析某场景应使用的 (provider, model)。 */
export function resolvePurpose(purpose) {
  const p = String(purpose || 'chat');
  const aliasEnv = `LLM_MODEL_${p.toUpperCase()}`;
  const alias = process.env[aliasEnv];
  if (alias && PROVIDERS[alias]) {
    const modelEnv = `${aliasEnv}_MODEL`;
    return {
      provider: alias,
      model: process.env[modelEnv] || PROVIDERS[alias].modelId(),
    };
  }
  return {
    provider: DEFAULT_PURPOSE_PROVIDER,
    model: PROVIDERS[DEFAULT_PURPOSE_PROVIDER].modelId(),
  };
}

export function getProvider(name) {
  return PROVIDERS[name];
}
