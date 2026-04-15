// ============================================================
//  mbot.ino  —  mbot (mCore / ATmega328P)
//
//  Responsibilities:
//    - Line-following grid navigation
//    - LCD display (I2C on mCore SDA/SCL, addr 0x27)
//    - Binary serial protocol with Arduino R4 @ 9600 baud
//
//  Wiring:
//    Line follower   : PORT_2
//    Motors          : M1 (left), M2 (right)
//    LCD 16x2 I2C    : SDA + SCL + GND + 5V on mCore
//    R4 TX1 (pin 1)  : mCore RX (pin 0)
//    R4 RX1 (pin 0)  : mCore TX (pin 1)
//    ** Unplug mCore USB while R4 serial wires are connected **
//
//  Grid design expected:
//    White squares at each node, black lines connecting them.
//    lineFinder.readSensors() == 3  →  both on white = AT A NODE
//    lineFinder.readSensors() == 1  →  left on black only
//    lineFinder.readSensors() == 2  →  right on black only
//
//  Heading convention:
//    0 = North (+Y)   1 = East (+X)   2 = South (-Y)   3 = West (-X)
// ============================================================

#include <MeMCore.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ── Hardware ─────────────────────────────────────────────────
MeLineFollower    lineFinder(PORT_2);
MeDCMotor         leftMotor(M1);
MeDCMotor         rightMotor(M2);
LiquidCrystal_I2C lcd(0x3F, 16, 2);   // change to 0x27 if still blank

// ── Motion tuning ────────────────────────────────────────────
// Adjust TURN_TIME_90 until a 90° in-place turn is exact on your surface.
#define BASE_SPEED       175
#define TURN_SPEED       140
#define TURN_TIME_90     750    // ms for 90° pivot
#define NODE_DEBOUNCE    600    // ms — ignore re-trigger after node hit
#define CENTER_SPEED     135
#define POST_TURN_DELAY   80

#define CLEAR_MIN_MS     320
#define CLEAR_MAX_MS     650
#define CLEAR_CONFIRM_MS  35
#define CLEAR_STOP_MS     40

#define PID_DT_MS          2
float Kp = 120.0f, Kd = 20.0f, lastError = 0.0f;
#define MAX_CORRECTION    90

// ── Position / heading ───────────────────────────────────────
int  currentX    = 0;
int  currentY    = 0;
int  heading     = 0;   // 0=N 1=E 2=S 3=W
unsigned long lastNodeTime = 0;

// ── Serial protocol (R4 ↔ mbot) ──────────────────────────────
// From R4:
#define CMD_GOTO        0xA1   // followed by 1 coord byte: (x<<4)|y
#define CMD_RETURN_HOME 0xC1
#define CMD_LCD_CLEAR   0xF0
#define CMD_LCD_LINE0   0xF1   // followed by exactly 16 bytes (space-padded)
#define CMD_LCD_LINE1   0xF2   // followed by exactly 16 bytes (space-padded)
// To R4:
#define EVT_ARRIVED     0xD1   // followed by 1 coord byte

// ── Parser state ─────────────────────────────────────────────
bool expectingCoord  = false;
bool inLcdCmd        = false;
int  lcdRow          = 0;
int  lcdBytesRead    = 0;
char lcdBuf[17];

// ──────────────────────────────────────────────────────────────
//  Motors
// ──────────────────────────────────────────────────────────────
void setMotor(int l, int r) {
  leftMotor.run(-constrain(l, -255, 255));
  rightMotor.run( constrain(r, -255, 255));
}
void stopMotors() { setMotor(0, 0); }

// ──────────────────────────────────────────────────────────────
//  PID
// ──────────────────────────────────────────────────────────────
float sensorErr(int s) {
  if (s == 2) return  1.0f;
  if (s == 1) return -1.0f;
  return 0.0f;
}
void pidStep(int spd) {
  int   s    = lineFinder.readSensors();
  float err  = sensorErr(s);
  float dErr = err - lastError;
  if (abs(dErr) > 1.5f) dErr = 0;
  float corr = constrain(Kp * err + Kd * dErr,
                         -(float)MAX_CORRECTION, (float)MAX_CORRECTION);
  lastError = err;
  setMotor((int)(spd + corr), (int)(spd - corr));
}

// ──────────────────────────────────────────────────────────────
//  Intersection helpers
// ──────────────────────────────────────────────────────────────
// Push bot forward past the current node marker before a turn.
void clearNodeBeforeTurn() {
  lastError = 0;
  unsigned long t0 = millis();
  setMotor(CENTER_SPEED, CENTER_SPEED);
  while (millis() - t0 < CLEAR_MIN_MS) delay(PID_DT_MS);

  unsigned long offStart = 0;
  t0 = millis();
  while (millis() - t0 < CLEAR_MAX_MS) {
    int s = lineFinder.readSensors();
    if (s != 3) {
      if (!offStart) offStart = millis();
      if (millis() - offStart >= CLEAR_CONFIRM_MS) break;
    } else {
      offStart = 0;
    }
    setMotor(CENTER_SPEED, CENTER_SPEED);
    delay(PID_DT_MS);
  }
  stopMotors();
  delay(CLEAR_STOP_MS);
  lastError = 0;
}

// Nudge forward to center over a freshly-detected node.
void centerOverNode() {
  lastError = 0;
  unsigned long t = millis();
  while (millis() - t < 250) {
    if (lineFinder.readSensors() != 3) break;
    setMotor(CENTER_SPEED, CENTER_SPEED);
    delay(PID_DT_MS);
  }
  stopMotors();
  delay(60);
  lastError = 0;
}

// ──────────────────────────────────────────────────────────────
//  Turns
// ──────────────────────────────────────────────────────────────
void doTurnRight() {
  leftMotor.run(-TURN_SPEED);
  rightMotor.run(-TURN_SPEED);
  delay(TURN_TIME_90);
  stopMotors();
  delay(POST_TURN_DELAY);
  lastError = 0;
}
void doTurnLeft() {
  leftMotor.run(TURN_SPEED);
  rightMotor.run(TURN_SPEED);
  delay(TURN_TIME_90);
  stopMotors();
  delay(POST_TURN_DELAY);
  lastError = 0;
}

void turnTo(int target) {
  int diff = (target - heading + 4) % 4;
  if (diff == 0) { heading = target; return; }  // already facing right way — no clear needed
  clearNodeBeforeTurn();
  if      (diff == 1) doTurnRight();
  else if (diff == 3) doTurnLeft();
  else                { doTurnRight(); doTurnRight(); }  // 180°
  heading = target;
}

// ──────────────────────────────────────────────────────────────
//  Move one node
// ──────────────────────────────────────────────────────────────
void updatePos() {
  if      (heading == 0) currentY++;
  else if (heading == 1) currentX++;
  else if (heading == 2) currentY--;
  else                   currentX--;
}

void moveForwardOneNode() {
  lastError = 0;
  // Phase 1: creep off current node (sensors on white, s==3) → onto path
  unsigned long t = millis();
  while (millis() - t < 600) {
    if (lineFinder.readSensors() != 3) break;
    setMotor(CENTER_SPEED, CENTER_SPEED);
    delay(PID_DT_MS);
  }
  lastError = 0;
  // Phase 2: PID along path until next node marker (s==3 again, debounced)
  while (true) {
    int s = lineFinder.readSensors();
    if (s == 3 && (millis() - lastNodeTime) > NODE_DEBOUNCE) {
      lastNodeTime = millis();
      stopMotors();
      break;
    }
    pidStep(BASE_SPEED);
    delay(PID_DT_MS);
  }
  updatePos();
  centerOverNode();
  stopMotors();
}

// ──────────────────────────────────────────────────────────────
//  Navigation: Y first, then X
// ──────────────────────────────────────────────────────────────
void goToLeg(int tx, int ty) {
  if      (ty > currentY) turnTo(0);
  else if (ty < currentY) turnTo(2);
  while (currentY != ty) moveForwardOneNode();

  if      (tx > currentX) turnTo(1);
  else if (tx < currentX) turnTo(3);
  while (currentX != tx) moveForwardOneNode();

  stopMotors();
  delay(120);
}

void goTo(int tx, int ty) {
  if (ty != currentY && tx != currentX) {
    goToLeg(currentX, ty);  // Y leg first (keep X fixed)
    goToLeg(tx,       ty);  // X leg
  } else {
    goToLeg(tx, ty);
  }
}

// ──────────────────────────────────────────────────────────────
//  Binary command handler (called from loop)
// ──────────────────────────────────────────────────────────────
void handleByte(byte b) {

  // Accumulate LCD payload (fixed 16-byte rows)
  if (inLcdCmd) {
    lcdBuf[lcdBytesRead++] = (char)b;
    if (lcdBytesRead >= 16) {
      lcdBuf[16] = '\0';
      lcd.setCursor(0, lcdRow);
      lcd.print(lcdBuf);
      inLcdCmd = false;
    }
    return;
  }

  // Second byte of CMD_GOTO
  if (expectingCoord) {
    expectingCoord = false;
    int x = b >> 4;
    int y = b & 0x0F;
    goTo(x, y);
    Serial.write(EVT_ARRIVED);
    Serial.write(b);   // echo back the same coord byte
    return;
  }

  switch (b) {
    case CMD_GOTO:
      expectingCoord = true;
      break;

    case CMD_RETURN_HOME:
      goTo(0, 0);
      Serial.write(EVT_ARRIVED);
      Serial.write((byte)0x00);
      break;

    case CMD_LCD_CLEAR:
      lcd.clear();
      break;

    case CMD_LCD_LINE0:
      inLcdCmd     = true;
      lcdRow       = 0;
      lcdBytesRead = 0;
      break;

    case CMD_LCD_LINE1:
      inLcdCmd     = true;
      lcdRow       = 1;
      lcdBytesRead = 0;
      break;

    default:
      break;
  }
}

// ──────────────────────────────────────────────────────────────
//  Setup / Loop
// ──────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(9600);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print("MBot Ready");
  lcd.setCursor(0, 1); lcd.print("At Home (0,0)");
  lastNodeTime = millis();
}

void loop() {
  if (Serial.available()) {
    handleByte((byte)Serial.read());
  }
}
