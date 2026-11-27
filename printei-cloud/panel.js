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
    <p>Consumo em gramas por cor ainda sem confirmação.</p>
  </section>
</main>
<script>
  const byId = id => document.getElementById(id);
  const key = byId("key"), email = byId("email"), code = byId("code"), device = byId("device");
  const monitor = byId("monitor"), status = byId("status");
  let busy = false;
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
  function render(result) {
    const data = result.telemetry || {};
    byId("sample").textContent = result.receivedAt
      ? "Recebido às " + new Date(result.receivedAt).toLocaleTimeString("pt-BR") : "";
    const metrics = byId("metrics");
    metrics.replaceChildren();
    const job = ["IDLE", "FINISH", "FAILED"].includes(data.state) ? null : data.job || data.file;
    for (const [label, value, unit] of [
      ["Impressão", job, ""], ["Estado", data.state, ""], ["Progresso", data.progress, " %"],
      ["Tempo restante", data.remainingMinutes, " min"], ["Bico", data.nozzleC, " °C"],
      ["Mesa", data.bedC, " °C"], ["Câmara", data.chamberC, " °C"]
    ]) {
      const term = document.createElement("dt"), description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value == null ? "—" : value + unit;
      metrics.append(term, description);
    }
    const channels = byId("channels");
    channels.replaceChildren();
    for (const [id, slots] of Object.entries(data.units || {})) {
      for (const [slot, filament] of Object.entries(slots)) {
        const item = document.createElement("li");
        item.append("Unidade " + id + " · Canal " + (Number(slot) + 1) + " — ");
        if (filament.color) {
          const swatch = document.createElement("span");
          swatch.className = "swatch";
          swatch.style.backgroundColor = filament.color;
          item.append(swatch, filament.color + " · ");
        }
        item.append(filament.material || "Material não informado");
        channels.append(item);
      }
    }
    if (!channels.children.length) {
      const item = document.createElement("li");
      item.textContent = "Nenhum canal informado nesta consulta.";
      channels.append(item);
    }
  }
  function refresh() {
    return run(async () => {
      render({});
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
  device.onchange = refresh;
  setInterval(() => {
    if (!document.hidden && !monitor.hidden && byId("auto").checked) refresh();
  }, 30000);
</script>
</html>`;
