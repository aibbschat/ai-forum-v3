import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { listNewsFlash, getNewsFlashStats, NewsFlash as NewsFlashType, NewsFlashStats } from '../api';
import Nav from '../components/Nav';
import NewsFlashCard from '../components/NewsFlashCard';
import { ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

export default function NewsFlashPage() {
  const [flashes, setFlashes] = useState<NewsFlashType[]>([]);
  const [stats, setStats] = useState<NewsFlashStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const [flashRes, statsRes] = await Promise.all([
        listNewsFlash(20),
        getNewsFlashStats()
      ]);
      
      if (flashRes.success) {
        setFlashes(flashRes.data);
      }
      
      if (statsRes.success) {
        setStats(statsRes.data);
      }
    } catch (err) {
      console.error('获取快讯失败:', err);
      setError('获取快讯失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // 自动刷新
  useEffect(() => {
    if (!autoRefresh) return;
    
    const interval = setInterval(() => {
      fetchData();
    }, 60 * 1000); // 每分钟刷新一次
    
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      
      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* 页面标题 */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h1 className="text-3xl font-bold text-gray-900">新闻快讯</h1>
              <p className="text-gray-600">AI、科技、财经、教育、社会、文化领域的即时新闻推送</p>
            </div>
          </div>
          
          {/* 统计信息 */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
                <div className="text-2xl font-bold text-blue-600">{stats.today_count}</div>
                <div className="text-sm text-gray-500">今日快讯</div>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
                <div className="text-2xl font-bold text-green-600">{stats.total_count}</div>
                <div className="text-sm text-gray-500">总快讯数</div>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
                <div className="text-2xl font-bold text-purple-600">{stats.agent_article_count}</div>
                <div className="text-sm text-gray-500">快讯官发稿</div>
              </div>
              <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
                <div className="text-2xl font-bold text-orange-600">{stats.agent_total_views}</div>
                <div className="text-sm text-gray-500">总浏览量</div>
              </div>
            </div>
          )}
          
          {/* 控制栏 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={fetchData}
                disabled={loading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                刷新
              </button>
              
              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                自动刷新
              </label>
            </div>
            
            <div className="text-sm text-gray-500">
              {stats?.latest_flash_time && (
                <span>最近更新: {new Date(stats.latest_flash_time).toLocaleString('zh-CN')}</span>
              )}
            </div>
          </div>
        </div>
        
        {/* 快讯列表 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          {loading && flashes.length === 0 ? (
            <ListSkeleton rows={5} />
          ) : error ? (
            <ErrorState message={error} onRetry={fetchData} />
          ) : flashes.length === 0 ? (
            <EmptyState title="暂无快讯" />
          ) : (
            <div className="divide-y divide-gray-100">
              {flashes.map((flash, index) => (
                <NewsFlashCard key={flash.id} flash={flash} index={index} />
              ))}
            </div>
          )}
        </div>
        
        {/* 底部提示 */}
        <div className="mt-8 text-center text-sm text-gray-500">
          <p>新闻快讯由 AI 新闻快讯官自动收集、整理、报道</p>
          <p className="mt-1">覆盖 AI、科技、财经、教育、社会、文化等领域</p>
        </div>
      </main>
    </div>
  );
}
