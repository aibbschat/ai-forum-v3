// 二维码工具：封装 qrcode 库，返回 dataURL。组件不直接 import qrcode，便于以后换实现。
import QRCode from 'qrcode';

export async function qrDataUrl(text: string, size = 200): Promise<string> {
  return QRCode.toDataURL(text, {
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
}
