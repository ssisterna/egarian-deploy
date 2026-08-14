/**
 * PM2 — topología COMPLETA del VPS de producción (fuente de verdad única).
 *
 * Vive VERSIONADO acá (repo deploy) y se copia al servidor a su ubicación de
 * siempre, la raíz donde viven los repos:
 *   /usr/local/etc/ecosystem.config.js
 *
 * Solo se usa para instalar o CAMBIAR la topología (pm2 start / pm2 save);
 * los deploys diarios reinician por nombre de proceso vía deploy.sh.
 *
 * ── egarian-api: multi-instancia ─────────────────────────────────────────────
 * - egarian-api (cluster ×2, :4000): instancias HTTP detrás de Apache (ERP,
 *   store, POS, portales). Rol "web": no corren migraciones, crons ni colas;
 *   en el boot esperan a que el scheduler deje el esquema al día.
 * - egarian-api-scheduler (fork ×1, :4001): único dueño de migraciones, crons
 *   (ProcessTask), cola de canales del asistente y polling de Telegram. Su
 *   HTTP NO va al balanceador (Apache solo proxya a :4000).
 *
 * El estado compartido vive en Mongo/Redis (sesiones, cache, locks), así que
 * las instancias web son intercambiables.
 *
 * PM2 inyecta este `env` ANTES de que corra dotenv, y dotenv NO pisa variables
 * ya presentes: lo declarado acá le gana al .env.production de cada app.
 *
 * SEGURIDAD: ni :4000 ni :4001 pueden estar abiertos en el firewall. Apache
 * publica 80/443 y proxya SOLO a :4000. El :4001 del scheduler sirve la API
 * COMPLETA (no un endpoint de salud): es exclusivamente para ops locales.
 *
 * Deploy del api: SIEMPRE el scheduler PRIMERO y las web después (lo hace
 * deploy.sh solo):
 *   pm2 restart egarian-api-scheduler    # aplica las migraciones nuevas
 *   pm2 reload egarian-api               # rolling, sin downtime; espera esquema al día
 * Al revés se traba: las web nuevas esperan migraciones que el scheduler viejo
 * no conoce, agotan el timeout (10 min) y ciclan hasta que el scheduler migre.
 * Disciplina de migraciones: compatibles con el código viejo (expand/contract),
 * porque durante el reload las web viejas siguen sirviendo sobre el esquema nuevo.
 *
 * Instalación inicial de la topología (una vez, con corte breve):
 *   pm2 delete egarian-api               # baja el proceso único actual
 *   pm2 start /usr/local/etc/ecosystem.config.js
 *   pm2 save                             # persistir para reboot
 */
module.exports = {
    apps: [
        // ── egarian-api ──────────────────────────────────────────────────────
        {
            name: 'egarian-api',
            cwd: '/usr/local/etc/egarian-api',
            script: 'dist/index.js',
            exec_mode: 'cluster',
            instances: 2,
            wait_ready: true,
            // En un deploy con migración larga el 'ready' se demora: la instancia
            // web espera a que el scheduler termine de migrar antes de escuchar.
            listen_timeout: 600000,
            kill_timeout: 15000,

            // Logs (con merge_logs:false y cluster, PM2 sufija el nº de instancia)
            out_file:   '/usr/local/etc/pm2_logs/egarian-api-out.log',
            error_file: '/usr/local/etc/pm2_logs/egarian-api-err.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: false,

            // Reinicio automático
            watch: false,
            autorestart: true,
            max_restarts: 10,
            min_uptime: '5s',
            restart_delay: 2000,
            env: {
                NODE_ENV: 'production',
                SERVER_ROLE: 'web',
                SERVER_PORT: '4000',
                // env.ts le suma el número de instancia (w0, w1): un log por proceso.
                LOG_PREFIX: 'w',
                // Sin worker threads: solo los usa el cron updateIndicators (scheduler).
                // Ahorra ~150 MB/thread y conexiones Mongo por instancia web.
                WORKER_THREADS: '0',
                // Pool Mongo del hilo principal: DB_POOL_SIZE si hiciera falta afinar
                // (default: max(5, cpus×3) por instancia).
            },
        },
        {
            name: 'egarian-api-scheduler',
            cwd: '/usr/local/etc/egarian-api',
            script: 'dist/index.js',
            exec_mode: 'fork',
            instances: 1,
            wait_ready: true,
            listen_timeout: 1800000, // las migraciones corren acá
            kill_timeout: 30000,     // margen para que un proceso en curso termine

            // Logs
            out_file:   '/usr/local/etc/pm2_logs/egarian-api-scheduler-out.log',
            error_file: '/usr/local/etc/pm2_logs/egarian-api-scheduler-err.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: false,

            // Reinicio automático
            watch: false,
            autorestart: true,
            max_restarts: 10,
            min_uptime: '5s',
            restart_delay: 2000,
            env: {
                NODE_ENV: 'production',
                SERVER_ROLE: 'scheduler',
                SERVER_PORT: '4001',
                LOG_PREFIX: 's',
            },
        },

        // ── egarian-erp ──────────────────────────────────────────────────────
       {
		  name: "egarian-erp",
		  script: "dist/index.js",
		  cwd: "/usr/local/etc/egarian-erp",
		  instances: 1,
		  exec_mode: "fork",
		  node_args: "--max-old-space-size=256",

		  // Logs
		  out_file:   "/usr/local/etc/pm2_logs/egarian-erp-out.log",
		  error_file: "/usr/local/etc/pm2_logs/egarian-erp-err.log",
		  log_date_format: "YYYY-MM-DD HH:mm:ss",
		  merge_logs: false,

		  // Reinicio automático
		  watch: false,
		  autorestart: true,
		  max_restarts: 10,
		  min_uptime: "5s",
		  restart_delay: 2000,

		  env: {
			NODE_ENV: "production",
		  },
		},


        // ── egarian-store ────────────────────────────────────────────────────
        {
		  name: "egarian-store",
		  script: "dist/index.js",
		  cwd: "/usr/local/etc/egarian-store",
		  instances: 1,
		  exec_mode: "fork",
		  node_args: "--max-old-space-size=256",

		  // Logs
		  out_file:   "/usr/local/etc/pm2_logs/egarian-store-out.log",
		  error_file: "/usr/local/etc/pm2_logs/egarian-store-err.log",
		  log_date_format: "YYYY-MM-DD HH:mm:ss",
		  merge_logs: false,

		  // Reinicio automático
		  watch: false,
		  autorestart: true,
		  max_restarts: 10,
		  min_uptime: "5s",
		  restart_delay: 2000,

		  env: {
			NODE_ENV: "production",
		  },
		},

    ],
};
