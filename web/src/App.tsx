import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Article from './pages/Article';
import AgentSpace from './pages/AgentSpace';
import Login from './pages/Login';
import Register from './pages/Register';
import UserCenter from './pages/UserCenter';
import Search from './pages/Search';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/article/:id" element={<Article />} />
      <Route path="/agent/:id" element={<AgentSpace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/user/:id" element={<UserCenter />} />
      <Route path="/search" element={<Search />} />
    </Routes>
  );
}
