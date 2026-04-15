'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Location, Profile, Delivery, BotState } from '@/lib/types'

const PREFIX = process.env.NEXT_PUBLIC_MQTT_TOPIC_PREFIX ?? 'mbot_epp_2025'
const TOPIC_CMD    = `${PREFIX}/command`
const TOPIC_STATUS = `${PREFIX}/status`

interface Props {
  userId:          string
  profile:         (Profile & { location?: Location }) | null
  locations:       Location[]
  allProfiles:     (Profile & { location?: Location })[]
  initialDelivery: Delivery | null
  initialBotState: BotState | null
}

export default function Dashboard({
  userId, profile, locations, allProfiles,
  initialDelivery, initialBotState
}: Props) {
  const router   = useRouter()
  const supabase = createClient()
  const mqtt     = useRef<import('mqtt').MqttClient | null>(null)

  const [mqttOk,   setMqttOk]   = useState(false)
  const [delivery, setDelivery] = useState<Delivery | null>(initialDelivery)
  const [botState, setBotState] = useState<BotState | null>(initialBotState)
  const [toast,    setToast]    = useState<string | null>(null)
  const [log,      setLog]      = useState<string[]>([])

  // Sender popup — shown after bot arrives at pickup
  const [showDispatch, setShowDispatch] = useState(false)
  const [destId,       setDestId]       = useState('')
  const [passcode,     setPasscode]     = useState('')

  const myLoc        = profile?.location
  const botStatus    = botState?.status ?? 'idle'
  const amSender     = delivery?.sender_id    === userId
  const amRecipient  = delivery?.recipient_id === userId

  // ── helpers ───────────────────────────────────────────
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false })
    setLog(p => [`[${ts}] ${msg}`, ...p].slice(0, 60))
  }, [])

  const toast_ = useCallback((msg: string) => {
    setToast(msg); setTimeout(() => setToast(null), 4000)
  }, [])

  function publish(obj: object) {
    mqtt.current?.publish(TOPIC_CMD, JSON.stringify(obj), { qos: 1 })
    addLog('→ ' + JSON.stringify(obj))
  }

  // ── MQTT ─────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    import('mqtt').then(({ connect }) => {
      if (!alive) return
      const c = connect(process.env.NEXT_PUBLIC_MQTT_BROKER_WSS!, {
        clientId: `web_${Math.random().toString(16).slice(2, 8)}`,
        username: process.env.NEXT_PUBLIC_MQTT_USERNAME,
        password: process.env.NEXT_PUBLIC_MQTT_PASSWORD,
        reconnectPeriod: 3000,
      })
      mqtt.current = c
      c.on('connect', () => {
        setMqttOk(true)
        c.subscribe(TOPIC_STATUS)
        addLog('MQTT connected')
      })
      c.on('error',      () => setMqttOk(false))
      c.on('disconnect', () => setMqttOk(false))
      c.on('message', (_t: string, buf: Buffer) => {
        try { onEvent(JSON.parse(buf.toString())) } catch {}
      })
    })
    return () => { alive = false; mqtt.current?.end(true) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Supabase realtime ────────────────────────────────
  useEffect(() => {
    const ch = supabase
      .channel('rt')
      .on('postgres_changes', { event:'*', schema:'public', table:'deliveries' },
        ({ new: r }) => setDelivery(r as Delivery))
      .on('postgres_changes', { event:'*', schema:'public', table:'bot_state' },
        ({ new: r }) => setBotState(r as BotState))
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── MQTT event handler ────────────────────────────────
  // We use the delivery STATUS stored in Supabase to know what
  // phase we're in when arrived_location fires.
  async function onEvent(data: { event: string }) {
    const { event } = data
    addLog('← ' + event)

    if (event === 'arrived_location') {
      // Fetch fresh delivery so we have latest status
      const { data: fresh } = await supabase
        .from('deliveries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const status = fresh?.status ?? delivery?.status

      if (status === 'going_pickup') {
        // Bot just arrived at sender's location
        await supabase.from('deliveries').update({ status: 'at_pickup' })
          .eq('id', fresh?.id ?? delivery?.id ?? '')
        await supabase.from('bot_state').update({ status: 'at_pickup' }).eq('id', 1)
        if (fresh) setDelivery(fresh as Delivery)
        // Show dispatch popup to sender
        if (amSender || fresh?.sender_id === userId) {
          setShowDispatch(true)
          toast_('Bot arrived at your location — set delivery details')
        }
      }
      else if (status === 'in_transit') {
        // Bot arrived at delivery destination
        await supabase.from('deliveries').update({ status: 'at_delivery' })
          .eq('id', fresh?.id ?? delivery?.id ?? '')
        await supabase.from('bot_state').update({ status: 'at_delivery' }).eq('id', 1)
        if (fresh) setDelivery(fresh as Delivery)
        if (amRecipient || fresh?.recipient_id === userId) {
          toast_('Bot has arrived! Check your passcode below')
        }
        if (amSender || fresh?.sender_id === userId) {
          toast_('Bot arrived at destination — waiting for recipient')
        }
      }
    }

    if (event === 'arrived_home') {
      await supabase.from('bot_state').update({ status:'idle', delivery_id:null }).eq('id', 1)
      if (delivery?.id) {
        await supabase.from('deliveries').update({ status:'idle' }).eq('id', delivery.id)
      }
      setDelivery(null)
      toast_('Bot returned to home base')
    }
  }

  // ── Actions ───────────────────────────────────────────
  async function callBot() {
    if (!myLoc) return toast_('Your location is not set — contact admin')

    const { data: del } = await supabase
      .from('deliveries')
      .insert({ status: 'going_pickup', sender_id: userId, pickup_location_id: myLoc.id })
      .select().single()

    if (del) {
      setDelivery(del as Delivery)
      await supabase.from('bot_state').update({ status:'going_pickup', delivery_id:del.id }).eq('id', 1)
    }

    publish({ action: 'call', pickup: myLoc.id })
    toast_(`Bot on its way to ${myLoc.label}`)
  }

  async function dispatchBot() {
    if (!destId)                    return toast_('Pick a destination')
    if (!/^\d{4}$/.test(passcode))  return toast_('Passcode must be 4 digits')
    if (!delivery?.id)              return toast_('No active delivery')

    // Find the user whose home station matches the destination
    const recipient = allProfiles.find(p => p.location_id === destId)

    await supabase.from('deliveries').update({
      status:               'in_transit',
      delivery_location_id: destId,
      passcode,
      recipient_id:         recipient?.id ?? null,
    }).eq('id', delivery.id)

    await supabase.from('bot_state').update({ status: 'in_transit' }).eq('id', 1)

    publish({ action: 'deliver', delivery: destId })
    setShowDispatch(false)
    toast_('Package dispatched!')
  }

  async function confirmDelivery() {
    // Recipient confirms collection — bot goes home
    publish({ action: 'return_home' })
    if (delivery?.id) {
      await supabase.from('deliveries').update({ status: 'returning' }).eq('id', delivery.id)
    }
    await supabase.from('bot_state').update({ status: 'returning' }).eq('id', 1)
    toast_('Package collected — bot returning home')
  }

  async function logout() {
    await supabase.auth.signOut(); router.push('/')
  }

  const dispatchableLocs = locations.filter(l => !l.is_home && l.id !== myLoc?.id)

  // ── UI ────────────────────────────────────────────────
  return (
    <div style={{ minHeight:'100vh', padding:'24px', maxWidth:'860px', margin:'0 auto' }}>

      {/* Top bar */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'28px' }}>
        <div>
          <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--amber)', letterSpacing:'0.2em', textTransform:'uppercase' }}>
            ◆ AILN — mbot Delivery
          </div>
          <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'18px', fontWeight:300, marginTop:'4px' }}>
            {profile?.name || 'Operator'}
            <span style={{ fontSize:'11px', color:'var(--muted)', marginLeft:'12px' }}>
              @ {myLoc?.label || 'No location set'}
            </span>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:'16px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
            <span className={`status-dot ${mqttOk ? 'dot-green' : 'dot-red'}`} />
            <span style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--muted)' }}>
              {mqttOk ? 'MQTT LIVE' : 'MQTT OFF'}
            </span>
          </div>
          <button className="btn" style={{ fontSize:'11px', padding:'6px 14px' }} onClick={logout}>Logout</button>
        </div>
      </div>

      {/* Bot status */}
      <div className="card" style={{ padding:'20px', marginBottom:'16px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: delivery ? '14px' : 0 }}>
          <span className="label">Bot status</span>
          <span style={{
            fontFamily:'JetBrains Mono, monospace', fontSize:'12px',
            color: botStatus === 'idle' ? 'var(--muted)' :
                   (botStatus === 'at_pickup' || botStatus === 'at_delivery') ? 'var(--green)' : 'var(--amber)'
          }}>
            {{
              idle:         '● Idle at home base',
              going_pickup: '⟳ Navigating to pickup…',
              at_pickup:    '✓ At pickup',
              in_transit:   '⟶ Delivering…',
              at_delivery:  '✓ At delivery',
              returning:    '⟵ Returning home…',
            }[botStatus] || botStatus}
          </span>
        </div>

        {delivery && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'10px' }}>
            {[
              { label:'From', val: locations.find(l => l.id === delivery.pickup_location_id)?.label || '—' },
              { label:'To',   val: locations.find(l => l.id === delivery.delivery_location_id)?.label || '—' },
              { label:'Passcode', val: amRecipient ? (delivery.passcode || '—') : (delivery.passcode ? '✦ ✦ ✦ ✦' : '—') },
            ].map(({ label, val }) => (
              <div key={label} style={{ background:'#0a0a0a', border:'1px solid var(--border)', borderRadius:'2px', padding:'8px 10px' }}>
                <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'9px', color:'var(--muted)', textTransform:'uppercase', letterSpacing:'0.1em' }}>{label}</div>
                <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:label==='Passcode'?'18px':'12px', color: label==='Passcode' && amRecipient ? 'var(--amber)' : 'var(--text)', marginTop:'3px', letterSpacing: label==='Passcode' ? '4px' : 'normal' }}>{val}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action panel */}
      <div className="card" style={{ padding:'20px', marginBottom:'16px' }}>
        <span className="label" style={{ display:'block', marginBottom:'14px' }}>Actions</span>

        {botStatus === 'idle' && (
          <>
            <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--muted)', marginBottom:'12px', lineHeight:1.6 }}>
              Bot is at home base (0,0). Call it to your location.
            </p>
            <button className="btn btn-amber" onClick={callBot}>
              ↗ Call Bot to {myLoc?.label ?? 'my location'}
            </button>
          </>
        )}

        {botStatus === 'going_pickup' && amSender && (
          <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--amber)', lineHeight:1.6 }}>
            ⟳ Bot is navigating to {myLoc?.label}…
          </p>
        )}

        {botStatus === 'at_pickup' && amSender && (
          <>
            <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--green)', marginBottom:'12px' }}>
              ✓ Bot arrived at your station.
            </p>
            <button className="btn btn-amber" onClick={() => setShowDispatch(true)}>
              Set Destination & Passcode →
            </button>
          </>
        )}

        {botStatus === 'in_transit' && amSender && (
          <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--amber)', lineHeight:1.6 }}>
            ⟶ Bot delivering to {locations.find(l => l.id === delivery?.delivery_location_id)?.label ?? '…'}
          </p>
        )}

        {(botStatus === 'in_transit' || botStatus === 'at_delivery') && amRecipient && delivery?.passcode && (
          <div style={{ marginBottom:'16px' }}>
            <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--muted)', marginBottom:'8px' }}>YOUR PASSCODE — show this to enter on the bot:</div>
            <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'52px', fontWeight:700, color:'var(--amber)', letterSpacing:'16px' }}>
              {delivery.passcode}
            </div>
          </div>
        )}

        {botStatus === 'at_delivery' && amRecipient && (
          <>
            <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--green)', marginBottom:'12px' }}>
              ✓ Bot has arrived with your package. Enter the passcode shown above.
            </p>
            <button className="btn btn-amber" onClick={confirmDelivery}>
              ✓ Passcode Confirmed — Collect Package
            </button>
          </>
        )}

        {botStatus === 'returning' && (
          <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--amber)', lineHeight:1.6 }}>
            ⟵ Bot returning to home base…
          </p>
        )}
      </div>

      {/* Event log */}
      <div className="card" style={{ padding:'16px' }}>
        <span className="label" style={{ display:'block', marginBottom:'8px' }}>Event Log</span>
        <div style={{ maxHeight:'130px', overflowY:'auto' }}>
          {log.length === 0
            ? <span style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'11px', color:'var(--muted)' }}>Waiting…</span>
            : log.map((l, i) => (
              <div key={i} style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color: i===0 ? 'var(--text)' : 'var(--muted)', padding:'2px 0' }}>{l}</div>
            ))
          }
        </div>
      </div>

      {/* ── DISPATCH MODAL ─────────────────────────────── */}
      {showDispatch && (
        <div className="modal-overlay" onClick={() => setShowDispatch(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--amber)', letterSpacing:'0.15em', marginBottom:'8px' }}>
              ◆ BOT ARRIVED
            </div>
            <h2 style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'18px', fontWeight:300, marginBottom:'6px' }}>
              Where should this go?
            </h2>
            <p style={{ fontFamily:'JetBrains Mono, monospace', fontSize:'10px', color:'var(--muted)', marginBottom:'20px' }}>
              Set the destination and a 4-digit passcode. The recipient will see the passcode on their screen.
            </p>

            <div style={{ marginBottom:'14px' }}>
              <span className="label">Destination</span>
              <select className="select" value={destId} onChange={e => setDestId(e.target.value)}>
                <option value="">— select —</option>
                {dispatchableLocs.map(l => (
                  <option key={l.id} value={l.id}>{l.label} ({l.x},{l.y})</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom:'24px' }}>
              <span className="label">Passcode (4 digits)</span>
              <input
                className="input"
                type="text"
                maxLength={4}
                placeholder="e.g. 1245"
                value={passcode}
                onChange={e => setPasscode(e.target.value.replace(/\D/g,'').slice(0,4))}
                style={{ letterSpacing:'0.5em', fontSize:'24px', textAlign:'center' }}
                autoFocus
              />
            </div>

            <div style={{ display:'flex', gap:'10px' }}>
              <button className="btn" onClick={() => setShowDispatch(false)}>Cancel</button>
              <button className="btn btn-amber" onClick={dispatchBot} style={{ flex:1 }}>
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
          color:'var(--amber)', zIndex:999, whiteSpace:'nowrap', boxShadow:'0 4px 24px rgba(0,0,0,0.5)',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}