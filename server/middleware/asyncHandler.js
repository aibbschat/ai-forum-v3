// server/middleware/asyncHandler.js
// Express 4 不自动捕获 async handler 的 rejected promise；统一包装器把错误交给 next()，
// 由 error-handler 中间件处理。所有 routes 在 services 异步化后必须用它。

export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
