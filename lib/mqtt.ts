'use client'
import type { MqttClient } from 'mqtt'

const PREFIX = process.env.NEXT_PUBLIC_MQTT_TOPIC_PREFIX || 'mbot_epp_2025'

export const TOPICS = {
  command: `${PREFIX}/command`,
  status:  `${PREFIX}/status`,
} as const

let client: MqttClient | null = null

export async function getMqttClient(): Promise<MqttClient> {
  if (client && client.connected) return client

  const { connect } = await import('mqtt')
  client = connect(process.env.NEXT_PUBLIC_MQTT_BROKER_WSS!, {
    clientId: `mbot_web_${Math.random().toString(16).slice(2, 8)}`,
    username: process.env.NEXT_PUBLIC_MQTT_USERNAME,
    password: process.env.NEXT_PUBLIC_MQTT_PASSWORD,
    reconnectPeriod: 2000,
    keepalive: 30,
  })

  return client
}

export async function publishCommand(cmd: object) {
  const c = await getMqttClient()
  c.publish(TOPICS.command, JSON.stringify(cmd), { qos: 1 })
}
