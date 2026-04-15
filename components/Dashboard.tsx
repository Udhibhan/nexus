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
  at_pickup:    'Arrived at pickup',
  loading:      'Awaiting load',
  in_transit:   'Delivering',
  at_delivery:  'Arrived at delivery',
  delivered:    'Load collected',
  returning:    'Returning to base',
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
  const [showEntry, setShowEntry]   = useState(false)
  const [recipientId, setRecipient] = useState('')
  const [destId, setDest]           = useState('')
  const [passcode, setPasscode]     = useState('')
  const [entered, setEntered]       = useState('')
  const mqttRef = useRef<MqttClient | null>(null)

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

  // MQTT — async dynamic import, safe in Next.js client components
  useEffect(() => {
    let mounted = true
    import('mqtt').then((mod) => {
      const m = mod as Record<string, unknown>
      const connectFn = (typeof m.connect === 'function' ? m.connect : (m.default as Record<string,unknown>)?.connect ?? m.default) as (url: string, opts: object) => import('mqtt').MqttClient
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
      c.on('close',   () => { setMqttOk(false); addLog('MQTT disconnected') })
      c.on('message', (_t: string, payload: Buffer) => {
        try {
          const { event } = JSON.parse(payload.toString()) as { event: MqttStatusEvent }
          handleEvent(event)
        } catch {}
      })
    })
    return () => { mounted = false; mqttRef.current?.end(true) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Supabase realtime
  useEffect(() => {
    const ch = supabase.channel('rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, ({ new: r }) => {
        setDelivery(r as Delivery); addLog(`Status → ${(r as Delivery).status}`)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bot_state' }, ({ new: r }) => {
        setBotState(r as BotState)
      })
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleEvent(event: MqttStatusEvent) {
    addLog(`Event: ${event}`)
    if (event === 'arrived_pickup' || event === 'arrived_location') {
      // Determine context: if bot was going to pickup, this is a pickup arrival
      if (botStatus === 'going_pickup' || !delivery?.delivery_location_id) {
        await patchDelivery({ status: 'at_pickup' })
        await patchBot({ status: 'at_pickup', current_x: myLoc?.x ?? 0, current_y: myLoc?.y ?? 0 })
        if (amSender) setShowSetup(true)
        showToast('Bot arrived at pickup location')
      } else {
        // It's a delivery arrival
        await patchDelivery({ status: 'at_delivery' })
        const dLoc = locations.find(l => l.id === delivery?.delivery_location_id)
        if (dLoc) await patchBot({ status: 'at_delivery', current_x: dLoc.x, current_y: dLoc.y })
        if (amRecip) { setShowEntry(true); showToast('Bot arrived — enter your passcode') }
      }
    } else if (event === 'load_detected') {
      await patchDelivery({ status: 'loading', load_detected: true })
      if (amSender) showToast('✓ Load detected — ready to dispatch')
    } else if (event === 'load_removed') {
      await patchDelivery({ status: 'delivered' })
      publishCommand({ action: 'return_home' })
    } else if (event === 'box_opened') {
      await patchDelivery({ status: 'delivered' })
      showToast('✓ Box opened — collect your package')
      setShowEntry(false)
    } else if (event === 'wrong_passcode') {
      showToast('✕ Wrong passcode — try again')
    } else if (event === 'arrived_home') {
      await patchBot({ status: 'idle', current_x: 0, current_y: 0, delivery_id: null })
      if (delivery?.id) await supabase.from('deliveries').update({ status: 'idle' }).eq('id', delivery.id)
      setDelivery(null)
      showToast('Bot returned to home base')
    }
  }

  async function patchDelivery(patch: Partial<Delivery>) {
    if (!delivery?.id) return
    await supabase.from('deliveries').update(patch).eq('id', delivery.id)
  }

  async function patchBot(patch: Partial<BotState>) {
    await supabase.from('bot_state').update(patch).eq('id', 1)
  }

  async function callBot() {
    if (!myLoc) return showToast('Your location is not set — ask admin to assign it')
    const { data: nd } = await supabase.from('deliveries')
      .insert({ status: 'going_pickup', sender_id: userId, pickup_location_id: myLoc.id })
      .select().single()
    if (nd) { setDelivery(nd as Delivery); await patchBot({ status: 'going_pickup', delivery_id: nd.id }) }
    publishCommand({ action: 'call', pickup: myLoc.id })
    showToast(`Bot en route to ${myLoc.label}`)
    addLog(`Called bot to ${myLoc.label}`)
  }

  async function startDelivery() {
    if (passcode.length !== 4)   return showToast('Enter a 4-digit passcode')
    if (!recipientId || !destId) return showToast('Select recipient and destination')
    await patchDelivery({ status: 'in_transit', recipient_id: recipientId, delivery_location_id: destId, passcode })
    await patchBot({ status: 'in_transit' })
    publishCommand({ action: 'deliver', delivery: destId })
    setShowSetup(false)
    showToast('Package dispatched')
    addLog(`Dispatching to ${destId}`)
  }

  async function submitCode() {
    if (entered.length !== 4) return
    if (entered === delivery?.passcode) {
      publishCommand({ action: 'open_lid' })
      addLog('Correct passcode — opening lid')
    } else {
      showToast('✕ Wrong passcode')
      setEntered('')
    }
  }

  async function logout() { await supabase.auth.signOut(); router.push('/') }

  const M = { fontFamily: 'JetBrains Mono,monospace' }

  return (
    <div style={{ minHeight: '100vh', padding: 24, maxWidth: 1100, margin: '0 auto' }}>

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ ...M, fontSize: 10, color: 'var(--amber)', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 4 }}>◆ mbot Delivery System</div>
          <div style={{ ...M, fontSize: 18, fontWeight: 300 }}>
            {profile?.name || 'Operator'}
            <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 12 }}>@ {myLoc?.label || 'no location set'}</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={`status-dot ${mqttOk ? 'dot-green' : 'dot-red'}`} />
            <span style={{ ...M, fontSize: 10, color: 'var(--muted)' }}>{mqttOk ? 'MQTT LIVE' : 'MQTT OFF'}</span>
          </div>
          <button className="btn" onClick={logout} style={{ fontSize: 11, padding: '6px 14px' }}>Logout</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>

        {/* Left */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Bot status */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <span className="label">Bot status</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={`status-dot ${STATUS_DOT[botStatus] || 'dot-gray'}`} />
                <span style={{ ...M, fontSize: 11 }}>{STATUS_LABELS[botStatus] || botStatus}</span>
              </div>
            </div>
            {delivery && (
              <>
                <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                  {['going_pickup','at_pickup','loading','in_transit','at_delivery','delivered','returning'].map(s => (
                    <div key={s} style={{ flex: 1, height: 3, borderRadius: 2, background: isAfterOrEqual(botStatus, s) ? 'var(--amber)' : 'var(--border2)', transition: 'background 0.4s' }} />
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 12 }}>
                  <InfoBox label="From"      value={locations.find(l => l.id === delivery.pickup_location_id)?.label  || '—'} />
                  <InfoBox label="To"        value={locations.find(l => l.id === delivery.delivery_location_id)?.label || '—'} />
                  <InfoBox label="Recipient" value={allProfiles.find(p => p.id === delivery.recipient_id)?.name         || '—'} />
                </div>
              </>
            )}
          </div>

          {/* Actions */}
          <div className="card" style={{ padding: 20 }}>
            <span className="label" style={{ display: 'block', marginBottom: 16 }}>Actions</span>

            {botIdle && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ ...M, fontSize: 11, color: 'var(--muted)', lineHeight: 1.6 }}>Bot is at home base. Call it to your location to start a delivery.</div>
                <button className="btn btn-amber" onClick={callBot} style={{ width: 'fit-content' }}>↗ Call Bot to {myLoc?.label || 'my location'}</button>
              </div>
            )}

            {botStatus === 'going_pickup' && amSender && <StatusMsg icon="⟳" text={`Bot is navigating to ${myLoc?.label}...`} color="var(--amber)" />}

            {botStatus === 'at_pickup' && amSender && (
              <div>
                <StatusMsg icon="✓" text="Bot arrived. Load your item then set delivery details." color="var(--green)" />
                <button className="btn btn-amber" onClick={() => setShowSetup(true)} style={{ marginTop: 12 }}>Set Delivery Details →</button>
              </div>
            )}

            {delivery?.load_detected && botStatus === 'loading' && amSender && (
              <div>
                <StatusMsg icon="⚖" text="Load detected on platform." color="var(--green)" />
                <button className="btn btn-amber" onClick={startDelivery} style={{ marginTop: 12 }}>▶ Start Delivery</button>
              </div>
            )}

            {botStatus === 'in_transit' && <StatusMsg icon="⟶" text={`Delivering to ${locations.find(l => l.id === delivery?.delivery_location_id)?.label || '...'}`} color="var(--amber)" />}

            {botStatus === 'in_transit' && amRecip && delivery?.passcode && (
              <div style={{ marginTop: 16 }}>
                <span className="label">Your incoming passcode</span>
                <div style={{ ...M, fontSize: 40, fontWeight: 700, color: 'var(--amber)', letterSpacing: 12, marginTop: 8 }}>{delivery.passcode}</div>
                <div style={{ ...M, fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>Enter this on the bot keypad when it arrives</div>
              </div>
            )}

            {botStatus === 'at_delivery' && amRecip && (
              <div>
                <StatusMsg icon="✓" text="Bot has arrived at your station." color="var(--green)" />
                <button className="btn btn-amber" onClick={() => setShowEntry(true)} style={{ marginTop: 12 }}>Enter Passcode →</button>
              </div>
            )}

            {botStatus === 'at_delivery' && amSender && <StatusMsg icon="⟳" text="Waiting for recipient to enter passcode..." color="var(--amber)" />}
            {botStatus === 'returning'   && <StatusMsg icon="⟵" text="Package collected. Bot returning to home base." color="var(--amber)" />}
          </div>

          {/* Log */}
          <div className="card" style={{ padding: 16 }}>
            <span className="label" style={{ display: 'block', marginBottom: 10 }}>Event Log</span>
            <div style={{ maxHeight: 130, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {log.length === 0
                ? <span style={{ ...M, fontSize: 11, color: 'var(--muted)' }}>No events yet</span>
                : log.map((l, i) => <div key={i} style={{ ...M, fontSize: 10, color: i === 0 ? 'var(--text)' : 'var(--muted)' }}>{l}</div>)
              }
            </div>
          </div>
        </div>

        {/* Right — map */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card" style={{ padding: 16 }}>
            <span className="label" style={{ display: 'block', marginBottom: 12 }}>Grid Map</span>
            <GridMap locations={locations} botX={botState?.current_x ?? 0} botY={botState?.current_y ?? 0} />
          </div>
          <div className="card" style={{ padding: 16 }}>
            <span className="label" style={{ display: 'block', marginBottom: 10 }}>Stations</span>
            {locations.map(loc => (
              <div key={loc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ ...M, fontSize: 11, color: loc.is_home ? 'var(--amber)' : 'var(--text)' }}>{loc.label}</div>
                  <div style={{ ...M, fontSize: 9, color: 'var(--muted)' }}>({loc.x},{loc.y})</div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {loc.is_home && <span className="tag tag-amber">HOME</span>}
                  {myLoc?.id === loc.id && !loc.is_home && <span className="tag tag-blue">YOU</span>}
                  {botState?.current_x === loc.x && botState?.current_y === loc.y && <span className="tag tag-green">BOT</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Delivery setup modal */}
      {showSetup && (
        <div className="modal-overlay" onClick={() => setShowSetup(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ ...M, fontSize: 10, color: 'var(--amber)', letterSpacing: '0.15em', marginBottom: 8 }}>◆ DELIVERY SETUP</div>
            <h2 style={{ ...M, fontSize: 18, fontWeight: 300, marginBottom: 24 }}>Configure Package</h2>
            <div style={{ marginBottom: 14 }}>
              <span className="label">Recipient</span>
              <select className="select" value={recipientId} onChange={e => setRecipient(e.target.value)}>
                <option value="">— select recipient —</option>
                {others.map(p => <option key={p.id} value={p.id}>{p.name} — {p.location?.label || 'no location'}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <span className="label">Delivery Station</span>
              <select className="select" value={destId} onChange={e => setDest(e.target.value)}>
                <option value="">— select destination —</option>
                {locations.filter(l => !l.is_home).map(l => <option key={l.id} value={l.id}>{l.label} ({l.x},{l.y})</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 24 }}>
              <span className="label">Passcode (4 digits)</span>
              <input className="input" type="text" maxLength={4} placeholder="e.g. 7432" value={passcode}
                onChange={e => setPasscode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                style={{ letterSpacing: '0.3em', fontSize: 20, textAlign: 'center' }} />
              <div style={{ ...M, fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>Recipient sees this code privately on their screen</div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={() => setShowSetup(false)}>Cancel</button>
              <button className="btn btn-amber" onClick={startDelivery} style={{ flex: 1 }}>Confirm &amp; Dispatch →</button>
            </div>
          </div>
        </div>
      )}

      {/* Passcode entry modal */}
      {showEntry && (
        <div className="modal-overlay" onClick={() => setShowEntry(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ ...M, fontSize: 10, color: 'var(--amber)', letterSpacing: '0.15em', marginBottom: 8 }}>◆ PACKAGE AWAITING</div>
            <h2 style={{ ...M, fontSize: 18, fontWeight: 300, marginBottom: 6 }}>Enter Passcode</h2>
            <p style={{ ...M, fontSize: 11, color: 'var(--muted)', marginBottom: 20, lineHeight: 1.6 }}>Enter the 4-digit code you received — on screen here, or via the bot keypad.</p>
            {delivery?.passcode && (
              <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 2, padding: '12px 16px', marginBottom: 20, textAlign: 'center' }}>
                <div style={{ ...M, fontSize: 10, color: 'var(--muted)', marginBottom: 4 }}>YOUR CODE</div>
                <div style={{ ...M, fontSize: 40, fontWeight: 700, color: 'var(--amber)', letterSpacing: 16 }}>{delivery.passcode}</div>
              </div>
            )}
            <div style={{ marginBottom: 20 }}>
              <span className="label">Passcode</span>
              <input className="input" type="text" maxLength={4} placeholder="_ _ _ _" value={entered}
                onChange={e => setEntered(e.target.value.replace(/\D/g, '').slice(0, 4))}
                style={{ letterSpacing: '0.5em', fontSize: 24, textAlign: 'center' }} autoFocus />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" onClick={() => setShowEntry(false)}>Close</button>
              <button className="btn btn-amber" onClick={submitCode} disabled={entered.length !== 4} style={{ flex: 1 }}>Submit →</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: 'var(--surface)', border: '1px solid var(--amber)', borderRadius: 2, padding: '12px 20px', ...M, fontSize: 12, color: 'var(--amber)', zIndex: 999, whiteSpace: 'nowrap', letterSpacing: '0.05em', boxShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>
          {toast}
        </div>
      )}
    </div>
  )
}
