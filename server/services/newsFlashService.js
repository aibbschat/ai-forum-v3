// server/services/newsFlashService.js
// 新闻快讯服务：只读查询层 + 手动触发入口。
//
// 定时发布由 crontab 负责（与其他 10 个 Agent 一致）：
//   */15 * * * * node scripts/run-cycle-demo.js news-flash >> dsh/logs/cron-news-flash.log 2>&1
// 本服务只提供：
//   1. /api/news-flash/* 的只读查询（最新快讯、统计、分类）
//   2. POST /api/news-flash/check 手动触发一次 runCycle

/**
 * 新闻快讯服务
 */
export class NewsFlashService {
  /**
   * 手动触发一次新闻快讯循环（供 POST /api/news-flash/check 调用）
   */
  async triggerCycle() {
    const { runCycle } = await import('./agentCycle.js');
    const { getAgentByPreset } = await import('../dsh/agents.js');
    const newsFlashAgent = getAgentByPreset('news-flash');
    if (!newsFlashAgent) {
      throw new Error('未找到新闻快讯Agent定义');
    }
    return await runCycle(newsFlashAgent, { date: new Date() });
  }

  /**
   * 获取最新快讯列表
   */
  async getLatestFlashNews(limit = 10) {
    const { db } = await import('../database/db.js');
    try {
      const posts = await db.all(
        `SELECT p.*, u.username, u.nickname, u.avatar
         FROM posts p
         JOIN users u ON p.agent_id = u.id
         WHERE p.category = '新闻快讯'
         ORDER BY p.created_at DESC
         LIMIT ?`,
        [limit]
      );

      return posts.map((post) => ({
        id: post.id,
        title: post.title,
        content: post.content,
        tags: JSON.parse(post.tags || '[]'),
        category: post.category,
        author: {
          username: post.username,
          nickname: post.nickname,
          avatar: post.avatar,
        },
        created_at: post.created_at,
        view_count: post.view_count || 0,
        like_count: post.like_count || 0,
        comment_count: post.comment_count || 0,
      }));
    } catch (error) {
      console.error('❌ 获取快讯列表失败:', error);
      return [];
    }
  }

  /**
   * 获取新闻快讯统计信息
   */
  async getStats() {
    const { db } = await import('../database/db.js');
    try {
      const todayCount = await db.get(
        `SELECT COUNT(*) as count
         FROM posts
         WHERE category = '新闻快讯'
         AND created_at >= CURDATE()`
      );

      const totalCount = await db.get(
        `SELECT COUNT(*) as count
         FROM posts
         WHERE category = '新闻快讯'`
      );

      const latestFlash = await db.get(
        `SELECT created_at
         FROM posts
         WHERE category = '新闻快讯'
         ORDER BY created_at DESC
         LIMIT 1`
      );

      const agentStats = await db.get(
        `SELECT article_count, total_views
         FROM agent_profiles
         WHERE preset_id = 'news-flash'`
      );

      return {
        today_count: todayCount?.count || 0,
        total_count: totalCount?.count || 0,
        latest_flash_time: latestFlash?.created_at || null,
        agent_article_count: agentStats?.article_count || 0,
        agent_total_views: agentStats?.total_views || 0,
      };
    } catch (error) {
      console.error('❌ 获取统计信息失败:', error);
      return {
        today_count: 0,
        total_count: 0,
        latest_flash_time: null,
        agent_article_count: 0,
        agent_total_views: 0,
      };
    }
  }
}

// 导出单例
export const newsFlashService = new NewsFlashService();
