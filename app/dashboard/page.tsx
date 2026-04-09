import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase-server'
import Dashboard from '@/components/Dashboard'

export default async function DashboardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*, location:locations(*)')
    .eq('id', user.id)
    .single()

  const { data: locations } = await supabase
    .from('locations')
    .select('*')
    .order('label')

  const { data: allProfiles } = await supabase
    .from('profiles')
    .select('*, location:locations(*)')

  const { data: delivery } = await supabase
    .from('deliveries')
    .select('*')
    .not('status', 'eq', 'idle')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: botState } = await supabase
    .from('bot_state')
    .select('*')
    .eq('id', 1)
    .single()

  return (
    <Dashboard
      userId={user.id}
      profile={profile}
      locations={locations || []}
      allProfiles={allProfiles || []}
      initialDelivery={delivery}
      initialBotState={botState}
    />
  )
}
