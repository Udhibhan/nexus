'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { TOPICS, publishCommand } from '@/lib/mqtt'
import type { MqttClient } from 'mqtt'
import type { Location, Profile, Delivery, BotState, MqttStatusEvent } from '@/lib/types'

const STATUS_LABELS: Record<string, string> = {
  idle:         'Idle — at home base',
  going_pickup: 'En route to pickup',
  at_pickup:    'Loading at pickup...',
  loading:      'Load secured — awaiting dispatch',
  in_transit:   'Delivering',
  at_delivery:  'Arrived — awaiting physical keypad entry',
  delivered:    'Package collected',
  returning:    'Returning to base',
}

const STATUS_DOT: Record<string, string> = {
  idle:         'dot-gray',
  going_pickup: 'dot-amber',
  at_pickup:    'dot-amber',
  loading:      'dot-amber',
  in_transit:   'dot-amber',
  at_delivery:  'dot-green',
  delivered:    'dot-green',
  returning:    'dot-amber',
}

const STATUS_ORDER = ['idle','going_pickup','at_pickup','loading','in_transit','at_delivery','delivered','returning']
function isAfterOrEqual(current: string, target: string) {
  return STATUS_ORDER.indexOf(current) >= STATUS_ORDER.indexOf(target)
}

interface Props {
  userId:          string
  profile:         (Profile & { location?: Location }) | null
  locations:       Location[]
  allProfiles:     (Profile & { location?: Location })[]
  initialDelivery: Delivery | null
  initialBotState: BotState | null
}

function GridMap({ locations, botX, botY }: { locations: Location[], botX: number, botY: number }) {
  const maxX = Math.max(...locations.map(l => l.x), 3)
  const maxY = Math.max(...locations.map(l => l.y), 2)
  const cols = maxX + 1
  const locMap: Record<string, Location> = {}
  locations.forEach(l => { locMap[`${l.x},${l.y}`] = l })

  const grid = []
  for (let y = maxY; y >= 0; y--) {
    for (let x = 0; x < cols; x++) {
      const loc   = locMap[`${x},${y}`]
      const isBot = botX === x && botY === y
      grid.push(
        <div key={`${x},${y}`}
          className={`grid-cell${loc ? ' has-location' : ''}${loc?.is_home ? ' is-home' : ''}${isBot ? ' bot-here' : ''}`}
          style={{ minHeight: '60px', position: 'relative' }}
        >
          {isBot && <div style={{ position: 'absolute', top: 4, right: 4, fontSize: 14 }}>🤖</div>}
          {loc ? (
            <div style={{ textAlign: 'center', lineHeight: 1.3 }}>
              <div style={{ fontSize: 8, color: 'var(--muted)' }}>{x},{y}</div>
              <div style={{ fontSize: 9, color: loc.is_home ? 'var(--amber)' : 'var(--text)', marginTop: 2 }}>
                {loc.label}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 8, color: '#222' }}>{x},{y}</div>
          )}
        </div>
      )
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 4 }}>
      {grid}
    </div>
  )
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#0a0a0a', border: '1px solid var(--border)', borderRadius: 2, padding: '8px 10px' }}>
      <div style={{ fontFamily: 'JetBrains Mono,monospace', fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono,monospace', fontSize: 11, color: 'var(--text)' }}>{value}</div>
    </div>
  )
}

function StatusMsg({ icon, text, color }: { icon: string; text: string; color: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: 12, background: '#0a0a0a', border: `1px solid ${color}33`, borderRadius: 2 }}>
      <span style={{ color, fontSize: 14 }}>{icon}</span>
      <span style={{ fontFamily: 'JetBrains Mono,monospace', fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>{text}</span>
    </div>
  )
}

export default function Dashboard({ userId, profile, locations, allProfiles, initialDelivery, initialBotState }: Props) {
  const router   = useRouter()
  const supabase = createClient()

  const [delivery, setDelivery]     = useState<Delivery | null>(initialDelivery)
  const [botState, setBotState]     = useState<BotState | null>(initialBotState)
  const [mqttOk, setMqttOk]         = useState(false)
  const [toast, setToast]           = useState<string | null>(null)
  const [log, setLog]               = useState<string[]>([])
  const [showSetup, setShowSetup]   = useState(false)
  const [recipientId, setRecipient] = useState('')
  const [destId, setDest]           = useState('')
  const [passcode, setPasscode]     = useState('')
  
  const mqttRef = useRef<MqttClient | null>(null)
  
  // Refs for logic consistency
  const deliveryRef = useRef<Delivery | null>(initialDelivery)
  const botStateRef = useRef<BotState | null>(initialBotState)

  useEffect(() => { deliveryRef.current = delivery }, [delivery])
  useEffect(() => { botStateRef.current = botState }, [botState])

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false })
    setLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 40))
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg); setTimeout(() => setToast(null), 4000)
  }, [])

  const myLoc      = profile?.location
  const amSender   = delivery?.sender_id    === userId
  const amRecip    = delivery?.recipient_id === userId
  const botStatus  = botState?.status || 'idle'
  const botIdle    = botStatus === 'idle' || !delivery
  const others     = allProfiles.filter(p => p.id !== userId)

  // MQTT Connection
  useEffect(() => {
    let mounted = true
    import('mqtt').then((mod) => {
      const m = mod as Record<string, any>
      const connectFn = (typeof m.connect === 'function' ? m.connect : (m.default as any)?.connect ?? m.default)
      if (!mounted) return
      
      const c = connectFn(process.env.NEXT_PUBLIC_MQTT_BROKER_WSS!, {
        clientId: `mbot_web_${Math.random().toString(16).slice(2, 8)}`,
        username:  process.env.NEXT_PUBLIC_MQTT_USERNAME,
        password:  process.env.NEXT_PUBLIC_MQTT_PASSWORD,
        reconnectPeriod: 3000,
        keepalive: 30,
      })
      mqttRef.current = c
      c.on('connect', () => { setMqttOk(true); c.subscribe(TOPICS.status); addLog('MQTT connected') })
      c.on('message', (_t: string, payload: Buffer) => {
        try {
          const { event } = JSON.parse(payload.toString())
          handleEvent(event)
        } catch {}
      })
    })
    return () => { mounted = false; mqttRef.current?.end(true) }
  }, [])

  // Supabase Realtime - FIXED: Aggressive state syncing
  useEffect(() => {
    const ch = supabase.channel('rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, ({ new: r }) => {
        const d = r as Delivery
        setDelivery(d)
        deliveryRef.current = d
        addLog(`DB Sync: Status is now ${d.status}`)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_state' }, ({ new: r }) => {
        setBotState(r as BotState)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [])
  async function handleEvent(event: string) {
    addLog(`Hardware Event: ${event}`)
    
    // Grab current states from refs so we don't get trapped by race conditions
    const status = botStateRef.current?.status
    const del    = deliveryRef.current
    const sender = del?.sender_id

    // ── 1. ARRIVAL LOGIC ────────────────────────────────────────────────────
    if (event === 'arrived_location' || event === 'arrived_home') {

      if (status === 'going_pickup') {
        // Only the sender's client drives state transitions to avoid double-patch
        if (sender === userId) {
          await patchDelivery({ status: 'at_pickup' })
          await patchBot({ status: 'at_pickup' })
        }
      }
      else if (status === 'in_transit') {
        if (sender === userId) {
          await patchDelivery({ status: 'at_delivery' })
          await patchBot({ status: 'at_delivery' })
        }
      }
      else if (event === 'arrived_home' && (status === 'returning' || status === 'delivered')) {
        if (sender === userId) {
          await patchBot({ status: 'idle', current_x: 0, current_y: 0, delivery_id: null })
          setDelivery(null)
        }
        showToast('Bot back at base.')
      }

    }
    // ── 2. LOAD RECEIVED ─────────────────────────────────────────────────────
    else if (event === 'load_received') {

      if (status === 'at_pickup' || status === 'going_pickup' || status === 'loading') {
        if (sender === userId) {
          await patchDelivery({ status: 'loading', load_detected: true })
          await patchBot({ status: 'loading' })
          // Show the dispatch modal for the sender
          setShowSetup(true)
          showToast('✓ Load secured. Set destination & passcode.')
        }
      }

    }
    // ── 3. PASSCODE CORRECT ───────────────────────────────────────────────────
    else if (event === 'box_opened') {
      if (sender === userId) {
        await patchDelivery({ status: 'delivered' })
        await patchBot({ status: 'returning' })
      }
      showToast('✓ Passcode accepted — box opened!')
    }
    // ── 4. WRONG PASSCODE ────────────────────────────────────────────────────
    else if (event === 'wrong_passcode') {
      showToast('⚠ Wrong passcode entered on keypad.')
    }
    else if (event === 'wrong_passcode_locked') {
      showToast('🔒 Keypad locked — 3 wrong attempts. Contact admin.')
    }
  }
  async function patchDelivery(patch: Partial<Delivery>) {
    const id = deliveryRef.current?.id
    if (!id) return
    const { data } = await supabase.from('deliveries').update(patch).eq('id', id).select().single()
    if (data) setDelivery(data)
  }

  async function patchBot(patch: Partial<BotState>) {
    await supabase.from('bot_state').update(patch).eq('id', 1)
  }

  async function callBot() {
    if (!myLoc) return showToast('Location not set')
    
    // Create new delivery record
    const { data: nd, error } = await supabase.from('deliveries')
      .insert({ status: 'going_pickup', sender_id: userId, pickup_location_id: myLoc.id })
      .select().single()
    
    if (nd) { 
      setDelivery(nd as Delivery)
      deliveryRef.current = nd as Delivery // Update ref immediately for event listener
      await patchBot({ status: 'going_pickup', delivery_id: nd.id }) 
      publishCommand({ action: 'call', pickup: myLoc.id })
      showToast(`Bot called to ${myLoc.label}`)
    }
  }

  async function startDelivery() {
    if (passcode.length !== 4) return showToast('Need 4-digit passcode')
    if (!recipientId || !destId) return showToast('Select recipient/destination')
    
    await patchDelivery({ 
      status: 'in_transit', 
      recipient_id: recipientId, 
      delivery_location_id: destId, 
      passcode 
    })
    
    await patchBot({ status: 'in_transit' })
    publishCommand({ action: 'deliver', delivery: destId, passcode: passcode })
    
    setShowSetup(false)
    showToast('Package dispatched')
  }

  const logout = async () => { await supabase.auth.signOut(); router.refresh(); router.push('/') }
  const M = { fontFamily: 'JetBrains Mono,monospace' }

  return (
    <div style={{ minHeight: '100vh', padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ ...M, fontSize: 10, color: 'var(--amber)', textTransform: 'uppercase', marginBottom: 4 }}>◆ Terafabs Silicon Sentinel</div>
          <div style={{ ...M, fontSize: 18, fontWeight: 300 }}>
            {profile?.name || 'Loading Operator...'} 
            <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 12 }}>ID: {userId.slice(0,5)}... @ {myLoc?.label || 'Unknown'}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={`status-dot ${mqttOk ? 'dot-green' : 'dot-red'}`} />
            <span style={{ ...M, fontSize: 10, color: 'var(--muted)' }}>MQTT {mqttOk ? 'ONLINE' : 'OFFLINE'}</span>
          </div>
          <button className="btn" onClick={logout}>Logout</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          
          {/* Status Card */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <span className="label">Robot Status</span>
              <span style={{ ...M, fontSize: 11 }}>{STATUS_LABELS[botStatus]}</span>
            </div>
            {delivery && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <InfoBox label="From" value={locations.find(l => l.id === delivery.pickup_location_id)?.label || '—'} />
                <InfoBox label="To" value={locations.find(l => l.id === delivery.delivery_location_id)?.label || '—'} />
                <InfoBox label="Recipient" value={allProfiles.find(p => p.id === delivery.recipient_id)?.name || '—'} />
              </div>
            )}
          </div>

          {/* Action Center */}
          <div className="card" style={{ padding: 20 }}>
            <span className="label" style={{ display: 'block', marginBottom: 16 }}>Controls</span>
            
            {botIdle && (
              <button className="btn btn-amber" onClick={callBot}>↗ Request Bot to {myLoc?.label || 'Station'}</button>
            )}

            {botStatus === 'loading' && amSender && (
               <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                 <StatusMsg icon="⚖" text="Physical load detected. Waiting for routing instructions." color="var(--amber)" />
                 <button className="btn btn-amber" onClick={() => setShowSetup(true)}>Set Destination & Dispatch →</button>
               </div>
            )}

            {botStatus === 'in_transit' && !amRecip && <StatusMsg icon="⟶" text="En route to destination..." color="var(--amber)" />}

            {/* ── RECIPIENT OTP PANEL ─────────────────────────────────────────
                Show as soon as the package is in transit so Yatin has the code
                ready. Stays visible until the bot returns home. */}
            {amRecip && delivery?.passcode && isAfterOrEqual(botStatus, 'in_transit') && botStatus !== 'idle' && (
              <div style={{
                padding: 20,
                background: '#0a0a0a',
                border: '2px solid var(--amber)',
                borderRadius: 4,
              }}>
                <span className="label" style={{ display: 'block', marginBottom: 8 }}>
                  📦 Your Collection OTP — enter this on the keypad
                </span>
                <div style={{ ...M, fontSize: 40, color: 'var(--amber)', letterSpacing: 12, marginTop: 8, fontWeight: 700 }}>
                  {delivery.passcode}
                </div>
                <div style={{ ...M, fontSize: 10, color: 'var(--muted)', marginTop: 8 }}>
                  {botStatus === 'at_delivery'
                    ? '⚡ Bot is at your station. Enter code on the physical keypad.'
                    : 'Bot is on its way. Get ready.'}
                </div>
              </div>
            )}
          </div>

          {/* Log */}
          <div className="card" style={{ padding: 16 }}>
            <span className="label" style={{ display: 'block', marginBottom: 10 }}>System Log</span>
            <div style={{ maxHeight: 120, overflowY: 'auto', ...M, fontSize: 10 }}>
              {log.map((m, i) => <div key={i} style={{ color: i === 0 ? 'var(--text)' : 'var(--muted)', marginBottom: 2 }}>{m}</div>)}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 16 }}>
            <span className="label" style={{ display: 'block', marginBottom: 12 }}>Live Map</span>
            <GridMap locations={locations} botX={botState?.current_x ?? 0} botY={botState?.current_y ?? 0} />
          </div>
          <div className="card" style={{ padding: 16 }}>
            <span className="label" style={{ display: 'block', marginBottom: 8 }}>Stations</span>
            {locations.map(l => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '4px 0' }}>
                <span style={{ color: l.is_home ? 'var(--amber)' : 'var(--text)' }}>{l.label}</span>
                <span style={{ color: 'var(--muted)' }}>({l.x},{l.y})</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Dispatch Modal */}
      {showSetup && (
        <div className="modal-overlay">
          <div className="modal">
            <h2 style={{ ...M, fontSize: 18, marginBottom: 20 }}>Dispatch Silicon Sentinel</h2>
            <div style={{ marginBottom: 12 }}>
              <span className="label">Send To</span>
              <select className="select" value={recipientId} onChange={e => setRecipient(e.target.value)}>
                <option value="">Select Recipient</option>
                {others.map(p => <option key={p.id} value={p.id}>{p.name} ({p.location?.label})</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 12 }}>
              <span className="label">Station</span>
              <select className="select" value={destId} onChange={e => setDest(e.target.value)}>
                <option value="">Select Station</option>
                {locations.filter(l => !l.is_home).map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 20 }}>
              <span className="label">Passcode (Recipient must enter this)</span>
              <input className="input" type="text" maxLength={4} value={passcode} onChange={e => setPasscode(e.target.value.replace(/\D/g, ''))} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={() => setShowSetup(false)} style={{ flex: 1 }}>Cancel</button>
              <button className="btn btn-amber" onClick={startDelivery} style={{ flex: 2 }}>Confirm Dispatch</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}