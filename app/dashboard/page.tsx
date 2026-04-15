import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import Dashboard from '@/components/Dashboard'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DashboardPage() {
  // Force dynamic rendering by calling cookies()
  const cookieStore = cookies()
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*, location:locations(*)')
    .eq('id', user.id)
    .single()

  const { data: locations } = await supabase.from('locations').select('*').order('label', { ascending: true })
  const { data: allProfiles } = await supabase.from('profiles').select('*, location:locations(*)')
  const { data: botState } = await supabase.from('bot_state').select('*').single()

  // FIXED: Only fetch ACTIVE deliveries — filter out idle/delivered/returning rows
  // that were left over from previous sessions. Without this filter, stale
  // deliveries from past runs show up on login even after a bot_state reset.
  const { data: delivery } = await supabase
    .from('deliveries')
    .select('*')
    .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
    .in('status', ['going_pickup', 'at_pickup', 'loading', 'in_transit', 'at_delivery'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (
    <Dashboard
      key={user.id}
      userId={user.id}
      profile={profile}
      locations={locations || []}
      allProfiles={allProfiles || []}
      initialDelivery={delivery}
      initialBotState={botState}
    />
  )
}