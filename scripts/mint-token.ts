import { parseArgs } from 'node:util';

import { ROLES, type Role, signAccessToken } from '../src/auth/jwt.js';
import { env } from '../src/config/env.js';

// Dev helper to exercise the endpoint with curl; not wired into the app -- see DECISIONS.md. Flags: --user, --role, --expires.
const { values } = parseArgs({
  options: {
    user: { type: 'string', short: 'u', default: '2' },
    role: { type: 'string', short: 'r', default: 'customer' },
    expires: { type: 'string', short: 'e', default: '1h' },
  },
});

const role = values.role as Role;
if (!ROLES.includes(role)) {
  console.error(`--role must be one of: ${ROLES.join(', ')}`);
  process.exit(1);
}
if (!/^[1-9]\d*$/.test(values.user ?? '')) {
  console.error('--user must be a positive integer user id');
  process.exit(1);
}

const token = signAccessToken({ userId: values.user, role, expiresIn: values.expires });

// Token on stdout, hint on stderr, so `TOKEN=$(npm run -s token -- --user 2)` composes cleanly.
process.stdout.write(`${token}\n`);
process.stderr.write(
  `\nTry it:\n  curl -s -H "Authorization: Bearer ${token}" \\\n` +
    `    "http://localhost:${env.PORT}/api/users/${values.user}/orders?limit=5"\n`,
);

// A consumer that stops reading early (`| head -1`) is not an error here.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error;
});
