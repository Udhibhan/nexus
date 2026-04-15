import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Dashboard from '@/components/Dashboard'

export default async function DashboardPage() {
  const supabase = createClient()
  
  // 1. Identify who is logged in
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  // 2. Fetch the specific profile for THIS user
  // Without the .eq('id', user.id), Supabase might just return Alice
  const { data: profile } = await supabase
    .from('profiles')
    .select('*, location:locations(*)')
    .eq('id', user.id) 
    .single()

  // 3. Fetch all possible locations and profiles (for the dispatch dropdowns)
  const { data: locations } = await supabase
    .from('locations')
    .select('*')
    .order('label', { ascending: true })

  const { data: allProfiles } = await supabase
    .from('profiles')
    .select('*, location:locations(*)')

  // 4. Get the current robot state
  const { data: botState } = await supabase
    .from('bot_state')
    .select('*')
    .single()
  
  // 5. Fetch the most recent delivery where this user is the SENDER or RECIPIENT
  // This ensures that when the robot arrives, the dashboard knows it belongs to YOU
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