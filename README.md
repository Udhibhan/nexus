# mbot Delivery System — EPP Project

Autonomous factory delivery robot controlled via a web app.

## Stack
- **Frontend/Backend**: Next.js 14 (App Router) on Vercel
- **Database + Auth**: Supabase (Postgres + Realtime + Auth)
- **Message broker**: HiveMQ Cloud (MQTT over WSS for browser, TLS for Arduino)
- **Hardware**: Arduino R4 WiFi + mbot (mCore/ATmega328P), wired TX/RX

## Quick start

### 1. Clone and install
  npm install

### 2. Configure environment
  cp .env.local.example .env.local
  # Fill in your Supabase and HiveMQ credentials (see supabase/SETUP.md and supabase/HIVEMQ.md)

### 3. Set up Supabase
  Follow supabase/SETUP.md

### 4. Run locally
  npm run dev
  # Open http://localhost:3000

### 5. Deploy to Vercel
  vercel deploy
  # Add all NEXT_PUBLIC_ env vars in Vercel dashboard > Settings > Environment Variables

### 6. Flash Arduino
  Open arduino/arduino_r4.ino in Arduino IDE
  Fill in WiFi + MQTT credentials at the top
  Upload to Arduino R4 WiFi

### 7. Flash mbot
  Open arduino/mbot.ino in Arduino IDE
  Upload via USB, then unplug USB and connect R4 TX/RX wires

## Delivery flow
  1. Sender logs in -> calls bot to their location
  2. Bot navigates to pickup -> lid opens if empty
  3. Sender sets recipient, destination, 4-digit passcode
  4. Sender loads item -> load cell confirms -> starts delivery
  5. Recipient sees passcode privately on their screen
  6. Bot navigates to destination
  7. Recipient enters passcode (website + keypad when available)
  8. Lid opens -> recipient collects item
  9. Load cell detects empty -> lid closes -> bot returns to (0,0)

## Changing grid coordinates
  Update the locations table in Supabase SQL Editor.
  Update locationToByte() and coordToId() in arduino_r4.ino to match.

## Calibration (mbot)
  Tune TURN_MS until a single turn is exactly 90 degrees.
  Tune CLEAR_MS until the bot fully clears one intersection before line-following.
  Tune LOAD_THRESHOLD for your load cell — print analogRead(A0) over Serial to find the right value.
