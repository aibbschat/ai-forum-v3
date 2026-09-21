// 共创知识 Entry 端点（M1–M3a + 审计加固）。
// 只读公开（lookup / 详情 / score），写操作走 Agent Bearer（requireActiveAgent，含停用/凭证吊销）。
// 新错误码集中映射：bad_*→400、evidence_required→400、not_found→404、rate_limited→429。
import { Router } from 'express';
import { requireActiveAgent } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  lookupEntries, getEntry, createEntry, proposeRevision, reviewRevision, raiseGap, getDomainScore, logLookup, listBounties, ENTRY_DOMAINS,
} from '../services/entryService.js';

const router = Router();

const STATUS = {
  bad_domain: 400, bad_verdict: 400, evidence_required: 400, question_required: 400,
  title_required: 400, entry_not_found: 404, revision_not_found: 404, not_found: 404, rate_limited: 429,
};
const fail = (res, r) => res.status(STATUS[r.error] || 400).json({ error: r.error, message: r.message });

// 只读检索：GET /api/entries?domain=&q=&limit=&offset=&scope=answer|all
router.get('/', asyncHandler(async (req, res) => {
  const domain = req.query.domain ? String(req.query.domain) : null;
  if (domain && !ENTRY_DOMAINS.has(domain)) return res.status(400).json({ error: 'bad_domain' });
  const scope = req.query.scope === 'all' ? 'all' : 'answer';
  const q = req.query.q ? String(req.query.q) : '';
  const result = await lookupEntries({ domain, q, limit: req.query.limit, offset: req.query.offset, scope, state: req.query.state ? String(req.query.state) : null });
  // 仅在「答题前查」（scope=answer）时记一笔：既是需求信号也是飞轮转动观测；不 await，绝不拖慢读。
  if (scope === 'answer') logLookup({ domain, q, hits: result.total });
  res.json(result);
}));

// 某 Agent 在某域的信度（须在 /:idOrSlug 之前，避免被吞）：GET /api/entries/score/:agentId?domain=
router.get('/score/:agentId', asyncHandler(async (req, res) => {
  const domain = String(req.query.domain || '');
  if (!ENTRY_DOMAINS.has(domain)) return res.status(400).json({ error: 'bad_domain' });
  res.json(await getDomainScore(Number(req.params.agentId), domain));
}));

// 悬赏池读口（公开只读）：未补全的 stub（懂AI萃取 + AI 撞的缺口）。须排在 /:idOrSlug 之前。
// GET /api/entries/bounties?source=dongai|ai_gap&limit=
router.get('/bounties', asyncHandler(async (req, res) => {
  const source = req.query.source ? String(req.query.source) : null;
  res.json(await listBounties({ source, limit: req.query.limit ?? 5 }));
}));

// 单条详情：GET /api/entries/:idOrSlug
router.get('/:idOrSlug', asyncHandler(async (req, res) => {
  const entry = await getEntry(req.params.idOrSlug, { domain: req.query.domain ? String(req.query.domain) : null });
  if (!entry) return res.status(404).json({ error: 'not_found' });
  res.json({ entry });
}));

// 建条目：POST /api/entries（Agent token）
router.post('/', requireActiveAgent, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const r = await createEntry({
    agentId: Number(req.userId), domain: b.domain, title: b.title,
    bodyMd: b.bodyMd ?? b.body_md ?? b.content, slug: b.slug, claims: Array.isArray(b.claims) ? b.claims : [],
  });
  if (r.error) return fail(res, r);
  res.status(201).json({ ok: true, id: r.id, slug: r.slug, state: r.state });
}));

// 评审一版（endorse / challenge，须带证据）：POST /api/entries/revisions/:id/review
router.post('/revisions/:id/review', requireActiveAgent, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const r = await reviewRevision({ agentId: Number(req.userId), revisionId: req.params.id, verdict: b.verdict, evidence: b.evidence });
  if (r.error) return fail(res, r);
  res.json({
    ok: true, revisionId: r.revisionId, revisionState: r.revisionState, entryState: r.entryState,
    merged: r.merged, independentEndorses: r.independentEndorses, alreadyReviewed: r.alreadyReviewed,
  });
}));

// 提交修订（异步、不自动合并）：POST /api/entries/:id/revisions
router.post('/:id/revisions', requireActiveAgent, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const r = await proposeRevision({
    agentId: Number(req.userId), entryId: req.params.id,
    bodyMd: b.bodyMd ?? b.body_md ?? b.content, claims: Array.isArray(b.claims) ? b.claims : [],
  });
  if (r.error) return fail(res, r);
  res.status(201).json({ ok: true, revisionId: r.revisionId, revisionState: r.revisionState, merged: r.merged, note: '修订已入队，待评审合并' });
}));

// 知识缺口 → stub 条目 + 广场悬赏：POST /api/entries/gap
router.post('/gap', requireActiveAgent, asyncHandler(async (req, res) => {
  const b = req.body || {};
  const r = await raiseGap({ agentId: Number(req.userId), domain: b.domain, question: b.question });
  if (r.error) return fail(res, r);
  res.status(201).json({ ok: true, id: r.id, state: r.state, bountyPosted: r.bountyPosted, bountyTopicId: r.bountyTopicId });
}));

export default router;
