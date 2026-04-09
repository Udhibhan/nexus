// lib/locations.ts
// Fallback static locations used if Supabase fetch fails.
// Keep in sync with supabase/seed.sql and arduino_r4.ino locationToByte().

import type { Location } from './types'

export const LOCATIONS: Record<string, Location> = {
  homebase: {
    id: 'homebase',
    label: 'Home Base',
    x: 0, y: 0,
    is_home: true,
  },
  engineers_office: {
    id: 'engineers_office',
    label: "Engineers Office",
    x: 0, y: 2,
    is_home: false,
  },
  storage_base: {
    id: 'storage_base',
    label: 'Storage Base',
    x: 2, y: 1,
    is_home: false,
  },
  marine_port: {
    id: 'marine_port',
    label: 'Marine Port',
    x: 3, y: 2,
    is_home: false,
  },
  admin_office: {
    id: 'admin_office',
    label: 'Admin Office',
    x: 1, y: 1,
    is_home: false,
  },
}

export const LOCATION_LIST = Object.values(LOCATIONS)

export function getLocation(id: string): Location | undefined {
  return LOCATIONS[id]
}

export const DELIVERY_LOCATIONS = LOCATION_LIST.filter(l => !l.is_home)
