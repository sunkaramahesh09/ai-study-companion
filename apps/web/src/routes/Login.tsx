import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider.tsx';

export function Login() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
      } else {
        await signUp(email, password, fullName);
        // Depending on the project's email-confirmation setting, signUp may not
        // create a session. Say so rather than leaving the form looking stuck.
        setNotice('Account created. If confirmation is required, check your email.');
        setMode('signin');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      {/* Left Panel — Branding */}
      <div className="login-left">
        {/* Decorative only — no content, no interaction. Sits behind the
            branding column via z-index so it never affects layout or a11y. */}
        <div className="login-bg-decor" aria-hidden="true">
          <span className="login-blob login-blob-1" />
          <span className="login-blob login-blob-2" />
          <span className="login-blob login-blob-3" />
          <span className="login-landscape" />
        </div>

        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-8)' }}>
            <div className="sidebar-logo-icon" style={{ width: 40, height: 40, fontSize: 20 }}>🎓</div>
            <div>
              <span style={{ fontWeight: 700, fontSize: 'var(--text-lg)' }}>AI.Prof</span>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', display: 'block' }}>Your AI Study Companion</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)', marginBottom: 'var(--space-4)' }}>
            <div>
              <div className="login-badge">✨ AI-Powered Learning</div>
              <h1 className="login-headline">
                Learn smarter.<br />
                <span className="gradient">Master faster.</span>
              </h1>
            </div>
            <div className="login-illustration">
              <span className="login-illustration-glow" aria-hidden="true" />
              <img
                src="/ai-brain.jpg"
                alt="AI Brain Illustration"
                style={{
                  width: 140,
                  height: 140,
                  objectFit: 'cover',
                  borderRadius: '50%',
                  boxShadow: '0 20px 40px rgba(108, 71, 236, 0.2)',
                  border: '4px solid white',
                  mixBlendMode: 'multiply',
                  position: 'relative',
                }}
              />
              <span className="login-sparkle login-sparkle-1" aria-hidden="true">✦</span>
              <span className="login-sparkle login-sparkle-2" aria-hidden="true">✦</span>
              <div className="login-callout" aria-hidden="true">
                💡 Small steps every day lead to big results!
              </div>
            </div>
          </div>

          <p className="login-subtitle">
            Your AI-powered study companion for notes, quizzes, progress and personalized recommendations.
          </p>

          <div className="login-features">
            <div className="login-feature">
              <div className="login-feature-icon" style={{ background: 'var(--lavender-100)', color: 'var(--primary-500)' }}>💬</div>
              <div>
                <h4>AI Tutor</h4>
                <p>Get clear explanations, real examples, and instant help from your materials.</p>
              </div>
            </div>
            <div className="login-feature">
              <div className="login-feature-icon" style={{ background: 'var(--info-50)', color: 'var(--info-500)' }}>📝</div>
              <div>
                <h4>Adaptive Quizzes</h4>
                <p>Practice with AI-generated questions tailored to your progress.</p>
              </div>
            </div>
            <div className="login-feature">
              <div className="login-feature-icon" style={{ background: 'var(--success-50)', color: 'var(--success-500)' }}>📈</div>
              <div>
                <h4>Personalized Growth</h4>
                <p>Track your mastery and get smart recommendations for what to learn next.</p>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 'var(--space-8)', fontStyle: 'italic', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            <p>"The beautiful thing about learning is that no one can take it away from you."</p>
            <p style={{ marginTop: 'var(--space-1)', fontWeight: 600, fontStyle: 'normal' }}>— B.B. King</p>
          </div>
        </div>
      </div>

      {/* Right Panel — Form */}
      <div className="login-right">
        <div className="login-form-container">
          <div style={{ textAlign: 'right', marginBottom: 'var(--space-6)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Better Students. Brighter Futures. ✨
          </div>

          <div className="login-tabs">
            <button
              type="button"
              className={`login-tab${mode === 'signin' ? ' active' : ''}`}
              onClick={() => { setMode('signin'); setError(null); setNotice(null); }}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`login-tab${mode === 'signup' ? ' active' : ''}`}
              onClick={() => { setMode('signup'); setError(null); setNotice(null); }}
            >
              Create account
            </button>
          </div>

          <div className="login-welcome">
            <h2>
              {mode === 'signin' ? 'Welcome back 👋' : 'Get started 🚀'}
            </h2>
            <p>
              {mode === 'signin'
                ? 'Continue your learning journey.'
                : 'Create your account and start learning.'}
            </p>
          </div>

          <form className="login-form" onSubmit={onSubmit}>
            {mode === 'signup' && (
              <label>
                Full Name
                <div className="login-input-group">
                  <span className="login-input-icon">👤</span>
                  <input
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    autoComplete="name"
                    required
                    placeholder="Enter your full name"
                  />
                </div>
              </label>
            )}

            <label>
              Email
              <div className="login-input-group">
                <span className="login-input-icon">✉️</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                  placeholder="Enter your email address"
                />
              </div>
            </label>

            <label>
              Password
              <div className="login-input-group" style={{ position: 'relative' }}>
                <span className="login-input-icon">🔒</span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  minLength={8}
                  required
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: 12,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    padding: 4,
                    cursor: 'pointer',
                    fontSize: 14,
                    boxShadow: 'none',
                  }}
                  tabIndex={-1}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? '🙈' : '👁️'}
                </button>
              </div>
            </label>

            {error && (
              <div style={{
                padding: 'var(--space-3)',
                background: 'var(--error-50)',
                border: '1px solid var(--error-100)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--error-600)',
                fontSize: 'var(--text-sm)',
              }}>
                {error}
              </div>
            )}
            {notice && (
              <div style={{
                padding: 'var(--space-3)',
                background: 'var(--success-50)',
                border: '1px solid var(--success-100)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--success-700)',
                fontSize: 'var(--text-sm)',
              }}>
                {notice}
              </div>
            )}

            <button type="submit" className="login-submit" disabled={busy}>
              {busy ? 'Working…' : mode === 'signin' ? 'Sign in →' : 'Create account →'}
            </button>
          </form>

          <div className="login-footer">
            <p>
              {mode === 'signin'
                ? <>New to AI.Prof? <a href="#" onClick={(e) => { e.preventDefault(); setMode('signup'); setError(null); }}>Create an account</a></>
                : <>Already have an account? <a href="#" onClick={(e) => { e.preventDefault(); setMode('signin'); setError(null); }}>Sign in</a></>}
            </p>
          </div>

          <div className="login-privacy">
            <span>🔒</span>
            <span>Your learning data stays private. We never share your materials or personal information.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
