export type DeliveryStatus =
  | 'idle'
  | 'going_pickup'
  | 'at_pickup'
  | 'loading'
  | 'in_transit'
  | 'at_delivery'
  | 'delivered'
  | 'returning'

export interface Location {
  id: string
  label: string
  x: number
  y: number
  is_home: boolean
}

export interface Profile {
  id: string
  name: string
  location_id: string | null
  location?: Location
}

export interface Delivery {
  id: string
  status: DeliveryStatus
  sender_id: string | null
  recipient_id: string | null
  pickup_location_id: string | null
  delivery_location_id: string | null
  passcode: string | null
  load_detected: boolean
  created_at: string
  updated_at: string
}

export interface BotState {
  id: number
  status: string
  current_x: number
  current_y: number
  delivery_id: string | null
  updated_at: string
}

// MQTT command payloads sent from website → Arduino R4
export type MqttCommand =
  | { action: 'call';        pickup: string }
  | { action: 'deliver';     delivery: string }
  | { action: 'return_home' }
  | { action: 'open_lid' }
  | { action: 'close_lid' }

// MQTT status events sent from Arduino R4 → website
export type MqttStatusEvent =
  | 'arrived_location'
  | 'load_received'
  | 'box_opened'
  | 'wrong_passcode'
  | 'wrong_passcode_locked'
  | 'arrived_home'

// Shape of the JSON object published on the status topic
export interface MqttEvent {
  event: MqttStatusEvent
}
