# 素材与许可 / Credits

OceanSwarm 的几何、着色器、动画与光效几乎全部由代码程序化生成；**外部美术资源**只有两项本地贴图：一张用于天空大气的 HDR 全景图，以及一张用于水面微细节的照片法线贴图。本文件记录两项素材的来源、作者、许可与本仓库中的使用方式，并给出出处链接（CC0 不要求署名，此处署名出于对作者的感谢与可追溯性）。

## 天空 HDR 全景图

| 项目 | 内容 |
| --- | --- |
| 名称 | Kloppenheim 06 (Pure Sky) |
| 作者 | Greg Zaal（Original，原始全景）、Jarod Guest（Sky edits，天空精修） |
| 来源页面 | <https://polyhaven.com/a/kloppenheim_06_puresky> |
| 许可 | **CC0 1.0 Universal**（公有领域贡献，可自由使用、修改与再分发，无需署名）<br><https://polyhaven.com/license> |
| 发布 / 拍摄 | 2022-11-26 发布；2019-11-03 拍摄于 -25.6484, 30.1519；原始分辨率 24K |
| 仓库内文件 | `public/hdr/kloppenheim_06_puresky_2k.hdr` |
| 尺寸 / 格式 | 2048 × 1024（2:1 等距圆柱投影），Radiance RGBE (`.hdr`)，32-bit RLE |
| 文件大小 | 4 434 394 字节 |
| MD5 | `590a829b3cf71216451655e601d542c6`（与 Poly Haven files API 的 2K HDR 完全一致） |
| 内容 | 纯天空全景，不含地面与建筑：低角度金色阳光（方位角 ≈ 40.69°、仰角 ≈ 4.66°）穿过薄云，暖色逆光积云与深蓝天顶 |

### 用途

同一张 HDR 全景被三个渲染环节共享，使可见天空、海面反射与环境光照描述同一个大气：

1. **天空穹顶**（`src/core/sky.js`）：以等距圆柱投影逐像素采样全景图，作为可见天空；穹顶随相机移动。
2. **海面反射与地平线雾**（`src/core/ocean.js`）：菲涅尔反射从同一全景的低分辨率 mip 采样；远处海面的距离雾色直接取该视线方向的全景地平线颜色，因此海天交界线逐方向无缝、太阳一侧偏暖、背光一侧偏冷。
3. **基于图像的环境光（IBL）**（`src/core/hdri.js` → `src/core/materials.js`）：`HDRLoader` 读入后经 `PMREMGenerator` 预滤波，得到 HDR 环境贴图；`materials.js` 把它作为金属与玻璃材质（`makeMetal` / `makeGlass`）的逐材质 `envMap`，不依赖 `scene.environment`。

加载方式为**本地同源**：文件随仓库一起分发，由 Vite 从 `public/hdr/` 以应用自身的 base URL 提供，运行时不请求任何 CDN、字体或远程资源，可完全离线运行。若该文件缺失或解码失败，`src/main.js` 会记录 `console.error` 并回退到原有的程序化天空（`skyTint()` 渐变 + 太阳光晕），场景仍可正常渲染。

### 除此之外的内容

除上述两张本地贴图外，场景**不使用任何其他外部贴图、模型或 HDR 资源**：船体（`core/geo.js` 参数化船体）、无人艇设备、海岛与岩壁、珊瑚礁与鱼群、母船与基地建筑、浮标/灯塔/风机、海面波形与泡沫、尾迹、通信与扫描光效、海鸥等均由代码程序化生成；尾迹与天空绘制所需的噪声、渐变等纹理也在运行时由 Canvas 或 GLSL 现场生成（HDR 全景中的云与太阳是唯一“拍摄而来”的大气内容，水面法线是唯一的拍摄法线细节）。

### 替换天空全景

1. 将 2:1 等距圆柱投影的 `.hdr`（建议 2K/4K）放入 `public/hdr/`；
2. 修改 `src/config.js` 中 `WORLD.sky.hdrPath`（以及可选的 `hdrIntensity`，当前 `0.9`）；
3. 若新全景的太阳位置不同，同步更新 `WORLD.sunDirection` 以及 `WORLD.sunColor` / `WORLD.sunIntensity`：主光方向、补光方向与天空/海面的 `uSunDir` uniform 都由 `sunDirection` 派生（不再有单独的 `sunElevationDeg` 字段）；
4. 检查整条流水线（天空、海面反射、金属/玻璃 IBL）并重新截图。

> 替换素材时请确认其许可允许再分发，并更新本文件的作者与许可信息。

## 水面法线贴图

| 项目 | 内容 |
| --- | --- |
| 名称 | Water normals（three.js “Water”示例所用水面法线贴图） |
| 来源 | <https://threejs.org/examples/textures/waternormals.jpg>（three.js 官方示例 `webgl_shaders_ocean` 使用的纹理） |
| 许可 | **MIT**（随 [three.js](https://threejs.org/) 仓库分发，Copyright © three.js authors）<br><https://github.com/mrdoob/three.js/blob/dev/LICENSE> |
| 仓库内文件 | `public/textures/waternormals.jpg` |
| 尺寸 / 格式 | 1024 × 1024 灰度法线贴图（切线空间，JPEG） |
| 文件大小 | 248 813 字节 |
| SHA256 | `add9912b158a4fe9c12421745babe68c44c8af75631ac4837236cb2a03bc373f` |
| 内容 | 真实拍摄/生成的水面微起伏法线：细碎毛细波、方向性细浪与大尺度风斑；本身不含颜色，只提供坡度方向 |

### 用途

经 `src/core/water-normal.js`（`TextureLoader`，`NoColorSpace`、`RepeatWrapping`、mipmap + anisotropy 8）加载后，同一张纹理在海洋着色器（`src/core/ocean.js`）中以**三个不同缩放、缓慢漂移、按相机距离加权的坐标层**复用：

1. **近景毛细波**（`normalScaleC`，约 6--140 m 内生效）：贴着水面的细碎起伏，负责近景的真实感；
2. **中景细浪**（`normalScaleA`，约 70--700 m）：近/中景的主力层，驱动反射扰动与太阳碎金；
3. **远景风斑**（`normalScaleB`，约 160--1600 m）：远距离水面的低频纹理，避免高空俯视时海面“糊成一片”。

法线坡度既用于扰动水面法线（反射与高光），也通过 `dot(N, uSunDir)` 与平滑法线之差形成**微明暗**项，让低角度太阳下的涟漪面片产生亮/暗变化；程序化方向波仍负责大尺度几何起伏，照片细节只负责“看起来像水”。加载失败时（`uNormalReady = 0`）着色器回退到程序化涟漪，场景不中断。水面法线贴图亦随仓库本地分发、同源加载，运行时不访问网络。

### 替换水面法线

1. 将 1024×1024（或其他 2 的幂尺寸）的切线空间法线贴图放入 `public/textures/`；
2. 修改 `src/config.js` 中 `WORLD.water.normalMapPath`；
3. 按需要调整 `WORLD.water` 的 `normalScaleA/B/C`（每米 uv 重复，y/x 拉伸用于沿主风向拉长波纹）、`normalStrength`（坡度强度，1.3）与 `normalShading`（微明暗强度，0.95）；
4. 重新检查近景碎浪、中景肌理、反射扰动与太阳碎金，并按需调整深水色板 `COLORS.oceanDeep/oceanMid/oceanLight`。

## 第三方软件组件

| 组件 | 版本 | 许可 | 用途 |
| --- | --- | --- | --- |
| [three.js](https://threejs.org/) | 0.186 | MIT | 三维渲染引擎、`HDRLoader`、`PMREMGenerator`、`OrbitControls` |
| [Vite](https://vite.dev/) | 7 | MIT | 开发服务器与生产构建 |

## 文档

开发文档（`docs/OceanSwarm-GCS-dev-doc.tex` / `.pdf`）使用 XeLaTeX + ctex 排版，工程截图为项目自身的无头浏览器渲染结果；文档中引用的 Poly Haven 全景与 three.js 水面法线信息以本文件为准。
