import { createClient } from '@/lib/supabase/server'
import LoginForm from '@/components/LoginForm'

export default async function HomePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Fetch the profile so we can show who is currently logged in (if anyone)
  let currentName: string | null = null
  if (user) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', user.id)
      .single()
    currentName = profile?.name ?? user.email ?? null
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: '20px',
      background: 'var(--background)' // Ensure background matches
    }}>
      <div style={{ width: '100%', maxWidth: '380px' }}>
        <div style={{ marginBottom: '40px' }}>
          <div style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: '10px',
            color: 'var(--amber)', letterSpacing: '0.2em',
            textTransform: 'uppercase', marginBottom: '12px',
          }}>
            ◆ EPP — Autonomous Delivery
          </div>
          <h1 style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: '28px',
            fontWeight: 300, color: 'var(--text)', margin: 0,
            letterSpacing: '-0.02em', lineHeight: 1.2,
          }}>
            mbot<br />
            <span style={{ color: 'var(--amber)', fontWeight: 600 }}>DELIVERY</span>
          </h1>
          <div style={{ width: '40px', height: '2px', background: 'var(--amber)', marginTop: '16px' }} />
        </div>

        {/* Show who is currently logged in so users know logging in will switch accounts */}
        {currentName && (
          <div style={{
            marginBottom: '16px',
            padding: '10px 14px',
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: '2px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '11px',
            color: 'var(--amber)',
          }}>
            ⚠ Logged in as <strong>{currentName}</strong>.{' '}
            <a href="/dashboard" style={{ color: 'var(--amber)', textDecoration: 'underline' }}>Go to dashboard</a>
            {' '}or log in below to switch accounts.
          </div>
        )}

        {/* This form MUST use the dynamic credentials provided by the user */}
        <LoginForm />

        <div style={{
          marginTop: '32px', fontFamily: 'JetBrains Mono, monospace',
          fontSize: '10px', color: 'var(--muted)', textAlign: 'center', letterSpacing: '0.05em',
        }}>
          NUS EPP PROJECT — 2026
        </div>
      </div>
    </div>
  )
}