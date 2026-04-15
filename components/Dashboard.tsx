'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { TOPICS, publishCommand } from '@/lib/mqtt'
import type { MqttClient } from 'mqtt'
import type { Location, Profile, Delivery, BotState } from '@/lib/types'

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

  const [delivery, setDelivery]       = useState<Delivery | null>(initialDelivery)
  const [botState, setBotState]       = useState<BotState | null>(initialBotState)
  const [mqttOk, setMqttOk]           = useState(false)
  const [toast, setToast]             = useState<string | null>(null)
  const [log, setLog]                 = useState<string[]>([])
  const [showSetup, setShowSetup]     = useState(false)   // sender dispatch modal
  const [showOtpModal, setShowOtpModal]     = useState(false)
  const [recipientInput, setRecipientInput] = useState('')
  const [recipientAttempts, setRecipientAttempts] = useState(0)
  const [recipientLocked, setRecipientLocked]     = useState(false)
  const [otpSubmitted, setOtpSubmitted]           = useState(false) // prevents poll re-opening modal after correct entry
  const [recipientId, setRecipient]   = useState('')
  const [destId, setDest]             = useState('')
  const [passcode, setPasscode]       = useState('')
  const [callError, setCallError]     = useState<string | null>(null)
  const [calling, setCalling]         = useState(false)

  // Refs for stable access inside MQTT/realtime callbacks (avoids stale closures)
  const deliveryRef  = useRef<Delivery | null>(initialDelivery)
  const botStateRef  = useRef<BotState | null>(initialBotState)
  const handleEventRef = useRef<(event: string) => void>(() => {})

  useEffect(() => { deliveryRef.current  = delivery  }, [delivery])
  useEffect(() => { botStateRef.current  = botState  }, [botState])

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false })
    setLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 40))
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg); setTimeout(() => setToast(null), 5000)
  }, [])

  const myLoc    = profile?.location
  const amSender = delivery?.sender_id    === userId
  const amRecip  = delivery?.recipient_id === userId
  const botStatus = botState?.status || 'idle'
  const botIdle   = botStatus === 'idle' || !delivery
  const others    = allProfiles.filter(p => p.id !== userId)

  // Auto-show OTP modal for recipient when delivery is dispatched their way
  useEffect(() => {
    if (!otpSubmitted && amRecip && delivery?.passcode && ['in_transit', 'at_delivery'].includes(botStatus)) {
      setShowOtpModal(true)
    }
    if (['returning', 'delivered', 'idle'].includes(botStatus)) {
      setShowOtpModal(false)
      setOtpSubmitted(false)
    }
  }, [amRecip, delivery?.passcode, botStatus, otpSubmitted])

  // ── MQTT ─────────────────────────────────────────────────────────────────
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

      c.on('connect', () => { setMqttOk(true); c.subscribe(TOPICS.status); addLog('MQTT connected') })
      c.on('disconnect', () => setMqttOk(false))

      // KEY FIX: call via ref so we always get the latest handleEvent, not the
      // stale closure captured at mount time.
      c.on('message', (_t: string, payload: Buffer) => {
        try {
          const { event } = JSON.parse(payload.toString())
          handleEventRef.current(event)
        } catch {}
      })
    })
    return () => { mounted = false }
  }, [])

  // ── Supabase Realtime ─────────────────────────────────────────────────────
  useEffect(() => {
    const ch = supabase.channel('rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, ({ new: r }) => {
        const d = r as Delivery
        if (d.sender_id !== userId && d.recipient_id !== userId) return

        setDelivery(d)
        deliveryRef.current = d
        addLog(`DB: delivery → ${d.status}`)

        // ── MODAL TRIGGERS FROM DB STATE (reliable, not MQTT-dependent) ──────
        // Sender: show dispatch modal when load is secured
        if (d.sender_id === userId && d.status === 'loading') {
          setShowSetup(true)
        }
        // Recipient: show OTP modal when bot arrives at their station
        if (d.recipient_id === userId && d.passcode &&
            ['in_transit', 'at_delivery'].includes(d.status)) {
          setShowOtpModal(true)
          // Reset input state when a fresh delivery arrives
          if (d.status === 'in_transit') {
            setRecipientInput('')
            setRecipientAttempts(0)
            setRecipientLocked(false)
          }
        }
        // Clean up modals when delivery is done
        if (['idle', 'returning', 'delivered'].includes(d.status)) {
          setShowSetup(false)
          setShowOtpModal(false)
          setOtpSubmitted(false)
          setDest('')
          setRecipient('')
          setPasscode('')
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_state' }, ({ new: r }) => {
        setBotState(r as BotState)
        botStateRef.current = r as BotState
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [userId])

  // ── On mount: restore OTP modal if this user is already the recipient ──────
  // Handles page reload — showOtpModal starts false so we explicitly check
  // initialDelivery/initialBotState on mount without waiting for realtime.
  useEffect(() => {
    if (
      initialDelivery?.recipient_id === userId &&
      initialDelivery?.passcode &&
      initialBotState?.status &&
      ['in_transit', 'at_delivery'].includes(initialBotState.status)
    ) {
      setShowOtpModal(true)
      addLog('Restored OTP modal from initial state')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Recipient delivery poll ──────────────────────────────────────────────
  // Realtime sometimes misses the delivery assignment (RLS timing: the row is
  // created without recipient_id, then updated to add it — the initial INSERT
  // notification goes out before the recipient is set, so the client may never
  // get the UPDATE). This poll is the safety net: every 3s check if a delivery
  // has been assigned to this user as recipient.
  useEffect(() => {
    const interval = setInterval(async () => {
      // Skip if we already have an active delivery for this user as recipient
      if (deliveryRef.current?.recipient_id === userId &&
          ['in_transit','at_delivery'].includes(deliveryRef.current?.status || '')) return

      const { data } = await supabase
        .from('deliveries')
        .select('*')
        .eq('recipient_id', userId)
        .in('status', ['in_transit', 'at_delivery'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (data && data.id !== deliveryRef.current?.id) {
        setDelivery(data)
        deliveryRef.current = data
        addLog(`Poll: incoming delivery found → ${data.status}`)
        // Don't re-open if recipient already submitted correct password
        if (!otpSubmitted) {
          setShowOtpModal(true)
          setRecipientInput('')
          setRecipientAttempts(0)
          setRecipientLocked(false)
        }
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [userId])

  // ── Event handler (always current via ref) ────────────────────────────────
  const handleEvent = useCallback(async (event: string) => {
    addLog(`HW Event: ${event}`)

    const status = botStateRef.current?.status
    const del    = deliveryRef.current
    const sender = del?.sender_id

    // ── 1. ARRIVAL ───────────────────────────────────────────────────────────
    if (event === 'arrived_location') {
      if (status === 'going_pickup' && sender === userId) {
        await patchDelivery({ status: 'at_pickup' })
        await patchBot({ status: 'at_pickup' })
      } else if (status === 'in_transit' && sender === userId) {
        await patchDelivery({ status: 'at_delivery' })
        await patchBot({ status: 'at_delivery' })
      }
    }

    // ── 2. HOME ──────────────────────────────────────────────────────────────
    else if (event === 'arrived_home') {
      if (sender === userId) {
        await patchBot({ status: 'idle', current_x: 0, current_y: 0, delivery_id: null })
        // Mark delivery complete so it won't show on next login
        if (del?.id) {
          await supabase.from('deliveries').update({ status: 'idle' }).eq('id', del.id)
        }
        setDelivery(null)
        deliveryRef.current = null
      }
      showToast('✓ Bot back at base.')
    }

    // ── 3. LOAD RECEIVED ─────────────────────────────────────────────────────
    else if (event === 'load_received') {
      addLog(`load_received: status=${status} sender=${sender} userId=${userId}`)
      if (sender === userId) {
        await patchDelivery({ status: 'loading', load_detected: true })
        await patchBot({ status: 'loading' })
        // Trigger modal directly — don't wait for realtime (patchDelivery may fail silently)
        setShowSetup(true)
        showToast('✓ Load secured — set destination & passcode.')
      } else {
        addLog(`load_received SKIPPED: sender mismatch`)
      }
    }

    // ── 4. BOX OPENED (correct passcode on keypad) ───────────────────────────
    else if (event === 'box_opened') {
      if (sender === userId) {
        await patchDelivery({ status: 'delivered' })
        await patchBot({ status: 'returning' })
      }
      setShowOtpModal(false)
      showToast('✓ Passcode accepted — box opened! Bot returning.')
    }

    // ── 5. WRONG PASSCODE ────────────────────────────────────────────────────
    else if (event === 'wrong_passcode') {
      showToast('⚠ Wrong passcode entered on keypad.')
    }
    else if (event === 'wrong_passcode_locked') {
      showToast('🔒 Keypad locked — 3 wrong attempts.')
    }
  }, [userId, showToast, addLog])

  // Keep ref in sync with latest handleEvent
  useEffect(() => { handleEventRef.current = handleEvent }, [handleEvent])

  // ── DB helpers ────────────────────────────────────────────────────────────
  async function patchDelivery(patch: Partial<Delivery>) {
    const id = deliveryRef.current?.id
    if (!id) { addLog('ERR patchDelivery: no delivery id in ref'); return }
    const { data, error } = await supabase.from('deliveries').update(patch).eq('id', id).select().single()
    if (error) { addLog(`ERR patchDelivery: ${error.message} (code ${error.code})`); return }
    if (data) { setDelivery(data); deliveryRef.current = data }
  }

  async function patchBot(patch: Partial<BotState>) {
    const { error } = await supabase.from('bot_state').update(patch).eq('id', 1)
    if (error) addLog(`ERR patchBot: ${error.message}`)
  }

  // ── CALL BOT ──────────────────────────────────────────────────────────────
  async function callBot() {
    setCallError(null)

    // Bail early with a VISIBLE inline error (not just a toast)
    if (!myLoc) {
      const msg = 'Your profile has no location assigned. Check Supabase: profiles → location_id'
      setCallError(msg)
      addLog('ERROR: ' + msg)
      return
    }

    setCalling(true)
    try {
      const { data: nd, error } = await supabase
        .from('deliveries')
        .insert({ status: 'going_pickup', sender_id: userId, pickup_location_id: myLoc.id })
        .select()
        .single()

      if (error) throw error

      if (nd) {
        setDelivery(nd as Delivery)
        deliveryRef.current = nd as Delivery
        await patchBot({ status: 'going_pickup', delivery_id: nd.id })
        publishCommand({ action: 'call', pickup: myLoc.id })
        addLog(`Bot called to ${myLoc.label}`)
        showToast(`Bot en route to ${myLoc.label}`)
      }
    } catch (err: any) {
      const msg = err?.message || 'Unknown error calling bot'
      setCallError(msg)
      addLog('ERROR calling bot: ' + msg)
    } finally {
      setCalling(false)
    }
  }

  // ── DISPATCH ──────────────────────────────────────────────────────────────
  async function startDelivery() {
    if (passcode.length !== 4)    return showToast('Passcode must be exactly 4 digits')
    if (!recipientId || !destId)  return showToast('Select a recipient and destination station')

    await patchDelivery({
      status: 'in_transit',
      recipient_id: recipientId,
      delivery_location_id: destId,
      passcode,
    })
    await patchBot({ status: 'in_transit' })
    publishCommand({ action: 'deliver', delivery: destId, passcode })

    setShowSetup(false)
    setPasscode('')
    setDest('')        // reset so next delivery starts with blank dropdown
    setRecipient('')   // same
    addLog(`Dispatched to ${locations.find(l => l.id === destId)?.label}`)
    showToast('Package dispatched')
  }

  const logout = async () => {
    await supabase.auth.signOut()
    window.location.replace('/')
  }

  const M = { fontFamily: 'JetBrains Mono,monospace' }

  return (
    <div style={{ minHeight: '100vh', padding: 24, maxWidth: 1100, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ ...M, fontSize: 10, color: 'var(--amber)', textTransform: 'uppercase', marginBottom: 4 }}>◆ Terafabs Silicon Sentinel</div>
          <div style={{ ...M, fontSize: 18, fontWeight: 300 }}>
            {profile?.name || 'Operator'}
            <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 12 }}>
              ID: {userId.slice(0,5)}... @ {myLoc?.label || 'Unknown'}
            </span>
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
              <span style={{ ...M, fontSize: 11 }}>{STATUS_LABELS[botStatus] || botStatus}</span>
            </div>
            {delivery && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <InfoBox label="From" value={locations.find(l => l.id === delivery.pickup_location_id)?.label || '—'} />
                <InfoBox label="To"   value={locations.find(l => l.id === delivery.delivery_location_id)?.label || '—'} />
                <InfoBox label="Recipient" value={allProfiles.find(p => p.id === delivery.recipient_id)?.name || '—'} />
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="card" style={{ padding: 20 }}>
            <span className="label" style={{ display: 'block', marginBottom: 16 }}>Controls</span>

            {/* IDLE — sender can call the bot */}
            {botIdle && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button
                  className="btn btn-amber"
                  onClick={callBot}
                  disabled={calling || !myLoc}
                  style={{ opacity: !myLoc ? 0.5 : 1 }}
                >
                  {calling ? 'Calling bot...' : `↗ Request Bot to ${myLoc?.label || '???'}`}
                </button>
                {!myLoc && (
                  <div style={{
                    fontFamily: 'JetBrains Mono,monospace', fontSize: 10,
                    color: 'var(--red)', padding: '6px 10px',
                    border: '1px solid rgba(239,68,68,0.3)', borderRadius: 2,
                    background: 'rgba(239,68,68,0.05)',
                  }}>
                    ✕ No location set on your profile. Go to Supabase → profiles → set location_id for your user UUID.
                  </div>
                )}
                {callError && (
                  <div style={{
                    fontFamily: 'JetBrains Mono,monospace', fontSize: 10,
                    color: 'var(--red)', padding: '6px 10px',
                    border: '1px solid rgba(239,68,68,0.3)', borderRadius: 2,
                    background: 'rgba(239,68,68,0.05)',
                  }}>
                    ✕ {callError}
                  </div>
                )}
              </div>
            )}

            {/* BOT EN ROUTE TO PICKUP — waiting */}
            {botStatus === 'going_pickup' && amSender && (
              <StatusMsg icon="⟶" text={`Bot is on its way to ${myLoc?.label || 'your station'}...`} color="var(--amber)" />
            )}

            {/* AT PICKUP — loading phase */}
            {botStatus === 'at_pickup' && amSender && (
              <StatusMsg icon="⚖" text="Bot is at your station. Servo open — place the load now." color="var(--amber)" />
            )}

            {/* LOADING — show dispatch button if modal was closed */}
            {botStatus === 'loading' && amSender && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <StatusMsg icon="✓" text="Load secured. Set destination and passcode to dispatch." color="var(--amber)" />
                <button className="btn btn-amber" onClick={() => setShowSetup(true)}>
                  Set Destination & Dispatch →
                </button>
              </div>
            )}

            {/* IN TRANSIT — sender view */}
            {botStatus === 'in_transit' && amSender && !amRecip && (
              <StatusMsg icon="⟶" text="Bot en route to destination..." color="var(--amber)" />
            )}

            {/* AT DELIVERY — sender view */}
            {botStatus === 'at_delivery' && amSender && !amRecip && (
              <StatusMsg icon="📍" text="Bot arrived at destination. Awaiting keypad entry by recipient." color="var(--amber)" />
            )}

            {/* RETURNING */}
            {botStatus === 'returning' && (
              <StatusMsg icon="↩" text="Delivery complete. Bot returning to home base." color="var(--amber)" />
            )}

            {/* RECIPIENT inline reminder (after dismissing modal) */}
            {amRecip && delivery?.passcode && isAfterOrEqual(botStatus, 'in_transit') && botStatus !== 'idle' && (
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-amber" onClick={() => setShowOtpModal(true)}>
                  📦 Show My Passcode
                </button>
              </div>
            )}
          </div>

          {/* Log */}
          <div className="card" style={{ padding: 16 }}>
            <span className="label" style={{ display: 'block', marginBottom: 10 }}>System Log</span>
            <div style={{ maxHeight: 120, overflowY: 'auto', ...M, fontSize: 10 }}>
              {log.length === 0
                ? <div style={{ color: 'var(--muted)' }}>No events yet.</div>
                : log.map((m, i) => (
                    <div key={i} style={{ color: i === 0 ? 'var(--text)' : 'var(--muted)', marginBottom: 2 }}>{m}</div>
                  ))
              }
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

      {/* ── SENDER DISPATCH MODAL ─────────────────────────────────────────────── */}
      {showSetup && (
        <div className="modal-overlay">
          <div className="modal">
            <h2 style={{ ...M, fontSize: 16, marginBottom: 6 }}>Dispatch Silicon Sentinel</h2>
            <p style={{ ...M, fontSize: 10, color: 'var(--muted)', marginBottom: 20 }}>
              Load is secured. Set the destination, recipient, and a 4-digit passcode.
              The recipient will see the passcode on their screen.
            </p>

            <div style={{ marginBottom: 12 }}>
              <span className="label">Recipient</span>
              <select className="select" value={recipientId} onChange={e => setRecipient(e.target.value)}>
                <option value="">Select Recipient</option>
                {others.map(p => (
                  <option key={p.id} value={p.id}>{p.name} — {p.location?.label || 'Unknown station'}</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: 12 }}>
              <span className="label">Destination Station</span>
              <select className="select" value={destId} onChange={e => setDest(e.target.value)}>
                <option value="">Select Station</option>
                {locations.filter(l => !l.is_home).map(l => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: 20 }}>
              <span className="label">Passcode (4 digits — recipient must enter this on keypad)</span>
              <input
                className="input"
                type="text"
                maxLength={4}
                placeholder="e.g. 1234"
                value={passcode}
                onChange={e => setPasscode(e.target.value.replace(/\D/g, ''))}
              />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={() => setShowSetup(false)} style={{ flex: 1 }}>Cancel</button>
              <button className="btn btn-amber" onClick={startDelivery} style={{ flex: 2 }}>
                ↗ Confirm Dispatch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RECIPIENT PASSCODE INPUT MODAL ───────────────────────────────────── */}
      {showOtpModal && amRecip && delivery && (
        <div className="modal-overlay">
          <div className="modal" style={{ textAlign: 'center', maxWidth: 400 }}>
            <div style={{ ...M, fontSize: 10, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }}>
              📦 Incoming Delivery
            </div>
            <h2 style={{ ...M, fontSize: 15, marginBottom: 6 }}>
              {allProfiles.find(p => p.id === delivery.sender_id)?.name || 'Someone'} sent you a package
            </h2>
            <p style={{ ...M, fontSize: 10, color: 'var(--muted)', marginBottom: 20 }}>
              {botStatus === 'at_delivery'
                ? '⚡ Bot is at your station. Read the OTP from the LCD screen and enter it below.'
                : '🚚 Bot is on its way. Get ready — OTP will show on the LCD when it arrives.'}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
              <InfoBox label="From" value={allProfiles.find(p => p.id === delivery.sender_id)?.name || '—'} />
              <InfoBox label="Destination" value={locations.find(l => l.id === delivery.delivery_location_id)?.label || '—'} />
            </div>

            {recipientLocked ? (
              <div style={{
                padding: 16, background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.4)', borderRadius: 4,
                ...M, fontSize: 11, color: 'var(--red)'
              }}>
                🔒 Too many wrong attempts. Contact the sender.
              </div>
            ) : (
              <>
                <div style={{ marginBottom: 8, textAlign: 'left' }}>
                  <span className="label">Enter OTP shown on bot LCD</span>
                  <input
                    className="input"
                    type="text"
                    maxLength={4}
                    placeholder="e.g. 2222"
                    value={recipientInput}
                    onChange={e => setRecipientInput(e.target.value.replace(/\D/g, ''))}
                    style={{ fontSize: 24, letterSpacing: 8, textAlign: 'center' }}
                  />
                  <div style={{ ...M, fontSize: 10, color: botStatus === 'at_delivery' ? 'var(--amber)' : 'var(--muted)', marginTop: 4 }}>
                    {botStatus === 'at_delivery' ? '⚡ Bot is here — enter OTP from LCD' : '🚚 Bot en route — OTP will show on LCD when it arrives'}
                  </div>
                </div>

                {recipientAttempts > 0 && (
                  <div style={{ ...M, fontSize: 11, color: 'var(--red)', marginBottom: 8 }}>
                    ✕ Wrong passcode — attempt {recipientAttempts}/3
                  </div>
                )}

                <button
                  className="btn btn-amber"
                  style={{ width: '100%' }}
                  disabled={recipientInput.length !== 4}
                  onClick={async () => {
                    if (recipientInput === delivery.passcode) {
                      // Correct — tell R4 to open the servo, dismiss modal permanently
                      publishCommand({ action: 'open_lid' })
                      setOtpSubmitted(true)   // prevent poll/realtime from re-opening modal
                      setShowOtpModal(false)
                      setRecipientInput('')
                      setRecipientAttempts(0)
                      showToast('✓ Correct! Servo opening — bot returns in ~5s.')
                    } else {
                      const attempts = recipientAttempts + 1
                      setRecipientAttempts(attempts)
                      setRecipientInput('')
                      // Tell R4 to flash "Wrong" on LCD
                      publishCommand({ action: 'wrong_passcode' })
                      if (attempts >= 3) {
                        setRecipientLocked(true)
                        publishCommand({ action: 'wrong_passcode_locked' } as any)
                        showToast('🔒 Locked after 3 wrong attempts')
                      } else {
                        showToast('✕ Wrong passcode — ' + attempts + '/3 attempts')
                      }
                    }
                  }}
                >
                  Unlock Box →
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
