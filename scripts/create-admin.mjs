/**
 * Create (or promote) an admin account.
 *
 *   node --env-file=.env scripts/create-admin.mjs admin@yourdomain.com "Admin Name"
 *
 * The password is read from stdin with echo off, so it never reaches your
 * shell history, this file, the repo, or any log. Nothing here prints it.
 *
 * Why a script and not a migration: `role` lives in `public.profiles` and is
 * read from the database on every request (D-053), never from a token claim,
 * so promotion is a single UPDATE. But the auth user has to exist first, and
 * only the service role may create one — which is exactly what this does and
 * why it is not something the app itself can offer.
 *
 * Safe to re-run: an existing email is promoted rather than duplicated.
 */
import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline';

const [email, fullNameArg] = process.argv.slice(2);
const fullName = fullNameArg?.trim() || undefined;

if (!email || !email.includes('@')) {
  console.error('Usage: node --env-file=.env scripts/create-admin.mjs <email> ["Full Name"]');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRole) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. Run with --env-file=.env.');
  process.exit(1);
}

/**
 * Reads a line from stdin without echoing it back to the terminal.
 *
 * `_writeToOutput` is readline's single choke point for everything it echoes,
 * so muting it after the prompt has been written hides the typing and leaves
 * nothing to scroll back to. `terminal` follows `isTTY` so the script also
 * works with the password piped in, which is what CI would do.
 */
function readSecret(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
    let muted = false;
    let answered = false;
    rl._writeToOutput = (str) => {
      if (!muted) process.stdout.write(str);
    };
    // Without this, stdin closing before a line is sent leaves `question`'s
    // callback pending forever and the process exits on an unsettled await
    // with no explanation. Resolving empty lets the caller say what happened.
    rl.on('close', () => {
      if (!answered) resolve('');
    });
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const MIN_LENGTH = 12;

/**
 * Only called when an account has to be CREATED. Promoting an existing one
 * never asks, because it never needs to know.
 */
async function readPassword(forEmail) {
  // An explicit escape hatch for a shell that cannot give the script a
  // terminal. Not the default: an env var is visible to `ps` on some systems
  // and lands in shell history unless the line is prefixed with a space.
  const password = process.env.ADMIN_PASSWORD
    ? process.env.ADMIN_PASSWORD
    : await readSecret(`Password for ${forEmail} (not echoed, not stored): `);

  if (password.length === 0) {
    console.error(
      '\nNo password received — stdin closed without sending a line.\n' +
        'This needs a real terminal. If you ran it through a wrapper that does not\n' +
        'attach one (Claude Code\'s `!` prefix, a CI step, an editor task runner),\n' +
        'use one of these instead:\n\n' +
        '  • run it in a normal Terminal window, or\n' +
        '  • pipe the password in:\n' +
        "      printf '%s' 'your-password' | node --env-file=.env scripts/create-admin.mjs " +
        `${forEmail}\n` +
        '  • or pass it as an env var (note the LEADING SPACE, which keeps the line\n' +
        '    out of zsh/bash history when HIST_IGNORE_SPACE is on):\n' +
        `       ADMIN_PASSWORD='your-password' node --env-file=.env scripts/create-admin.mjs ${forEmail}\n`,
    );
    process.exit(1);
  }

  // Supabase enforces 6; this is our own floor, for an account that can read
  // every user's activity on a public deployment.
  if (password.length < MIN_LENGTH) {
    console.error(
      `\nReceived ${password.length} characters; this script wants at least ${MIN_LENGTH}.\n` +
        'That is our rule, not Supabase\'s — this account can read every user\'s\n' +
        'activity, and the deployment is public.\n',
    );
    process.exit(1);
  }

  return password;
}

const admin = createClient(url, serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listError) throw listError;

let user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

if (user) {
  // Promotion is a role change and nothing else. Asking for a password here —
  // which the first version did, before it had even looked the account up —
  // implied the script was about to set one, and made promoting an account
  // created in the Supabase dashboard needlessly look like a credentials
  // operation. It is not: the password is never read, sent or changed.
  console.log(`Found ${email} (${user.id}). Promoting — password untouched.`);
} else {
  console.log(`No account for ${email}; creating one.`);
  const password = await readPassword(email);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName ?? 'Admin' },
  });
  if (error) throw error;
  user = data.user;
  console.log(`Created auth user ${user.id}.`);
}

// The handle_new_user trigger writes the profile row; role is updated here.
// `full_name` is only touched when one was given, so promoting an existing
// account does not rename the person to "Admin".
const patch = fullName ? { role: 'admin', full_name: fullName } : { role: 'admin' };
const { data: profile, error: roleError } = await admin
  .from('profiles')
  .update(patch)
  .eq('id', user.id)
  .select('email, full_name, role')
  .single();
if (roleError) throw roleError;

console.log('Done:', profile);
console.log('Sign in normally — the Admin link appears in the sidebar because the');
console.log('role is read from the database, not from the token.');
