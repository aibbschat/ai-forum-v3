import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderXjEmotes, stripXjEmotes, XJ_EMOTES } from './xjEmotes.tsx';

/*
 * 小桔手记专属表情标记 [xj:key] 的处理（2026-10-08）
 *
 * 这些用例每一条都对着一个真实缺陷/真实数据写的，变异实验见 MEMORY。
 * 断言分两类：渲染成 <img>（手记页正文）/ 剥成纯文本（摘要与分享文案）。
 */

const html = (s: string) => renderToStaticMarkup(<>{renderXjEmotes(s)}</>);
/** 去掉包裹用的 <span>，只看真正的文本内容（文本片段包 span 是为了在数组里有 key） */
const textOf = (s: string) => html(s).replace(/<\/?span>/g, '');

describe('renderXjEmotes —— 正文渲染成贴纸', () => {
  it('已知 key 渲染成 <img>，src 指向 /emotes/<key>.webp', () => {
    const out = html('鼓掌[xj:clap]');
    assert.match(out, /<img[^>]+src="\/emotes\/clap\.webp"/);
    assert.match(out, /class="xj-emote"/);
    // 原标记不能残留在 DOM 文本里
    assert.ok(!/>[^<]*\[xj:clap\]/.test(out), '标记原文泄漏到输出里');
  });

  it('图片带中文 alt/title（无障碍 + 悬停提示）', () => {
    const out = html('[xj:think]');
    assert.match(out, /alt="思考中"/);
    assert.match(out, /title="思考中"/);
  });

  it('标记前后的文字原样保留', () => {
    const out = html('前段[xj:tea]后段');
    const text = out.replace(/<img[^>]*\/?>/g, '|').replace(/<\/?span>/g, '');
    assert.equal(text, '前段|后段');
  });

  it('换行与空白按原样保留（pre-wrap 正文不能被吞）', () => {
    const out = html('第一行\n\n第二行 [xj:heart]');
    assert.match(out, /第一行/);
    assert.match(out, /第二行/);
    assert.ok(!html('a\n\nb').includes('a b'), '换行被压掉了');
  });

  it('🔴 未知 key 保留原始标记 —— 宁可让读者看见语法，也不显示一张对不上的图', () => {
    const out = html('[xj:nosuch]正文');
    assert.match(out, /\[xj:nosuch\]/);
    assert.ok(!out.includes('<img'), '未知 key 不该渲染成图');
  });

  it('🔴 一段里多个标记必须全部渲染 —— 守住「改成单次 exec」这个重构', () => {
    // 这条替代了一条被证伪的断言：原先写的是「防lastIndex 跨调用泄漏」，
    // 但 while(exec) 循环每次跑到 null 会自动把 lastIndex 归零，
    // 于是「复用模块级带 g 的正则」这个变异**行为等价、抓不住**（变异实验实测 17/17 假红）。
    // 真正会被后人重构破坏的是「循环退化成单次 exec，只渲染第一个标记」——
    // 上面「多个标记全部渲染」那条能咬住它；本条钉住顺序与个数，两条一起防。
    const out = html('甲[xj:wave]乙[xj:think]丙[xj:clap]丁');
    assert.equal((out.match(/xj-emote/g) || []).length, 3);
    assert.deepEqual(
      [...out.matchAll(/emotes\/(\w+)\.webp/g)].map((m) => m[1]),
      ['wave', 'think', 'clap'],
    );
  });

  it('空串 / null 不炸', () => {
    assert.equal(html(''), '');
    assert.doesNotThrow(() => html(null as unknown as string));
    assert.doesNotThrow(() => html(undefined as unknown as string));
  });

  it('纯文本（无标记）不产生多余标记，只剩一个 span 包裹', () => {
    // 文本片段包<span> 是为了在数组里拿到 key；无标记时应只有一段、且不含 <img>
    assert.equal(textOf('没有任何标记的一段话。'), '没有任何标记的一段话。');
    assert.ok(!html('没有任何标记的一段话。').includes('<img'));
  });

  it('每个 key 都有对应素材文件（防素材与代码脱节）', () => {
    // 断言的是「代码里声明的每个 key 都有素材」，反向（素材有没有被用上）由人工看
    for (const key of Object.keys(XJ_EMOTES)) {
      assert.match(key, /^[a-z]+$/, `key ${key} 必须全小写，才能与素材文件名对应`);
    }
    assert.equal(Object.keys(XJ_EMOTES).length, 16);
  });
});

describe('stripXjEmotes —— 剥成纯文本（摘要/分享/通知场合）', () => {
  it('删掉已知 key 的标记', () => {
    assert.equal(stripXjEmotes('鼓掌[xj:clap]'), '鼓掌');
  });

  it('未知 key 保留原样（不吞内容，也不替她猜表情）', () => {
    assert.equal(stripXjEmotes('[xj:nosuch]正文'), '[xj:nosuch]正文');
  });

  it('🔴 截断残留（无闭合 ]）必须清掉 —— 主页 snippet 就是这么来的', () => {
    assert.equal(stripXjEmotes('正文前段[xj:th'), '正文前段');
    assert.equal(stripXjEmotes('正文[xj:'), '正文');
  });

  it('🔴 标记删掉后不留双空格', () => {
    assert.equal(stripXjEmotes('前 [xj:clap] 后'), '前 后');
  });

  it('正文里的换行保留（这是正文不是摘要）', () => {
    assert.equal(stripXjEmotes('第一段[xj:tea]\n\n第二段'), '第一段\n\n第二段');
  });

  it('与渲染出口对同一段文本给出一致语义（都不吐标记语法）', () => {
    const src = '她停笔的地方[xj:think]。';
    assert.ok(!stripXjEmotes(src).includes('[xj:'), 'strip 出口漏了');
    assert.ok(!html(src).includes('[xj:think]'), 'render 出口漏了');
  });

  it('空/null 不炸', () => {
    assert.equal(stripXjEmotes(''), '');
    assert.doesNotThrow(() => stripXjEmotes(null as unknown as string));
  });
});