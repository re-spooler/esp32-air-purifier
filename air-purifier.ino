/*
 * ============================================================
 *  TJC 串口屏 + BLE 双通道 · 三档风扇控制
 *  平台：ESP32-C3（Arduino-ESP32 core 2.x / 3.x 均可编译）
 *  依赖：NimBLE-Arduino >= 2.0（库管理器搜 "NimBLE-Arduino" 安装）
 * ------------------------------------------------------------
 *  为什么用 C3：3.3 V 电平，和串口屏直连不用分压；硬件 UART 可以跑 115200；
 *  自带 BLE（C3 只有 BLE，没有经典蓝牙），手机网页可直连控制。
 * ------------------------------------------------------------
 *  接线（C3 可用 IO：0~10、18~21；20/21 是 UART0，18/19 是 USB）
 *    屏 TX     -> GPIO4   (UART1 RX)
 *    屏 RX     <- GPIO5   (UART1 TX，3.3V 同电平，无需分压)
 *    风扇 PWM  -> GPIO6   (MOSFET 栅极，模块必须共地)
 *    有源蜂鸣器 -> GPIO7   (高电平触发；低电平模块把 BEEP_ON_LEVEL 改成 0)
 *    板载 LED  -> GPIO8   (多数 C3 SuperMini 是低电平点亮，可关掉)
 * ------------------------------------------------------------
 *  通道一：串口屏（单字节）
 *    屏 -> MCU：0x01/0x02/0x03 = 1/2/3 档，0x10 = 开机，0x11 = 关机
 *    MCU -> 屏：va0.val=n\xFF\xFF\xFF  /  sw.val=n\xFF\xFF\xFF
 *  通道二：BLE（Nordic UART 风格，UTF-8 文本行，\n 结尾）
 *    写 6E400002：L1 / L2 / L3、P0 / P1 / P（切换）、S（查询）、B（试响）
 *    通知 6E400003：{"lv":2,"on":1,"duty":170,"pct":66,"fw":"2.0.0"}
 *  USB 串口（Serial）也接同一套文本命令，不连蓝牙也能调试
 * ------------------------------------------------------------
 *  OTA 远程升级（WiFi）：
 *    - 版本检查：GitHub 上 VERSON.txt（内容形如 2.0.1），比本地新就自动下载刷写
 *    - 触发方式：① 开机 20 秒后自动查一次，之后每 6 小时查一次
 *                ② BLE / 串口发 "OTA" 立即检查；发 "W" 查 WiFi 状态
 *    - !!! Arduino IDE 开发板设置里，分区方案必须选带 OTA 的：
 *        工具 -> Partition Scheme -> "Minimal SPIFFS (Large APPS with OTA)"
 *        （固件约 1.4MB，默认分区装不下第二个 OTA 槽）
 *    - 升级过程 BLE 保持连接，网页会实时收到 {"ota":"progress","p":45} 进度
 * ============================================================
 *  提示音（有源蜂鸣器只能改节奏）：开机 1 声长、关机 2 声长、
 *  切到几档响几声、重复点当前档 1 声极短
 * ============================================================
 */

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>

#define FW_VERSION "2.0.0"
//#define TYPE "淘池屏"

// ---------------- 引脚 ----------------
const int PIN_HMI_RX = 4;  // ← 屏 TX
const int PIN_HMI_TX = 5;  // → 屏 RX
const int PIN_FAN = 6;     // 风扇 PWM
const int PIN_BUZZER = 7;  // 有源蜂鸣器

#define ENABLE_STATUS_LED 1  // 不想用板载灯就改成 0
const int PIN_LED = 8;       // C3 SuperMini 板载 LED（低电平点亮）

const bool BEEP_ON_LEVEL = true;  // 低电平触发的蜂鸣器模块改成 false

// ---------------- 参数 ----------------
const uint32_t HMI_BAUD = 115200;      // 屏的工程属性也要设成 115200
const uint16_t SYNC_PERIOD_MS = 1000;  // 定时补发状态给屏（屏重启能自愈；0=关）
const uint16_t BLE_HB_MS = 5000;       // BLE 心跳通知周期（0=关）

const uint8_t PWM_TABLE[4] = { 0, 150, 200, 255 };  // 0 / 33 / 66 / 100 %
const uint8_t PCT_TABLE[4] = { 0, 33, 66, 99 };     // 与屏上百分比一致

const int FAN_PWM_FREQ = 25000;  // 25 kHz：MOSFET 不啸叫，4 线风扇也是这个频率
const int FAN_PWM_RES = 8;

// ---------------- BLE UUID（Nordic UART 风格，通用 BLE 串口 App 也能连） ----------------
#define BLE_DEVICE_NAME "Air-Purifier"
#define SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define RX_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  // 手机 -> C3（写）
#define TX_UUID "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  // C3 -> 手机（通知）

// ---------------- WiFi / OTA 远程升级 ----------------
// 填上你家的 WiFi，路由器 2.4G 频段（ESP32 不支持 5G）
const char *WIFI_SSID = "";       // ← 改成你的 WiFi 名
const char *WIFI_PASS = "";       // ← 改成你的 WiFi 密码

const char *OTA_VER_URL =
  "https://raw.githubusercontent.com/re-spooler/esp32/refs/heads/main/OTA/VERSON.txt";
const char *OTA_BIN_URL =
  "https://raw.githubusercontent.com/re-spooler/esp32/refs/heads/main/OTA/airpurifier-ota.bin";

const uint32_t OTA_BOOT_DELAY_MS = 20000;  // 开机后第一次检查的延时
const uint32_t OTA_CHECK_PERIOD_MS =
  6UL * 3600UL * 1000UL;  // 之后的检查间隔（6 小时）；改成 0 = 只手动触发

// ---------------- LEDC 版本兼容（core 3.x 换 API） ----------------
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
#define LEDC_V3 1
#else
#define LEDC_V3 0
#endif

HardwareSerial &HMISerial = Serial1;

// ---------------- 状态 ----------------
uint8_t fanLevel = 0;  // 1~3
bool fanOn = false;

volatile bool bleConnected = false;
volatile bool bleSubscribed = false;
NimBLECharacteristic *pTx = nullptr;
NimBLECharacteristic *pRx = nullptr;

uint32_t lastSync = 0;
uint32_t lastBleHb = 0;

// ---------------- 蜂鸣器（非阻塞） ----------------
uint8_t beepSteps = 0;
uint16_t beepOnMs = 80, beepOffMs = 90;
bool beepIsOn = false;
uint32_t beepNext = 0;

inline void buzzerWrite(bool on) {
  digitalWrite(PIN_BUZZER, BEEP_ON_LEVEL ? on : !on);
}

// times 声短鸣：每声响 onMs、间隔 offMs（全程不阻塞）
void beepStart(uint8_t times, uint16_t onMs, uint16_t offMs) {
  if (times == 0) return;
  beepSteps = (uint8_t)(times * 2 - 1);  // 响-停-响…，最后一步必为响
  beepOnMs = onMs;
  beepOffMs = offMs;
  beepIsOn = true;
  buzzerWrite(true);
  beepNext = millis() + onMs;
}

void beepTask() {
  // if (beepSteps == 0) return;
  // if ((int32_t)(millis() - beepNext) < 0) return;
  // beepSteps--;
  // if (beepSteps == 0) {
  //   buzzerWrite(false);
  //   beepIsOn = false;
  //   return;
  // }
  // beepIsOn = !beepIsOn;
  // buzzerWrite(beepIsOn);
  // beepNext = millis() + (beepIsOn ? beepOnMs : beepOffMs);
}

// ---------------- PWM ----------------
void fanPwmInit() {
#if LEDC_V3
  ledcAttach(PIN_FAN, FAN_PWM_FREQ, FAN_PWM_RES);
#else
  ledcSetup(0, FAN_PWM_FREQ, FAN_PWM_RES);
  ledcAttachPin(PIN_FAN, 0);
#endif
}

void fanPwmWrite(uint8_t duty) {
#if LEDC_V3
  ledcWrite(PIN_FAN, duty);
#else
  ledcWrite(0, duty);
#endif
}

void applyFan() {
  fanPwmWrite(fanOn ? PWM_TABLE[fanLevel] : 0);
}

// ---------------- 串口屏 ----------------
void hmiEnd() {
  HMISerial.write(0xFF);
  HMISerial.write(0xFF);
  HMISerial.write(0xFF);
}

void hmiSetLevel(uint8_t v) {
#if defined(TYPE)

  HMISerial.print("va0.val=");
  HMISerial.print(v);
  hmiEnd();
#else  
  HMISerial.printf("wset va0.val %ld", v);
  HMISerial.print("\r\n");
#endif
}

void hmiSetPower(uint8_t v) {
#if defined(TYPE)
  HMISerial.print("sw.val=");
  HMISerial.print(v);
  hmiEnd();
#else  
  HMISerial.printf("wset sw.press %ld", v);
  HMISerial.print("\r\n");
#endif
}

void hmiSync() {
  hmiSetLevel(fanLevel);
  hmiSetPower(fanOn ? 1 : 0);
}

// ---------------- BLE 通知 ----------------
void notifyState() {
  if (!bleConnected || !bleSubscribed || pTx == nullptr) return;
  char buf[96];
  int n = snprintf(buf, sizeof(buf),
                   "{\"lv\":%u,\"on\":%u,\"duty\":%u,\"pct\":%u,\"fw\":\"%s\"}\n",
                   (unsigned)fanLevel, (unsigned)(fanOn ? 1 : 0),
                   (unsigned)(fanOn ? PWM_TABLE[fanLevel] : 0),
                   (unsigned)(fanOn ? PCT_TABLE[fanLevel] : 0),
                   FW_VERSION);
  if (n <= 0) return;
  if (n > (int)sizeof(buf) - 1) n = sizeof(buf) - 1;
  pTx->setValue((uint8_t *)buf, (size_t)n);
  pTx->notify();
}

// ---------------- OTA 远程升级 ----------------
bool otaBusy = false;          // 正在检查/下载中
uint32_t otaNextCheck = 0;     // 下次自动检查时刻（millis）

// 比较语义化版本号 "2.0.1" vs "2.0.0"，返回 >0 表示 a 更新
int verCompare(const String &a, const String &b) {
  int av[3] = { 0, 0, 0 }, bv[3] = { 0, 0, 0 };
  sscanf(a.c_str(), "%d.%d.%d", &av[0], &av[1], &av[2]);
  sscanf(b.c_str(), "%d.%d.%d", &bv[0], &bv[1], &bv[2]);
  for (int i = 0; i < 3; i++)
    if (av[i] != bv[i]) return av[i] - bv[i];
  return 0;
}

// 通过 BLE 推送 OTA 事件给网页（也打 USB 串口日志）
void otaSend(const char *json) {
  Serial.println(String("[OTA] ") + json);
  if (bleConnected && bleSubscribed && pTx != nullptr) {
    char buf[128];
    int n = snprintf(buf, sizeof(buf), "%s\n", json);
    pTx->setValue((uint8_t *)buf, (size_t)n);
    pTx->notify();
  }
}

void otaSendf(const char *fmt, const char *arg) {
  char j[128];
  snprintf(j, sizeof(j), fmt, arg);
  otaSend(j);
}

// 只保留数字和点，防止版本文件里混入换行/引号把 JSON 弄坏
String verClean(const String &s) {
  String o;
  for (size_t i = 0; i < s.length() && o.length() < 15; i++) {
    char c = s[i];
    if ((c >= '0' && c <= '9') || c == '.') o += c;
  }
  return o;
}

// 检查版本并按需下载固件。manual=true 表示用户发 OTA 命令主动触发
void doOtaCheck(bool manual) {
  if (otaBusy) return;
  if (WIFI_SSID[0] == '\0') {
    if (manual) otaSend("{\"ota\":\"fail\",\"msg\":\"wifi not set\"}");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (manual) otaSend("{\"ota\":\"fail\",\"msg\":\"wifi not connected\"}");
    return;
  }

  otaBusy = true;
  otaSend("{\"ota\":\"checking\"}");

  // ---- 1. 取远程版本号 ----
  WiFiClientSecure secure;
  secure.setInsecure();  // raw.githubusercontent.com 证书校验省略（省 RAM；文件由自己仓库发布，风险可控）
  HTTPClient http;
  http.begin(secure, OTA_VER_URL);
  http.setTimeout(10000);
  int httpCode = http.GET();
  String remote = (httpCode == HTTP_CODE_OK) ? http.getString() : "";
  http.end();

  if (httpCode != HTTP_CODE_OK) {
    otaBusy = false;
    char j[96];
    snprintf(j, sizeof(j), "{\"ota\":\"fail\",\"msg\":\"ver http %d\"}", httpCode);
    otaSend(j);
    return;
  }
  remote = verClean(remote);
  Serial.printf("[OTA] remote=%s local=%s\n", remote.c_str(), FW_VERSION);

  if (remote.length() == 0) {
    otaBusy = false;
    otaSend("{\"ota\":\"fail\",\"msg\":\"bad version file\"}");
    return;
  }

  if (verCompare(remote, FW_VERSION) <= 0) {
    otaBusy = false;
    otaSend("{\"ota\":\"uptodate\"}");
    return;
  }

  // ---- 2. 发现新版本 → 下载刷写 ----
  otaSendf("{\"ota\":\"found\",\"v\":\"%s\"}", remote.c_str());

  WiFiClientSecure binClient;
  binClient.setInsecure();
  HTTPUpdate httpUpdate;
  httpUpdate.rebootOnUpdate(false);  // 刷完先响 3 声再自己重启
  httpUpdate.onProgress([](int cur, int total) {
    static uint8_t lastStep = 255;
    if (total <= 0) return;
    uint8_t pct = (uint8_t)(cur * 100 / total);
    if (pct / 5 != lastStep) {           // 每 5% 推一次进度
      lastStep = pct / 5;
      char j[48];
      snprintf(j, sizeof(j), "{\"ota\":\"progress\",\"p\":%u}", pct);
      otaSend(j);
    }
#if ENABLE_STATUS_LED
    digitalWrite(PIN_LED, ((cur / 200) & 1) ? LOW : HIGH);  // 快闪表示正在写
#endif
  });

  t_httpUpdate_return r = httpUpdate.update(binClient, OTA_BIN_URL);
  otaBusy = false;

  if (r == HTTP_UPDATE_OK) {
    otaSend("{\"ota\":\"ok\"}");
    beepStart(3, 80, 80);
    delay(600);  // 给通知/蜂鸣留点时间
    ESP.restart();  // 重启后运行新固件
  } else {
    char j[128];
    snprintf(j, sizeof(j), "{\"ota\":\"fail\",\"msg\":\"%s\"}",
             httpUpdate.getLastErrorString().c_str());
    otaSend(j);
  }
}

// loop 里轮询：到点自动检查（WiFi 未连上就等下一轮）
void otaTask() {
  if (otaBusy || WIFI_SSID[0] == '\0') return;
  if (OTA_CHECK_PERIOD_MS == 0 && otaNextCheck != 0) return;  // 关闭自动检查
  if ((int32_t)(millis() - otaNextCheck) < 0) return;
  if (WiFi.status() != WL_CONNECTED) {
    otaNextCheck = millis() + 60000;  // WiFi 没连上，1 分钟后再试
    return;
  }
  otaNextCheck = (OTA_CHECK_PERIOD_MS == 0) ? UINT32_MAX : millis() + OTA_CHECK_PERIOD_MS;
  doOtaCheck(false);
}

// ---------------- 统一的状态修改入口（屏 / BLE / 按键 都走这里） ----------------
void setLevel(uint8_t lv) {
  if (lv < 1 || lv > 3) return;
  if (lv == fanLevel) {  // 同一档：只给一个"收到"的极短提示
    beepStart(1, 30, 0);
    return;
  }
  fanLevel = lv;  // 关机时也记住选择，下次开机沿用
  applyFan();
  hmiSetLevel(fanLevel);
  notifyState();
  beepStart(1, 55, 70);  // 1 档 1 声、2 档 2 声、3 档 3 声
}

void setPower(bool on) {
  if (on == fanOn) return;
  fanOn = on;
  hmiSetPower(on ? 1 : 0);
  if (on) {
    beepStart(1, 100, 0);  // 开机：1 声长音
    fanLevel = 1;
  } else {
    beepStart(2, 110, 90);  // 关机：2 声长音
    fanLevel = 0;
  }
  setLevel(fanLevel);
  applyFan();
  notifyState();
}

// ---------------- 文本命令解析（BLE 与 USB 串口共用） ----------------
char cmdBuf[32];
uint8_t cmdLen = 0;

void handleCommand(const char *raw) {
  String s(raw);
  s.trim();
  s.toUpperCase();
  if (s.length() == 0) return;

  if (s == "S" || s == "STATE" || s == "STATUS" || s == "?") {
    notifyState();
    return;
  }
  if (s == "B" || s == "BEEP") {
    beepStart(1, 60, 0);
    return;
  }
  if (s == "OTA" || s == "UPDATE" || s == "U") {  // 手动触发 OTA 检查
    if (WIFI_SSID[0] == '\0') {
      otaSend("{\"ota\":\"fail\",\"msg\":\"wifi not set\"}");
    } else if (WiFi.status() != WL_CONNECTED) {
      otaSend("{\"ota\":\"fail\",\"msg\":\"wifi not connected\"}");
    } else {
      doOtaCheck(true);
    }
    return;
  }
  if (s == "W" || s == "WIFI") {  // 查询 WiFi 状态
    char j[96];
    if (WIFI_SSID[0] == '\0') {
      snprintf(j, sizeof(j), "{\"wifi\":0,\"msg\":\"not set\"}");
    } else {
      snprintf(j, sizeof(j), "{\"wifi\":%d,\"rssi\":%d}", WiFi.status() == WL_CONNECTED,
               WiFi.RSSI());
    }
    otaSend(j);
    return;
  }
  if (s == "ON") {
    setPower(true);
    return;
  }
  if (s == "OFF") {
    setPower(false);
    return;
  }

  char c = s[0];
  int arg = (s.length() > 1) ? s.substring(1).toInt() : -1;

  if (c == 'P') {
    if (s.startsWith("POW")) {  // POW0 / POW1
      if (s.length() > 3) setPower(s.substring(3).toInt() != 0);
      return;
    }
    if (arg < 0) setPower(!fanOn);  // 只发 P = 切换
    else setPower(arg != 0);
  } else if (c == 'L' || c == 'A') {  // L1~L3 / A1~A3
    if (arg >= 1 && arg <= 3) setLevel((uint8_t)arg);
  }
}

void feedCommandChar(char c) {
  if (c == '\r') return;
  if (c == '\n') {
    if (cmdLen > 0) {
      cmdBuf[cmdLen] = '\0';
      handleCommand(cmdBuf);
      cmdLen = 0;
    }
    return;
  }
  if (cmdLen < sizeof(cmdBuf) - 1) cmdBuf[cmdLen++] = c;
  else cmdLen = 0;  // 溢出直接丢弃，防止卡死
}

// ---------------- 串口屏收字节 ----------------
void pollHmi() {
  while (HMISerial.available()) {
    uint8_t b = (uint8_t)HMISerial.read();
    switch (b) {
      case 0x01:
      case 0x02:
      case 0x03: setLevel(b); break;
      case 0x10: setPower(true); break;
      case 0x11: setPower(false); break;
      default: break;  // 0xFF 等噪声/回显，忽略
    }
  }
}

// ---------------- BLE 回调 ----------------
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo) override {
    bleConnected = true;
    Serial.println("[BLE] central connected");
    // 连接建立后广播会自动停，这里确保第二台设备/断线重连还能发现
    if (NimBLEDevice::getAdvertising() && !NimBLEDevice::getAdvertising()->isAdvertising()) {
      NimBLEDevice::startAdvertising();
    }
  }

  void onDisconnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo, int reason) override {
    bleConnected = pServer->getConnectedCount() > 0;
    bleSubscribed = false;
    Serial.printf("[BLE] disconnected, reason=%d\n", reason);
    NimBLEDevice::startAdvertising();
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *pChar, NimBLEConnInfo &connInfo) override {
    std::string v = pChar->getValue();
    for (char c : v) feedCommandChar(c);
  }
};

class TxCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic *pChar, NimBLEConnInfo &connInfo, uint16_t subValue) override {
    bleSubscribed = (subValue != 0);
    if (bleSubscribed) notifyState();  // 手机刚订阅就把当前状态推过去
  }
};

// ---------------- 状态灯 ----------------
#if ENABLE_STATUS_LED
uint32_t lastLedMs = 0;
bool ledOn = false;
void ledTask() {
  if (bleConnected) {
    digitalWrite(PIN_LED, LOW);  // 已连接：常亮
    return;
  }
  if (millis() - lastLedMs >= 500) {  // 广播中：慢闪
    lastLedMs = millis();
    ledOn = !ledOn;
    digitalWrite(PIN_LED, ledOn ? LOW : HIGH);
  }
}
#endif

// ---------------- setup ----------------
void setup() {
  pinMode(PIN_BUZZER, OUTPUT);
  buzzerWrite(false);
  Serial.begin(115200);  // USB 调试串口
  Serial.println("\n=== Fan Controller (ESP32-C3) " FW_VERSION " ===");

  fanPwmInit();
  fanPwmWrite(0);

  HMISerial.begin(HMI_BAUD, SERIAL_8N1, PIN_HMI_RX, PIN_HMI_TX);

  delay(600);  // 等串口屏开机
  hmiSync();
  applyFan();

  // ---- BLE ----
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEDevice::setMTU(185);

  NimBLEServer *pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  NimBLEService *pService = pServer->createService(SERVICE_UUID);

  pTx = pService->createCharacteristic(TX_UUID, NIMBLE_PROPERTY::NOTIFY);
  pTx->setCallbacks(new TxCallbacks());

  pRx = pService->createCharacteristic(RX_UUID,
                                       NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  pRx->setCallbacks(new RxCallbacks());

  pService->start();

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setName(BLE_DEVICE_NAME);
  adv->addServiceUUID(SERVICE_UUID);
  NimBLEDevice::startAdvertising();

  // ---- WiFi / OTA（非阻塞连接，连不上不影响风扇和 BLE） ----
  if (WIFI_SSID[0] != '\0') {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);        // 关省电，TLS 下载更稳
    WiFi.setAutoReconnect(true); // 掉线自动重连
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("[WiFi] connecting to %s ...\n", WIFI_SSID);
  }
  otaNextCheck = millis() + OTA_BOOT_DELAY_MS;  // 开机 20 秒后第一次自动检查

  Serial.println("[BLE] advertising as " BLE_DEVICE_NAME);
  beepStart(1, 80, 0);  // 开机提示音
}

// ---------------- loop ----------------
void loop() {
  pollHmi();
  beepTask();
  otaTask();
  // USB 串口也能发同样的文本命令（调试用）
  while (Serial.available()) {
    feedCommandChar((char)Serial.read());
  }
  uint32_t now = millis();

  if (SYNC_PERIOD_MS && now - lastSync >= SYNC_PERIOD_MS) {
    lastSync = now;
    hmiSync();
  }

  if (BLE_HB_MS && now - lastBleHb >= BLE_HB_MS) {
    lastBleHb = now;
    notifyState();
  }

#if ENABLE_STATUS_LED
  ledTask();
#endif
}
