import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (!existsSync('.env.local')) {
  writeFileSync('.env.local', 'GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\nOPENAI_API_KEY=\nALIEXPRESS_APP_KEY=\nALIEXPRESS_APP_SECRET=\n', { flag: 'wx' });
}
if (!existsSync('.env.docker.local')) {
  writeFileSync('.env.docker.local', 'POSTGRES_PASSWORD=' + randomBytes(32).toString('hex') +
    '\nSESSION_SECRET=' + randomBytes(32).toString('hex') + '\nAPP_BASE_URL=http://localhost:3000\n', { flag: 'wx' });
}
console.log('Local configuration is ready. Existing credentials were preserved.');
