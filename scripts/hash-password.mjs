#!/usr/bin/env node
// Prints a password hash for ADMIN_USERS (or ADMIN_PASSWORD_HASH) and a fresh SESSION_SECRET.
// Usage: npm run hash-password            (prompts, input hidden)
//        npm run hash-password -- "pass"  (non-interactive; note the password lands in shell history)
// The format must match verifyPassword() in api/_lib/auth.ts.
import { randomBytes, scrypt } from 'node:crypto';
import { createInterface } from 'node:readline';

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.includes(question) ? s : '');
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const password = process.argv[2] ?? (await ask('Admin password: '));
if (password.length < 8) {
  console.error('Use at least 8 characters.');
  process.exit(1);
}
if (password.length < 12) {
  console.warn('Warning: passwords under 12 characters are easier to guess. Consider a longer one for the live admin.');
}
if (!process.argv[2] && (await ask('Repeat password: ')) !== password) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const [N, r, p] = [16384, 8, 1];
const salt = randomBytes(16);
const hash = await new Promise((resolve, reject) => scrypt(password, salt, 64, { N, r, p }, (e, k) => (e ? reject(e) : resolve(k))));

console.log('\nPassword hash: use it as "passwordHash" for this user in ADMIN_USERS (or as ADMIN_PASSWORD_HASH):\n');
console.log(['scrypt', N, r, p, salt.toString('hex'), hash.toString('hex')].join(':'));
console.log('\nA fresh SESSION_SECRET, if you have not set one yet (one secret is shared by all users):\n');
console.log(randomBytes(32).toString('base64url'));
