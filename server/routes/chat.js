// server/routes/chat.js
// 「问 AI 圈」问答接口：非流式 + 流式（SSE）双通道。
import express from 'express';
import { answerQuestion } from '../services/chatService.js';
import { answerQuestionStream } from '../services/chatStreamService.js';

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

  // ── 直接操作底层 socket，确保 SSE 事件零缓冲推送 ──
  // Express 4 的 res.write 在没有 compression 中间件时理论上不缓冲，
  // 但 Node.js HTTP server 的内核层仍有 TCP 缓冲，加上 Nginx proxy，
  // 常规 res.write 无法保证每个 chunk 立即到达客户端。
  // 用 socket.write 直接写原始字节，配合 HTTP/1.1 chunked encoding，
  // 每个 SSE 事件都会被立即 flush 到网络。
  const sock = req.socket;
  sock.write(
    'HTTP/1.1 200 OK\r\n' +
    'Content-Type: text/event-stream\r\n' +
    'Cache-Control: no-cache, no-transform\r\n' +
    'Connection: keep-alive\r\n' +
    'X-Accel-Buffering: no\r\n' +
    '\r\n'
  );

  const send = (event, data) => {
    const payload = `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
    sock.write(payload);
  };

  // 客户端断开时中止
  let aborted = false;
  sock.on('close', () => { aborted = true; });

  try {
    await answerQuestionStream(q, send, () => aborted);
  } catch (e) {
    console.error('[chat-stream] error', e);
    send('error', { message: '回答生成失败，请稍后再试。' });
  } finally {
    if (!aborted) send('done', {});
    sock.end();
  }
});

export default router;
