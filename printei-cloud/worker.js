import { connect } from "cloudflare:sockets";
import { readTelemetry } from "./mqtt.js";
import { tokenClaims } from "./session.js";
import { monitorView, normalizeTasks, staleAfterMs } from "./monitor.js";
import { panel } from "./panel.js";

export { BambuSession } from "./session.js";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const api = "https://api.bambulab.com";
const encoder = new TextEncoder();
const json = (body, status = 200) => Response.json(body, { status, headers });
const error = (message, status) => json({ error: message }, status);

async function authorized(key, secret) {
  if (typeof key !== "string" || key.length > 1024) return false;
  const digest = value => crypto.subtle.digest("SHA-256", encoder.encode(value));
  const [provided, expected] = await Promise.all([digest(key), digest(secret)]);
  return crypto.subtle.timingSafeEqual(provided, expected);
}

class BambuError extends Error {
  constructor(message, stage, category, status = 502, details = {}) {
    super(message);
    this.status = status;
    this.diagnostic = { stage, category, ...details };
  }
}

async function bambu(stage, path, options = {}) {
  let response;
  try {
    response = await fetch(api + path, { ...options, redirect: "manual", signal: options.signal ?? AbortSignal.timeout(20000) });
    const upstreamStatus = response.status;
    const details = { upstreamStatus };
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (upstreamStatus >= 300 && upstreamStatus < 400) {
        throw new BambuError("A Bambu Cloud respondeu com um redirecionamento bloqueado.", stage, "redirect", 502, details);
      }
      if (upstreamStatus === 429) {
        throw new BambuError("A Bambu Cloud limitou as solicitações. Aguarde antes de tentar novamente.", stage, "rate_limit", 429, details);
      }
      if (upstreamStatus === 401 || upstreamStatus === 403) {
        throw new BambuError("A Bambu Cloud recusou o acesso nesta etapa.", stage, "access_denied", 502, details);
      }
      throw new BambuError("A Bambu Cloud retornou um erro HTTP.", stage, "http_error", 502, details);
    }
    const result = await response.json();
    if (result && typeof result === "object" && !Array.isArray(result)) return result;
    throw new SyntaxError("Expected a JSON object");
  } catch (cause) {
    if (cause instanceof BambuError) throw cause;
    const details = response ? { upstreamStatus: response.status } : {};
    if (cause?.name === "SyntaxError") {
      throw new BambuError("A Bambu Cloud retornou uma resposta em formato inesperado.", stage, "invalid_response", 502, details);
    }
    if (["TimeoutError", "AbortError"].includes(cause?.name)) {
      throw new BambuError("A Bambu Cloud demorou demais para responder.", stage, "timeout", 504, details);
    }
    const category = cause?.name === "TypeError" ? "network" : "runtime";
    throw new BambuError("Falha de comunicação com a Bambu Cloud.", stage, category, 502, details);
  }
}

function applicationError(message, stage, code, status) {
  const applicationCode = (typeof code === "number" || typeof code === "string") &&
    /^-?\d{1,9}$/.test(String(code)) ? Number(code) : undefined;
  return new BambuError(message, stage, "application_error", status, { applicationCode });
}

async function authenticate(body, env) {
  const email = String(body.email || "").trim();
  const code = String(body.code || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || (code && !/^\d{6}$/.test(code))) {
    return error("Confira o e-mail e o código de seis dígitos.", 400);
  }
  if (code && body.save && !/^[0-9a-f]{64}$/i.test(env.PRINTEI_SESSION_KEY ?? "")) {
    return error("Configure PRINTEI_SESSION_KEY nos segredos do Worker.", 503);
  }
  const endpoint = code ? "login" : "sendemail/code";
  const stage = code ? "verificacao" : "solicitacao";
  const result = await bambu(stage, "/v1/user-service/user/" + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(code ? { account: email, code } : { email, type: "codeLogin" })
  });
  if (!code) {
    if (result.code != null && ![0, 200, "0", "200"].includes(result.code)) {
      throw applicationError("A Bambu Cloud recusou o envio do código.", stage, result.code, 502);
    }
    return json({ authenticated: false, message: "Solicitação enviada. Confira seu e-mail." });
  }
  const token = result.accessToken;
  if (typeof token !== "string" || !token || token.length > 8192) {
    throw applicationError("A Bambu Cloud não retornou uma sessão válida. Confira o código.", stage, result.code, 401);
  }
  const options = { headers: { Authorization: "Bearer " + token } };
  const devices = await bambu("impressoras", "/v1/iot-service/api/user/bind", options);
  const list = devices.devices;
  const deviceLookup = Array.isArray(list);
  const validDevices = deviceLookup ? list.flatMap(device => {
    if (!device || !/^[A-Za-z0-9]{1,64}$/.test(device.dev_id ?? "")) return [];
    return [{
      serial: device.dev_id,
      name: String(device.name || device.dev_name || "Impressora").slice(0, 120),
      model: String(device.dev_model_name || device.model || "").slice(0, 40),
      online: typeof device.online === "boolean" ? device.online : null
    }];
  }) : [];
  const summary = validDevices.map(({ name, model, online }) => ({ name, model, online }));
  if (!body.save) return json({ authenticated: true, deviceLookup, devices: summary });
  if (!deviceLookup) {
    throw new BambuError("A Bambu Cloud retornou uma lista de impressoras em formato inesperado.", "impressoras", "invalid_response");
  }
  if (!validDevices.length) return error("Nenhuma impressora vinculada disponível para monitoramento.", 422);
  let username = tokenClaims(token)?.username;
  if (typeof username !== "string" || !/^u_\d+$/.test(username)) {
    const profile = await bambu("identificacao_mqtt", "/v1/design-user-service/my/preference", options);
    const uid = profile.uid;
    const numericUid = typeof uid === "string" || Number.isSafeInteger(uid);
    if (!numericUid || !/^\d+$/.test(String(uid))) {
      throw new BambuError("A Bambu Cloud não forneceu a identificação MQTT da conta.", "identificacao_mqtt", "invalid_response");
    }
    username = "u_" + uid;
  }
  await sessionStore(env).save({ token, username, devices: validDevices });
  return json({ authenticated: true, devices: summary, message: "Sessão salva." });
}

function sessionStore(env) {
  const namespace = env.BAMBU_SESSION;
  return namespace.get(namespace.idFromName("owner"));
}

async function privateRoute(request, env, path, url) {
  if (request.method !== "POST" || request.headers.get("Origin") !== url.origin) {
    return error("Requisição inválida.", 403);
  }
  if (!env.PRINTEI_ADMIN_KEY) return error("Configure PRINTEI_ADMIN_KEY nos segredos do Worker.", 503);
  const body = await request.json().catch(() => null);
  if (!await authorized(body?.key, env.PRINTEI_ADMIN_KEY)) return error("Chave de acesso inválida.", 403);
  if (path === "/bambu/test") return authenticate(body, env);
  const store = sessionStore(env);
  if (path === "/bambu/logout") {
    await store.clear();
    return json({ message: "Sessão removida do Printei Cloud." });
  }
  let session;
  try {
    session = await store.load();
  } catch {
    console.warn({ event: "bambu_session_read_failed" });
    return json({ error: "Falha ao abrir a sessão Bambu salva.", stage: "sessao", category: "storage" }, 502);
  }
  if (!session) return error("Sessão ausente ou expirada. Entre novamente com o código de e-mail.", 401);
  if (path === "/bambu/session") {
    return json({
      expiresAt: new Date(session.expiresAt).toISOString(),
      devices: session.devices.map(({ name, model }) => ({ name, model }))
    });
  }
  const device = Number.isInteger(body.device) ? session.devices[body.device] : null;
  if (!device) return error("Selecione uma impressora vinculada.", 400);
  let previous;
  try {
    previous = await store.monitor(session.username, device.serial);
  } catch {
    console.warn({ event: "bambu_monitor_storage_failed" });
    return json({ error: "Falha ao acessar o histórico da impressora.", stage: "monitoramento", category: "storage" }, 502);
  }
  const at = Date.now();
  const authOptions = { headers: { Authorization: "Bearer " + session.token } };
  const mqtt = readTelemetry(connect, session, device.serial);
  const cloud = at - (previous?.cloudAttemptAt ?? 0) >= staleAfterMs
    ? bambu("historico", "/v1/user-service/my/tasks?limit=30&deviceId=" + encodeURIComponent(device.serial),
        { ...authOptions, signal: AbortSignal.timeout(3000) })
      .then(raw => ({ at, tasks: normalizeTasks(raw, device.serial) }), () => ({ at, tasks: null }))
    : null;
  const [{ samples = [], ...result }, taskUpdate] = await Promise.all([mqtt, cloud]);
  if (result.status !== "received") {
    console.warn({ event: "bambu_telemetry", status: result.status, stage: result.stage,
      brokerCode: result.brokerCode });
  }
  try {
    let availability = null;
    if (!samples.some(sample => !sample.retained)) {
      const lastCheck = Math.max(previous?.lastReportAt ?? 0, previous?.availability?.at ?? 0);
      if (Date.now() - lastCheck > staleAfterMs) {
        const at = Date.now();
        try {
          const devices = await bambu("impressoras", "/v1/iot-service/api/user/bind", {
            ...authOptions,
            signal: AbortSignal.timeout(3000)
          });
          const online = Array.isArray(devices.devices)
            ? devices.devices.find(item => item?.dev_id === device.serial)?.online : undefined;
          availability = { at, online: typeof online === "boolean" ? online : null };
        } catch {
          availability = { at, online: null };
        }
      }
    }
    const snapshot = samples.length || availability || taskUpdate
      ? await store.monitor(session.username, device.serial, samples, availability, taskUpdate) : previous;
    return json({ ...result, ...monitorView(snapshot) });
  } catch {
    console.warn({ event: "bambu_monitor_storage_failed" });
    return json({ error: "Falha ao acessar o histórico da impressora.", stage: "monitoramento", category: "storage" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (["/bambu/test", "/bambu/session", "/bambu/telemetry", "/bambu/logout"].includes(path)) {
      try {
        return await privateRoute(request, env, path, url);
      } catch (cause) {
        if (cause instanceof BambuError) {
          return json({ error: cause.message, ...cause.diagnostic }, cause.status);
        }
        return error("Falha ao acessar o serviço. Confira a configuração e tente novamente.", 502);
      }
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers });
    if (path === "/health") return json({ service: "printei-cloud", stage: "mqtt-experimental" });
    if (path === "/diagnostic") {
      let socket, timer;
      try {
        socket = connect({ hostname: "us.mqtt.bambulab.com", port: 8883 }, { secureTransport: "on" });
        socket.closed.catch(() => {});
        await Promise.race([socket.opened, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("TLS timeout")), 5000);
        })]);
        return json({ tls: true, mqttAuthenticated: false, printerConnected: false });
      } catch {
        return json({ tls: false, mqttAuthenticated: false, printerConnected: false }, 503);
      } finally {
        clearTimeout(timer);
        socket?.close().catch(() => {});
      }
    }
    if (path !== "/") return new Response("Not found", { status: 404, headers });
    return new Response(panel, { headers: {
      ...headers,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer"
    } });
  }
};
