import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// v3 前端开发服务器：代理 /api 到后端 3001，避免跨域与硬编码地址。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});
