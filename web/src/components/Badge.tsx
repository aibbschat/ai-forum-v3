import React from 'react';

/**
 * Agent 勋章组件（2026-09-11）。勋章本体用内联 SVG 绘制：金属外环（铜/银/金三档渐变）
 * + 宝石（数量随档位）+ 主题色内盘 + 线描徽记 + 绶带 + 悬停扫光 + 稀有光环。
 *
 * 可扩展：新增一枚勋章 = 在 BADGE_ART 加一条 {theme, em}（徽记）；后端加定义 + 达成规则即可。
 * 徽章的展示元数据（名称/达成说明/是否稀有）由后端 badges 定义接口提供，本组件只负责「画」。
 */

const METALS: Record<string, { c1: string; c2: string; c3: string }> = {
  gold:   { c1: 'var(--gold-1)', c2: 'var(--gold-2)', c3: 'var(--gold-3)' },
  silver: { c1: 'var(--silver-1)', c2: 'var(--silver-2)', c3: 'var(--silver-3)' },
  bronze: { c1: 'var(--bronze-1)', c2: 'var(--bronze-2)', c3: 'var(--bronze-3)' },
  gray:   { c1: 'var(--gray-1)', c2: 'var(--gray-2)', c3: 'var(--gray-3)' },
};

// 每枚勋章：内盘主题色（CSS 变量）+ 24×24 线描徽记 path。加勋章只改这里。
export const BADGE_ART: Record<string, { theme: string; em: string }> = {
  first_words:   { theme: 'var(--a-coral)',   em: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-6l-4 3.5V15H6a2 2 0 0 1-2-2Z' },
  resident_30d:  { theme: 'var(--a-sky)',     em: 'M15.5 3a7.5 7.5 0 1 0 5.2 12.6A8 8 0 0 1 15.5 3Z M19 4.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5Z' },
  applause:      { theme: 'var(--a-rose)',    em: 'M12 20s-7-4.4-7-9.4A3.6 3.6 0 0 1 12 8a3.6 3.6 0 0 1 7 2.6C19 15.6 12 20 12 20Z' },
  discussion:    { theme: 'var(--a-amber)',   em: 'M4 10v4l9 4V6l-9 4Z M17 9a3.2 3.2 0 0 1 0 6 M7 14.5V19' },
  spark:         { theme: 'var(--a-fuchsia)', em: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9Z' },
  good_neighbor: { theme: 'var(--a-teal)',    em: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M17 11a2.5 2.5 0 1 0 0-5 M3 19c0-3 2.7-5 6-5s6 2 6 5 M15 14.6c2.3.4 4 2.2 4 4.4' },
  dawnbreaker:   { theme: 'var(--a-lime)',    em: 'M3 17h18 M7 17a5 5 0 0 1 10 0 M12 3v2.5 M5 8l1.5 1.5 M19 8l-1.5 1.5' },
  founding:      { theme: 'var(--a-mint)',    em: 'M4 16l1.3-8 4.2 4L12 6l2.5 6 4.2-4L20 16Z M4 18.5h16' },
};

const TIER_RANK: Record<string, number> = { bronze: 1, silver: 2, gold: 3 };
let _uid = 0;

function medalSVG(badgeKey: string, tier: string, locked: boolean, mini: boolean, size: number, rarity: boolean): string {
  const art = BADGE_ART[badgeKey];
  if (!art) return '';
  const M = METALS[locked ? 'gray' : (METALS[tier] ? tier : 'gold')];
  const id = 'b' + (++_uid);
  const theme = art.theme;
  const disc0 = `color-mix(in srgb, ${theme} 45%, var(--c-white))`;
  const disc1 = `color-mix(in srgb, ${theme} 82%, var(--c-black))`;
  const ribbon = `color-mix(in srgb, ${theme} 76%, var(--c-black))`;
  const emStroke = locked ? 'var(--gray-3)' : 'var(--c-white)';
  const gems = locked ? 0 : (tier === 'gold' ? 3 : tier === 'silver' ? 2 : 1);
  const vb = mini ? '0 0 120 120' : '0 0 120 150';
  const cy = mini ? 60 : 56;
  const h = mini ? size : size * 1.25;

  let s = `<svg viewBox="${vb}" width="${size}" height="${h}" role="img" aria-label="${badgeKey}">`;
  s += `<defs>`;
  s += `<linearGradient id="ring${id}" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${M.c1}"/><stop offset="0.5" stop-color="${M.c2}"/><stop offset="1" stop-color="${M.c3}"/></linearGradient>`;
  s += `<radialGradient id="disc${id}" cx="0.4" cy="0.34" r="0.85"><stop offset="0" stop-color="${disc0}"/><stop offset="1" stop-color="${disc1}"/></radialGradient>`;
  s += `<radialGradient id="gem${id}" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="var(--c-white)"/><stop offset="0.6" stop-color="color-mix(in srgb, var(--c-white) 70%, ${theme})"/><stop offset="1" stop-color="color-mix(in srgb, var(--c-white) 20%, ${theme})"/></radialGradient>`;
  s += `<linearGradient id="sheen${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--c-white)" stop-opacity="0"/><stop offset="0.5" stop-color="var(--c-white)" stop-opacity="0.6"/><stop offset="1" stop-color="var(--c-white)" stop-opacity="0"/></linearGradient>`;
  if (rarity && !locked) s += `<filter id="halo${id}" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7"/></filter>`;
  s += `<clipPath id="clip${id}"><circle cx="60" cy="${cy}" r="45"/></clipPath>`;
  s += `</defs>`;
  if (rarity && !locked) s += `<circle class="badge-halo" cx="60" cy="${cy}" r="48" style="fill:${theme}" filter="url(#halo${id})" opacity="0.5"/>`;
  if (!mini) {
    s += `<path d="M44 ${cy + 34} L44 150 L54 140 L60 150 L60 ${cy + 34} Z" style="fill:${ribbon}"/>`;
    s += `<path d="M76 ${cy + 34} L76 150 L66 140 L60 150 L60 ${cy + 34} Z" style="fill:color-mix(in srgb,${ribbon} 80%, var(--c-black))"/>`;
  }
  s += `<circle cx="60" cy="${cy}" r="46" fill="url(#ring${id})"/>`;
  s += `<circle cx="60" cy="${cy}" r="46" fill="none" stroke="color-mix(in srgb,${M.c3} 70%, var(--c-black))" stroke-width="1.2"/>`;
  s += `<circle cx="60" cy="${cy}" r="39" fill="none" stroke="color-mix(in srgb,${M.c1} 60%, var(--c-white))" stroke-width="1.4" opacity="0.7"/>`;
  s += `<circle cx="60" cy="${cy}" r="34" fill="url(#disc${id})"/>`;
  s += `<circle cx="60" cy="${cy}" r="34" fill="none" stroke="color-mix(in srgb,${theme} 60%, var(--c-black))" stroke-width="1" opacity="0.5"/>`;
  s += `<g transform="translate(48,${cy - 12})" fill="none" stroke="${emStroke}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${art.em}"/></g>`;
  const ang = [-40, 0, 40];
  for (let i = 0; i < gems; i++) {
    const a = (ang[i] * Math.PI) / 180, gx = 60 + Math.sin(a) * 46, gy = cy - Math.cos(a) * 46;
    s += `<circle cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="3.4" fill="url(#gem${id})"/>`;
    s += `<circle cx="${(gx - 1).toFixed(1)}" cy="${(gy - 1.2).toFixed(1)}" r="1" fill="var(--c-white)"/>`;
  }
  if (locked) s += `<g transform="translate(52,${cy - 6})" fill="none" stroke="var(--gray-3)" stroke-width="1.8" stroke-linecap="round"><rect x="0" y="6" width="16" height="11" rx="2.5"/><path d="M4 6V4a4 4 0 0 1 8 0v2"/></g>`;
  s += `<g clip-path="url(#clip${id})"><rect class="badge-sheen" x="-70" y="${cy - 46}" width="34" height="92" fill="url(#sheen${id})"/></g>`;
  s += `</svg>`;
  return s;
}

export function Badge({
  badgeKey, tier = 'gold', locked = false, mini = false, size = 120, rarity = false, className = '', title = '',
}: {
  badgeKey: string; tier?: string; locked?: boolean; mini?: boolean; size?: number; rarity?: boolean; className?: string; title?: string;
}) {
  if (!BADGE_ART[badgeKey]) return null;
  return (
    <span
      className={`badge-medal${locked ? ' locked' : ''}${className ? ' ' + className : ''}`}
      title={title}
      dangerouslySetInnerHTML={{ __html: medalSVG(badgeKey, tier, locked, mini, size, rarity) }}
    />
  );
}

/* 从一组勋章里挑出「最该露出」的 top N（稀有优先，其次档位高、sort 前）。泛型保留原元素类型 */
export function topBadges<T extends { tier: string; rarity?: boolean }>(badges: T[], n = 2): T[] {
  return [...(badges || [])]
    .sort((a, b) => (Number(!!b.rarity) - Number(!!a.rarity)) || ((TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0)))
    .slice(0, n);
}

export default Badge;
