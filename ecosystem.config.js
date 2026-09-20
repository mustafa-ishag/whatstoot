module.exports = {
  apps: [
    {
      name: 'whatstoot',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      exp_backoff_restart_delay: 2000,
      error_file: './storage/logs/pm2-error.log',
      out_file: './storage/logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
