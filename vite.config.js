import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function configuredPort(value, fallback) {
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('PORT and DEV_PORT must contain digits only.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('PORT and DEV_PORT must be between 1024 and 65535.');
  }
  return port;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = configuredPort(env.PORT, 4173);
  const devPort = configuredPort(env.DEV_PORT, 5173);

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: devPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
