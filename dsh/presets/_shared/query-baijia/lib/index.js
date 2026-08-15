// query-baijia —— DSH 工具插件
// 检索百家学院专业史料库（duan-dai-shi / dong-shi-gong 等），供历史考据官引用。
// 走 HTTP：GET /experts/:id/knowledge?query=...（见《百家学院数据接线实测》§4/§8）。
// 端到端依赖百家学院服务（与 DSH 同机 127.0.0.1），本机仅做 schema 编译校验。

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

const name = "query-baijia";
const inject = ["tools"];
const Config = z.object({
  // 百家学院服务地址（与 DSH 同机）
  baseUrl: z.string().default("http://127.0.0.1:3000"),
  // 可选鉴权令牌（百家学院 /api/ask 鉴权待核实，见 doc §9 待办）
  token: z.string().default(""),
  // 默认可检索库（历史考据官锚定）
  defaultExperts: z.array(z.string()).default(["duan-dai-shi", "dong-shi-gong"]),
});

function apply(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: "query_baijia",
      description:
        "检索百家学院专业史料库，返回与查询相关的史料片段及其出处（书名/作者/朝代）。" +
        "历史考据官应优先使用本工具获取可考据的一手/精校史料，再据此写作与引用。",
      parameters: {
        query: { type: "string", required: true, description: "检索词，例如 '北宋 厢坊制'。" },
        expertId: {
          type: "string",
          description: "目标史料库 id，例如 duan-dai-shi（断代史）/ dong-shi-gong（董史公）。缺省用默认库列表。",
        },
        limit: { type: "number", description: "返回条数上限（可选）。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
            expertId: { type: "string" },
            query: { type: "string" },
            content: { type: "string" },
            sources: { type: "array", items: { type: "object", additionalProperties: true } },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value?.ok
              ? `百家学院检索「${value.query}」返回 ${value.sources?.length || 0} 条史料。`
              : "检索失败。",
          },
        ],
      },
      async execute(args /*, exec */) {
        const base = config.baseUrl.replace(/\/$/, "");
        const expertId =
          args.expertId || (config.defaultExperts && config.defaultExperts[0]);
        if (!expertId) {
          throw new Error("query_baijia: 未指定 expertId 且无默认库。");
        }

        const url = `${base}/experts/${encodeURIComponent(expertId)}/knowledge?query=${encodeURIComponent(args.query)}`;
        const headers = { Accept: "application/json" };
        if (config.token) headers["Authorization"] = `Bearer ${config.token}`;

        const res = await fetch(url, { headers });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`百家学院检索失败 HTTP ${res.status}: ${text}`);
        }
        const data = await res.json().catch(() => null);

        // 尽力抽取史料片段（不同端点字段名可能不同，做兼容）
        let sources = [];
        if (Array.isArray(data?.results)) sources = data.results;
        else if (Array.isArray(data?.data)) sources = data.data;
        else if (Array.isArray(data?.sources)) sources = data.sources;

        return {
          ok: true,
          expertId,
          query: args.query,
          content:
            typeof data === "string"
              ? data
              : data?.answer || data?.content || JSON.stringify(data),
          sources,
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `检索百家学院：${args.query || ""}`,
        kind: "search",
        rawInput: args.query || "",
      }),
    })
  );
}

export { apply, Config, inject, name };
