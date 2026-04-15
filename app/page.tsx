import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Dashboard from '@/components/Dashboard'

export default async function DashboardPage() {
  const supabase = createClient()
  
  // 1. Get the current logged-in user's Auth ID
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  // 2. Fetch ONLY the profile matching this ID
  // Use .eq('id', user.id) to ensure you don't get Alice every time
  const { data: profile } = await supabase
    .from('profiles')
    .select('*, location:locations(*)')
    .eq('id', user.id) // <--- CRITICAL FILTER
    .single()

  // 3. Fetch other necessary data for the dashboard
  const { data: locations } = await supabase.from('locations').select('*')
  const { data: allProfiles } = await supabase.from('profiles').select('*, location:locations(*)')
  const { data: botState } = await supabase.from('bot_state').select('*').single()
  
  // Get the most recent active delivery for this specific user
  const { data: delivery } = await supabase
    .from('deliveries')
    .select('*')
    .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

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