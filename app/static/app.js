const state = {
  token: sessionStorage.getItem("greeApiToken") || "",
  devices: [],
  schedules: [],
  drafts: new Map(),
  commandTimers: new Map(),
};

const grid = document.querySelector("#deviceGrid");
const connection = document.querySelector("#connection");
const dialog = document.querySelector("#tokenDialog");
const tokenInput = document.querySelector("#tokenInput");
const dialogError = document.querySelector("#dialogError");
const toast = document.querySelector("#toast");

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
  const value = { Authorization: `Bearer ${state.token}` };
  if (json) value["Content-Type"] = "application/json";
  return value;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    setConnection("需要认证", "error");
    dialog.showModal();
    throw new Error("访问令牌无效");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `请求失败 (${response.status})`);
  }
  return response.json();
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
  };
}

async function loadAll(refresh = true) {
  if (!state.token) {
    dialog.showModal();
    renderEmpty("请先连接", "点击右上角钥匙图标，输入服务器 API Token。");
    return;
  }
  setConnection("正在同步", "");
  try {
    const [devices, schedules] = await Promise.all([
      api(`/api/devices?refresh=${refresh}`, { headers: headers() }),
      api("/api/schedules", { headers: headers() }),
    ]);
    state.devices = devices;
    state.schedules = schedules;
    devices.forEach((device) => {
      if (!state.drafts.has(device.id)) state.drafts.set(device.id, makeDraft(device));
    });
    render();
    setConnection("本地在线", "online");
    document.querySelector("#lastUpdated").textContent =
      `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    if (error.message !== "访问令牌无效") {
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
    <div class="comfort-toggles ${device.capabilities.lower_outlet ? "has-four" : ""}">
      <label class="mini-toggle"><span>睡眠</span><input type="checkbox" data-field="sleep" ${draft.sleep ? "checked" : ""}><i></i></label>
      <label class="mini-toggle"><span>面板灯</span><input type="checkbox" data-field="light" ${draft.light ? "checked" : ""}><i></i></label>
      <label class="mini-toggle"><span>静音</span><input type="checkbox" data-field="quiet" ${draft.quiet ? "checked" : ""}><i></i></label>
      ${device.capabilities.lower_outlet ? `<label class="mini-toggle"><span>下出风</span><input type="checkbox" data-field="lowerOutlet" ${draft.lowerOutlet ? "checked" : ""}><i></i></label>` : ""}
    </div>
    <p class="instant-hint">所有调节都会立即生效</p>`;
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
  };
  if (payloadMap[field]) sendCommand(card, payloadMap[field]);
});

function renderScheduleRoomOptions() {
  const select = document.querySelector("#scheduleRoom");
  const previous = select.value;
  select.replaceChildren(...state.devices.map((device) => {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.room;
    return option;
  }));
  if (state.devices.some((device) => device.id === previous)) select.value = previous;
}

function renderSchedules() {
  const list = document.querySelector("#scheduleList");
  const pending = state.schedules.filter((item) => item.status === "pending");
  if (!pending.length) {
    list.innerHTML = '<div class="desktop-schedule-empty">暂无待执行任务</div>';
    return;
  }
  list.replaceChildren(...pending.map((item) => {
    const device = state.devices.find((entry) => entry.id === item.device_id);
    const row = document.createElement("div");
    row.className = "desktop-schedule-item";
    const when = new Date(item.run_at);
    row.innerHTML = `
      <span>${item.action === "on" ? "开" : "关"}</span>
      <div><strong>${device?.room || "空调"} · ${item.action === "on" ? "定时开机" : "定时关机"}</strong>
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
    await api("/api/schedules", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        device_id: document.querySelector("#scheduleRoom").value,
        action: document.querySelector("#scheduleAction").value,
        run_at: new Date(time).toISOString(),
      }),
    });
    event.target.reset();
    showToast("定时任务已添加");
    await loadAll(false);
  } catch (error) {
    showToast(error.message);
  }
});

async function deleteSchedule(id) {
  try {
    await api(`/api/schedules/${id}`, { method: "DELETE", headers: headers() });
    showToast("定时任务已删除");
    await loadAll(false);
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector("#refreshButton").addEventListener("click", () => loadAll(true));
document.querySelector("#tokenButton").addEventListener("click", () => {
  tokenInput.value = state.token;
  dialogError.textContent = "";
  dialog.showModal();
});
document.querySelector("#tokenForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.token = tokenInput.value.trim();
  try {
    await api("/api/devices?refresh=false", { headers: headers() });
    sessionStorage.setItem("greeApiToken", state.token);
    dialog.close();
    await loadAll(true);
  } catch (error) {
    dialogError.textContent = error.message;
  }
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setMinimumScheduleTime() {
  const next = new Date(Date.now() + 60_000);
  const local = new Date(next.getTime() - next.getTimezoneOffset() * 60_000);
  document.querySelector("#scheduleTime").min = local.toISOString().slice(0, 16);
}

setMinimumScheduleTime();
loadAll(true);
setInterval(() => {
  if (state.token && !document.hidden) loadAll(true);
}, 60_000);
