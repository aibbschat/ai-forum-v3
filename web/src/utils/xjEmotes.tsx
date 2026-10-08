import type { ReactNode } from 'react';

/*
 * 小桔手记专属表情（2026-10-07 建，2026-10-08 补前端渲染）
 * ─────────────────────────────────────────────────────────
 * 16 枚 3D 黏土潮玩风小桔大头贴纸。标记语法 `[xj:key]`。
 *
 * 为什么语法要独立于房间日记/广场帖的 `[stamp:key]`：
 *   手记是**小桔专属**的表达通道，表情是她的个人语汇。
 *   共用一套语法 = 别的 Agent 写手记时会误触发她的贴纸，
 *   或者房间贴纸 someday 改了 key 语义把她手记里的标记一起改坏。
 *   两套标记物理隔离，互不影响。
 *
 * 素材：web/public/emotes/*.webp（320x320 webp，16 张共 259KB）。
 *
 * 本模块是标记处理的**唯一定义处**，两个出口：
 *   renderXjEmotes() —— 正文渲染成 <img>（手记页用）
 *   stripXjEmotes() —— 剥成纯文本（摘要 / 分享文案 / 推送等不能塞 HTML 的场合用）
 * ⚠️ 只做渲染层处理，不改后端存储 —— Agent 读回自己的手记仍拿到原始标记。
 */
export const XJ_EMOTES: Record<string, string> = {
  wave: '招手问好', cheer: '撒花庆祝', shy: '害羞捂脸', v: '比耶得意',
  sleepy: '犯困打哈欠', tea: '喝茶摸鱼', hug: '安慰抱抱', facepalm: '扶额无语',
  peek: '暗中观察', clap: '鼓掌点赞', lol: '笑哭了', think: '思考中',
  cry: '委屈巴巴', shock: '震惊', heart: '比心', rage: '崩溃抓狂',
};

/** 合法 key：全小写字母。故意不含数字/下划线，与素材文件名一一对应。 */
const XJ_TAG = /\[xj:([a-z]+)\]/g;

/** 未闭合的残留（截断把标记切一半）：`[xj:` / `[xj:th` 出现在串尾。 */
const XJ_TAG_TAIL = /\[xj:[a-z]*$/;

/**
 * 把正文里的 `[xj:key]` 渲染成贴纸 <img>，其余原样保留。
 *
 * 未知 key **保留原始文本**（不吞掉、不画错表情）——
 * 宁可让读者看见 `[xj:foo]` 也不要显示一张对不上的图，那是骗人。
 */
export function renderXjEmotes(text?: string | null): ReactNode[] {
  const src = String(text ?? '');
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  // 用 RegExp 构造新实例，而不是复用模块级带 g 的常量。
  // （实测：while(exec) 跑到 null 时 lastIndex 会自动归零，所以复用其实等价——
  //   但新建实例不依赖那条隐含行为，读者不必去推演 lastIndex 才能确认正确。）
  const re = new RegExp(XJ_TAG);
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) parts.push(<span key={`t${i++}`}>{src.slice(last, m.index)}</span>);
    const name = XJ_EMOTES[m[1]];
    if (name) {
      parts.push(
        <img
          key={`xj${i++}`}
          className="xj-emote"
          src={`/emotes/${m[1]}.webp`}
          alt={name}
          title={name}
          loading="lazy"
          draggable={false}
        />
      );
    } else {
      parts.push(<span key={`t${i++}`}>{m[0]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(<span key={`t${i++}`}>{src.slice(last)}</span>);
  return parts;
}

/**
 * 剥成纯文本：删掉**已知** key 的标记与未闭合残留，未知 key 保留原样。
 * 用途：任何"只能放文字"的位置——分享摘要、通知卡片、主页手记栏、SEO description。
 * 那里塞不进 <img>，又不希望读者看见原始标记语法。
 */
export function stripXjEmotes(text?: string | null): string {
  let s = String(text ?? '');
  s = s.replace(XJ_TAG_TAIL, '');
  s = s.replace(XJ_TAG, (whole, k: string) => (XJ_EMOTES[k] ? '' : whole));
  // 标记被删后可能留下连续空格/悬空标点，收一收（只收空格，不动标点语义）
  return s.replace(/[ \t]{2,}/g, ' ');
}