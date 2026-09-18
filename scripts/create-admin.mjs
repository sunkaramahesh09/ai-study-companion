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
    rl._writeToOutput = (str) => {
      if (!muted) process.stdout.write(str);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const password = await readSecret(`Password for ${email} (not echoed, not stored): `);

// Supabase enforces 6; an admin account on a public deployment deserves more.
if (password.length < 12) {
  console.error('Refusing: use at least 12 characters for an account that can read every user\'s activity.');
  process.exit(1);
}

const admin = createClient(url, serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listError) throw listError;

let user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());

if (user) {
  console.log(`User already exists (${user.id}) — promoting, password left unchanged.`);
} else {
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
