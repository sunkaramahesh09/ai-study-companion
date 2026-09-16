import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Project-level data isolation — PRD §15, "a core requirement".
 *
 * These tests run against the real database with real user JWTs, deliberately.
 * Isolation that is only verified by mocks proves nothing about RLS: the
 * policies live in Postgres, so the test has to reach Postgres as an ordinary
 * signed-in user holding the anon key.
 *
 * Shape: user A creates a Space, Project and Material. User B then attempts
 * every read and write path against A's rows and must fail at all of them.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const configured = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY);

// Skip rather than fail when the machine has no credentials, so `npm test`
// stays useful without secrets. CI sets them and the suite runs for real.
const describeIntegration = configured ? describe : describe.skip;

type TestUser = { id: string; email: string; client: SupabaseClient };

describeIntegration('project-level data isolation', () => {
  const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let userA: TestUser;
  let userB: TestUser;
  let spaceA: string;
  let projectA: string;
  let materialA: string;

  async function createUser(label: string): Promise<TestUser> {
    const email = `isolation-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const password = `Test!${Math.random().toString(36).slice(2, 12)}`;

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser(${label}) failed: ${error.message}`);

    const client = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`signIn(${label}) failed: ${signIn.error.message}`);

    return { id: data.user!.id, email, client };
  }

  beforeAll(async () => {
    [userA, userB] = await Promise.all([createUser('a'), createUser('b')]);

    const { data: space, error: spaceErr } = await userA.client
      .from('spaces')
      .insert({ user_id: userA.id, name: 'A private space' })
      .select('id')
      .single();
    if (spaceErr) throw new Error(`space insert failed: ${spaceErr.message}`);
    spaceA = space.id;

    const { data: project, error: projErr } = await userA.client
      .from('projects')
      .insert({
        space_id: spaceA,
        user_id: userA.id,
        name: 'A private project',
        goal: 'Confidential learning goal',
      })
      .select('id')
      .single();
    if (projErr) throw new Error(`project insert failed: ${projErr.message}`);
    projectA = project.id;

    const { data: material, error: matErr } = await userA.client
      .from('materials')
      .insert({
        project_id: projectA,
        user_id: userA.id,
        filename: 'secret-notes.pdf',
        storage_path: `${userA.id}/${projectA}/secret-notes.pdf`,
        size_bytes: 1024,
      })
      .select('id')
      .single();
    if (matErr) throw new Error(`material insert failed: ${matErr.message}`);
    materialA = material.id;
  });

  afterAll(async () => {
    // Cascades clean up spaces, projects and materials.
    for (const u of [userA, userB]) {
      if (u?.id) await admin.auth.admin.deleteUser(u.id);
    }
  });

  it('lets the owner read their own rows', () => {
    // Guards against a false pass: if A could not read A's data either, every
    // assertion below would succeed for the wrong reason.
    expect(spaceA).toBeTruthy();
    expect(projectA).toBeTruthy();
    expect(materialA).toBeTruthy();
  });

  it("hides A's spaces from B", async () => {
    const { data } = await userB.client.from('spaces').select('id');
    expect(data ?? []).toEqual([]);
  });

  it("hides A's project from B, even by direct id", async () => {
    const { data } = await userB.client.from('projects').select('id, goal').eq('id', projectA);
    expect(data ?? []).toEqual([]);
  });

  it("hides A's materials from B", async () => {
    const { data } = await userB.client.from('materials').select('id, filename').eq('id', materialA);
    expect(data ?? []).toEqual([]);
  });

  it("stops B writing a project into A's space", async () => {
    // B owns the user_id but not the space. A policy checking only user_id
    // would wrongly allow this, which is why projects_insert also asserts
    // owns_space() (see 0006_rls_policies.sql).
    const { error } = await userB.client
      .from('projects')
      .insert({ space_id: spaceA, user_id: userB.id, name: 'intrusion' });
    expect(error).not.toBeNull();
  });

  it("stops B forging a row under A's user_id", async () => {
    const { error } = await userB.client
      .from('spaces')
      .insert({ user_id: userA.id, name: 'forged' });
    expect(error).not.toBeNull();
  });

  it("stops B updating A's project", async () => {
    const { data } = await userB.client
      .from('projects')
      .update({ name: 'hijacked' })
      .eq('id', projectA)
      .select('id');
    // RLS filters the row out, so the update matches nothing rather than erroring.
    expect(data ?? []).toEqual([]);

    const { data: check } = await userA.client
      .from('projects')
      .select('name')
      .eq('id', projectA)
      .single();
    expect(check?.name).toBe('A private project');
  });

  it("stops B deleting A's project", async () => {
    await userB.client.from('projects').delete().eq('id', projectA);
    const { data } = await userA.client.from('projects').select('id').eq('id', projectA);
    expect(data).toHaveLength(1);
  });

  it('stops a user promoting themselves to admin', async () => {
    // RLS controls which ROWS you may touch, not which COLUMNS. Without the
    // column-level grant in 0006, `id = auth.uid()` would happily permit this.
    const { error } = await userB.client
      .from('profiles')
      .update({ role: 'admin' })
      .eq('id', userB.id);
    expect(error).not.toBeNull();

    const { data } = await admin.from('profiles').select('role').eq('id', userB.id).single();
    expect(data?.role).toBe('user');
  });

  it('lets a user rename themselves (the allowed column still works)', async () => {
    const { error } = await userB.client
      .from('profiles')
      .update({ full_name: 'Renamed B' })
      .eq('id', userB.id);
    expect(error).toBeNull();
  });

  it('hides platform evaluation data from non-admins', async () => {
    const { data } = await userA.client.from('eval_runs').select('id');
    expect(data ?? []).toEqual([]);
  });

  it('blocks direct client writes to backend-only tables', async () => {
    // material_chunks has a SELECT policy and no INSERT policy, so retrieval
    // content cannot be poisoned through the anon key.
    const { error } = await userB.client.from('material_chunks').insert({
      material_id: materialA,
      project_id: projectA,
      user_id: userB.id,
      page_number: 1,
      chunk_index: 0,
      content: 'injected chunk',
    });
    expect(error).not.toBeNull();
  });
});
