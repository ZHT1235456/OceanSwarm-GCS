# OceanSwarm GCS — 视觉设计系统（Visual Design System）

> 适用对象：所有界面模块 owner 与 design owner。契约见 `docs/GCS-architecture.md`。
> 目标：一眼看上去像**真实可用的海军级无人系统指挥台**，而不是网页套壳仪表盘。
> 参考气质：舰艇作战情报中心（CIC）、航天测控中心、深海科考母船指挥甲板。

---

## 1. 设计方向：Deep-Sea Command Deck 深海指挥甲板

- **背景是黄金时刻的真实海面**（继承场景），界面是**深海军蓝玻璃**——冷暖强对比，
  UI 像悬浮在视景之上的一块块「战术玻璃板」。
- **技术制图感**：细线、刻度、等宽数字、坐标读数、罗经带、比例尺、角标。
  一切「能显示数据的地方」都显示真实数据，不做无意义装饰。
- **克制**：动效只服务于状态变化（回执闪烁、告警脉冲、新事件滑入、面板入场）；
  不用大圆角卡片、不用彩色渐变、不用 emoji、不用发光大标题。
- **双语分层**：中文是主信息，英文/编号是视觉节奏（`微标签 + 大数字` 组合）。
- **信息密度**：高但不拥挤；靠字号层级、留白、分隔线组织，而不是靠底色块堆叠。

关键词：深海 / 舷窗 / 声呐绿松石 / 罗经刻度 / 坐标格网 / 玻璃面板 / 琥珀警示 / 冷静专业。

---

## 2. 色彩 Token（`src/ui/styles/tokens.css`）

```css
:root {
  /* ---- 基底（深海玻璃） ---- */
  --gcs-ink-1000:#020b12;                  /* 开机/遮罩最深 */
  --gcs-ink-950: #04121b;
  --gcs-ink-900: #06202c;
  --gcs-panel:        rgba(4,17,25,.74);   /* 面板底 */
  --gcs-panel-strong: rgba(3,13,20,.90);   /* 顶栏/底栏/弹层 */
  --gcs-panel-soft:   rgba(10,34,46,.55);  /* 内嵌块 */
  --gcs-panel-hover:  rgba(16,52,66,.55);
  --gcs-sheen:        linear-gradient(180deg, rgba(160,240,250,.07), rgba(160,240,250,0) 42%);

  /* ---- 线与分隔 ---- */
  --gcs-line:        rgba(140,224,238,.14);
  --gcs-line-strong: rgba(140,224,238,.30);
  --gcs-line-faint:  rgba(140,224,238,.07);

  /* ---- 文字 ---- */
  --gcs-text:   #eaf7f7;
  --gcs-text-2: rgba(212,236,241,.68);
  --gcs-text-3: rgba(188,220,229,.44);
  --gcs-text-4: rgba(168,204,214,.28);

  /* ---- 强调 ---- */
  --gcs-accent:      #5ff3e4;              /* 青绿主强调（数据/选中/可执行） */
  --gcs-accent-2:    #9fd6e8;              /* 冰蓝次强调（英文/刻度） */
  --gcs-accent-soft: rgba(95,243,228,.14);
  --gcs-accent-line: rgba(95,243,228,.42);
  --gcs-command:     #8fd6ff;              /* 指令类事件 */

  /* ---- 语义 ---- */
  --gcs-ok:      #5ce8a5;
  --gcs-warn:    #ffb257;
  --gcs-danger:  #ff5d4a;
  --gcs-gold:    #ffd27a;
  --gcs-offline: rgba(170,196,204,.45);

  /* ---- 船型分类色（名册/地图/详情统一） ---- */
  --gcs-type-flagship:#ffd27a;
  --gcs-type-scout:   #5ff3e4;
  --gcs-type-env:     #7ee0b8;
  --gcs-type-survey:  #9fd6e8;
  --gcs-type-patrol:  #ffb257;
  --gcs-type-comms:   #c1a7ff;
  --gcs-type-energy:  #ffcf6e;
  --gcs-type-rescue:  #ff9a8a;

  /* ---- 尺寸 ---- */
  --gcs-topbar-h: 64px;
  --gcs-rail-l: 300px;
  --gcs-rail-r: 332px;
  --gcs-dock-h: 196px;
  --gcs-gap: 12px;
  --gcs-pad: 14px;
  --gcs-radius: 4px;
  --gcs-radius-s: 2px;
  --gcs-hair: 1px;

  /* ---- 字体 ---- */
  --gcs-font-cn: "Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif;
  --gcs-font-en: "Bahnschrift","Segoe UI Semibold","Segoe UI",var(--gcs-font-cn);
  --gcs-font-mono: "Cascadia Mono","Consolas","SFMono-Regular",var(--gcs-font-cn);
  --gcs-fs-micro: 9.5px;
  --gcs-fs-small: 11px;
  --gcs-fs-body: 12.5px;
  --gcs-fs-title: 13.5px;
  --gcs-fs-hero: 30px;

  /* ---- 动效 ---- */
  --gcs-ease: cubic-bezier(.22,.61,.36,1);
  --gcs-fast: 120ms;
  --gcs-normal: 220ms;
  --gcs-slow: 420ms;
}
```

规则：

- **不允许**在模块 CSS 中新造主色；需要新语义色时在 `tokens.css` 增加（design owner 管理）。
- 半透明面板必须配合 `backdrop-filter: blur(18px) saturate(1.15)`；低端降级为不透明底色。
- 文字对比度：正文 ≥ 4.5:1（对 `--gcs-panel` 复合后的底色）；`--gcs-text-3/4` 仅用于微标签/刻度。

---

## 3. 字体与排版

| 用途 | font-family | 字号/字重 | 其他 |
|---|---|---|---|
| 面板中文标题 | cn | 13.5px / 600 | 与英文小标题同行 |
| 英文微标签 | en | 9.5px / 500 | 大写，letter-spacing .16em，`--gcs-text-3` |
| 正文 / 列表 | cn | 12.5px / 400 | 行高 1.5 |
| 数字读数（大） | en | 30px / 500 | tabular-nums，letter-spacing -.01em |
| 数字读数（中） | en | 17px / 500 | tabular-nums |
| 表格/日志 | mono | 11px | 时间戳、坐标、指令 |
| 顶栏时钟 | en | 15px / 500 | 带 `UTC+8` 微标签 |

- 数字一律 `font-variant-numeric: tabular-nums`，单位用小号 `--gcs-text-3`（如 `6.0 kn` 的 kn）。
- 中文标题后接英文小标题时用 `·` 或空格：`集群编队 FLEET`（英文全大写、10px、text-3）。
- 不使用斜体；不使用下划线链接；不缩放字体做动效。

---

## 4. 布局网格（1600×900 基准）

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ TOPBAR 64px  logo | 任务 M-07 + 阶段 | 航路进度 | 数据链/海况/时钟/指挥员     │
 ├──────────┬──────────────────────────────────────────────┬──────────────────┤
 │ LEFT     │  CENTER                                       │ RIGHT            │
 │ 300px    │  ┌ 视区 HUD（罗经带 / 视角切换 / 读数）────┐  │ 332px            │
 │          │  │                                           │  │ 单艇详情          │
 │ 任务卡   │  │        3D 海域视景 / 二维战术图            │  │ 英雄数值          │
 │ 名册     │  │        （选中锁定框、比例尺、坐标）        │  │ 姿态/链路/功率    │
 │ 编队控制 │  └───────────────────────────────────────────┘  │ 载荷/操作         │
 │          │  DOCK 196px  事件流（≈58%） | 指令台（≈42%）     │                  │
 ├──────────┴──────────────────────────────────────────────┴──────────────────┤
 │ 外边距 12px；面板间距 12px；烟囱式暗角保证边缘文字可读                        │
 └────────────────────────────────────────────────────────────────────────────┘
```

- 左右栏为**通高**（顶栏下到底部），中央列 = 视区（flex）+ 底栏（196）。
- `< 1500px`：`--gcs-rail-l:272px; --gcs-rail-r:304px;`，顶栏隐藏次要 chip。
- `< 1280px`：右栏折叠为抽屉（右上角按钮展开），中央视区优先。
- 面板之间允许多层叠压（`box-shadow: 0 18px 48px rgba(0,0,0,.38)`），但禁止互相遮挡操作区。

---

## 5. 面板（Panel）解剖

每个面板统一结构：

```html
<section class="gcs-panel">
  <header class="gcs-panel-head">
    <span class="gcs-panel-index">03</span>
    <h2 class="gcs-panel-title">集群编队 <em>FLEET ROSTER</em></h2>
    <span class="gcs-panel-meta">17/17 在线</span>
  </header>
  <div class="gcs-panel-body"> … </div>
</section>
```

样式规格：

- 底：`--gcs-panel` + `backdrop-filter: blur(18px) saturate(1.15)`；
  `border:1px solid var(--gcs-line)`；`border-radius:4px`；顶部 1px 高光（`--gcs-sheen`）。
- 四角角标：`::before/::after` 绘制左上/右下 10×10 L 形，色 `rgba(95,243,228,.42)`，1px。
- 标题行高 34px，下边框 1px `--gcs-line-faint`；序号 mono 10px `--gcs-text-3`；
  标题中文 13.5px/600；英文 `<em>` 10px 大写 0.16em `--gcs-text-3` not italic；
  右侧 meta 用 mono 10px。
- 内容 padding 12–14px；内部区块用 1px `--gcs-line-faint` 分隔或 8px 间距，不用卡片套卡片
  （最多一层内嵌块 `--gcs-panel-soft`）。

---

## 6. 基础组件（`base.css` 发布类）

### 6.1 按钮 `.gcs-btn`

- 默认：透明底、1px `--gcs-line`、文字 `--gcs-text-2`、高 26px、padding 0 10px、
  圆角 2px、字号 11.5px；hover：边框 `--gcs-line-strong`、底色 `--gcs-accent-soft`、文字 accent。
- `.gcs-btn--primary`：1px `--gcs-accent-line`，文字 accent，底色 accent 6%。
- `.gcs-btn--danger`：边框 `rgba(255,93,74,.5)`，文字 danger，hover 底色 danger 12%。
- `.gcs-btn--ghost`：无边框，hover 才出现底色。
- `.is-active`：底色 accent 14%，文字 accent，左侧 2px accent 竖条（或底部 2px 线）。
- `.is-pending`：文字变 text-3，右侧 3 个跳动点动画；`.is-acked`：一次 400ms 青色闪烁。
- 图标按钮最小 26×26；同一行按钮间距 6px；按钮内英文微标签 9px。

### 6.2 分段控件 `.gcs-seg`

容器 1px 边框 + 内嵌按钮；选中项底色 accent 12% + 文字 accent + 顶部 1px accent 线。

### 6.3 状态点 `.gcs-dot`

6px 圆点，`--gcs-ok/--gcs-warn/--gcs-danger/--gcs-offline`；活动状态带 3px 同色 18% 光晕；
危险状态 1.6s 呼吸动画（透明度 .55↔1）。

### 6.4 数据条 `.gcs-bar`

高 3px，底 `rgba(140,224,238,.12)`，填充 accent；低于 30% 变 warn，低于 15% 变 danger；
电池/链路/进度统一使用，宽度 24–80px 之间。

### 6.5 键值对 `.gcs-kv`

```html
<div class="gcs-kv"><span class="gcs-kv-k">航速 SPEED</span><span class="gcs-kv-v">6.0 <i>kn</i></span></div>
```
标签 9.5px 大写 text-3；值 12px mono；冒号省略；行高 22px；同组内用 1px 竖线或 8px 间距分隔。

### 6.6 Chip `.gcs-chip`

高 18px，padding 0 6px，1px 边框，圆角 2px，9.5px 大写 0.12em；
变体 `--warn/--danger/--ok/--accent` 只改边框/文字色，不填充大色块。

### 6.7 表格/列表行

行高 24–28px；hover 背景 `--gcs-panel-hover`；选中行：背景 accent 8% + 左侧 2px accent 竖条；
首列状态点，末列数值右对齐 mono。斑马纹不用。

### 6.8 滚动条

宽 4px；轨道透明；滑块 `rgba(140,224,238,.22)`，hover `.4`；`scrollbar-width: thin`。

### 6.9 告警条纹

面板顶部 `border-top:2px solid --gcs-warn/--gcs-danger` + 对应 3% 底色；critical 呼吸。

### 6.10 动效

- 面板入场：`opacity 0→1`、`translateY(8px→0)`、间隔 40ms 依次；`--gcs-slow`。
- 新日志行：高度展开 + 左侧 2px 色条闪光一次。
- 选中变化：锁定框 160ms 缩放淡入。
- 数值变化：不做滚动数字动画（读数必须可信）；仅告警颜色变化时 300ms 闪烁一次。
- `prefers-reduced-motion` 时关闭全部非必要动效。

---

## 7. 各区域内容规格

### 7.1 顶栏（64px）

三段式：**[左] 品牌 + 任务** ｜ **[中] 航路进度** ｜ **[右] 环境 + 时钟 + 指挥员**。

- 品牌：SVG 集群标志（3 个三角/节点组成），28px；右侧 `OCEAN SWARM` 13px/600 字距 .12em，
  下一行 `无人艇集群上位机 · GCS` 9.5px text-3；竖线分隔。
- 任务：`M-07` chip（accent）+ `协同警戒巡航` 13px + 阶段 `协同测绘 04/06` 小字 + 进度条 120px。
  心跳/数据链状态点。
- 中部：航路进度点列（6 个点 + 连线，已完成 accent、当前呼吸、未来 text-4）+ `航路 04/06 · 62%`
  + `ETA 00:08:24`。
- 右侧：`数据链 5/5 · 42 ms`、`GNSS 12 · RTK`、`海况 3 · 0.8 m` 三组 chip + 告警计数
  （有告警时琥珀/红色）+ 时钟（`14:32:07` 15px mono + `UTC+8 · 2026-10-26` 9px）+ 指挥员
  （圆形字母「指」+ `指挥员 OPERATOR` + `权限 ADMIN`）。
- 底边：1px `--gcs-line` + 中央 accent 渐变短线（60px）作为「甲板灯带」。

### 7.2 左栏（300px）

- **任务卡**（约 132px）：`任务 MISSION` 标题；任务名 + 海域；阶段进度（5 段刻度）；MET；
  当前航路点 `WP-04 协同测绘区`；「战术图」跳转按钮。
- **集群名册**（flex 撑满，内部滚动）：标题右侧 `17/17`、`平均电量 86%`；分组小标题
  （`指挥舰 FLAGSHIP`、`侦察分队 SCOUT`…，9px text-3，上下留 6px）；每行 26px：
  状态点 + 呼号 `USV-02`（mono 10.5）+ 中文名 `侦察-1`（11.5）+ 船型缩写（9px text-3）+ 电量条
  + 电量数字（10px mono）+ 速度（10px mono，右对齐）。选中行 accent 底色 + 左竖条；
  告警行末加小圆点（warn/danger）。
- **编队控制**（约 200px）：标题 `编队控制 FORMATION`；5 个队形按钮（glyph 图标 + 中文 9px，
  横向排布，32×34，选中态 accent）；航速分段（`微速 / 巡航 / 全速`）；第二行
  `保持 / 恢复`、`集结 / 分散`；底部指令行 `调头 180°`、`返航 RTL`、`急停 E-STOP`（danger）。

### 7.3 中央 HUD（叠加在视区上，`pointer-events:none`）

- 左上：视图切换 `三维态势 / 战术图` 分段 + 视角预设 8 个文字 chip（默认/低空/编队/俯视/
  基地/礁区/船首/舷侧）+ 镜头模式 chip（跟随编队 / 锁定目标 / 自由视角）。
- 顶中：罗经带（宽 380，高 36，Canvas：每 5° 刻度、30° 数字、中心航向三角、当前航向数字）。
- 右上：渲染读数（`fps · draw calls · triangles`，mono 9.5，text-3）。
- 左下：坐标读数（`18°13.29′N  112°38.05′E` mono）+ `航向 042° · 航速 6.0 kn` + 比例尺
  （100 m 线段，随镜头高度缩放）。
- 右下：环境罗盘（风向箭头 + `045° / 12kn` + `浪 0.8m`）。
- 选中锁定框：四角括号 28×28、cyan 1px、角线 8px、顶部标签 chip（`USV-07 侦察-3 · 6.2kn`），
  朝向指示线（艇艏方向 24px）；超出视区时显示边缘箭头 + 距离。
- 视区四角内嵌 1px 内描边 `rgba(140,224,238,.10)`，营造「观察窗」；不画扫描线。

### 7.4 底栏（196px，左右分栏）

- **事件流**（flex 1.55）：标题 `实时事件 EVENT STREAM` + 过滤 chip（全部/告警/指令/任务/链路）
  + 未读计数 + 「签收全部告警」；行结构：`[时钟 mono 10px] [类别窄条] [来源 chip] [正文 11.5px]`
  + 右侧耗时/状态；严重级：info→text-2、success→ok、warning→warn、critical→danger、
  command→command 蓝。最多展示 ~9 行，自动滚动到最新；hover 高亮。
- **指令台**（flex 1）：标题 `指令台 COMMAND`；最后回执行（ok/danger 色 + 延时 ms）；
  输入行 `▸` + 等宽输入框（placeholder：`输入指令，如 formation wedge / 编队 楔形 / help`）；
  建议 chips（点击填入）：`编队 楔形`、`航速 全速`、`保持`、`返航`、`help`；
  支持中文/英文命令、Tab 补全、↑↓ 历史、Enter 执行；错误提示红色小字。

### 7.5 右栏（332px，可滚动）

内容顺序：

1. **选中艇头图**：类型色竖条 + 呼号 `USV-07`（mono 大）+ 中文名 `侦察-3` + 类型 chip
   `高速侦察艇 SCOUT` + 在线状态；右上 `锁定` 图标按钮。
2. **英雄读数**：三列大数字：`航速 6.0 kn`（hero 30px）、`艏向 042°`、`电量 87%`
   （环形电量 48px，SVG，颜色随阈值）；下面一行 `纵向速度 / 横向偏差 / 距旗舰 138 m`。
3. **姿态**：人工地平线（120×64 Canvas：滚转刻度 −30…30、俯仰刻度、青色地平线）+
   右列 `纵摇 +0.8° / 横摇 −1.2° / 升沉 0.34 m`。
4. **数据链**：信号 5 格 + `−58 dBm` + `延时 42 ms` + `丢包 0.12%` + `MESH · 中继 USV-14`。
5. **能源**：面积折线图（120×46 Canvas，最近 8 分钟电量曲线，accent 线 + 10% 填充）+
   `28.4 V / 46 A / 1.3 kW / 42.6 °C`。
6. **载荷**：传感器清单（每行：简称 mono + 中文 + 状态 chip + 开关）；开关为 26×14 胶囊，
   on=accent，off=line；点击产生指令事件。
7. **操作**：3×2 按钮网格：`锁定跟随`、`定点导航`、`保持待机`、`单艇返航`、`归队恢复`、
   `标记目标`；danger 主按钮 `解除接管`（仅接管态显示）。
8. **原始参数**（折叠）：mono 小表 8–10 行（`id / type / group / uptime / cpu / mem / alarm`）。

### 7.6 二维战术图（占据中央视区）

- 全屏深蓝海图（`#04131d → #071f2a` 微渐变），16px 经纬网格（细线 + 边缘刻度标注），
  500 m 距离环（以旗舰为中心 3 圈），罗经玫瑰（左下或右上）。
- 地形：岛屿多边形（暗绿填充 `rgba(90,140,105,.28)` + 描边）、礁盘椭圆（青绿 12%）、
  基地/母船/航标/风机/观测平台图标（内联 SVG + 9px 标注）、任务海域边界（琥珀虚线）。
- 航路：6 个航点折线（accent 虚线 + 已过航点实心、未来空心）+ `WP-0x` 标注。
- 艇标：按类型色的小三角/箭头（10–14px，旋转到艏向），尾迹渐隐线（60–120 s 历史）；
  选中艇：外圈呼吸光环 + 呼号；旗舰：金色菱形 + 光环。
- 交互：滚轮缩放（0.3×–8×）、拖拽平移、点击选中（8px 命中）、双击居中；工具条
  `选择 / 航点 / 测距 / 居中 / 图层`；光标经纬读数 + 比例尺（随缩放）。
- 「航线/尾迹/网格/标注/声呐覆盖」图层开关（chip）；右上「跟随编队」开关。

### 7.7 覆盖层

- **开机（Boot）**：全屏 `--gcs-ink-1000`；中央 SVG 集群标志（缓慢描边动画）+ `OCEAN SWARM`
  大字（字距 .3em）+ `无人艇集群指挥控制系统 · GCS`；下方进度条 1px + 百分比 + 两行系统日志
  （`初始化三维视景… / 接入集群数据链… / 同步任务 M-07…`）；角落 `OFFLINE SECURE LINK · v2.0`。
  2.4 s 后整体上移淡出；可点击跳过；`?nointro=1` 直接跳过。
- **确认（Confirm）**：居中 420px 玻璃板；`--gcs-danger` 顶部条 + 警示图标；标题、说明、
  影响清单；主按钮采用**长按 1.2 s 确认**（进度环填充，松开取消），次按钮取消；
  `Esc` 取消。急停确认文案需说明「17 艘艇将立即停船，仅解除急停可恢复」。
- **帮助（Help）**：860×560 玻璃板；快捷键 2 列网格（键帽 mono 圆角小方块 + 说明）；
  底部 `OceanSwarm GCS v2.0 · 离线指挥控制终端`。
- **Toast**：右上（顶栏下 12px），最多 3 条，宽 300px；左侧严重色条 + 标题 + 说明；
  3.2 s 后淡出；用于指令回执、告警、模式切换。

---

## 8. 文案规范（中文主 / 英文辅）

| 场景 | 文案 |
|---|---|
| 模式 | 编队巡航 CRUISE / 编队保持 HOLD / 转向中 TURNING / 返航中 RTL / 紧急停止 E-STOP |
| 队形 | 楔形 WEDGE / 纵队 COLUMN / 横队 LINE / 菱形 DIAMOND / 环形 RING |
| 航速 | 微速 SLOW / 巡航 CRUISE / 全速 FLANK |
| 状态 | 在线 ONLINE / 告警 WARN / 严重 CRITICAL / 离线 OFFLINE / 待机 STANDBY |
| 单艇模式 | 编队 / 自主 / 待机 / 返航 / 手动 |
| 载荷 | 导航雷达 RADAR / 光电吊舱 EO-IR / 前视声呐 SONAR / AIS 接收 AIS / MESH 中继 |

- 指令名称：`编队队形 → 楔形`、`航速 → 全速`、`编队保持`、`调头 180°`、`返航基地`、
  `紧急停止`、`解除急停`、`单艇定点导航 → WP-05`、`载荷 光电吊舱 → 开启`。
- 回执：`指令已执行 · 延时 0.42 s` / `指令被拒绝 · 急停状态下仅可解除急停`。
- 告警：`USV-07 电量低于 25% · 当前 23.8%`、`USV-13 数据链延时过高 · 186 ms`、
  `USV-05 阵位偏离 42 m`、`集群进入紧急停止状态`。
- 数字格式：航速 `6.0 kn`、航向 `042°`、电量 `87%`、距离 `2.4 km`（<1000 m 用 m）、
  经纬 `18°13.29′N`、时间 `14:32:07`、延时 `42 ms`、坐标 `E 112°38.05′`。
- 不用「！」「~」「哈哈」等口语；不用英文感叹；标点统一中文全角，数字与单位间保留空格。

---

## 9. 图标（`src/ui/icons.js`，内联 SVG，stroke=currentColor）

需要：`logo` `vessel-flagship` `vessel-scout` `vessel-env` `vessel-survey` `vessel-patrol`
`vessel-comms` `vessel-energy` `vessel-rescue` `map` `globe` `crosshair` `lock` `unlock`
`compass` `link` `battery` `power` `temp` `warning` `critical` `info` `check` `close` `help`
`chevron-left/right/down` `zoom-in/out` `layers` `target` `route` `radar` `eoir` `sonar` `ais`
`mesh` `clock` `operator` `wind` `wave` `anchor` `play/pause` `settings` `expand` `arrow-up`。

统一：24×24 viewBox，1.6 线宽，round cap；16px 显示尺寸为主，12px 用于行内。

---

## 10. 反例（禁止）

- 渐变大按钮、发光文字、彩色玻璃卡片、emoji、外链字体、圆角 > 6px 的大卡片。
- 无意义装饰：假波形、随机跳动数字、与场景无关的雷达扫描动画。
- 信息造假：不允许在 UI 中显示与场景不一致的航速/航向/位置（全部来自 Sim snapshot）。
- 遮挡操作：Toast 不得盖住顶栏按钮；确认弹层必须居中且背景可点击取消。
