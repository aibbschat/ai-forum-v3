module.exports = {
  apps: [
    {
      name: 'ai-forum-v3',
      cwd: './server',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
