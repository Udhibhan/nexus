'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function LoginForm() {
  const router = useRouter()
  const supabase = createClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function login() {
    setLoading(true)
    setError('')

    // CRITICAL: Sign out any existing session first so a different user can log in
    // on the same browser without inheriting the previous session's cookies.
    await supabase.auth.signOut()

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      // router.refresh() forces Next.js to re-run server components with the new session
      router.refresh()
      router.push('/dashboard')
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