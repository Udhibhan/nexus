'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function LoginForm() {
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function login() {
    setLoading(true)
    setError('')

    // NOTE: We do NOT signOut() first. signOut() is global — it kills ALL tabs'
    // sessions simultaneously (shared cookie), which caused the cross-tab bug.
    // The new signIn naturally replaces the existing session cookie.
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      // Hard redirect instead of router.push — forces the browser to send the
      // new session cookie to the server fresh, bypassing Next.js router cache.
      window.location.replace('/dashboard')
    }
  }

  return (
    <div className="card" style={{ padding: '28px' }}>
      <div style={{ marginBottom: '20px' }}>
        <span className="label">Access Terminal</span>
      </div>
      <div style={{ marginBottom: '14px' }}>
        <span className="label">Email</span>
        <input
          className="input" type="email"
          placeholder="operator@facility.local"
          value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()}
        />
      </div>
      <div style={{ marginBottom: '20px' }}>
        <span className="label">Password</span>
        <input
          className="input" type="password" placeholder="••••••••"
          value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()}
        />
      </div>
      {error && (
        <div style={{
          fontFamily: 'JetBrains Mono, monospace', fontSize: '11px',
          color: 'var(--red)', marginBottom: '14px', padding: '8px 10px',
          border: '1px solid rgba(239,68,68,0.3)', borderRadius: '2px',
          background: 'rgba(239,68,68,0.05)',
        }}>✕ {error}</div>
      )}
      <button className="btn btn-amber" style={{ width: '100%' }} onClick={login} disabled={loading}>
        {loading ? 'Authenticating...' : '→ Login'}
      </button>
    </div>
  )
}