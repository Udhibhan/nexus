#include <MeMCore.h>

MeLineFollower lineFinder(PORT_2);
MeDCMotor leftMotor(M1);
MeDCMotor rightMotor(M2);

// ===== Motion tuning =====
#define BASE_SPEED        175
#define TURN_SPEED        140
#define TURN_TIME_90      750
#define NODE_DEBOUNCE     600
#define CENTER_SPEED      135
#define POST_TURN_DELAY   80

#define CLEAR_MIN_PUSH_MS    320
#define CLEAR_MAX_PUSH_MS    650
#define CLEAR_CONFIRM_MS      35
#define CLEAR_STOP_MS         40

#define PID_DT_MS 2

float Kp = 120;
float Kd = 20;
float lastError = 0;
#define MAX_CORRECTION 90

int currentX = 0;
int currentY = 0;
int heading   = 0; // 0=N,1=E,2=S,3=W

// Track what phase the bot is in
// 0 = idle at home
// 1 = went to pickup, waiting for delivery command
// 2 = went to delivery, waiting for passcode confirmation
int botPhase = 0;

unsigned long lastNodeTime = 0;

// ── Motors ──────────────────────────────────────────────
void setMotor(int left, int right) {
  leftMotor.run(-constrain(left,  -255, 255));
  rightMotor.run( constrain(right, -255, 255));
}
void stopMotors() { setMotor(0, 0); }

// ── PID ─────────────────────────────────────────────────
float sensorErrorFrom(int s) {
  if (s == 2) return  1;
  if (s == 1) return -1;
  return 0;
}

void pidStep(int baseSpeed) {
  int s = lineFinder.readSensors();
  float error = sensorErrorFrom(s);
  float dError = error - lastError;
  if (abs(dError) > 1.5) dError = 0;
  float correction = constrain(Kp * error + Kd * dError, -MAX_CORRECTION, MAX_CORRECTION);
  lastError = error;
  setMotor((int)(baseSpeed + correction), (int)(baseSpeed - correction));
}

// ── Clear node before turns ──────────────────────────────
void clearNodeBeforeTurn() {
  lastError = 0;
  unsigned long t0 = millis();
  setMotor(CENTER_SPEED, CENTER_SPEED);
  while (millis() - t0 < CLEAR_MIN_PUSH_MS) delay(PID_DT_MS);

  unsigned long offNodeStart = 0;
  t0 = millis();
  while (millis() - t0 < CLEAR_MAX_PUSH_MS) {
    int s = lineFinder.readSensors();
    if (s != 3) {
      if (offNodeStart == 0) offNodeStart = millis();
      if (millis() - offNodeStart >= CLEAR_CONFIRM_MS) break;
    } else {
      offNodeStart = 0;
    }
    setMotor(CENTER_SPEED, CENTER_SPEED);
    delay(PID_DT_MS);
  }
  stopMotors();
  delay(CLEAR_STOP_MS);
  lastError = 0;
}

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

// ── Turns ────────────────────────────────────────────────
void executeTurnRight() {
  leftMotor.run(-TURN_SPEED);
  rightMotor.run(-TURN_SPEED);
  delay(TURN_TIME_90);
  stopMotors();
  delay(POST_TURN_DELAY);
  lastError = 0;
}

void executeTurnLeft() {
  leftMotor.run(TURN_SPEED);
  rightMotor.run(TURN_SPEED);
  delay(TURN_TIME_90);
  stopMotors();
  delay(POST_TURN_DELAY);
  lastError = 0;
}

void turnTo(int targetHeading) {
  clearNodeBeforeTurn();
  int diff = (targetHeading - heading + 4) % 4;
  if      (diff == 1) executeTurnRight();
  else if (diff == 3) executeTurnLeft();
  else if (diff == 2) { executeTurnRight(); executeTurnRight(); }
  heading = targetHeading;
}

// ── Forward one node ─────────────────────────────────────
void updatePositionAfterNode() {
  if      (heading == 0) currentY++;
  else if (heading == 1) currentX++;
  else if (heading == 2) currentY--;
  else if (heading == 3) currentX--;
}

void moveForwardOneNode() {
  lastError = 0;
  unsigned long creepStart = millis();
  while (millis() - creepStart < 600) {
    if (lineFinder.readSensors() != 3) break;
    setMotor(CENTER_SPEED, CENTER_SPEED);
    delay(PID_DT_MS);
  }
  lastError = 0;

  while (true) {
    int s = lineFinder.readSensors();
    if (s == 3 && millis() - lastNodeTime > NODE_DEBOUNCE) {
      lastNodeTime = millis();
      stopMotors();
      break;
    }
    pidStep(BASE_SPEED);
    delay(PID_DT_MS);
  }

  updatePositionAfterNode();
  centerOverNode();
  stopMotors();
}

// ── Navigation ───────────────────────────────────────────
void goToLeg(int targetX, int targetY) {
  if (targetY > currentY) turnTo(0);
  else if (targetY < currentY) turnTo(2);
  while (currentY != targetY) moveForwardOneNode();

  if (targetX > currentX) turnTo(1);
  else if (targetX < currentX) turnTo(3);
  while (currentX != targetX) moveForwardOneNode();

  stopMotors();
  delay(120);
}

void goTo(int targetX, int targetY) {
  if (targetY != currentY && targetX != currentX) {
    goToLeg(currentX, targetY);
    goToLeg(targetX, targetY);
  } else {
    goToLeg(targetX, targetY);
  }
}

// ── Serial command handler ───────────────────────────────
void handleSerial(String input) {
  input.trim();
  if (input.length() == 0) return;

  // "PASSCODE_OK" — simulate keypad confirmation at delivery
  if (input == "PASSCODE_OK") {
    delay(3000);              // wait 3 seconds at delivery station
    goTo(0, 0);               // return home
    botPhase = 0;
    Serial.println("HOME");   // tell R4 we're back
    return;
  }

  // Coordinate command: "x,y"
  int commaIndex = input.indexOf(',');
  if (commaIndex == -1) return;

  int x = input.substring(0, commaIndex).toInt();
  int y = input.substring(commaIndex + 1).toInt();

  goTo(x, y);

  // Report arrival based on phase
  if (botPhase == 0) {
    // Just arrived at pickup
    botPhase = 1;
    Serial.println("ARRIVED");          // pickup arrival
  } else if (botPhase == 1) {
    // Just arrived at delivery
    botPhase = 2;
    Serial.println("ARRIVED_DELIVERY"); // delivery arrival
    // Now wait for PASSCODE_OK from R4
  }
}

void setup() {
  Serial.begin(115200);
  lastNodeTime = millis();
  // Signal ready
  Serial.println("READY");
}

void loop() {
  if (Serial.available()) {
    String input = Serial.readStringUntil('\n');
    handleSerial(input);
  }
}