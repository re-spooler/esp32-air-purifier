/* ================= 中英文切换（i18n） =================
 * 用法：
 *   HTML 静态文字  →  元素上加 data-i18n="key"（textContent）
 *                     data-i18n-html="key"（innerHTML，含 <br> 等标签时用）
 *                     data-i18n-title="key"（title 属性）
 *   JS 动态文字    →  t("key")，t 是 control.js 里对 I18N.t 的简写
 * 切换：点 #langBtn；选择存入 localStorage，下次打开自动恢复
 * ====================================================== */
(() => {
  "use strict";

  const DICT = {
    zh: {
      /* ---- 静态界面 ---- */
      title: "空气净化器控制 · Web 蓝牙",
      appTitle: "空气净化器控制",
      notConnected: "未连接",
      switchDevice: "换设备",
      connect: "连接蓝牙",
      disconnect: "断开",
      connected: "已连接",
      power: "电源",
      powerOn: "开",
      powerOff: "关",
      levelUnit: "档",
      lvLow: "低 档",
      lvMid: "中 档",
      lvHigh: "高 档",
      logTitle: "通信日志",
      fanTitle: "风扇状态",
      fwLabel: "固件",
      otaCheck: "检查升级",
      otaChecking: "检查中…",
      otaProgress: "下载中 {p}%",
      otaUptodate: "已是最新版本",
      otaOk: "升级完成，设备重启中…",
      otaFail: "升级失败",
      otaReboot: "设备重启中…",
      modalTitle: "选择蓝牙设备",
      modalDesc: "选一个设备连接。连接过的设备会记住，下次直接点即可。",
      close: "关闭",
      scanNew: "扫描新设备",

      /* ---- WiFi 设置 ---- */
      wifiBtn: "WiFi",
      wifiTitle: "WiFi 设置",
      wifiDesc: "设备通过 WiFi 联网检查升级、下载固件。配置保存在设备上，掉电不丢。",
      wifiSsidLabel: "WiFi 名称（SSID）",
      wifiSsidPh: "家里路由器的名字",
      wifiPickLabel: "选择网络",
      wifiManual: "手动输入",
      wifiBackToList: "返回列表",
      wifiManualHint: "已切换为手动输入，适合隐藏网络。填名称和密码后保存。",
      wifiScan: "搜索附近 WiFi",
      wifiRescan: "重新搜索",
      wifiScanning: "正在搜索附近的 WiFi…（约 3 秒）",
      wifiScanningBtn: "搜索中…",
      wifiScanHint: "点「搜索附近 WiFi」，由设备扫描周围网络，选一个再填密码。",
      wifiScanEmpty: "没搜到网络，请靠近路由器或手动输入名称",
      wifiScanFail: "搜索失败或超时，请重试",
      wifiPickFirst: "请先选择一个网络",
      wifiPassLabel: "密码",
      wifiPassKeep: "留空则沿用已保存的密码",
      pwShow: "显示",
      pwHide: "隐藏",
      wifiNote: "搜索由设备完成，只支持 2.4GHz 网络；密码至少 8 位，开放网络可留空。",
      wifiSave: "保存并连接",
      wifiClear: "清除",
      wifiClearConfirm: "再点一次清除",
      wifiConnecting: "连接中…",
      wifiNotConfigured: "设备尚未配置 WiFi",
      wifiSavedNotConnected: "已保存 <b>{s}</b>，当前未连接",
      wifiConnectedTo: "已连接 <b>{s}</b>",
      wifiConnOk: "WiFi 已连接：{s}",
      wifiConnFail: "WiFi 连接失败，请检查名称和密码",
      wifiCleared: "已清除设备上的 WiFi 配置",
      wifiLost: "WiFi 已断开",
      wifiNeedSsid: "请填写 WiFi 名称",
      wifiPassShort: "密码至少 8 位",
      wifiBadSsid: "WiFi 名称不能包含英文逗号",

      /* ---- JS 动态文字 ---- */
      btUnsupportedToast: "当前浏览器不支持 Web 蓝牙，请用电脑 Chrome / Edge 或安卓 Chrome",
      btUnsupportedLog: "浏览器不支持 navigator.bluetooth",
      readAuthFail: "读取已授权设备失败：",
      unsupportedBig: "当前浏览器不支持 Web 蓝牙",
      unsupportedDesc: "请用电脑版 Chrome / Edge 或安卓 Chrome 打开（iOS 任何浏览器都不支持）。",
      emptyBig: "还没有连接过任何设备",
      emptyDesc: "点下面「扫描新设备」，系统会列出附近的蓝牙设备，<br>选哪个就连哪个。",
      advertising: "广播中",
      notAdvertising: "未在广播",
      unnamed: "(未命名设备)",
      unnamedShort: "(未命名)",
      tagConnect: "连接",
      demoToast: "预览模式：这里会打开系统设备列表",
      scanCancelled: "已取消扫描",
      scanFailed: "扫描失败：",
      selected: "已选择 ",
      connectedLog: "已连接 ",
      connectFailed: "连接失败：",
      disconnectedLog: "连接已断开",
      disconnectedToast: "蓝牙已断开",
      connectFirst: "请先连接蓝牙",
      sendFailed: "发送失败：",
      ready: "页面就绪，等待连接 ",
      hintNoBt: "<b>浏览器不支持 Web 蓝牙。</b>请用电脑版 Chrome / Edge，或安卓 Chrome 打开（iOS 的 Safari 完全不支持）。",
      hintInsecure: "<b>当前不是安全上下文。</b>Web 蓝牙要求 <code>https://</code> 或 <code>localhost</code>。用 <code>python -m http.server 8000</code> 起本地服务后访问 <code>http://localhost:8000</code> 即可。",
      hintKeys: "快捷键：<code>1</code> <code>2</code> <code>3</code> 切档 · <code>P</code> 开关 · <code>S</code> 查询 · <code>C</code> 连接"
    },
    en: {
      title: "Air Purifier Control · Web Bluetooth",
      appTitle: "Air Purifier Control",
      notConnected: "Not connected",
      switchDevice: "Switch",
      connect: "Connect",
      disconnect: "Disconnect",
      connected: "Connected",
      power: "Power",
      powerOn: "On",
      powerOff: "Off",
      levelUnit: "Level",
      lvLow: "Low",
      lvMid: "Medium",
      lvHigh: "High",
      logTitle: "Log",
      fanTitle: "Fan",
      fwLabel: "Firmware",
      otaCheck: "Check update",
      otaChecking: "Checking…",
      otaProgress: "Downloading {p}%",
      otaUptodate: "Up to date",
      otaOk: "Update complete, device rebooting…",
      otaFail: "Update failed",
      otaReboot: "Device rebooting…",
      modalTitle: "Select Bluetooth Device",
      modalDesc: "Pick a device to connect. Devices you have paired with are remembered — just tap next time.",
      close: "Close",
      scanNew: "Scan for new devices",

      /* ---- WiFi settings ---- */
      wifiBtn: "WiFi",
      wifiTitle: "WiFi Settings",
      wifiDesc: "The device uses WiFi to check for updates and download firmware. Settings are stored on the device.",
      wifiSsidLabel: "Network name (SSID)",
      wifiSsidPh: "Your router's name",
      wifiPickLabel: "Network",
      wifiManual: "Enter manually",
      wifiBackToList: "Back to list",
      wifiManualHint: "Manual entry enabled — for hidden networks. Type the name and password.",
      wifiScan: "Scan for WiFi",
      wifiRescan: "Scan again",
      wifiScanning: "Scanning nearby WiFi… (about 3 s)",
      wifiScanningBtn: "Scanning…",
      wifiScanHint: "Tap \u201cScan for WiFi\u201d — the device scans nearby networks. Pick one, then enter the password.",
      wifiScanEmpty: "No networks found — move closer to the router or enter the name manually",
      wifiScanFail: "Scan failed or timed out — please retry",
      wifiPickFirst: "Pick a network first",
      wifiPassLabel: "Password",
      wifiPassKeep: "Leave blank to keep the saved password",
      pwShow: "Show",
      pwHide: "Hide",
      wifiNote: "Scanning is done on the device. 2.4 GHz networks only; password must be at least 8 characters, leave blank for open networks.",
      wifiSave: "Save & connect",
      wifiClear: "Clear",
      wifiClearConfirm: "Tap again",
      wifiConnecting: "Connecting…",
      wifiNotConfigured: "No WiFi configured on the device",
      wifiSavedNotConnected: "Saved <b>{s}</b> · not connected",
      wifiConnectedTo: "Connected to <b>{s}</b>",
      wifiConnOk: "WiFi connected: {s}",
      wifiConnFail: "WiFi connection failed — check the name and password",
      wifiCleared: "WiFi settings cleared from the device",
      wifiLost: "WiFi disconnected",
      wifiNeedSsid: "Please enter the network name",
      wifiPassShort: "Password must be at least 8 characters",
      wifiBadSsid: "Network name cannot contain a comma",

      btUnsupportedToast: "This browser does not support Web Bluetooth. Please use desktop Chrome / Edge or Android Chrome.",
      btUnsupportedLog: "navigator.bluetooth is not supported",
      readAuthFail: "Failed to read authorized devices: ",
      unsupportedBig: "This browser does not support Web Bluetooth",
      unsupportedDesc: "Open with desktop Chrome / Edge or Android Chrome (no iOS browser supports it).",
      emptyBig: "No devices connected yet",
      emptyDesc: "Tap \u201cScan for new devices\u201d below \u2014 the system will list nearby Bluetooth devices.<br>Pick one to connect.",
      advertising: "Advertising",
      notAdvertising: "Not advertising",
      unnamed: "(Unnamed device)",
      unnamedShort: "(Unnamed)",
      tagConnect: "Connect",
      demoToast: "Preview mode: the system device picker would open here",
      scanCancelled: "Scan cancelled",
      scanFailed: "Scan failed: ",
      selected: "Selected ",
      connectedLog: "Connected to ",
      connectFailed: "Connect failed: ",
      disconnectedLog: "Disconnected",
      disconnectedToast: "Bluetooth disconnected",
      connectFirst: "Please connect via Bluetooth first",
      sendFailed: "Send failed: ",
      ready: "Ready, waiting for ",
      hintNoBt: "<b>This browser does not support Web Bluetooth.</b> Please use desktop Chrome / Edge or Android Chrome (iOS Safari is not supported).",
      hintInsecure: "<b>Not a secure context.</b> Web Bluetooth requires <code>https://</code> or <code>localhost</code>. Start a local server with <code>python -m http.server 8000</code> and open <code>http://localhost:8000</code>.",
      hintKeys: "Shortcuts: <code>1</code> <code>2</code> <code>3</code> level · <code>P</code> power · <code>S</code> status · <code>C</code> connect"
    }
  };

  function applyStatic() {
    document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = I18N.t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = I18N.t(el.dataset.i18nHtml); });
    document.querySelectorAll("[data-i18n-title]").forEach(el => { el.title = I18N.t(el.dataset.i18nTitle); });
    document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = I18N.t(el.dataset.i18nPh); });
  }

  function updateToggle() {
    const b = document.getElementById("langBtn");
    if (b) b.textContent = I18N.lang === "zh" ? "EN" : "中文";  // 按钮上显示"可切换到"的语言
  }

  const I18N = window.I18N = {
    lang: localStorage.getItem("app-lang") === "en" ? "en" : "zh",  // 默认中文，记住上次选择

    t(key) {
      const d = DICT[this.lang];
      return d && d[key] != null ? d[key] : (DICT.zh[key] != null ? DICT.zh[key] : key);  // 缺词条时回退中文
    },

    set(lang) {
      this.lang = lang;
      try { localStorage.setItem("app-lang", lang); } catch (e) {}
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      applyStatic();
      updateToggle();
      document.dispatchEvent(new Event("langchange"));  // 通知 control.js 重渲染动态文字
    },

    toggle() { this.set(this.lang === "zh" ? "en" : "zh"); }
  };

  /* 初始化：脚本在 body 末尾加载，DOM 已就绪 */
  document.documentElement.lang = I18N.lang === "zh" ? "zh-CN" : "en";
  applyStatic();
  updateToggle();

  const b = document.getElementById("langBtn");
  if (b) b.addEventListener("click", () => I18N.toggle());
})();
