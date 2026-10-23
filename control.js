(() => {
  "use strict";

  const SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const RX_CH   = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
  const TX_CH   = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
  const PCT = { 1: 33, 2: 66, 3: 100 };
  const NAME_PREFIX = "FAN-C3";
  const HAS_BT = ("bluetooth" in navigator);
  const DEMO = new URLSearchParams(location.search).has("demo");  // ?demo 预览弹窗（无蓝牙环境也能看）

  const $ = id => document.getElementById(id);
  const app = $("app"), dot = $("dot"), devName = $("devName");
  const connBtn = $("connBtn"), switchBtn = $("switchBtn"), pwrBtn = $("pwrBtn");
  const bigLvl = $("bigLvl"), pctEl = $("pct"), fill = $("fill");
  const logEl = $("log"), hintEl = $("hint"), toastEl = $("toast");
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

  /* ---------------- 小工具 ---------------- */
  const nowStr = () => new Date().toTimeString().slice(0, 8);

  function log(text, cls = "") {
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
    pwrBtn.querySelector("b").textContent = on ? "开" : "关";
    lvBtns.forEach(b => b.classList.toggle("active", on && +b.dataset.lv === lv));
  }

  const lockUI = lock => app.classList.toggle("off", lock);

  function setConnected(ok, name) {
    connected = ok;
    lockUI(!ok);
    connBtn.textContent = ok ? "断开" : "连接蓝牙";
    connBtn.classList.toggle("ghost", ok);
    switchBtn.style.display = ok ? "" : "none";
    setDot(ok ? "on" : "");
    devName.textContent = ok ? (name || "已连接") : "未连接";
  }

  /* ================= 设备列表弹窗 ================= */
  function openPicker() {
    if (!HAS_BT && !DEMO) {
      toast("当前浏览器不支持 Web 蓝牙，请用电脑 Chrome / Edge 或安卓 Chrome");
      log("浏览器不支持 navigator.bluetooth", "er");
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
      log("读取已授权设备失败：" + (e.message || e), "er");
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
      devList.innerHTML = `<div class="empty"><div class="big">当前浏览器不支持 Web 蓝牙</div>
        请用电脑版 Chrome / Edge 或安卓 Chrome 打开（iOS 任何浏览器都不支持）。</div>`;
      scanBtn.disabled = true;
      return;
    }
    scanBtn.disabled = false;

    if (!known.length) {
      devList.innerHTML = `<div class="empty"><div class="big">还没有连接过任何设备</div>
        点下面「扫描新设备」，系统会列出附近的蓝牙设备，<br>选哪个就连哪个。</div>`;
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
      const status = k.rssi != null ? `${k.rssi} dBm` : (k.seen ? "广播中" : "未在广播");
      const name = k.name || "(未命名设备)";
      const initials = (name.match(/[A-Za-z0-9]/g) || ["?"]).slice(0, 2).join("").toUpperCase();
      return `<button class="dev${cur ? " cur" : ""}" data-i="${known.indexOf(k)}">
        <span class="av">${initials}</span>
        <span class="info">
          <span class="nm">${name}</span>
          <span class="meta">${shortId(k.device)} · ${status}</span>
        </span>
        <span class="right-side">
          ${cur ? '<span class="tag">已连接</span>' : (sig + '<span class="tag off">连接</span>')}
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
    if (!HAS_BT) { if (DEMO) { toast("预览模式：这里会打开系统设备列表"); } return; }
    const opts =  { filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE] };     

    let d;
    try {
      d = await navigator.bluetooth.requestDevice(opts);
    } catch (e) {
      if (e && e.name === "NotFoundError") { log("已取消扫描"); }
      else { log("扫描失败：" + (e.message || e), "er"); toast("扫描失败：" + (e.message || e)); }
      return;
    }

    let k = known.find(x => x.device.id === d.id);
    if (!k) { k = { device: d, name: d.name || "", rssi: null, seen: true, watching: false }; known.push(k); }
    else { k.seen = true; if (d.name) k.name = d.name; }
    log("已选择 " + (k.name || shortId(d)));
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
    const nm = d.name || "(未命名)";

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
      log("已连接 " + nm);
      send("S");
    } catch (e) {
      log("连接失败：" + (e.message || e), "er");
      toast("连接失败：" + (e.message || e));
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
    log("连接已断开");
    toast("蓝牙已断开");
  }

  /* ---------------- 收发 ---------------- */
  async function send(cmd) {
    if (!rxChar) { toast("请先连接蓝牙"); return; }
    log("→ " + cmd, "tx");
    const data = enc.encode(cmd + "\n");
    try {
      if (rxChar.writeValueWithoutResponse) await rxChar.writeValueWithoutResponse(data);
      else await rxChar.writeValue(data);
    } catch (e) {
      try { await rxChar.writeValue(data); }
      catch (e2) { log("发送失败：" + (e2.message || e2), "er"); }
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

  /* ---------------- 启动提示 ---------------- */
  (function initHint() {
    const isSecure = location.protocol === "https:" ||
                     ["localhost", "127.0.0.1"].includes(location.hostname);
    if (!HAS_BT) {
      hintEl.innerHTML = "<b>浏览器不支持 Web 蓝牙。</b>请用电脑版 Chrome / Edge，" +
        "或安卓 Chrome 打开（iOS 的 Safari 完全不支持）。";
    } else if (!isSecure) {
      hintEl.innerHTML = "<b>当前不是安全上下文。</b>Web 蓝牙要求 <code>https://</code> 或 " +
        "<code>localhost</code>。用 <code>python -m http.server 8000</code> 起本地服务后访问 " +
        "<code>http://localhost:8000</code> 即可。";
    } else {
      hintEl.innerHTML = "快捷键：<code>1</code> <code>2</code> <code>3</code> 切档 · " +
        "<code>P</code> 开关 · <code>S</code> 查询 · <code>C</code> 连接";
    }
  })();

  lockUI(true);
  render();
  log("页面就绪，等待连接 " + NAME_PREFIX);

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