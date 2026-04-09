import mqtt, { MqttClient } from 'mqtt'

const PREFIX = process.env.NEXT_PUBLIC_MQTT_TOPIC_PREFIX || 'mbot_epp'

export const TOPICS = {
  command: `${PREFIX}/command`,
  status:  `${PREFIX}/status`,
} as const

let client: MqttClient | null = null

export function getMqttClient(): MqttClient {
  if (client && client.connected) return client

  client = mqtt.connect(process.env.NEXT_PUBLIC_MQTT_BROKER_WSS!, {
    clientId: `mbot_web_${Math.random().toString(16).slice(2, 8)}`,
    username: process.env.NEXT_PUBLIC_MQTT_USERNAME,
    password: process.env.NEXT_PUBLIC_MQTT_PASSWORD,
    reconnectPeriod: 2000,
    keepalive: 30,
  })

  return client
}

export function publishCommand(cmd: object) {
  const c = getMqttClient()
  c.publish(TOPICS.command, JSON.stringify(cmd), { qos: 1 })
}
