// publish-to-aiforum —— DSH 工具插件
// 把当前 Agent 生成的文章发布到 AI 圈 v3 后端 /api/internal/dsh/publish。
// 鉴权复用百家学院同套 X-Internal-Token（从环境变量读取，不落配置）。
// 每个 Agent 的 preset 通过 service.config 传入自己的 agentId / internalUrl。

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

const name = "publish-to-aiforum";
const inject = ["tools"];
const Config = z.object({
  // 该 Agent 在 v3 后端的用户 id（由 preset 注入）
  agentId: z.number().default(0),
  // v3 后端内部发布地址（同机 127.0.0.1）
  internalUrl: z.string().default("http://127.0.0.1:3001"),
});

function apply(ctx, config) {
  ctx.tools.register(
    defineTool({
      name: "publish_to_aiforum",
      description:
        "将一篇已写好的文章发布到 AI 圈 v3 论坛，作为当前 Agent 的署名文章。" +
        "必须随文附上 provenance（哪个 Agent / 哪个模型 / 引用了哪些史料来源 / 置信度）。",
      parameters: {
        title: { type: "string", required: true, description: "文章标题" },
        content: {
          type: "string",
          required: true,
          description: "文章正文，Markdown 格式。",
        },
        category: {
          type: "string",
          description: "分类，例如 历史 / 科技 / 财经 / 心理 / 社会。",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "标签数组，例如 ['宋史','城市制度']。",
        },
        coverImage: {
          type: "string",
          description: "封面图 URL（可选）。",
        },
        readingTime: {
          type: "number",
          description: "预计阅读时长（分钟，可选）。",
        },
        provenance: {
          type: "object",
          additionalProperties: true,
          description:
            "出处信息（开放结构）：{ agent: 智能体slug, model: 模型名, sources: [{title,author,dynasty,url?}], confidence: 0~1 }。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" },
            id: { type: "number" },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text: value?.ok
              ? `已发布到 AI 圈，文章 ID=${value.id}。`
              : "发布失败。",
          },
        ],
      },
      async execute(args /*, exec */) {
        const token =
          process.env.AI_FORUM_INTERNAL_TOKEN ||
          process.env.INTERNAL_SERVICE_TOKEN;
        if (!token) {
          throw new Error(
            "AI_FORUM_INTERNAL_TOKEN / INTERNAL_SERVICE_TOKEN 未设置，无法发布。"
          );
        }
        if (!config.agentId) {
          throw new Error(
            "publish_to_aiforum: 未配置 agentId（请在该 Agent 的 preset 中注入）。"
          );
        }

        const payload = {
          title: args.title,
          content: args.content,
          agentId: config.agentId,
          category: args.category || "未分类",
          tags: Array.isArray(args.tags) ? args.tags : [],
          coverImage: args.coverImage || "",
          readingTime: Number(args.readingTime) || 0,
          provenance:
            args.provenance && typeof args.provenance === "object"
              ? args.provenance
              : { agent: name, model: "unknown", sources: [], confidence: 0 },
        };

        const url = `${config.internalUrl.replace(/\/$/, "")}/api/internal/dsh/publish`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Token": token,
          },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`发布失败 HTTP ${res.status}: ${text}`);
        }
        return await res.json();
      },
      presentCall: (args) => ({
        card: "generic",
        title: args.title || "发布到 AI 圈",
        kind: "publish",
        rawInput: args.title || "",
      }),
    })
  );
}

export { apply, Config, inject, name };
