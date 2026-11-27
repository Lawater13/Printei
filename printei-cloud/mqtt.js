import { normalizeReport } from "./monitor.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const maxPacket = 256 * 1024;

function join(...parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function field(value) {
  const bytes = encoder.encode(value);
  if (bytes.length > 65535) throw new Error("MQTT field too large");
  return join([bytes.length >> 8, bytes.length & 255], bytes);
}

function packet(type, payload) {
  const size = [];
  let remaining = payload.length;
  do {
    const digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    size.push(digit | (remaining ? 128 : 0));
  } while (remaining);
  return join([type], size, payload);
}

function unpack(buffer) {
  let size = 0;
  for (let index = 1; index <= 4 && index < buffer.length; index++) {
    const digit = buffer[index];
    size += (digit & 127) * 128 ** (index - 1);
    if (size > maxPacket || (index === 4 && digit >= 128)) throw new Error("Invalid MQTT length");
    if (digit < 128) {
      const start = index + 1;
      const end = start + size;
      if (end <= buffer.length) return { type: buffer[0], body: buffer.subarray(start, end), end };
      break;
    }
  }
  return null;
}

function parseReport(body, topic) {
  if (body.length < 2) return null;
  const size = (body[0] << 8) | body[1];
  if (size + 2 >= body.length) return null;
  try {
    if (decoder.decode(body.subarray(2, size + 2)) !== topic) return null;
    return JSON.parse(decoder.decode(body.subarray(size + 2)))?.print;
  } catch {
    return null;
  }
}

export async function readTelemetry(connect, session, serial, windowMs = 8000) {
  const topic = "device/" + serial + "/report";
  const clientId = "printei" + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const login = packet(0x10, join(field("MQTT"), [4, 0xc2, 0, 20],
    field(clientId), field(session.username), field(session.token)));
  const subscribe = packet(0x82, join([0, 1], field(topic), [0]));
  let socket, timer;
  let phase = "tls";
  let failure;
  const samples = [];
  let expired = false;
  try {
    socket = connect({ hostname: "us.mqtt.bambulab.com", port: 8883 }, { secureTransport: "on" });
    socket.closed.catch(() => {});
    // One deadline covers TLS, writes, acknowledgements and report collection.
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, windowMs);
    });
    const listen = async () => {
      await socket.opened;
      if (expired) return;
      phase = "auth";
      const reader = socket.readable.getReader();
      const writer = socket.writable.getWriter();
      await writer.write(login);
      let buffer = new Uint8Array();
      while (!expired) {
        const { value, done } = await reader.read();
        if (done || expired) return;
        if (buffer.length + value.length > maxPacket + 5) throw new Error("MQTT buffer limit");
        buffer = join(buffer, value);
        let frame;
        while (!expired && (frame = unpack(buffer))) {
          buffer = buffer.subarray(frame.end);
          const { type, body } = frame;
          if (phase === "auth") {
            if (type !== 0x20 || body.length !== 2 || body[0] !== 0) throw new Error("Invalid CONNACK");
            if (body[1] !== 0) {
              failure = { status: [4, 5].includes(body[1]) ? "auth_refused" : "broker_refused",
                stage: phase, brokerCode: body[1] };
              return;
            }
            phase = "subscribe";
            await writer.write(subscribe);
          } else if (phase === "subscribe" && type === 0x90) {
            if (body.length !== 3 || body[0] !== 0 || body[1] !== 1 || body[2] !== 0) {
              failure = { status: "subscription_refused", stage: phase };
              return;
            }
            phase = "listening";
          } else if ((phase === "listening" || phase === "subscribe") && (type & 0xf6) === 0x30) {
            const sample = normalizeReport(parseReport(body, topic), Date.now(), Boolean(type & 1));
            if (sample && samples.length < 32) {
              samples.push(sample);
              if (samples.length >= 32 && phase === "listening") return;
            }
          }
        }
      }
    };
    await Promise.race([listen(), timeout]);
    if (failure) return failure;
    if (phase === "listening") {
      if (samples.length) return { status: "received", samples };
      return { status: expired ? "no_report" : "disconnected", stage: phase };
    }
    return { status: expired ? "timeout" : "disconnected", stage: phase };
  } catch {
    return { status: "network_error", stage: phase };
  } finally {
    clearTimeout(timer);
    // Closing the socket cancels pending stream I/O. workerd rejects releaseLock() while read() is pending.
    void socket?.close().catch(() => {});
  }
}
