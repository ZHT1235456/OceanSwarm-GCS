# OceanSwarm GCS — 无人艇集群上位机：架构与协作规范

> 版本：v2.0.0 · 状态：开发基线 · 本文件是全体开发成员的**唯一接口契约**。
> 交付物：在继承项目 OceanSwarm（Three.js 实时海洋 + 17 艇集群场景）之上，构建一套
> **无人艇集群地面指挥控制上位机（Ground Control Station）**：以现有 3D 海域为「态势视景」，
> 叠加集群编队控制、单艇遥测、二维战术图、任务规划、告警与事件流、指令台、指挥确认等完整
> 上位机作业能力。纯前端、完全离线、无外部资源依赖（字体只用系统字体栈）。

---

## 0. 产品定义与验收

**一句话**：这不是一个「带 HUD 的演示动画」，而是一台可以被指挥员真正操作的上位机——
点击任意艇能看到它的实时遥测；下达编队/航速/保持/调头/返航/急停指令会**真实改变 3D 场景中
集群的运动**，并经数据链延时后回执、写入事件流；二维战术图可以选中、规划、定点派遣；
告警会按规则产生、升级、恢复并可签收。

**验收清单（Definition of Done）**：

1. 1600×900 视口下无溢出、无遮挡、无横向滚动条；1920×1080 下同样完整。
2. 顶栏 / 左栏（任务+编队名册+编队控制）/ 中央态势视景（HUD + 二维战术图切换）/
   右栏（选中艇详情）/ 底栏（事件流 + 指令台）/ 覆盖层（开机、确认、帮助、Toast）全部就位。
3. 17 艘艇的名字、呼号、类别、状态与 3D 场景一一对应；选中联动（名册 ↔ 3D 锁定框 ↔ 详情 ↔ 战术图）。
4. 以下指令闭环可验证：编队队形（5 种）、航速、编队保持/恢复、调头、返航、急停（二次确认）、
   单艇定点导航（战术图点选）、单艇返航/待机、载荷开关。每条指令产生「下发 → 回执」事件。
5. 告警引擎至少覆盖：低电量、链路异常、阵位偏离、急停；告警可在事件流与状态区可见。
6. 控制台零报错（pageerror / console.error），首屏 ready ≤ 8 s（本机 dev，含 HDR）。
7. `npm run build` 通过；产物仍完全离线可运行。
8. `artifacts/gcs/` 下的截图脚本可复现全套界面截图；`docs/` 内附架构与设计文档；README 更新。

---

## 1. 继承关系与既有资产

现有项目（**不得改坏的资产**）：HDR 天空、海洋着色器、17 艇程序化模型、编队动力学、
尾迹/技术光效/海鸥、海岛/基地/母船/礁盘/航标。`src/main.js` 是既有装配入口。

本任务新增三层，全部为增量改造：

```
┌──────────────────────────────────────────────────────────────────────┐
│ UI 层（src/ui/*）       DOM + Canvas 2D 上位机界面（新增）            │
├──────────────────────────────────────────────────────────────────────┤
│ 仿真/数据层（src/sim/*）遥测模型、数据链、告警、事件流、指令总线（新增）│
├──────────────────────────────────────────────────────────────────────┤
│ 场景层（src/*，继承）   Three.js 海域视景 + Fleet 编队 + 新增控制器   │
│                          swarm-control（编队/航速/保持/调头/返航/急停/  │
│                          单艇导航） camera-director（镜头导演）        │
└──────────────────────────────────────────────────────────────────────┘
```

**硬约束**：

- 不引入任何 npm 依赖（不 `npm install`）。图表、仪表、地图全部 Canvas 2D / DOM / SVG 手写。
- 不访问网络资源（不加载在线字体/图标/图片）。图标一律内联 SVG（`src/ui/icons.js`）。
- 不改变现有场景的美术观感：海、天、船、尾迹的既有参数与着色器保持原样；UI 以叠加层形式存在。
- 现有 `window.__oceanSwarm` QA 钩子保持可用；新增 `window.__gcs` 钩子。
- 既有 `artifacts/` 下的 QA 脚本与基线截图不动。

---

## 2. 目录结构与文件所有权

> 协作规则：**只写自己 ownership 内的文件**。新增文件必须放在指定路径。
> 共享 CSS 变量/基础组件由 design owner 维护；模块私有 CSS 使用模块前缀，禁止写全局选择器
> （`html`/`body`/`*`/`.panel` 等），只允许 `.left-*` / `.detail-*` / `.dock-*` / `.topbar-*` /
> `.map-*` / `.hud-*` / `.ovl-*` 前缀 + 已发布的 `.gcs-*` 基础类。

```
index.html                              [Lead]      标题、启动骨架、字体栈
src/main.js                             [Lead]      场景装配 + GCS 集成
src/systems/formation.js                [Lead]      小幅扩展：可变航速/转角、阵位覆盖、单艇接管
src/systems/swarm-control.js            [Lead]      编队/航速/保持/调头/返航/急停/单艇导航
src/systems/camera-director.js          [Lead]      镜头导演（跟随编队 / 锁定单艇 / 自由）
src/objects/effects/selection.js        [Lead]      选中光环、航点光柱、航线（3D）
src/gcs/meta.js                         [Lead]      领域常量：任务/名册/分组/队形/载荷/经纬度原点
src/ui/index.js                         [Lead]      UI 根：模块装配、循环、window.__gcs、键盘
src/ui/context.js                       [Lead]      ctx：state/actions/bus/dialog/format
src/ui/shell.js                         [Lead]      DOM 骨架与宿主元素
src/ui/format.js                        [Lead]      数字/时间/经纬/单位格式化
src/ui/icons.js                         [Lead]      内联 SVG 图标库
src/ui/styles/layout.css                [Lead]      grid 布局、宿主、vignette、响应式
src/ui/styles/tokens.css                [Design]    设计变量（色板/字号/间距/动效）
src/ui/styles/base.css                  [Design]    基础组件：panel/按钮/chip/滚动条/表格/动画
src/ui/panels/*.js                      [各模块 owner]
src/ui/styles/{left,detail,topbar,dock,overlays,map,hud}.css   [各模块 owner]
src/sim/*.js                            [sim-engine] 遥测/数据链/告警/事件/指令总线
artifacts/gcs/capture.mjs               [Lead]      截图与交互回归脚本
docs/GCS-architecture.md                [Lead]      本文件
docs/GCS-design-system.md               [Lead→Design] 视觉规范
README.md                               [Lead]      最终更新
```

**面板模块文件与宿主**（模块只挂载到自己的宿主，不碰别的宿主）：

| 模块 | 文件 | 宿主 | owner |
|---|---|---|---|
| 覆盖层（开机/确认/帮助/Toast） | `src/ui/panels/overlays.js` | `#gcs-overlays` | ui-dock |
| 顶栏 | `src/ui/panels/topbar.js` | `#gcs-topbar` | ui-dock |
| 底栏（事件流+指令台） | `src/ui/panels/dock.js` | `#gcs-dock` | ui-dock |
| 左栏（任务+名册+编队控制） | `src/ui/panels/left.js` | `#gcs-left` | ui-left |
| 右栏（选中艇详情） | `src/ui/panels/detail.js` + `src/ui/charts.js` | `#gcs-right` | ui-detail |
| 中央 HUD | `src/ui/panels/hud.js` | `#gcs-hud` | ui-map |
| 二维战术图 | `src/ui/panels/map.js` | `#gcs-map` | ui-map |

---

## 3. 运行时数据流

```
Fleet.update(dt)                        既有编队运动（Lead 微调）
      │
SwarmControl.update(dt)                 阵位补间 / 速度 / 保持 / 调头 / 返航 / 单艇接管
      │
      ├──► sceneProvider  ──────────────► Sim.update(dt)   10Hz 遥测建模、1Hz 告警规则、
      │        (船位/艏向/姿态/模式)          指令总线（延时 220–650ms）
      │                                            │
      │                                    snapshot() 10Hz
      │                                            │
UI 根 frame(dt) ──► CameraDirector.update       └──► 各面板 module.update(snap) 10Hz
      │             SelectionFx / HUD 投影            module.frame(dt) 每帧（地图/罗经/HUD）
      └──► renderer.render
```

- 面板 **不直接读 three.js 对象**；位置/姿态类数据只从 snapshot 与 `ctx.getLiveVessels()` 取。
- 用户操作 → `ctx.actions.*` → `sim.dispatch(cmd)` →（延时）→ `swarm.command(cmd)` → 场景改变
  → 事件流新增「回执」。UI 不做乐观更新，但点击后 120ms 内按钮进入 pending 态。
- 三维拾取（点击海面上的艇）由 Lead 在 `main.js`/集成层完成，调用 `ctx.actions.selectVessel(id)`。

---

## 4. 模块契约

### 4.1 面板模块接口

每个 `src/ui/panels/x.js` 必须导出：

```js
export function createXxxPanel(ctx) {
  return {
    name: 'left',
    mount(host) {},          // 只调用一次；host 是元素，构建 DOM、绑定事件
    update(snap) {},         // 新快照（10Hz）时调用
    frame(dt, nowMs) {},     // 每帧调用，可选（Canvas/投影类需要）
    resize() {},             // 可选：窗口尺寸变化
    destroy() {},            // 可选
  };
}
```

`src/ui/index.js`（Lead）负责 import 全部模块、mount、驱动 update/frame、异常隔离
（单模块抛错只 console.error 一次并停用该模块，不得拖垮整个界面）。

### 4.2 ctx（`src/ui/context.js` 提供）

```js
ctx = {
  version: '2.0.0',
  meta,                    // = src/gcs/meta.js 的全部导出集合
  state,                   // UiState（只读约定：修改一律走 actions）
  actions,                 // 见 4.6
  dialog: {                // overlays 模块 mount 时注册实现
    confirm(opts) → Promise<boolean>,   // opts:{title, message, detail, confirmText, danger, holdMs}
    toast({severity, title, message, ttl}), 
    help(open = true),
    skipBoot(),
  },
  bus: { on(evt, fn) → unsubscribe, emit(evt, data) },  // 跨模块通知（select/view/camera/tool/filter）
  format,                  // = src/ui/format.js 导出
  getSnapshot(),           // 最近一次 Sim snapshot（可能为 undefined，首帧前）
  getLiveVessels(),        // 每帧最新 [{id,x,z,yawDeg,headingDeg,sogKn,lat,lon}]，供地图/HUD 平滑绘制
  getSceneState(),         // {fleet, vessels, mode, estop, rtlDistanceM...}（场景真值，供调试）
  dispatch(cmd),           // = sim.dispatch，返回 {accepted, ticket, error}
  scene3d: {
    focusVessel(id), focusFleet(), setCameraMode(mode), getCameraMode(),
    applyPreset(key), presets: [{key, name, en}],
    project(x, y, z) → {x, y, visible},   // 世界坐标 → 窗口 CSS 像素
    setSelection(id | null), setWaypoint(x, z, label | null),
    pause(), resume(), renderFrame(), isPaused(),
    stats(),               // {fps, drawCalls, triangles}
  },
  select, // 兼容快捷方式 = actions.selectVessel
}
```

`UiState`（Lead 初始化）：`{ selectedId: 'flagship', viewMode: '3d', cameraMode: 'fleet',
mapTool: 'select', mapFollow: true, mapLayers: {...}, logFilter: 'all', clean: false,
booted: false, acks: [] }`。模块可读 `ctx.state`，但修改必须通过 actions。

### 4.3 snapshot（Sim 输出，10Hz）

字段命名已冻结，Sim 必须逐字段提供；允许后续追加字段。详见 `src/ui/mock-sim.js`
（Lead 的临时桩实现，形状参考）与 `docs/GCS-design-system.md` 的文案约定。

```js
{
  seq, t, met, metText:'00:18:42', clockText:'14:32:07', dateText:'2026-10-26',
  utcText:'06:32:07Z', timezone:'UTC+8',
  fleet: {
    center:{x,z,lat,lon}, headingDeg, speedKn, speedScale, speedKnMax,
    mode:'cruise'|'hold'|'uturn'|'rtl'|'estop', modeText,
    formation:'wedge', formationText:'楔形', formationEn:'WEDGE',
    total, online, avgBatteryPct,
    alerts:{critical,warning,info,unread},
    link:{quality,latencyMs,lossPct,linksUp,linksTotal,bandwidthMbps,gnssSats,gnssFix,relayId},
    sea:{state,waveHeightM,windKn,windDirDeg,visibilityKm,waterTempC,currentKn,currentDirDeg,tideM},
    mission:{id,name,en,area,phaseIndex,phaseCount,phaseName,phaseEn,phaseProgress,
             overallProgress,waypointIndex,waypointTotal,waypointName,etaSec},
    rtl:{active,distanceM,bearingDeg} | null,
    estop:{active, sinceSec} | null,
  },
  vessels: [VesselSnapshot],   // 顺序 = meta.GROUPS 的展示顺序（17 条）
  events:[EventEntry],         // 最新在前，最多 120
  alarms:[AlarmEntry],         // 活动告警，severity critical 在前
  acks:[AckEntry],             // 最近指令回执，最新在前，最多 8
  system:{fps,drawCalls,triangles}
}

VesselSnapshot = {
  id, callSign:'USV-07', name:'侦察-3', type:'scout',
  typeName:'高速侦察艇', roleEn:'SCOUT', group:'scout', groupName:'侦察分队',
  x, z, lat, lon,
  headingDeg, cogDeg, sogKn, depthM,
  pitchDeg, rollDeg, heaveM,
  batteryPct, powerKw, voltageV, currentA, tempC, cpuPct,
  link:{rssiDbm,latencyMs,lossPct,type,quality},   // quality 0..1
  status:'normal'|'warning'|'critical'|'offline',
  mode:'formation'|'auto'|'hold'|'rtl'|'manual'|'offline', modeText,
  alarmCount, uptimeSec, distToFleetM,
  sensors:[{id,label,short,on,stateText}],
  waypoint:{x,z,lat,lon,distM,etaSec} | null,
}

EventEntry = { id, t, metText, clockText, severity:'info'|'success'|'warning'|'critical'|'command',
  category:'command'|'alarm'|'mission'|'link'|'system', sourceId|null, sourceLabel,
  text, detail?, ackMs? }
AlarmEntry = { id, severity:'warning'|'critical', vesselId|null, sourceLabel, title, detail,
  sinceMet, sinceClockText }
AckEntry   = { id, commandText, ok, text, latencyMs, clockText }
```

### 4.4 sceneProvider（Lead 提供，Sim 消费）

`src/sim/index.js` 的工厂签名（**Sim owner 实现，Lead 集成时装配**）：

```js
export function createSim({ scene, meta, options }) → {
  update(dt, nowMs),           // 每帧调用；内部 10Hz 建模、1Hz 告警
  dispatch(cmd, opts),         // {accepted:boolean, ticket?, error?}
  snapshot(),                  // 缓存快照
  commands,                    // 可选：命令目录（console 自动补全用）
  debug,                       // 可选
}
```

`scene`（Lead 在 `main.js` 构造，勿改接口）：

```js
{
  getSceneState() → {
    simTime, paused,
    fleet: { centerX, centerZ, headingDeg, yawRad, speedKn, speedScale, mode,
             formationKey, formationText, rtlDistanceM, estopActive },
    vessels: [{ id, type, x, z, yawRad, headingDeg, pitchRad, rollRad, heaveM,
                mode, waypoint }],   // mode: 'formation'|'auto'|'hold'|'rtl'|'manual'
  },
  execute(cmd) → { ok, text, detail },  // = swarm.command；Sim 延时后调用
  base: { x, z, lat, lon },             // 试验基地（返航点）
  origin: { lat0, lon0 },
}
```

### 4.5 指令协议（Sim 校验、Swarm 执行）

```js
{ type:'formation.set',    formation:'wedge'|'column'|'line'|'diamond'|'ring' }
{ type:'formation.scale',  scale:0.5|1|1.8 }        // 集结/分散
{ type:'fleet.speed',      scale:0.45|1|1.9 }        // 微速/巡航/全速
{ type:'fleet.hold' }      { type:'fleet.resume' }
{ type:'fleet.uturn' }     { type:'fleet.rtl' }      { type:'fleet.cancelRtl' }
{ type:'fleet.estop' }     { type:'fleet.recover' }
{ type:'vessel.goto', id, x, z }
{ type:'vessel.rtl', id }  { type:'vessel.hold', id }  { type:'vessel.resume', id }
{ type:'vessel.payload', id, sensor:'radar'|'eoir'|'sonar'|'ais'|'mesh', on:boolean }
```

执行语义（SwarmControl 必须实现，见 §6）：数据链延时 220–650ms 后执行；执行结果
`{ok, text, detail}` 由 Sim 写入 `acks` 与 `events`。非法/过期指令返回 `ok:false`（如急停中
除 recover 外全部拒绝）。UI 不直接改场景。

### 4.6 actions（ctx.actions，Lead 实现）

```js
selectVessel(id|null)            // 选中并联动 3D 锁定框
focusSelected() / focusVessel(id) / focusFleet() / setCameraMode(mode)
applyCameraPreset(key)           // default|low|fleet|top|base|reef|bow|side
setViewMode('3d'|'map')          // 中央视区切换（body[data-view]）
toggleClean()                    // 隐藏/显示除视景外全部 UI（H 键）
setFormation(key) / rally() / disperse()
setSpeedScale(scale) / holdFleet() / resumeFleet()
uturn() / rtlFleet() / cancelRtl() / estop() / recover()
vesselGotoSelected()             // 进入「航点」工具并自动切到战术图
gotoVesselAt(id, x, z)
vesselRtl(id) / vesselHold(id) / vesselResume(id)
toggleSensor(id, sensorId)
placeWaypoint(x, z)              // 战术图点击回调：goto 工具时派遣；否则仅记录标记
setMapTool(tool) / toggleMapLayer(layer) / setLogFilter(kind)
ackAlarm(id) / ackAllAlarms()
runConsole(text)                 // 由 dock 模块解析后调用底层 dispatch
```

`ctx.bus` 事件：`'select'`(id)、`'view'`(mode)、`'camera'`(mode)、`'tool'`(tool)、
`'mapfocus'`({x,z})、`'help'`(open)、`'alarm'`(alarm)。

### 4.7 shell DOM（Lead 提供，不得改写层级）

```html
<div id="gcs-root">
  <div class="gcs-vignette"></div>
  <header id="gcs-topbar" class="gcs-host"></header>
  <aside id="gcs-left" class="gcs-host gcs-rail gcs-rail--left"></aside>
  <main id="gcs-center">
    <section id="gcs-viewport">
      <div id="gcs-hud"></div>
      <div id="gcs-map" hidden></div>
    </section>
    <footer id="gcs-dock" class="gcs-host"></footer>
  </main>
  <aside id="gcs-right" class="gcs-host gcs-rail gcs-rail--right"></aside>
  <div id="gcs-overlays"></div>
</div>
```

`#gcs-root` 全局 `pointer-events:none`；`.gcs-host`、`#gcs-map` 交互区域 `pointer-events:auto`；
`#gcs-hud` `pointer-events:none`，其内部按钮单独设 auto；中央视区空白处鼠标事件穿透到 3D canvas。

---

## 5. 领域常量（`src/gcs/meta.js`，Lead 维护）

- `GEO = { lat0: 18.2215, lon0: 112.6412, mPerDegLat: 111320 }`；**北 = -Z，东 = +X**；
  `lat = lat0 - z/mPerDegLat`，`lon = lon0 + x/(mPerDegLat*cos(lat0))`。
- `MISSION`：id `M-07`，名称「协同警戒巡航 / COOPERATIVE PATROL」，海域「南海 · 试验海域 A」，
  6 个阶段（航渡展开/编队集结/区域警戒/协同测绘/抵近侦察/返航评估），6 个航路点（世界 x/z 沿
  既有大圆弧航线）。初始任务时钟偏移 720 s（打开即处于「协同测绘」阶段）。
- `FLEET_ROSTER`（继承 `src/config.js`）17 艇，展示顺序与分组：
  指挥舰 1；侦察分队 5；环境与测绘分队 5（env×3、survey×2）；巡逻警戒分队 2；综合保障分队 4
  （comms、energy-1、energy-2、rescue）。呼号 USV-01…USV-17 按展示顺序。
- `VESSEL_META`（每型）：中文名、英文名、用途、传感器清单、额定功率、典型航速。
- `FORMATIONS`：wedge 楔形 / column 纵队 / line 横队 / diamond 菱形 / ring 环形，
  含 SVG glyph 描述（给左栏按钮用，可用简单 path 数据）。
- `SENSOR_CATALOG`：radar 导航雷达 / eoir 光电吊舱 / sonar 前视声呐 / ais AIS 接收 / mesh MESH 中继。
- `GEOFENCE`：任务海域多边形（战术图上绘制、越界告警用）。

---

## 6. 场景控制语义（`src/systems/swarm-control.js`，Lead）

`createSwarmControl({ fleet, boats, meta })` → `{ update(dt), command(cmd), getState() }`。

1. **Fleet 扩展**（`formation.js` 小幅修改）：航速/转角改为逐帧积分（`pathPos += forward*speed*dt`、
   `pathYaw += turnRate*dt`），支持 `fleet.speedScale`、`fleet.timeScale`（保持=0）、
   每艇阵位 `b.slot = {lat, fwd}`（覆盖 roster.offset）、每艇 `b._auto = {target, speed, arrive}`
   单艇接管、`b._holdPos` 定点驻留；编队中心改为**实际艇位质心**（相机跟随真实集群）。
2. **五种队形**：wedge/column/line/diamond/ring 各给出 17 个阵位（旗舰在阵位基准点），
   切换时 6–10 s 缓动补间（各艇靠弹簧追位，自然）。
3. **航速**：0.45× 微速 / 1× 巡航 / 1.9× 全速（巡航约 6 kn）。
4. **保持/恢复**：`timeScale=0` 冻结航迹推进，各艇原地随浪保持阵位；恢复后继续。
5. **调头**：以最大 0.012 rad/s 转向，艏向变化 π 后恢复巡航曲率，事件「调头完成」。
6. **返航 RTL**：全员进入自主模式，转向基地（约 2.4 km），速度 1.7×，距基地实时更新；
   抵近 120 m 后保持待命；可取消并归队。相机继续跟随集群质心。
7. **急停**：全员 3 s 内减速停船（`timeScale→0`，自主艇原地保持），场景顶部红色警示；
   仅「解除急停」可恢复。
8. **单艇导航**：目标点直线航行（6.5 m/s），到达 8 m 内驻留待命（`hold`），可「归队」；
   `selection.js` 显示该艇 3D 航点光柱与航线。
9. **状态回传**：`getState()` 返回 §4.4 的 `fleet.mode`、每艇 `mode`、`waypoint`、`rtlDistanceM`。

---

## 7. 交互与快捷键

| 操作 | 说明 |
|---|---|
| 点击名册行 / 3D 艇 / 战术图艇标 | 选中（联动锁定框、详情、战术图高亮） |
| 双击名册行 / 详情「锁定跟随」 | 镜头锁定该艇 |
| `1`–`5` | 五种编队队形 |
| `Shift+1/2/3` | 微速/巡航/全速 |
| `Space` | 编队保持 / 恢复 |
| `U` | 调头 |
| `R` | 镜头回到「跟随编队」 |
| `M` | 三维态势 / 二维战术图切换 |
| `F` | 镜头锁定选中艇 |
| `H` | 纯净视景（隐藏 UI） |
| `?` / `/` | 帮助覆盖层 |
| `Enter` | 聚焦指令台输入框 |
| `Esc` | 关闭覆盖层 / 取消地图工具 / 退出纯净视景 |
| 急停 | 顶栏红色按钮或左栏指令区；**必须二次确认**（长按 1.2 s 或点击确认） |

---

## 8. 视觉规范（摘要，详见 `docs/GCS-design-system.md`）

- 关键词：**深海指挥甲板 / Deep-Sea Command Deck**。深海军蓝玻璃拟态面板 + 青绿霓虹数据条，
  金色夕阳海面作为背景，冷暖对比；技术制图式的细线、刻度、等宽数字；克制的动效。
- 主色：面板 `rgba(4,17,25,.74)`，线 `rgba(140,225,240,.16)`，主强调 `#5ff3e4`，
  次强调冰蓝 `#9fd6e8`，警告 `#ffb257`，危险 `#ff5d4a`，成功 `#5ce8a5`，文字 `#eaf7f7`。
- 字体：中文系统栈（Microsoft YaHei UI / PingFang SC），英文与数字用 Bahnschrift / Cascadia Mono；
  所有数字 `font-variant-numeric: tabular-nums`；微标签 9.5–10px，字距 0.14em，大写。
- 面板：1px 半透明描边 + 顶部 1px 高光 + 四角 8px 制图角标 + 标题行（序号/中英标题/右侧计数）。
- 布局（1600×900）：顶栏 64，左栏 300，右栏 332，中央视区（HUD+3D）+ 底栏 196；间隙 12，外边距 12。
- 禁止：圆角超过 6px 的卡片、彩色渐变进度条、emoji、外链字体、花哨阴影。

---

## 9. QA 与可视化验收

- 开发服务器：`http://127.0.0.1:5179`（Lead 常驻，**其他人不要重启/占用 5179**）。
- 截图脚本：`node artifacts/gcs/capture.mjs --out artifacts/gcs/run-<name> [--tag <name>]`。
  该脚本会：跳过开机动画（`?nointro=1`）、暂停场景、逐状态截图、记录 console/pageerror、
  校验关键 DOM 数值（无 NaN/undefined）、校验指令回执与选中联动。
- 每轮改动后由 Lead 运行截图并逐张目检；模块 owner 可用
  `node artifacts/gcs/smoke.mjs --out artifacts/gcs/<name>` 自测单页。
- Playwright 路径（离线共享）：`C:/Users/45814/Documents/研究生/系统科学/2026/10/无人机组/素材库/node_modules/playwright-core/index.mjs`
  （用 `pathToFileURL` 动态 import；启动参数含 `--use-angle=swiftshader --enable-unsafe-swiftshader`）。
- 截图前调用 `window.__gcs.pause()`；需要新帧时 `window.__gcs.renderFrame()`。
- 任何 `console.error` / pageerror 视为失败；修复后再交付。

---

## 10. 协作规则

1. 动手前先读：本文件、`docs/GCS-design-system.md`、`src/gcs/meta.js`、`src/ui/context.js`、
   `src/ui/shell.js`、`src/ui/icons.js`、`src/ui/format.js` 及自己模块的骨架文件。
2. 只写 ownership 文件；共享文件（`main.js`、`shell.js`、`context.js`、`meta.js`、`styles/tokens.css`、
   `styles/base.css`、`styles/layout.css`）禁止改动，需要变更时发消息给 Lead。
3. 模块 CSS 文件内使用 `.模块前缀-*` 类名；复用 `base.css` 已发布的 `.gcs-panel`、`.gcs-btn`、
   `.gcs-chip`、`.gcs-kv`、`.gcs-bar` 等基础类。
4. 交付前自检：`node --check` 语法（ESM 用 `node --input-type=module --check` 不可用，
   直接 `node -e "import('./src/ui/panels/left.js').catch(e=>{console.error(e);process.exit(1)})"`
   会因 DOM/three 依赖失败，改为最小逻辑抽离自测 + 浏览器 smoke），浏览器零报错、截图目检通过。
5. 完成后给 Lead 发消息：文件清单、实现要点、已知限制、自测截图路径。
6. 不 commit、不 push、不 npm install、不修改 `package.json`（如确需依赖先问 Lead）。

---

## 11. 实现状态与验收记录（v2.1.0）

**交付状态：已完成。** 全部模块按本契约实现，整机回归与仿真自测均通过。

### 11.1 代码规模（新增/改造）

| 区域 | 规模 |
|---|---|
| `src/ui/`（界面：9 个核心模块 + 7 个面板 + 10 个 CSS 主题文件） | ≈ 17 000 行 |
| `src/sim/`（仿真引擎 8 个模块） | ≈ 3 600 行 |
| `src/gcs/`（领域常量 + 场景桥） | ≈ 570 行 |
| `src/systems/swarm-control.js` + `camera-director.js` + `objects/effects/selection.js` | ≈ 760 行 |
| `src/systems/vessel-dynamics.js`（3-DOF 水动力 plant）+ `motion-controller.js`（制导/自动舵/DP） | ≈ 1 050 行 |
| 扩展 `src/systems/formation.js` / `src/main.js` / `index.html` | 增量改造 |

### 11.2 自动化验收（最近一次全部通过）

| 项目 | 命令 | 结果 |
|---|---|---|
| 水动力单元自测 | `node artifacts/dynamics/selftest.mjs` | **141/141 PASS**：8 型参数/加速/回转/漂角/数值稳定性 + DP 执行器（低速保持 <1 m） |
| 纯 Node 闭环（plant+autopilot） | `node artifacts/motion/closed-loop-test.mjs` | **10/10 PASS**：6 kn 巡航、航点 1.3 m、回转半径、随流漂移、17 艇编队收敛 |
| 真实 Fleet+SwarmControl 集成 | `node artifacts/motion/fleet-integration-test.mjs` | **13/13 PASS**：巡航 6.03 kn / 阵位 13.4 m / 漂角 4.2° / 航点 6.3 m / 纵队收敛 17.9 m / 急停漂移 / 调头 1.1° / RTL 2627→406 m |
| 仿真引擎单元自测 | `node artifacts/sim/selftest.mjs` | **32/32 PASS**：全字段 schema、15 类指令 + 9 种拒绝路径、告警、暂停态回执、动力学透传、确定性 |
| 仿真引擎浏览器集成 | `node artifacts/sim/browser-check.mjs` | **16/16 PASS**，0 console error，真实 dynamics 17/17 |
| 整机回归 | `npm run qa:gcs`（`artifacts/gcs/capture.mjs`） | **30/30 PASS**，0 console error / pageerror，0 外部网络请求 |
| 生产构建 | `npm run build` | 通过，产物离线可用 |

整机回归断言覆盖：7 个面板挂载、DOM 无 NaN/undefined、17 艇遥测有限值、3-DOF 操纵遥测
（舵角/油门/漂角/COG）、名册点击 ↔ 3D ↔ 右栏联动、战术图切换、航点派遣与回执、编队指令回执、
急停弹层、帮助弹层、指令台执行、纯净视景、开机门闩、3D 拾取、键盘快捷键、急停长按确认、
急停中指令拒绝与恢复。

### 11.3 视觉基线

`docs/figures/gcs-01-console.png`（三维态势总览）、`gcs-02-map.png`（二维战术图）、
`gcs-03-estop.png`（急停长按确认）、`gcs-04-boot.png`（开机自检）、
`gcs-05-formation.png`（编队保持 + 单艇自主）、`gcs-06-clean.png`（纯净视景）。
截图由 `artifacts/gcs/run-final/` 全量冷启动回归产出；开机图由
`artifacts/gcs/bootshot.mjs`（`?bootms=` 慢放 + 暂停渲染）单独拍摄。

### 11.4 已知限制

1. 仿真任务阶段按 `MISSION.phases` 无限循环、MET 持续累计；跨午夜时日期文本正确滚动。
2. `depthM` 为近似水深场（继承场景无测深通道）；阵位偏离告警依赖 `vessels[].stationErrorM`。
3. 极端低帧率（软件渲染 ~2 fps）下，数据链回执的墙钟观测会顺延到下一 UI 帧（仿真时间语义仍严格）。
4. 1× 巡航时 17 艇在中心视区的屏幕尺寸偏小（真实尺度 10–30 m 艇在 ~600 m 观察距离下）；
   可通过视角预设「低空 / 编队 / 俯视」或滚轮拉近观察。
5. 战术图在 2.2× 以上缩放时编队簇内 17 个呼号标签会略拥挤（阅读阈值建议 ≤ 2.2×）。

---

## 12. 无人艇水动力动力学（v2.1，替代质点动力学）

**背景**：v2.0 中艇位由弹簧/直线插值直接驱动（质点运动学）；v2.1 把每艘艇升级为
**3 自由度（纵荡 surge / 横荡 sway / 艏摇 yaw）水动力操纵模型**，编队、单艇派遣、急停等
所有运动都由推力、舵力、质量/附加质量、阻尼与水流积分得到，控制器只能通过油门/舵/侧推
等真实执行器间接操纵。

### 12.1 模型方程（`src/systems/vessel-dynamics.js`）

体轴：u 纵荡（船首）、v 横荡（右舷）、r 艏摇；正 ψ 为左转，与场景
`forward=(cosψ,0,−sinψ)` 一致。

```
运动学   ẋ = cosψ·u + sinψ·v
         ż = −sinψ·u + cosψ·v
         ψ̇ = r
纵荡     (m − X_u̇)·u̇ = (m−Y_v̇)·v·r + X_u·u_r + X_uu·u_r|u_r| + T(throttle)
横荡     (m − Y_v̇)·v̇ = −(m−X_u̇)·u·r + Y_v·v_r + Y_vv·v_r|v_r| + Y_δ·sinδ·u_r² + F_dp
艏摇     (I_z − N_ṙ)·ṙ = (X_u̇−Y_v̇)·u·v + N_r·r + N_rr·r|r| + N_δ·sinδ·u_r² + M_dp
```

- `u_r, v_r` 为相对水的速度（= 船速 − 体轴系下的水流分量）；无油门时艇随流漂移，
  顶流航行时航迹向 COG 与艏向不同，产生真实**漂角**。
- 推力一阶滞后（`engineTauS`）、倒车限幅；舵角机械限幅 ±30°、舵速率限幅 25–40°/s；
  舵力随来流平方，低速舵效自然消失。
- **低速动力定位执行器**（艏侧推 / 喷注差动）：`cmd.lateral` 与 `cmd.yawAux` 通道，
  有效性随航速衰减 `thrusterEff(u)=clamp(1−|u|/(0.75·Umax), 0.08, 1)`；使单舵欠驱动艇
  在低速也能做定点保持（DP），高速时仍由舵主导，不破坏操纵真实性。
- 数值：内部子步长 ≤0.02 s，dt 0.005–0.1 稳定，长时间满舵满油不发散。

### 12.2 船型参数（真实量级）

| 型别 | L(m) | 排水(t) | Umax(kn) | 推力(kN) | 巡航全舵回转直径 | 巡航艏摇率 | 稳态漂角 | 0→80%Umax |
|---|---|---|---|---|---|---|---|---|
| 旗舰 flagship | 30 | 95 | 20 | 76 | 121 m (4.0 L) | 2.95°/s | 8° | 20 s |
| 侦察 scout | 10.5 | 3.5 | 24 | 8.1 | 48.5 m (4.6 L) | 7.5°/s | 13° | 9 s |
| 环境 env | 16.5 | 9 | 16 | 7.6 | 66.8 m (4.1 L) | 5.4°/s | 9° | 14 s |
| 测绘 survey | 18 | 14 | 12 | 6.5 | 63.5 m (3.5 L) | 5.6°/s | 7° | 18 s |
| 巡逻 patrol | 14.5 | 7.5 | 22 | 12.2 | 59.1 m (4.1 L) | 6.1°/s | 11° | 11 s |
| 通信 comms | 19 | 18 | 14 | 11.1 | 80.4 m (4.2 L) | 4.4°/s | 7° | 16 s |
| 能源 energy | 20 | 26 | 12 | 11.5 | 90.7 m (4.5 L) | 3.9°/s | 7° | 18 s |
| 救援 rescue | 15.5 | 8 | 18 | 9.2 | 62.8 m (4.1 L) | 5.7°/s | 9° | 12 s |

### 12.3 制导与控制（`src/systems/motion-controller.js`）

- **编队保持**：路径系下前向误差 → 速度指令（加减速追赶），横向误差 → 期望艏向
  （LOS 前视点 + 限幅），自动舵 PD（艏向 P + 转艏角速度反馈）→ 舵；
- **单艇派遣/RTL**：指向航点 + 制动包线（`v=√(2a·d)`），18 m 内交棒给 DP 定点模式；
- **动力定位 DP**：位置误差 → 期望对地速度（−水流前馈）→ 体轴期望速度 → 油门 PI +
  侧推 PI + 艏向保持（舵 + yawAux）；实测航点保持误差 ≈1.3 m；
- **编队保持/待机**：同样使用 DP 保持冻结阵位（受流扰动时持续小推力修正）；
- **急停**：全部执行器归零（动力切断），艇仅以水流速度漂移——物理上真实的"停船"；
- **软隔离**：邻艇过近时给出横向分离偏置与减速（非严格避碰，仅避免编队变换穿越时贴靠）。

### 12.4 验证（脚本可复跑）

| 验证 | 命令 | 结果 |
|---|---|---|
| 动力学单元/特性 | `node artifacts/dynamics/selftest.mjs` | 加速、稳态速度、停车滑行、全舵回转半径、漂角、水流漂移、DP 保持、稳定性 |
| 纯 Node 闭环（同一控制器） | `node artifacts/motion/closed-loop-test.mjs` | **10/10 PASS**：6 kn 巡航、航点 1.3 m 到达、全舵回转 27.9 m、切断动力随流漂移、17 艇编队变换后重新收敛 |
| 浏览器真实整机 | `node artifacts/motion/browser-dynamics.mjs` | 巡航/阵位、单艇派遣、编队变换、急停/恢复，全部通过、0 报错 |

### 12.5 简化与边界

1. 仅水平面 3-DOF：纵摇/横摇/升沉仍由波场驱动（视觉与姿态仪表），未建立耐波性动力学；
2. 水动力系数为 Fossen 风格工程近似（按目标回转直径/漂角/加速度反推），非水池试验数据；
3. 未建模波浪力对艇的漂移与失速、风载荷、浅水效应与搁浅；
4. 障碍/他船避碰非严格保证；编队变换时仅做轻量分离偏置。


