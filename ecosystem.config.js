module.exports = {
  apps: [
    {
      name: 'smartdeck-api',
      script: 'dist/main.js',
      cwd: '/var/www/SmartDeck',
      instances: 2,
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
    {
      name: 'smartdeck-worker',
      script: 'dist/worker.js',
      cwd: '/var/www/SmartDeck',
      instances: 3,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};