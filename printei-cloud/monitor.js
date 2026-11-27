export const staleAfterMs = 120_000;

const fields = {
  gcode_state: "state", subtask_name: "job", gcode_file: "file", task_id: "taskId",
  subtask_id: "subtaskId", gcode_start_time: "startedAt", mc_percent: "progress",
  mc_remaining_time: "remainingMinutes", layer_num: "layer", total_layer_num: "totalLayers",
  nozzle_temper: "nozzleC", nozzle_target_temper: "nozzleTargetC",
  bed_temper: "bedC", bed_target_temper: "bedTargetC", chamber_temper: "chamberC",
  spd_lvl: "speedLevel", spd_mag: "speedPercent", print_error: "printError",
  cooling_fan_speed: "partFan", heatbreak_fan_speed: "hotendFan",
  big_fan1_speed: "auxFan", big_fan2_speed: "chamberFan"
};
const textFields = new Set(["state", "job", "file", "taskId", "subtaskId"]);
const jobFields = ["job", "file", "taskId", "subtaskId", "startedAt", "progress", "remainingMinutes", "layer", "totalLayers"];
const active = new Set(["RUNNING", "PAUSE", "PREPARE", "SLICING", "INIT"]);
const ended = { FINISH: "completed", FAILED: "interrupted", CANCELLED: "interrupted", CANCELED: "interrupted" };

function number(value) {
  if (typeof value === "string" && /^\d{1,13}$/.test(value)) value = Number(value);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeColor(value) {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex) || hex === "00000000") return null;
  return "#" + hex.slice(0, 6).toUpperCase();
}

function normalizeTray(tray) {
  const data = {};
  if (!tray || typeof tray !== "object" || Array.isArray(tray)) return data;
  if (Object.hasOwn(tray, "id") && Object.keys(tray).length === 1) return data;
  if (typeof tray.tray_type === "string") data.material = tray.tray_type.slice(0, 40) || null;
  const fallback = Array.isArray(tray.cols) && tray.cols.length === 1 ? normalizeColor(tray.cols[0]) : null;
  const color = normalizeColor(tray.tray_color) ?? fallback;
  if (color || typeof tray.tray_color === "string") data.color = color;
  return data;
}

export function normalizeReport(report, at, retained = false) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const data = {};
  for (const [input, output] of Object.entries(fields)) {
    const value = report[input];
    if (textFields.has(output)) {
      if (typeof value === "string") data[output] = value.trim().slice(0, 250);
      continue;
    }
    const metric = number(value);
    if (metric === undefined || (output === "progress" && metric > 100)) continue;
    if (output.endsWith("Fan") && (!Number.isInteger(metric) || metric > 15)) continue;
    if (output === "startedAt") {
      if (metric >= 1_500_000_000 && metric * 1000 <= at) data.startedAt = metric * 1000;
    } else {
      data[output] = metric;
    }
  }
  if (Array.isArray(report.hms)) {
    const alerts = report.hms.slice(0, 20).flatMap(item => {
      const attr = number(item?.attr), code = number(item?.code);
      return [attr, code].every(value => Number.isInteger(value) && value <= 0xffffffff)
        ? [attr.toString(16).padStart(8, "0") + "-" + code.toString(16).padStart(8, "0")] : [];
    });
    if (!report.hms.length || alerts.length) data.alerts = alerts;
  }
  const trayNow = number(report.ams?.tray_now);
  if (Number.isInteger(trayNow) && trayNow <= 255) data.activeTray = trayNow;
  const channels = {};
  if (Array.isArray(report.ams?.ams)) {
    if (!report.ams.ams.length) data.amsEmpty = true;
    for (const unit of report.ams.ams.slice(0, 16)) {
      const id = String(unit?.id ?? "");
      if (!/^\d{1,3}$/.test(id) || !Array.isArray(unit.tray)) continue;
      if (!unit.tray.length) data["unit:" + id] = null;
      for (const tray of unit.tray.slice(0, 4)) {
        const slot = String(tray?.id ?? "");
        if (!/^[0-3]$/.test(slot)) continue;
        for (const [field, value] of Object.entries(normalizeTray(tray))) {
          channels[id + ":" + slot + ":" + field] = value;
        }
      }
    }
  }
  // Studio treats vir_slot as authoritative when present. Preserve the single external
  // spool representation only when that array identifies an unambiguous tray.
  const external = Array.isArray(report.vir_slot)
    ? (report.vir_slot.length === 1 ? report.vir_slot[0] : null)
    : report.vt_tray;
  for (const [field, value] of Object.entries(normalizeTray(external))) {
    channels["external:0:" + field] = value;
  }
  return { at, retained, data, channels };
}

function identityChanged(values, data) {
  return ["taskId", "subtaskId", "startedAt"].some(key =>
    values[key] && values[key] !== "0" && data[key] && data[key] !== "0" && values[key] !== data[key]);
}

export function normalizeTasks(result, serial) {
  if (!Array.isArray(result.hits)) return null;
  return result.hits.slice(0, 30).flatMap(task => {
    if (task?.deviceId !== serial || !/^\d{1,20}$/.test(String(task.id ?? "")) ||
        (typeof task.id === "number" && !Number.isSafeInteger(task.id))) return [];
    const estimated = {};
    for (const entry of Array.isArray(task.amsDetailMapping) ? task.amsDetailMapping.slice(0, 32) : []) {
      const color = [entry?.targetColor, entry?.sourceColor].find(value =>
        typeof value === "string" && /^[0-9a-f]{8}$/i.test(value) && value !== "00000000");
      if (color && Number.isFinite(entry.weight) && entry.weight > 0) {
        const hex = "#" + color.slice(0, 6).toUpperCase();
        estimated[hex] = (estimated[hex] ?? 0) + entry.weight;
      }
    }
    return [{
      id: String(task.id),
      job: typeof task.title === "string" ? task.title.slice(0, 250) : null,
      result: task.status === 2 ? "completed" : task.status === 3 ? "interrupted" : null,
      endedAt: typeof task.endTime === "string" && Number.isFinite(Date.parse(task.endTime))
        ? Date.parse(task.endTime) : null,
      estimated
    }];
  });
}

export function updateMonitor(previous, samples, availability, cloud) {
  const snapshot = previous ?? { telemetry: {}, updated: {}, channels: {}, history: [] };
  const { telemetry, updated, channels, history } = snapshot;
  if (cloud && cloud.at >= (snapshot.cloudAttemptAt ?? 0)) {
    snapshot.cloudAttemptAt = cloud.at;
    if (cloud.tasks) {
      snapshot.cloudTasks = cloud.tasks;
      snapshot.cloudUpdatedAt = cloud.at;
    }
  }
  if (availability && availability.at >= (snapshot.availability?.at ?? 0)) snapshot.availability = availability;
  for (const { at, retained, data, channels: delta } of samples) {
    if (retained && snapshot.lastReportAt) {
      for (const [key, value] of Object.entries(delta)) {
        const unit = key.split(":")[0];
        if (value == null || Object.hasOwn(channels, key) || updated["unit:" + unit] != null ||
            (unit !== "external" && updated.amsEmpty != null)) continue;
        channels[key] = { value, at: null };
      }
      continue;
    }
    if (!retained) snapshot.lastReportAt = Math.max(snapshot.lastReportAt ?? 0, at);
    const inOrder = at >= (snapshot.lastSampleAt ?? 0);
    const nextState = data.state || telemetry.state;
    const wasActive = active.has(telemetry.state);
    if (inOrder && active.has(nextState) && (!wasActive || identityChanged(telemetry, data))) {
      for (const key of jobFields) {
        delete telemetry[key];
        updated[key] = at;
      }
    }
    if (inOrder && wasActive && Object.hasOwn(ended, data.state) && !identityChanged(telemetry, data) && !retained) {
      history.unshift({ result: ended[data.state], observedAt: at,
        ids: [data.taskId || telemetry.taskId, data.subtaskId || telemetry.subtaskId].filter(id => id && id !== "0"),
        job: data.job || telemetry.job || data.file || telemetry.file || null,
        startedAt: data.startedAt ?? telemetry.startedAt ?? null });
      history.length = Math.min(history.length, 30);
    }
    for (const [key, value] of Object.entries(data)) {
      if (at < (updated[key] ?? 0)) continue;
      if (key === "amsEmpty" || key.startsWith("unit:")) {
        const prefix = key.slice(5) + ":";
        for (const name of Object.keys(channels)) {
          if ((key === "amsEmpty" ? !name.startsWith("external:") : name.startsWith(prefix)) &&
              at >= channels[name].at) delete channels[name];
        }
      }
      telemetry[key] = value;
      updated[key] = retained ? null : at;
    }
    for (const [key, value] of Object.entries(delta)) {
      const unit = key.split(":")[0];
      if (unit !== "external" && at < Math.max(updated.amsEmpty ?? 0, updated["unit:" + unit] ?? 0)) continue;
      if (at >= (channels[key]?.at ?? 0)) channels[key] = { value, at: retained ? null : at };
    }
    snapshot.lastSampleAt = Math.max(snapshot.lastSampleAt ?? 0, at);
  }
  return snapshot;
}

export function monitorView(snapshot, now = Date.now()) {
  if (!snapshot) return {};
  const { telemetry, updated, channels, history, lastReportAt, availability } = snapshot;
  const live = date => date != null && now - date <= staleAfterMs;
  const useAvailability = typeof availability?.online === "boolean" && live(availability.at) && availability.at > (lastReportAt ?? 0);
  const connection = useAvailability
    ? availability.online ? "online" : "offline"
    : live(lastReportAt) ? "online" : null;
  const remainingAt = updated.remainingMinutes;
  const tasks = snapshot.cloudTasks || [];
  const cloudHistory = tasks.filter(task => task.result && task.endedAt);
  const cloudIds = new Set(cloudHistory.map(task => task.id));
  const recentHistory = [...cloudHistory, ...history.filter(entry => !entry.ids?.some(id => cloudIds.has(id)))]
    .sort((a, b) => (b.endedAt ?? b.observedAt) - (a.endedAt ?? a.observedAt)).slice(0, 30);
  const current = active.has(telemetry.state)
    ? tasks.find(task => (telemetry.taskId === task.id || telemetry.subtaskId === task.id) && task.id !== "0") : null;
  return {
    telemetry, updated, channels, history: recentHistory, lastReportAt, connection,
    estimated: current?.estimated ?? null, cloudUpdatedAt: snapshot.cloudUpdatedAt, connectionAt: useAvailability ? availability.at : lastReportAt,
    staleAfterMs,
    eta: telemetry.state === "RUNNING" && connection === "online" &&
      live(remainingAt) && live(updated.state) && remainingAt >= (telemetry.startedAt ?? 0)
      ? remainingAt + telemetry.remainingMinutes * 60_000 : null
  };
}
