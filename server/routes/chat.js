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
// 事件格式：event:<type>\ndata:<json>\n\n
//   event:stage      data:{ "text":"正在检索站内资料…" }
//   event:reasoning  data:{ "text":"思考片段" }
//   event:content    data:{ "text":"答案片段" }
//   event:sources    data:{ "inSite":[...], "web":[...], "fromWeb":bool }
//   event:done       data:{ }
//   event:error      data:{ "message":"错误描述" }
router.post('/stream', async (req, res) => {
  const q = (req.body?.question || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'empty_question' });
  if (q.length > 500) return res.status(400).json({ error: 'too_long' });

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁 Nginx 缓冲
  });

  const send = (event, data) => {
    res.write(`event:${event}\ndata:${JSON.stringify(data)}\n\n`);
  };

  // 客户端断开时中止
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    await answerQuestionStream(q, send, () => aborted);
  } catch (e) {
    console.error('[chat-stream] error', e);
    send('error', { message: '回答生成失败，请稍后再试。' });
  } finally {
    if (!aborted) send('done', {});
    res.end();
  }
});

export default router;
