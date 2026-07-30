const model = {
  authenticated: false,
  legacyToken: sessionStorage.getItem("greeApiToken") || "",
  devices: [],
  schedules: [],
  tv: null,
  selectedId: null,
  drafts: new Map(),
  commandTimers: new Map(),
};

const el = (selector) => document.querySelector(selector);
const statusLine = el("#statusLine");
const authDialog = el("#authDialog");
const logoutButton = el("#logoutButton");
const toast = el("#toast");

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
    const error = new Error(body.detail || "请先登录清风家庭");
    error.isAuthError = true;
    throw error;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `请求失败 (${response.status})`);
  }
  return response.json();
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
    const [devices, schedules, tv] = await Promise.all([
      api(`/api/devices?refresh=${refresh}`, { headers: requestHeaders() }),
      api("/api/schedules", { headers: requestHeaders() }),
      api("/api/tv", { headers: requestHeaders() }),
    ]);
    model.authenticated = true;
    updateAuthControls();
    model.devices = devices;
    model.schedules = schedules;
    model.tv = tv;
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
  renderSchedules();
  renderTV();
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
  const inputSelect = el("#tvInputSelect");
  inputSelect.replaceChildren(...(tv.inputs || []).map((input) => {
    const option = document.createElement("option");
    option.value = input.uri;
    option.textContent = `${input.title}${input.connected ? "" : "（未连接）"}`;
    option.selected = input.uri === tv.input_uri;
    return option;
  }));
  inputSelect.disabled = !tv.configured || !tv.online;
  const volume = Number.isFinite(tv.volume) ? tv.volume : 0;
  el("#tvVolumeValue").textContent = Number.isFinite(tv.volume) ? String(tv.volume) : "—";
  el("#tvVolumeRange").value = String(volume);
  el("#tvVolumeRange").disabled =
    !tv.configured || !tv.online || !Number.isFinite(tv.volume);
  el("#tvMuteSwitch").disabled = !tv.configured || !tv.online;
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

function renderSchedules() {
  const list = el("#scheduleList");
  const device = selectedDevice();
  const items = model.schedules.filter((item) =>
    item.device_id === device?.id && item.status === "pending"
  );
  if (!items.length) {
    list.innerHTML = '<div class="schedule-empty">当前房间暂无待执行任务</div>';
    return;
  }
  list.replaceChildren(...items.map((item) => {
    const row = document.createElement("div");
    row.className = "schedule-item";
    const when = new Date(item.run_at);
    row.innerHTML = `
      <span class="schedule-icon">${item.action === "on" ? "开" : "关"}</span>
      <div><strong>${item.action === "on" ? "定时开机" : "定时关机"}</strong>
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
el("#tvVolumeDown").addEventListener("click", () => {
  if (model.tv) sendTVCommand({ remote: "volume_down" });
});
el("#tvVolumeUp").addEventListener("click", () => {
  if (model.tv) sendTVCommand({ remote: "volume_up" });
});
el("#tvVolumeRange").addEventListener("change", (event) => {
  sendTVCommand({ volume: Number(event.target.value) });
});
el("#tvMuteSwitch").addEventListener("click", () => {
  sendTVCommand({ remote: "mute" });
});

document.querySelectorAll(".view-nav button").forEach((button) => {
  button.addEventListener("click", () => {
    document.body.dataset.view = button.dataset.view;
    document.querySelectorAll(".view-nav button").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
  });
});

el("#scheduleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const device = selectedDevice();
  const timeValue = el("#scheduleTime").value;
  if (!device || !timeValue) return;
  try {
    await api("/api/schedules", {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify({
        device_id: device.id,
        action: el("#scheduleAction").value,
        run_at: new Date(timeValue).toISOString(),
        label: `${device.room}定时任务`,
      }),
    });
    el("#scheduleForm").reset();
    showToast("定时任务已添加");
    await loadAll(false);
  } catch (error) {
    showToast(error.message);
  }
});

async function removeSchedule(id) {
  try {
    await api(`/api/schedules/${id}`, {
      method: "DELETE",
      headers: requestHeaders(),
    });
    showToast("定时任务已删除");
    await loadAll(false);
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

function setMinimumScheduleTime() {
  const next = new Date(Date.now() + 60_000);
  const local = new Date(next.getTime() - next.getTimezoneOffset() * 60_000);
  el("#scheduleTime").min = local.toISOString().slice(0, 16);
}

el("#today").textContent = new Date().toLocaleDateString("zh-CN", {
  month: "long", day: "numeric", weekday: "long",
});
setMinimumScheduleTime();
bootstrap();
setInterval(() => {
  if (model.authenticated && !document.hidden) loadAll(true);
}, 60_000);
