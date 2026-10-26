// =============================================================================
// SwarmControl — the command layer between the GCS console and the fleet.
//
// Owns:
//   · the five commanded formations (wedge / column / line / diamond / ring)
//     with tweened slots and rally/disperse scaling,
//   · commanded speed multiplier (slow / cruise / flank),
//   · formation hold / resume (path freezes, hulls keep station and ride waves),
//   · U-turn and return-to-base (RTL) course control,
//   · emergency stop (all-stop) and recovery,
//   · single-vessel autonomous navigation / return / station-keeping.
//
// The inherited Fleet keeps owning hull motion, wave riding and attitude; this
// module only writes its control inputs (slots, speedScale, timeScale,
// turnRate, boat._auto / boat._holdPos) every frame and answers command calls.
// =============================================================================
import * as THREE from 'three';
import { FORMATION } from '../config.js';
import { META } from '../gcs/meta.js';

const TWO_PI = Math.PI * 2;
const wrap = (a) => {
  while (a > Math.PI) a -= TWO_PI;
  while (a < -Math.PI) a += TWO_PI;
  return a;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = (d) => (d * Math.PI) / 180;

// --- commanded formation slots (lat = starboard, fwd = ahead, meters) --------
const DIAMOND_RING = [
  { lat: 0, fwd: -86 },
  { lat: 86, fwd: 0 },
  { lat: 0, fwd: 86 },
  { lat: -86, fwd: 0 },
  { lat: 0, fwd: -172 },
  { lat: 172, fwd: 0 },
  { lat: 0, fwd: 172 },
  { lat: -172, fwd: 0 },
  { lat: 86, fwd: 86 },
  { lat: 86, fwd: -86 },
  { lat: -86, fwd: 86 },
  { lat: -86, fwd: -86 },
  { lat: 0, fwd: -258 },
  { lat: 258, fwd: 0 },
  { lat: 0, fwd: 258 },
  { lat: -258, fwd: 0 },
];

const FORMATION_LAYOUT = {
  // flagship at the apex; escorts trail in a V on both sides
  wedge(k) {
    const rank = Math.floor(k / 2) + 1;
    const side = k % 2 === 0 ? -1 : 1;
    return { lat: side * rank * 56, fwd: -rank * 52 };
  },
  // single file astern, slight lateral stagger for a natural wake lane
  column(k) {
    return { lat: (k % 2 === 0 ? -1 : 1) * 11, fwd: -(k + 1) * 54 };
  },
  // line abreast, flagship in the middle of a symmetric short line
  line(k) {
    const rank = Math.floor(k / 2) + 1;
    const side = k % 2 === 0 ? -1 : 1;
    return { lat: side * rank * 56, fwd: 0 };
  },
  // concentric diamond lattice around the flagship
  diamond(k) {
    return DIAMOND_RING[k % DIAMOND_RING.length];
  },
  // close ring escort around the flagship
  ring(k) {
    const a = (k / 16) * TWO_PI;
    return { lat: Math.cos(a) * 168, fwd: Math.sin(a) * 168 };
  },
};

export function createSwarmControl({ fleet, boats, meta = META }) {
  const byId = new Map(boats.map((b) => [b.id, b]));
  const roster = fleet.boats;
  const flags = roster[0];
  const escorts = roster.slice(1);

  const state = {
    formationKey: 'wedge',
    slotScale: 1,
    speedTarget: 1,
    speedCur: 1,
    timeTarget: 1,
    timeCur: 1,
    mode: 'cruise', // cruise | hold | uturn | rtl | estop
    estop: false,
    uturn: null,
    rtl: null,
    slots: new Map(), // id -> {lat, fwd} tweened
    slotTargets: new Map(), // id -> {lat, fwd}
    autoKinds: new Map(), // id -> 'goto' | 'rtl'
    lastCommand: null,
    history: [],
  };

  // --- slots -----------------------------------------------------------------
  function layoutFor(key, scale = 1) {
    const layout = new Map();
    layout.set(flags.id, { lat: 0, fwd: 0 });
    const fn = FORMATION_LAYOUT[key] || FORMATION_LAYOUT.wedge;
    escorts.forEach((b, i) => {
      const { lat, fwd } = fn(i);
      layout.set(b.id, { lat: lat * scale, fwd: fwd * scale });
    });
    return layout;
  }

  function retargetSlots() {
    state.slotTargets = layoutFor(state.formationKey, state.slotScale);
  }

  // Boot directly in the commanded wedge (the console opens in formation).
  state.slotTargets = layoutFor('wedge', 1);
  for (const b of roster) {
    const t = state.slotTargets.get(b.id) || { lat: 0, fwd: 0 };
    state.slots.set(b.id, { lat: t.lat, fwd: t.fwd });
    b.slot = { lat: t.lat, fwd: t.fwd };
  }

  const vmeta = (id) => meta.FLEET_BY_ID.get(id);

  function setBoatMode(id, kind) {
    const b = byId.get(id);
    if (!b) return;
    if (kind) state.autoKinds.set(id, kind);
    else state.autoKinds.delete(id);
  }

  function clearAuto(b) {
    b._auto = null;
    state.autoKinds.delete(b.id);
  }

  // --- command surface -------------------------------------------------------
  function command(cmd) {
    if (!cmd || typeof cmd.type !== 'string') {
      return { ok: false, text: '非法指令' };
    }
    const refuse = (text) => ({ ok: false, text });
    if (state.estop && cmd.type !== 'fleet.recover') {
      return refuse('紧急停止状态下仅可执行“解除急停”');
    }

    switch (cmd.type) {
      case 'formation.set': {
        const f = meta.FORMATION_BY_KEY.get(cmd.formation);
        if (!f) return refuse(`未知编队队形：${cmd.formation}`);
        state.formationKey = f.key;
        retargetSlots();
        return { ok: true, text: `编队队形 → ${f.name}`, detail: { formation: f.key } };
      }

      case 'formation.scale': {
        const scale = Number(cmd.scale);
        if (!Number.isFinite(scale) || scale < 0.2 || scale > 3) return refuse('编队尺度超出允许范围');
        state.slotScale = scale;
        retargetSlots();
        return {
          ok: true,
          text: scale < 1 ? '编队集结（收缩阵位）' : '编队分散（扩展阵位）',
          detail: { scale },
        };
      }

      case 'fleet.speed': {
        const scale = Number(cmd.scale);
        if (!Number.isFinite(scale) || scale < 0.2 || scale > 2.4) return refuse('航速指令超出允许范围');
        state.speedTarget = scale;
        if (state.mode === 'hold') state.timeTarget = 1;
        if (state.mode === 'estop') return refuse('紧急停止状态下禁止变更航速');
        return {
          ok: true,
          text: `航速 → ${scale >= 1.6 ? '全速' : scale <= 0.6 ? '微速' : '巡航'}`,
          detail: { scale },
        };
      }

      case 'fleet.hold': {
        if (state.mode === 'estop') return refuse('紧急停止状态下不可执行编队保持');
        state.mode = 'hold';
        state.timeTarget = 0;
        state.rtl = null;
        state.uturn = null;
        fleet.turnRate = FORMATION.turnRate;
        return { ok: true, text: '编队保持（航迹冻结，原地随浪保持阵位）' };
      }

      case 'fleet.resume': {
        if (state.mode === 'estop') return refuse('请先解除急停');
        state.mode = 'cruise';
        state.timeTarget = 1;
        state.speedTarget = 1;
        fleet.turnRate = FORMATION.turnRate;
        return { ok: true, text: '编队恢复巡航' };
      }

      case 'fleet.uturn': {
        if (state.uturn) return refuse('调头指令正在执行');
        state.mode = 'uturn';
        state.uturn = { acc: 0, dir: 1 };
        state.timeTarget = 1;
        state.rtl = null;
        return { ok: true, text: '编队调头 180°' };
      }

      case 'fleet.rtl': {
        if (state.rtl) return refuse('返航指令正在执行');
        state.mode = 'rtl';
        state.uturn = null;
        state.rtl = { arrived: false };
        state.timeTarget = 1;
        state.speedTarget = 1.7;
        return { ok: true, text: '集群返航基地（试验基地码头）' };
      }

      case 'fleet.cancelRtl': {
        if (!state.rtl) return refuse('当前未处于返航状态');
        state.rtl = null;
        state.mode = 'cruise';
        state.timeTarget = 1;
        state.speedTarget = 1;
        fleet.turnRate = FORMATION.turnRate;
        return { ok: true, text: '取消返航，恢复编队巡航' };
      }

      case 'fleet.estop': {
        state.estop = true;
        state.mode = 'estop';
        state.timeTarget = 0;
        state.speedTarget = 0.05;
        state.rtl = null;
        state.uturn = null;
        fleet.turnRate = 0;
        for (const b of roster) {
          b._auto = null;
          b._holdPos = true;
        }
        state.autoKinds.clear();
        return { ok: true, text: '紧急停止：全部无人艇立即停船' };
      }

      case 'fleet.recover': {
        if (!state.estop) return refuse('当前未处于紧急停止状态');
        state.estop = false;
        state.mode = 'cruise';
        state.timeTarget = 1;
        state.speedTarget = 1;
        for (const b of roster) b._holdPos = false;
        fleet.turnRate = FORMATION.turnRate;
        return { ok: true, text: '解除急停，恢复编队队形与巡航' };
      }

      case 'vessel.goto': {
        const b = byId.get(cmd.id);
        if (!b) return refuse(`未知无人艇：${cmd.id}`);
        const x = Number(cmd.x);
        const z = Number(cmd.z);
        if (!Number.isFinite(x) || !Number.isFinite(z)) return refuse('航点坐标非法');
        b._holdPos = false;
        b._auto = { target: new THREE.Vector3(x, 0, z), speed: 6.6, arrive: 8, kind: 'goto' };
        setBoatMode(b.id, 'goto');
        const vm = vmeta(b.id);
        return {
          ok: true,
          text: `单艇定点导航 → ${vm ? vm.callSign : b.id}`,
          detail: { id: b.id, x, z },
        };
      }

      case 'vessel.rtl': {
        const b = byId.get(cmd.id);
        if (!b) return refuse(`未知无人艇：${cmd.id}`);
        b._holdPos = false;
        b._auto = {
          target: new THREE.Vector3(meta.HOME_BASE.x, 0, meta.HOME_BASE.z),
          speed: 6.8,
          arrive: 12,
          kind: 'rtl',
        };
        setBoatMode(b.id, 'rtl');
        const vm = vmeta(b.id);
        return { ok: true, text: `单艇返航基地 → ${vm ? vm.callSign : b.id}` };
      }

      case 'vessel.hold': {
        const b = byId.get(cmd.id);
        if (!b) return refuse(`未知无人艇：${cmd.id}`);
        clearAuto(b);
        b._holdPos = true;
        const vm = vmeta(b.id);
        return { ok: true, text: `单艇保持待机 → ${vm ? vm.callSign : b.id}` };
      }

      case 'vessel.resume': {
        const b = byId.get(cmd.id);
        if (!b) return refuse(`未知无人艇：${cmd.id}`);
        clearAuto(b);
        b._holdPos = false;
        const vm = vmeta(b.id);
        return { ok: true, text: `单艇归队 → ${vm ? vm.callSign : b.id}` };
      }

      case 'vessel.payload': {
        const b = byId.get(cmd.id);
        if (!b) return refuse(`未知无人艇：${cmd.id}`);
        const sensor = meta.SENSOR_CATALOG[cmd.sensor];
        if (!sensor) return refuse(`未知载荷：${cmd.sensor}`);
        const vm = vmeta(b.id);
        return {
          ok: true,
          text: `载荷 ${sensor.label} → ${cmd.on ? '开启' : '关闭'}（${vm ? vm.callSign : b.id}）`,
          detail: { id: b.id, sensor: cmd.sensor, on: !!cmd.on },
        };
      }

      default:
        return refuse(`未知指令类型：${cmd.type}`);
    }
  }

  // --- per-frame update ------------------------------------------------------
  function update(dt) {
    dt = Math.min(Math.max(dt, 0), 0.08);

    // smooth commanded speed / time scale
    const k = 1 - Math.exp(-dt / 0.9);
    state.speedCur += (state.speedTarget - state.speedCur) * k;
    state.timeCur += (state.timeTarget - state.timeCur) * k;
    if (state.timeTarget === 0 && state.timeCur < 0.01) state.timeCur = 0;
    fleet.speedScale = state.speedCur;
    fleet.timeScale = state.timeCur;

    // tween formation slots
    const slotK = 1 - Math.exp(-dt / 2.6);
    for (const b of roster) {
      const target = state.slotTargets.get(b.id) || { lat: 0, fwd: 0 };
      let cur = state.slots.get(b.id);
      if (!cur) {
        cur = { lat: target.lat, fwd: target.fwd };
        state.slots.set(b.id, cur);
      }
      cur.lat += (target.lat - cur.lat) * slotK;
      cur.fwd += (target.fwd - cur.fwd) * slotK;
      b.slot = cur;
    }

    // U-turn: hold a constant turn rate until 180 degrees of course change
    if (state.mode === 'uturn' && state.uturn) {
      fleet.turnRate = state.uturn.dir * 0.05;
      state.uturn.acc += 0.05 * dt * Math.max(state.timeCur, 0.05);
      if (state.uturn.acc >= Math.PI - 0.02) {
        fleet.turnRate = FORMATION.turnRate;
        state.uturn = null;
        state.mode = 'cruise';
      }
    }

    // return to base: steer the formation course towards the home base
    if (state.mode === 'rtl' && state.rtl && !state.rtl.arrived) {
      const dx = meta.HOME_BASE.x - fleet.center.x;
      const dz = meta.HOME_BASE.z - fleet.center.z;
      const distance = Math.hypot(dx, dz);
      state.rtl.distanceM = distance;
      if (distance < 140) {
        state.rtl.arrived = true;
        state.mode = 'hold';
        state.timeTarget = 0;
        state.speedTarget = 0.05;
        fleet.turnRate = 0;
      } else {
        const desiredHeadingRad = Math.atan2(dx, -dz); // compass bearing -> radians
        const desiredYaw = Math.PI / 2 - desiredHeadingRad;
        const err = wrap(desiredYaw - fleet.pathYaw);
        fleet.turnRate = clamp(err * 0.55, -0.05, 0.05);
        state.rtl.bearingDeg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
      }
    }

    // single-vessel arrival handling
    for (const b of roster) {
      if (!b._auto) continue;
      const target = b._auto.target;
      const dist = Math.hypot(target.x - b._rt.pos.x, target.z - b._rt.pos.z);
      const arrive = b._auto.arrive || 8;
      if (dist <= arrive) {
        const kind = b._auto.kind;
        clearAuto(b);
        b._holdPos = true;
        if (kind === 'goto' || kind === 'rtl') {
          // arrive on station: keep the hull where it is until recalled
          b._holdPos = true;
        }
      }
    }
  }

  // --- readback for the simulation / UI -------------------------------------
  function stationError(b) {
    if (b._auto || b._holdPos) return 0;
    const slot = state.slots.get(b.id) || { lat: 0, fwd: 0 };
    const ex = fleet.pathPos.x + fleet.right.x * slot.lat + fleet.forward.x * slot.fwd;
    const ez = fleet.pathPos.z + fleet.right.z * slot.lat + fleet.forward.z * slot.fwd;
    return Math.hypot(ex - b._rt.pos.x, ez - b._rt.pos.z);
  }

  function getState() {
    const vessels = roster.map((b) => {
      const vm = vmeta(b.id);
      const auto = b._auto;
      let mode = 'formation';
      if (auto) mode = auto.kind === 'rtl' ? 'rtl' : 'auto';
      else if (b._holdPos) mode = 'hold';
      else if (state.estop) mode = 'hold';
      return {
        id: b.id,
        type: b.type,
        callSign: vm ? vm.callSign : b.id,
        x: b._rt.pos.x,
        z: b._rt.pos.z,
        yawRad: b._rt.yaw,
        headingDeg: ((90 - THREE.MathUtils.radToDeg(b._rt.yaw)) % 360 + 360) % 360,
        pitchRad: b._rt.pitch,
        rollRad: b._rt.roll,
        heaveM: b._rt.heave,
        mode,
        stationErrorM: stationError(b),
        waypoint: auto ? { x: auto.target.x, z: auto.target.z, kind: auto.kind } : b.waypoint || null,
      };
    });

    const f = meta.FORMATION_BY_KEY.get(state.formationKey);
    return {
      simTime: fleet.time,
      fleet: {
        centerX: fleet.center.x,
        centerZ: fleet.center.z,
        headingDeg: fleet.headingDeg,
        yawRad: fleet.pathYaw,
        speedKn: fleet.speedKn,
        speedScale: state.speedCur,
        mode: state.mode,
        formationKey: state.formationKey,
        formationText: f ? f.name : state.formationKey,
        formationEn: f ? f.en : '',
        rtlDistanceM: state.rtl ? state.rtl.distanceM ?? null : null,
        rtlBearingDeg: state.rtl ? state.rtl.bearingDeg ?? null : null,
        estopActive: state.estop,
        holdActive: state.mode === 'hold',
      },
      vessels,
    };
  }

  return { command, update, getState, state };
}
