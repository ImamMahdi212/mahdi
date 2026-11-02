module.exports = {
  apps: [
    {
      name: 'mone-gardens-bot',
      script: 'app.js',
      cwd: __dirname,
      instances: 1, // whatsapp-web.js NO soporta múltiples instancias con la misma sesión
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      kill_timeout: 15000,
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Guayaquil',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
