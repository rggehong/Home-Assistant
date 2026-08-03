const state = {
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
  tmall: null,
  dreame: null,
  ezviz: null,
  tvForeground: null,
  drafts: new Map(),
  commandTimers: new Map(),
};
const SONY_TV_DEVICE_ID = "sony-living-tv";
const MIJIA_PLUG_DEVICE_ID = "mijia-plug-3";

const grid = document.querySelector("#deviceGrid");
const connection = document.querySelector("#connection");
const authDialog = document.querySelector("#authDialog");
const passwordInput = document.querySelector("#passwordInput");
const authError = document.querySelector("#authError");
const logoutButton = document.querySelector("#logoutButton");
const toast = document.querySelector("#toast");
const tvScreenDialog = document.querySelector("#desktopTvScreenDialog");
const aupuSetupDialog = document.querySelector("#desktopAupuSetupDialog");
const purifierSetupDialog = document.querySelector("#desktopPurifierSetupDialog");
const waterHeaterAuthDialog = document.querySelector("#desktopWaterHeaterAuthDialog");
const desktopDreameSetupDialog = document.querySelector("#desktopDreameSetupDialog");
let desktopAupuQrPollTimer = null;
let desktopAupuQrGeneration = 0;
let tencentCaptchaLoader = null;
let oppleCommandTimer = null;
let opplePendingCommand = {};
const secondaryLoads = new Map();
const desktopRefreshTimers = new Map();
let desktopClimateLoad = null;

const desktopRefreshGroups = {
  climate: { interval: 5_000 },
  schedules: { interval: 5_000, keys: ["schedules"] },
  local: { interval: 8_000, keys: ["tv", "aupu", "plug", "opple", "ezviz"] },
  cloud: { interval: 15_000, keys: ["purifier", "water-heater", "tmall", "dreame"] },
};

const modeLabels = { Auto: "自动", Cool: "制冷", Dry: "除湿", Fan: "送风", Heat: "制热" };
const modeValues = { Auto: "auto", Cool: "cool", Dry: "dry", Fan: "fan", Heat: "heat" };
const fanLabels = {
  Auto: "自动风", Low: "低风", MediumLow: "中低风",
  Medium: "中风", MediumHigh: "中高风", High: "高风",
};
const fanValues = {
  Auto: "auto", Low: "low", MediumLow: "medium_low",
  Medium: "medium", MediumHigh: "medium_high", High: "high",
};
const verticalValues = {
  Default: "middle", FullSwing: "full", FixedUpper: "upper",
  FixedUpperMiddle: "upper_middle", FixedMiddle: "middle",
  FixedLowerMiddle: "lower_middle", FixedLower: "lower",
};
const horizontalValues = {
  Default: "center", FullSwing: "full", Left: "left",
  LeftCenter: "left_center", Center: "center",
  RightCenter: "right_center", Right: "right",
};
const verticalLabels = {
  full: "上下扫风", upper: "上方定格", upper_middle: "偏上定格",
  middle: "中间定格", lower_middle: "偏下定格", lower: "下方定格",
};
const horizontalLabels = {
  full: "左右扫风", left: "左侧定格", left_center: "偏左定格",
  center: "中间定格", right_center: "偏右定格", right: "右侧定格",
};

function headers(json = false) {
  const value = {};
  if (json) value["Content-Type"] = "application/json";
  return value;
}

function updateAuthControls() {
  logoutButton.hidden = !state.authenticated;
}

function openAuthDialog() {
  passwordInput.value = "";
  authError.textContent = "";
  updateAuthControls();
  if (!authDialog.open) authDialog.showModal();
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (response.status === 401) {
    const body = await response.json().catch(() => ({}));
    state.authenticated = false;
    setConnection("需要登录", "error");
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
    state.authenticated = false;
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

function makeDraft(device) {
  return {
    temperature: device.target_temperature || 26,
    mode: modeValues[device.mode] || "cool",
    fan: fanValues[device.fan_speed] || "auto",
    vertical: verticalValues[device.vertical_swing] || "middle",
    horizontal: horizontalValues[device.horizontal_swing] || "center",
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

async function loadAll(refresh = true, { silent = false, secondary = true } = {}) {
  if (desktopClimateLoad) return desktopClimateLoad;
  if (!silent) setConnection("正在同步", "");
  desktopClimateLoad = (async () => {
    try {
    const devices = await api(`/api/devices?refresh=${refresh}`, { headers: headers() });
    state.authenticated = true;
    updateAuthControls();
    state.devices = devices;
    devices.forEach((device) => state.drafts.set(device.id, makeDraft(device)));
    render();
    if (!silent) setConnection("本地在线", "online");
    document.querySelector("#lastUpdated").textContent =
      `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
    if (secondary) loadSecondaryData();
    } catch (error) {
      if (error.isAuthError && !silent) {
      renderEmpty("请先登录", "输入一次家庭访问密码，此设备将保持登录 30 天。");
      } else if (!silent) {
      setConnection("连接失败", "error");
      showToast(error.message);
      }
    } finally {
      desktopClimateLoad = null;
    }
  })();
  return desktopClimateLoad;
}

function loadSecondary(key, path, apply) {
  if (secondaryLoads.has(key)) return secondaryLoads.get(key);
  const request = api(path, { headers: headers() })
    .then((value) => {
      state.authenticated = true;
      apply(value);
    })
    .catch(() => {})
    .finally(() => secondaryLoads.delete(key));
  secondaryLoads.set(key, request);
  return request;
}

function loadSecondaryData(keys = null) {
  const selected = keys ? new Set(keys) : null;
  const include = (key, loader) => selected && !selected.has(key) ? Promise.resolve() : loader();
  return Promise.allSettled([
    include("schedules", () => loadSecondary("schedules", "/api/schedules", (value) => {
      state.schedules = value;
      renderSchedules();
      renderAupu();
    })),
    include("tv", () => loadSecondary("tv", "/api/tv", (value) => {
      state.tv = value;
      renderTV();
      loadTVForeground();
    })),
    include("aupu", () => loadSecondary("aupu", "/api/aupu", (value) => {
      state.aupu = value;
      renderAupu();
    })),
    include("plug", () => loadSecondary("plug", "/api/plug", (value) => {
      state.plug = value;
      renderPlug();
    })),
    include("opple", () => loadSecondary("opple", "/api/opple", (value) => {
      state.opple = value;
      renderOpple();
    })),
    include("purifier", () => loadSecondary("purifier", "/api/purifier", (value) => {
      state.purifier = value;
      renderPurifier();
    })),
    include("water-heater", () => loadSecondary("water-heater", "/api/water-heater", (value) => {
      state.waterHeater = value;
      renderWaterHeater();
    })),
    include("tmall", () => loadSecondary("tmall", "/api/tmall", (value) => {
      state.tmall = value;
      renderSmartDevices();
    })),
    include("dreame", () => loadSecondary("dreame", "/api/dreame", (value) => {
      state.dreame = value;
      renderSmartDevices();
    })),
    include("ezviz", () => loadSecondary("ezviz", "/api/ezviz", (value) => {
      state.ezviz = value;
      renderEzviz();
    })),
  ]);
}

function desktopRealtimeRefreshPaused() {
  if (!state.authenticated || document.hidden) return true;
  if (document.querySelector("dialog[open], .is-busy, .is-dragging")) return true;
  return document.activeElement?.matches("input, select, textarea") || false;
}

function scheduleDesktopRefresh(group, delay) {
  clearTimeout(desktopRefreshTimers.get(group));
  const config = desktopRefreshGroups[group];
  desktopRefreshTimers.set(group, setTimeout(() => runDesktopRefresh(group), delay ?? config.interval));
}

async function runDesktopRefresh(group) {
  const config = desktopRefreshGroups[group];
  try {
    if (!desktopRealtimeRefreshPaused()) {
      if (group === "climate") await loadAll(true, { silent: true, secondary: false });
      else await loadSecondaryData(config.keys);
    }
  } finally {
    scheduleDesktopRefresh(group, config.interval);
  }
}

function startDesktopRealtimeRefresh(delay = undefined) {
  Object.keys(desktopRefreshGroups).forEach((group) => scheduleDesktopRefresh(group, delay));
}

function renderEzviz() {
  const section = document.querySelector("#desktopEzviz");
  const grid = document.querySelector("#desktopEzvizGrid");
  if (!section || !grid || !state.ezviz) return;
  section.hidden = !state.ezviz.cameras?.length;
  const cameras = state.ezviz.cameras || [];
  const online = cameras.filter((camera) => camera.online).length;
  document.querySelector("#desktopEzvizStatus").textContent =
    `${online}/${cameras.length} 路摄像头在线`;
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
        media.replaceWith(Object.assign(document.createElement("div"), {
          className: "ezviz-placeholder",
          textContent: "视频接口可达，暂未取得画面",
        }));
      };
    } else {
      media = Object.assign(document.createElement("div"), {
        className: "ezviz-placeholder",
        textContent: `${camera.protocol} 设备当前离线`,
      });
    }
    const actions = document.createElement("div");
    actions.className = "ezviz-actions";
    const live = Object.assign(document.createElement("button"), {
      type: "button", textContent: "实时观看", disabled: !camera.online,
    });
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

function setConnection(text, className) {
  connection.className = `connection ${className}`;
  connection.querySelector("span").textContent = text;
}

function render() {
  const online = state.devices.filter((item) => item.online);
  const running = online.filter((item) => item.power);
  const temps = online.map((item) => item.current_temperature).filter(Number.isFinite);
  document.querySelector("#onlineCount").textContent = String(online.length);
  document.querySelector("#runningCount").textContent = String(running.length);
  document.querySelector("#averageTemp").textContent =
    temps.length ? `${Math.round(temps.reduce((a, b) => a + b, 0) / temps.length)}°` : "—";

  if (!state.devices.length) {
    renderEmpty("未发现空调", "请确认空调和服务器处于同一局域网，然后刷新。");
    return;
  }
  grid.replaceChildren(...state.devices.map(createCard));
  renderScheduleRoomOptions();
  renderSchedules();
  renderTV();
  renderAupu();
  renderPlug();
  renderOpple();
  renderPurifier();
    renderWaterHeater();
    renderSmartDevices();
}

function renderWaterHeater() {
  const device = state.waterHeater;
  if (!device) return;
  document.querySelector("#desktopWaterHeaterStatus").textContent =
    `${device.ip} · ${device.status_text}`;
  document.querySelector("#desktopWaterHeaterControl").textContent =
    device.control_ready ? "已可控制" : "等待云授权";
  const badge = document.querySelector("#desktopWaterHeaterBadge");
  badge.textContent = device.control_ready ? "查看云授权" : "配置云授权";
  badge.title = device.reachable ? "设备局域网在线" : "设备当前离线";
  badge.classList.toggle("online", Boolean(device.reachable));
}

function renderSmartDevices() {
  const tmall = state.tmall;
  const dreame = state.dreame;
  if (tmall) {
    document.querySelector("#desktopTmallStatus").textContent =
      `${tmall.online_count}/${tmall.devices.length} 台局域网在线`;
    document.querySelector("#desktopTmallList").replaceChildren(...tmall.devices.map((device) => {
      const item = document.createElement("span");
      item.classList.toggle("online", device.online);
      item.textContent = `${device.ip} ${device.online ? "在线" : "离线"}`;
      return item;
    }));
    const bridge = tmall.voice_bridge || {};
    document.querySelector("#desktopTmallBridgeStatus").textContent = bridge.configured
      ? "146 技能网关已就绪"
      : "等待生成 AliGenie 技能凭据";
    if (bridge.developer_url) {
      document.querySelector("#desktopTmallDeveloperLink").href = bridge.developer_url;
    }
  }
  if (dreame) {
    document.querySelector("#desktopDreameName").textContent =
      dreame.device_name || dreame.model_name || "追觅 X30";
    document.querySelector("#desktopDreameStatus").textContent = dreame.configured
      ? `${dreame.ip} · ${dreame.online ? "云端在线" : (dreame.error || "暂时离线")}`
      : `${dreame.ip} · 等待 Dreamehome 授权`;
    document.querySelector("#desktopDreameBattery").textContent =
      dreame.battery == null ? "—" : `${dreame.battery}%`;
    document.querySelector("#desktopDreameArea").textContent =
      dreame.cleaned_area == null ? "—" : `${dreame.cleaned_area}㎡`;
    document.querySelector("#desktopDreameTime").textContent =
      dreame.cleaning_time == null ? "—" : `${dreame.cleaning_time}min`;
    document.querySelector("#desktopDreameCount").textContent =
      dreame.cleaning_count == null ? "—" : `${dreame.cleaning_count}次`;
    document.querySelector("#desktopDreameBaseStatus").textContent =
      dreame.base_status_text || "基站状态未知";
    document.querySelector("#desktopDreameTankStatus").textContent =
      `${[0, 3].includes(dreame.clean_water_tank_status) ? "清水箱正常" : "请检查清水箱"} · ${dreame.dirty_water_tank_status === 0 ? "污水箱正常" : "请检查污水箱"}`;
    const values = {
      cleaning_mode: dreame.cleaning_mode_value,
      suction_level: dreame.suction_level,
      wetness_level: dreame.wetness_level,
      mop_wash_level: dreame.mop_wash_level,
      volume: dreame.volume,
    };
    document.querySelectorAll("[data-desktop-dreame-setting]").forEach((control) => {
      const setting = control.dataset.desktopDreameSetting;
      if (control.type === "checkbox") {
        control.checked = Boolean(dreame[setting]);
      } else if (values[setting] != null) {
        control.value = String(values[setting]);
      }
      control.disabled = !dreame.configured || !dreame.online;
    });
    document.querySelector("#desktopDreameVolumeValue").textContent = dreame.volume ?? "—";
    const capabilities = new Set(dreame.capabilities || []);
    document.querySelectorAll("[data-desktop-dreame-capability]").forEach((item) => {
      item.hidden = !capabilities.has(item.dataset.desktopDreameCapability);
    });
    const consumables = {
      desktopDreameMainBrush: dreame.main_brush_left,
      desktopDreameSideBrush: dreame.side_brush_left,
      desktopDreameFilter: dreame.filter_left,
      desktopDreameSensor: dreame.sensor_dirty_left,
      desktopDreameSilverIon: dreame.silver_ion_left,
    };
    Object.entries(consumables).forEach(([id, value]) => {
      document.querySelector(`#${id}`).textContent = value ?? "—";
    });
    const baseStop = document.querySelector("#desktopDreameBaseStop");
    baseStop.hidden = ![1, 2].includes(dreame.base_status);
    baseStop.dataset.desktopDreame = dreame.base_status === 2 ? "stop_drying" : "stop_washing";
    document.querySelector("#desktopDreameSetup").textContent =
      dreame.configured ? "重新连接" : "连接 Dreamehome";
    document.querySelectorAll("[data-desktop-dreame]").forEach((button) => {
      button.disabled = !dreame.configured || !dreame.online;
    });
  }
}

async function sendDesktopDreameCommand(action) {
  try {
    state.dreame = await api("/api/dreame/command", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ action }),
    });
    renderSmartDevices();
    showToast("追觅 X30 指令已发送");
  } catch (error) {
    showToast(error.message);
  }
}

async function sendDesktopDreameSetting(setting, value, control) {
  control.disabled = true;
  try {
    state.dreame = await api("/api/dreame/setting", {
      method: "POST",
      headers: headers(true),
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

function renderPurifier() {
  const device = state.purifier;
  if (!device) return;
  let status = `${device.ip} · 等待连接 AI‑LiNK`;
  if (device.configured) {
    status = device.error
      ? `${device.ip} · ${device.error}`
      : `${device.ip} · ${device.online === false ? "云端离线" : "云端已连接"}`;
  }
  document.querySelector("#desktopPurifierStatus").textContent = status;

  const roomField = document.querySelector("#desktopPurifierRoomField");
  roomField.hidden = !device.room;
  document.querySelector("#desktopPurifierRoom").textContent = device.room || "—";
  const nameField = document.querySelector("#desktopPurifierNameField");
  nameField.hidden = !device.device_name;
  document.querySelector("#desktopPurifierName").textContent = device.device_name || "—";

  const detail = document.querySelector("#desktopPurifierDetail");
  detail.hidden = !device.detail_url;
  if (device.detail_url) detail.href = device.detail_url;
  document.querySelector("#desktopPurifierSetup").textContent =
    device.configured ? "重新连接" : "连接 AI‑LiNK";
}

function desktopPlugSupports(name) {
  return Boolean(state.plug?.capabilities?.includes(name));
}

function renderPlug() {
  const device = state.plug;
  if (!device) return;
  document.querySelector("#desktopPlugStatus").textContent = device.online
    ? `${device.ip} · ${device.configured ? (device.on ? "已通电" : "已关闭") : "已发现，等待连接"}`
    : `${device.ip} · ${device.error || "离线"}`;
  document.querySelector("#desktopPlugPower").textContent = device.electric_power ?? "—";
  document.querySelector("#desktopPlugEnergy").textContent = device.energy_kwh ?? "—";
  document.querySelector("#desktopPlugTemperature").textContent = device.temperature ?? "—";
  document.querySelector("#desktopPlugFault").textContent = device.fault_name || "—";
  const power = document.querySelector("#desktopPlugPowerButton");
  power.classList.toggle("is-on", Boolean(device.on));
  power.disabled = !device.configured || !device.online;

  const capabilityFields = [
    ["desktopPlugDefaultField", "default_power_state"],
    ["desktopPlugLockCard", "physical_lock"],
    ["desktopPlugIndicatorCard", "indicator_light"],
    ["desktopPlugChargingCard", "charging_protection"],
    ["desktopPlugMaxPowerCard", "max_power_limit"],
    ["desktopPlugMaxPowerField", "max_power"],
  ];
  capabilityFields.forEach(([id, capability]) => {
    document.querySelector(`#${id}`).hidden =
      device.configured && !desktopPlugSupports(capability);
  });
  document.querySelector("#desktopPlugDefault").value =
    String(device.default_power_state ?? 0);
  document.querySelector("#desktopPlugLock").checked = Boolean(device.physical_lock);
  document.querySelector("#desktopPlugIndicator").checked = Boolean(device.indicator_light);
  document.querySelector("#desktopPlugCharging").checked = Boolean(device.charging_protection);
  document.querySelector("#desktopPlugMaxPowerEnabled").checked = Boolean(device.max_power_limit);
  document.querySelector("#desktopPlugMaxPower").value = String(device.max_power ?? 2500);
  document.querySelectorAll("#desktopPlug input, #desktopPlug select").forEach((control) => {
    control.disabled = !device.configured || !device.online;
  });
  document.querySelector("#desktopPlugSetup").hidden = device.configured;
}

async function sendPlugCommand(payload) {
  document.querySelector("#desktopPlug").classList.add("is-busy");
  try {
    state.plug = await api("/api/plug/command", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(payload),
    });
    renderPlug();
    showToast("智能插座设置已生效");
  } catch (error) {
    renderPlug();
    showToast(error.message);
  } finally {
    document.querySelector("#desktopPlug").classList.remove("is-busy");
  }
}

function renderOpple() {
  const device = state.opple;
  if (!device) return;
  document.querySelector("#desktopOppleStatus").textContent = device.online
    ? `${device.ip} · ${device.power ? "已打开" : "已关闭"} · 本地控制`
    : `${device.ip} · ${device.error || "离线"}`;
  const power = document.querySelector("#desktopOpplePower");
  const brightness = document.querySelector("#desktopOppleBrightness");
  const color = document.querySelector("#desktopOppleColor");
  power.classList.toggle("is-on", Boolean(device.power));
  power.disabled = !device.online;
  brightness.disabled = !device.online;
  color.disabled = !device.online;
  if (Number.isFinite(device.brightness)) brightness.value = device.brightness;
  if (Number.isFinite(device.color_temperature)) color.value = device.color_temperature;
  document.querySelector("#desktopOppleBrightnessValue").textContent =
    Number.isFinite(device.brightness) ? device.brightness : "—";
  document.querySelector("#desktopOppleColorValue").textContent =
    Number.isFinite(device.color_temperature) ? device.color_temperature : "—";
}

async function sendOppleCommand(payload) {
  document.querySelector("#desktopOpple").classList.add("is-busy");
  try {
    state.opple = await api("/api/opple/command", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(payload),
    });
    renderOpple();
    showToast("欧普灯设置已生效");
  } catch (error) {
    renderOpple();
    showToast(error.message);
  } finally {
    document.querySelector("#desktopOpple").classList.remove("is-busy");
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
  const device = state.aupu;
  if (!device) return;
  document.querySelector("#desktopAupuStatus").textContent = device.online
    ? `${device.ip} · ${device.configured ? device.mode_name : "已发现，等待连接"}`
    : `${device.ip} · ${device.error || "离线"}`;
  document.querySelector("#desktopAupuModes").replaceChildren(...device.modes.map((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.aupuMode = mode.value;
    button.textContent = mode.label;
    button.classList.toggle("active", mode.value === device.mode);
    button.disabled = !device.configured || !device.online;
    return button;
  }));
  const light = document.querySelector("#desktopAupuLight");
  const external = document.querySelector("#desktopAupuExternalLight");
  light.checked = Boolean(device.light);
  external.checked = Boolean(device.external_light);
  light.disabled = !device.configured || !device.online;
  external.disabled = !device.configured || !device.online;
  document.querySelector("#desktopAupuSetup").hidden = device.configured;
}

async function sendAupuCommand(payload) {
  document.querySelector("#desktopAupu").classList.add("is-busy");
  try {
    state.aupu = await api("/api/aupu/command", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(payload),
    });
    renderAupu();
    showToast("浴霸设置已生效");
  } catch (error) {
    renderAupu();
    showToast(error.message);
  } finally {
    document.querySelector("#desktopAupu").classList.remove("is-busy");
  }
}

function renderTV() {
  const tv = state.tv;
  if (!tv) return;
  document.querySelector("#desktopTvName").textContent = `${tv.brand} ${tv.model}`;
  document.querySelector("#desktopTvStatus").textContent = tv.online
    ? `${tv.power ? "播放中" : "待机"}${tv.input_title ? ` · ${tv.input_title}` : ""}`
    : (tv.error || "电视离线");
  const power = document.querySelector("#desktopTvPower");
  power.classList.toggle("is-on", Boolean(tv.power));
  power.disabled = !tv.configured;
  document.querySelector("#desktopTvScreenButton").disabled =
    !tv.configured || !tv.online;
  document.querySelector("#desktopTvScreenNowPlaying").textContent = tv.power
    ? `正在播放：${tv.input_title || "当前电视内容"}`
    : "电视当前处于待机状态";
  const input = document.querySelector("#desktopTvInput");
  input.replaceChildren(...(tv.inputs || []).map((item) => {
    const option = document.createElement("option");
    option.value = item.uri;
    option.textContent = `${item.title}${item.connected ? "" : "（未连接）"}`;
    option.selected = item.uri === tv.input_uri;
    return option;
  }));
  input.disabled = !tv.configured || !tv.online;
  document.querySelectorAll("[data-tv-remote]").forEach((button) => {
    button.disabled = !tv.configured || !tv.online;
  });
  renderTVApps();
}

async function sendTVCommand(payload) {
  try {
    state.tv = await api("/api/tv/command", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(payload),
    });
    renderTV();
    showToast("电视设置已生效");
  } catch (error) {
    showToast(error.message);
  }
}

async function loadTVForeground() {
  const target = document.querySelector("#desktopTvForegroundApp");
  target.textContent = "前台应用：正在识别";
  target.removeAttribute("title");
  try {
    const foreground = await api("/api/tv/foreground", {
      headers: headers(),
    });
    state.tvForeground = foreground;
    target.textContent = foreground.available
      ? `前台应用：${foreground.name}`
      : "前台应用：暂时无法识别";
    if (foreground.package) {
      target.title = `${foreground.package}/${foreground.activity || ""}`;
    }
  } catch {
    state.tvForeground = null;
    target.textContent = "前台应用：暂时无法读取";
  }
  renderTVApps();
}

function renderTVApps() {
  const foreground = state.tvForeground;
  const buttons = document.querySelectorAll("[data-tv-app]");
  let activeLabel = "";
  buttons.forEach((button) => {
    const active = Boolean(
      foreground?.available &&
      foreground.package === button.dataset.tvAppPackage
    );
    button.classList.toggle("active", active);
    button.disabled = !state.tv?.configured || !state.tv?.online;
    if (active) activeLabel = button.querySelector("b")?.textContent || "";
  });
  document.querySelectorAll("[data-tv-cleanup]").forEach((button) => {
    button.disabled = !state.tv?.configured || !state.tv?.online;
  });
  document.querySelector("#desktopTvActiveApp").textContent = activeLabel
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
      headers: headers(),
    });
    state.tvForeground = result.foreground || null;
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
  const wasStandby = !state.tv?.power;
  document.querySelectorAll("[data-tv-app]").forEach((item) => {
    item.disabled = true;
  });
  showToast(wasStandby ? `正在启动电视并打开 ${label}` : `正在打开 ${label}`);
  try {
    const result = await api(`/api/tv/apps/${appId}`, {
      method: "POST",
      headers: headers(),
    });
    if (result.powered_on && state.tv) {
      state.tv.power = true;
      state.tv.online = true;
    }
    state.tvForeground = result.foreground || null;
    renderTVApps();
    showToast(result.powered_on ? `电视已启动并打开 ${label}` : `已打开 ${label}`);
  } catch (error) {
    renderTVApps();
    showToast(error.message);
  }
}

async function captureTVScreen() {
  const image = document.querySelector("#desktopTvScreenImage");
  const placeholder = document.querySelector("#desktopTvScreenPlaceholder");
  const button = document.querySelector("#refreshDesktopTvScreen");
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

function createCard(device) {
  const draft = state.drafts.get(device.id);
  const card = document.createElement("article");
  card.className = `device-card ${device.power ? "is-on" : ""}`;
  card.dataset.id = device.id;

  const horizontal = device.capabilities.horizontal_swing || [];
  const verticalOptions = selectOptions(
    device.capabilities.vertical_swing,
    (value) => verticalLabels[value],
    draft.vertical
  );
  const horizontalOptions = selectOptions(horizontal, (value) => horizontalLabels[value], draft.horizontal);

  card.innerHTML = `
    <div class="card-head">
      <div><span class="device-ip">${device.ip}</span><h4 class="room-name">${device.room}</h4></div>
      <button class="power-button" data-action="power" aria-label="${device.power ? "关闭" : "开启"}空调">◉</button>
    </div>
    <div class="temperature">
      <strong class="temp-value">${formatTemperature(draft.temperature)}</strong><span class="temp-unit">°C</span>
    </div>
    <span class="room-temp">室内 ${device.current_temperature ?? "—"}° · ${device.power ? (modeLabels[device.mode] || device.mode) : "已关闭"}</span>
    <div class="temp-controls">
      <button data-action="temp-down" aria-label="降低温度">−</button>
      <button data-action="temp-up" aria-label="升高温度">＋</button>
    </div>
    <div class="control-row">
      <div class="field"><label>运行模式</label><select data-field="mode">${enumOptions(modeValues, modeLabels, draft.mode)}</select></div>
      <div class="field"><label>风速</label><select data-field="fan">${enumOptions(fanValues, fanLabels, draft.fan)}</select></div>
    </div>
    <div class="advanced-controls">
      <div class="field"><label>上下风向</label><select data-field="vertical">${verticalOptions}</select></div>
      <div class="field" ${horizontal.length ? "" : "hidden"}><label>左右风向</label><select data-field="horizontal">${horizontalOptions}</select></div>
    </div>
    <div class="comfort-toggles">
      ${device.capabilities.sleep ? `<label class="mini-toggle"><span>睡眠</span><input type="checkbox" data-field="sleep" ${draft.sleep ? "checked" : ""}><i></i></label>` : ""}
      ${device.capabilities.light ? `<label class="mini-toggle"><span>面板灯</span><input type="checkbox" data-field="light" ${draft.light ? "checked" : ""}><i></i></label>` : ""}
      ${device.capabilities.quiet ? `<label class="mini-toggle"><span>静音</span><input type="checkbox" data-field="quiet" ${draft.quiet ? "checked" : ""}><i></i></label>` : ""}
      ${device.capabilities.lower_outlet ? `<label class="mini-toggle"><span>下出风</span><input type="checkbox" data-field="lowerOutlet" ${draft.lowerOutlet ? "checked" : ""}><i></i></label>` : ""}
      ${device.capabilities.anti_direct ? `<label class="mini-toggle"><span>防直吹</span><input type="checkbox" data-field="antiDirect" ${draft.antiDirect ? "checked" : ""}><i></i></label>` : ""}
      ${device.capabilities.turbo ? `<label class="mini-toggle"><span>强劲风</span><input type="checkbox" data-field="turbo" ${draft.turbo ? "checked" : ""}><i></i></label>` : ""}
      ${device.capabilities.health ? `<label class="mini-toggle"><span>健康</span><input type="checkbox" data-field="health" ${draft.health ? "checked" : ""}><i></i></label>` : ""}
      ${device.capabilities.auxiliary_heat ? `<label class="mini-toggle"><span>辅热</span><input type="checkbox" data-field="auxiliaryHeat" ${draft.auxiliaryHeat ? "checked" : ""}><i></i></label>` : ""}
    </div>`;
  return card;
}

function enumOptions(valueMap, labelMap, selected) {
  return Object.entries(valueMap)
    .map(([key, value]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${labelMap[key]}</option>`)
    .join("");
}

function selectOptions(values, label, selected) {
  return values
    .map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label(value) || value}</option>`)
    .join("");
}

function formatTemperature(value) {
  return Number(value) % 1 === 0 ? String(Number(value)) : Number(value).toFixed(1);
}

function renderEmpty(title, text) {
  grid.innerHTML = `<div class="empty-state"><h3>${title}</h3><p>${text}</p></div>`;
}

async function sendCommand(card, payload) {
  card.classList.add("is-busy");
  try {
    const updated = await api(`/api/devices/${card.dataset.id}/command`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(payload),
    });
    const index = state.devices.findIndex((item) => item.id === updated.id);
    state.devices[index] = updated;
    state.drafts.set(updated.id, makeDraft(updated));
    render();
    showToast("设置已发送到空调");
  } catch (error) {
    card.classList.remove("is-busy");
    showToast(error.message);
  }
}

function queueCommand(card, payload, delay = 0) {
  const key = card.dataset.id;
  clearTimeout(state.commandTimers.get(key));
  const timer = setTimeout(() => {
    state.commandTimers.delete(key);
    sendCommand(card, payload);
  }, delay);
  state.commandTimers.set(key, timer);
}

grid.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  const card = event.target.closest(".device-card");
  if (!button || !card) return;
  const device = state.devices.find((item) => item.id === card.dataset.id);
  const draft = state.drafts.get(card.dataset.id);
  const action = button.dataset.action;
  if (action === "power") {
    sendCommand(card, { power: !device.power });
  } else if (action === "temp-down" || action === "temp-up") {
    draft.temperature = Math.min(30, Math.max(16, draft.temperature + (action === "temp-up" ? 0.5 : -0.5)));
    card.querySelector(".temp-value").textContent = formatTemperature(draft.temperature);
    queueCommand(card, { power: true, target_temperature: draft.temperature }, 350);
  }
});

grid.addEventListener("change", (event) => {
  const field = event.target.dataset.field;
  const card = event.target.closest(".device-card");
  if (!field || !card) return;
  const draft = state.drafts.get(card.dataset.id);
  const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  draft[field] = value;
  const payloadMap = {
    mode: { power: true, mode: value },
    fan: { fan_speed: value },
    vertical: { vertical_swing: value },
    horizontal: { horizontal_swing: value },
    sleep: { sleep: value },
    light: { light: value },
    quiet: { quiet: value },
    lowerOutlet: { lower_outlet: value },
    antiDirect: { anti_direct: value },
    turbo: { turbo: value },
    health: { health: value },
    auxiliaryHeat: { auxiliary_heat: value },
  };
  if (payloadMap[field]) sendCommand(card, payloadMap[field]);
});

function renderScheduleRoomOptions() {
  const select = document.querySelector("#scheduleRoom");
  const previous = select.value;
  const options = state.devices.map((device) => {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = `格力空调 · ${device.room}`;
    return option;
  });
  if (state.tv?.configured) {
    const option = document.createElement("option");
    option.value = SONY_TV_DEVICE_ID;
    option.textContent = "索尼电视";
    options.push(option);
  }
  if (state.plug?.configured) {
    const option = document.createElement("option");
    option.value = MIJIA_PLUG_DEVICE_ID;
    option.textContent = "米家智能插座 3";
    options.push(option);
  }
  select.replaceChildren(...options);
  if (options.some((option) => option.value === previous)) select.value = previous;
}

function scheduleTargetName(deviceId) {
  if (deviceId === SONY_TV_DEVICE_ID) return "索尼电视";
  if (deviceId === MIJIA_PLUG_DEVICE_ID) return "米家智能插座 3";
  const device = state.devices.find((entry) => entry.id === deviceId);
  return device ? `格力空调 · ${device.room}` : "格力空调";
}

function renderSchedules() {
  const list = document.querySelector("#scheduleList");
  const pending = state.schedules.filter((item) => item.status === "pending");
  if (!pending.length) {
    list.innerHTML = '<div class="desktop-schedule-empty">暂无待执行任务</div>';
    return;
  }
  list.replaceChildren(...pending.map((item) => {
    const row = document.createElement("div");
    row.className = "desktop-schedule-item";
    const when = new Date(item.run_at);
    row.innerHTML = `
      <span>${item.action === "on" ? "开" : "关"}</span>
      <div><strong>${scheduleTargetName(item.device_id)} · ${item.action === "on" ? "定时开机" : "定时关机"}</strong>
      <small>${when.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small></div>
      <button type="button" aria-label="删除任务">×</button>`;
    row.querySelector("button").addEventListener("click", () => deleteSchedule(item.id));
    return row;
  }));
}

document.querySelector("#scheduleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const time = document.querySelector("#scheduleTime").value;
  if (!time) return;
  try {
    const created = await api("/api/schedules", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        device_id: document.querySelector("#scheduleRoom").value,
        action: document.querySelector("#scheduleAction").value,
        run_at: new Date(time).toISOString(),
      }),
    });
    state.schedules = [
      created,
      ...state.schedules.filter((item) => item.id !== created.id),
    ];
    setScheduleTimeAfterMinutes(10);
    renderSchedules();
    showToast("定时任务已添加");
  } catch (error) {
    showToast(error.message);
  }
});

async function deleteSchedule(id) {
  try {
    await api(`/api/schedules/${id}`, { method: "DELETE", headers: headers() });
    state.schedules = state.schedules.filter((item) => item.id !== id);
    renderSchedules();
    showToast("定时任务已删除");
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector("#desktopTvPower").addEventListener("click", () => {
  if (state.tv) sendTVCommand({ power: !state.tv.power });
});
document.querySelector("#desktopTvInput").addEventListener("change", (event) => {
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
document.querySelector("#desktopTvScreenButton").addEventListener("click", () => {
  if (!tvScreenDialog.open) tvScreenDialog.showModal();
  captureTVScreen();
});
document.querySelector("#refreshDesktopTvScreen").addEventListener("click", captureTVScreen);
document.querySelector("#closeDesktopTvScreenDialog").addEventListener("click", () => {
  tvScreenDialog.close();
});
document.querySelector("#desktopAupuModes").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-aupu-mode]");
  if (button) sendAupuCommand({ mode: Number(button.dataset.aupuMode) });
});
document.querySelector("#desktopAupuLight").addEventListener("change", (event) => {
  sendAupuCommand({ light: event.target.checked });
});
document.querySelector("#desktopAupuExternalLight").addEventListener("change", (event) => {
  sendAupuCommand({ external_light: event.target.checked });
});
document.querySelectorAll("[data-xiaomi-setup]").forEach((button) => button.addEventListener("click", () => {
  desktopAupuQrGeneration += 1;
  document.querySelector("#desktopAupuSetupError").textContent = "";
  document.querySelector("#desktopAupuQrBox").hidden = true;
  document.querySelector("#desktopAupuQrStart").disabled = false;
  clearTimeout(desktopAupuQrPollTimer);
  if (!aupuSetupDialog.open) aupuSetupDialog.showModal();
}));
document.querySelector("#closeDesktopAupuSetupDialog").addEventListener("click", () => {
  desktopAupuQrGeneration += 1;
  clearTimeout(desktopAupuQrPollTimer);
  aupuSetupDialog.close();
});
async function pollDesktopAupuQr(sessionId, generation) {
  try {
    const result = await api(`/api/aupu/qr/${sessionId}`, { headers: headers() });
    if (generation !== desktopAupuQrGeneration) return;
    if (result.status === "connected") {
      state.aupu = result.device;
      state.plug = await api("/api/plug", { headers: headers() });
      clearTimeout(desktopAupuQrPollTimer);
      aupuSetupDialog.close();
      renderAupu();
      renderPlug();
      showToast("米家设备已连接");
      return;
    }
    if (result.status === "error" || result.status === "expired") {
      document.querySelector("#desktopAupuSetupError").textContent =
        result.error || "二维码已失效，请重新生成";
      document.querySelector("#desktopAupuQrStatus").textContent = "二维码已失效";
      document.querySelector("#desktopAupuQrStart").disabled = false;
      return;
    }
    document.querySelector("#desktopAupuQrStatus").textContent = "等待在米家 App 中确认…";
    desktopAupuQrPollTimer = setTimeout(
      () => pollDesktopAupuQr(sessionId, generation),
      1800,
    );
  } catch (error) {
    if (generation !== desktopAupuQrGeneration) return;
    document.querySelector("#desktopAupuSetupError").textContent = error.message;
    document.querySelector("#desktopAupuQrStart").disabled = false;
  }
}
document.querySelector("#desktopAupuSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  const generation = ++desktopAupuQrGeneration;
  clearTimeout(desktopAupuQrPollTimer);
  submit.disabled = true;
  document.querySelector("#desktopAupuSetupError").textContent = "";
  try {
    const result = await api("/api/aupu/qr/start", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        locale: document.querySelector("#desktopAupuLocale").value,
      }),
    });
    document.querySelector("#desktopAupuQrImage").src = result.qr_image;
    document.querySelector("#desktopAupuQrBox").hidden = false;
    document.querySelector("#desktopAupuQrStatus").textContent =
      "请使用米家 App 扫码并确认";
    pollDesktopAupuQr(result.session_id, generation);
  } catch (error) {
    if (generation !== desktopAupuQrGeneration) return;
    document.querySelector("#desktopAupuSetupError").textContent = error.message;
    submit.disabled = false;
  }
});
document.querySelector("#desktopPlugPowerButton").addEventListener("click", () => {
  if (state.plug) sendPlugCommand({ on: !state.plug.on });
});
document.querySelector("#desktopPlugDefault").addEventListener("change", (event) => {
  sendPlugCommand({ default_power_state: Number(event.target.value) });
});
document.querySelector("#desktopPlugLock").addEventListener("change", (event) => {
  sendPlugCommand({ physical_lock: event.target.checked });
});
document.querySelector("#desktopPlugIndicator").addEventListener("change", (event) => {
  sendPlugCommand({ indicator_light: event.target.checked });
});
document.querySelector("#desktopPlugCharging").addEventListener("change", (event) => {
  sendPlugCommand({ charging_protection: event.target.checked });
});
document.querySelector("#desktopPlugMaxPowerEnabled").addEventListener("change", (event) => {
  sendPlugCommand({ max_power_limit: event.target.checked });
});
document.querySelector("#desktopPlugMaxPower").addEventListener("change", (event) => {
  sendPlugCommand({ max_power: Number(event.target.value) });
});
document.querySelector("#desktopOpplePower").addEventListener("click", () => {
  if (state.opple?.online) sendOppleCommand({ power: !state.opple.power });
});
document.querySelector("#desktopOppleBrightness").addEventListener("input", (event) => {
  document.querySelector("#desktopOppleBrightnessValue").textContent = event.target.value;
  queueOppleCommand({ brightness: Number(event.target.value) });
});
document.querySelector("#desktopOppleColor").addEventListener("input", (event) => {
  document.querySelector("#desktopOppleColorValue").textContent = event.target.value;
  queueOppleCommand({ color_temperature: Number(event.target.value) });
});
document.querySelector("#desktopPurifierSetup").addEventListener("click", () => {
  document.querySelector("#desktopPurifierSetupError").textContent = "";
  document.querySelector("#desktopPurifierCaptcha").value = "";
  if (!purifierSetupDialog.open) purifierSetupDialog.showModal();
});

document.querySelector("#desktopWaterHeaterBadge").addEventListener("click", () => {
  if (!waterHeaterAuthDialog.open) waterHeaterAuthDialog.showModal();
});
document.querySelector("#closeDesktopWaterHeaterAuthDialog").addEventListener("click", () => {
  waterHeaterAuthDialog.close();
});
document.querySelector("#closeDesktopPurifierSetupDialog").addEventListener("click", () => {
  purifierSetupDialog.close();
});
document.querySelector("#desktopPurifierSendCaptcha").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const mobile = document.querySelector("#desktopPurifierMobile").value.trim();
  const error = document.querySelector("#desktopPurifierSetupError");
  error.textContent = "";
  if (!/^1\d{10}$/.test(mobile)) {
    error.textContent = "请输入正确的 11 位手机号码";
    return;
  }
  button.disabled = true;
  try {
    const verification = await requestTencentCaptcha();
    const result = await api("/api/purifier/captcha", {
      method: "POST",
      headers: headers(true),
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
document.querySelector("#desktopPurifierSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  const error = document.querySelector("#desktopPurifierSetupError");
  error.textContent = "";
  submit.disabled = true;
  try {
    state.purifier = await api("/api/purifier/login", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        mobile: document.querySelector("#desktopPurifierMobile").value.trim(),
        captcha: document.querySelector("#desktopPurifierCaptcha").value.trim(),
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

document.querySelector("#desktopDreameSetup").addEventListener("click", () => {
  document.querySelector("#desktopDreameError").textContent = "";
  document.querySelector("#desktopDreamePassword").value = "";
  if (!desktopDreameSetupDialog.open) desktopDreameSetupDialog.showModal();
});
document.querySelector("#closeDesktopDreameSetup").addEventListener("click", () => {
  desktopDreameSetupDialog.close();
});
document.querySelector("#desktopDreameSetupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  document.querySelector("#desktopDreameError").textContent = "";
  try {
    state.dreame = await api("/api/dreame/login", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        username: document.querySelector("#desktopDreameUsername").value.trim(),
        password: document.querySelector("#desktopDreamePassword").value,
        country: document.querySelector("#desktopDreameCountry").value,
      }),
    });
    document.querySelector("#desktopDreamePassword").value = "";
    desktopDreameSetupDialog.close();
    renderSmartDevices();
    showToast("追觅 X30 已接入");
  } catch (error) {
    document.querySelector("#desktopDreameError").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
document.querySelectorAll("[data-desktop-dreame]").forEach((button) => {
  button.addEventListener("click", () => sendDesktopDreameCommand(button.dataset.desktopDreame));
});
document.querySelectorAll("[data-desktop-dreame-setting]").forEach((control) => {
  if (control.type === "range") {
    control.addEventListener("input", () => {
      document.querySelector("#desktopDreameVolumeValue").textContent = control.value;
    });
  }
  control.addEventListener("change", () => {
    const value = control.type === "checkbox" ? control.checked : Number(control.value);
    sendDesktopDreameSetting(control.dataset.desktopDreameSetting, value, control);
  });
});

document.querySelector("#refreshButton").addEventListener("click", async () => {
  await loadAll(true);
  startDesktopRealtimeRefresh();
});
document.querySelector("#authButton").addEventListener("click", openAuthDialog);
document.querySelector("#closeAuthDialog").addEventListener("click", () => authDialog.close());
document.querySelector("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = passwordInput.value;
  try {
    await api("/api/auth/login", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ password }),
    });
    state.authenticated = true;
    sessionStorage.removeItem("greeApiToken");
    state.legacyToken = "";
    authDialog.close();
    await loadAll(true);
  } catch (error) {
    authError.textContent = error.message;
  }
});
logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    state.authenticated = false;
    sessionStorage.removeItem("greeApiToken");
    location.reload();
  }
});

async function bootstrap() {
  if (state.legacyToken) {
    const legacyToken = state.legacyToken;
    state.legacyToken = "";
    sessionStorage.removeItem("greeApiToken");
    try {
      await api("/api/auth/login", {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ password: legacyToken }),
      });
      state.authenticated = true;
    } catch {
      state.authenticated = false;
    }
  }
  await loadAll(true);
  startDesktopRealtimeRefresh();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function localScheduleValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function applyScheduleTime(value) {
  const [date, time] = value.split("T");
  const [hour, minute] = time.split(":");
  document.querySelector("#scheduleDay").value = date;
  document.querySelector("#scheduleHour").value = hour;
  document.querySelector("#scheduleMinute").value = minute;
  document.querySelector("#scheduleTime").value = value;
}

function syncScheduleTimeFromSelects() {
  document.querySelector("#scheduleTime").value =
    `${document.querySelector("#scheduleDay").value}T${document.querySelector("#scheduleHour").value}:${document.querySelector("#scheduleMinute").value}`;
}

function setScheduleTimeAfterMinutes(minutes) {
  const next = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + minutes * 60_000);
  applyScheduleTime(localScheduleValue(next));
}

function initializeScheduleTime() {
  const daySelect = document.querySelector("#scheduleDay");
  daySelect.innerHTML = Array.from({ length: 8 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index);
    const value = localScheduleValue(date).slice(0, 10);
    const label = index === 0 ? "今天" : index === 1 ? "明天" :
      date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
    return `<option value="${value}">${label}</option>`;
  }).join("");
  document.querySelector("#scheduleHour").innerHTML = Array.from({ length: 24 }, (_, hour) => {
    const value = String(hour).padStart(2, "0");
    return `<option value="${value}">${value}时</option>`;
  }).join("");
  document.querySelector("#scheduleMinute").innerHTML = Array.from({ length: 60 }, (_, minute) => {
    const value = String(minute).padStart(2, "0");
    return `<option value="${value}">${value}分</option>`;
  }).join("");
  setScheduleTimeAfterMinutes(10);
}

document.querySelectorAll("[data-schedule-delay]").forEach((button) => {
  button.addEventListener("click", () => {
    setScheduleTimeAfterMinutes(Number(button.dataset.scheduleDelay));
    document.querySelector("#scheduleForm").requestSubmit();
  });
});
["#scheduleDay", "#scheduleHour", "#scheduleMinute"].forEach((selector) => {
  document.querySelector(selector).addEventListener("change", syncScheduleTimeFromSelects);
});

initializeScheduleTime();
bootstrap();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    desktopRefreshTimers.forEach((timer) => clearTimeout(timer));
    desktopRefreshTimers.clear();
  } else {
    startDesktopRealtimeRefresh(0);
  }
});
