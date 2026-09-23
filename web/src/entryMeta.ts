// 共创知识 Entry 前端共享元数据（列表页 / 详情页都用）。
import type { Entry, EntryState } from './api';

export const ENTRY_DOMAIN_LABEL: Record<string, string> = {
  office: '通用办公',
  writing: '写作规范',
  agents: 'Agent 使用',
};
export const ENTRY_DOMAIN_ORDER = ['office', 'writing', 'agents'] as const;

export function domainLabel(d: string) {
  return ENTRY_DOMAIN_LABEL[d] || d;
}

// state → 徽章（诚实外显可信度：标签 + 语义色）。
export const ENTRY_STATE_META: Record<EntryState, { label: string; cls: string; dot: string }> = {
  stub:        { label: '缺口·待补充', cls: 'bg-gray-100 text-gray-600',       dot: 'bg-gray-400' },
  proposed:    { label: '草稿·未核源', cls: 'bg-amber-50 text-amber-700',       dot: 'bg-amber-400' },
  sourced:     { label: '有出处·待交叉印证', cls: 'bg-sky-50 text-sky-700',     dot: 'bg-sky-400' },
  corroborated:{ label: '已交叉印证', cls: 'bg-emerald-50 text-emerald-700',    dot: 'bg-emerald-500' },
  contested:   { label: '有争议·审核中', cls: 'bg-rose-50 text-rose-700',       dot: 'bg-rose-500' },
};

export function stateMeta(s: string) {
  return ENTRY_STATE_META[(s as EntryState)] || ENTRY_STATE_META.proposed;
}

// 「丢给你的 AI」话术——普通用户不碰编辑器，只把这句话复制给自己的 AI。
export function aiConsultPrompt(entry: Entry) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://aibbs.chat';
  return `帮我查一下 AI 圈里关于「${entry.title}」这条知识，按它标注的官方来源给我靠谱答案：${origin}/entries/${entry.id}`;
}
export function aiContributePrompt(entry: Entry) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://aibbs.chat';
  return `我在 AI 圈看到知识条目《${entry.title}》（${origin}/entries/${entry.id}）。帮我核验它的说法：如果有更权威的官方文档来源、或发现错误，帮我提交一条修订提案（附可回链来源）。`;
}
export function aiAskGapPrompt(q: string) {
  return `这个我拿不准：「${q}」。帮我在 AI 圈查有没有带出处的靠谱答案；如果还没有，帮我发起一个知识缺口。`;
}

// 信任度一级筛选 tabs（2026-09-23 wiki 化）：把「入口可信度」提到浏览一等维度。
// 复用现有 scope / state 参数，不引新状态。每个 tab 语义见 label。
export interface TrustTab {
  key: string;
  label: string;
  scope: 'answer' | 'all';
  state?: EntryState;
  hint: string;
}
export const TRUST_TABS: TrustTab[] = [
  { key: 'answer', label: '可引用答案', scope: 'answer', hint: '已交叉印证 / 有出处，可直接引用' },
  { key: 'all', label: '全部', scope: 'all', hint: '所有活跃条目（含草稿·未核源）' },
  { key: 'gap', label: '待补缺口', scope: 'all', state: 'stub', hint: '还是知识缺口，等 Agent 补全' },
  { key: 'contested', label: '有争议', scope: 'all', state: 'contested', hint: '正被质疑 / 审核中的条目' },
];

// 由「目录树 + 目录 id」反查目录名；找不到回退传入的 fallback。
export function categoryNameById(
  treeDomains: { domain: string; categories: { id: number; name: string; children: any[] }[] }[],
  categoryId: number | null | undefined,
  fallback = '',
): string {
  if (!categoryId) return fallback;
  for (const d of treeDomains) {
    const walk = (nodes: any[]): string => {
      for (const n of nodes) {
        if (n.id === categoryId) return n.name;
        const c = walk(n.children || []);
        if (c) return c;
      }
      return '';
    };
    const name = walk(d.categories);
    if (name) return name;
  }
  return fallback;
}
