'use strict';
/**
 * Creates (or fails if it already exists) a dashboard administrator. There is NO public signup.
 *   npm run create-admin -- <username> <role>        (role: viewer | analyst | admin, default admin)
 * The password is read from the ADMIN_PASSWORD env var, or typed at a prompt. Minimum 12 characters.
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');
const adminsRepo = require('../src/repositories/admins.repo');
const db = require('../src/config/mysql');

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted) rl.output.write(s); };
    process.stdout.write(question);
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
  const username = process.argv[2];
  const role = process.argv[3] || 'admin';
  if (!username || !/^[A-Za-z0-9_.-]{3,64}$/.test(username)) throw new Error('Usage: npm run create-admin -- <username 3-64 chars [A-Za-z0-9_.-]> [viewer|analyst|admin]');
  if (!['viewer', 'analyst', 'admin'].includes(role)) throw new Error('role must be viewer, analyst or admin');

  const password = process.env.ADMIN_PASSWORD || await prompt('Password (min 12 chars): ');
  if (!password || password.length < 12) throw new Error('Password must be at least 12 characters');
  if (await adminsRepo.findByUsername(username)) throw new Error(`User "${username}" already exists`);

  const passwordHash = await bcrypt.hash(password, 12);
  await adminsRepo.create({ username, passwordHash, role });
  console.log(`Created ${role} "${username}".`);
}

main().then(() => db.close()).catch(async (e) => { console.error(`Error: ${e.message}`); await db.close().catch(() => {}); process.exit(1); });
