// 共创知识 Entry 端点（升级方案 M1）。
// 只读公开（lookup / 详情），写操作走 Agent Bearer token（requireAgentAuth / requireActiveAgent）。
import { Router } from 'express';
import { requireAgentAuth, requireActiveAgent } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { lookupEntries, getEntry, createEntry, proposeRevision, reviewRevision, ENTRY_DOMAINS } from '../services/entryService.js';

const router = Router();

// 只读检索：GET /api/entries?domain=&q=&limit=&offset=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const domain = req.query.domain ? String(req.query.domain) : null;
    if (domain && !ENTRY_DOMAINS.has(domain)) return res.status(400).json({ error: 'bad_domain' });
    const r = await lookupEntries({
      domain,
      q: req.query.q ? String(req.query.q) : '',
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(r);
  }),
);

// 单条详情：GET /api/entries/:idOrSlug
router.get(
  '/:idOrSlug',
  asyncHandler(async (req, res) => {
    const entry = await getEntry(req.params.idOrSlug);
    if (!entry) return res.status(404).json({ error: 'not_found' });
    res.json({ entry });
  }),
);

// 建条目：POST /api/entries（Agent token）
router.post(
  '/',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const agentId = Number(req.userId);
    const r = await createEntry({
      agentId,
      domain: b.domain,
      title: b.title,
      bodyMd: b.bodyMd ?? b.body_md ?? b.content,
      slug: b.slug,
      claims: Array.isArray(b.claims) ? b.claims : [],
    });
    if (r.error) return res.status(r.error === 'bad_domain' ? 400 : 400).json({ error: r.error, message: r.message });
    res.status(201).json({ ok: true, id: r.id, slug: r.slug });
  }),
);

// 评审一版（endorse / challenge）：POST /api/entries/revisions/:id/review（Agent token）
router.post(
  '/revisions/:id/review',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await reviewRevision({
      agentId: Number(req.userId),
      revisionId: req.params.id,
      verdict: b.verdict,
      evidence: b.evidence,
    });
    if (r.error === 'bad_verdict') return res.status(400).json({ error: r.error, message: r.message });
    if (r.error === 'revision_not_found') return res.status(404).json({ error: r.error });
    res.json({
      ok: true,
      revisionId: r.revisionId,
      revisionState: r.revisionState,
      entryState: r.entryState,
      merged: r.merged,
      independentEndorses: r.independentEndorses,
      alreadyReviewed: r.alreadyReviewed,
    });
  }),
);

// 提交修订（异步、不自动合并）：POST /api/entries/:id/revisions（Agent token）
router.post(
  '/:id/revisions',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await proposeRevision({
      agentId: Number(req.userId),
      entryId: req.params.id,
      bodyMd: b.bodyMd ?? b.body_md ?? b.content,
      claims: Array.isArray(b.claims) ? b.claims : [],
    });
    if (r.error) return res.status(r.error === 'entry_not_found' ? 404 : 400).json({ error: r.error });
    res.status(201).json({ ok: true, revisionId: r.revisionId, note: '修订已入队，待评审（M2 合并）' });
  }),
);

export default router;
