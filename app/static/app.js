const state = {
  authenticated: false,
  legacyToken: sessionStorage.getItem("greeApiToken") || "",
  devices: [],
  schedules: [],
  tv: null,
  aupu: null,
  plug: null,
  purifier: null,
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
let desktopAupuQrPollTimer = null;
let desktopAupuQrGeneration = 0;
let tencentCaptchaLoader = null;

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

async function loadAll(refresh = true) {
  setConnection("正在同步", "");
  try {
    const [devices, schedules, tv, aupu, plug, purifier] = await Promise.all([
      api(`/api/devices?refresh=${refresh}`, { headers: headers() }),
      api("/api/schedules", { headers: headers() }),
      api("/api/tv", { headers: headers() }),
      api("/api/aupu", { headers: headers() }),
      api("/api/plug", { headers: headers() }),
      api("/api/purifier", { headers: headers() }),
    ]);
    state.authenticated = true;
    updateAuthControls();
    state.devices = devices;
    state.schedules = schedules;
    state.tv = tv;
    state.aupu = aupu;
    state.plug = plug;
    state.purifier = purifier;
    devices.forEach((device) => {
      if (!state.drafts.has(device.id)) state.drafts.set(device.id, makeDraft(device));
    });
    render();
    loadTVForeground();
    setConnection("本地在线", "online");
    document.querySelector("#lastUpdated").textContent =
      `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    if (error.isAuthError) {
      renderEmpty("请先登录", "输入一次家庭访问密码，此设备将保持登录 30 天。");
    } else {
      setConnection("连接失败", "error");
      showToast(error.message);
    }
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
  renderPurifier();
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
  document.querySelectorAll("[data-tv-app]").forEach((item) => {
    item.disabled = true;
  });
  showToast(`正在打开 ${label}`);
  try {
    const result = await api(`/api/tv/apps/${appId}`, {
      method: "POST",
      headers: headers(),
    });
    state.tvForeground = result.foreground || null;
    renderTVApps();
    showToast(`已打开 ${label}`);
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
document.querySelector("#desktopPurifierSetup").addEventListener("click", () => {
  document.querySelector("#desktopPurifierSetupError").textContent = "";
  document.querySelector("#desktopPurifierCaptcha").value = "";
  if (!purifierSetupDialog.open) purifierSetupDialog.showModal();
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

document.querySelector("#refreshButton").addEventListener("click", () => loadAll(true));
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
setInterval(() => {
  if (state.authenticated && !document.hidden) loadAll(true);
}, 60_000);
