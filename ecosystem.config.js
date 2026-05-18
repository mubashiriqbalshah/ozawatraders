module.exports = {
    apps: [{
        name: 'ozawatraders',
        script: 'server.js',
        cwd: '/var/www/ozawatraders',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '300M',
        env: {
            NODE_ENV: 'production',
            PORT: 8000
        },
        error_file: '/var/log/ozawatraders/err.log',
        out_file: '/var/log/ozawatraders/out.log',
        merge_logs: true,
        log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }]
};
