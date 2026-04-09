// =============================================================
// mbot Delivery — mbot (mCore / ATmega328P)
//
// Libraries needed:
//   - MakeBlock (install from Makeblock GitHub or IDE manager)
//   - Servo     (built in)
//
// Wiring:
//   Load cell sensor  -> A0 (analog, raw voltage threshold)
//   Servo (box lid)   -> Pin 5
//   Ultrasonic        -> PORT_3
//   Line follower     -> PORT_2
//   R4 TX             -> Pin 0 (mbot RX)
//   R4 RX             -> Pin 1 (mbot TX)
//   *** Unplug mbot USB before connecting R4 wires ***
// =============================================================

#include <MeMCore.h>
#include <Servo.h>

// -- Hardware -------------------------------------------------
MeDCMotor         motorL(M1);
MeDCMotor         motorR(M2);
MeUltrasonicSensor ultrasonic(PORT_3);
MeLineFollower    lineSensor(PORT_2);
Servo             lidServo;

#define SERVO_PIN       5
#define LOAD_CELL_PIN   A0
#define LOAD_THRESHOLD  400   // tune: analogRead above this = load present
#define OBSTACLE_CM     15
#define CELL_SPEED      180
#define TURN_MS         450   // tune until 90deg exact
#define CLEAR_MS        280   // ms to drive off current intersection before line-following

// -- Protocol bytes R4 -> mbot --------------------------------
#define CMD_GOTO        0xA1
#define CMD_OPEN_LID    0xB1
#define CMD_CLOSE_LID   0xB2
#define CMD_RETURN_HOME 0xC1

// -- Protocol bytes mbot -> R4 --------------------------------
#define EVT_ARRIVED     0xD1
#define EVT_LOAD_ON     0xD2
#define EVT_LOAD_OFF    0xD3
#define EVT_LID_OPENED  0xE1
#define EVT_WRONG_CODE  0xE2

// -- Bot state ------------------------------------------------
int curX = 0, curY = 0;
int heading = 0;   // 0=East(+x) 1=North(+y) 2=West(-x) 3=South(-y)
const int DHX[] = { 1, 0,-1, 0};
const int DHY[] = { 0, 1, 0,-1};

bool loadPresent = false;
bool expectingCoord = false;

// -- Setup ----------------------------------------------------
void setup() {
  Serial.begin(9600);
  lidServo.attach(SERVO_PIN);
  lidServo.write(0);   // closed
  pinMode(LED_BUILTIN, OUTPUT);
  flashLED(3, 200);    // startup signal
}

// -- Loop -----------------------------------------------------
void loop() {
  handleSerial();
  monitorLoadCell();
}

// -- Serial handler -------------------------------------------
void handleSerial() {
  if (!Serial.available()) return;
  byte b = Serial.read();

  if (expectingCoord) {
    expectingCoord = false;
    int tx = b >> 4;
    int ty = b & 0x0F;
    moveTo(tx, ty);
    sendArrived();
    return;
  }

  switch (b) {
    case CMD_GOTO:
      expectingCoord = true;
      break;
    case CMD_OPEN_LID:
      openLid();
      break;
    case CMD_CLOSE_LID:
      closeLid();
      break;
    case CMD_RETURN_HOME:
      moveTo(0, 0);
      sendArrived();
      break;
  }
}

// -- Load cell monitor ----------------------------------------
void monitorLoadCell() {
  int val = analogRead(LOAD_CELL_PIN);
  bool hasLoad = (val > LOAD_THRESHOLD);
  if (hasLoad && !loadPresent) {
    loadPresent = true;
    Serial.write(EVT_LOAD_ON);
  } else if (!hasLoad && loadPresent) {
    loadPresent = false;
    Serial.write(EVT_LOAD_OFF);
  }
}

// -- Status senders -------------------------------------------
void sendArrived() {
  byte coord = (byte)((curX << 4) | (curY & 0x0F));
  Serial.write(EVT_ARRIVED);
  Serial.write(coord);
}

// -- Lid control ----------------------------------------------
void openLid() {
  lidServo.write(90);   // adjust angle to your servo/mechanism
  delay(500);
  Serial.write(EVT_LID_OPENED);
  flashLED(2, 150);
}

void closeLid() {
  lidServo.write(0);
  delay(500);
}

// -- Navigation -----------------------------------------------
void moveTo(int tx, int ty) {
  // Move X axis first, then Y
  while (curX != tx) {
    turnToHeading(tx > curX ? 0 : 2);
    stepForward();
    curX += DHX[heading];
  }
  while (curY != ty) {
    turnToHeading(ty > curY ? 1 : 3);
    stepForward();
    curY += DHY[heading];
  }
  stopMotors();
  flashLED(1, 400);
}

void turnToHeading(int target) {
  int diff = (target - heading + 4) % 4;
  if      (diff == 1) { turnLeft();  }
  else if (diff == 2) { turnLeft();  turnLeft(); }
  else if (diff == 3) { turnRight(); }
  heading = target;
}

void stepForward() {
  // Obstacle check before moving
  float dist = ultrasonic.distanceCm();
  if (dist > 0 && dist < OBSTACLE_CM) {
    stopMotors();
    while (ultrasonic.distanceCm() < OBSTACLE_CM) delay(200);
    delay(400);
  }

  // Drive off current intersection
  motorL.run(-CELL_SPEED);
  motorR.run(CELL_SPEED);
  delay(CLEAR_MS);

  // Line-follow until next intersection
  bool clearedStart = false;
  unsigned long t = millis();
  while (millis() - t < 6000) {
    int s = lineSensor.read();
    if (s != 0) clearedStart = true;
    if (s == 0 && clearedStart) {
      stopMotors();
      delay(60);
      return;
    }
    // Correction
    if      (s == 1) { motorL.run(-CELL_SPEED); motorR.run(CELL_SPEED / 2); }
    else if (s == 2) { motorL.run(-CELL_SPEED / 2); motorR.run(CELL_SPEED); }
    else             { motorL.run(-CELL_SPEED); motorR.run(CELL_SPEED);      }
  }
  stopMotors(); // timeout
}

void turnLeft() {
  motorL.run(CELL_SPEED);
  motorR.run(CELL_SPEED);
  delay(TURN_MS);
  stopMotors();
  delay(100);
}

void turnRight() {
  motorL.run(-CELL_SPEED);
  motorR.run(-CELL_SPEED);
  delay(TURN_MS);
  stopMotors();
  delay(100);
}

void stopMotors() {
  motorL.stop();
  motorR.stop();
}

void flashLED(int n, int ms) {
  for (int i = 0; i < n; i++) {
    digitalWrite(LED_BUILTIN, HIGH); delay(ms);
    digitalWrite(LED_BUILTIN, LOW);  delay(ms);
  }
}
