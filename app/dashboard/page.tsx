import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Dashboard from '@/components/Dashboard'

// THIS IS CRITICAL: This stops Next.js from caching Alice's profile
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DashboardPage() {
  const supabase = createClient()
  
  // 1. Identify who is logged in via Auth
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  // --- DEBUG BLOCK: Check your terminal (not browser) to see these ---
  console.log("-----------------------------------------")
  console.log("LOGGED IN AUTH ID:", user.id)
  console.log("LOGGED IN EMAIL:", user.email)
  // ---------------------------------------------------------------

  // 2. Fetch the specific profile for THIS user
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*, location:locations(*)')
    .eq('id', user.id) 
    .single()

  // DEBUG: See what profile came back
  console.log("DATABASE PROFILE NAME:", profile?.name || "NOT FOUND")
  if (profileError) console.error("PROFILE ERROR:", profileError.message)
  console.log("-----------------------------------------")

  // If no profile exists for this Auth ID, you might need to create one 
  // or check your Supabase table for ID mismatches.
  if (!profile) {
    // Optional: redirect to a setup page if you want
    // redirect('/setup-profile') 
  }

  // 3. Fetch all possible locations and profiles (for dropdowns)
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
  
  // 5. Fetch the most recent delivery where this user is involved
  // This is what allows the popup to show up for the SENDER
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