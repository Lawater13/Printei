(() => {
  "use strict";

  const el = id => document.getElementById(id);
  const get = id => el(id).value;
  const set = (id, text) => { el(id).textContent = text; };
  const date = stamp => new Date(stamp).toLocaleString("pt-BR");
  const decimal = value => value.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  const unavailable = "—";
  const states = {
    IDLE: "Em repouso", RUNNING: "Imprimindo", PAUSE: "Pausada", PREPARE: "Preparando",
    INIT: "Preparando", SLICING: "Preparando", FINISH: "Concluída", FAILED: "Erro",
    CANCELED: "Interrompida", CANCELLED: "Interrompida"
  };
  const reportErrors = {
    no_report: "Nenhum relatório novo nesta consulta.",
    auth_refused: "A sessão Bambu foi recusada. Vincule novamente em Configurações.",
    broker_refused: "O broker recusou a conexão.",
    subscription_refused: "O broker recusou a assinatura MQTT.",
    timeout: "A conexão MQTT excedeu o tempo limite.",
    disconnected: "O broker encerrou a conexão.",
    network_error: "Falha de comunicação MQTT."
  };

  let devices = [], selected = 0, snapshot = {}, busy = false, linked = false, lastPoll = 0;
  let reportMessage = "";
  let historyMessage = "";
  let generation = 0;
  let pairing = false, restoring = false, retryAt = 0;

  async function api(action, data = {}) {
    const response = await fetch("/printer-cloud/" + action, {
      method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Printei-Printer": "1" },
      body: JSON.stringify(data)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const diagnostics = [body.stage, body.category, body.upstreamStatus && "HTTP Bambu " + body.upstreamStatus].filter(Boolean);
      throw Object.assign(new Error((body.error || "Falha na consulta.") +
        (diagnostics.length ? " (" + diagnostics.join(" · ") + ")" : "")), { status: response.status });
    }
    return body;
  }

  function loadDevices(result) {
    devices = Array.isArray(result.devices) ? result.devices : [];
    const suik = devices.findIndex(device => device.name?.trim().toLowerCase() === "suik lab");
    selected = suik >= 0 ? suik : 0;
    el("printerSelect").replaceChildren(...devices.map((device, index) =>
      new Option(device.name + (device.model ? " · " + device.model : ""), index)));
    el("printerSelect").value = String(selected);
    el("printerDeviceField").hidden = devices.length < 2;
    linked = devices.length > 0;
    generation++;
    snapshot = {};
    lastPoll = 0;
    reportMessage = "";
    historyMessage = "";
    render();
  }

  const connectButton = el("printerConnect");
  async function restore() {
    if (restoring) return;
    restoring = true;
    try {
      const result = await api("session");
      if (result.pairing) {
        pairing = true;
        retryAt = Date.now() + 2000;
        return;
      }
      loadDevices(result);
      set("printerSettingsStatus", linked ? "Impressora conectada." : "Nenhuma impressora vinculada.");
    } catch (error) {
      if (error.status === 428) {
        set("printerSettingsStatus", pairing ? "Autorização pendente. Abra uma nova janela para tentar novamente." : "");
      } else {
        set("printerSettingsStatus", error.message);
        if (error.status === 502 || !error.status) retryAt = Date.now() + 15000;
      }
    } finally {
      if (retryAt <= Date.now()) pairing = false;
      restoring = false;
      connectButton.disabled = linked;
    }
  }
  connectButton.onclick = async () => {
    connectButton.disabled = true;
    try {
      await api("connect");
      pairing = true;
      set("printerSettingsStatus", "Conclua a autorização na janela do Printei.");
      retryAt = Date.now() + 1000;
    } catch (error) {
      set("printerSettingsStatus", error.message);
    } finally {
      connectButton.disabled = linked;
    }
  };
  el("printerSelect").onchange = () => {
    selected = Number(get("printerSelect"));
    generation++;
    snapshot = {};
    lastPoll = 0;
    reportMessage = "";
    historyMessage = "";
    render();
  };

  const stale = at => at != null && Date.now() - at > (snapshot.staleAfterMs || 120000);
  function observed(value, at) {
    if (value == null) return unavailable;
    if (at == null) return value + " · sem horário";
    return stale(at) ? value + " · desatualizado" : String(value);
  }
  function pair(list, label, value) {
    const term = document.createElement("dt"), detail = document.createElement("dd");
    term.textContent = label;
    detail.textContent = value;
    if (list.id === "printerMetrics") {
      const tile = document.createElement("div");
      tile.className = "printer-metric-tile";
      const icon = document.createElement("span");
      icon.className = "printer-metric-icon";
      icon.setAttribute("aria-hidden", "true");
      const paths = {"Estado":"M8 5l12 7-12 7z","Progresso":"M12 3a9 9 0 1 1-9 9M12 3v4","Restante":"M12 7v5l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0","Bico":"M8 3h8v8l-4 5-4-5zM12 16v5","Mesa":"M4 19h16M8 15c-3-4 3-5 0-9M12 15c-3-4 3-5 0-9M16 15c-3-4 3-5 0-9"};
      const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
      svg.setAttribute("viewBox","0 0 24 24"); svg.setAttribute("fill","none"); svg.setAttribute("stroke","currentColor"); svg.setAttribute("stroke-width","1.7"); svg.setAttribute("stroke-linecap","round"); svg.setAttribute("stroke-linejoin","round");
      const path = document.createElementNS(svg.namespaceURI,"path"); path.setAttribute("d",paths[label] || paths.Estado); svg.append(path); icon.append(svg); tile.append(icon,term,detail); list.append(tile);
    } else list.append(term, detail);
  }
  function swatch(color) {
    const chip = document.createElement("span");
    chip.className = "printer-swatch";
    if (typeof color === "string" && /^#[0-9A-F]{6}$/i.test(color)) {
      chip.className = "printer-swatch";
      chip.style.backgroundColor = color;
    }
    return chip;
  }

  const slots = [0, 1, 2, 3];
  const colorHex = value => typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value.trim())
    ? "#" + value.trim().replace(/^#/, "").toUpperCase() : null;

  function printerChannelKey() {
    const printer = devices[selected];
    if (typeof printer?.monitorId === "string" && /^[a-f0-9]{64}$/.test(printer.monitorId)) {
      return "printei-bmcu-colors-v1:" + printer.monitorId;
    }
    return null;
  }

  function readChannelPreferences(key) {
    if (!key) return {};
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return {
        unit: typeof value?.unit === "string" && /^\d{1,3}$/.test(value.unit) ? value.unit : null,
        active: slots.includes(value?.active) ? value.active : null,
        colors: slots.map(slot => colorHex(value?.colors?.[slot]))
      };
    } catch {
      return {};
    }
  }

  function channelView() {
    const records = snapshot.channels || {};
    const tray = snapshot.telemetry?.activeTray;
    // AMS HT reports one of its unit IDs (128–135) directly, and 254/255 indicate external/no tray.
    const multiSlot = id => /^\d{1,3}$/.test(id) && (Number(id) < 128 || Number(id) > 135);
    const traySlot = Number.isInteger(tray) && tray >= 0 && tray < 254 && (tray < 128 || tray > 135)
      ? { unit: String(Math.floor(tray / 4)), slot: tray % 4 } : null;
    const activeAt = snapshot.updated?.activeTray;
    const knownActive = activeAt != null && !stale(activeAt) && snapshot.connection === "online" &&
      !stale(snapshot.connectionAt) && (traySlot || tray === 254 || tray === 255 || (tray >= 128 && tray <= 135));
    const units = [...new Set(Object.keys(records).map(key => key.split(":")[0]))].filter(multiSlot);
    const preferences = readChannelPreferences(printerChannelKey());
    const unit = (knownActive ? traySlot?.unit : null) ?? preferences.unit ?? units[0] ?? traySlot?.unit ?? null;
    const manualApplies = preferences.unit === unit || (preferences.unit == null && units.length <= 1);
    return { records, tray, traySlot, activeAt, knownActive, unit, preferences: manualApplies ? preferences : {} };
  }

  function renderChannels() {
    const { records, tray, traySlot, activeAt, knownActive, unit, preferences } = channelView();
    const channels = el("printerChannels");
    channels.replaceChildren();
    let receivedColor = false;
    for (const slot of slots) {
      const reported = records[unit + ":" + slot + ":color"];
      const material = records[unit + ":" + slot + ":material"];
      const automatic = colorHex(reported?.value);
      const manual = !automatic ? preferences.colors?.[slot] : null;
      const color = manual || automatic;
      if (automatic) receivedColor = true;
      const active = knownActive && traySlot?.unit === unit && traySlot?.slot === slot;
      const indicated = preferences.active === slot;
      const marked = indicated && !knownActive;
      const item = document.createElement("li");
      if (active || marked) item.dataset.active = "";
      item.append(swatch(color), "Canal " + (slot + 1) + (active ? " · em uso" : marked ? " · uso informado" : indicated ? " · indicação manual" : ""));
      const detail = document.createElement("small");
      item.title = [color, automatic && stale(reported.at) ? "Última cor recebida" : null, material?.value && stale(material.at) ? "Último material recebido" : null].filter(Boolean).join(" · ");
      detail.textContent = [
        material?.value || null,
        manual ? "Manual" : color ? null : "Cor não recebida"
      ].filter(Boolean).join(" · ");
      item.append(detail);
      channels.append(item);
    }
    const configure = el("printerConfigureChannels"), hint = el("printerChannelHint");
    configure.hidden = !linked || !printerChannelKey();
    const hasManual = preferences.colors?.some(Boolean);
    hint.hidden = !linked || receivedColor;
    hint.textContent = hasManual
      ? "A impressora ainda não enviou as cores do BMCU."
      : "A impressora ainda não enviou as cores. Você pode informar a cor do filamento.";
    const singleUnit = knownActive && tray >= 128 && tray <= 135;
    const prefix = singleUnit ? tray + ":0:" : "external:0:";
    const color = records[prefix + "color"], material = records[prefix + "material"];
    const spoolActive = knownActive && (tray === 254 || singleUnit);
    const external = el("printerExternal");
    external.hidden = !linked || !(spoolActive || color?.value || material?.value);
    if (!external.hidden) {
      const swatchColor = colorHex(color?.value);
      const summary = [
        swatchColor ? null : "cor não recebida",
        material?.value || null
      ].filter(Boolean);
      const name = singleUnit ? "Unidade de bobina única" : "Bobina externa";
      external.title = [swatchColor, swatchColor && stale(color.at) ? "Última cor recebida" : null, material?.value && stale(material.at) ? "Último material recebido" : null].filter(Boolean).join(" · ");
      external.replaceChildren(swatch(swatchColor), name + (spoolActive ? " · em uso" : "") + (summary.length ? " · " + summary.join(" · ") : ""));
    }
  }

  const channelDialog = el("printerChannelDialog");
  let editingChannels;
  el("printerConfigureChannels").onclick = () => {
    const key = printerChannelKey();
    if (!key || channelDialog.open) return;
    const { unit, preferences, records } = channelView();
    editingChannels = { key, unit };
    const fields = el("printerColorFields");
    fields.replaceChildren();
    el("printerManualActive").value = preferences.active == null ? "" : String(preferences.active + 1);
    el("printerChannelError").hidden = true;
    for (const slot of slots) {
      const label = document.createElement("label");
      label.htmlFor = "printerColor" + slot;
      label.textContent = "Canal " + (slot + 1);
      const picker = document.createElement("input");
      picker.type = "color";
      picker.setAttribute("aria-label", "Escolher cor do canal " + (slot + 1));
      picker.value = preferences.colors?.[slot] || colorHex(records[unit + ":" + slot + ":color"]?.value) || "#000000";
      const hex = document.createElement("input");
      hex.id = label.htmlFor;
      hex.value = preferences.colors?.[slot] || "";
      hex.placeholder = "Sem cor manual";
      hex.maxLength = 7;
      hex.oninput = () => {
        const color = colorHex(hex.value);
        if (color) picker.value = color;
      };
      picker.oninput = () => { hex.value = picker.value.toUpperCase(); };
      const inputs = document.createElement("div");
      inputs.className = "printer-slot-color";
      inputs.append(picker, hex);
      const field = document.createElement("div");
      field.append(label, inputs);
      fields.append(field);
    }
    channelDialog.showModal();
  };
  el("printerCancelChannels").onclick = () => channelDialog.close();
  el("printerChannelForm").onsubmit = event => {
    event.preventDefault();
    if (!editingChannels) return;
    const values = slots.map(slot => get("printerColor" + slot).trim());
    const colors = values.map(value => colorHex(value));
    const error = el("printerChannelError");
    if (values.some((value, slot) => value && !colors[slot])) {
      error.textContent = "Use seis dígitos hexadecimais, como #A855F7, ou deixe em branco.";
      error.hidden = false;
      return;
    }
    const active = get("printerManualActive");
    try {
      if (!active && !colors.some(Boolean)) localStorage.removeItem(editingChannels.key);
      else localStorage.setItem(editingChannels.key, JSON.stringify({
        unit: editingChannels.unit, active: active ? Number(active) - 1 : null, colors
      }));
    } catch {
      error.textContent = "Não foi possível salvar as cores neste perfil do Printei.";
      error.hidden = false;
      return;
    }
    channelDialog.close();
    renderChannels();
  };

  function render() {
    const data = snapshot.telemetry || {}, times = snapshot.updated || {};
    const printer = devices[selected];
    set("printerTitle", printer ? printer.name + (printer.model ? " · " + printer.model : "") : "Suik Lab");
    el("printerOverviewLink").hidden = linked;
    set("printerStatus", reportMessage || (snapshot.status === "received" ? "Telemetria recebida."
      : linked ? "Aguardando a primeira consulta." : "Conecte o Printei Cloud em Configurações."));
    const connection = stale(snapshot.connectionAt) ? null : snapshot.connection;
    const state = Object.hasOwn(states, data.state) ? states[data.state] : data.state;
    el("printerConnection").dataset.status = connection || "unknown";
    set("printerConnection", connection ? (connection === "online" ? "Online" : "Offline") : "Conexão indeterminada");
    set("printerJob", ["RUNNING", "PAUSE", "PREPARE", "INIT", "SLICING"].includes(data.state)
      ? observed(data.job || data.file, data.job ? times.job : times.file) : unavailable);
    const progress = el("printerProgress");
    progress.hidden = typeof data.progress !== "number";
    progress.value = data.progress ?? 0;
    const metrics = el("printerMetrics");
    metrics.replaceChildren();
    pair(metrics, "Estado", observed(state, times.state));
    for (const [label, key, unit] of [
      ["Progresso", "progress", "%"], ["Restante", "remainingMinutes", " min"],
      ["Bico", "nozzleC", " °C"], ["Mesa", "bedC", " °C"]
    ]) pair(metrics, label, observed(typeof data[key] === "number" ? decimal(data[key]) + unit : null, times[key]));
    renderChannels();
    const details = el("printerDetailsMetrics");
    details.replaceChildren();
    if (snapshot.lastReportAt) pair(details, "Última comunicação", observed(date(snapshot.lastReportAt), snapshot.lastReportAt));
    for (const [label, key, unit] of [
      ["Alvo do bico", "nozzleTargetC", " °C"], ["Alvo da mesa", "bedTargetC", " °C"], ["Câmara", "chamberC", " °C"],
      ["Camada", "layer", ""], ["Total de camadas", "totalLayers", ""], ["Velocidade relativa", "speedPercent", "%"],
      ["Ventilador da peça", "partFan", "/15"], ["Ventilador do hotend", "hotendFan", "/15"],
      ["Ventilador auxiliar", "auxFan", "/15"], ["Ventilador da câmara", "chamberFan", "/15"]
    ]) pair(details, label, observed(typeof data[key] === "number" ? decimal(data[key]) + unit : null, times[key]));
    pair(details, "Início informado", observed(data.startedAt ? date(data.startedAt) : null, times.startedAt));
    pair(details, "Previsão de término", snapshot.eta && !stale(times.remainingMinutes) && !stale(times.state) ? date(snapshot.eta) : unavailable);
    pair(details, "Erro", observed(data.printError == null ? null : data.printError ? "0x" + data.printError.toString(16).toUpperCase() : "Nenhum informado", times.printError));
    pair(details, "Alertas HMS", observed(data.alerts == null ? null : data.alerts.join(", ") || "Nenhum informado", times.alerts));
    renderHistory();
  }

  function renderHistory() {
    const list = el("printerHistory"), colorFilter = el("printerColorFilter");
    const history = Array.isArray(snapshot.history) ? snapshot.history : [];
    const chosen = colorFilter.value;
    const colors = [...new Set(history.flatMap(entry => Object.keys(entry.estimated || {})))].sort();
    colorFilter.replaceChildren(new Option("Todas as cores", ""), ...colors.map(color => new Option(color, color)));
    if (colors.includes(chosen)) colorFilter.value = chosen;
    const from = get("printerFrom"), to = get("printerTo"), status = get("printerResult"), color = colorFilter.value;
    const start = from ? new Date(from + "T00:00:00").getTime() : -Infinity;
    const end = to ? new Date(to + "T23:59:59.999").getTime() : Infinity;
    list.replaceChildren();
    if (!linked || (from && to && from > to)) {
      set("printerHistoryStatus", linked ? "A data inicial deve vir antes da data final." : historyMessage || "Conecte o Printei Cloud em Configurações.");
      return;
    }
    const filtered = history.filter(entry => {
      const timestamp = entry.endedAt ?? entry.observedAt;
      return timestamp >= start && timestamp <= end && (!status || entry.result === status) &&
        (!color || Object.hasOwn(entry.estimated || {}, color));
    });
    set("printerHistoryStatus", filtered.length ? filtered.length + " de " + history.length + " impressões" :
      history.length ? "Nenhuma impressão corresponde aos filtros." : historyMessage || "Nenhum encerramento disponível.");
    for (const entry of filtered) {
      const row = document.createElement("tr");
      for (const text of [entry.job || "Peça sem nome", date(entry.endedAt ?? entry.observedAt),
        entry.result === "completed" ? "Concluída" : "Interrompida"]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      const details = document.createElement("td");
      const estimates = Object.entries(entry.estimated || {}).filter(([hex]) => !color || hex === color);
      for (const [hex, grams] of estimates) {
        if (!Number.isFinite(grams)) continue;
        const item = document.createElement("span");
        item.className = "printer-estimate";
        item.append(swatch(hex), hex + " · " + decimal(grams) + " g");
        details.append(item);
      }
      if (!details.children.length) details.textContent = unavailable;
      row.append(details);
      list.append(row);
    }
  }
  for (const id of ["printerFrom", "printerTo", "printerResult", "printerColorFilter"]) el(id).onchange = renderHistory;

  const visible = new Set();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target);
    }
    refresh();
  });
  observer.observe(el("printerOverview"));
  observer.observe(el("printerProduction"));
  async function refresh(manual = false) {
    if (!linked || busy || document.hidden || !visible.size || (!manual && Date.now() - lastPoll < 30000)) return;
    busy = true;
    lastPoll = Date.now();
    const requestGeneration = generation;
    try {
      const result = await api("telemetry", { device: selected });
      if (requestGeneration !== generation) return;
      snapshot = result;
      reportMessage = reportErrors[result.status] || "";
      historyMessage = reportMessage;
    } catch (error) {
      if (requestGeneration !== generation) return;
      reportMessage = error.message;
      historyMessage = reportMessage;
      if (error.status === 401 || error.status === 403) {
        linked = false;
        connectButton.disabled = false;
        set("printerSettingsStatus", error.message);
        snapshot = {};
      }
    } finally {
      busy = false;
      render();
    }
  }
  el("printerRefresh").onclick = () => refresh(true);
  el("printerProductionRefresh").onclick = () => refresh(true);
  document.addEventListener("visibilitychange", () => refresh());
  setInterval(() => {
    if (retryAt && Date.now() >= retryAt && !restoring) {
      retryAt = 0;
      restore();
    }
    if (!document.hidden && visible.size) refresh();
  }, 1000);
  setInterval(() => {
    if (!document.hidden && visible.size) render();
  }, 15000);
  render();
  restore();
})();
