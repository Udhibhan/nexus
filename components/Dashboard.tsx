'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { TOPICS, publishCommand } from '@/lib/mqtt'
import type { MqttClient } from 'mqtt'
import type { Location, Profile, Delivery, BotState, MqttStatusEvent } from '@/lib/types'

// --- Essential Visual Helpers (The "Stuff" that was missing) ---
const STATUS_LABELS: Record<string, string> = {
  idle: 'At Base', going_pickup: 'Heading to you', at_pickup: 'Arrived at Pickup',
  loading: 'Awaiting Destination', in_transit: 'In Transit', at_delivery: 'At Destination',
  delivered: 'Collected', returning: 'Returning Home'
}

function GridMap({ locations, botX, botY }: { locations: Location[], botX: number, botY: number }) {
  const maxX = Math.max(...locations.map(l => l.x), 3), maxY = Math.max(...locations.map(l => l.y), 2)
  const cols = maxX + 1, grid = []
  const locMap: Record<string, Location> = {}
  locations.forEach(l => { locMap[`${l.x},${l.y}`] = l })
  for (let y = maxY; y >= 0; y--) {
    for (let x = 0; x < cols; x++) {
      const loc = locMap[`${x},${y}`], isBot = botX === x && botY === y
      grid.push(
        <div key={`${x},${y}`} className={`grid-cell ${loc ? 'has-location' : ''} ${isBot ? 'bot-here' : ''}`} style={{ minHeight: '50px', border: '1px solid #222', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px' }}>
          {isBot && <div style={{ position: 'absolute', top: 2, right: 2 }}>🤖</div>}
          {loc?.label}
        </div>
      )
    }
  }
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 4, background: '#000', padding: 10 }}>{grid}</div>
}

export default function Dashboard({ userId, profile, locations, allProfiles, initialDelivery, initialBotState }: any) {
  const router = useRouter()
  const supabase = createClient()
  const [delivery, setDelivery] = useState<Delivery | null>(initialDelivery)
  const [botState, setBotState] = useState<BotState | null>(initialBotState)
  const [mqttOk, setMqttOk] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [showSetup, setShowSetup] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // Form States
  const [recipientId, setRecipient] = useState('')
  const [destId, setDest] = useState('')
  const [passcode, setPasscode] = useState('')
  const mqttRef = useRef<MqttClient | null>(null)

  const addLog = (msg: string) => {
    setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 20))
  }

  // --- REALTIME FIX: The "Aggressive" Listeners ---
  useEffect(() => {
    // 1. MQTT for hardware events
    import('mqtt').then((mod) => {
      const client = mod.connect(process.env.NEXT_PUBLIC_MQTT_BROKER_WSS!, {
        clientId: `web_${userId.slice(0,4)}`,
        username: process.env.NEXT_PUBLIC_MQTT_USERNAME,
        password: process.env.NEXT_PUBLIC_MQTT_PASSWORD,
      })
      mqttRef.current = client
      client.on('connect', () => { setMqttOk(true); client.subscribe(TOPICS.status); addLog("MQTT: Link Active") })
      client.on('message', (t, p) => {
        const { event } = JSON.parse(p.toString())
        addLog(`Hardware Event: ${event}`)
        
        // CRITICAL: POPUP TRIGGER
        if (event === 'load_received') {
            setShowSetup(true) // Force the modal open immediately
            setToast("Load detected! Please set destination.")
        }
      })
    })

    // 2. Supabase Realtime for database sync
    const channel = supabase.channel('table-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, (payload) => {
        setDelivery(payload.new as Delivery)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_state' }, (payload) => {
        setBotState(payload.new as BotState)
      })
      .subscribe()

    return () => { mqttRef.current?.end(); supabase.removeChannel(channel) }
  }, [supabase, userId])

  // --- Actions ---
  const callBot = async () => {
    const { data } = await supabase.from('deliveries').insert({
      sender_id: userId,
      pickup_location_id: profile.location_id,
      status: 'going_pickup'
    }).select().single()
    if (data) {
      publishCommand({ action: 'call', pickup: profile.location_id })
      addLog("Command: Calling Bot to Office")
    }
  }

  const dispatchBot = async () => {
    if (!destId || !recipientId || passcode.length < 4) return setToast("Fill all fields")
    
    await supabase.from('deliveries').update({
      delivery_location_id: destId, recipient_id: recipientId, passcode: passcode, status: 'in_transit'
    }).eq('id', delivery?.id)

    publishCommand({ action: 'deliver', delivery: destId, passcode: passcode })
    setShowSetup(false)
    addLog(`Command: Dispatching to ${destId}`)
  }

  return (
    <div style={{ padding: 30, background: '#050505', color: '#eee', minHeight: '100vh', fontFamily: 'monospace' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #222', pb: 10, mb: 20 }}>
        <div>
          <h2 style={{ margin: 0, color: 'orange' }}>SILICON SENTINEL // CONTROL</h2>
          <small style={{ color: '#666' }}>OPERATOR: {profile?.name} @ {profile?.location?.label}</small>
        </div>
        <div style={{ color: mqttOk ? '#00ff00' : '#ff0000', fontSize: '12px' }}>
          MQTT STATUS: {mqttOk ? 'ENCRYPTED LIVE' : 'DISCONNECTED'}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 20 }}>
        <section>
          <div className="card" style={{ border: '1px solid #222', padding: 20, background: '#0a0a0a', mb: 20 }}>
            <h3 style={{ marginTop: 0 }}>BOT NAVIGATION</h3>
            <GridMap locations={locations} botX={botState?.current_x ?? 0} botY={botState?.current_y ?? 0} />
          </div>

          <div className="card" style={{ border: '1px solid #222', padding: 20, background: '#0a0a0a' }}>
            <h3>SYSTEM LOG</h3>
            <div style={{ height: 150, overflowY: 'auto', fontSize: '11px', color: '#888' }}>
              {log.map((l, i) => <div key={i} style={{ borderBottom: '1px solid #111', padding: '4px 0' }}>{l}</div>)}
            </div>
          </div>
        </section>

        <section>
          <div className="card" style={{ border: '1px solid #222', padding: 20, background: '#0a0a0a', height: '100%' }}>
            <h3>CURRENT MISSION</h3>
            <div style={{ background: '#111', padding: 15, borderRadius: 4, borderLeft: '4px solid orange' }}>
              <div style={{ fontSize: '12px', color: '#666' }}>STATUS</div>
              <div style={{ fontSize: '18px', fontWeight: 'bold' }}>{STATUS_LABELS[delivery?.status || 'idle']}</div>
            </div>

            <div style={{ mt: 20 }}>
              {(!delivery || delivery.status === 'idle') && (
                <button onClick={callBot} style={{ width: '100%', padding: 15, background: 'orange', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}>
                  CALL BOT TO PICKUP
                </button>
              )}

              {/* Recipient View: Shows them the OTP */}
              {delivery?.recipient_id === userId && (delivery.status === 'in_transit' || delivery.status === 'at_delivery') && (
                <div style={{ mt: 20, textAlign: 'center', background: '#222', padding: 20 }}>
                  <div style={{ fontSize: '12px', color: 'orange' }}>YOUR COLLECTION CODE</div>
                  <div style={{ fontSize: '40px', letterSpacing: 10, fontWeight: 'bold' }}>{delivery.passcode}</div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* THE DESTINATION POPUP (The "Ask Where To Go" Modal) */}
      {showSetup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#111', padding: 30, border: '2px solid orange', width: 400 }}>
            <h2 style={{ color: 'orange', marginTop: 0 }}>ROUTE CONFIGURATION</h2>
            <p style={{ fontSize: '12px', color: '#888' }}>Load confirmed by Silicon Sentinel. Select destination.</p>
            
            <label style={{ display: 'block', mt: 15, fontSize: '11px' }}>DESTINATION STATION</label>
            <select value={destId} onChange={e => setDest(e.target.value)} style={{ width: '100%', padding: 10, background: '#222', color: 'white', border: '1px solid #444' }}>
              <option value="">-- Select --</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>

            <label style={{ display: 'block', mt: 15, fontSize: '11px' }}>RECIPIENT</label>
            <select value={recipientId} onChange={e => setRecipient(e.target.value)} style={{ width: '100%', padding: 10, background: '#222', color: 'white', border: '1px solid #444' }}>
              <option value="">-- Select --</option>
              {allProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            <label style={{ display: 'block', mt: 15, fontSize: '11px' }}>SET 4-DIGIT OTP</label>
            <input type="text" maxLength={4} value={passcode} onChange={e => setPasscode(e.target.value.replace(/\D/g,''))} style={{ width: '100%', padding: 10, background: '#222', color: 'orange', border: '1px solid #444', textAlign: 'center', fontSize: '20px', letterSpacing: 8 }} />

            <button onClick={dispatchBot} style={{ width: '100%', mt: 25, padding: 15, background: 'orange', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}>
              INITIATE DELIVERY ⟶
            </button>
          </div>
        </div>
      )}

      {toast && <div style={{ position: 'fixed', bottom: 20, left: 20, background: 'orange', color: 'black', padding: '10px 20px', fontWeight: 'bold' }}>{toast}</div>}
    </div>
  )
}