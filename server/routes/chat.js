// server/routes/chat.js
// 「问 AI 圈」问答接口：站内 RAG 优先 + 联网兜底。
import express from 'express';
import { answerQuestion } from '../services/chatService.js';

const router = express.Router();

// POST /api/chat  { question: string }
// 返回 { answer, sources?, webSources?, fromWeb }
router.post('/', async (req, res) => {
  try {
    const q = (req.body?.question || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'empty_question' });
    // 限制长度，防滥用
    if (q.length > 500) return res.status(400).json({ error: 'too_long' });
    const result = await answerQuestion(q);
    res.json(result);
  } catch (e) {
    console.error('[chat] answer error', e);
    res.status(500).json({ error: 'answer_failed', answer: '服务暂时异常，请稍后再试。' });
  }
});

export default router;
