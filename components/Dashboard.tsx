'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Location, Profile, Delivery, BotState } from '@/lib/types'

const PREFIX = process.env.NEXT_PUBLIC_MQTT_TOPIC_PREFIX ?? 'mbot_epp_2025'
const TOPICS = {
  command: `${PREFIX}/command`,
  status:  `${PREFIX}/status`,
}

// ── Status labels ─────────────────────────────────────────
const STATUS_LABEL: Record<string, string> = {
  idle:             'Idle at home base',
  going_pickup:     'Navigating to pickup…',
  at_pickup:        'At pickup — awaiting load details',
  in_transit:       'Delivering…',
  at_delivery:      'At delivery — awaiting passcode',
  returning:        'Returning to base…',
}

interface Props {
  userId:          string
  profile:         Profile & { location?: Location } | null
  locations:       Location[]
  allProfiles:     (Profile & { location?: Location })[]
  initialDelivery: Delivery | null
  initialBotState: BotState | null
}

export default function Dashboard({
  userId, profile, locations, allProfiles,
  initialDelivery, initialBotState
}: Props) {
  const router    = useRouter()
  const supabase  = createClient()
  const mqttRef   = useRef<import('mqtt').MqttClient | null>(null)

  const [mqttOk,    setMqttOk]    = useState(false)
  const [delivery,  setDelivery]  = useState<Delivery | null>(initialDelivery)
  const [botState,  setBotState]  = useState<BotState | null>(initialBotState)
  const [toast,     setToast]     = useState<string | null>(null)
  const [log,       setLog]       = useState<string[]>([])

  // Delivery-setup modal (shown to sender after bot arrives at pickup)
  const [showSetup,   setShowSetup]   = useState(false)
  const [destId,      setDestId]      = useState('')
  const [passcode,    setPasscode]    = useState('')

  // Passcode display modal (shown to recipient)
  const [showPasscode, setShowPasscode] = useState(false)
  const [myPasscode,   setMyPasscode]   = useState('')

  const myLocation   = profile?.location
  const botStatus    = botState?.status ?? 'idle'
  const amSender     = delivery?.sender_id    === userId
  const amRecipient  = delivery?.recipient_id === userId

  // ── Helpers ───────────────────────────────────────────
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false })
    setLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 50))
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }, [])

  function publish(obj: object) {
    mqttRef.current?.publish(TOPICS.command, JSON.stringify(obj), { qos: 1 })
  }

  // ── MQTT ─────────────────────────────────────────────
  useEffect(() => {
    let mounted = true
    import('mqtt').then(({ connect }) => {
      if (!mounted) return
      const client = connect(process.env.NEXT_PUBLIC_MQTT_BROKER_WSS!, {
        clientId: `mbot_web_${Math.random().toString(16).slice(2, 8)}`,
        username: process.env.NEXT_PUBLIC_MQTT_USERNAME,
        password: process.env.NEXT_PUBLIC_MQTT_PASSWORD,
        reconnectPeriod: 3000,
      })
      mqttRef.current = client

      client.on('connect', () => {
        setMqttOk(true)
        client.subscribe(TOPICS.status)
        addLog('MQTT connected')
      })
      client.on('disconnect', () => { setMqttOk(false); addLog('MQTT disconnected') })
      client.on('error',      () => setMqttOk(false))
      client.on('message', (_topic: string, payload: Buffer) => {
        try {
          const data = JSON.parse(payload.toString()) as { event: string }
          handleEvent(data.event)
        } catch {}
      })
    })
    return () => {
      mounted = false
      mqttRef.current?.end(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Supabase Realtime ─────────────────────────────────
  useEffect(() => {
    const ch = supabase
      .channel('rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' },
        ({ new: row }) => setDelivery(row as Delivery))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_state' },
        ({ new: row }) => setBotState(row as BotState))
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── MQTT event handler ────────────────────────────────
  async function handleEvent(event: string) {
    addLog(`Event: ${event}`)

    if (event === 'arrived_pickup') {
      // Bot arrived at sender's location
      await updateDelivery({ status: 'at_pickup' })
      await updateBot({ status: 'at_pickup' })
      // Show setup modal to sender only
      if (amSender) {
        setShowSetup(true)
        showToast('Bot has arrived at your location')
      }
    }

    if (event === 'arrived_delivery') {
      // Bot arrived at delivery station
      await updateDelivery({ status: 'at_delivery' })
      await updateBot({ status: 'at_delivery' })
      // Show passcode to recipient
      if (amRecipient) {
        setShowPasscode(true)
        showToast('Bot has arrived — check your passcode')
      }
      if (amSender) {
        showToast('Bot arrived at destination — waiting for recipient')
      }
    }

    if (event === 'arrived_home') {
      await updateBot({ status: 'idle', current_x: 0, current_y: 0, delivery_id: null })
      if (delivery?.id) {
        await supabase.from('deliveries').update({ status: 'idle' }).eq('id', delivery.id)
      }
      setDelivery(null)
      setShowPasscode(false)
      showToast('Bot returned to home base')
    }
  }

  // ── DB helpers ────────────────────────────────────────
  async function updateDelivery(patch: Partial<Delivery>) {
    if (!delivery?.id) return
    await supabase.from('deliveries').update(patch).eq('id', delivery.id)
  }

  async function updateBot(patch: Partial<BotState>) {
    await supabase.from('bot_state').update(patch).eq('id', 1)
  }

  // ── Actions ───────────────────────────────────────────
  async function callBot() {
    if (!myLocation) return showToast('Your location is not set in your profile')

    const { data: newDel } = await supabase
      .from('deliveries')
      .insert({ status: 'going_pickup', sender_id: userId, pickup_location_id: myLocation.id })
      .select().single()

    if (newDel) {
      setDelivery(newDel as Delivery)
      await updateBot({ status: 'going_pickup', delivery_id: newDel.id })
    }

    publish({ action: 'call', pickup: myLocation.id })
    addLog(`Calling bot to ${myLocation.label}`)
    showToast(`Bot on its way to ${myLocation.label}…`)
  }

  async function confirmDelivery() {
    if (!destId)                       return showToast('Select a destination')
    if (passcode.length !== 4)         return showToast('Enter a 4-digit passcode')
    if (!/^\d{4}$/.test(passcode))    return showToast('Passcode must be 4 digits')

    const recipient = allProfiles.find(p => p.location_id === destId)

    await updateDelivery({
      status: 'in_transit',
      recipient_id: recipient?.id ?? null,
      delivery_location_id: destId,
      passcode,
    })
    await updateBot({ status: 'in_transit' })

    // Tell mbot to go to delivery location
    publish({ action: 'deliver', delivery: destId })

    // Show passcode to recipient via Supabase Realtime
    // (recipient's screen polls their delivery row which now has the passcode)
    if (recipient) {
      // The recipient will see it because their delivery row is updated above
      // They check: amRecipient && delivery?.passcode
    }

    setShowSetup(false)
    addLog(`Dispatching to ${destId} — passcode set`)
    showToast('Package dispatched!')
  }

  async function confirmPasscode() {
    // Simulates pressing the correct passcode on the physical keypad
    // In production this comes from the mbot keypad via Serial → R4 → MQTT
    publish({ action: 'passcode_ok' })
    setShowPasscode(false)
    await updateDelivery({ status: 'returning' })
    await updateBot({ status: 'returning' })
    showToast('Passcode accepted — bot returning home in 3s…')
    addLog('Passcode confirmed — bot will return home')
  }

  async function logout() {
    await supabase.auth.signOut()
    router.push('/')
  }

  const nonHomeLocs   = locations.filter(l => !l.is_home)
  const otherLocs     = nonHomeLocs.filter(l => l.id !== myLocation?.id)

  // ── Render ────────────────────────────────────────────
  return (
    <div style={{ minHeight:'100vh', padding:'24px', maxWidth:'900px', margin:'0 auto' }}>

      {/* Top bar */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'28px' }}>
        <div>
          <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--amber)', letterSpacing:'0.2em', textTransform:'uppercase', marginBottom:'4px' }}>
            ◆ AILN — mbot Delivery
          </div>
          <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'18px', fontWeight:300 }}>
            {profile?.name || 'Operator'}
            <span style={{ fontSize:'11px', color:'var(--muted)', marginLeft:'12px' }}>
              @ {myLocation?.label || 'No location set'}
            </span>
          </div>
        </div>
        <div style={{ display:'flex', gap:'16px', alignItems:'center' }}>
          <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
            <span className={`status-dot ${mqttOk ? 'dot-green' : 'dot-red'}`} />
            <span style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--muted)' }}>
              {mqttOk ? 'MQTT LIVE' : 'MQTT OFF'}
            </span>
          </div>
          <button className="btn" onClick={logout} style={{ fontSize:'11px', padding:'6px 14px' }}>Logout</button>
        </div>
      </div>

      {/* Status card */}
      <div className="card" style={{ padding:'20px', marginBottom:'16px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span className="label">Bot status</span>
          <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
            <span className={`status-dot ${
              botStatus === 'idle'       ? 'dot-gray'  :
              botStatus === 'at_pickup' || botStatus === 'at_delivery' ? 'dot-green' :
              'dot-amber'
            }`} />
            <span style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'12px', color:'var(--text)' }}>
              {STATUS_LABEL[botStatus] || botStatus}
            </span>
          </div>
        </div>

        {delivery && (
          <div style={{ marginTop:'14px', display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'10px' }}>
            {[
              { label:'From', val: locations.find(l => l.id === delivery.pickup_location_id)?.label || '—' },
              { label:'To',   val: locations.find(l => l.id === delivery.delivery_location_id)?.label || '—' },
              { label:'Passcode', val: amRecipient ? (delivery.passcode || '—') : '****' },
            ].map(({ label, val }) => (
              <div key={label} style={{ background:'#0a0a0a', border:'1px solid var(--border)', borderRadius:'2px', padding:'8px 10px' }}>
                <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'9px', color:'var(--muted)', textTransform:'uppercase', letterSpacing:'0.1em' }}>{label}</div>
                <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'12px', color:'var(--text)', marginTop:'3px' }}>{val}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action panel */}
      <div className="card" style={{ padding:'20px', marginBottom:'16px' }}>
        <span className="label" style={{ display:'block', marginBottom:'14px' }}>Actions</span>

        {/* IDLE → call bot */}
        {botStatus === 'idle' && (
          <div>
            <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--muted)', marginBottom:'12px', lineHeight:1.6 }}>
              Bot is at home base. Call it to your location to start a delivery.
            </p>
            <button className="btn btn-amber" onClick={callBot}>
              ↗ Call Bot to {myLocation?.label || 'my location'}
            </button>
          </div>
        )}

        {/* Navigating to pickup */}
        {botStatus === 'going_pickup' && amSender && (
          <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--amber)', lineHeight:1.6 }}>
            ⟳ Bot is navigating to {myLocation?.label}…
          </p>
        )}

        {/* At pickup — sender needs to set destination */}
        {botStatus === 'at_pickup' && amSender && (
          <div>
            <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--green)', marginBottom:'12px', lineHeight:1.6 }}>
              ✓ Bot arrived. Place your load, then set delivery details.
            </p>
            <button className="btn btn-amber" onClick={() => setShowSetup(true)}>
              Set Destination & Passcode →
            </button>
          </div>
        )}

        {/* In transit */}
        {botStatus === 'in_transit' && (
          <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--amber)', lineHeight:1.6 }}>
            ⟶ Bot is delivering to {locations.find(l => l.id === delivery?.delivery_location_id)?.label || '…'}
          </p>
        )}

        {/* In transit — recipient sees passcode */}
        {botStatus === 'in_transit' && amRecipient && delivery?.passcode && (
          <div style={{ marginTop:'16px', background:'rgba(245,158,11,0.08)', border:'1px solid rgba(245,158,11,0.3)', borderRadius:'2px', padding:'16px', textAlign:'center' }}>
            <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--muted)', marginBottom:'6px' }}>YOUR INCOMING PASSCODE</div>
            <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'44px', fontWeight:700, color:'var(--amber)', letterSpacing:'14px' }}>
              {delivery.passcode}
            </div>
            <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--muted)', marginTop:'6px' }}>Enter this when the bot arrives</div>
          </div>
        )}

        {/* At delivery — recipient confirms */}
        {botStatus === 'at_delivery' && amRecipient && (
          <div>
            <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--green)', marginBottom:'12px', lineHeight:1.6 }}>
              ✓ Bot has arrived with your package.
            </p>
            {delivery?.passcode && (
              <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'36px', fontWeight:700, color:'var(--amber)', letterSpacing:'12px', marginBottom:'14px' }}>
                {delivery.passcode}
              </div>
            )}
            <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--muted)', marginBottom:'12px' }}>
              Enter the code on the bot keypad. Or click below to simulate confirmation:
            </p>
            <button className="btn btn-amber" onClick={confirmPasscode}>
              ✓ Confirm Passcode (simulate keypad)
            </button>
          </div>
        )}

        {/* Returning */}
        {botStatus === 'returning' && (
          <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--amber)', lineHeight:1.6 }}>
            ⟵ Bot returning to home base…
          </p>
        )}
      </div>

      {/* Event log */}
      <div className="card" style={{ padding:'16px' }}>
        <span className="label" style={{ display:'block', marginBottom:'10px' }}>Event Log</span>
        <div style={{ maxHeight:'120px', overflowY:'auto' }}>
          {log.length === 0
            ? <span style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--muted)' }}>No events yet</span>
            : log.map((l, i) => (
              <div key={i} style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:i===0?'var(--text)':'var(--muted)', padding:'2px 0' }}>{l}</div>
            ))
          }
        </div>
      </div>

      {/* ── SETUP MODAL ────────────────────────────────── */}
      {showSetup && (
        <div className="modal-overlay" onClick={() => setShowSetup(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--amber)', letterSpacing:'0.15em', marginBottom:'8px' }}>◆ LOAD RECEIVED</div>
            <h2 style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'18px', fontWeight:300, marginBottom:'20px' }}>Where would you like to send this?</h2>

            <div style={{ marginBottom:'14px' }}>
              <span className="label">Destination</span>
              <select className="select" value={destId} onChange={e => setDestId(e.target.value)}>
                <option value="">— select destination —</option>
                {otherLocs.map(l => (
                  <option key={l.id} value={l.id}>{l.label} ({l.x},{l.y})</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom:'24px' }}>
              <span className="label">Set Passcode (4 digits)</span>
              <input
                className="input"
                type="text"
                maxLength={4}
                placeholder="e.g. 7432"
                value={passcode}
                onChange={e => setPasscode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                style={{ letterSpacing:'0.4em', fontSize:'22px', textAlign:'center' }}
              />
              <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--muted)', marginTop:'6px' }}>
                Recipient at the destination will see this privately
              </div>
            </div>

            <div style={{ display:'flex', gap:'10px' }}>
              <button className="btn" onClick={() => setShowSetup(false)}>Cancel</button>
              <button className="btn btn-amber" onClick={confirmDelivery} style={{ flex:1 }}>
                Dispatch →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position:'fixed', bottom:'24px', left:'50%', transform:'translateX(-50%)',
          background:'var(--surface)', border:'1px solid var(--amber)', borderRadius:'2px',
          padding:'12px 20px', fontFamily:'JetBrains Mono, monospace', fontSize:'12px',
          color:'var(--amber)', zIndex:999, whiteSpace:'nowrap', letterSpacing:'0.05em',
          boxShadow:'0 4px 24px rgba(0,0,0,0.5)',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}