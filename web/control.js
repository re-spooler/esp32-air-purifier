(() => {
  "use strict";

  const SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const RX_CH   = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
  const TX_CH   = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
  const PCT = { 1: 33, 2: 66, 3: 100 };
  const SPIN = { 1: 1.8, 2: 1.1, 3: 0.7 };   // 每档扇叶转一圈的秒数，越小转得越快
  const NAME_PREFIX = "Air-Purifier";
  const HAS_BT = ("bluetooth" in navigator);
  const DEMO = new URLSearchParams(location.search).has("demo");  // ?demo 预览弹窗（无蓝牙环境也能看）

  const $ = id => document.getElementById(id);
  const app = $("app"), dot = $("dot"), devName = $("devName");
  const connBtn = $("connBtn"), switchBtn = $("switchBtn"), pwrBtn = $("pwrBtn");
  const bigLvl = $("bigLvl"), pctEl = $("pct"), fill = $("fill");
  const logEl = $("log"), hintEl = $("hint"), toastEl = $("toast");
  const fanEl = $("fan");
  const fwVer = $("fwVer"), otaBtn = $("otaBtn");
  const otaLatestEl = $("otaLatest"), otaLatestVerEl = $("otaLatestVer");
  const otaLine = $("otaLine"), otaBarFill = $("otaBarFill"), otaPctTxt = $("otaPctTxt");
  const otaStateTxt = $("otaStateTxt");
  const wifiBtn = $("wifiBtn"), wifiModal = $("wifiModal");
  const wifiStat = $("wifiStat"), wifiStatTxt = $("wifiStatTxt");
  const wifiSsidEl = $("wifiSsid"), wifiPassEl = $("wifiPass");
  const wifiSaveBtn = $("wifiSaveBtn"), wifiClearBtn = $("wifiClearBtn"), pwEye = $("pwEye");
  const wifiList = $("wifiList"), wifiScanBtn = $("wifiScanBtn"), wifiManualBtn = $("wifiManualBtn");
  const wifiPassField = $("wifiPassField");
  const lvBtns = [...document.querySelectorAll(".btns button")];
  const modal = $("modal"), devList = $("devList"), scanBtn = $("scanBtn");

  let device = null, server = null, rxChar = null, txChar = null;
  let connected = false, connecting = false;
  let state = { lv: 1, on: true };
  let rxBuf = "";
  const known = [];            // { device, name, rssi, seen, watching }
  const bound = new WeakSet(); // 防止重复绑 gattserverdisconnected

  const enc = new TextEncoder();
  const rxDec = new TextDecoder();   // 流式解码：中文 SSID 被拆到两个通知里也不会乱码

  const t = key => window.I18N.t(key);  // 多语言取词（词典见 i18n.js）
  let curName = null;                   // 当前连接的设备名（切换语言时重渲染用）

  /* ---------------- 小工具 ---------------- */
  const nowStr = () => new Date().toTimeString().slice(0, 8);

  function log(text, cls = "") {
    if (!logEl) { console.log(text); return; }   // 页面已不显示日志，改为输出到控制台
    const row = document.createElement("div");
    row.innerHTML = `<span class="t">${nowStr()}</span><span class="${cls}">${text}</span>`;
    logEl.appendChild(row);
    while (logEl.childElementCount > 120) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  const setDot = mode => { dot.className = "dot" + (mode ? " " + mode : ""); };

  function shortId(d) {
    return (d.id || "").replace(/[^0-9a-z]/gi, "").slice(-6).toUpperCase();
  }

  function bars(rssi) {
    if (rssi == null) return 0;
    if (rssi >= -55) return 4;
    if (rssi >= -67) return 3;
    if (rssi >= -78) return 2;
    return 1;
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const lv = state.lv, on = state.on;
    bigLvl.textContent = on ? lv : "–";
    pctEl.textContent = on ? PCT[lv] : 0;
    fill.style.width = (on ? PCT[lv] : 0) + "%";
    pwrBtn.setAttribute("aria-pressed", on ? "true" : "false");
    pwrBtn.querySelector("b").textContent = on ? t("powerOn") : t("powerOff");
    lvBtns.forEach(b => b.classList.toggle("active", on && +b.dataset.lv === lv));
    if (fanEl) {                                 // 只有"已连接 + 电源开"才转
      fanEl.classList.toggle("paused", !(connected && on));
      fanEl.style.setProperty("--spin", SPIN[lv] + "s");
    }
  }

  /* ---------------- OTA 升级（版本检查在网页端做，点"升级"才让设备下载） ---------------- */
  // 流程：点"检查升级" → 浏览器直接拉 GitHub 的 VERSON.txt（比 ESP32 上查快得多）
  //       → 显示最新版本号 → 有新版时按钮变成"升级到 x.x.x" → 再点才发 FLASH 让设备下载
  const OTA_VER_URL =
    "https://raw.githubusercontent.com/re-spooler/esp32-air-purifier/refs/heads/main/web/OTA/VERSON.txt";

  let otaPhase = "idle";   // idle | webcheck(网页查版本中) | ready(发现新版等确认) | progress(设备下载中)
  let otaPct = 0;
  let otaRemoteVer = "";   // 网页查到的最新版本号
  let deviceFw = "";       // 设备回报的当前固件版本

  // 语义化版本比较：>0 表示 a 更新
  function verCmp(a, b) {
    const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function renderOta() {
    renderOtaInline();
    if (!otaBtn) return;
    const busy = otaPhase === "webcheck" || otaPhase === "progress";
    otaBtn.disabled = !connected || busy;
    otaBtn.classList.toggle("busy", busy);
    if (otaPhase === "webcheck") otaBtn.textContent = t("otaChecking");
    else if (otaPhase === "progress")
      otaBtn.textContent = otaSawEvent ? t("otaProgress").replace("{p}", otaPct) : t("otaWaitDev");
    else if (otaPhase === "ready") otaBtn.textContent = t("otaUpdateTo").replace("{v}", otaRemoteVer);
    else otaBtn.textContent = t("otaCheck");
  }

  // 升级进度直接显示在页面里（不用弹窗）：进度条 + 百分比 + 状态文字
  function renderOtaInline() {
    if (!otaLine) return;
    const show = otaPhase === "progress" && connected;
    otaLine.classList.toggle("show", show);
    if (!show) return;
    const got = otaSawEvent;                       // 有没有收到设备推的进度
    otaLine.classList.toggle("wait", !got);        // 没收到就显示呼吸条，别让人以为卡死
    otaBarFill.style.width = got ? Math.max(0, Math.min(100, otaPct)) + "%" : "";
    otaPctTxt.textContent = got ? Math.max(0, Math.min(100, otaPct)) + "%" : "--";
    if (otaStateTxt) {
      otaStateTxt.textContent = got
        ? (otaPct >= 100 ? t("otaWriting") : t("otaUpdating"))
        : t("otaWaitDev");
    }
  }

  // 网页端版本检查：浏览器直接拉 VERSON.txt
  async function webOtaCheck() {
    otaPhase = "webcheck";
    renderOta();
    try {
      const res = await fetch(OTA_VER_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const txt = await res.text();
      const m = txt.match(/\d+(?:\.\d+){0,2}/);          // 只取版本号本体
      if (!m) throw new Error("bad version file");
      otaRemoteVer = m[0];
    } catch (e) {
      otaPhase = "idle";
      renderOta();
      toast(t("otaWebFail"));
      return;
    }

    // 显示"最新 x.x.x"
    if (otaLatestEl) {
      otaLatestEl.style.display = "";
      if (otaLatestVerEl) otaLatestVerEl.textContent = otaRemoteVer;
    }

    if (!deviceFw) {                       // 还没拿到设备版本，先等等
      otaPhase = "idle"; renderOta();
      toast(t("otaNoFwVer"));
      return;
    }
    if (verCmp(otaRemoteVer, deviceFw) > 0) {
      otaPhase = "ready";                  // 有新版本：按钮变成"升级到 x.x.x"，等用户确认
      toast(t("otaFound").replace("{v}", otaRemoteVer));
    } else {
      otaPhase = "idle";
      toast(t("otaUptodate"));
    }
    renderOta();
  }

  function onOtaBtn() {
    if (otaPhase === "ready") {            // 用户点了"升级到 x.x.x" → 设备直接下载
      otaPhase = "progress"; otaPct = 0;
      otaSawEvent = false;
      renderOta();
      send("FLASH");
      stopOtaTimers();
      // 兜底：4.5 秒内一声不吭，可能是旧固件不认识 FLASH，补发老命令 OTA 让它自查自升。
      // 注意这里只补发命令，不改 UI 状态——设备可能只是通知没送到手机。
      otaAckTimer = setTimeout(() => {
        if (otaSawEvent) return;
        toast(t("otaLegacy"));
        send("OTA");
      }, 4500);
      // 安全阀：3 分钟还没结果才复位，中途绝不关进度条
      otaSafeTimer = setTimeout(() => {
        if (otaPhase !== "progress") return;
        otaPhase = "idle"; renderOta();
        toast(t("otaNoProgress"));
      }, 180000);
      return;
    }
    if (otaPhase === "idle") webOtaCheck();
  }

  // 设备侧事件（FLASH 下载中 / 兜底 OTA 路径共用）
  let otaAckTimer = 0;      // 发 FLASH 后等设备第一声回应的看门狗（只用于兜底发 OTA）
  let otaSafeTimer = 0;     // 安全阀：3 分钟还没结束才复位，绝不中途关掉进度条
  let otaSawEvent = false;  // 本轮是否已收到设备的 OTA 事件

  function stopOtaAck() { clearTimeout(otaAckTimer); otaAckTimer = 0; }
  function stopOtaTimers() { stopOtaAck(); clearTimeout(otaSafeTimer); otaSafeTimer = 0; }

  function handleOtaEvent(s) {
    otaSawEvent = true;
    stopOtaAck();                 // 收到任何回应就不必再补发 OTA 了；安全阀保留
    switch (s.ota) {
      case "start":                        // 设备已开始下载（新版固件会先发这条）
        otaPhase = "progress"; otaPct = 0; renderOta();
        break;
      case "checking":                     // 设备自查路径（兜底）
        otaPhase = "webcheck"; renderOta(); toast(t("otaChecking"));
        break;
      case "found":                        // 设备开始下载
        otaPhase = "progress"; otaPct = 0; renderOta();
        break;
      case "progress":
        otaPhase = "progress"; otaPct = s.p | 0; renderOta();
        break;
      case "uptodate":
        stopOtaTimers(); otaPhase = "idle"; renderOta(); toast(t("otaUptodate"));
        break;
      case "ok":
        stopOtaTimers();
        otaPct = 100; otaPhase = "progress"; renderOta();   // 先让进度条走满
        setTimeout(() => { otaPhase = "idle"; renderOta(); }, 1500);
        toast(t("otaOk"));
        break;
      case "fail":
        stopOtaTimers(); otaPhase = "idle"; renderOta();
        toast(t("otaFail") + (s.msg ? " (" + s.msg + ")" : ""));
        break;
    }
  }

  /* ---------------- WiFi 设置 ---------------- */
  let wifi = { on: false, saved: false, ssid: "", ip: "", rssi: 0, failMsg: "" };
  let wifiBusy = false;                 // 已发出保存命令，等设备回结果
  let clearArmed = false, clearTimer = 0;
  let wifiScanning = false;             // 已请求设备扫描，等结果
  const wifiScanList = [];              // 设备扫到的网络 [{s,r,e}]（设备已按信号排序）
  let pickedSsid = "";                  // 列表里选中的网络
  let pickedEnc = true;                 // 选中网络是否加密（开放网络不显示密码框）
  let wifiManual = false;               // true = 手动输入 SSID（隐藏网络用）
  let scanTimer = 0;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function renderWifi() {
    if (!wifiStat) return;
    wifiStat.classList.toggle("on", !!wifi.on);
    const ssid = esc(wifi.ssid || "?");
    let html;
    if (wifi.on) {
      html = t("wifiConnectedTo").replace("{s}", ssid) +
             `<br><em>${esc(wifi.ip || "?")}${wifi.rssi ? " · " + wifi.rssi + " dBm" : ""}</em>`;
    } else if (wifi.saved) {
      html = t("wifiSavedNotConnected").replace("{s}", ssid);
    } else {
      html = t("wifiNotConfigured");
    }
    // 连接失败的原因留在面板上，别只闪 2 秒就没了
    if (!wifi.on && wifi.failMsg) html += `<br><em class="err">${esc(wifi.failMsg)}</em>`;
    wifiStatTxt.innerHTML = html;
    if (wifiBtn) wifiBtn.classList.toggle("ok", !!wifi.on);   // 顶部按钮变绿表示 WiFi 在线
    if (wifiPassEl && wifiModal && wifiModal.classList.contains("show")) {
      wifiPassEl.placeholder = wifi.saved ? t("wifiPassKeep") : "••••••••";
    }
  }

  function renderWifiBtns() {
    const offline = !connected;
    const dis = offline || wifiBusy;
    if (wifiSaveBtn) {
      wifiSaveBtn.disabled = dis;
      wifiSaveBtn.textContent = wifiBusy ? t("wifiConnecting") : t("wifiSave");
    }
    if (wifiClearBtn && !clearArmed) {
      wifiClearBtn.disabled = dis;
      wifiClearBtn.textContent = t("wifiClear");
    }
    if (wifiSsidEl) wifiSsidEl.disabled = offline || wifiBusy;
    if (wifiPassEl) wifiPassEl.disabled = offline || wifiBusy;
    if (wifiScanBtn) wifiScanBtn.disabled = offline || wifiScanning;
    if (wifiManualBtn) wifiManualBtn.disabled = offline || wifiScanning;
  }

  /* ---- WiFi 搜索结果（扫描由设备完成，结果通过 BLE 分条推来） ---- */
  function renderWifiList() {
    if (!wifiList) return;
    if (wifiScanning && !wifiScanList.length) {
      wifiList.innerHTML = `<div class="wifi-empty">${t("wifiScanning")}</div>`;
    } else if (wifiManual) {
      wifiList.innerHTML = `<div class="wifi-empty">${t("wifiManualHint")}</div>`;
    } else if (!wifiScanList.length) {
      wifiList.innerHTML = `<div class="wifi-empty">${t("wifiScanHint")}</div>`;
    } else {
      wifiList.innerHTML = wifiScanList.map((ap, i) => {
        const n = bars(ap.r);
        const sig = `<span class="sig">${[1, 2, 3, 4]
          .map(x => `<i class="${x <= n ? "on" : ""}"></i>`).join("")}</span>`;
        const lock = ap.e
          ? `<span class="lock"><svg viewBox="0 0 24 24" width="12" height="12" fill="none"
               stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
               <rect x="4" y="10.5" width="16" height="9.5" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>
             </svg></span>`
          : "";
        return `<button class="wifi-ap${ap.s === pickedSsid ? " cur" : ""}" type="button" data-i="${i}">
          <span class="nm">${esc(ap.s)}</span>${sig}${lock}
        </button>`;
      }).join("");

      [...wifiList.querySelectorAll(".wifi-ap")].forEach(el => {
        el.addEventListener("click", () => {
          const ap = wifiScanList[+el.dataset.i];
          if (ap) pickSsid(ap.s, !!ap.e);
        });
      });
    }

    if (wifiScanBtn) {
      wifiScanBtn.disabled = !connected || wifiScanning;
      wifiScanBtn.classList.toggle("busy", wifiScanning);
      wifiScanBtn.textContent = wifiScanning
        ? t("wifiScanningBtn")
        : (wifiScanList.length ? t("wifiRescan") : t("wifiScan"));
    }
    if (wifiManualBtn) {
      wifiManualBtn.disabled = !connected || wifiScanning;
      wifiManualBtn.textContent = wifiManual ? t("wifiBackToList") : t("wifiManual");
    }
  }

  function pickSsid(ssid, enc) {
    pickedSsid = ssid;
    pickedEnc = enc;
    wifiManual = false;
    if (wifiSsidEl) { wifiSsidEl.value = ssid; wifiSsidEl.hidden = true; }
    if (wifiPassField) wifiPassField.style.display = enc ? "" : "none";  // 开放网络不用密码
    if (wifiPassEl) {
      if (!enc) wifiPassEl.value = "";
      else if (wifiModal.classList.contains("show")) wifiPassEl.focus();
    }
    renderWifiList();
    renderWifiBtns();
  }

  function setWifiManual(on) {
    wifiManual = on;
    if (wifiSsidEl) {
      wifiSsidEl.hidden = !on;
      if (on) { wifiSsidEl.value = pickedSsid || ""; wifiSsidEl.focus(); }
    }
    if (wifiPassField) wifiPassField.style.display = "";
    if (on) { pickedSsid = ""; pickedEnc = true; }
    renderWifiList();
    renderWifiBtns();
  }

  function startWifiScan() {
    if (!connected || wifiScanning) return;
    wifiScanning = true;
    wifiScanList.length = 0;
    wifiManual = false;
    if (wifiSsidEl) wifiSsidEl.hidden = true;
    renderWifiList();
    renderWifiBtns();
    send("WIFISCAN");
    clearTimeout(scanTimer);   // 设备扫描 2~4 秒，10 秒还没完成就当失败
    scanTimer = setTimeout(() => {
      if (!wifiScanning) return;
      wifiScanning = false;
      renderWifiList();
      renderWifiBtns();
      if (wifiModal && wifiModal.classList.contains("show")) toast(t("wifiScanFail"));
    }, 10000);
  }

  // 设备扫描结果：
  //  {"ws":{"start":1}} / {"ws":{"n":8}} / {"ws":{"i":0,"s":"..","r":-45,"e":1}} × n / {"ws":{"done":1}}
  function onWifiScan(w) {
    if (w.start) {
      wifiScanning = true;
      wifiScanList.length = 0;
      renderWifiList();
      renderWifiBtns();
      return;
    }
    if (typeof w.i === "number") {
      if (w.s) wifiScanList.push({ s: w.s, r: w.r | 0, e: !!w.e });
      if (wifiModal && wifiModal.classList.contains("show")) renderWifiList();
      return;
    }
    if (w.done) {
      wifiScanning = false;
      clearTimeout(scanTimer);
      if (!wifiScanList.length) toast(t("wifiScanEmpty"));
      renderWifiList();
      renderWifiBtns();
    }
  }

  function disarmClear() {
    clearArmed = false;
    clearTimeout(clearTimer);
    if (wifiClearBtn) {
      wifiClearBtn.classList.remove("confirm");
      wifiClearBtn.textContent = t("wifiClear");
    }
  }

  // 设备最多 15s 连 WiFi，这里兜底 25s 解除"连接中"状态，避免按钮永久卡住
  let wifiGuard = 0;
  function armWifiGuard() {
    clearTimeout(wifiGuard);
    wifiGuard = setTimeout(() => {
      if (!wifiBusy) return;
      wifiBusy = false;
      renderWifiBtns();
      // 兜底必须有提示：25 秒还没任何回音 = 设备没收到命令或通知丢了
      toast(t("wifiNoResp"));
    }, 25000);
  }
  function stopWifiGuard() { clearTimeout(wifiGuard); }

  function openWifi() {
    if (!connected) { toast(t("connectFirst")); return; }
    wifiModal.classList.add("show");
    pickedSsid = wifi.ssid || "";
    pickedEnc = true;
    wifiManual = false;
    if (wifiSsidEl) { wifiSsidEl.hidden = true; wifiSsidEl.value = pickedSsid; }
    if (wifiPassField) wifiPassField.style.display = "";
    if (wifiPassEl) {
      wifiPassEl.value = "";
      wifiPassEl.type = "password";
      wifiPassEl.placeholder = wifi.saved ? t("wifiPassKeep") : "••••••••";
    }
    if (pwEye) pwEye.textContent = t("pwShow");
    disarmClear();
    renderWifi();
    renderWifiList();
    renderWifiBtns();
    send("WIFI?");              // 先拉一次设备上的真实状态
    if (!wifi.on) startWifiScan();  // 还没联网就自动搜一次，省得用户多点一下
  }

  function closeWifi() {
    wifiModal.classList.remove("show");
    disarmClear();
  }

  function onWifiSave() {
    if (wifiBusy) return;                    // 连接中忽略重复点击
    const ssid = (wifiManual ? (wifiSsidEl.value || "") : pickedSsid).trim();
    const pass = pickedEnc ? (wifiPassEl.value || "") : "";
    if (!ssid) {
      toast(wifiManual ? t("wifiNeedSsid") : t("wifiPickFirst"));
      if (wifiManual) wifiSsidEl.focus();
      return;
    }
    if (ssid.indexOf(",") >= 0) { toast(t("wifiBadSsid")); if (wifiManual) wifiSsidEl.focus(); return; }
    if (pass && pass.length < 8) { toast(t("wifiPassShort")); wifiPassEl.focus(); return; }
    wifiBusy = true;
    renderWifiBtns();
    toast(t("wifiTry").replace("{s}", ssid));  // 立即给反馈，不等设备回话
    armWifiGuard();
    send("WIFI:" + ssid + "," + pass);   // 设备保存到 NVS 后立即连接
  }

  function onWifiClear() {
    if (wifiBusy) return;
    if (!clearArmed) {                    // 第一次点击只是"上膛"，3 秒内再点才真删
      clearArmed = true;
      wifiClearBtn.classList.add("confirm");
      wifiClearBtn.textContent = t("wifiClearConfirm");
      clearTimeout(clearTimer);
      clearTimer = setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    wifiBusy = true;
    renderWifiBtns();
    armWifiGuard();
    send("WIFI:CLEAR");
  }

  // 把固件回报的断开原因码翻译成能看懂的话（err 就是 ESP-IDF 的 wifi_err_reason_t）
  function wifiFailText(w) {
    if (typeof w.err !== "number") return t("wifiConnFail");   // 老固件没带原因码，只能给通用提示
    const e = w.err | 0;
    if (e === 0) return t("wifiErrIdle");                      // 压根没开始连（命令没到设备）
    if (e === 201 || e === 210 || e === 8) return t("wifiErrNoAp");
    if (e === 15 || e === 204 || e === 23 || e === 2 || e === 202 || e === 4 || e === 3)
      return t("wifiErrPass");
    if (e === 200 || e === 205 || e === 206) return t("wifiErrTimeout");
    if (e === 24 || e === 18 || e === 19 || e === 20 || e === 21 || e === 22)
      return t("wifiErrCipher");
    return t("wifiErrOther").replace("{c}", e);
  }

  // 设备上报的 WiFi 状态：{"wifi":{"on":1,"saved":1,"ssid":"..","ip":"..","rssi":-52,"st":3,"err":0,"msg":".."}}
  function onWifiState(w) {
    const msg = w.msg || "";
    wifi.on = !!w.on;
    wifi.saved = !!w.saved;
    if (typeof w.ssid === "string") wifi.ssid = w.ssid;
    wifi.ip = w.ip || "";
    wifi.rssi = w.rssi | 0;

    const open = wifiModal.classList.contains("show");
    if (msg === "connecting") {
      wifiBusy = true;
      wifi.failMsg = "";
    } else if (msg === "connected") {
      wifiBusy = false; stopWifiGuard();
      wifi.failMsg = "";
      if (open) {
        toast(t("wifiConnOk").replace("{s}", wifi.ssid));
        if (wifiPassEl) wifiPassEl.value = "";
      }
    } else if (msg === "fail" || msg === "connect failed") {
      wifiBusy = false; stopWifiGuard();
      wifi.failMsg = wifiFailText(w);
      if (open) toast(wifi.failMsg);
    } else if (msg === "cleared") {
      wifiBusy = false; stopWifiGuard();
      wifi.failMsg = "";
      pickedSsid = "";
      pickedEnc = true;
      if (wifiSsidEl) wifiSsidEl.value = "";
      if (wifiPassEl) wifiPassEl.value = "";
      toast(t("wifiCleared"));
    } else if (msg === "lost") {
      wifiBusy = false; stopWifiGuard();
      toast(t("wifiLost"));
    } else if (msg === "off") {
      wifiBusy = false; stopWifiGuard();
    } else if (msg === "usage: WIFI:ssid,pass") {
      wifiBusy = false; stopWifiGuard();
      wifi.failMsg = t("wifiErrIdle");
      toast(wifi.failMsg);
    }
    renderWifi();
    renderWifiBtns();
  }

  const lockUI = lock => app.classList.toggle("off", lock);

  function setConnected(ok, name) {
    connected = ok;
    curName = ok ? name : null;
    lockUI(!ok);
    connBtn.textContent = ok ? t("disconnect") : t("connect");
    connBtn.classList.toggle("ghost", ok);
    switchBtn.style.display = ok ? "" : "none";
    setDot(ok ? "on" : "");
    devName.textContent = ok ? (name || t("connected")) : t("notConnected");
    if (!ok) {              // 断开：OTA 状态复位，隐藏"最新版本"显示
      const wasOta = otaPhase === "progress";
      otaPhase = "idle";
      deviceFw = "";
      stopOtaTimers();
      if (otaLatestEl) otaLatestEl.style.display = "none";
      if (fwVer) fwVer.textContent = "--";
      // 升级过程中断线 = 设备刷完重启了，提示一下（不是故障）
      if (wasOta) toast(t("otaReboot"));
    }
    render();      // 连接状态变化要同步风扇：未连接时停转
    renderOta();   // 未连接时禁用"检查升级"按钮
    renderWifi();
    renderWifiBtns();
    renderWifiList();
    if (!ok && wifiModal && wifiModal.classList.contains("show")) closeWifi();
  }

  /* ================= 设备列表弹窗 ================= */
  function openPicker() {
    if (!HAS_BT && !DEMO) {
      toast(t("btUnsupportedToast"));
      log(t("btUnsupportedLog"), "er");
      return;
    }
    modal.classList.add("show");
    known.forEach(k => { k.seen = !!k.device.gatt.connected; });
    renderDevices();
    refreshKnown();
  }

  function closePicker() { modal.classList.remove("show"); }

  async function refreshKnown() {
    if (!navigator.bluetooth.getDevices) {
      renderDevices();
      return;
    }
    try {
      const devs = await navigator.bluetooth.getDevices();
      devs.forEach(d => {
        let k = known.find(x => x.device.id === d.id);
        if (!k) { k = { device: d, name: d.name || "", rssi: null, seen: false, watching: false }; known.push(k); }
        else if (d.name) k.name = d.name;
      });
      renderDevices();
      watchAll();
    } catch (e) {
      log(t("readAuthFail") + (e.message || e), "er");
    }
  }

  async function watchAll() {
    for (const k of known) {
      const d = k.device;
      if (!d.watchAdvertisements || k.watching) continue;
      k.watching = true;
      d.addEventListener("advertisementreceived", ev => {
        k.seen = true;
        k.rssi = ev.rssi;
        if (ev.device && ev.device.name) k.name = ev.device.name;
        if (modal.classList.contains("show")) renderDevices();
      });
      try { await d.watchAdvertisements(); }
      catch (e) { k.watching = false; }
    }
  }

  function renderDevices() {
    if (!HAS_BT && !DEMO) {
      devList.innerHTML = `<div class="empty"><div class="big">${t("unsupportedBig")}</div>
        ${t("unsupportedDesc")}</div>`;
      scanBtn.disabled = true;
      return;
    }
    scanBtn.disabled = false;

    if (!known.length) {
      devList.innerHTML = `<div class="empty"><div class="big">${t("emptyBig")}</div>
        ${t("emptyDesc")}</div>`;
      return;
    }

    const rows = [...known].sort((a, b) => {
      const ca = (a.device === device && connected) ? 0 : 1;
      const cb = (b.device === device && connected) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      if (a.seen !== b.seen) return a.seen ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "");
    });

    devList.innerHTML = rows.map((k, i) => {
      const cur = (k.device === device && connected);
      const n = bars(k.rssi);
      const sig = `<span class="sig">${[1, 2, 3, 4].map(x => `<i class="${x <= n ? "on" : ""}"></i>`).join("")}</span>`;
      const status = k.rssi != null ? `${k.rssi} dBm` : (k.seen ? t("advertising") : t("notAdvertising"));
      const name = k.name || t("unnamed");
      const initials = (name.match(/[A-Za-z0-9]/g) || ["?"]).slice(0, 2).join("").toUpperCase();
      return `<button class="dev${cur ? " cur" : ""}" data-i="${known.indexOf(k)}">
        <span class="av">${initials}</span>
        <span class="info">
          <span class="nm">${name}</span>
          <span class="meta">${shortId(k.device)} · ${status}</span>
        </span>
        <span class="right-side">
          ${cur ? `<span class="tag">${t("connected")}</span>` : (sig + `<span class="tag off">${t("tagConnect")}</span>`)}
        </span>
      </button>`;
    }).join("");

    [...devList.querySelectorAll(".dev")].forEach(el => {
      el.addEventListener("click", () => {
        const k = known[+el.dataset.i];
        if (k) connectTo(k.device);
      });
    });
  }

  /* ---------------- 扫描新设备 ---------------- */
  // 注意：requestDevice 必须在本函数最前面同步调用，
  // 一旦先 await 别的异步操作，浏览器的"用户手势"就失效了。
  async function scanNew() {
    if (!HAS_BT) { if (DEMO) { toast(t("demoToast")); } return; }
    const opts =  { filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE] };     

    let d;
    try {
      d = await navigator.bluetooth.requestDevice(opts);
    } catch (e) {
      if (e && e.name === "NotFoundError") { log(t("scanCancelled")); }
      else { log(t("scanFailed") + (e.message || e), "er"); toast(t("scanFailed") + (e.message || e)); }
      return;
    }

    let k = known.find(x => x.device.id === d.id);
    if (!k) { k = { device: d, name: d.name || "", rssi: null, seen: true, watching: false }; known.push(k); }
    else { k.seen = true; if (d.name) k.name = d.name; }
    log(t("selected") + (k.name || shortId(d)));
    renderDevices();
    connectTo(d);
  }

  /* ---------------- 连接 ---------------- */
  function bindDevice(d) {
    if (bound.has(d)) return;
    bound.add(d);
    d.addEventListener("gattserverdisconnected", onGattDisconnected);
  }

  async function connectTo(d) {
    if (connecting) return;
    connecting = true;
    connBtn.disabled = true;
    scanBtn.disabled = true;
    setDot("wait");
    const nm = d.name || t("unnamedShort");

    try {
      if (device && device !== d && device.gatt.connected) {
        try { device.gatt.disconnect(); } catch (e) {}
      }
      if (!d.gatt.connected) await d.gatt.connect();
      device = d;
      bindDevice(d);

      const service = await d.gatt.getPrimaryService(SERVICE);
      rxChar = await service.getCharacteristic(RX_CH);
      txChar = await service.getCharacteristic(TX_CH);
      await txChar.startNotifications();
      try { txChar.removeEventListener("characteristicvaluechanged", onNotify); } catch (e) {}
      txChar.addEventListener("characteristicvaluechanged", onNotify);

      setConnected(true, nm);
      closePicker();
      log(t("connectedLog") + nm);
      send("S");
      armFwRetry();
      // 把网页当前语言同步给屏（设备存 NVS，开机屏也用这个语言）
      send("LANG:" + (window.I18N.lang === "en" ? "EN" : "ZH"));
    } catch (e) {
      log(t("connectFailed") + (e.message || e), "er");
      toast(t("connectFailed") + (e.message || e));
      setDot("");
      renderDevices();
    } finally {
      connecting = false;
      connBtn.disabled = false;
      scanBtn.disabled = false;
    }
  }

  function disconnect() {
    try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
    onGattDisconnected();
  }

  // 版本号随状态 JSON 一起回。连接瞬间通知最密（订阅推送 + S 应答挤在一起），
  // 首帧偶发被挤丢就只剩 5 秒心跳能救——这里主动补问，1.5s 一次最多 5 次，
  // 拿到 fw（或断线）就停。
  let fwTimer = 0;
  function stopFwRetry() { if (fwTimer) { clearInterval(fwTimer); fwTimer = 0; } }
  function armFwRetry() {
    stopFwRetry();
    let tries = 0;
    fwTimer = setInterval(() => {
      if (!connected || deviceFw || tries++ >= 5) { stopFwRetry(); return; }
      send("S");
    }, 1500);
  }

  function onGattDisconnected() {
    rxChar = null; txChar = null; server = null;
    rxBuf = "";
    stopFwRetry();
    try { rxDec.decode(); } catch (e) {}   // 清掉流式解码器里残留的半个字符
    setConnected(false);
    log(t("disconnectedLog"));
    toast(t("disconnectedToast"));
  }

  /* ---------------- 收发 ---------------- */
  /* 一条命令可能比蓝牙单包还长（WIFI:名称,密码），所以按 20 字节切片发送，
     固件端按 '\n' 把碎片拼回去；同时用 promise 链串行化，避免两条命令同时写
     触发 "GATT operation already in progress" 而把命令丢掉。 */
  const WRITE_CHUNK = 20;
  let txChain = Promise.resolve();

  function send(cmd) {
    if (!rxChar) { toast(t("connectFirst")); return Promise.resolve(); }
    log("→ " + cmd, "tx");
    const bytes = enc.encode(cmd + "\n");

    txChain = txChain.then(async () => {
      const ch = rxChar;
      if (!ch) return;
      for (let i = 0; i < bytes.length; i += WRITE_CHUNK) {
        const part = bytes.subarray(i, Math.min(i + WRITE_CHUNK, bytes.length));
        try {
          if (ch.writeValue) await ch.writeValue(part);          // 有回应写：带流控，最稳
          else await ch.writeValueWithoutResponse(part);
        } catch (e) {
          try { await ch.writeValueWithoutResponse(part); }
          catch (e2) { log(t("sendFailed") + (e2.message || e2), "er"); return; }
        }
        if (i + WRITE_CHUNK < bytes.length) await new Promise(r => setTimeout(r, 15));
      }
    }).catch(() => {});

    return txChain;
  }

  // 一条已解析的 JSON 消息
  function handleMessage(s) {
    if (typeof s.lv === "number") {
      state.lv = Math.min(3, Math.max(1, s.lv));
      state.on = !!s.on;
      render();
    }
    if (typeof s.fw === "string" && fwVer) {
      fwVer.textContent = s.fw;          // 固件版本
      deviceFw = s.fw;
      stopFwRetry();                     // 拿到版本号，不用再补问了
    }
    if (s.ota) handleOtaEvent(s);                                     // OTA 进度/结果
    if (s.wifi) onWifiState(s.wifi);                                  // WiFi 状态
    if (s.ws) onWifiScan(s.ws);                                       // WiFi 搜索结果
    if ((s.lang === "en" || s.lang === "zh") && window.I18N.lang !== s.lang) {
      window.I18N.set(s.lang);  // 屏自己切了语言 → 网页跟着切（I18N.set 会存 localStorage）
    }
  }

  function onNotify(ev) {
    rxBuf += rxDec.decode(ev.target.value, { stream: true });   // 固件会把长 JSON 拆包发

    // 兜底：所有帧都以 '\n' 结尾，缓冲区攒到 400 字节还没有换行，
    // 说明中间有分片彻底丢了（BLE 在 WiFi/OTA 抢空口时可能丢包）。
    // 此时必须清掉坏数据，否则后面收到的每条消息都会粘在它后面，永远解析不出来。
    if (rxBuf.length > 400) {
      const k = rxBuf.lastIndexOf("\n");
      rxBuf = k >= 0 ? rxBuf.slice(k + 1) : "";
    }

    let idx;
    while ((idx = rxBuf.indexOf("\n")) >= 0) {
      let line = rxBuf.slice(0, idx).trim();
      rxBuf = rxBuf.slice(idx + 1);
      if (!line) continue;
      log("← " + line, "rx");
      // 帧同步：丢了开头分片时，一行里会残留 "…gress","p":45} 这种残缺数据，
      // 只保留最后一个 '{' 之后的部分（顶层 JSON 不含多余 '{'，这样切刚好）。
      if (line[0] !== "{" || line[line.length - 1] !== "}") {
        const k = line.lastIndexOf("{");
        if (k < 0) continue;
        line = line.slice(k);
        if (line[line.length - 1] !== "}") continue;   // 尾巴也缺，直接丢帧
      }
      try {
        handleMessage(JSON.parse(line));
      } catch (e) { /* 坏帧忽略，等下一帧 */ }
    }
  }

  /* ---------------- 交互 ---------------- */
  connBtn.addEventListener("click", () => connected ? disconnect() : openPicker());
  switchBtn.addEventListener("click", openPicker);
  $("closeBtn").addEventListener("click", closePicker);
  $("backdrop").addEventListener("click", closePicker);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (wifiModal && wifiModal.classList.contains("show")) { closeWifi(); e.stopPropagation(); return; }
    if (modal.classList.contains("show")) { closePicker(); e.stopPropagation(); }
  }, true);

  scanBtn.addEventListener("click", scanNew);

  if (otaBtn) otaBtn.addEventListener("click", onOtaBtn);  // 检查升级 / 确认升级（网页端查版本）

  /* ---- WiFi 设置弹窗 ---- */
  if (wifiBtn) wifiBtn.addEventListener("click", openWifi);
  $("wifiCloseBtn").addEventListener("click", closeWifi);
  $("wifiBackdrop").addEventListener("click", closeWifi);
  if (wifiSaveBtn) wifiSaveBtn.addEventListener("click", onWifiSave);
  if (wifiClearBtn) wifiClearBtn.addEventListener("click", onWifiClear);
  if (wifiScanBtn) wifiScanBtn.addEventListener("click", startWifiScan);
  if (wifiManualBtn) wifiManualBtn.addEventListener("click", () => setWifiManual(!wifiManual));
  if (pwEye) pwEye.addEventListener("click", () => {
    const show = wifiPassEl.type === "password";
    wifiPassEl.type = show ? "text" : "password";
    pwEye.textContent = show ? t("pwHide") : t("pwShow");
  });
  [wifiSsidEl, wifiPassEl].forEach(el => {
    if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); onWifiSave(); } });
  });

  pwrBtn.addEventListener("click", () => {
    const next = !state.on;
    state.on = next; render();
    send(next ? "P1" : "P0");
  });

  lvBtns.forEach(btn => btn.addEventListener("click", () => {
    const lv = +btn.dataset.lv;
    state.lv = lv; state.on = true; render();
    send("L" + lv);
  }));

  document.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (modal.classList.contains("show")) return;
    if (wifiModal && wifiModal.classList.contains("show")) return;   // WiFi 弹窗里打字不触发快捷键
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const k = e.key.toLowerCase();
    if (k === "1" || k === "2" || k === "3") {
      const lv = +k;
      state.lv = lv; state.on = true; render();
      send("L" + lv);
    } else if (k === "p") {
      const next = !state.on;
      state.on = next; render();
      send(next ? "P1" : "P0");
    } else if (k === "s") {
      send("S");
    } else if (k === "c") {
      connected ? disconnect() : openPicker();
    }
  });

  /* ---------------- 启动提示（切换语言时也会重新调用） ---------------- */
  function initHint() {
    const isSecure = location.protocol === "https:" ||
                     ["localhost", "127.0.0.1"].includes(location.hostname);
    if (!HAS_BT) hintEl.innerHTML = t("hintNoBt");
    else if (!isSecure) hintEl.innerHTML = t("hintInsecure");
    else hintEl.innerHTML = t("hintKeys");
  }
  initHint();

  lockUI(true);
  render();
  renderWifi();
  renderWifiBtns();
  log(t("ready") + NAME_PREFIX);

  /* 切换语言时重渲染所有动态文字 */
  document.addEventListener("langchange", () => {
    // 已连接就把新语言同步给屏（设备存 NVS，开机屏自动用上次的语言）
    if (connected) send("LANG:" + (window.I18N.lang === "en" ? "EN" : "ZH"));
    initHint();
    setConnected(connected, curName);
    render();
    renderOta();
    renderWifi();
    renderWifiBtns();
    renderWifiList();
    if (pwEye && wifiPassEl) pwEye.textContent = wifiPassEl.type === "text" ? t("pwHide") : t("pwShow");
    if (modal.classList.contains("show")) renderDevices();
  });

  /* ---------------- 预览模式（仅在 ?demo 时生效，不影响正常使用） ---------------- */
  if (DEMO) {
    known.push(
      { device: { id: "aa11bb22cc33", gatt: { connected: true } }, name: "FAN-C3-A1", rssi: -48, seen: true, watching: true },
      { device: { id: "dd44ee55ff66", gatt: { connected: false } }, name: "FAN-C3-B7", rssi: -71, seen: true, watching: true },
      { device: { id: "77889900aabb", gatt: { connected: false } }, name: "", rssi: null, seen: false, watching: true }
    );
    modal.classList.add("show");
    renderDevices();
  }
})();