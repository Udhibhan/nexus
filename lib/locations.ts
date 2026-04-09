// lib/locations.ts
// These match exactly what's in supabase/schema.sql seed data.
// To change coordinates: update both this file AND the Supabase locations table.

import type { Location } from './types'

export const LOCATIONS: Record<string, Location> = {
  homebase: {
    id: 'homebase',
    name: 'Homebase',
    x: 0, y: 0,
    location_byte: 0x00,
  },
  engineers_office: {
    id: 'engineers_office',
    name: "Engineer's Office",
    x: 0, y: 2,
    location_byte: 0x01,
  },
  storage_base: {
    id: 'storage_base',
    name: 'Storage Base',
    x: 2, y: 1,
    location_byte: 0x02,
  },
  marine_port: {
    id: 'marine_port',
    name: 'Marine Port',
    x: 3, y: 2,
    location_byte: 0x03,
  },
  admin_office: {
    id: 'admin_office',
    name: 'Admin Office',
    x: 1, y: 1,
    location_byte: 0x04,
  },
}

export const LOCATION_LIST = Object.values(LOCATIONS)

export function getLocation(id: string): Location | undefined {
  return LOCATIONS[id]
}

// Locations the bot can be called to / sent to (excludes homebase)
export const DELIVERY_LOCATIONS = LOCATION_LIST.filter(l => l.id !== 'homebase')
