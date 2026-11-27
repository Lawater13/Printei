import assert from "node:assert/strict";
import test from "node:test";
import { readTelemetry } from "./mqtt.js";

const serial = "TEST123";
const topic = "device/" + serial + "/report";
const encoder = new TextEncoder();
const session = { username: "u_123", token: "fake-token" };

function report(print, source = topic) {
  const name = encoder.encode(source);
  const payload = encoder.encode(JSON.stringify({ print }));
  const length = 2 + name.length + payload.length;
  const remaining = length < 128 ? [length] : [(length % 128) | 128, Math.floor(length / 128)];
  return [0x30, ...remaining, 0, name.length, ...name, ...payload];
}

function broker(replies, { stayOpen = false } = {}) {
  const writes = [];
  let closed = false;
  let address;
  const connect = (destination, options) => {
    address = { destination, options };
    return {
      opened: Promise.resolve(),
      closed: Promise.resolve(),
      readable: new ReadableStream({
        start(controller) {
          for (const reply of replies) controller.enqueue(Uint8Array.from(reply));
          if (!stayOpen) controller.close();
        }
      }),
      writable: new WritableStream({ write: frame => writes.push(frame) }),
      async close() { closed = true; }
    };
  };
  return { connect, writes, isClosed: () => closed, address: () => address };
}

test("assina somente report e combina pacotes fragmentados sem publicar comandos", async () => {
  const state = report({
    gcode_state: "RUNNING", subtask_name: "Peça", mc_percent: 0,
    mc_remaining_time: 12, nozzle_temper: 220
  });
  const ams = report({ bed_temper: 60, ams: { ams: [{ id: "0", tray: [
    { id: "0", tray_type: "PLA", tray_color: "123456FF" },
    { id: "1", tray_type: "PETG", tray_color: "FFFFFFFF" },
    { id: "2", tray_type: "", tray_color: "00000000" },
    { id: "3" }
  ] }] } });
  const mock = broker([[0x20], [2, 0, 0], [
    0x90, 3, 0, 1, 0, ...report({ mc_percent: 99 }, "device/OTHER/report"), ...state.slice(0, 2)
  ], [...state.slice(2), ...ams]]);
  const result = await readTelemetry(mock.connect, session, serial);
  assert.equal(result.status, "received");
  assert.ok(Number.isFinite(Date.parse(result.receivedAt)));
  assert.deepEqual(result.telemetry, {
    state: "RUNNING", job: "Peça", progress: 0, remainingMinutes: 12, nozzleC: 220, bedC: 60,
    units: { 0: {
      0: { material: "PLA", color: "#123456" }, 1: { material: "PETG", color: "#FFFFFF" },
      2: { material: null, color: null }, 3: { material: null, color: null }
    } }
  });
  assert.deepEqual(mock.address(), {
    destination: { hostname: "us.mqtt.bambulab.com", port: 8883 }, options: { secureTransport: "on" }
  });
  assert.deepEqual(mock.writes.map(frame => frame[0]), [0x10, 0x82]);
  assert.deepEqual([...mock.writes[1]], [0x82, topic.length + 5, 0, 1, 0, topic.length, ...encoder.encode(topic), 0]);
  assert.ok(mock.isClosed());
});

test("distingue inscrição aceita sem relatório, token recusado e inscrição recusada", async () => {
  const connack = [0x20, 2, 0, 0];
  for (const [replies, status] of [
    [[connack, [0x90, 3, 0, 1, 0]], "no_report"],
    [[[0x20, 2, 0, 5]], "auth_refused"],
    [[connack, [0x90, 3, 0, 1, 0x80]], "subscription_refused"],
    [[[0x30, 0xff, 0xff, 0xff, 0xff]], "network_error"]
  ]) {
    const mock = broker(replies, { stayOpen: true });
    assert.deepEqual(await readTelemetry(mock.connect, session, serial, 25), { status });
    assert.ok(mock.isClosed());
  }
});
