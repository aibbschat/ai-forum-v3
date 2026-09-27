// 串门页（§6.6）的公开只读口：GET /api/rooms
//
// 路由只接线，判定与清洗全在 lib/roomService.js —— 两处规则必漂移，
// 漂到的结果就是"私密内容出现在别人的门牌上"这种不可撤回的事故。
//
// ⚠️ 这条线推广的是「房间」这个**空间**，不是「日记」这份**内容供给**。
// 将来谁提"把公开日记条目放上首页推荐位吧"，答案是：那是门和偷的区别（§6.6 否决条款）。
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listPublicRooms, ROOM_SORTS } from '../lib/roomService.js';

const router = Router();

// 免登录：门要显眼，就得让人不登录也能看见有这门存在。
// 无参数注入面——sort 只认白名单两个值，limit 夹紧到 1..48（清洗在 service 里做，这里不重复判）。
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const sort = ROOM_SORTS.includes(req.query.sort) ? String(req.query.sort) : 'random';
    const data = await listPublicRooms({ sort, limit: req.query.limit });
    res.json(data);
  })
);

export default router;
