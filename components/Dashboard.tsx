'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-client'
import { getMqttClient, TOPICS, publishCommand } from '@/lib/mqtt'
import type { Location, Profile, Delivery, BotState, MqttStatusEvent } from '@/lib/types'

// ─── Status helpers ───────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  idle:            'Idle — at home base',
  going_pickup:    'En route to pickup',
  at_pickup:       'Arrived at pickup',
  loading:         'Awaiting load',
  in_transit:      'Delivering',
  at_delivery:     'Arrived at delivery',
  delivered:       'Load collected',
  returning:       'Returning to base',
}

const STATUS_DOT: Record<string, string> = {
  idle:         'dot-gray',
  going_pickup: 'dot-amber',
  at_pickup:    'dot-green',
  loading:      'dot-amber',
  in_transit:   'dot-amber',
  at_delivery:  'dot-green',
  delivered:    'dot-green',
  returning:    'dot-amber',
}

// ─── Props ────────────────────────────────────────────────────
interface Props {
  userId:           string
  profile:          Profile & { location?: Location } | null
  locations:        Location[]
  allProfiles:      (Profile & { location?: Location })[]
  initialDelivery:  Delivery | null
  initialBotState:  BotState | null
}

// ─── Grid map ─────────────────────────────────────────────────
function GridMap({ locations, botX, botY }: { locations: Location[], botX: number, botY: number }) {
  const maxX = Math.max(...locations.map(l => l.x), 3)
  const maxY = Math.max(...locations.map(l => l.y), 2)
  const cols  = maxX + 1
  const rows  = maxY + 1

  // Build lookup
  const locMap: Record<string, Location> = {}
  locations.forEach(l => { locMap[`${l.x},${l.y}`] = l })

  // Render rows top-to-bottom (highest Y first)
  const grid = []
  for (let y = maxY; y >= 0; y--) {
    for (let x = 0; x < cols; x++) {
      const loc     = locMap[`${x},${y}`]
      const isBot   = botX === x && botY === y
      const isHome  = loc?.is_home
      grid.push(
        <div
          key={`${x},${y}`}
          className={`grid-cell ${loc ? 'has-location' : ''} ${isHome ? 'is-home' : ''} ${isBot ? 'bot-here' : ''}`}
          style={{ minHeight: '60px' }}
        >
          {isBot && (
            <div style={{ position: 'absolute', top: '4px', right: '4px', fontSize: '14px' }}>🤖</div>
          )}
          {loc && (
            <div style={{ textAlign: 'center', lineHeight: 1.3 }}>
              <div style={{ fontSize: '8px', color: 'var(--muted)' }}>{x},{y}</div>
              <div style={{ fontSize: '9px', color: isHome ? 'var(--amber)' : 'var(--text)', marginTop: '2px' }}>
                {loc.label.replace(' ', '\n')}
              </div>
            </div>
          )}
          {!loc && (
            <div style={{ fontSize: '8px', color: '#222' }}>{x},{y}</div>
          )}
        </div>
      )
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '4px' }}>
      {grid}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────
export default function Dashboard({
  userId, profile, locations, allProfiles, initialDelivery, initialBotState
}: Props) {
  const router = useRouter()
  const supabase = createClient()

  const [delivery, setDelivery]       = useState<Delivery | null>(initialDelivery)
  const [botState, setBotState]       = useState<BotState | null>(initialBotState)
  const [mqttConnected, setMqttConn]  = useState(false)
  const [toast, setToast]             = useState<string | null>(null)
  const [log, setLog]                 = useState<string[]>([])

  // Modal state
  const [showDeliverySetup, setShowDeliverySetup] = useState(false)
  const [showPasscodeModal, setShowPasscodeModal]  = useState(false)
  const [showPasscodeEntry, setShowPasscodeEntry]  = useState(false) // for recipient

  // Delivery setup form
  const [recipientId, setRecipientId]         = useState('')
  const [deliveryLocationId, setDeliveryLocId] = useState('')
  const [passcode, setPasscode]               = useState('')
  const [enteredCode, setEnteredCode]         = useState('')

  const mqttRef = useRef<ReturnType<typeof getMqttClient> | null>(null)

  // ── Helpers ───────────────────────────────────────────────
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false })
    setLog(prev => [`[${ts}] ${msg}`, ...prev].slice(0, 40))
  }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }, [])

  // My location
  const myLocation = profile?.location

  // Active delivery context
  const amSender    = delivery?.sender_id    === userId
  const amRecipient = delivery?.recipient_id === userId
  const botStatus   = botState?.status || 'idle'
  const botIdle     = botStatus === 'idle' || !delivery

  // Other profiles (excluding self)
  const otherProfiles = allProfiles.filter(p => p.id !== userId)

  // ── MQTT setup ────────────────────────────────────────────
  useEffect(() => {
    const client = getMqttClient()
    mqttRef.current = client

    client.on('connect', () => {
      setMqttConn(true)
      client.subscribe(TOPICS.status)
      addLog('MQTT connected')
    })
    client.on('disconnect', () => { setMqttConn(false); addLog('MQTT disconnected') })
    client.on('error', () => setMqttConn(false))

    client.on('message', (_topic: string, payload: Buffer) => {
      try {
        const data = JSON.parse(payload.toString()) as { event: MqttStatusEvent }
        handleMqttEvent(data.event)
      } catch {}
    })

    return () => { client.removeAllListeners('message') }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivery?.id])

  // ── Supabase realtime ─────────────────────────────────────
  useEffect(() => {
    const ch = supabase
      .channel('realtime-delivery')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, ({ new: row }) => {
        setDelivery(row as Delivery)
        addLog(`Delivery status → ${(row as Delivery).status}`)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_state' }, ({ new: row }) => {
        setBotState(row as BotState)
      })
      .subscribe()

    return () => { supabase.removeChannel(ch) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── MQTT event handler ────────────────────────────────────
  async function handleMqttEvent(event: MqttStatusEvent) {
    addLog(`Event: ${event}`)

    switch (event) {
      case 'arrived_pickup':
        await updateDelivery({ status: 'at_pickup' })
        await updateBotState({ status: 'at_pickup', current_x: myLocation?.x ?? 0, current_y: myLocation?.y ?? 0 })
        if (amSender) setShowDeliverySetup(true)
        showToast('Bot arrived at your location')
        break

      case 'load_detected':
        await updateDelivery({ status: 'loading', load_detected: true })
        if (amSender) showToast('✓ Load detected — ready to dispatch')
        break

      case 'load_removed':
        // Package collected at destination — servo closes, return home
        await updateDelivery({ status: 'delivered' })
        publishCommand({ action: 'return_home' })
        addLog('Load removed — sending bot home')
        break

      case 'arrived_delivery':
        await updateDelivery({ status: 'at_delivery' })
        const deliveryLoc = locations.find(l => l.id === delivery?.delivery_location_id)
        if (deliveryLoc) await updateBotState({ status: 'at_delivery', current_x: deliveryLoc.x, current_y: deliveryLoc.y })
        if (amRecipient) setShowPasscodeEntry(true)
        if (amRecipient) showToast('Bot has arrived — enter your passcode')
        break

      case 'box_opened':
        await updateDelivery({ status: 'delivered' })
        showToast('✓ Box opened — collect your package')
        setShowPasscodeEntry(false)
        break

      case 'wrong_passcode':
        showToast('✕ Wrong passcode — try again')
        break

      case 'arrived_home':
        await updateBotState({ status: 'idle', current_x: 0, current_y: 0, delivery_id: null })
        // Mark delivery fully done
        await supabase.from('deliveries').update({ status: 'idle' }).eq('id', delivery?.id)
        setDelivery(null)
        showToast('Bot returned to home base')
        break
    }
  }

  // ── DB helpers ────────────────────────────────────────────
  async function updateDelivery(patch: Partial<Delivery>) {
    if (!delivery?.id) return
    await supabase.from('deliveries').update(patch).eq('id', delivery.id)
  }

  async function updateBotState(patch: Partial<BotState>) {
    await supabase.from('bot_state').update(patch).eq('id', 1)
  }

  // ── Actions ───────────────────────────────────────────────
  async function callBot() {
    if (!myLocation) return showToast('Your location is not set in your profile')

    // Create new delivery record
    const { data: newDel } = await supabase
      .from('deliveries')
      .insert({ status: 'going_pickup', sender_id: userId, pickup_location_id: myLocation.id })
      .select()
      .single()

    if (newDel) {
      setDelivery(newDel as Delivery)
      await updateBotState({ status: 'going_pickup', delivery_id: newDel.id })
    }

    publishCommand({ action: 'call', pickup: myLocation.id })
    addLog(`Called bot to ${myLocation.label}`)
    showToast(`Bot en route to ${myLocation.label}`)
  }

  async function startDelivery() {
    if (!passcode || passcode.length !== 4) return showToast('Enter a 4-digit passcode')
    if (!recipientId || !deliveryLocationId) return showToast('Select recipient and destination')

    // Update delivery with all details
    await updateDelivery({
      status: 'in_transit',
      recipient_id: recipientId,
      delivery_location_id: deliveryLocationId,
      passcode,
    })
    await updateBotState({ status: 'in_transit' })

    publishCommand({ action: 'deliver', delivery: deliveryLocationId })
    setShowDeliverySetup(false)
    addLog(`Dispatching to ${deliveryLocationId}`)
    showToast('Package dispatched')
  }

  async function submitPasscode() {
    if (!enteredCode || enteredCode.length !== 4) return
    // Simulate sending passcode to bot (in real setup this goes via keypad)
    // For now we check against DB and send open command
    if (enteredCode === delivery?.passcode) {
      publishCommand({ action: 'open_lid' })
      addLog('Correct passcode — lid opening')
    } else {
      publishCommand({ action: 'wrong_passcode_entered' } as never)
      showToast('✕ Wrong passcode')
      setEnteredCode('')
      // Emit wrong_passcode status so sender sees it
      await supabase.from('bot_state').update({ status: 'at_delivery' }).eq('id', 1)
    }
  }

  async function logout() {
    await supabase.auth.signOut()
    router.push('/')
  }

  // ── Render ────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: 'var(--amber)', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '4px' }}>
            ◆ mbot Delivery System
          </div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '18px', fontWeight: 300 }}>
            {profile?.name || 'Operator'}
            <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '12px' }}>
              @ {myLocation?.label || 'No location set'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className={`status-dot ${mqttConnected ? 'dot-green' : 'dot-red'}`} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: 'var(--muted)' }}>
              {mqttConnected ? 'MQTT LIVE' : 'MQTT OFF'}
            </span>
          </div>
          <button className="btn" onClick={logout} style={{ fontSize: '11px', padding: '6px 14px' }}>
            Logout
          </button>
        </div>
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '16px' }}>

        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Bot status card */}
          <div className="card" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <span className="label">Bot status</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span className={`status-dot ${STATUS_DOT[botStatus] || 'dot-gray'}`} />
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--text)' }}>
                  {STATUS_LABELS[botStatus] || botStatus}
                </span>
              </div>
            </div>

            {/* Delivery progress bar */}
            {delivery && (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                  {['going_pickup','at_pickup','loading','in_transit','at_delivery','delivered','returning'].map(s => (
                    <div key={s} style={{
                      flex: 1, height: '3px', borderRadius: '2px',
                      background: isAfterOrEqual(botStatus, s) ? 'var(--amber)' : 'var(--border2)',
                      transition: 'background 0.5s',
                    }} />
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', color: 'var(--muted)' }}>PICKUP</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', color: 'var(--muted)' }}>DELIVERY</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', color: 'var(--muted)' }}>HOME</span>
                </div>
              </div>
            )}

            {/* Delivery details */}
            {delivery && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                <InfoBox label="From" value={locations.find(l => l.id === delivery.pickup_location_id)?.label || '—'} />
                <InfoBox label="To" value={locations.find(l => l.id === delivery.delivery_location_id)?.label || '—'} />
                <InfoBox label="Recipient" value={allProfiles.find(p => p.id === delivery.recipient_id)?.name || '—'} />
              </div>
            )}
          </div>

          {/* Action panel */}
          <div className="card" style={{ padding: '20px' }}>
            <span className="label" style={{ marginBottom: '16px', display: 'block' }}>Actions</span>

            {/* CALL BOT — sender only, when idle */}
            {botIdle && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: '11px',
                  color: 'var(--muted)', marginBottom: '4px', lineHeight: 1.6,
                }}>
                  Bot is at home base. Call it to your location to begin a delivery.
                </div>
                <button className="btn btn-amber" onClick={callBot} style={{ width: 'fit-content' }}>
                  ↗ Call Bot to {myLocation?.label || 'my location'}
                </button>
              </div>
            )}

            {/* WAITING FOR BOT */}
            {botStatus === 'going_pickup' && amSender && (
              <StatusMessage icon="⟳" text={`Bot is navigating to ${myLocation?.label}...`} color="var(--amber)" />
            )}

            {/* BOT AT PICKUP — sender sets up delivery */}
            {botStatus === 'at_pickup' && amSender && (
              <div>
                <StatusMessage icon="✓" text="Bot has arrived. Load your item, then set delivery details." color="var(--green)" />
                <button className="btn btn-amber" onClick={() => setShowDeliverySetup(true)} style={{ marginTop: '12px' }}>
                  Set Delivery Details →
                </button>
              </div>
            )}

            {/* LOAD DETECTED */}
            {delivery?.load_detected && botStatus === 'loading' && amSender && (
              <div>
                <StatusMessage icon="⚖" text="Load detected on platform." color="var(--green)" />
                <button className="btn btn-amber" onClick={startDelivery} style={{ marginTop: '12px' }}>
                  ▶ Start Delivery
                </button>
              </div>
            )}

            {/* IN TRANSIT */}
            {botStatus === 'in_transit' && (
              <StatusMessage icon="⟶" text={`Bot is delivering to ${locations.find(l => l.id === delivery?.delivery_location_id)?.label || '...'}`} color="var(--amber)" />
            )}

            {/* AT DELIVERY — recipient enters passcode */}
            {botStatus === 'at_delivery' && amRecipient && (
              <div>
                <StatusMessage icon="✓" text="Bot has arrived at your station with a package." color="var(--green)" />
                <button className="btn btn-amber" onClick={() => setShowPasscodeEntry(true)} style={{ marginTop: '12px' }}>
                  Enter Passcode →
                </button>
              </div>
            )}

            {/* AT DELIVERY — sender waiting */}
            {botStatus === 'at_delivery' && amSender && (
              <StatusMessage icon="⟳" text="Waiting for recipient to enter passcode..." color="var(--amber)" />
            )}

            {/* RETURNING */}
            {botStatus === 'returning' && (
              <StatusMessage icon="⟵" text="Package collected. Bot returning to home base." color="var(--amber)" />
            )}

            {/* Recipient sees passcode when delivery is in_transit */}
            {botStatus === 'in_transit' && amRecipient && delivery?.passcode && (
              <div style={{ marginTop: '12px' }}>
                <span className="label">Your Incoming Passcode</span>
                <div style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: '36px',
                  fontWeight: 600, color: 'var(--amber)', letterSpacing: '12px',
                  marginTop: '8px',
                }}>
                  {delivery.passcode}
                </div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: 'var(--muted)', marginTop: '6px' }}>
                  Enter this on the bot keypad when it arrives
                </div>
              </div>
            )}
          </div>

          {/* Event log */}
          <div className="card" style={{ padding: '16px' }}>
            <span className="label" style={{ marginBottom: '10px', display: 'block' }}>Event Log</span>
            <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {log.length === 0 && (
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--muted)' }}>
                  No events yet
                </span>
              )}
              {log.map((l, i) => (
                <div key={i} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: i === 0 ? 'var(--text)' : 'var(--muted)' }}>
                  {l}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right column — map */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="card" style={{ padding: '16px' }}>
            <span className="label" style={{ marginBottom: '12px', display: 'block' }}>Grid Map</span>
            <GridMap
              locations={locations}
              botX={botState?.current_x ?? 0}
              botY={botState?.current_y ?? 0}
            />
          </div>

          {/* Location legend */}
          <div className="card" style={{ padding: '16px' }}>
            <span className="label" style={{ marginBottom: '10px', display: 'block' }}>Stations</span>
            {locations.map(loc => (
              <div key={loc.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 0', borderBottom: '1px solid var(--border)',
              }}>
                <div>
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: loc.is_home ? 'var(--amber)' : 'var(--text)' }}>
                    {loc.label}
                  </div>
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', color: 'var(--muted)' }}>
                    ({loc.x},{loc.y})
                  </div>
                </div>
                {loc.is_home && <span className="tag tag-amber">HOME</span>}
                {myLocation?.id === loc.id && !loc.is_home && <span className="tag tag-blue">YOU</span>}
                {botState?.current_x === loc.x && botState?.current_y === loc.y && (
                  <span className="tag tag-green">BOT</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────── */}

      {/* Delivery Setup Modal */}
      {showDeliverySetup && (
        <div className="modal-overlay" onClick={() => setShowDeliverySetup(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: 'var(--amber)', letterSpacing: '0.15em', marginBottom: '8px' }}>
              ◆ DELIVERY SETUP
            </div>
            <h2 style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '18px', fontWeight: 300, marginBottom: '24px' }}>
              Configure Package
            </h2>

            <div style={{ marginBottom: '14px' }}>
              <span className="label">Recipient</span>
              <select className="select" value={recipientId} onChange={e => setRecipientId(e.target.value)}>
                <option value="">— select recipient —</option>
                {otherProfiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name} — {p.location?.label || 'no location'}</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: '14px' }}>
              <span className="label">Delivery Station</span>
              <select className="select" value={deliveryLocationId} onChange={e => setDeliveryLocId(e.target.value)}>
                <option value="">— select destination —</option>
                {locations.filter(l => !l.is_home).map(l => (
                  <option key={l.id} value={l.id}>{l.label} ({l.x},{l.y})</option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <span className="label">Passcode (4 digits)</span>
              <input
                className="input"
                type="text"
                maxLength={4}
                placeholder="e.g. 7432"
                value={passcode}
                onChange={e => setPasscode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                style={{ letterSpacing: '0.3em', fontSize: '20px', textAlign: 'center' }}
              />
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: 'var(--muted)', marginTop: '6px' }}>
                Recipient will receive this code privately on their screen
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="btn" onClick={() => setShowDeliverySetup(false)}>Cancel</button>
              <button className="btn btn-amber" onClick={startDelivery} style={{ flex: 1 }}>
                Confirm &amp; Dispatch →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Passcode Entry Modal (recipient) */}
      {showPasscodeEntry && (
        <div className="modal-overlay" onClick={() => setShowPasscodeEntry(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: 'var(--amber)', letterSpacing: '0.15em', marginBottom: '8px' }}>
              ◆ PACKAGE AWAITING
            </div>
            <h2 style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '18px', fontWeight: 300, marginBottom: '6px' }}>
              Enter Passcode
            </h2>
            <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--muted)', marginBottom: '24px', lineHeight: 1.6 }}>
              Enter the 4-digit code you received. On the physical bot this is entered via keypad — here you can also enter it on screen.
            </p>

            {/* Passcode display for recipient */}
            {delivery?.passcode && (
              <div style={{
                background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
                borderRadius: '2px', padding: '12px 16px', marginBottom: '20px', textAlign: 'center',
              }}>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: 'var(--muted)', marginBottom: '4px' }}>YOUR CODE</div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '40px', fontWeight: 700, color: 'var(--amber)', letterSpacing: '16px' }}>
                  {delivery.passcode}
                </div>
              </div>
            )}

            <div style={{ marginBottom: '20px' }}>
              <span className="label">Enter code on bot keypad (or here)</span>
              <input
                className="input"
                type="text"
                maxLength={4}
                placeholder="_ _ _ _"
                value={enteredCode}
                onChange={e => setEnteredCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                style={{ letterSpacing: '0.5em', fontSize: '24px', textAlign: 'center' }}
                autoFocus
              />
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="btn" onClick={() => setShowPasscodeEntry(false)}>Close</button>
              <button
                className="btn btn-amber"
                onClick={submitPasscode}
                disabled={enteredCode.length !== 4}
                style={{ flex: 1 }}
              >
                Submit Passcode →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--surface)', border: '1px solid var(--amber)', borderRadius: '2px',
          padding: '12px 20px', fontFamily: 'JetBrains Mono, monospace', fontSize: '12px',
          color: 'var(--amber)', zIndex: 999, whiteSpace: 'nowrap', letterSpacing: '0.05em',
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Small helpers ────────────────────────────────────────────
function InfoBox({ label, value }: { label: string, value: string }) {
  return (
    <div style={{ background: '#0a0a0a', border: '1px solid var(--border)', borderRadius: '2px', padding: '8px 10px' }}>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--text)' }}>{value}</div>
    </div>
  )
}

function StatusMessage({ icon, text, color }: { icon: string, text: string, color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px', background: '#0a0a0a', border: `1px solid ${color}22`, borderRadius: '2px' }}>
      <span style={{ color, fontSize: '14px', marginTop: '1px' }}>{icon}</span>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', color: 'var(--muted)', lineHeight: 1.6 }}>{text}</span>
    </div>
  )
}

const STATUS_ORDER = ['idle','going_pickup','at_pickup','loading','in_transit','at_delivery','delivered','returning']
function isAfterOrEqual(current: string, target: string) {
  return STATUS_ORDER.indexOf(current) >= STATUS_ORDER.indexOf(target)
}
