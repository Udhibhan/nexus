// =============================================================
// mbot Delivery — Arduino R4 WiFi
// Bridges MQTT (cloud) <-> mbot (Serial1 via TX/RX wires)
//
// Libraries needed (Tools > Manage Libraries):
//   - ArduinoMqttClient  by Arduino
//   - ArduinoJson        by Benoit Blanchon
//   - WiFiS3             (built in for R4 WiFi)
// =============================================================

#include <WiFiS3.h>
#include <ArduinoMqttClient.h>
#include <ArduinoJson.h>

// -- Config: match your .env.local ----------------------------
const char* WIFI_SSID    = "YourWiFiName";
const char* WIFI_PASS    = "YourWiFiPass";
const char* MQTT_BROKER  = "YOUR_CLUSTER.s2.eu.hivemq.cloud";
const int   MQTT_PORT    = 8883;
const char* MQTT_USER    = "your_hivemq_username";
const char* MQTT_PASS    = "your_hivemq_password";
const char* TOPIC_CMD    = "mbot_epp_2025/command";
const char* TOPIC_STATUS = "mbot_epp_2025/status";

// -- Location -> coordinate byte encoding ---------------------
// Packed as (x << 4) | y  so both fit in one byte
// Max coord value = 15, fine for any lab grid
byte locationToByte(const char* loc) {
  if (strcmp(loc, "homebase")         == 0) return (0 << 4) | 0;
  if (strcmp(loc, "engineers_office") == 0) return (0 << 4) | 2;
  if (strcmp(loc, "storage_base")     == 0) return (2 << 4) | 1;
  if (strcmp(loc, "marine_port")      == 0) return (3 << 4) | 2;
  if (strcmp(loc, "admin_office")     == 0) return (1 << 4) | 1;
  return 0x00;
}

String coordToId(int x, int y) {
  if (x==0&&y==0) return "homebase";
  if (x==0&&y==2) return "engineers_office";
  if (x==2&&y==1) return "storage_base";
  if (x==3&&y==2) return "marine_port";
  if (x==1&&y==1) return "admin_office";
  return "unknown";
}

// -- Protocol bytes R4 -> mbot --------------------------------
#define CMD_GOTO        0xA1   // + 1 byte packed (x<<4)|y
#define CMD_OPEN_LID    0xB1
#define CMD_CLOSE_LID   0xB2
#define CMD_RETURN_HOME 0xC1

// -- Protocol bytes mbot -> R4 --------------------------------
#define EVT_ARRIVED     0xD1   // + 1 byte packed (x<<4)|y
#define EVT_LOAD_ON     0xD2
#define EVT_LOAD_OFF    0xD3
#define EVT_LID_OPENED  0xE1
#define EVT_WRONG_CODE  0xE2

// -- MQTT + WiFi ----------------------------------------------
WiFiSSLClient wifiClient;
MqttClient    mqttClient(wifiClient);

bool expectingCoord = false;

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);

  Serial.print("WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println(" OK " + WiFi.localIP().toString());

  mqttClient.setUsernamePassword(MQTT_USER, MQTT_PASS);
  Serial.print("MQTT");
  while (!mqttClient.connect(MQTT_BROKER, MQTT_PORT)) { delay(1000); Serial.print("."); }
  mqttClient.subscribe(TOPIC_CMD);
  mqttClient.onMessage(onMqttMessage);
  Serial.println(" OK");
}

void loop() {
  mqttClient.poll();

  while (Serial1.available()) {
    handleMbotByte((byte)Serial1.read());
  }

  if (!mqttClient.connected()) {
    delay(2000);
    mqttClient.connect(MQTT_BROKER, MQTT_PORT);
    mqttClient.subscribe(TOPIC_CMD);
  }
}

// -- MQTT -> mbot ---------------------------------------------
void onMqttMessage(int) {
  String raw = "";
  while (mqttClient.available()) raw += (char)mqttClient.read();
  Serial.println("IN: " + raw);

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, raw)) return;

  const char* action = doc["action"] | "";

  if (strcmp(action, "call") == 0) {
    byte loc = locationToByte(doc["pickup"] | "homebase");
    Serial1.write(CMD_GOTO); Serial1.write(loc);
    Serial.printf("-> GOTO pickup (%d,%d)\n", loc>>4, loc&0xF);
  }
  else if (strcmp(action, "deliver") == 0) {
    byte loc = locationToByte(doc["delivery"] | "homebase");
    Serial1.write(CMD_GOTO); Serial1.write(loc);
    Serial.printf("-> GOTO delivery (%d,%d)\n", loc>>4, loc&0xF);
  }
  else if (strcmp(action, "open_lid") == 0) {
    Serial1.write(CMD_OPEN_LID);
    Serial.println("-> OPEN_LID");
  }
  else if (strcmp(action, "close_lid") == 0) {
    Serial1.write(CMD_CLOSE_LID);
    Serial.println("-> CLOSE_LID");
  }
  else if (strcmp(action, "return_home") == 0) {
    Serial1.write(CMD_RETURN_HOME);
    Serial.println("-> RETURN_HOME");
  }
}

// -- mbot -> MQTT ---------------------------------------------
void handleMbotByte(byte b) {
  if (expectingCoord) {
    expectingCoord = false;
    int x = b >> 4, y = b & 0x0F;
    String id = coordToId(x, y);
    // Home = arrived_home, anywhere else = arrived_pickup or arrived_delivery
    // Website tracks context so we emit a single event; it handles both cases
    const char* evt = (x==0&&y==0) ? "arrived_home" : "arrived_location";
    publishEvent(evt);
    Serial.printf("mbot arrived at %s (%d,%d)\n", id.c_str(), x, y);
    return;
  }

  switch (b) {
    case EVT_ARRIVED:    expectingCoord = true;             break;
    case EVT_LOAD_ON:    publishEvent("load_detected");     break;
    case EVT_LOAD_OFF:   publishEvent("load_removed");      break;
    case EVT_LID_OPENED: publishEvent("box_opened");        break;
    case EVT_WRONG_CODE: publishEvent("wrong_passcode");    break;
    default: Serial.printf("Unknown byte 0x%02X\n", b);
  }
}

void publishEvent(const char* event) {
  StaticJsonDocument<64> doc;
  doc["event"] = event;
  String out; serializeJson(doc, out);
  mqttClient.beginMessage(TOPIC_STATUS, out.length(), false, 1);
  mqttClient.print(out);
  mqttClient.endMessage();
  Serial.println("OUT: " + out);
}
