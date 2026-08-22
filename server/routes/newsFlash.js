// server/routes/newsFlash.js
// 新闻快讯路由

import { Router } from 'express';
import { newsFlashService } from '../services/newsFlashService.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/news-flash/latest
 * 获取最新新闻快讯
 */
router.get('/latest', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const flashNews = await newsFlashService.getLatestFlashNews(limit);
    
    res.json({
      success: true,
      data: flashNews,
      count: flashNews.length
    });
    
  } catch (error) {
    console.error('❌ 获取快讯失败:', error);
    res.status(500).json({
      success: false,
      error: '获取快讯失败'
    });
  }
});

/**
 * POST /api/news-flash/check
 * 手动触发新闻检查（管理员权限）
 */
router.post('/check', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限（这里简化处理，实际应该检查用户角色）
    // 暂时允许所有登录用户触发检查
    
    // 异步执行一次标准 runCycle（DSH 大脑出稿 + 统一发布）
    newsFlashService.triggerCycle().then((result) => {
      console.log('📰 手动触发新闻快讯循环完成:', result?.published ? '已发布' : '本轮未发布');
    }).catch(error => {
      console.error('❌ 手动新闻检查失败:', error);
    });

    res.json({
      success: true,
      message: '新闻快讯循环已触发'
    });
    
  } catch (error) {
    console.error('❌ 手动新闻检查失败:', error);
    res.status(500).json({
      success: false,
      error: '新闻检查失败'
    });
  }
});

/**
 * GET /api/news-flash/stats
 * 获取新闻快讯统计信息
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await newsFlashService.getStats();
    
    res.json({
      success: true,
      data: stats
    });
    
  } catch (error) {
    console.error('❌ 获取统计信息失败:', error);
    res.status(500).json({
      success: false,
      error: '获取统计信息失败'
    });
  }
});

/**
 * GET /api/news-flash/categories
 * 获取新闻分类列表
 */
router.get('/categories', async (req, res) => {
  try {
    const categories = [
      { id: 'ai', name: 'AI/科技', description: '人工智能、大模型、科技产品' },
      { id: 'finance', name: '财经', description: '股市、企业、投资、经济' },
      { id: 'education', name: '教育', description: '教育政策、高校、学习' },
      { id: 'society', name: '社会', description: '民生、政策、突发事件' },
      { id: 'culture', name: '文化', description: '影视、艺术、文学、娱乐' }
    ];
    
    res.json({
      success: true,
      data: categories
    });
    
  } catch (error) {
    console.error('❌ 获取分类列表失败:', error);
    res.status(500).json({
      success: false,
      error: '获取分类列表失败'
    });
  }
});

export default router;
