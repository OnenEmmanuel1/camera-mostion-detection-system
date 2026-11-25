'use strict';

const readline = require('readline');
const bcrypt = require('bcrypt');
const { getDb } = require('../src/db/database');
const { runMigrations } = require('../src/db/migrate');
const AuditService = require('../src/services/audit');

function prompt(query, isPassword = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    if (!isPassword) {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    } else {
      process.stdout.write(query);
      let input = '';
      
      const onData = (char) => {
        char = char.toString();
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004':
            process.stdin.pause();
            break;
          case '\u0003': // Ctrl+C
            process.exit();
            break;
          case '\u0008': // Backspace
          case '\x7f':
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write('\b \b');
            }
            break;
          default:
            input += char;
            process.stdout.write('*');
            break;
        }
      };

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', onData);
        rl.question('', () => {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          rl.close();
          console.log('');
          resolve(input.trim());
        });
      } else {
        // Fallback for non-interactive tty
        rl.question('', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      }
    }
  });
}

async function createAdmin() {
  console.log('===============================================================');

  if (process.env.APP_ENV !== 'production') {
    console.error('❌ Administrator provisioning requires APP_ENV=production.');
    process.exit(1);
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('❌ Interactive TTY required so the password can be entered without echo.');
    process.exit(1);
  }
  console.log(' ISSS PRODUCTION ADMINISTRATOR PROVISIONING');
  console.log('===============================================================');

  runMigrations();
  const db = getDb();
  const audit = new AuditService(db);

  const username = await prompt('Enter Administrator username (3-30 chars): ');
  if (!/^[a-zA-Z0-9_\-]{3,30}$/.test(username)) {
    console.error('❌ Error: Username must be 3-30 alphanumeric characters.');
    process.exit(1);
  }

  const existing = db.prepare('SELECT user_id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.error(`❌ Error: Username "${username}" already exists.`);
    process.exit(1);
  }

  const password = await prompt('Enter Administrator password (min 8 chars): ', true);
  if (!password || password.length < 8) {
    console.error('❌ Error: Password must be at least 8 characters long.');
    process.exit(1);
  }

  const confirmPassword = await prompt('Confirm password: ', true);
  if (password !== confirmPassword) {
    console.error('❌ Error: Passwords do not match.');
    process.exit(1);
  }

  console.log('[Security] Hashing password with bcrypt (cost factor 12)...');
  const saltRounds = 12;
  const hash = await bcrypt.hash(password, saltRounds);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (username, password_hash, role, active, created_at)
    VALUES (?, ?, 'Administrator', 1, ?)
  `).run(username, hash, now);

  audit.log({
    userId: null,
    action: 'ProductionAdminCreated',
    outcome: 'Success',
    details: { username }
  });

  console.log(`✅ Administrator account "${username}" created successfully.`);
  console.log('Credentials have been committed securely to persistent storage.');
  process.exit(0);
}

if (require.main === module) {
  createAdmin().catch((err) => {
    console.error('[CreateAdmin Error]:', err);
    process.exit(1);
  });
}

module.exports = { createAdmin };
