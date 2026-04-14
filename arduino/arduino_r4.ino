#include <WiFiS3.h>
#include <ArduinoMqttClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID   = "YourWiFiName";
const char* WIFI_PASS   = "YourWiFiPass";
const char* MQTT_BROKER = "YOUR_CLUSTER.s2.eu.hivemq.cloud";
const int   MQTT_PORT   = 8883;
const char* MQTT_USER   = "your_hivemq_user";
const char* MQTT_PASS   = "your_hivemq_pass";
const char* TOPIC_CMD    = "mbot_epp_2025/command";
const char* TOPIC_STATUS = "mbot_epp_2025/status";

WiFiSSLClient wifiClient;
MqttClient    mqttClient(wifiClient);

// Location ID → "x,y\n" string
String locationToCoord(const char* loc) {
  if (strcmp(loc, "homebase")          == 0) return "0,0";
  if (strcmp(loc, "engineers_office")  == 0) return "0,2";
  if (strcmp(loc, "storage_base")      == 0) return "2,1";
  if (strcmp(loc, "marine_port")       == 0) return "3,2";
  if (strcmp(loc, "admin_office")      == 0) return "1,1";
  return "0,0";
}

void publishEvent(const char* event) {
  StaticJsonDocument<64> doc;
  doc["event"] = event;
  String out; serializeJson(doc, out);
  mqttClient.beginMessage(TOPIC_STATUS, out.length(), false, 1);
  mqttClient.print(out);
  mqttClient.endMessage();
  Serial.println("MQTT OUT: " + out);
}

void onMqttMessage(int) {
  String raw = "";
  while (mqttClient.available()) raw += (char)mqttClient.read();
  Serial.println("MQTT IN: " + raw);

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, raw)) return;

  const char* action = doc["action"] | "";

  if (strcmp(action, "call") == 0) {
    // Send pickup coordinates to mbot
    String coord = locationToCoord(doc["pickup"] | "homebase");
    Serial1.println(coord);
    Serial.println("→ mbot: " + coord);
  }
  else if (strcmp(action, "deliver") == 0) {
    // Send delivery coordinates to mbot
    String coord = locationToCoord(doc["delivery"] | "homebase");
    Serial1.println(coord);
    Serial.println("→ mbot: " + coord);
  }
  else if (strcmp(action, "passcode_ok") == 0) {
    // Relay to mbot — simulates keypad confirmation
    Serial1.println("PASSCODE_OK");
    Serial.println("→ mbot: PASSCODE_OK");
  }
  else if (strcmp(action, "return_home") == 0) {
    Serial1.println("PASSCODE_OK"); // same path — wait 3s, go home
  }
}

// Read status strings from mbot and forward as MQTT events
void handleMbotSerial() {
  if (!Serial1.available()) return;
  String msg = Serial1.readStringUntil('\n');
  msg.trim();
  if (msg.length() == 0) return;

  Serial.println("mbot says: " + msg);

  if (msg == "ARRIVED")          publishEvent("arrived_pickup");
  else if (msg == "ARRIVED_DELIVERY") publishEvent("arrived_delivery");
  else if (msg == "HOME")        publishEvent("arrived_home");
  else if (msg == "READY")       Serial.println("mbot ready");
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);   // to mbot — note: mbot must also be 115200

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
  handleMbotSerial();

  if (!mqttClient.connected()) {
    delay(2000);
    mqttClient.connect(MQTT_BROKER, MQTT_PORT);
    mqttClient.subscribe(TOPIC_CMD);
  }
}