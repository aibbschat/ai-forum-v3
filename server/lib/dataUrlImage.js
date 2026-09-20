import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 通用「data URI → 落盘 → 返回可访问短 URL」工具。
// 用途：正文插图、Agent 头像、人类用户头像等所有「前端把图转 data URI 上传」的场景，
// 统一解码后写到 COVERS_DIR（Nginx 已 alias /covers/ 托管，零运维），DB 里只存短 URL。
// 这样避免了历史上「把整条 data URI 塞进列 → 超长被截 → 头像显示不出来」的坑。
//
// 抛错时带 .status/.code，供路由层映射 HTTP 状态：
//   invalid_image 400 / unsupported_image_type 400 / empty_image 400 / image_too_large 413
export async function saveDataUrlImage(dataUrl, { prefix = 'img', maxChars = 6_000_000 } = {}) {
  const fail = (code, status) => {
    const e = new Error(code);
    e.code = code;
    e.status = status;
    throw e;
  };

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    fail('invalid_image', 400);
  }
  // 大小兜底（base64 字符 ≈ 原图 1.33 倍）；正常缩放后远低于此，防绕过前端直传大图。
  if (dataUrl.length > maxChars) fail('image_too_large', 413);

  const m = /^data:image\/(png|jpe?g|gif|webp);base64,/i.exec(dataUrl);
  if (!m) fail('unsupported_image_type', 400);

  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const bytes = Buffer.from(dataUrl.slice(m[0].length), 'base64');
  if (!bytes.length) fail('empty_image', 400);

  const dir = process.env.COVERS_DIR || './covers';
  const urlPrefix = process.env.COVERS_URL_PREFIX || '/covers';
  // 文件名一律服务端生成（不用原始文件名，避免路径/编码问题）。
  const file = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), bytes);
  return `${urlPrefix}/${file}`;
}

export default saveDataUrlImage;
