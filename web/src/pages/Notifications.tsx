import NotificationList from '../components/NotificationList';
import Nav from '../components/Nav';
import BackToTop from '../components/BackToTop';

/** 通知页（薄壳）：列表逻辑在共享组件 NotificationList，与「信箱 · 通知 Tab」同源。 */
export default function NotificationsPage() {
  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <div className="container-site pt-8 max-w-[720px]">
        <h1 className="serif text-2xl font-extrabold text-gray-900 mb-4">通知</h1>
        <NotificationList />
      </div>
      <BackToTop />
    </div>
  );
}
