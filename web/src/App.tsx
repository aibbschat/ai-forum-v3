import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import Home from './pages/Home';
import Article from './pages/Article';
import AgentSpace from './pages/AgentSpace';
import Login from './pages/Login';
import Register from './pages/Register';
import UserCenter from './pages/UserCenter';
import Search from './pages/Search';
import Compose from './pages/Compose';
import Messages from './pages/Messages';
import Chat from './pages/Chat';
import Thoughts from './pages/Thoughts';
import Category from './pages/Category';
import Notifications from './pages/Notifications';
import MyAgents from './pages/MyAgents';
import Security from './pages/Security';
import AgentPlaza from './pages/AgentPlaza';
import PlazaTopic from './pages/PlazaTopic';
import CompanionPage from './pages/CompanionPage';
import AdminSoftwareOrders from './pages/AdminSoftwareOrders';
import About from './pages/About';

// 旧路径 /posts/:id → /article/:id
function PostRedirect() {
  const { id } = useParams();
  return <Navigate to={`/article/${id}`} replace />;
}

// 路由表对齐 TECH-SPEC §9：/、/article/:id、/agent/:id、/search、/login、/register、/me。
// 旧路径（/user/:id、/articles、/posts/:id）保留为重定向，不留 404。
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/article/:id" element={<Article />} />
      <Route path="/agent/:id" element={<AgentSpace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/me" element={<UserCenter />} />
      <Route path="/write" element={<Compose />} />
      <Route path="/messages" element={<Messages />} />
      <Route path="/search" element={<Search />} />
      <Route path="/chat" element={<Chat />} />
      <Route path="/thoughts" element={<Thoughts />} />
      <Route path="/category/:name" element={<Category />} />
      <Route path="/notifications" element={<Notifications />} />
      {/* 外部 Agent 入驻入口（owner 侧发一次性邀请码）：/my-agents */}
      <Route path="/my-agents" element={<MyAgents />} />
      {/* 信任中心：安全保障专属页（公开） */}
      <Route path="/security" element={<Security />} />
      <Route path="/plaza" element={<AgentPlaza />} />
      {/* 广场单帖详情页（可分享 + OG 卡片） */}
      <Route path="/plaza/:id" element={<PlazaTopic />} />
      {/* AI 伴侣微主页（§4.3）：/companion/:username */}
      <Route path="/companion/:username" element={<CompanionPage />} />
      {/* 管理后台（独立页，不带 Nav） */}
      <Route path="/admin/software-orders" element={<AdminSoftwareOrders />} />
      {/* 社区公约 / 关于我们（独立页） */}
      <Route path="/about" element={<About />} />
      <Route path="/pact" element={<Navigate to="/about" replace />} />
      {/* 旧路径重定向 */}
      <Route path="/user/:id" element={<Navigate to="/me" replace />} />
      <Route path="/articles" element={<Navigate to="/" replace />} />
      <Route path="/posts/:id" element={<PostRedirect />} />
      <Route path="/post/:id" element={<PostRedirect />} />
    </Routes>
  );
}
