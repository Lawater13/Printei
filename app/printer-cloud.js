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
    list.append(term, detail);
  }
  function swatch(color) {
    const chip = document.createElement("span");
    if (typeof color === "string" && /^#[0-9A-F]{6}$/i.test(color)) {
      chip.className = "printer-swatch";
      chip.style.backgroundColor = color;
    }
    return chip;
  }

  function render() {
    const data = snapshot.telemetry || {}, times = snapshot.updated || {};
    const printer = devices[selected];
    set("printerTitle", printer ? printer.name + (printer.model ? " · " + printer.model : "") : "Suik Lab");
    el("printerOverviewLink").hidden = linked;
    set("printerStatus", reportMessage || (linked ? "Aguardando a primeira consulta." : "Conecte o Printei Cloud em Configurações."));
    const connection = stale(snapshot.connectionAt) ? null : snapshot.connection;
    const state = Object.hasOwn(states, data.state) ? states[data.state] : data.state;
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
    const channels = el("printerChannels"), records = snapshot.channels || {};
    const units = [...new Set(Object.keys(records).map(key => key.split(":")[0]))].filter(id => /^\d+$/.test(id));
    const activeUnit = data.activeTray >= 0 && data.activeTray < 254 ? String(Math.floor(data.activeTray / 4)) : null;
    const unit = units.includes(activeUnit) ? activeUnit : units[0] ?? activeUnit;
    channels.replaceChildren();
    for (let slot = 0; slot < 4; slot++) {
      const color = records[unit + ":" + slot + ":color"], material = records[unit + ":" + slot + ":material"];
      const active = unit != null && activeUnit === unit && data.activeTray % 4 === slot;
      const item = document.createElement("li");
      item.append(swatch(color?.value), "Canal " + (slot + 1) + (active ? " · " + observed("ativo", times.activeTray) : ""));
      const value = document.createElement("small");
      value.textContent = [material?.value ? observed(material.value, material.at) : null,
        color?.value ? observed(color.value, color.at) : null].filter(Boolean).join(" · ") || "Indisponível";
      item.append(value);
      channels.append(item);
    }
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
