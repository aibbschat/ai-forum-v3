/**
 * mdBlocks —— 把 markdown 正文切成「文本块 / 图片块」，供编辑器把图片渲染成真图。
 *
 * 设计要点（2026-09-15，应萧哥要求"图片要显示预览图而不是代码"）：
 *
 * 1. **无损**：`serialize(parse(x)) === x` 对所有输入严格成立。
 *    做法是「按行切分 + 图片块保留原始整行文本（raw）+ 块间用 \n 连接」。
 *    原文里每个块边界本来就恰好是一个 \n，所以拼回去必然逐字节相同。
 *    这样编辑器的数据源永远是原始 markdown，**不会静默改写已有稿件**
 *    （这正是我们不用 HTML 内核做全量 WYSIWYG 的原因：markdown ↔ HTML 往返
 *    会规范化列表符号、表格对齐、嵌套缩进，等于悄悄改稿）。
 *
 * 2. **保守**：只有「整行就是一个图片语法」才当图片块。
 *    行内混排（如 `文字 ![a](b) 文字`）保持原样留在文本块里，不做任何猜测。
 *
 * 3. **可识别历史脏数据**：早期 bug 时期可能把整个 data URI 写进了正文，
 *    这类块标记为 legacyEmbedded，由 UI 提示并允许一键移除（见 Compose.tsx）。
 */

export type TextBlock = { kind: 'text'; value: string };

export type ImageBlock = {
  kind: 'image';
  alt: string;
  url: string;
  /** 原始整行文本，序列化时原样吐回，保证无损 */
  raw: string;
  /** 是否为内嵌 data URI（历史 bug 产物，体积可能达数 MB） */
  legacyEmbedded: boolean;
};

export type Block = TextBlock | ImageBlock;

/** 整行图片语法：允许行首尾空白（含 CR），允许 URL 后带 "title"，URL 内不含空白和右括号 */
const IMAGE_LINE = /^[ \t]*!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)[ \t\r]*$/;

/** 超过这个长度的 data URI 视为历史脏数据（正常 URL 不会有这么长） */
const LEGACY_DATA_URI_LIMIT = 2048;

export function parseBlocks(content: string): Block[] {
  // 空正文也必须有一个可聚焦的文本块，否则编辑区点不进去
  if (!content) return [{ kind: 'text', value: '' }];

  const lines = content.split('\n');
  const blocks: Block[] = [];
  let buf: string[] = [];

  const flush = () => {
    if (buf.length) {
      blocks.push({ kind: 'text', value: buf.join('\n') });
      buf = [];
    }
  };

  for (const line of lines) {
    const m = IMAGE_LINE.exec(line);
    if (m) {
      flush();
      const url = m[2];
      blocks.push({
        kind: 'image',
        alt: m[1],
        url,
        raw: line,
        legacyEmbedded: url.startsWith('data:') && url.length > LEGACY_DATA_URI_LIMIT,
      });
    } else {
      buf.push(line);
    }
  }
  flush();

  // 理论不可达（content 非空时至少产生一个块），兜底避免 UI 拿到空数组
  if (!blocks.length) blocks.push({ kind: 'text', value: content });
  return blocks;
}

export function serializeBlocks(blocks: Block[]): string {
  return blocks.map((b) => (b.kind === 'image' ? b.raw : b.value)).join('\n');
}

/** 生成一个图片块（供上传成功后插入使用） */
export function makeImageBlock(alt: string, url: string): ImageBlock {
  // 与上传接口返回的短路径一致，alt 里的方括号会破坏语法，清掉
  const safeAlt = alt.replace(/[[\]]/g, '');
  return {
    kind: 'image',
    alt: safeAlt,
    url,
    raw: `![${safeAlt}](${url})`,
    legacyEmbedded: false,
  };
}

/** 该块是否只由空白字符组成（纯空行块，用来决定渲染高度） */
export function isBlankText(b: Block): boolean {
  return b.kind === 'text' && b.value.trim() === '';
}
