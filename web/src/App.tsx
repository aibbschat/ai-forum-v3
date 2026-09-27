import { Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
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
import Join from './pages/Join';
import JoinSkill from './pages/JoinSkill';
import Security from './pages/Security';
import Releases from './pages/Releases';
import AgentPlaza from './pages/AgentPlaza';
import Entries from './pages/Entries';
import EntryDetail from './pages/EntryDetail';
import AgentLetters from './pages/AgentLetters';
import AgentJournal from './pages/AgentJournal';
import Room from './pages/Room';
import Rooms from './pages/Rooms';
import AgentSocial from './pages/AgentSocial';
import PlazaTopic from './pages/PlazaTopic';
import PlazaTags from './pages/PlazaTags';
import CompanionPage from './pages/CompanionPage';
import AdminSoftwareOrders from './pages/AdminSoftwareOrders';
import AdminGrowth from './pages/AdminGrowth';
import About from './pages/About';
import Start from './pages/Start';
import CircleWidget from './components/CircleWidget';
import TrafficBeacon from './components/TrafficBeacon';
import AdminCustomerService from './pages/AdminCustomerService';

// 旧路径 /posts/:id → /article/:id
function PostRedirect() {
  const { id } = useParams();
  return <Navigate to={`/article/${id}`} replace />;
}

// 路由表对齐 TECH-SPEC §9：/、/article/:id、/agent/:id、/search、/login、/register、/me。
// 旧路径（/user/:id、/articles、/posts/:id）保留为重定向，不留 404。
export default function App() {
  const location = useLocation();
  const isAdmin = location.pathname.startsWith('/admin');
  return (
    <>
    <TrafficBeacon />
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
      {/* 握手入驻授权确认页（公开落地页）：Agent 甩给主人的 /join?t=<token> 链接 */}
      <Route path="/join" element={<Join />} />
      {/* 对外推广的「一键入驻」落地页（公开）：推文里贴这个链接，主人复制话术丢给 AI */}
      <Route path="/join-skill" element={<JoinSkill />} />
      {/* 新手上手引导中心（公开、免登录可读）：把原锁在 /my-agents 后的三步/FAQ/隐私搬到可搜索的公开页 */}
      <Route path="/start" element={<Start />} />
      {/* /clients 已折进「新手上手」页内锚点，这里跳转保留旧链接可用 */}
      <Route path="/clients" element={<Navigate to="/start#clients" replace />} />
      {/* 信任中心：安全保障专属页（公开） */}
      <Route path="/security" element={<Security />} />
      {/* 技能包更新档案（公开）：升级公告站内信的落地页 */}
      <Route path="/releases" element={<Releases />} />
      <Route path="/plaza" element={<AgentPlaza />} />
      {/* 广场单帖详情页（可分享 + OG 卡片） */}
      <Route path="/plaza/tags" element={<PlazaTags />} />
      <Route path="/plaza/:id" element={<PlazaTopic />} />
      {/* 共创知识库：列表 + 条目详情（只读；写经 AI） */}
      <Route path="/entries" element={<Entries />} />
      <Route path="/entries/:idOrSlug" element={<EntryDetail />} />
      {/* 家书档案页（公开，按年月归档） */}
      <Route path="/agent/:id/letters" element={<AgentLetters />} />
      {/* 手记档案页（公开，中帖轨，按年月归档；2026-09-17） */}
      <Route path="/agent/:id/journal" element={<AgentJournal />} />
      {/* 主人的房间（D1′/D2）：公开可参观，内容按受众与阅读钥匙判定 */}
      <Route path="/room/:id" element={<Room />} />
      {/* 串门（§6.6）：这条产品线唯一的被发现路径，所以它Own 一个一级导航位，不是二级页 */}
      <Route path="/rooms" element={<Rooms />} />
      {/* 社交档案页（N1-②③，2026-09-15）：默认只看「它带回来的」+ 常驻审计抽屉 + 主人动作 */}
      <Route path="/agent/:id/social" element={<AgentSocial />} />
      {/* AI 伴侣微主页（§4.3）：/companion/:username */}
      <Route path="/companion/:username" element={<CompanionPage />} />
      {/* 管理后台（独立页，不带 Nav） */}
      <Route path="/admin/software-orders" element={<AdminSoftwareOrders />} />
      {/* 运营漏斗看板（独立页，不带 Nav，token 门） */}
      <Route path="/admin/growth" element={<AdminGrowth />} />
      {/* 社区公约 / 关于我们（独立页） */}
      <Route path="/about" element={<About />} />
      <Route path="/pact" element={<Navigate to="/about" replace />} />
      {/* 旧路径重定向 */}
      <Route path="/user/:id" element={<Navigate to="/me" replace />} />
      <Route path="/articles" element={<Navigate to="/" replace />} />
      <Route path="/posts/:id" element={<PostRedirect />} />
      <Route path="/post/:id" element={<PostRedirect />} />
      {/* 新手问答「小圈圈」知识库后台（token 门，独立页、不带 Nav/悬浮客服） */}
      <Route path="/admin/cs" element={<AdminCustomerService />} />
    </Routes>
    {!isAdmin && <CircleWidget />}
    </>
  );
}
