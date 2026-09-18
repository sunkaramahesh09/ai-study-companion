import type { Session } from '@supabase/supabase-js';
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setSessionExpiredHandler } from '../lib/api.ts';
import { supabase } from '../lib/supabase.ts';

export type Profile = {
  id: string;
  email: string;
  /** Given at sign-up. Falls back in the DB trigger to the email's local part. */
  fullName: string | null;
  role: 'user' | 'admin';
};

type AuthState = {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    // Resolve the persisted session before first paint, so a reload does not
    // bounce an authenticated user to the login screen.
    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setLoading(false);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (active) setSession(next);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  /**
   * The API reports an expired or revoked session by returning 401.
   *
   * Signing out here means the user gets the sign-in screen once, instead of
   * every panel on the page rendering "Unauthorized" while the app behaves as
   * though it is still logged in. Only 401 triggers this — a 403 means the
   * caller IS authenticated and simply lacks the role, and signing them out
   * for visiting an admin page would be a bug.
   */
  useEffect(() => {
    setSessionExpiredHandler(() => {
      void supabase.auth.signOut();
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      return;
    }
    let active = true;
    // Read the profile through RLS: the policy returns this user's row only,
    // so the role shown in the UI is the role the database actually holds.
    supabase
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => {
        if (!active || !data) return;
        const row = data as { id: string; email: string; full_name: string | null; role: Profile['role'] };
        setProfile({ id: row.id, email: row.email, fullName: row.full_name, role: row.role });
      });
    return () => {
      active = false;
    };
  }, [session]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      loading,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
      },
      async signUp(email, password, fullName) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (error) throw new Error(error.message);
      },
      async signOut() {
        await supabase.auth.signOut();
      },
    }),
    [session, profile, loading],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
