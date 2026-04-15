import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import LoginForm from '@/components/LoginForm'

export default async function HomePage() {
  const supabase = createClient()
  
  // Get current session
  const { data: { user } } = await supabase.auth.getUser()
  
  // If a user exists, send them to the dashboard
  if (user) {
    // We use redirect to avoid any flickering
    redirect('/dashboard')
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