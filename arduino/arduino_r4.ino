#include <WiFiS3.h>
#include <ArduinoMqttClient.h>
#include <ArduinoJson.h>
#include <Servo.h>
#include "HX711.h"
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Keypad.h>

// ── LCD i2c (on R4 SDA/SCL) — change 0x27 → 0x3F if blank ──
LiquidCrystal_I2C lcd(0x27, 16, 2);

// ── Keypad 4×3: rows D4-D7, cols D8-D10 ─────────────────────
const byte ROWS = 4, COLS = 3;
char keys[ROWS][COLS] = {
  {'1','2','3'},
  {'4','5','6'},
  {'7','8','9'},
  {'*','0','#'}
};
byte rowPins[ROWS] = {4, 5, 6, 7};
byte colPins[COLS] = {8, 9, 10};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

// ── WiFi / MQTT (unchanged) ──────────────────────────────────
const char* WIFI_SSID   = "demo";
const char* WIFI_PASS   = "pzac1245";
const char* MQTT_BROKER = "0dfa135da60e491aa2523c5c40ba3f2d.s1.eu.hivemq.cloud";
const int   MQTT_PORT   = 8883;
const char* MQTT_USER   = "mbot_epp";
const char* MQTT_PASS   = "Udnirora2658@";
const char* TOPIC_CMD   = "mbot_epp_2025/command";
const char* TOPIC_STATUS= "mbot_epp_2025/status";

// ── Servo ────────────────────────────────────────────────────
#define SERVO_CLOSED_DEG   0
#define SERVO_OPEN_DEG    90
#define SERVO_PIN         13
Servo lidServo;

// ── Load cell (HX711) ────────────────────────────────────────
#define DT_PIN  A1
#define SCK_PIN A0
#define CALIBRATION_FACTOR -958.25
HX711 scale;
float filteredWeight = 0;
bool  firstReading   = true;
const float alpha          = 0.2f;
const float resetThreshold = 0.6f;

float getFilteredWeight() {
  float w = scale.get_units(5);
  if (w < 0) w = 0;
  if (firstReading) { filteredWeight = w; firstReading = false; }
  else if (abs(w - filteredWeight) > resetThreshold) filteredWeight = w;
  else filteredWeight = alpha * w + (1 - alpha) * filteredWeight;
  return filteredWeight;
}

// ── State machine ────────────────────────────────────────────
enum State {
  S_IDLE,
  S_GOING_PICKUP,
  S_AT_PICKUP,
  S_WAITING_DELIVER,
  S_GOING_DELIVERY,
  S_AT_DELIVERY,
  S_RETURNING,
  S_LOCKED
};
State state = S_IDLE;

char storedPasscode[8] = "";
char enteredCode[8]    = "";
int  codeLen           = 0;
int  wrongCount        = 0;

// ── Location helpers ─────────────────────────────────────────
void locationToXY(const char* loc, int &x, int &y) {
  if      (strcmp(loc, "homebase")         == 0) { x=0; y=0; }
  else if (strcmp(loc, "engineers_office") == 0) { x=0; y=2; }
  else if (strcmp(loc, "storage_base")     == 0) { x=2; y=1; }
  else if (strcmp(loc, "marine_port")      == 0) { x=3; y=2; }
  else if (strcmp(loc, "admin_office")     == 0) { x=1; y=1; }
  else                                            { x=0; y=0; }
}

const char* locationLabel(const char* loc) {
  if (strcmp(loc, "homebase")         == 0) return "Home Base";
  if (strcmp(loc, "engineers_office") == 0) return "Engineers Off";
  if (strcmp(loc, "storage_base")     == 0) return "Storage Base";
  if (strcmp(loc, "marine_port")      == 0) return "Marine Port";
  if (strcmp(loc, "admin_office")     == 0) return "Admin Office";
  return "Unknown";
}

void sendGoto(int x, int y) {
  Serial1.println(String(x) + "," + String(y));
  Serial.println("-> mbot goto (" + String(x) + "," + String(y) + ")");
}

// ── LCD helpers ──────────────────────────────────────────────
void lcdLine(int row, const char* text) {
  lcd.setCursor(0, row);
  lcd.print("                ");
  lcd.setCursor(0, row);
  lcd.print(text);
}

// ── MQTT ─────────────────────────────────────────────────────
WiFiSSLClient wifiClient;
MqttClient    mqttClient(wifiClient);

void publishEvent(const char* event) {
  StaticJsonDocument<64> doc;
  doc["event"] = event;
  String out; serializeJson(doc, out);
  mqttClient.beginMessage(TOPIC_STATUS, out.length(), false, 1);
  mqttClient.print(out);
  mqttClient.endMessage();
  Serial.println("OUT: " + out);
}

// ── Pickup sequence ──────────────────────────────────────────
// Called after mbot reports ARRIVED at pickup.
// Opens servo, reads weight for 5 s, closes, publishes load_received.
void doPickupSequence() {
  state = S_AT_PICKUP;
  lcdLine(0, "Loading...");

  lidServo.write(SERVO_OPEN_DEG);
  Serial.println("Servo OPEN");

  unsigned long t0 = millis();
  while (millis() - t0 < 5000UL) {
    mqttClient.poll();
    float w = getFilteredWeight();
    char buf[16];
    snprintf(buf, sizeof(buf), "%.1f g", w);
    lcdLine(1, buf);
    delay(200);
  }

  lidServo.write(SERVO_CLOSED_DEG);
  Serial.println("Servo CLOSED");

  publishEvent("load_received");
  state = S_WAITING_DELIVER;
  lcdLine(0, "Load received");
  lcdLine(1, "Set dest...");
}

// ── OTP entry at delivery ────────────────────────────────────
void startOtpEntry() {
  codeLen    = 0;
  wrongCount = 0;
  memset(enteredCode, 0, sizeof(enteredCode));
  lcdLine(0, "Enter OTP:");
  lcdLine(1, "");
}

void updateOtpDisplay() {
  char buf[17];
  memset(buf, ' ', 16);
  buf[16] = '\0';
  for (int i = 0; i < codeLen; i++) buf[i] = '*';
  lcdLine(1, buf);
}

void handleKeypad() {
  if (state != S_AT_DELIVERY) return;
  char key = keypad.getKey();
  if (!key) return;

  if (key == '*') {
    // backspace
    if (codeLen > 0) { codeLen--; enteredCode[codeLen] = '\0'; updateOtpDisplay(); }

  } else if (key == '#') {
    // submit
    enteredCode[codeLen] = '\0';
    if (strcmp(enteredCode, storedPasscode) == 0) {
      lcdLine(0, "Correct!");
      lcdLine(1, "Opening...");
      lidServo.write(SERVO_OPEN_DEG);
      Serial.println("Correct passcode — opening");
      publishEvent("box_opened");

      unsigned long t0 = millis();
      while (millis() - t0 < 5000UL) { mqttClient.poll(); delay(10); }

      lidServo.write(SERVO_CLOSED_DEG);
      Serial.println("Servo CLOSED");

      Serial1.println("PASSCODE_OK");
      state = S_RETURNING;
      lcdLine(0, "Returning...");
      lcdLine(1, "");

    } else {
      wrongCount++;
      publishEvent("wrong_passcode");

      if (wrongCount >= 3) {
        state = S_LOCKED;
        publishEvent("wrong_passcode_locked");
        lcdLine(0, "LOCKED!");
        lcdLine(1, "3 wrong attempts");
        Serial.println("Bot LOCKED");
      } else {
        char buf[16];
        snprintf(buf, sizeof(buf), "Wrong! %d/3", wrongCount);
        lcdLine(0, buf);
        lcdLine(1, "Try again:");
        delay(2000);
        codeLen = 0;
        memset(enteredCode, 0, sizeof(enteredCode));
        lcdLine(0, "Enter OTP:");
        lcdLine(1, "");
      }
    }

  } else if (codeLen < 4) {
    // digit
    enteredCode[codeLen++] = key;
    updateOtpDisplay();
  }
}

// ── mbot serial line handler ─────────────────────────────────
void handleMbotLine(String line) {
  line.trim();
  Serial.println("mbot: " + line);

  if (line == "READY") {
    Serial.println("mbot ready");
    lcdLine(0, "BASE");
    lcdLine(1, "Bot ready");

  } else if (line == "ARRIVED") {
    publishEvent("arrived_location");
    Serial.println("-> Arrived at pickup. Starting pickup sequence.");
    doPickupSequence();

  } else if (line == "ARRIVED_DELIVERY") {
    publishEvent("arrived_location");
    Serial.println("-> Arrived at delivery.");
    state = S_AT_DELIVERY;
    startOtpEntry();

  } else if (line == "HOME") {
    state = S_IDLE;
    publishEvent("arrived_home");
    Serial.println("-> Bot back at home.");
    lcdLine(0, "BASE");
    lcdLine(1, "Ready");
  }
}

// Serial1 line buffer
String mbotBuf = "";

// ── MQTT command handler ─────────────────────────────────────
void onMqttMessage(int) {
  String raw = "";
  while (mqttClient.available()) raw += (char)mqttClient.read();
  Serial.println("IN: " + raw);

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, raw)) return;
  const char* action = doc["action"] | "";

  if (strcmp(action, "call") == 0) {
    const char* pickup = doc["pickup"] | "homebase";
    int x, y;
    locationToXY(pickup, x, y);
    sendGoto(x, y);
    state = S_GOING_PICKUP;
    lcdLine(0, "Going to:");
    lcdLine(1, locationLabel(pickup));

  } else if (strcmp(action, "deliver") == 0) {
    const char* dest = doc["delivery"] | "homebase";
    const char* pc   = doc["passcode"] | "";
    strncpy(storedPasscode, pc, sizeof(storedPasscode) - 1);
    storedPasscode[sizeof(storedPasscode) - 1] = '\0';
    int x, y;
    locationToXY(dest, x, y);
    sendGoto(x, y);
    state = S_GOING_DELIVERY;
    lcdLine(0, "Delivering to:");
    lcdLine(1, locationLabel(dest));

  } else if (strcmp(action, "return_home") == 0) {
    sendGoto(0, 0);
    state = S_RETURNING;
    lcdLine(0, "Returning home");
    lcdLine(1, "");
  }
}

// ── Setup ────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial1.begin(115200);

  // LCD
  Wire.begin();
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcdLine(0, "Starting...");

  // Servo — start closed
  lidServo.attach(SERVO_PIN);
  lidServo.write(SERVO_CLOSED_DEG);

  // Load cell
  scale.begin(DT_PIN, SCK_PIN);
  scale.set_scale(CALIBRATION_FACTOR);
  scale.tare(20);
  Serial.println("Load cell ready");
  lcdLine(1, "Scale OK");

  // WiFi
  Serial.print("WiFi");
  lcdLine(1, "WiFi...");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println(" OK " + WiFi.localIP().toString());

  // MQTT
  lcdLine(1, "MQTT...");
  mqttClient.setUsernamePassword(MQTT_USER, MQTT_PASS);
  Serial.print("MQTT");
  while (!mqttClient.connect(MQTT_BROKER, MQTT_PORT)) { delay(1000); Serial.print("."); }
  mqttClient.subscribe(TOPIC_CMD);
  mqttClient.onMessage(onMqttMessage);
  Serial.println(" OK");

  lcdLine(0, "BASE");
  lcdLine(1, "Ready");
}

// ── Loop ─────────────────────────────────────────────────────
void loop() {
  mqttClient.poll();

  handleKeypad();

  while (Serial1.available()) {
    char c = (char)Serial1.read();
    if (c == '\n') {
      if (mbotBuf.length() > 0) handleMbotLine(mbotBuf);
      mbotBuf = "";
    } else if (c != '\r') {
      mbotBuf += c;
    }
  }

  if (!mqttClient.connected()) {
    delay(2000);
    mqttClient.connect(MQTT_BROKER, MQTT_PORT);
    mqttClient.subscribe(TOPIC_CMD);
  }
}
