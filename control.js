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
  const lvBtns = [...document.querySelectorAll(".btns button")];
  const modal = $("modal"), devList = $("devList"), scanBtn = $("scanBtn");

  let device = null, server = null, rxChar = null, txChar = null;
  let connected = false, connecting = false;
  let state = { lv: 1, on: true };
  let rxBuf = "";
  const known = [];            // { device, name, rssi, seen, watching }
  const bound = new WeakSet(); // 防止重复绑 gattserverdisconnected

  const enc = new TextEncoder();
  const dec = new TextDecoder();

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

  /* ---------------- OTA 升级状态 ---------------- */
  let otaStatus = "idle";   // idle | checking | progress
  let otaPct = 0;

  function renderOta() {
    if (!otaBtn) return;
    const busy = otaStatus === "checking" || otaStatus === "progress";
    otaBtn.disabled = !connected || busy;
    otaBtn.classList.toggle("busy", busy);
    otaBtn.textContent = busy
      ? (otaStatus === "checking" ? t("otaChecking") : t("otaProgress").replace("{p}", otaPct))
      : t("otaCheck");
  }

  function handleOtaEvent(s) {
    switch (s.ota) {
      case "checking":
        otaStatus = "checking"; renderOta(); toast(t("otaChecking"));
        break;
      case "found":                       // 发现新版本，开始下载
        otaStatus = "progress"; otaPct = 0; renderOta();
        break;
      case "progress":
        otaStatus = "progress"; otaPct = s.p | 0; renderOta();
        break;
      case "uptodate":
        otaStatus = "idle"; renderOta(); toast(t("otaUptodate"));
        break;
      case "ok":
        otaStatus = "idle"; renderOta(); toast(t("otaOk"));
        break;
      case "fail":
        otaStatus = "idle"; renderOta();
        toast(t("otaFail") + (s.msg ? " (" + s.msg + ")" : ""));
        break;
    }
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
    render();      // 连接状态变化要同步风扇：未连接时停转
    renderOta();   // 未连接时禁用"检查升级"按钮
    if (!ok && fwVer) fwVer.textContent = "--";
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

  function onGattDisconnected() {
    rxChar = null; txChar = null; server = null;
    setConnected(false);
    log(t("disconnectedLog"));
    toast(t("disconnectedToast"));
  }

  /* ---------------- 收发 ---------------- */
  async function send(cmd) {
    if (!rxChar) { toast(t("connectFirst")); return; }
    log("→ " + cmd, "tx");
    const data = enc.encode(cmd + "\n");
    try {
      if (rxChar.writeValueWithoutResponse) await rxChar.writeValueWithoutResponse(data);
      else await rxChar.writeValue(data);
    } catch (e) {
      try { await rxChar.writeValue(data); }
      catch (e2) { log(t("sendFailed") + (e2.message || e2), "er"); }
    }
  }

  function onNotify(ev) {
    rxBuf += dec.decode(ev.target.value);
    let idx;
    while ((idx = rxBuf.indexOf("\n")) >= 0) {
      const line = rxBuf.slice(0, idx).trim();
      rxBuf = rxBuf.slice(idx + 1);
      if (!line) continue;
      log("← " + line, "rx");
      try {
        const s = JSON.parse(line);
        if (typeof s.lv === "number") {
          state.lv = Math.min(3, Math.max(1, s.lv));
          state.on = !!s.on;
          render();
        }
        if (typeof s.fw === "string" && fwVer) fwVer.textContent = s.fw;  // 固件版本
        if (s.ota) handleOtaEvent(s);                                     // OTA 进度/结果
      } catch (e) { /* 非 JSON 通知忽略 */ }
    }
  }

  /* ---------------- 交互 ---------------- */
  connBtn.addEventListener("click", () => connected ? disconnect() : openPicker());
  switchBtn.addEventListener("click", openPicker);
  $("closeBtn").addEventListener("click", closePicker);
  $("backdrop").addEventListener("click", closePicker);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && modal.classList.contains("show")) { closePicker(); e.stopPropagation(); }
  }, true);

  scanBtn.addEventListener("click", scanNew);

  if (otaBtn) otaBtn.addEventListener("click", () => send("OTA"));  // 触发固件 OTA 检查/升级

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
  log(t("ready") + NAME_PREFIX);

  /* 切换语言时重渲染所有动态文字 */
  document.addEventListener("langchange", () => {
    initHint();
    setConnected(connected, curName);
    render();
    renderOta();
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