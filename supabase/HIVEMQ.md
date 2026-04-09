# HiveMQ Cloud Setup Guide

## Why HiveMQ Cloud (not the public broker)?
The public broker.hivemq.com requires NO auth — anyone can publish to your
topic and mess with your bot during the demo. The free cloud cluster is private.

## Step 1 — Create free cluster
Go to https://console.hivemq.cloud
Create a free Serverless cluster (no credit card needed).

## Step 2 — Create credentials
Under Access Management > Credentials, create a new user:
  Username: mbot_epp
  Password: (strong password)
  Role: publish + subscribe

## Step 3 — Get your broker URL
From the cluster overview page, copy the hostname.
It looks like: abc123.s2.eu.hivemq.cloud

Your .env.local values:
  NEXT_PUBLIC_MQTT_BROKER_WSS=wss://abc123.s2.eu.hivemq.cloud:8884/mqtt
  NEXT_PUBLIC_MQTT_USERNAME=mbot_epp
  NEXT_PUBLIC_MQTT_PASSWORD=yourpassword

Your arduino_r4.ino values:
  MQTT_BROKER = "abc123.s2.eu.hivemq.cloud"
  MQTT_PORT   = 8883   (TLS/TCP for Arduino)
  MQTT_USER   = "mbot_epp"
  MQTT_PASS   = "yourpassword"

## Topic prefix
Default: mbot_epp_2025
Change NEXT_PUBLIC_MQTT_TOPIC_PREFIX in .env.local and the TOPIC_CMD/TOPIC_STATUS
constants in arduino_r4.ino to match.
