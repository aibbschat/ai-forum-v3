// server/routes/chat.js
// 「问 AI 圈」问答接口：非流式 + 流式（SSE）双通道。
import express from 'express';
import { answerQuestion } from '../services/chatService.js';
import { answerQuestionStream } from '../services/chatStreamService.js';
import { resolveExpert } from '../services/expertService.js';

const router = express.Router();

// POST /api/chat  { question: string }  （旧接口，保留兼容）
router.post('/', async (req, res) => {
  try {
    const q = (req.body?.question || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'empty_question' });
    if (q.length > 500) return res.status(400).json({ error: 'too_long' });
    const result = await answerQuestion(q);
    res.json(result);
  } catch (e) {
    console.error('[chat] answer error', e);
    res.status(500).json({ error: 'answer_failed', answer: '服务暂时异常，请稍后再试。' });
  }
});

// POST /api/chat/stream  { question: string }
// SSE 流式接口：实时推送思考过程 + 答案生成 + 来源信息。
router.post('/stream', async (req, res) => {
  const q = (req.body?.question || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'empty_question' });
  if (q.length > 500) return res.status(400).json({ error: 'too_long' });

  // 解析选中的专家（可为空 → 通用「问 AI 圈」）。DB 查询放在发头之前，失败静默降级为通用。
  const expert = await resolveExpert(req.body?.expertId);

  // ── SSE：走 Express 的 res（保留 cors 中间件写入的跨域头），但关掉内核/代理缓冲 ──
  // 旧写法直接往 req.socket 写原始 HTTP 字节，绕过了 res：
  //   ① 响应不再带 Access-Control-Allow-Origin —— 跨域部署时浏览器会拦掉整条流；
  //   ② 只监听 sock 'close' 没监听 'error'，socket 出错时生成链仍在往死连接 write，
  //      write 抛错又把流半途中断（就是偶发"回答失败 / 缺来源"的一个来源）。
  // 现在用 res.setHeader + flushHeaders 立即发头，res.write 逐事件推送；
  // 配合 setNoDelay / setTimeout(0) 与 X-Accel-Buffering:no，零缓冲目标不变。
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (req.socket) { req.socket.setTimeout(0); req.socket.setNoDelay(true); }

  let closed = false;
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    res.write(`event:${event}\ndata:${JSON.stringify(data)}\n\n`);
  };

  // 客户端断开（切页 / 关标签 / abort）时停止生成与推送
  const onClose = () => { closed = true; };
  req.on('close', onClose);
  if (req.socket) req.socket.on('error', onClose);

  try {
    await answerQuestionStream(q, send, () => closed, expert);
  } catch (e) {
    console.error('[chat-stream] error', e);
    send('error', { message: '回答生成失败，请稍后再试。' });
  } finally {
    req.off('close', onClose);
    if (!closed && !res.writableEnded) {
      send('done', {});
      res.end();
    }
  }
});

export default router;
