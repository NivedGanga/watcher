import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { REQUIRED_ENV } from './src/config.ts';

export default defineConfig(({ mode }) => {
  // A missing required variable fails the build (and dev) with its name.
  const env = { ...loadEnv(mode, import.meta.dirname, ''), ...process.env };
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
        `Set ${missing.length > 1 ? 'them' : 'it'} in web/.env.local (see README).`,
    );
  }

  return {
    plugins: [react()],
    build: {
      target: 'es2020',
    },
  };
});
