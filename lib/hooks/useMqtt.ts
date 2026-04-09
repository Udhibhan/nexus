'use client'
import { useEffect, useRef, useCallback } from 'react'
import type { MqttClient } from 'mqtt'
import type { MqttCommand, MqttEvent } from '../types'

const PREFIX = process.env.NEXT_PUBLIC_MQTT_TOPIC_PREFIX ?? 'mbot_epp_2024'
export const TOPIC_CMD    = `${PREFIX}/command`
export const TOPIC_STATUS = `${PREFIX}/status`

type EventHandler = (event: MqttEvent) => void

export function useMqtt(onEvent: EventHandler) {
  const clientRef = useRef<MqttClient | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    let mounted = true

    // Dynamic import so it only runs client-side
    import('mqtt').then(({ connect }) => {
      if (!mounted) return

      const client = connect(process.env.NEXT_PUBLIC_MQTT_BROKER!, {
        clientId: `mbot_web_${Math.random().toString(16).slice(2, 8)}`,
        clean: true,
        reconnectPeriod: 3000,
      })

      clientRef.current = client

      client.on('connect', () => {
        client.subscribe(TOPIC_STATUS, { qos: 1 })
      })

      client.on('message', (topic, payload) => {
        if (topic !== TOPIC_STATUS) return
        try {
          const event: MqttEvent = JSON.parse(payload.toString())
          onEventRef.current(event)
        } catch {}
      })
    })

    return () => {
      mounted = false
      clientRef.current?.end(true)
      clientRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const publish = useCallback((cmd: MqttCommand) => {
    clientRef.current?.publish(
      TOPIC_CMD,
      JSON.stringify(cmd),
      { qos: 1 }
    )
  }, [])

  return { publish }
}
