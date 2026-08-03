const model = {
  authenticated: false,
  legacyToken: sessionStorage.getItem("greeApiToken") || "",
  devices: [],
  schedules: [],
  tv: null,
  aupu: null,
  plug: null,
  opple: null,
  purifier: null,
  waterHeater: null,
  xiaomiScale: null,
  xiaomiScaleHistory: [],
  xiaomiScaleSummary: null,
  xiaomiScalePreferences: { display_unit: "jin", target_weight_kg: null, target_enabled: false },
  xiaomiScaleDays: 30,
  tmall: null,
  dreame: null,
  ezviz: null,
  tvForeground: null,
  aupuTimers: new Map(),
  selectedId: null,
  drafts: new Map(),
  commandTimers: new Map(),
};

const el = (selector) => document.querySelector(selector);
const SONY_TV_DEVICE_ID = "sony-living-tv";
const MIJIA_PLUG_DEVICE_ID = "mijia-plug-3";
const AUPU_DEVICE_ID = "aupu-q360a-pro";
const statusLine = el("#statusLine");
const authDialog = el("#authDialog");
const logoutButton = el("#logoutButton");
const toast = el("#toast");
const tvScreenDialog = el("#tvScreenDialog");
const aupuSetupDialog = el("#aupuSetupDialog");
const purifierSetupDialog = el("#purifierSetupDialog");
const waterHeaterAuthDialog = el("#waterHeaterAuthDialog");
const dreameSetupDialog = el("#dreameSetupDialog");
let aupuQrPollTimer = null;
let aupuQrGeneration = 0;
let tencentCaptchaLoader = null;
let oppleCommandTimer = null;
let opplePendingCommand = {};
let climateStatusLoad = null;
let realtimeRefreshTimer = null;

const realtimeRefreshIntervals = {
  control: 5_000,
  tv: 5_000,
  aupu: 5_000,
  plug: 5_000,
  opple: 8_000,
  "xiaomi-scale": 12_000,
  schedule: 5_000,
  ezviz: 10_000,
  "smart-device": 10_000,
  dreame: 10_000,
  purifier: 10_000,
  "water-heater": 10_000,
};

const modeToApi = { Auto: "auto", Cool: "cool", Dry: "dry", Fan: "fan", Heat: "heat" };
const MIN_TEMPERATURE = 16;
const MAX_TEMPERATURE = 30;
const TEMPERATURE_STEP = 0.5;
const fanToApi = {
  Auto: "auto", Low: "low", MediumLow: "medium_low",
  Medium: "medium", MediumHigh: "medium_high", High: "high",
};
const verticalToApi = {
  Default: "middle", FullSwing: "full", FixedUpper: "upper",
  FixedUpperMiddle: "upper_middle", FixedMiddle: "middle",
  FixedLowerMiddle: "lower_middle", FixedLower: "lower",
  SwingUpper: "full", SwingUpperMiddle: "full", SwingMiddle: "full",
  SwingLowerMiddle: "full", SwingLower: "full",
};
const horizontalToApi = {
  Default: "center", FullSwing: "full", Left: "left",
  LeftCenter: "left_center", Center: "center",
  RightCenter: "right_center", Right: "right",
};

const verticalLabels = {
  full: "上下扫风",
  upper: "上方定格",
  upper_middle: "偏上定格",
  middle: "中间定格",
  lower_middle: "偏下定格",
  lower: "下方定格",
};
const horizontalLabels = {
  full: "左右扫风",
  left: "左侧定格",
  left_center: "偏左定格",
  center: "中间定格",
  right_center: "偏右定格",
  right: "右侧定格",
};

function requestHeaders(json = false) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function updateAuthControls() {
  logoutButton.hidden = !model.authenticated;
}

function openAuthDialog() {
  el("#passwordInput").value = "";
  el("#authError").textContent = "";
  updateAuthControls();
  if (!authDialog.open) authDialog.showModal();
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (response.status === 401) {
    const body = await response.json().catch(() => ({}));
    model.authenticated = false;
    setStatus("需要登录", "error");
    openAuthDialog();
    const error = new Error(body.detail || "请先登录家庭");
    error.isAuthError = true;
    throw error;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `请求失败 (${response.status})`);
  }
  return response.json();
}

async function apiBlob(path) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) {
    model.authenticated = false;
    openAuthDialog();
    throw new Error("请先登录家庭");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `请求失败 (${response.status})`);
  }
  return response.blob();
}

function ensureCameraViewer() {
  let viewer = document.querySelector("#cameraViewer");
  if (viewer) return viewer;
  viewer = document.createElement("div");
  viewer.id = "cameraViewer";
  viewer.className = "camera-viewer";
  viewer.hidden = true;
  viewer.innerHTML = `
    <section class="camera-viewer-panel" role="dialog" aria-modal="true" aria-label="摄像头直播">
      <header><div><span>本地直连</span><strong data-camera-title></strong></div><button type="button" data-camera-close aria-label="关闭">×</button></header>
      <img data-camera-live alt="">
      <p data-camera-status></p>
    </section>`;
  const close = () => {
    viewer.querySelector("[data-camera-live]").removeAttribute("src");
    viewer.hidden = true;
  };
  viewer.querySelector("[data-camera-close]").addEventListener("click", close);
  viewer.addEventListener("click", (event) => { if (event.target === viewer) close(); });
  document.body.append(viewer);
  return viewer;
}

function openCameraViewer(camera) {
  const viewer = ensureCameraViewer();
  const image = viewer.querySelector("[data-camera-live]");
  viewer.querySelector("[data-camera-title]").textContent = camera.name;
  viewer.querySelector("[data-camera-status]").textContent = "146 本地直连实时画面 · 约 5 帧/秒";
  image.alt = `${camera.name} 实时直播`;
  image.src = `${camera.live_url}?t=${Date.now()}`;
  viewer.hidden = false;
}


function requestTencentCaptcha() {
  if (!tencentCaptchaLoader) {
    tencentCaptchaLoader = new Promise((resolve, reject) => {
      if (window.TencentCaptcha) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = "https://turing.captcha.qcloud.com/TCaptcha.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("安全验证加载失败，请检查网络后重试"));
      document.head.append(script);
    });
  }
  return tencentCaptchaLoader.then(() => new Promise((resolve, reject) => {
    const captcha = new window.TencentCaptcha("199886438", (result) => {
      if (result?.ret === 0 && result.ticket && result.randstr) {
        resolve({ ticket: result.ticket, randstr: result.randstr });
      } else {
        reject(new Error("已取消安全验证"));
      }
    }, { userLanguage: "zh-cn" });
    captcha.show();
  }));
}

function selectedDevice() {
  return model.devices.find((device) => device.id === model.selectedId);
}

function draftFromDevice(device) {
  return {
    temperature: device.target_temperature || 26,
    mode: modeToApi[device.mode] || "cool",
    fan: fanToApi[device.fan_speed] || "auto",
    vertical: verticalToApi[device.vertical_swing] || "middle",
    horizontal: horizontalToApi[device.horizontal_swing] || "center",
    sleep: Boolean(device.sleep),
    light: Boolean(device.light),
    quiet: Boolean(device.quiet),
    lowerOutlet: Boolean(device.lower_outlet),
    antiDirect: Boolean(device.anti_direct),
    turbo: Boolean(device.turbo),
    health: Boolean(device.health),
    auxiliaryHeat: Boolean(device.auxiliary_heat),
  };
}

function ensureDraft(device, sync = false) {
  const selectedEditing = device.id === model.selectedId
    && (el("#climateCard")?.classList.contains("is-busy")
      || el("#temperatureRing")?.classList.contains("is-dragging")
      || el("#climateCard")?.contains(document.activeElement)
        && document.activeElement.matches("input, select, textarea"));
  if (!model.drafts.has(device.id) || sync && !model.commandTimers.has(device.id) && !selectedEditing) {
    model.drafts.set(device.id, draftFromDevice(device));
  }
  return model.drafts.get(device.id);
}

async function loadAll(refresh = true, { silent = false } = {}) {
  if (climateStatusLoad) return climateStatusLoad;
  if (!silent) setStatus("正在同步空调状态", "");
  climateStatusLoad = (async () => {
    try {
    const devices = await api(`/api/devices?refresh=${refresh}`, { headers: requestHeaders() });
    model.authenticated = true;
    updateAuthControls();
    model.devices = devices;
    devices.forEach((device) => ensureDraft(device, true));
    if (!devices.some((device) => device.id === model.selectedId)) {
      model.selectedId = devices[0]?.id || null;
    }
    render();
    if (!silent) setStatus(`${devices.length} 台空调本地在线`, "online");
    } catch (error) {
      if (!error.isAuthError && !silent) {
      setStatus("连接失败", "error");
      showToast(error.message);
      }
    } finally {
      climateStatusLoad = null;
    }
  })();
  return climateStatusLoad;
}

const viewLoads = new Map();

async function loadViewData(view, force = false, { silent = false, realtime = false } = {}) {
  if (!view || view === "control") return;
  if (viewLoads.has(view)) return viewLoads.get(view);

  const request = (async () => {
    try {
      if (view === "tv") {
        model.tv = await api("/api/tv", { headers: requestHeaders() });
        renderTV();
        loadTVForeground();
      } else if (view === "aupu") {
        [model.aupu, model.schedules] = await Promise.all([
          api("/api/aupu", { headers: requestHeaders() }),
          api("/api/schedules", { headers: requestHeaders() }),
        ]);
        renderAupu();
      } else if (view === "opple") {
        model.opple = await api("/api/opple", { headers: requestHeaders() });
        renderOpple();
      } else if (view === "plug") {
        model.plug = await api("/api/plug", { headers: requestHeaders() });
        renderPlug();
      } else if (view === "xiaomi-scale") {
        const statusPath = realtime ? "/api/xiaomi-scale?scan_seconds=4" : "/api/xiaomi-scale";
        [model.xiaomiScale, model.xiaomiScaleHistory, model.xiaomiScaleSummary, model.xiaomiScalePreferences] = await Promise.all([
          api(statusPath, { headers: requestHeaders() }),
          api("/api/xiaomi-scale/history?limit=100", { headers: requestHeaders() }).catch(() => []),
          api(`/api/xiaomi-scale/summary?days=${model.xiaomiScaleDays}`, { headers: requestHeaders() }).catch(() => null),
          api("/api/xiaomi-scale/preferences", { headers: requestHeaders() }).catch(() => model.xiaomiScalePreferences),
        ]);
        renderXiaomiScale();
      } else if (view === "smart-device") {
        model.tmall = await api("/api/tmall", { headers: requestHeaders() });
        renderSmartDevices();
      } else if (view === "dreame") {
        model.dreame = await api("/api/dreame", { headers: requestHeaders() });
        renderSmartDevices();
      } else if (view === "ezviz") {
        model.ezviz = await api("/api/ezviz", { headers: requestHeaders() });
        renderEzviz();
      } else if (view === "purifier") {
        model.purifier = await api("/api/purifier", { headers: requestHeaders() });
        renderPurifier();
      } else if (view === "water-heater") {
        model.waterHeater = await api("/api/water-heater", { headers: requestHeaders() });
        renderWaterHeater();
      } else if (view === "schedule") {
        model.schedules = await api("/api/schedules", { headers: requestHeaders() });
        renderSchedules();
      }
    } catch (error) {
      if (!error.isAuthError && !silent) showToast(error.message);
    }
  })();

  viewLoads.set(view, request);
  try {
    await request;
  } finally {
    if (viewLoads.get(view) === request) viewLoads.delete(view);
  }
}

function realtimeRefreshPaused() {
  if (!model.authenticated || document.hidden) return true;
  if (document.querySelector("dialog[open], .is-busy, .is-dragging")) return true;
  return document.activeElement?.matches("input, select, textarea") || false;
}

function scheduleRealtimeRefresh(delay) {
  clearTimeout(realtimeRefreshTimer);
  const view = document.body.dataset.view || "control";
  realtimeRefreshTimer = setTimeout(runRealtimeRefresh, delay ?? realtimeRefreshIntervals[view] ?? 10_000);
}

async function runRealtimeRefresh() {
  const view = document.body.dataset.view || "control";
  try {
    if (!realtimeRefreshPaused()) {
      if (view === "control") await loadAll(true, { silent: true });
      else await loadViewData(view, true, { silent: true, realtime: true });
    }
  } finally {
    scheduleRealtimeRefresh();
  }
}

function setStatus(text, className) {
  statusLine.className = `status-line ${className}`;
  statusLine.querySelector("span").textContent = text;
}

function render() {
  renderTabs();
  renderDevice();
  renderScheduleTargets();
  renderSchedules();
  renderTV();
  renderAupu();
  renderPlug();
  renderOpple();
  renderXiaomiScale();
  renderPurifier();
  renderWaterHeater();
  renderSmartDevices();
  renderEzviz();
}

function renderEzviz() {
  const summary = el("#ezvizSummary");
  const grid = el("#ezvizGrid");
  if (!summary || !grid || !model.ezviz) return;
  const cameras = model.ezviz.cameras || [];
  const online = cameras.filter((camera) => camera.online).length;
  summary.textContent = `${online}/${cameras.length} 路摄像头在线`;
  grid.replaceChildren(...cameras.map((camera) => {
    const card = document.createElement("article");
    card.className = "ezviz-card";
    const header = document.createElement("div");
    header.className = "ezviz-card-header";
    header.innerHTML = `<strong></strong><span></span>`;
    header.querySelector("strong").textContent = camera.name;
    const services = (camera.services || []).map((item) => `${item.name} ${item.port}`).join(" · ");
    header.querySelector("span").textContent =
      `${camera.ip}:${camera.port} · ${camera.online ? "在线" : "离线"}${services ? ` · ${services}` : ""}`;
    let media;
    if (camera.online) {
      media = document.createElement("img");
      media.alt = `${camera.name} 实时画面`;
      media.loading = "lazy";
      media.src = `${camera.snapshot_url}?t=${Date.now()}`;
      media.onerror = () => {
        const placeholder = document.createElement("div");
        placeholder.className = "ezviz-placeholder";
        placeholder.textContent = "视频接口可达，暂未取得画面";
        media.replaceWith(placeholder);
      };
    } else {
      media = document.createElement("div");
      media.className = "ezviz-placeholder";
      media.textContent = `${camera.protocol} 设备当前离线`;
    }
    const actions = document.createElement("div");
    actions.className = "ezviz-actions";
    const live = document.createElement("button");
    live.type = "button";
    live.textContent = "实时观看";
    live.disabled = !camera.online;
    live.addEventListener("click", () => openCameraViewer(camera));
    actions.append(live);
    card.append(header, media);
    if (actions.childElementCount) card.append(actions);
    return card;
  }));
  if (!window.ezvizSnapshotTimer) {
    window.ezvizSnapshotTimer = window.setInterval(() => {
      document.querySelectorAll(".ezviz-card img").forEach((image) => {
        const base = image.src.split("?")[0];
        image.src = `${base}?t=${Date.now()}`;
      });
    }, 15000);
  }
}

function renderSmartDevices() {
  const tmall = model.tmall;
  const dreame = model.dreame;
  if (tmall) {
    el("#tmallSummary").textContent = `${tmall.online_count}/${tmall.devices.length} 台局域网在线`;
    el("#tmallNotice").textContent = tmall.notice || "";
    el("#tmallDeviceList").replaceChildren(...tmall.devices.map((device) => {
      const row = document.createElement("div");
      row.className = "tmall-device";
      row.innerHTML = `<div><strong>${device.name}</strong><span>${device.ip}</span></div><b class="device-presence ${device.online ? "online" : ""}">${device.online ? "在线" : "离线"}</b>`;
      return row;
    }));
    const bridge = tmall.voice_bridge || {};
    el("#tmallBridgeStatus").textContent = bridge.configured
      ? "146 技能网关已就绪"
      : "等待生成 AliGenie 技能凭据";
    if (bridge.developer_url) el("#tmallDeveloperLink").href = bridge.developer_url;
  }
  if (dreame) {
    el("#dreameName").textContent = dreame.device_name || dreame.model_name || "追觅 X30";
    el("#dreameStatus").textContent = dreame.configured
      ? `${dreame.ip} · ${dreame.online ? "云端在线" : (dreame.error || "暂时离线")}`
      : `${dreame.ip} · 等待 Dreamehome 授权`;
    el("#dreameBattery").textContent = dreame.battery ?? "—";
    el("#dreameArea").textContent = dreame.cleaned_area ?? "—";
    el("#dreameTime").textContent = dreame.cleaning_time ?? "—";
    el("#dreameCount").textContent = dreame.cleaning_count ?? "—";
    el("#dreameBaseStatus").textContent = dreame.base_status_text || "基站状态未知";
    el("#dreameTankStatus").textContent =
      `${[0, 3].includes(dreame.clean_water_tank_status) ? "清水箱正常" : "请检查清水箱"} · ${dreame.dirty_water_tank_status === 0 ? "污水箱正常" : "请检查污水箱"}`;
    const values = {
      cleaning_mode: dreame.cleaning_mode_value,
      suction_level: dreame.suction_level,
      wetness_level: dreame.wetness_level,
      mop_wash_level: dreame.mop_wash_level,
      volume: dreame.volume,
    };
    document.querySelectorAll("[data-dreame-setting]").forEach((control) => {
      const setting = control.dataset.dreameSetting;
      if (control.type === "checkbox") {
        control.checked = Boolean(dreame[setting]);
      } else if (values[setting] != null) {
        control.value = String(values[setting]);
      }
      control.disabled = !dreame.configured || !dreame.online;
    });
    el("#dreameVolumeValue").textContent = dreame.volume ?? "—";
    const capabilities = new Set(dreame.capabilities || []);
    document.querySelectorAll("[data-dreame-capability]").forEach((item) => {
      item.hidden = !capabilities.has(item.dataset.dreameCapability);
    });
    const consumables = {
      dreameMainBrush: dreame.main_brush_left,
      dreameSideBrush: dreame.side_brush_left,
      dreameFilter: dreame.filter_left,
      dreameSensor: dreame.sensor_dirty_left,
      dreameSilverIon: dreame.silver_ion_left,
    };
    Object.entries(consumables).forEach(([id, value]) => {
      el(`#${id}`).textContent = value ?? "—";
    });
    const baseStop = el("#dreameBaseStop");
    baseStop.hidden = ![1, 2].includes(dreame.base_status);
    baseStop.dataset.dreameAction = dreame.base_status === 2 ? "stop_drying" : "stop_washing";
    el("#dreameSetupButton").textContent = dreame.configured ? "重新连接 Dreamehome" : "连接 Dreamehome";
    document.querySelectorAll("[data-dreame-action]").forEach((button) => {
      button.disabled = !dreame.configured || !dreame.online;
    });
  }
}

async function sendDreameCommand(action) {
  try {
    model.dreame = await api("/api/dreame/command", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({ action }),
    });
    renderSmartDevices();
    showToast("追觅 X30 指令已发送");
  } catch (error) {
    showToast(error.message);
  }
}

async function sendDreameSetting(setting, value, control) {
  control.disabled = true;
  try {
    model.dreame = await api("/api/dreame/setting", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({ setting, value }),
    });
    renderSmartDevices();
    showToast("追觅 X30 设置已更新");
  } catch (error) {
    renderSmartDevices();
    showToast(error.message);
  } finally {
    control.disabled = false;
  }
}

function renderWaterHeater() {
  const device = model.waterHeater;
  if (!device) return;
  el("#waterHeaterStatus").textContent = `${device.ip} · ${device.status_text}`;
  el("#waterHeaterLanStatus").textContent =
    device.reachable ? "局域网在线" : "当前离线";
  el("#waterHeaterCloudStatus").textContent =
    device.control_ready ? "已授权" : "等待华为授权";
  el("#waterHeaterNotice").textContent = device.notice;
  el("#waterHeaterAuthButton").textContent =
    device.control_ready ? "查看云授权" : "配置云授权";
}

function renderPurifier() {
  const device = model.purifier;
  if (!device) return;
  let status = `${device.ip} · 等待连接 AI‑LiNK`;
  if (device.configured) {
    status = device.error
      ? `${device.ip} · ${device.error}`
      : `${device.ip} · ${device.online === false ? "云端离线" : "云端已连接"}`;
  }
  el("#purifierStatus").textContent = status;
  el("#purifierRoomField").hidden = !device.room;
  el("#purifierRoom").textContent = device.room || "—";
  el("#purifierNameField").hidden = !device.device_name;
  el("#purifierName").textContent = device.device_name || "—";
  const detail = el("#purifierDetail");
  detail.hidden = !device.detail_url;
  if (device.detail_url) detail.href = device.detail_url;
  el("#purifierSetupButton").textContent =
    device.configured ? "重新连接 AI‑LiNK" : "连接 AI‑LiNK";
}

function plugSupports(name) {
  return Boolean(model.plug?.capabilities?.includes(name));
}

function renderPlug() {
  const device = model.plug;
  if (!device) return;
  el("#plugStatus").textContent = device.online
    ? `${device.ip} · ${device.configured ? (device.on ? "已通电" : "已关闭") : "已发现，等待连接"}`
    : `${device.ip} · ${device.error || "离线"}`;
  el("#plugPowerButton").classList.toggle("is-on", Boolean(device.on));
  el("#plugPowerButton").disabled = !device.configured || !device.online;
  el("#plugElectricPower").textContent = device.electric_power ?? "—";
  el("#plugEnergy").textContent = device.energy_kwh ?? "—";
  el("#plugTemperature").textContent = device.temperature ?? "—";
  el("#plugFault").textContent = device.fault_name || "—";
  el("#plugFault").classList.toggle("has-fault", Boolean(device.fault));

  const settings = [
    ["plugDefaultStateField", "default_power_state"],
    ["plugLockCard", "physical_lock"],
    ["plugIndicatorCard", "indicator_light"],
    ["plugChargingCard", "charging_protection"],
    ["plugMaxPowerCard", "max_power_limit"],
    ["plugMaxPowerField", "max_power"],
  ];
  settings.forEach(([id, capability]) => {
    el(`#${id}`).hidden = device.configured && !plugSupports(capability);
  });
  el("#plugDefaultState").value = String(device.default_power_state ?? 0);
  el("#plugLock").checked = Boolean(device.physical_lock);
  el("#plugIndicator").checked = Boolean(device.indicator_light);
  el("#plugCharging").checked = Boolean(device.charging_protection);
  el("#plugMaxPowerEnabled").checked = Boolean(device.max_power_limit);
  el("#plugMaxPower").value = String(device.max_power ?? 2500);
  document.querySelectorAll("#plugView input, #plugView select").forEach((control) => {
    control.disabled = !device.configured || !device.online;
  });
  el("#plugSetupButton").hidden = device.configured;
}

async function sendPlugCommand(payload) {
  el("#plugView").classList.add("is-busy");
  try {
    model.plug = await api("/api/plug/command", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify(payload),
    });
    renderPlug();
    showToast("智能插座设置已生效");
  } catch (error) {
    renderPlug();
    showToast(error.message);
  } finally {
    el("#plugView").classList.remove("is-busy");
  }
}

function renderOpple() {
  const device = model.opple;
  if (!device) return;
  el("#oppleStatus").textContent = device.online
    ? `${device.ip} · ${device.power ? "已打开" : "已关闭"} · 本地控制`
    : `${device.ip} · ${device.error || "离线"}`;
  const power = el("#opplePowerButton");
  const brightness = el("#oppleBrightness");
  const color = el("#oppleColor");
  power.classList.toggle("is-on", Boolean(device.power));
  power.disabled = !device.online;
  brightness.disabled = !device.online;
  color.disabled = !device.online;
  if (Number.isFinite(device.brightness)) brightness.value = device.brightness;
  if (Number.isFinite(device.color_temperature)) color.value = device.color_temperature;
  el("#oppleBrightnessValue").textContent =
    Number.isFinite(device.brightness) ? device.brightness : "—";
  el("#oppleColorValue").textContent =
    Number.isFinite(device.color_temperature) ? device.color_temperature : "—";
  el("#oppleGlow").classList.toggle("is-on", Boolean(device.power));
  if (Number.isFinite(device.brightness)) {
    el("#oppleGlow").style.setProperty("--light-opacity", String(Math.max(.18, device.brightness / 100)));
  }
}

function formatBeijingTime(value) {
  if (!value) return "—";
  const text = String(value);
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}+08:00`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return text.replace("T", " ");
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}

const scaleUnitLabels = { kg: "千克", jin: "斤", lb: "磅" };
const scaleUnitToKg = { kg: 1, jin: 0.5, lb: 0.45359237 };

function scaleWeightToKg(value, unit) {
  const number = Number(value);
  const factor = scaleUnitToKg[String(unit || "").toLowerCase()];
  return Number.isFinite(number) && factor ? number * factor : null;
}

function scaleWeightFromKg(value, unit) {
  const factor = scaleUnitToKg[unit] || 1;
  return Number(value) / factor;
}

function formatScaleWeight(value, sourceUnit, displayUnit) {
  const kg = scaleWeightToKg(value, sourceUnit);
  if (!Number.isFinite(kg)) return "—";
  return `${scaleWeightFromKg(kg, displayUnit).toFixed(2)} ${scaleUnitLabels[displayUnit] || displayUnit}`;
}

function formatScaleKg(value, displayUnit, signed = false) {
  if (!Number.isFinite(Number(value))) return "—";
  const number = scaleWeightFromKg(Number(value), displayUnit);
  const prefix = signed && number > 0 ? "+" : "";
  return `${prefix}${number.toFixed(2)} ${scaleUnitLabels[displayUnit] || displayUnit}`;
}

function formatScaleShortTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const today = new Date();
  const isToday = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat("zh-CN", isToday
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(date).replaceAll("/", "-");
}

function renderXiaomiScaleTrend(points, displayUnit) {
  const host = el("#xiaomiScaleTrend");
  if (!host) return;
  host.replaceChildren();
  if (!Array.isArray(points) || points.length < 2) {
    const empty = document.createElement("span");
    empty.textContent = "至少需要两次稳定称重才显示趋势";
    host.append(empty);
    return;
  }
  const values = points.map((point) => scaleWeightFromKg(Number(point.weight_kg), displayUnit));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.1);
  const width = 360;
  const height = 130;
  const padding = 18;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "体重趋势图");
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const gradient = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
  gradient.setAttribute("id", "xiaomiScaleTrendGradient");
  gradient.setAttribute("x1", "0");
  gradient.setAttribute("y1", "0");
  gradient.setAttribute("x2", "0");
  gradient.setAttribute("y2", "1");
  [["0%", ".24"], ["100%", "0"]].forEach(([offset, opacity]) => {
    const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", "#07c160");
    stop.setAttribute("stop-opacity", opacity);
    gradient.append(stop);
  });
  defs.append(gradient);
  svg.append(defs);
  const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  const coordinates = values.map((value, index) => {
    const x = padding + (width - padding * 2) * (index / Math.max(1, values.length - 1));
    const y = height - padding - ((value - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  path.setAttribute("points", coordinates.join(" "));
  path.setAttribute("fill", "none");
  path.setAttribute("class", "xiaomi-scale-trend-line");
  area.setAttribute("points", `${padding},${height - padding} ${coordinates.join(" ")} ${width - padding},${height - padding}`);
  area.setAttribute("class", "xiaomi-scale-trend-area");
  svg.append(area, path);
  coordinates.forEach((coordinate) => {
    const [x, y] = coordinate.split(",");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", x);
    circle.setAttribute("cy", y);
    circle.setAttribute("r", "3.5");
    circle.setAttribute("class", "xiaomi-scale-trend-dot");
    svg.append(circle);
  });
  const label = document.createElement("span");
  label.textContent = `${formatScaleKg(min, displayUnit)} — ${formatScaleKg(max, displayUnit)}`;
  host.append(svg, label);
}

function renderXiaomiScaleInsights() {
  const summary = model.xiaomiScaleSummary || {};
  const preferences = model.xiaomiScalePreferences || {};
  const displayUnit = scaleUnitToKg[preferences.display_unit] ? preferences.display_unit : "jin";
  const average = el("#xiaomiScaleAverage");
  const change = el("#xiaomiScaleChange");
  const range = el("#xiaomiScaleRange");
  const period = el("#xiaomiScaleSummaryPeriod");
  if (average) average.textContent = formatScaleKg(summary.average_kg, displayUnit);
  if (change) change.textContent = formatScaleKg(summary.change_kg, displayUnit, true);
  if (range) {
    range.textContent = Number.isFinite(Number(summary.min_kg)) && Number.isFinite(Number(summary.max_kg))
      ? `${formatScaleKg(summary.min_kg, displayUnit)} — ${formatScaleKg(summary.max_kg, displayUnit)}`
      : "—";
  }
  if (period) period.textContent = `近 ${summary.days || model.xiaomiScaleDays} 天 · ${summary.count || 0} 条`;
  document.querySelectorAll("[data-scale-days]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.scaleDays) === Number(model.xiaomiScaleDays));
  });
  renderXiaomiScaleTrend(summary.points || [], displayUnit);
}

function renderXiaomiScale() {
  const device = model.xiaomiScale;
  if (!device) return;
  const advertisement = device.advertisement || {};
  const hasWeight = Boolean(advertisement.has_weight)
    && Number.isFinite(Number(advertisement.weight));
  const preferences = model.xiaomiScalePreferences || {};
  const displayUnit = scaleUnitToKg[preferences.display_unit] ? preferences.display_unit : "jin";
  const history = Array.isArray(model.xiaomiScaleHistory) ? model.xiaomiScaleHistory : [];
  const latestRecord = history[0] || null;
  const weight = hasWeight
    ? formatScaleWeight(advertisement.weight, advertisement.unit, displayUnit)
    : (latestRecord ? formatScaleWeight(latestRecord.weight, latestRecord.unit, displayUnit) : "—");
  const latestRecordKg = history[0] ? scaleWeightToKg(history[0].weight, history[0].unit) : null;
  const previousRecordKg = history[1] ? scaleWeightToKg(history[1].weight, history[1].unit) : null;

  el("#xiaomiScaleStatus").textContent = device.online
    ? "蓝牙连接正常，读数会自动保存"
    : "暂未发现电子秤，请站上秤面唤醒";
  el("#xiaomiScaleWeight").textContent = weight;
  el("#xiaomiScaleWeightLabel").textContent = hasWeight ? "本次体重" : (latestRecord ? "最近体重" : "本次体重");
  el("#xiaomiScaleReading").textContent = hasWeight
    ? (advertisement.stable ? "读数已稳定并保存" : "正在测量，请保持身体稳定")
    : (latestRecord ? `记录于 ${formatBeijingTime(latestRecord.measured_at || latestRecord.recorded_at)}` : "站上秤面，保持身体稳定");
  const live = el("#xiaomiScaleLive");
  if (live) {
    live.classList.toggle("is-online", Boolean(device.online));
    live.classList.toggle("is-measuring", Boolean(hasWeight && !advertisement.stable));
    live.querySelector("span").textContent = hasWeight
      ? (advertisement.stable ? "已记录" : "测量中")
      : (device.online ? "已连接" : "等待称重");
  }
  el("#xiaomiScaleStability").textContent = hasWeight
    ? (advertisement.stable ? "已稳定" : "测量中")
    : "—";
  const latestStableAt = hasWeight && advertisement.measured_at
    ? advertisement.measured_at
    : history[0]?.measured_at || advertisement.measured_at;
  el("#xiaomiScaleMeasuredAt").textContent = formatBeijingTime(latestStableAt);
  const measuredAt = el("#xiaomiScaleMeasuredAt");
  if (measuredAt) measuredAt.textContent = formatScaleShortTime(latestStableAt);
  el("#xiaomiScaleMac").textContent = device.mac || "—";
  el("#xiaomiScaleRaw").textContent = advertisement.raw
    ? `广播：${advertisement.raw}`
    : "未收到广播数据";

  el("#xiaomiScaleHistorySummary").textContent = history.length ? `${history.length} 条` : "暂无记录";
  const previousChange = el("#xiaomiScalePreviousChange");
  if (previousChange) {
    const delta = Number.isFinite(latestRecordKg) && Number.isFinite(previousRecordKg)
      ? latestRecordKg - previousRecordKg
      : null;
    previousChange.textContent = Number.isFinite(delta) ? formatScaleKg(delta, displayUnit, true) : "首次记录";
    previousChange.classList.toggle("is-good", Number.isFinite(delta) && delta <= 0);
    previousChange.classList.toggle("is-warning", Number.isFinite(delta) && delta > 0);
  }
  const targetProgress = el("#xiaomiScaleTargetProgress");
  if (targetProgress) {
    const targetKg = Number(preferences.target_weight_kg);
    const currentKg = Number.isFinite(latestRecordKg) ? latestRecordKg : scaleWeightToKg(advertisement.weight, advertisement.unit);
    if (preferences.target_enabled && Number.isFinite(targetKg) && Number.isFinite(currentKg)) {
      const delta = currentKg - targetKg;
      targetProgress.textContent = delta <= 0 ? "已达成" : `还差 ${formatScaleKg(delta, displayUnit)}`;
      targetProgress.classList.toggle("is-good", delta <= 0);
    } else {
      targetProgress.textContent = "未设置";
      targetProgress.classList.remove("is-good");
    }
  }

  el("#xiaomiScaleHistoryList").replaceChildren(...history.slice(0, 12).map((record, index) => {
    const row = document.createElement("div");
    row.className = "xiaomi-scale-history-row";
    const weightText = Number.isFinite(Number(record.weight))
      ? formatScaleWeight(record.weight, record.unit, displayUnit)
      : "—";
    const body = document.createElement("div");
    const weight = document.createElement("strong");
    weight.textContent = weightText;
    const time = document.createElement("small");
    time.textContent = formatBeijingTime(record.measured_at || record.recorded_at);
    body.append(weight, time);
    const nextRecord = history[index + 1];
    const recordKg = scaleWeightToKg(record.weight, record.unit);
    const nextKg = nextRecord ? scaleWeightToKg(nextRecord.weight, nextRecord.unit) : null;
    const delta = Number.isFinite(recordKg) && Number.isFinite(nextKg) ? recordKg - nextKg : null;
    const change = document.createElement("span");
    change.textContent = Number.isFinite(delta) ? `较上次 ${formatScaleKg(delta, displayUnit, true)}` : "首次记录";
    change.classList.toggle("is-up", Number.isFinite(delta) && delta > 0);
    change.classList.toggle("is-down", Number.isFinite(delta) && delta < 0);
    row.append(body, change);
    return row;
  }));
  const collector = el("#xiaomiScaleCollector");
  if (collector) {
    const scanText = device.last_scan_at ? `最近扫描：${formatBeijingTime(device.last_scan_at)}` : "尚未扫描";
    const intervalText = device.collector_enabled ? `自动采集：每 ${Math.round((device.poll_seconds || 0) / 60)} 分钟` : "自动采集已关闭";
    collector.textContent = `${intervalText} · ${scanText}${device.last_scan_error ? ` · ${device.last_scan_error}` : ""}`;
  }
  const unitSelect = el("#xiaomiScaleUnit");
  const target = el("#xiaomiScaleTarget");
  const targetEnabled = el("#xiaomiScaleTargetEnabled");
  if (unitSelect) unitSelect.value = displayUnit;
  if (target) target.value = Number.isFinite(Number(preferences.target_weight_kg)) ? preferences.target_weight_kg : "";
  if (targetEnabled) targetEnabled.checked = Boolean(preferences.target_enabled);
  renderXiaomiScaleInsights();
}

async function sendOppleCommand(payload) {
  el("#oppleView").classList.add("is-busy");
  try {
    model.opple = await api("/api/opple/command", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify(payload),
    });
    renderOpple();
    showToast("欧普灯设置已生效");
  } catch (error) {
    renderOpple();
    showToast(error.message);
  } finally {
    el("#oppleView").classList.remove("is-busy");
  }
}

function queueOppleCommand(payload) {
  opplePendingCommand = { ...opplePendingCommand, ...payload };
  clearTimeout(oppleCommandTimer);
  oppleCommandTimer = setTimeout(() => {
    const command = opplePendingCommand;
    opplePendingCommand = {};
    sendOppleCommand(command);
  }, 220);
}

function renderAupu() {
  const device = model.aupu;
  if (!device) return;
  model.aupuTimers.clear();
  model.schedules
    .filter((item) => item.status === "pending" && item.device_id === AUPU_DEVICE_ID)
    .forEach((item) => {
      const command = item.command || {};
      if (command.mode === 0 && item.label?.includes("浴霸")) {
        const modeMatch = item.label.match(/模式(\d+)/);
        if (modeMatch) model.aupuTimers.set(`mode:${modeMatch[1]}`, item.id);
      }
    });
  el("#aupuStatus").textContent = device.online
    ? `${device.ip} · ${device.configured ? "本地在线" : "已发现，等待连接"}`
    : `${device.ip} · ${device.error || "离线"}`;
  el("#aupuModeName").textContent = device.mode_name || "—";
  el("#aupuModes").replaceChildren(...device.modes.map((mode) => {
    const row = document.createElement("div");
    row.className = "aupu-mode-action";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.aupuMode = mode.value;
    button.textContent = mode.label;
    button.classList.toggle("active", mode.value === device.mode);
    button.disabled = !device.configured || !device.online;
    if (Number(mode.value) === 0) {
      row.classList.add("is-standby");
      row.append(button);
      return row;
    }
    const timer = document.createElement("button");
    timer.type = "button";
    timer.className = "aupu-timer-button";
    timer.dataset.aupuTimer = `mode:${mode.value}`;
    timer.setAttribute("aria-label", `${mode.label}开启30分钟后关闭`);
    timer.innerHTML = "<span>30分钟</span>";
    timer.disabled = button.disabled;
    timer.classList.toggle("is-scheduled", model.aupuTimers.has(timer.dataset.aupuTimer));
    row.append(button, timer);
    return row;
  }));
  el("#aupuLight").checked = Boolean(device.light);
  el("#aupuLight").disabled = !device.configured || !device.online;
  el("#aupuSetupButton").hidden = device.configured;
}

async function sendAupuCommand(payload) {
  el("#aupuView").classList.add("is-busy");
  try {
    model.aupu = await api("/api/aupu/command", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify(payload),
    });
    if (payload.mode !== undefined && payload.mode !== null) {
      model.schedules = model.schedules.filter((item) => !(
        item.status === "pending"
        && item.device_id === AUPU_DEVICE_ID
        && (item.command || {}).mode === 0
      ));
      renderSchedules();
    }
    renderAupu();
    showToast("浴霸设置已生效");
    return model.aupu;
  } catch (error) {
    renderAupu();
    showToast(error.message);
    return null;
  } finally {
    el("#aupuView").classList.remove("is-busy");
  }
}

async function scheduleAupuAutoOff(command, offCommand, timerKey, label) {
  try {
    const updated = await sendAupuCommand(command);
    if (!updated) return;
    const previousId = model.aupuTimers.get(timerKey);
    if (previousId) {
      await api(`/api/schedules/${previousId}`, {
        method: "DELETE",
        headers: requestHeaders(),
      });
      model.schedules = model.schedules.filter((item) => item.id !== previousId);
    }
    const created = await api("/api/schedules", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({
        device_id: AUPU_DEVICE_ID,
        action: "off",
        run_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        label: `${label} 30分钟后自动关闭${timerKey.startsWith("mode:") ? ` · 模式${timerKey.split(":")[1]}` : ""}`,
        command: offCommand,
      }),
    });
    model.aupuTimers.set(timerKey, created.id);
    model.schedules = [created, ...model.schedules.filter((item) => item.id !== created.id)];
    renderAupu();
    renderSchedules();
    showToast(`${label}将在30分钟后自动关闭`);
  } catch (error) {
    renderAupu();
  }
}

function renderTV() {
  const tv = model.tv;
  if (!tv) return;
  el("#tvName").textContent = `${tv.brand} ${tv.model}`;
  el("#tvStatus").textContent = tv.online
    ? `${tv.ip} · ${tv.power ? "播放中" : "待机"}${tv.input_title ? ` · ${tv.input_title}` : ""}`
    : `${tv.ip} · ${tv.error || "离线"}`;
  el("#tvPowerButton").classList.toggle("is-on", Boolean(tv.power));
  el("#tvPowerButton").disabled = !tv.configured;
  el("#tvScreenButton").disabled = !tv.configured || !tv.online;
  el("#tvScreenNowPlaying").textContent = tv.power
    ? `正在播放：${tv.input_title || "当前电视内容"}`
    : "电视当前处于待机状态";
  const inputSelect = el("#tvInputSelect");
  inputSelect.replaceChildren(...(tv.inputs || []).map((input) => {
    const option = document.createElement("option");
    option.value = input.uri;
    option.textContent = `${input.title}${input.connected ? "" : "（未连接）"}`;
    option.selected = input.uri === tv.input_uri;
    return option;
  }));
  inputSelect.disabled = !tv.configured || !tv.online;
  document.querySelectorAll("[data-tv-remote]").forEach((button) => {
    button.disabled = !tv.configured || !tv.online;
  });
  renderTVApps();
}

async function sendTVCommand(payload) {
  try {
    model.tv = await api("/api/tv/command", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify(payload),
    });
    renderTV();
    showToast("电视设置已生效");
  } catch (error) {
    showToast(error.message);
  }
}

async function loadTVForeground() {
  const target = el("#tvForegroundApp");
  target.textContent = "前台应用：正在识别";
  target.removeAttribute("title");
  try {
    const foreground = await api("/api/tv/foreground", {
      headers: requestHeaders(),
    });
    model.tvForeground = foreground;
    target.textContent = foreground.available
      ? `前台应用：${foreground.name}`
      : "前台应用：暂时无法识别";
    if (foreground.package) {
      target.title = `${foreground.package}/${foreground.activity || ""}`;
    }
  } catch {
    model.tvForeground = null;
    target.textContent = "前台应用：暂时无法读取";
  }
  renderTVApps();
}

function renderTVApps() {
  const foreground = model.tvForeground;
  const buttons = document.querySelectorAll("[data-tv-app]");
  let activeLabel = "";
  buttons.forEach((button) => {
    const active = Boolean(
      foreground?.available &&
      foreground.package === button.dataset.tvAppPackage
    );
    button.classList.toggle("active", active);
    button.disabled = !model.tv?.configured || !model.tv?.online;
    if (active) activeLabel = button.querySelector("b")?.textContent || "";
  });
  document.querySelectorAll("[data-tv-cleanup]").forEach((button) => {
    button.disabled = !model.tv?.configured || !model.tv?.online;
  });
  el("#tvActiveApp").textContent = activeLabel
    ? `${activeLabel} 正在运行`
    : foreground?.available
      ? foreground.name
      : "选择后立即打开";
}

async function cleanupTVApps() {
  document.querySelectorAll("[data-tv-app], [data-tv-cleanup]").forEach((item) => {
    item.disabled = true;
  });
  showToast("正在清理电视应用");
  try {
    const result = await api("/api/tv/cleanup", {
      method: "POST",
      headers: requestHeaders(),
    });
    model.tvForeground = result.foreground || null;
    renderTVApps();
    showToast(
      result.stopped_name
        ? `已关闭 ${result.stopped_name} 并完成清理`
        : "后台进程已清理"
    );
  } catch (error) {
    renderTVApps();
    showToast(error.message);
  }
}

async function launchTVApp(button) {
  const appId = button.dataset.tvApp;
  const label = button.querySelector("b")?.textContent || "应用";
  const wasStandby = !model.tv?.power;
  document.querySelectorAll("[data-tv-app]").forEach((item) => {
    item.disabled = true;
  });
  showToast(wasStandby ? `正在启动电视并打开 ${label}` : `正在打开 ${label}`);
  try {
    const result = await api(`/api/tv/apps/${appId}`, {
      method: "POST",
      headers: requestHeaders(),
    });
    if (result.powered_on && model.tv) {
      model.tv.power = true;
      model.tv.online = true;
    }
    model.tvForeground = result.foreground || null;
    renderTVApps();
    showToast(result.powered_on ? `电视已启动并打开 ${label}` : `已打开 ${label}`);
  } catch (error) {
    renderTVApps();
    showToast(error.message);
  }
}

async function captureTVScreen() {
  const image = el("#tvScreenImage");
  const placeholder = el("#tvScreenPlaceholder");
  const button = el("#refreshTvScreen");
  button.disabled = true;
  button.textContent = "正在获取画面…";
  placeholder.hidden = false;
  placeholder.textContent = "正在连接电视并抓取当前画面…";
  image.hidden = true;
  await loadTVForeground();
  try {
    const blob = await apiBlob(`/api/tv/screenshot?t=${Date.now()}`);
    image.src = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result), { once: true });
      reader.addEventListener("error", () => reject(new Error("无法读取电视截图")), { once: true });
      reader.readAsDataURL(blob);
    });
    await image.decode();
    image.hidden = false;
    placeholder.hidden = true;
  } catch (error) {
    placeholder.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "刷新画面";
  }
}

function renderTabs() {
  const tabs = el("#roomTabs");
  tabs.replaceChildren(...model.devices.map((device) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = device.room;
    button.className = device.id === model.selectedId ? "active" : "";
    button.addEventListener("click", () => {
      model.selectedId = device.id;
      render();
    });
    return button;
  }));
}

function renderDevice() {
  const device = selectedDevice();
  if (!device) return;
  const draft = ensureDraft(device);
  const card = el("#climateCard");
  card.className = `climate-card ${device.power ? "" : "is-off"}`;
  el("#roomName").textContent = device.room;
  el("#deviceIp").textContent = device.ip;
  updateTemperatureDisplay(draft.temperature);
  el("#roomTemperature").textContent =
    `室温 ${device.current_temperature ?? "—"}° · ${device.power ? "运行中" : "已关闭"}`;
  el("#powerButton").setAttribute("aria-label", device.power ? "关闭空调" : "开启空调");

  document.querySelectorAll("#modeStrip button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === draft.mode);
  });
  el("#fanSelect").value = draft.fan;
  fillSelect(el("#verticalSelect"), device.capabilities.vertical_swing, (value) => {
    return verticalLabels[value] || value;
  }, draft.vertical);

  const horizontal = device.capabilities.horizontal_swing || [];
  el("#horizontalField").hidden = horizontal.length === 0;
  fillSelect(el("#horizontalSelect"), horizontal, (value) => horizontalLabels[value] || value, draft.horizontal);

  el("#sleepCard").hidden = !device.capabilities.sleep;
  el("#sleepSwitch").checked = draft.sleep;
  el("#lightCard").hidden = !device.capabilities.light;
  el("#lightSwitch").checked = draft.light;
  el("#quietCard").hidden = !device.capabilities.quiet;
  el("#quietSwitch").checked = draft.quiet;
  el("#lowerOutletCard").hidden = !device.capabilities.lower_outlet;
  el("#lowerOutletSwitch").checked = draft.lowerOutlet;
  el("#antiDirectCard").hidden = !device.capabilities.anti_direct;
  el("#antiDirectSwitch").checked = draft.antiDirect;
  el("#turboCard").hidden = !device.capabilities.turbo;
  el("#turboSwitch").checked = draft.turbo;
  el("#healthCard").hidden = !device.capabilities.health;
  el("#healthSwitch").checked = draft.health;
  el("#auxiliaryHeatCard").hidden = !device.capabilities.auxiliary_heat;
  el("#auxiliaryHeatSwitch").checked = draft.auxiliaryHeat;
}

function fillSelect(select, values, label, selected) {
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label(value);
    option.selected = value === selected;
    return option;
  }));
  if (!values.includes(selected) && values.length) select.value = values[0];
}

function formatTemperature(value) {
  return Number(value) % 1 === 0 ? String(Number(value)) : Number(value).toFixed(1);
}

function normalizeTemperature(value) {
  const stepped = Math.round(Number(value) / TEMPERATURE_STEP) * TEMPERATURE_STEP;
  return Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, stepped));
}

function updateTemperatureDisplay(value) {
  const temperature = normalizeTemperature(value);
  const progress = (temperature - MIN_TEMPERATURE) / (MAX_TEMPERATURE - MIN_TEMPERATURE);
  const angle = (135 + progress * 270) * Math.PI / 180;
  const ring = el("#temperatureRing");
  const handle = el("#dialHandle");

  el("#targetTemperature").textContent = formatTemperature(temperature);
  ring.style.setProperty("--dial-fill", `${progress * 270}deg`);
  handle.style.left = `${50 + Math.cos(angle) * 42}%`;
  handle.style.top = `${50 + Math.sin(angle) * 42}%`;
  ring.setAttribute("aria-valuenow", String(temperature));
  ring.setAttribute("aria-valuetext", `${formatTemperature(temperature)} 摄氏度`);
}

function renderScheduleTargets() {
  const select = el("#scheduleTarget");
  const previous = select.value;
  const options = model.devices.map((device) => {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = `格力空调 · ${device.room}`;
    return option;
  });
  if (model.tv?.configured) {
    const option = document.createElement("option");
    option.value = SONY_TV_DEVICE_ID;
    option.textContent = "索尼电视";
    options.push(option);
  }
  if (model.plug?.configured) {
    const option = document.createElement("option");
    option.value = MIJIA_PLUG_DEVICE_ID;
    option.textContent = "米家智能插座 3";
    options.push(option);
  }
  if (model.aupu?.configured) {
    const option = document.createElement("option");
    option.value = AUPU_DEVICE_ID;
    option.textContent = "奥普浴霸";
    options.push(option);
  }
  select.replaceChildren(...options);
  const fallback = selectedDevice()?.id || SONY_TV_DEVICE_ID;
  select.value = options.some((option) => option.value === previous) ? previous : fallback;
}

function scheduleTargetName(deviceId) {
  if (deviceId === SONY_TV_DEVICE_ID) return "索尼电视";
  if (deviceId === MIJIA_PLUG_DEVICE_ID) return "米家智能插座 3";
  if (deviceId === AUPU_DEVICE_ID) return "奥普浴霸";
  const device = model.devices.find((item) => item.id === deviceId);
  return device ? `格力空调 · ${device.room}` : "格力空调";
}

function renderSchedules() {
  const list = el("#scheduleList");
  const items = model.schedules
    .filter((item) => item.status === "pending")
    .sort((left, right) => new Date(left.run_at) - new Date(right.run_at));
  if (!items.length) {
    list.innerHTML = '<div class="schedule-empty">暂无待执行任务</div>';
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const row = document.createElement("div");
    row.className = "schedule-item";
    const when = new Date(item.run_at);
    row.innerHTML = `
      <span class="schedule-icon">${item.action === "on" ? "开" : "关"}</span>
      <div><strong>${scheduleTargetName(item.device_id)} · ${item.action === "on" ? "定时开机" : "定时关机"}</strong>
      <small>${when.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></div>
      <button type="button" aria-label="删除任务">×</button>`;
    row.querySelector("button").addEventListener("click", () => removeSchedule(item.id));
    return row;
  }));
}

async function sendCommand(payload) {
  const device = selectedDevice();
  if (!device) return;
  el("#climateCard").classList.add("is-busy");
  try {
    const updated = await api(`/api/devices/${device.id}/command`, {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify(payload),
    });
    const index = model.devices.findIndex((item) => item.id === updated.id);
    model.devices[index] = updated;
    model.drafts.delete(updated.id);
    ensureDraft(updated);
    render();
    showToast("设置已发送到空调");
  } catch (error) {
    showToast(error.message);
  } finally {
    el("#climateCard").classList.remove("is-busy");
  }
}

function queueCommand(payload, delay = 0) {
  const device = selectedDevice();
  if (!device) return;
  clearTimeout(model.commandTimers.get(device.id));
  const timer = setTimeout(() => {
    model.commandTimers.delete(device.id);
    sendCommand(payload);
  }, delay);
  model.commandTimers.set(device.id, timer);
}

el("#powerButton").addEventListener("click", () => {
  const device = selectedDevice();
  if (device) sendCommand({ power: !device.power });
});
el("#tempDown").addEventListener("click", () => adjustTemperature(-1));
el("#tempUp").addEventListener("click", () => adjustTemperature(1));
function adjustTemperature(amount) {
  const device = selectedDevice();
  if (!device) return;
  const draft = ensureDraft(device);
  draft.temperature = normalizeTemperature(draft.temperature + amount * TEMPERATURE_STEP);
  updateTemperatureDisplay(draft.temperature);
  queueCommand({ power: true, target_temperature: draft.temperature }, 350);
}

const temperatureRing = el("#temperatureRing");
let temperatureGesture = null;

function temperatureFromPointer(event, currentTemperature) {
  const bounds = temperatureRing.getBoundingClientRect();
  const x = event.clientX - (bounds.left + bounds.width / 2);
  const y = event.clientY - (bounds.top + bounds.height / 2);
  let pointerAngle = Math.atan2(y, x) * 180 / Math.PI;
  if (pointerAngle < 0) pointerAngle += 360;

  const progress =
    (normalizeTemperature(currentTemperature) - MIN_TEMPERATURE) /
    (MAX_TEMPERATURE - MIN_TEMPERATURE);
  const currentAngle = 135 + progress * 270;
  const unwrappedAngle = [pointerAngle - 360, pointerAngle, pointerAngle + 360]
    .reduce((closest, candidate) =>
      Math.abs(candidate - currentAngle) < Math.abs(closest - currentAngle)
        ? candidate
        : closest
    );
  const boundedAngle = Math.min(405, Math.max(135, unwrappedAngle));
  return normalizeTemperature(
    MIN_TEMPERATURE + ((boundedAngle - 135) / 270) * (MAX_TEMPERATURE - MIN_TEMPERATURE)
  );
}

function previewTemperatureFromPointer(event) {
  if (!temperatureGesture) return;
  const device = selectedDevice();
  if (!device || device.id !== temperatureGesture.deviceId) return;
  const draft = ensureDraft(device);
  const temperature = temperatureFromPointer(event, draft.temperature);
  if (temperature === draft.temperature) return;
  draft.temperature = temperature;
  temperatureGesture.changed = true;
  updateTemperatureDisplay(temperature);
}

temperatureRing.addEventListener("pointerdown", (event) => {
  const device = selectedDevice();
  if (!device) return;
  const draft = ensureDraft(device);
  const pendingTimer = model.commandTimers.get(device.id);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    model.commandTimers.delete(device.id);
  }
  temperatureGesture = {
    pointerId: event.pointerId,
    deviceId: device.id,
    startTemperature: draft.temperature,
    changed: false,
  };
  temperatureRing.setPointerCapture(event.pointerId);
  temperatureRing.classList.add("is-dragging");
  previewTemperatureFromPointer(event);
  event.preventDefault();
});

temperatureRing.addEventListener("pointermove", (event) => {
  if (!temperatureGesture || event.pointerId !== temperatureGesture.pointerId) return;
  previewTemperatureFromPointer(event);
  event.preventDefault();
});

function finishTemperatureGesture(event, cancelled = false) {
  if (!temperatureGesture || event.pointerId !== temperatureGesture.pointerId) return;
  const gesture = temperatureGesture;
  const device = selectedDevice();
  temperatureGesture = null;
  temperatureRing.classList.remove("is-dragging");

  if (!device || device.id !== gesture.deviceId) return;
  const draft = ensureDraft(device);
  if (cancelled) {
    draft.temperature = gesture.startTemperature;
    updateTemperatureDisplay(draft.temperature);
    return;
  }
  if (gesture.changed) {
    queueCommand({ power: true, target_temperature: draft.temperature }, 0);
  }
}

temperatureRing.addEventListener("pointerup", (event) => finishTemperatureGesture(event));
temperatureRing.addEventListener("pointercancel", (event) => finishTemperatureGesture(event, true));
temperatureRing.addEventListener("keydown", (event) => {
  const keySteps = {
    ArrowUp: 1,
    ArrowRight: 1,
    ArrowDown: -1,
    ArrowLeft: -1,
    PageUp: 2,
    PageDown: -2,
  };
  if (event.key === "Home" || event.key === "End") {
    const device = selectedDevice();
    if (!device) return;
    const draft = ensureDraft(device);
    draft.temperature = event.key === "Home" ? MIN_TEMPERATURE : MAX_TEMPERATURE;
    updateTemperatureDisplay(draft.temperature);
    queueCommand({ power: true, target_temperature: draft.temperature }, 250);
    event.preventDefault();
    return;
  }
  if (!(event.key in keySteps)) return;
  adjustTemperature(keySteps[event.key]);
  event.preventDefault();
});

el("#modeStrip").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  const device = selectedDevice();
  if (!button || !device) return;
  ensureDraft(device).mode = button.dataset.mode;
  renderDevice();
  sendCommand({ power: true, mode: button.dataset.mode });
});

el("#fanSelect").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).fan = event.target.value;
  sendCommand({ fan_speed: event.target.value });
});
el("#verticalSelect").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).vertical = event.target.value;
  sendCommand({ vertical_swing: event.target.value });
});
el("#horizontalSelect").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).horizontal = event.target.value;
  sendCommand({ horizontal_swing: event.target.value });
});
el("#sleepSwitch").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).sleep = event.target.checked;
  sendCommand({ sleep: event.target.checked });
});
el("#lightSwitch").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).light = event.target.checked;
  sendCommand({ light: event.target.checked });
});
el("#quietSwitch").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).quiet = event.target.checked;
  sendCommand({ quiet: event.target.checked });
});
el("#lowerOutletSwitch").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).lowerOutlet = event.target.checked;
  sendCommand({ lower_outlet: event.target.checked });
});
el("#antiDirectSwitch").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).antiDirect = event.target.checked;
  sendCommand({ anti_direct: event.target.checked });
});
el("#turboSwitch").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).turbo = event.target.checked;
  sendCommand({ turbo: event.target.checked });
});
el("#healthSwitch").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).health = event.target.checked;
  sendCommand({ health: event.target.checked });
});
el("#auxiliaryHeatSwitch").addEventListener("change", (event) => {
  const device = selectedDevice();
  if (device) ensureDraft(device).auxiliaryHeat = event.target.checked;
  sendCommand({ auxiliary_heat: event.target.checked });
});

el("#tvPowerButton").addEventListener("click", () => {
  if (model.tv) sendTVCommand({ power: !model.tv.power });
});
el("#tvInputSelect").addEventListener("change", (event) => {
  sendTVCommand({ input_uri: event.target.value });
});
document.querySelectorAll("[data-tv-remote]").forEach((button) => {
  button.addEventListener("click", () => {
    sendTVCommand({ remote: button.dataset.tvRemote });
  });
});
document.querySelectorAll("[data-tv-app]").forEach((button) => {
  button.addEventListener("click", () => launchTVApp(button));
});
document.querySelectorAll("[data-tv-cleanup]").forEach((button) => {
  button.addEventListener("click", cleanupTVApps);
});
el("#tvScreenButton").addEventListener("click", () => {
  if (!tvScreenDialog.open) tvScreenDialog.showModal();
  captureTVScreen();
});
el("#refreshTvScreen").addEventListener("click", captureTVScreen);
el("#closeTvScreenDialog").addEventListener("click", () => tvScreenDialog.close());

el("#aupuModes").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-aupu-mode]");
  if (button) sendAupuCommand({ mode: Number(button.dataset.aupuMode) });
  const timer = event.target.closest("button[data-aupu-timer^='mode:']");
  if (timer) {
    const mode = Number(timer.dataset.aupuTimer.split(":")[1]);
    scheduleAupuAutoOff({ mode }, { mode: 0 }, timer.dataset.aupuTimer, `浴霸${timer.previousElementSibling?.textContent || "功能"}`);
  }
});
el("#aupuLight").addEventListener("change", (event) => {
  sendAupuCommand({ light: event.target.checked });
});
document.querySelectorAll("[data-xiaomi-setup]").forEach((button) => button.addEventListener("click", () => {
  aupuQrGeneration += 1;
  el("#aupuSetupError").textContent = "";
  el("#aupuQrBox").hidden = true;
  el("#aupuQrStart").disabled = false;
  clearTimeout(aupuQrPollTimer);
  if (!aupuSetupDialog.open) aupuSetupDialog.showModal();
}));
el("#closeAupuSetupDialog").addEventListener("click", () => {
  aupuQrGeneration += 1;
  clearTimeout(aupuQrPollTimer);
  aupuSetupDialog.close();
});
async function pollAupuQr(sessionId, generation) {
  try {
    const result = await api(`/api/aupu/qr/${sessionId}`, {
      headers: requestHeaders(),
    });
    if (generation !== aupuQrGeneration) return;
    if (result.status === "connected") {
      model.aupu = result.device;
      model.plug = await api("/api/plug", { headers: requestHeaders() });
      clearTimeout(aupuQrPollTimer);
      aupuSetupDialog.close();
      renderAupu();
      renderPlug();
      showToast("米家设备已连接");
      return;
    }
    if (result.status === "error" || result.status === "expired") {
      el("#aupuSetupError").textContent = result.error || "二维码已失效，请重新生成";
      el("#aupuQrStatus").textContent = "二维码已失效";
      el("#aupuQrStart").disabled = false;
      return;
    }
    el("#aupuQrStatus").textContent = "等待在米家 App 中确认…";
    aupuQrPollTimer = setTimeout(() => pollAupuQr(sessionId, generation), 1800);
  } catch (error) {
    if (generation !== aupuQrGeneration) return;
    el("#aupuSetupError").textContent = error.message;
    el("#aupuQrStart").disabled = false;
  }
}
el("#aupuSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  const generation = ++aupuQrGeneration;
  clearTimeout(aupuQrPollTimer);
  submit.disabled = true;
  el("#aupuSetupError").textContent = "";
  try {
    const result = await api("/api/aupu/qr/start", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({
        locale: el("#aupuLocale").value,
      }),
    });
    el("#aupuQrImage").src = result.qr_image;
    el("#aupuQrBox").hidden = false;
    el("#aupuQrStatus").textContent = "请使用米家 App 扫码并确认";
    pollAupuQr(result.session_id, generation);
  } catch (error) {
    if (generation !== aupuQrGeneration) return;
    el("#aupuSetupError").textContent = error.message;
    submit.disabled = false;
  }
});
el("#plugPowerButton").addEventListener("click", () => {
  if (model.plug) sendPlugCommand({ on: !model.plug.on });
});
el("#plugDefaultState").addEventListener("change", (event) => {
  sendPlugCommand({ default_power_state: Number(event.target.value) });
});
el("#plugLock").addEventListener("change", (event) => {
  sendPlugCommand({ physical_lock: event.target.checked });
});
el("#plugIndicator").addEventListener("change", (event) => {
  sendPlugCommand({ indicator_light: event.target.checked });
});
el("#plugCharging").addEventListener("change", (event) => {
  sendPlugCommand({ charging_protection: event.target.checked });
});
el("#plugMaxPowerEnabled").addEventListener("change", (event) => {
  sendPlugCommand({ max_power_limit: event.target.checked });
});
el("#plugMaxPower").addEventListener("change", (event) => {
  sendPlugCommand({ max_power: Number(event.target.value) });
});
el("#opplePowerButton").addEventListener("click", () => {
  if (model.opple?.online) sendOppleCommand({ power: !model.opple.power });
});
el("#oppleBrightness").addEventListener("input", (event) => {
  el("#oppleBrightnessValue").textContent = event.target.value;
  el("#oppleGlow").style.setProperty("--light-opacity", String(Math.max(.18, Number(event.target.value) / 100)));
  queueOppleCommand({ brightness: Number(event.target.value) });
});
el("#oppleColor").addEventListener("input", (event) => {
  el("#oppleColorValue").textContent = event.target.value;
  queueOppleCommand({ color_temperature: Number(event.target.value) });
});
el("#purifierSetupButton").addEventListener("click", () => {
  el("#purifierSetupError").textContent = "";
  el("#purifierCaptcha").value = "";
  if (!purifierSetupDialog.open) purifierSetupDialog.showModal();
});

el("#waterHeaterAuthButton").addEventListener("click", () => {
  if (!waterHeaterAuthDialog.open) waterHeaterAuthDialog.showModal();
});
el("#dreameSetupButton").addEventListener("click", () => {
  el("#dreameSetupError").textContent = "";
  el("#dreamePassword").value = "";
  if (!dreameSetupDialog.open) dreameSetupDialog.showModal();
});
el("#closeDreameSetupDialog").addEventListener("click", () => {
  dreameSetupDialog.close();
});
el("#dreameSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  el("#dreameSetupError").textContent = "";
  try {
    model.dreame = await api("/api/dreame/login", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({
        username: el("#dreameUsername").value.trim(),
        password: el("#dreamePassword").value,
        country: el("#dreameCountry").value,
      }),
    });
    el("#dreamePassword").value = "";
    dreameSetupDialog.close();
    renderSmartDevices();
    showToast("追觅 X30 已接入");
  } catch (error) {
    el("#dreameSetupError").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
document.querySelectorAll("[data-dreame-action]").forEach((button) => {
  button.addEventListener("click", () => sendDreameCommand(button.dataset.dreameAction));
});
document.querySelectorAll("[data-dreame-setting]").forEach((control) => {
  if (control.type === "range") {
    control.addEventListener("input", () => {
      el("#dreameVolumeValue").textContent = control.value;
    });
  }
  control.addEventListener("change", () => {
    const value = control.type === "checkbox" ? control.checked : Number(control.value);
    sendDreameSetting(control.dataset.dreameSetting, value, control);
  });
});
el("#closeWaterHeaterAuthDialog").addEventListener("click", () => {
  waterHeaterAuthDialog.close();
});
el("#closePurifierSetupDialog").addEventListener("click", () => {
  purifierSetupDialog.close();
});
el("#purifierSendCaptcha").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const error = el("#purifierSetupError");
  error.textContent = "";
  const mobile = el("#purifierMobile").value.trim();
  if (!/^1\d{10}$/.test(mobile)) {
    error.textContent = "请输入正确的 11 位手机号码";
    return;
  }
  button.disabled = true;
  try {
    const verification = await requestTencentCaptcha();
    const result = await api("/api/purifier/captcha", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({ mobile, ...verification }),
    });
    showToast(result.message || "验证码已发送");
    let remaining = 60;
    button.textContent = `${remaining} 秒`;
    const timer = setInterval(() => {
      remaining -= 1;
      button.textContent = remaining > 0 ? `${remaining} 秒` : "发送验证码";
      if (remaining <= 0) {
        clearInterval(timer);
        button.disabled = false;
      }
    }, 1000);
  } catch (requestError) {
    error.textContent = requestError.message;
    button.disabled = false;
  }
});
el("#purifierSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  const error = el("#purifierSetupError");
  error.textContent = "";
  submit.disabled = true;
  try {
    model.purifier = await api("/api/purifier/login", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({
        mobile: el("#purifierMobile").value.trim(),
        captcha: el("#purifierCaptcha").value.trim(),
      }),
    });
    purifierSetupDialog.close();
    renderPurifier();
    showToast("史密斯净水机已连接");
  } catch (requestError) {
    error.textContent = requestError.message;
  } finally {
    submit.disabled = false;
  }
});

document.querySelectorAll(".view-nav button").forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    document.body.dataset.view = view;
    document.querySelectorAll(".view-nav button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    loadViewData(view);
    scheduleRealtimeRefresh(realtimeRefreshIntervals[view] ?? 10_000);
  });
});

el("#scheduleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const timeValue = el("#scheduleTime").value;
  const targetId = el("#scheduleTarget").value;
  if (!targetId || !timeValue) return;
  try {
    const created = await api("/api/schedules", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({
        device_id: targetId,
        action: el("#scheduleAction").value,
        run_at: new Date(timeValue).toISOString(),
        label: `${scheduleTargetName(targetId)}定时任务`,
      }),
    });
    model.schedules = [
      created,
      ...model.schedules.filter((item) => item.id !== created.id),
    ];
    setScheduleTimeAfterMinutes(10);
    renderSchedules();
    showToast("定时任务已添加");
  } catch (error) {
    showToast(error.message);
  }
});
el("#scheduleTarget").addEventListener("change", renderSchedules);

async function removeSchedule(id) {
  try {
    await api(`/api/schedules/${id}`, {
      method: "DELETE",
      headers: requestHeaders(),
    });
    model.schedules = model.schedules.filter((item) => item.id !== id);
    renderAupu();
    renderSchedules();
    showToast("定时任务已删除");
  } catch (error) {
    showToast(error.message);
  }
}

async function saveXiaomiScalePreferences() {
  const button = el("#xiaomiScaleSavePreferences");
  const targetValue = el("#xiaomiScaleTarget").value.trim();
  button.disabled = true;
  try {
    model.xiaomiScalePreferences = await api("/api/xiaomi-scale/preferences", {
      method: "PUT",
      headers: requestHeaders(true),
      body: JSON.stringify({
        display_unit: el("#xiaomiScaleUnit").value,
        target_weight_kg: targetValue ? Number(targetValue) : null,
        target_enabled: el("#xiaomiScaleTargetEnabled").checked,
      }),
    });
    renderXiaomiScale();
    showToast("电子秤设置已保存");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function downloadXiaomiScaleExport(format) {
  try {
    const response = await fetch(`/api/xiaomi-scale/export?format=${encodeURIComponent(format)}`, {
      headers: requestHeaders(),
    });
    if (!response.ok) throw new Error(`导出失败（${response.status}）`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `xiaomi-scale-history.${format}`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${format.toUpperCase()} 历史记录`);
  } catch (error) {
    showToast(error.message);
  }
}

el("#xiaomiScaleUnit").addEventListener("change", (event) => {
  model.xiaomiScalePreferences = {
    ...model.xiaomiScalePreferences,
    display_unit: event.target.value,
  };
  renderXiaomiScale();
});
el("#xiaomiScaleSavePreferences").addEventListener("click", saveXiaomiScalePreferences);
el("#xiaomiScaleExportCsv").addEventListener("click", () => downloadXiaomiScaleExport("csv"));
el("#xiaomiScaleExportJson").addEventListener("click", () => downloadXiaomiScaleExport("json"));
document.querySelectorAll("[data-scale-days]").forEach((button) => {
  button.addEventListener("click", async () => {
    const days = Number(button.dataset.scaleDays);
    if (!Number.isFinite(days) || days === model.xiaomiScaleDays) return;
    model.xiaomiScaleDays = days;
    document.querySelectorAll("[data-scale-days]").forEach((item) => item.classList.toggle("active", item === button));
    try {
      model.xiaomiScaleSummary = await api(`/api/xiaomi-scale/summary?days=${days}`, { headers: requestHeaders() });
      renderXiaomiScaleInsights();
    } catch (error) {
      showToast(error.message);
    }
  });
});

el("#xiaomiScaleRefresh").addEventListener("click", async () => {
  const button = el("#xiaomiScaleRefresh");
  button.disabled = true;
  button.textContent = "正在寻找电子秤…";
  await loadViewData("xiaomi-scale", true);
  button.disabled = false;
  button.textContent = "开始称重";
});

el("#syncButton").addEventListener("click", async () => {
  await loadAll(true);
  await loadViewData(document.body.dataset.view || "control", true);
  scheduleRealtimeRefresh();
});
el("#authButton").addEventListener("click", openAuthDialog);
el("#closeDialog").addEventListener("click", () => authDialog.close());
el("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = el("#passwordInput").value;
  try {
    await api("/api/auth/login", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({ password }),
    });
    model.authenticated = true;
    model.legacyToken = "";
    sessionStorage.removeItem("greeApiToken");
    authDialog.close();
    await loadAll(true);
    await loadViewData(document.body.dataset.view || "control", true);
  } catch (error) {
    el("#authError").textContent = error.message;
  }
});
logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    model.authenticated = false;
    sessionStorage.removeItem("greeApiToken");
    location.reload();
  }
});

async function bootstrap() {
  if (model.legacyToken) {
    const legacyToken = model.legacyToken;
    model.legacyToken = "";
    sessionStorage.removeItem("greeApiToken");
    try {
      await api("/api/auth/login", {
        method: "POST",
        headers: requestHeaders(true),
        body: JSON.stringify({ password: legacyToken }),
      });
      model.authenticated = true;
    } catch {
      model.authenticated = false;
    }
  }
  await loadAll(true);
  await loadViewData(document.body.dataset.view || "control");
  scheduleRealtimeRefresh();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2500);
}

function localScheduleValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function applyScheduleTime(value) {
  const [date, time] = value.split("T");
  const [hour, minute] = time.split(":");
  el("#scheduleDay").value = date;
  el("#scheduleHour").value = hour;
  el("#scheduleMinute").value = minute;
  el("#scheduleTime").value = value;
}

function syncScheduleTimeFromSelects() {
  el("#scheduleTime").value =
    `${el("#scheduleDay").value}T${el("#scheduleHour").value}:${el("#scheduleMinute").value}`;
}

function setScheduleTimeAfterMinutes(minutes) {
  const next = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + minutes * 60_000);
  applyScheduleTime(localScheduleValue(next));
}

function initializeScheduleTime() {
  const daySelect = el("#scheduleDay");
  daySelect.innerHTML = Array.from({ length: 8 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index);
    const value = localScheduleValue(date).slice(0, 10);
    const label = index === 0 ? "今天" : index === 1 ? "明天" :
      date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
    return `<option value="${value}">${label}</option>`;
  }).join("");
  el("#scheduleHour").innerHTML = Array.from({ length: 24 }, (_, hour) => {
    const value = String(hour).padStart(2, "0");
    return `<option value="${value}">${value}时</option>`;
  }).join("");
  el("#scheduleMinute").innerHTML = Array.from({ length: 60 }, (_, minute) => {
    const value = String(minute).padStart(2, "0");
    return `<option value="${value}">${value}分</option>`;
  }).join("");
  setScheduleTimeAfterMinutes(10);
}

document.querySelectorAll("[data-schedule-delay]").forEach((button) => {
  button.addEventListener("click", () => {
    setScheduleTimeAfterMinutes(Number(button.dataset.scheduleDelay));
    el("#scheduleForm").requestSubmit();
  });
});
["#scheduleDay", "#scheduleHour", "#scheduleMinute"].forEach((selector) => {
  el(selector).addEventListener("change", syncScheduleTimeFromSelects);
});

el("#today").textContent = new Date().toLocaleDateString("zh-CN", {
  month: "long", day: "numeric", weekday: "long",
});
initializeScheduleTime();
bootstrap();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(realtimeRefreshTimer);
  } else {
    scheduleRealtimeRefresh(0);
  }
});
