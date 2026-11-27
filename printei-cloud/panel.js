export const panel = String.raw`<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Printei Cloud</title>
<style>
  :root { color-scheme: dark; font: 16px system-ui; }
  body { background: #15121b; color: #eee; margin: 24px; }
  main { max-width: 700px; margin: auto; background: #201d27; padding: 24px; border-radius: 16px; }
  a { color: #c084fc; }
  input, button, select { font: inherit; padding: .45rem; max-width: 100%; }
  label { display: block; margin: .6rem 0; }
  button { margin: .2rem .15rem .2rem 0; }
  section { border-top: 1px solid #4a4056; margin-top: 1.5rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .4rem 1rem; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .swatch { display: inline-block; width: .8em; height: .8em; border: 1px solid #bbb; margin-right: .35em; }
</style>
<main>
  <h1>Printei Cloud</h1>
  <p><a href="/diagnostic">Testar TLS com a Bambu Cloud</a></p>
  <label>Chave privada do Printei <input id="key" type="password" required autocomplete="off"></label>
  <button id="resume">Abrir sessão salva</button>
  <button id="logout">Remover sessão salva</button>
  <section>
    <h2>Entrar com a conta Bambu Lab</h2>
    <form id="auth">
      <label>E-mail <input id="email" type="email" required autocomplete="email" maxlength="254"></label>
      <button type="button" id="send">Solicitar código</button>
      <label>Código <input id="code" inputmode="numeric" pattern="[0-9]{6}" required maxlength="6" autocomplete="one-time-code"></label>
      <button type="submit">Entrar e salvar sessão</button>
    </form>
  </section>
  <p id="status" role="status"></p>
  <section id="monitor" hidden>
    <h2>Monitoramento da impressora</h2>
    <label>Impressora <select id="device"></select></label>
    <button id="refresh">Atualizar agora</button>
    <label><input id="auto" type="checkbox"> Atualizar a cada 30 segundos enquanto o painel estiver visível</label>
    <p id="sample"></p>
    <dl id="metrics"></dl>
    <h3>Canais de filamento</h3>
    <ul id="channels"></ul>
    <h3>Consumo por cor</h3>
    <dl><dt>Estimado</dt><dd><span id="estimated">Indisponível</span></dd><dt>Real</dt><dd>Indisponível nos relatórios MQTT</dd></dl>
    <h3>Histórico de impressões</h3>
    <ul id="history"></ul>
  </section>
</main>
<script>
  const byId = id => document.getElementById(id);
  const key = byId("key"), email = byId("email"), code = byId("code"), device = byId("device");
  const monitor = byId("monitor"), status = byId("status");
  let busy = false;
  let lastView = {};
  const states = {
    no_report: "Inscrição aceita. Nenhum relatório de impressão chegou nesta consulta.",
    auth_refused: "O broker recusou a sessão. Entre novamente para renovar a sessão.",
    broker_refused: "O broker recusou a conexão.",
    subscription_refused: "O broker recusou a inscrição no tópico de relatórios.",
    timeout: "Tempo limite ao conectar ou inscrever no MQTT.",
    disconnected: "O broker fechou a conexão.",
    network_error: "Falha de comunicação com o broker MQTT."
  };
  const mqttStages = {
    tls: "conexão TLS", auth: "autenticação MQTT", subscribe: "assinatura MQTT", listening: "escuta MQTT"
  };
  async function call(path, data = {}) {
    const response = await fetch("/bambu/" + path, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, key: key.value })
    });
    if (response.type === "opaqueredirect") {
      throw new Error("A solicitação foi redirecionada. Reabra o painel para renovar o acesso.");
    }
    const result = await response.json().catch(() => null);
    if (!result) {
      throw new Error("O Worker retornou uma resposta inesperada (HTTP " + response.status + ").");
    }
    if (response.status === 401 && (path === "telemetry" || path === "session")) {
      monitor.hidden = true;
      byId("auto").checked = false;
    }
    if (!response.ok) {
      const evidence = [
        result.stage,
        result.category,
        Number.isInteger(result.upstreamStatus) ? "HTTP Bambu " + result.upstreamStatus : null,
        Number.isInteger(result.applicationCode) ? "código Bambu " + result.applicationCode : null
      ].filter(Boolean);
      const message = result.error || "Falha na solicitação.";
      throw new Error(evidence.length ? message + " (" + evidence.join(" · ") + ")" : message);
    }
    return result;
  }
  async function run(action) {
    if (busy || !key.reportValidity()) return;
    busy = true;
    const controls = document.querySelectorAll("button, input, select");
    controls.forEach(control => control.disabled = true);
    status.textContent = "Consultando…";
    try {
      await action();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      controls.forEach(control => control.disabled = false);
      busy = false;
    }
  }
  function showDevices(devices) {
    device.replaceChildren(...devices.map((item, index) =>
      new Option(item.name + (item.model ? " · " + item.model : ""), index)));
    monitor.hidden = devices.length === 0;
    render({});
  }
  const printStates = {
    IDLE: "Em repouso", RUNNING: "Imprimindo", PAUSE: "Pausada", PREPARE: "Preparando",
    SLICING: "Preparando", INIT: "Preparando", FINISH: "Concluída", FAILED: "Erro",
    CANCELLED: "Interrompida", CANCELED: "Interrompida"
  };
  const speedModes = { 1: "Silencioso", 2: "Padrão", 3: "Esportivo", 4: "Máximo" };
  const formatTime = timestamp => new Date(timestamp).toLocaleString("pt-BR");
  const duration = minutes => {
    const rounded = Math.max(0, Math.floor(minutes));
    return rounded < 60 ? rounded + " min" : Math.floor(rounded / 60) + " h " + rounded % 60 + " min";
  };
  const fan = value => value == null ? null : value === 0 ? "Desligado" : "Ligado · nível " + value + "/15";
  const fmt = (value, unit) => value == null ? null : value + unit;

  function render(result) {
    lastView = result;
    const now = Date.now(), staleAfter = result.staleAfterMs || 120000;
    const data = result.telemetry || {}, updated = result.updated || {};
    const stale = at => at == null || now - at > staleAfter;
    const suffix = (at, value) => value == null ? "" : at == null ? " · horário de origem desconhecido"
      : stale(at) ? " · desatualizado" : "";
    const age = (...keys) => keys.some(key => updated[key] == null) ? null
      : Math.min(...keys.map(key => updated[key]));
    byId("sample").textContent = result.lastReportAt
      ? "Última comunicação MQTT: " + formatTime(result.lastReportAt) + suffix(result.lastReportAt, true)
      : "Última comunicação MQTT indisponível.";
    const metrics = byId("metrics");
    metrics.replaceChildren();
    const printing = ["RUNNING", "PAUSE", "PREPARE", "INIT", "SLICING"].includes(data.state);
    const channelRecords = result.channels || {};
    const activeTray = data.activeTray == null ? null : data.activeTray === 254 ? "Bobina externa"
      : data.activeTray === 255 ? "Nenhum indicado" : "Unidade " + Math.floor(data.activeTray / 4) +
      " · Canal " + (data.activeTray % 4 + 1);
    const basic = (label, key, unit = "") => [label, fmt(data[key], unit), updated[key]];
    for (const [label, value, at] of [
      ["Conexão", !stale(result.connectionAt) && result.connection ? (result.connection === "online" ? "Online" : "Offline") : null, result.connectionAt],
      ["Estado da impressão", printStates[data.state] || data.state, updated.state],
      ["Peça", printing ? data.job || data.file : null, data.job ? updated.job : updated.file],
      basic("Progresso", "progress", " %"),
      ["Tempo decorrido desde o início", printing && data.startedAt && !stale(updated.state)
        ? duration((now - data.startedAt) / 60000) : null, updated.startedAt],
      ["Tempo restante informado", data.remainingMinutes == null ? null : duration(data.remainingMinutes), updated.remainingMinutes],
      ["Previsão de término", result.eta && !stale(age("state", "remainingMinutes")) ? formatTime(result.eta) : null, age("state", "remainingMinutes")],
      basic("Camada atual", "layer"), basic("Total de camadas", "totalLayers"),
      basic("Bico", "nozzleC", " °C"), basic("Alvo do bico", "nozzleTargetC", " °C"),
      basic("Mesa", "bedC", " °C"), basic("Alvo da mesa", "bedTargetC", " °C"),
      basic("Câmara", "chamberC", " °C"),
      ["Modo de velocidade", speedModes[data.speedLevel] || fmt(data.speedLevel, ""), updated.speedLevel],
      basic("Velocidade relativa", "speedPercent", " %"),
      ...[["Peça", "partFan"], ["Hotend", "hotendFan"], ["Auxiliar", "auxFan"], ["Câmara", "chamberFan"]]
        .map(([label, key]) => ["Ventilador · " + label, fan(data[key]), updated[key]]),
      ["Erro de impressão", data.printError == null ? null : data.printError === 0 ? "Nenhum informado"
        : "0x" + data.printError.toString(16).toUpperCase(), updated.printError],
      ["Alertas HMS", data.alerts?.length ? data.alerts.join(", ") : data.alerts ? "Nenhum informado" : null, updated.alerts],
      ["Filamento ativo", activeTray, updated.activeTray]
    ]) {
      const term = document.createElement("dt"), description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value == null ? "—" : value + suffix(at, value);
      metrics.append(term, description);
    }

    const channels = byId("channels");
    channels.replaceChildren();
    const units = [...new Set(Object.keys(channelRecords).map(key => key.split(":")[0]))];
    if (!units.some(id => id !== "external")) units.unshift(null);
    for (const id of units) {
      const count = id === "external" ? 1 : 4;
      for (let slot = 0; slot < count; slot++) {
        const item = document.createElement("li");
        const color = channelRecords[id + ":" + slot + ":color"];
        const material = channelRecords[id + ":" + slot + ":material"];
        const selected = id != null && (id === "external" ? data.activeTray === 254
          : data.activeTray < 254 && data.activeTray === Number(id) * 4 + slot);
        const name = id === "external" ? "Bobina externa" : (id == null ? "" : "Unidade " + id + " · ") + "Canal " + (slot + 1);
        item.append(name + (selected ? " · ativo" + suffix(updated.activeTray, true) : "") + " — ");
        if (color?.value) {
          const swatch = document.createElement("span");
          swatch.className = "swatch";
          swatch.style.backgroundColor = color.value;
          item.append(swatch, color.value + suffix(color.at, color.value) + " · ");
        } else {
          item.append("Cor indisponível · ");
        }
        item.append(material?.value ? material.value + suffix(material.at, material.value) : "Material indisponível");
        channels.append(item);
      }
    }

    const estimates = entries => Object.entries(entries || {}).map(([color, grams]) =>
      color + " · " + grams.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " g").join(", ");
    const currentEstimate = estimates(result.estimated);
    byId("estimated").textContent = currentEstimate
      ? currentEstimate + suffix(result.cloudUpdatedAt, true) : "Indisponível para esta impressão";
    const history = byId("history");
    history.replaceChildren();
    for (const entry of result.history || []) {
      const item = document.createElement("li");
      item.textContent = (entry.job || "Peça sem nome informado") + " · " +
        (entry.result === "completed" ? "Concluída" : "Interrompida") +
        (entry.endedAt ? " · " + formatTime(entry.endedAt) + " · Bambu Cloud"
          : " · observada em " + formatTime(entry.observedAt));
      const estimate = estimates(entry.estimated);
      if (estimate) item.append(" · estimativa " + estimate);
      history.append(item);
    }
    if (!history.children.length) {
      const item = document.createElement("li");
      item.textContent = "Nenhum encerramento observado.";
      history.append(item);
    }
  }
  function refresh() {
    return run(async () => {
      const result = await call("telemetry", { device: Number(device.value) });
      render(result);
      if (result.status === "auth_refused") byId("auto").checked = false;
      const stage = mqttStages[result.stage];
      const brokerCode = Number.isInteger(result.brokerCode) ? " · código MQTT " + result.brokerCode : "";
      status.textContent = result.status === "received" ? "Relatório MQTT recebido."
        : (states[result.status] || "Resposta de telemetria inesperada.") +
          (stage ? " (" + stage + brokerCode + ")" : "");
    });
  }
  byId("send").onclick = () => {
    if (email.reportValidity()) run(async () => {
      status.textContent = (await call("test", { email: email.value })).message;
    });
  };
  byId("auth").onsubmit = event => {
    event.preventDefault();
    run(async () => {
      try {
        const result = await call("test", { email: email.value, code: code.value, save: true });
        showDevices(result.devices);
        status.textContent = result.message;
      } finally {
        code.value = "";
      }
    });
  };
  byId("resume").onclick = () => run(async () => {
    const result = await call("session");
    showDevices(result.devices);
    status.textContent = "Sessão válida até " + new Date(result.expiresAt).toLocaleString("pt-BR") + ".";
  });
  byId("logout").onclick = () => run(async () => {
    status.textContent = (await call("logout")).message;
    showDevices([]);
    byId("auto").checked = false;
    key.value = "";
  });
  byId("refresh").onclick = refresh;
  device.onchange = () => { render({}); refresh(); };
  setInterval(() => { if (!document.hidden && !monitor.hidden && !busy) render(lastView); }, 15000);
  setInterval(() => {
    if (!document.hidden && !monitor.hidden && byId("auto").checked) refresh();
  }, 30000);
</script>
</html>`;
