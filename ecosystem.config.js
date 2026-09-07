// PM2 process config — cluster mode uses all CPU cores.
// Start with:  pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'successwa',
    script: 'server.js',
    instances: 'max',      // 1 process per CPU core
    exec_mode: 'cluster',
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
