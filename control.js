(() => {
  "use strict";

  const SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const RX_CH   = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // 写入（手机 → C3）
  const TX_CH   = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // 通知（C3 → 手机）
  const PCT = { 0: 0, 1: 33, 2: 66, 3: 99 };
  const NAME_PREFIX = "FAN-C3";

  const $ = id => document.getElementById(id);
  const app = $("app"), dot = $("dot"), devName = $("devName");
  const connBtn = $("connBtn"), pwrBtn = $("pwrBtn");
  const bigLvl = $("bigLvl"), pctEl = $("pct"), fill = $("fill");
  const logEl = $("log"), hintEl = $("hint"), toastEl = $("toast");
  const lvBtns = [...document.querySelectorAll(".btns button")];

  let device = null, server = null, rxChar = null, txChar = null;
  let connected = false, state = { lv: 1, on: true };
  let rxBuf = "", connecting = false;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ---------- 小工具 ---------- */
  function nowStr() {
    const d = new Date();
    return d.toTimeString().slice(0, 8);
  }
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
  function setDot(mode) {
    dot.className = "dot" + (mode ? " " + mode : "");
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const lv = state.lv, on = state.on;
    bigLvl.textContent = on ? lv : "–";
    pctEl.textContent = on ? PCT[lv] : 0;
    fill.style.width = (on ? PCT[lv] : 0) + "%";
    pwrBtn.setAttribute("aria-pressed", on ? "true" : "false");
    pwrBtn.querySelector("b").textContent = on ? "开" : "关";
    lvBtns.forEach(b => b.classList.toggle("active", on && +b.dataset.lv === lv));
  }

  function lockUI(lock) {
    app.classList.toggle("off", lock);
  }

  /* ---------- 连接 ---------- */
  function setConnected(ok, name) {
    connected = ok;
    lockUI(!ok);
    connBtn.textContent = ok ? "断开" : "连接蓝牙";
    connBtn.classList.toggle("ghost", ok);
    setDot(ok ? "on" : "");
    devName.textContent = ok ? (name || "已连接") : "未连接";
  }

  async function connect() {
    if (!("bluetooth" in navigator)) {
      toast("当前浏览器不支持 Web 蓝牙，请用电脑 Chrome / Edge 或安卓 Chrome");
      log("浏览器不支持 navigator.bluetooth", "er");
      return;
    }
    if (connecting) return;
    connecting = true;
    connBtn.disabled = true;
    setDot("wait");

    try {
      if (!device) {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: NAME_PREFIX }],
          optionalServices: [SERVICE]
        });
        device.addEventListener("gattserverdisconnected", onGattDisconnected);
      }
      connBtn.textContent = "连接中…";
      server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE);
      rxChar = await service.getCharacteristic(RX_CH);
      txChar = await service.getCharacteristic(TX_CH);
      await txChar.startNotifications();
      txChar.addEventListener("characteristicvaluechanged", onNotify);

      setConnected(true, device.name || NAME_PREFIX);
      log("已连接 " + (device.name || NAME_PREFIX));
      send("S");
    } catch (e) {
      // 用户取消选择框会抛 NotFoundError，不必当错误刷屏
      if (e && e.name === "NotFoundError") log("已取消选择设备");
      else { log("连接失败：" + (e.message || e), "er"); toast("连接失败：" + (e.message || e)); }
      setDot("");
      connBtn.textContent = "连接蓝牙";
    } finally {
      connecting = false;
      connBtn.disabled = false;
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

  /* ---------- 收发 ---------- */
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
      } catch (e) { /* 非 JSON 的通知忽略 */ }
    }
  }

  /* ---------- 交互 ---------- */
  connBtn.addEventListener("click", () => connected ? disconnect() : connect());

  pwrBtn.addEventListener("click", () => {
    const next = !state.on;
    state.on = next; render();          // 乐观更新，等设备通知回来再对齐
    send(next ? "P1" : "P0");
  });

  lvBtns.forEach(btn => btn.addEventListener("click", () => {
    const lv = +btn.dataset.lv;
    state.lv = lv; state.on = true; render();
    send("L" + lv);
  }));

  document.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
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
      connected ? disconnect() : connect();
    }
  });

  /* ---------- 启动提示 ---------- */
  (function initHint() {
    const isSecure = location.protocol === "https:" ||
                     ["localhost", "127.0.0.1"].includes(location.hostname);
    const noBT = !("bluetooth" in navigator);
    if (noBT) {
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
})();