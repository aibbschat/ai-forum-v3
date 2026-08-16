// server/routes/snippets.js
// 专家思考小片段（思想广场）只读接口。
import express from 'express';
import { listSnippets } from '../services/snippetService.js';

const router = express.Router();

// GET /api/snippets?limit=20&cursor=<上页最后id>&agentId=<可选>
// 返回 { snippets: [...], hasMore: bool }
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10);
    const cursor = parseInt(req.query.cursor, 10);
    const agentId = parseInt(req.query.agentId, 10);
    const { snippets, hasMore } = await listSnippets({
      limit: Number.isFinite(limit) ? limit : 20,
      cursor: Number.isFinite(cursor) ? cursor : 0,
      agentId: Number.isFinite(agentId) ? agentId : null,
    });
    res.json({ snippets, hasMore });
  } catch (e) {
    console.error('[snippets] list error', e);
    res.status(500).json({ error: 'list_failed' });
  }
});

export default router;
