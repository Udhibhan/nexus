// ============================================================
//  arduino_r4.ino  —  Arduino UNO R4 WiFi (bridge board)
//
//  Responsibilities:
//    - WiFi + MQTT (HiveMQ cloud) bridge
//    - Servo (box lid)
//    - HX711 load cell
//    - 4x3 matrix keypad (passcode entry)
//    - LCD display commands forwarded to mbot over Serial1
//    - Full delivery state machine
//
//  Wiring:
//    Servo            → D13
//    Load cell SCK    → A0       (HX711 CLK)
//    Load cell DT     → A1       (HX711 DAT)
//    Keypad rows      → D4 D5 D6 D7  (row 1-4)
//    Keypad cols      → D8 D9 D10    (col 1-3)
//    mbot TX (pin 1)  → R4 RX1 (D0)
//    mbot RX (pin 0)  → R4 TX1 (D1)
//    GND              → shared
//
//  Required libraries (Arduino Library Manager):
//    WiFiS3           (bundled with R4 board package)
//    ArduinoMqttClient
//    ArduinoJson
//    Servo            (built-in)
//    Keypad           (by Mark Stanley / Alexander Brevig)
//    HX711            (by bogde)
//
//  LCD is driven by the mbot — R4 sends display bytes over Serial1.
// ============================================================

#include <WiFiS3.h>
#include <ArduinoMqttClient.h>
#include <ArduinoJson.h>
#include <Servo.h>
#include <Keypad.h>
#include "HX711.h"

// ── Credentials ─────────────────────────────────────────────
const char* WIFI_SSID   = "demo";
const char* WIFI_PASS   = "pzac1245";
const char* MQTT_BROKER = "0dfa135da60e491aa2523c5c40ba3f2d.s1.eu.hivemq.cloud";
const int   MQTT_PORT   = 8883;
const char* MQTT_USER   = "mbot_epp";
const char* MQTT_PASS   = "Udnirora2658@";
const char* TOPIC_CMD   = "mbot_epp_2025/command";
const char* TOPIC_STATUS= "mbot_epp_2025/status";

// ── Servo ────────────────────────────────────────────────────
#define SERVO_PIN    13
#define SERVO_OPEN   90   // degrees — adjust for your mechanism
#define SERVO_CLOSED  0
Servo lidServo;

// ── Load cell (HX711) ────────────────────────────────────────
#define LC_DT  A1
#define LC_SCK A0
HX711 scale;
// Raw HX711 units above which a parcel is considered present.
// After calling scale.tare() at startup the value is near 0 when empty.
// Place a known weight and Serial.println(scale.get_value(1)) to calibrate.
#define LOAD_THRESHOLD 10000L
bool loadOnBot = false;

// ── Keypad (4 rows × 3 cols, D4–D10) ────────────────────────
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

// ── Serial protocol (R4 → mbot) ─────────────────────────────
#define CMD_GOTO        0xA1   // + coord byte (x<<4)|y
#define CMD_RETURN_HOME 0xC1
#define CMD_LCD_CLEAR   0xF0
#define CMD_LCD_LINE0   0xF1   // + 16 space-padded bytes for row 0
#define CMD_LCD_LINE1   0xF2   // + 16 space-padded bytes for row 1
#define EVT_ARRIVED     0xD1   // + coord byte  (mbot → R4)

// ── State machine ────────────────────────────────────────────
enum State {
  S_IDLE,
  S_GOING_PICKUP,
  S_AT_PICKUP,    // servo open, waiting for delivery details + load
  S_IN_TRANSIT,
  S_AT_DELIVERY,  // waiting for keypad passcode
  S_DELIVERED,    // lid open, waiting for load removal
  S_RETURNING
};
State state = S_IDLE;

// ── Delivery context ─────────────────────────────────────────
char deliveryDest[32]   = "";
char storedPasscode[5]  = "";   // 4 digits + null
bool deliverCmdReceived = false;
bool loadDetected       = false;

// ── Keypad entry ─────────────────────────────────────────────
String enteredCode  = "";
int    wrongCount   = 0;
bool   botLocked    = false;
#define MAX_WRONG 3

// ── Return-home timer ────────────────────────────────────────
unsigned long returnTimerStart = 0;
bool          pendingReturn    = false;
#define RETURN_DELAY_MS 3000

// ── mbot serial parser ───────────────────────────────────────
bool expectingCoord = false;

// ── MQTT ─────────────────────────────────────────────────────
WiFiSSLClient wifiClient;
MqttClient    mqttClient(wifiClient);

// ──────────────────────────────────────────────────────────────
//  Location helpers  (grid: max x=3, max y=2)
// ──────────────────────────────────────────────────────────────
byte locationToByte(const char* loc) {
  if (strcmp(loc, "homebase")          == 0) return (0 << 4) | 0;
  if (strcmp(loc, "engineers_office")  == 0) return (0 << 4) | 2;
  if (strcmp(loc, "storage_base")      == 0) return (2 << 4) | 1;
  if (strcmp(loc, "marine_port")       == 0) return (3 << 4) | 2;
  if (strcmp(loc, "admin_office")      == 0) return (1 << 4) | 1;
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

// ──────────────────────────────────────────────────────────────
//  LCD helpers — send display commands to mbot over Serial1
//  The mbot code handles CMD_LCD_LINE0/1 and writes to its I2C LCD.
// ──────────────────────────────────────────────────────────────
void lcdClear() {
  Serial1.write((byte)CMD_LCD_CLEAR);
}

// Send exactly 16 bytes (space-padded) for one LCD row.
void lcdLine(int row, const char* text) {
  byte cmd = (row == 0) ? (byte)CMD_LCD_LINE0 : (byte)CMD_LCD_LINE1;
  Serial1.write(cmd);
  uint8_t buf[16];
  memset(buf, ' ', 16);
  int len = min((int)strlen(text), 16);
  memcpy(buf, text, len);
  Serial1.write(buf, 16);
}

// ──────────────────────────────────────────────────────────────
//  Servo helpers
// ──────────────────────────────────────────────────────────────
void openLid()  { lidServo.write(SERVO_OPEN);   }
void closeLid() { lidServo.write(SERVO_CLOSED); }

// ──────────────────────────────────────────────────────────────
//  MQTT publish
// ──────────────────────────────────────────────────────────────
void publishEvent(const char* event) {
  StaticJsonDocument<64> doc;
  doc["event"] = event;
  String out;
  serializeJson(doc, out);
  mqttClient.beginMessage(TOPIC_STATUS, out.length(), false, 1);
  mqttClient.print(out);
  mqttClient.endMessage();
  Serial.println("OUT: " + out);
}

// ──────────────────────────────────────────────────────────────
//  Navigation helpers
// ──────────────────────────────────────────────────────────────
void sendGoto(byte coordByte) {
  Serial1.write((byte)CMD_GOTO);
  Serial1.write(coordByte);
}

void startTransit() {
  state = S_IN_TRANSIT;
  sendGoto(locationToByte(deliveryDest));
  lcdClear();
  lcdLine(0, "Delivering to:");
  // Shorten name to fit 16 chars
  char shortDest[17];
  strncpy(shortDest, deliveryDest, 16);
  shortDest[16] = '\0';
  lcdLine(1, shortDest);
  Serial.println("-> IN_TRANSIT to " + String(deliveryDest));
}

// ──────────────────────────────────────────────────────────────
//  Full state reset (called when bot returns home)
// ──────────────────────────────────────────────────────────────
void resetState() {
  state               = S_IDLE;
  deliverCmdReceived  = false;
  loadDetected        = false;
  loadOnBot           = false;
  wrongCount          = 0;
  botLocked           = false;
  pendingReturn       = false;
  enteredCode         = "";
  memset(storedPasscode,  0, sizeof(storedPasscode));
  memset(deliveryDest,    0, sizeof(deliveryDest));
}

// ──────────────────────────────────────────────────────────────
//  Keypad handler  (only active in S_AT_DELIVERY)
// ──────────────────────────────────────────────────────────────
void handleKeypad() {
  char key = keypad.getKey();
  if (!key) return;

  if (key == '#') {
    // ── Submit ──────────────────────────────────────────────
    if (enteredCode.equals(storedPasscode)) {
      openLid();
      publishEvent("box_opened");
      wrongCount = 0;
      state = S_DELIVERED;
      lcdClear();
      lcdLine(0, "Access Granted!");
      lcdLine(1, "Collect parcel");
    } else {
      wrongCount++;
      publishEvent("wrong_passcode");
      if (wrongCount >= MAX_WRONG) {
        botLocked = true;
        publishEvent("wrong_passcode_locked");
        lcdClear();
        lcdLine(0, "BOT LOCKED");
        lcdLine(1, "Contact admin");
      } else {
        char tries[16];
        snprintf(tries, 16, "%d tries left", MAX_WRONG - wrongCount);
        lcdClear();
        lcdLine(0, "Wrong code!");
        lcdLine(1, tries);
        delay(1500);
        lcdClear();
        lcdLine(0, "Password:");
        lcdLine(1, "");
      }
    }
    enteredCode = "";

  } else if (key == '*') {
    // ── Backspace ────────────────────────────────────────────
    if (enteredCode.length() > 0) {
      enteredCode.remove(enteredCode.length() - 1);
      char buf[17]; enteredCode.toCharArray(buf, 17);
      lcdLine(1, buf);
    }

  } else if (enteredCode.length() < 4) {
    // ── Digit ────────────────────────────────────────────────
    enteredCode += key;
    char buf[17]; enteredCode.toCharArray(buf, 17);
    lcdLine(1, buf);   // show digits as typed
  }
}

// ──────────────────────────────────────────────────────────────
//  mbot → R4 event bytes
// ──────────────────────────────────────────────────────────────
void handleMbotByte(byte b) {
  if (expectingCoord) {
    expectingCoord = false;
    int x = b >> 4, y = b & 0x0F;
    Serial.println("mbot arrived (" + String(x) + "," + String(y) + ") state=" + String(state));

    if (x == 0 && y == 0) {
      // ── Arrived home ────────────────────────────────────────
      publishEvent("arrived_home");
      lcdClear();
      lcdLine(0, "Home Base");
      lcdLine(1, "Ready");
      resetState();

    } else if (state == S_GOING_PICKUP) {
      // ── Arrived at pickup ────────────────────────────────────
      state = S_AT_PICKUP;
      openLid();
      publishEvent("arrived_location");
      lcdClear();
      lcdLine(0, "At Pickup");
      lcdLine(1, "Loading...");

    } else if (state == S_IN_TRANSIT) {
      // ── Arrived at delivery ──────────────────────────────────
      state      = S_AT_DELIVERY;
      wrongCount = 0;
      enteredCode = "";
      publishEvent("arrived_location");
      lcdClear();
      lcdLine(0, "Password:");
      lcdLine(1, "");
    }
    return;
  }

  if (b == EVT_ARRIVED) {
    expectingCoord = true;
  }
}

// ──────────────────────────────────────────────────────────────
//  MQTT → R4 command handler
// ──────────────────────────────────────────────────────────────
void onMqttMessage(int) {
  String raw = "";
  while (mqttClient.available()) raw += (char)mqttClient.read();
  Serial.println("IN: " + raw);

  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, raw)) return;
  const char* action = doc["action"] | "";

  // ── call: go to pickup location ─────────────────────────────
  if (strcmp(action, "call") == 0 && state == S_IDLE) {
    const char* pickup = doc["pickup"] | "homebase";
    sendGoto(locationToByte(pickup));
    state = S_GOING_PICKUP;
    lcdClear();
    lcdLine(0, "Going to pickup");
    char buf[17]; strncpy(buf, pickup, 16); buf[16] = '\0';
    lcdLine(1, buf);

  // ── deliver: store destination + passcode, navigate when ready ─
  } else if (strcmp(action, "deliver") == 0 && state == S_AT_PICKUP) {
    const char* dest = doc["delivery"] | "homebase";
    const char* pass = doc["passcode"] | "";
    strncpy(deliveryDest,   dest, sizeof(deliveryDest)  - 1);
    strncpy(storedPasscode, pass, sizeof(storedPasscode)- 1);
    deliverCmdReceived = true;

    if (loadDetected) {
      // Load already on bot — close lid and go
      closeLid();
      startTransit();
    } else {
      // Waiting for load to be placed
      lcdClear();
      lcdLine(0, "Place parcel");
      lcdLine(1, "Lid is open");
    }

  // ── return_home: manual override ────────────────────────────
  } else if (strcmp(action, "return_home") == 0) {
    closeLid();
    Serial1.write((byte)CMD_RETURN_HOME);
    state = S_RETURNING;
    pendingReturn = false;
    lcdClear();
    lcdLine(0, "Returning home");
    lcdLine(1, "");
  }
}

// ──────────────────────────────────────────────────────────────
//  Setup
// ──────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);

  // Servo — start closed
  lidServo.attach(SERVO_PIN);
  closeLid();

  // Load cell
  scale.begin(LC_DT, LC_SCK);
  delay(400);
  scale.tare();   // zero out with no load — keep bot empty at startup

  // WiFi
  Serial.print("WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println(" OK  " + WiFi.localIP().toString());

  // MQTT
  mqttClient.setUsernamePassword(MQTT_USER, MQTT_PASS);
  Serial.print("MQTT");
  while (!mqttClient.connect(MQTT_BROKER, MQTT_PORT)) { delay(1000); Serial.print("."); }
  mqttClient.subscribe(TOPIC_CMD);
  mqttClient.onMessage(onMqttMessage);
  Serial.println(" OK");

  // Initial LCD message (give mbot time to boot first)
  delay(600);
  lcdClear();
  lcdLine(0, "System Ready");
  lcdLine(1, "Bot at Home");
}

// ──────────────────────────────────────────────────────────────
//  Loop
// ──────────────────────────────────────────────────────────────
void loop() {
  // ── MQTT ─────────────────────────────────────────────────
  mqttClient.poll();

  // ── mbot serial events ───────────────────────────────────
  while (Serial1.available()) {
    handleMbotByte((byte)Serial1.read());
  }

  // ── Load cell ────────────────────────────────────────────
  if (scale.is_ready()) {
    long val = scale.get_value(1);   // raw - tare offset
    bool weightNow = (val > LOAD_THRESHOLD);

    if (!loadOnBot && weightNow) {
      // ── Load placed ──────────────────────────────────────
      loadOnBot    = true;
      loadDetected = true;
      publishEvent("load_detected");
      Serial.println("Load detected: " + String(val));

      if (deliverCmdReceived && state == S_AT_PICKUP) {
        closeLid();
        startTransit();
      } else if (state == S_AT_PICKUP) {
        // Delivery details not yet received — show waiting message
        lcdClear();
        lcdLine(0, "Load detected");
        lcdLine(1, "Awaiting route");
      }

    } else if (loadOnBot && !weightNow && state == S_DELIVERED) {
      // ── Load removed after delivery ──────────────────────
      loadOnBot = false;
      closeLid();
      publishEvent("load_removed");
      pendingReturn      = true;
      returnTimerStart   = millis();
      state              = S_RETURNING;
      lcdClear();
      lcdLine(0, "Parcel collected");
      lcdLine(1, "Returning in 3s");
      Serial.println("Load removed — returning in 3 s");
    }
  }

  // ── 3-second delay then return home ──────────────────────
  if (pendingReturn && (millis() - returnTimerStart >= RETURN_DELAY_MS)) {
    pendingReturn = false;
    Serial1.write((byte)CMD_RETURN_HOME);
    lcdLine(1, "Going home...");
  }

  // ── Keypad (only at delivery station) ────────────────────
  if (state == S_AT_DELIVERY && !botLocked) {
    handleKeypad();
  }

  // ── MQTT reconnect ───────────────────────────────────────
  if (!mqttClient.connected()) {
    delay(2000);
    mqttClient.connect(MQTT_BROKER, MQTT_PORT);
    mqttClient.subscribe(TOPIC_CMD);
  }
}
