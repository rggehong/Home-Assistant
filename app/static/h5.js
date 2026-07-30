const model = {
  authenticated: false,
  legacyToken: sessionStorage.getItem("greeApiToken") || "",
  devices: [],
  schedules: [],
  tv: null,
  aupu: null,
  plug: null,
  purifier: null,
  waterHeater: null,
  tvForeground: null,
  selectedId: null,
  drafts: new Map(),
  commandTimers: new Map(),
};

const el = (selector) => document.querySelector(selector);
const SONY_TV_DEVICE_ID = "sony-living-tv";
const MIJIA_PLUG_DEVICE_ID = "mijia-plug-3";
const statusLine = el("#statusLine");
const authDialog = el("#authDialog");
const logoutButton = el("#logoutButton");
const toast = el("#toast");
const tvScreenDialog = el("#tvScreenDialog");
const aupuSetupDialog = el("#aupuSetupDialog");
const purifierSetupDialog = el("#purifierSetupDialog");
let aupuQrPollTimer = null;
let aupuQrGeneration = 0;
let tencentCaptchaLoader = null;

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

function ensureDraft(device) {
  if (!model.drafts.has(device.id)) {
    model.drafts.set(device.id, {
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
    });
  }
  return model.drafts.get(device.id);
}

async function loadAll(refresh = true) {
  setStatus("正在同步空调状态", "");
  try {
    const [devices, schedules, tv, aupu, plug, purifier, waterHeater] = await Promise.all([
      api(`/api/devices?refresh=${refresh}`, { headers: requestHeaders() }),
      api("/api/schedules", { headers: requestHeaders() }),
      api("/api/tv", { headers: requestHeaders() }),
      api("/api/aupu", { headers: requestHeaders() }),
      api("/api/plug", { headers: requestHeaders() }),
      api("/api/purifier", { headers: requestHeaders() }),
      api("/api/water-heater", { headers: requestHeaders() }),
    ]);
    model.authenticated = true;
    updateAuthControls();
    model.devices = devices;
    model.schedules = schedules;
    model.tv = tv;
    model.aupu = aupu;
    model.plug = plug;
    model.purifier = purifier;
    model.waterHeater = waterHeater;
    devices.forEach(ensureDraft);
    if (!devices.some((device) => device.id === model.selectedId)) {
      model.selectedId = devices[0]?.id || null;
    }
    render();
    setStatus(`${devices.length} 台空调本地在线`, "online");
  } catch (error) {
    if (!error.isAuthError) {
      setStatus("连接失败", "error");
      showToast(error.message);
    }
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
  renderPurifier();
  renderWaterHeater();
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

function renderAupu() {
  const device = model.aupu;
  if (!device) return;
  el("#aupuStatus").textContent = device.online
    ? `${device.ip} · ${device.configured ? "本地在线" : "已发现，等待连接"}`
    : `${device.ip} · ${device.error || "离线"}`;
  el("#aupuModeName").textContent = device.mode_name || "—";
  el("#aupuModes").replaceChildren(...device.modes.map((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.aupuMode = mode.value;
    button.textContent = mode.label;
    button.classList.toggle("active", mode.value === device.mode);
    button.disabled = !device.configured || !device.online;
    return button;
  }));
  el("#aupuLight").checked = Boolean(device.light);
  el("#aupuExternalLight").checked = Boolean(device.external_light);
  el("#aupuLight").disabled = !device.configured || !device.online;
  el("#aupuExternalLight").disabled = !device.configured || !device.online;
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
    renderAupu();
    showToast("浴霸设置已生效");
  } catch (error) {
    renderAupu();
    showToast(error.message);
  } finally {
    el("#aupuView").classList.remove("is-busy");
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
  document.querySelectorAll("[data-tv-app]").forEach((item) => {
    item.disabled = true;
  });
  showToast(`正在打开 ${label}`);
  try {
    const result = await api(`/api/tv/apps/${appId}`, {
      method: "POST",
      headers: requestHeaders(),
    });
    model.tvForeground = result.foreground || null;
    renderTVApps();
    showToast(`已打开 ${label}`);
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
  select.replaceChildren(...options);
  const fallback = selectedDevice()?.id || SONY_TV_DEVICE_ID;
  select.value = options.some((option) => option.value === previous) ? previous : fallback;
}

function scheduleTargetName(deviceId) {
  if (deviceId === SONY_TV_DEVICE_ID) return "索尼电视";
  if (deviceId === MIJIA_PLUG_DEVICE_ID) return "米家智能插座 3";
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
});
el("#aupuLight").addEventListener("change", (event) => {
  sendAupuCommand({ light: event.target.checked });
});
el("#aupuExternalLight").addEventListener("change", (event) => {
  sendAupuCommand({ external_light: event.target.checked });
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
el("#purifierSetupButton").addEventListener("click", () => {
  el("#purifierSetupError").textContent = "";
  el("#purifierCaptcha").value = "";
  if (!purifierSetupDialog.open) purifierSetupDialog.showModal();
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
    document.body.dataset.view = button.dataset.view;
    document.querySelectorAll(".view-nav button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    if (button.dataset.view === "tv") loadTVForeground();
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
    renderSchedules();
    showToast("定时任务已删除");
  } catch (error) {
    showToast(error.message);
  }
}

el("#syncButton").addEventListener("click", () => loadAll(true));
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
setInterval(() => {
  if (model.authenticated && !document.hidden) loadAll(true);
}, 60_000);
