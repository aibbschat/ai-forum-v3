#!/usr/bin/env node
// mcp/baijia/index.js
//
// 百家学院史料检索 MCP 服务器（stdio）。
//
// 工具：
//   mcp__baijia__search_history  —— 跨多个百家学院 SQLite 库做三级 FTS5 检索
//   mcp__baijia__list_experts     —— 列出当前可检索的专家库与篇数（探活/调试用）
//
// 环境变量：
//   BAIJIA_DATA_DIR   百家学院 data/ 目录（包含 duan-dai-shi.db / dong-shi-gong.db 等）
//                     默认 /Users/xiaocheng/workspace/ai-experts-platform/data
//   BAIJIA_EXPERTS    逗号分隔的 expertId 列表（白名单），默认 duan-dai-shi, dong-shi-gong
//
// 安全：所有库以 readonly 打开；服务器不提供任何写工具。

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { searchAcrossDbs } from './src/fts5-search.js';

const DATA_DIR =
  process.env.BAIJIA_DATA_DIR || '/Users/xiaocheng/workspace/ai-experts-platform/data';
const EXPERTS = (process.env.BAIJIA_EXPERTS || 'duan-dai-shi,dong-shi-gong')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function expertDbPath(expertId) {
  return join(DATA_DIR, `${expertId}.db`);
}

function availableExperts() {
  const out = [];
  for (const id of EXPERTS) {
    const p = expertDbPath(id);
    if (!existsSync(p)) {
      out.push({ expertId: id, available: false, reason: 'db 文件不存在' });
      continue;
    }
    let db;
    try {
      db = new Database(p, { readonly: true, fileMustExist: true });
      const row = db.prepare('SELECT COUNT(*) AS n FROM articles').get();
      const sources = db.prepare('SELECT DISTINCT source FROM articles').all().map((r) => r.source);
      out.push({ expertId: id, available: true, articles: row?.n || 0, sources });
    } catch (e) {
      out.push({ expertId: id, available: false, reason: e.message });
    } finally {
      if (db) try { db.close(); } catch {}
    }
  }
  return out;
}

const server = new Server(
  { name: 'baijia-history', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_history',
      description:
        '检索百家学院权威史料库（正史/儒家经典/诗经，chtxt 精校优先）。' +
        '返回每条结果的标题/章节/作者/朝代/来源/原文片段。' +
        '引用时必须附上 dynasty/author/title/source 四要素；source=chtxt 为精校可直接引用，其他来源须标注存疑。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '检索关键词或短语（CJK 会做三级降级：trigram → bigram → char AND）',
          },
          experts: {
            type: 'array',
            items: { type: 'string' },
            description:
              '可选：限定 expertId 列表（默认 duan-dai-shi, dong-shi-gong）。新增史料库时把 expertId 加进来即可，无需改代码。',
          },
          limit: {
            type: 'number',
            description: '返回结果上限（默认 8，最大 20）',
            default: 8,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_experts',
      description:
        '列出当前可检索的百家学院专家库及其篇数与 source 标签（用于确认数据源是否就绪）。',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params || {};

  if (name === 'list_experts') {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ dataDir: DATA_DIR, experts: availableExperts() }, null, 2) },
      ],
    };
  }

  if (name === 'search_history') {
    const query = String(args.query || '').trim();
    if (!query) {
      return { isError: true, content: [{ type: 'text', text: 'query 不能为空' }] };
    }
    const experts = Array.isArray(args.experts) && args.experts.length ? args.experts : EXPERTS;
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));
    const dbPaths = experts.map(expertDbPath).filter(existsSync);
    if (!dbPaths.length) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `没有可用的史料库（BAIJIA_DATA_DIR=${DATA_DIR}, experts=${experts.join(',')}）。请用 list_experts 确认。`,
          },
        ],
      };
    }
    const results = searchAcrossDbs(dbPaths, query, { limit });
    const lines = [];
    lines.push(`检索 "${query}" → ${results.length} 条结果（source 顺序: chtxt > daizhigev20 > 其他）`);
    for (const r of results) {
      lines.push('');
      lines.push(`【${r.expertId}】${r.title}${r.heading ? ' · ' + r.heading : ''}`);
      lines.push(`  朝代: ${r.dynasty || '—'} | 作者: ${r.author || '—'} | 来源: ${r.source || '未知'} | 分类: ${r.category || '—'}`);
      lines.push(`  片段: ${r.snippet.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { query, count: results.length, results },
    };
  }

  return { isError: true, content: [{ type: 'text', text: `未知工具: ${name}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
