// Конфигурация PM2 для production-запуска.
// Использование:  pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'chef-ai',
      script: 'index.js',
      instances: 1,            // long-polling бот + in-memory rate-limit → один инстанс
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production'
      },
      time: true               // таймстемпы в логах
    }
  ]
};
