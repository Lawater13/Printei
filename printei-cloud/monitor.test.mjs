import assert from "node:assert/strict";
import test from "node:test";
import { monitorView, normalizeReport, normalizeTasks, staleAfterMs, updateMonitor } from "./monitor.js";

const time = 1_800_000_000_000;
const sample = (report, delay = 0, retained = false) => normalizeReport(report, time + delay, retained);

test("mantém amostras e datas independentes, inclusive nos canais parciais", () => {
  const initial = sample({
    gcode_state: "RUNNING", task_id: "101", gcode_start_time: String(time / 1000 - 180),
    subtask_name: "Peça", mc_percent: 42, mc_remaining_time: 8, layer_num: 5, total_layer_num: 12,
    nozzle_temper: 218.5, nozzle_target_temper: 220, bed_temper: 58, bed_target_temper: 60,
    spd_lvl: 2, spd_mag: 100, cooling_fan_speed: "8", heatbreak_fan_speed: "0",
    print_error: 0, hms: [{ attr: 196608, code: 65537 }],
    ams: { tray_now: "2", ams: [{ id: "0", tray: [{ id: "2", tray_type: "PLA", tray_color: "FF4400FF" }] }] }
  });
  let snapshot = updateMonitor(null, [initial]);
  snapshot = updateMonitor(snapshot, [sample({
    nozzle_temper: 219.25, ams: { ams: [{ id: "0", tray: [{ id: "2", tray_type: "PETG" }] }] },
    hms: [], cooling_fan_speed: "bad", mc_percent: 350
  }, 2000)]);
  const view = monitorView(snapshot, time + 3000);
  assert.equal(view.telemetry.nozzleC, 219.25);
  assert.equal(view.telemetry.startedAt, time - 180000);
  assert.equal(view.telemetry.progress, 42);
  assert.equal(view.telemetry.partFan, 8);
  assert.equal(view.telemetry.hotendFan, 0);
  assert.equal(view.telemetry.activeTray, 2);
  assert.deepEqual(view.telemetry.alerts, []);
  assert.equal(view.updated.progress, time);
  assert.equal(view.updated.nozzleC, time + 2000);
  assert.deepEqual(view.channels["0:2:color"], { value: "#FF4400", at: time });
  assert.deepEqual(view.channels["0:2:material"], { value: "PETG", at: time + 2000 });
  assert.equal(view.eta, time + 480000);
  assert.equal(view.connection, "online");
  assert.equal(monitorView(snapshot, time + 3000 + staleAfterMs).connection, null);
  assert.equal(monitorView(snapshot, time + 3000 + staleAfterMs).eta, null);
});

test("registra somente encerramentos observados e limpa métricas ao iniciar nova impressão", () => {
  const snapshot = updateMonitor(null, [
    sample({ gcode_state: "RUNNING", subtask_id: "1", subtask_name: "Primeira", mc_percent: 60 }),
    sample({ gcode_state: "FINISH" }, 1000),
    sample({ gcode_state: "FINISH" }, 2000),
    sample({ gcode_state: "PREPARE", subtask_id: "2", subtask_name: "Segunda" }, 3000),
    sample({ gcode_state: "FAILED" }, 4000)
  ]);
  assert.equal(snapshot.telemetry.progress, undefined);
  assert.deepEqual(snapshot.history.map(({ result, job }) => ({ result, job })), [
    { result: "interrupted", job: "Segunda" }, { result: "completed", job: "Primeira" }
  ]);
  updateMonitor(snapshot, [sample({ gcode_state: "RUNNING", subtask_name: "Terceira" }, 5000)]);
  updateMonitor(snapshot, [sample({ gcode_state: "IDLE" }, 6000)]);
  assert.equal(snapshot.history.length, 2);
});

test("relatório retido não comprova conexão e silêncio não indica offline", () => {
  const snapshot = updateMonitor(null, [sample({ gcode_state: "IDLE" }, 0, true)]);
  assert.equal(monitorView(snapshot, time).connection, null);
  assert.equal(snapshot.updated.state, null);
  assert.equal(snapshot.lastReportAt, undefined);
  updateMonitor(snapshot, [], { at: time + 1000, online: false });
  assert.equal(monitorView(snapshot, time + 1000).connection, "offline");
  updateMonitor(snapshot, [sample({ nozzle_temper: 25 }, 2000)]);
  updateMonitor(snapshot, [sample({ nozzle_temper: 12 }, 3000, true)]);
  assert.equal(monitorView(snapshot, time + 3000).connection, "online");
  assert.equal(snapshot.telemetry.nozzleC, 25);
});

test("usa histórico da conta e estimativa por cor apenas da impressora e tarefa correspondentes", () => {
  const tasks = normalizeTasks({ hits: [
    { id: 17, deviceId: "OTHER", status: 2 },
    { id: 42, deviceId: "TEST", title: "Peça", status: 2, endTime: new Date(time + 5000).toISOString(),
      amsDetailMapping: [
        { targetColor: "FF8800FF", weight: 11.25 },
        { targetColor: "FF8800FF", weight: 0.75 },
        { sourceColor: "FFFFFFFF", weight: 3 },
        { targetColor: "00000000", weight: 1 },
        { targetColor: "123456FF", weight: -1 }
      ] }
  ] }, "TEST");
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].estimated, { "#FF8800": 12, "#FFFFFF": 3 });
  const snapshot = updateMonitor(null, [sample({ gcode_state: "RUNNING", task_id: "42" })],
    null, { at: time, tasks });
  assert.deepEqual(monitorView(snapshot, time).estimated, tasks[0].estimated);
  updateMonitor(snapshot, [sample({ gcode_state: "FINISH" }, 5000)], null, { at: time + 5000, tasks: null });
  const view = monitorView(snapshot, time + 5000);
  assert.equal(view.estimated, null);
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0].endedAt, time + 5000);
  assert.equal(view.cloudUpdatedAt, time);
});
