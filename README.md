# 广角照片几何校正

基于**显式选定的 Brown-Conrady 径向 + 切向畸变模型**的广角照片校正程序。程序读取自制标定参数与畸变图像，用模型的反向映射逐像素采样得到校正图；坐标残差与线条弯曲都在实际输出光栅上重新测量，未使用任何锐化、增强或预生成结果图。

- 模型：`1 + k1 r² + k2 r⁴ + k3 r⁶`（径向阶数可选 **2 / 4 / 6**），切向 `dx = 2p1xy + p2(r²+2x²)`、`dy = p1(r²+2y²) + 2p2xy`（可关闭）
- 内参（fx/fy/cx/cy）定义于标定参考分辨率；输入尺寸变化时按 `sx = W/refW`、`sy = H/refH` 缩放，无量纲畸变系数保持不变，绝不把同一组像素参数原样套用到任意图片
- 求逆为带步长上限、回退线搜索与迭代/残差预算的阻尼牛顿法，有明确的停止状态（`converged / iterations-exhausted / stalled / diverged`），异常参数不会无限计算
- 输出取景可选**保留视场**或**裁剪输出**，实际边界由所选投影实测得出（边界反演 / 居中裁剪二分测量），不拉伸到固定矩形
- 无效区域（越界、模型有效半径外、非有限坐标）有独立掩膜、填充色和红色边界叠加

## 一、窗口启动步骤（图形界面）

以下步骤在**本机终端之外**打开浏览器窗口完成，不需要桌面环境也能运行（页面是普通静态网页）。

1. **启动本地服务**（只启动一次，保持该终端窗口运行）

   ```bash
   cd /workspace
   npm start
   ```

   看到类似输出即成功：

   ```
   广角校正页面已启动
     打开 http://127.0.0.1:5178/
   ```

   - 默认端口 5178；被占用时用 `npm start -- --port=5180`，或 `PORT=5180 npm start`
   - 只监听 `127.0.0.1`，不对外网开放
   - 停止服务：在该终端按 `Ctrl+C`

2. **在浏览器窗口打开页面**

   - 直接访问 **<http://127.0.0.1:5178/>**（会自动跳转到 `/src/ui/index.html`）
   - 或打开 `http://localhost:5178/`
   - 若希望从终端直接拉起浏览器窗口，可另开一个终端执行：
     - Linux：`gio open http://127.0.0.1:5178/` 或 `xdg-open http://127.0.0.1:5178/`
     - macOS：`open http://127.0.0.1:5178/`
     - Windows：`start http://127.0.0.1:5178/`

3. **页面打开后**会自动载入内置合成广角标定图（800×600）并完成检测、拟合与校正；三栏分别是：
   - **左栏**：分辨率关系、显式模型选择（径向阶数 / 切向开关）、内参、畸变系数与有效半径、输出取景、求解预算、标定点列表
   - **中栏**：畸变图 / 校正图 / 并排视图。在畸变图上**拖动橙色标定点**即可改变标定；橙色十字是当前拟合下理想网格交点在畸变图中的实际位置
   - **右栏**：鼠标映射探针（正向/反向坐标与迭代次数）、坐标误差（含逐点表与误差曲线）、线条弯曲测量、无效区域统计、**畸变诊断（边缘异常追踪 + 阶段证据链）**、拟合诊断

4. **常用窗口操作**（全部触发真实计算，无预设结果）
   - 「载入内置标定图」：重新生成强畸变（k1≈-0.42, k2≈+0.19, k3≈-0.028）且主点偏移的场景并重算
   - 「载入图片」「载入参数 JSON」「载入对应点」：使用自己的素材；尺寸与参考分辨率不同时页面会显示并执行比例调整
   - 「保留视场 / 裁剪输出」：切换取景，左侧立即显示实测输出尺寸与比例
   - 径向阶数切到 2 / 4 阶：模型真正变化并重新拟合，残差随之增大；若所选阶数在当前系数下超出单调可逆范围，有效半径会被**收缩并明确提示**（不是静默失败）
   - 「导出校正 PNG / 参数 JSON / 对应点 / 评估 JSON / 诊断 JSON」：由当前实际计算结果生成文件，可离线核对；诊断 JSON 按原始分辨率重算坐标残差与失败区域

   拖动一个标定点后，如果它与整体模型明显不符，拟合会**剔除该点并在右栏与顶部提示条中报出点号**，其余点保持原有精度；这属于界面主动暴露的异常，而非把错误吸收进结果。

5. **畸变诊断（右栏「畸变诊断」区）**：每次拖动标定点、切换模型或修改参数后实时重算，与图像处理页联动显示——
   - 边缘黑块 / 局部拉伸的**坐标与有效性追踪**：失败区域（连通标记）逐区域给出输出像素坐标 → 无畸变平面坐标 → 源像素坐标、归一化半径 vs 有效半径、径向缩放与局部拉伸率（来自正向雅可比）
   - **阶段证据链**：`validate → model → plan → reverse-map → render → measure`，坐标残差与失败区域异常都定位到具体阶段
   - **已知径向变换探针**：闭式径向曲线 + 预算内回环反解，用以区分参数单位/尺度异常、迭代不收敛、输入覆盖不足（边缘越界）三类根因，每条原因都带观测证据
   - 诊断只读取光栅与映射，**不涂补失败像素**；异常记录条数有硬上限（默认 48 条 / 8 个区域），预算外丢弃只计数不展开，日志成本有界

## 二、交付物

### 已生成的实物结果（`deliverables/`）

| 文件 | 内容 |
| --- | --- |
| `distorted-grid.png` | 用已知直线网格生成的 1200×900 强畸变测试图（含中心偏移），逐像素反演采样真实生成 |
| `distorted-ground-truth.json` | 生成该图所用的真值标定参数 |
| `correspondences.json` | 160 组理想格点 ↔ 畸变图像素对应点 |
| `distorted-detected-markers.png` | 在畸变图上实际检测到的标记位置 |
| `distorted-with-ideal-grid.png` | 畸变图叠加理想网格（可直接看出线条弯曲） |
| `calibration-fitted.json` | **从图像实际检测点拟合出的标定参数文件**（含模型配置、拟合诊断） |
| `calibration-ground-truth.json` | 真值参数，供对比 |
| `rectified.png` | 用拟合参数反向映射重采样得到的校正图（保留视场，实测 1608×1220） |
| `rectified-invalid-overlay.png` | 无效区域红色边界叠加 |
| `rectified-with-ideal-grid.png` / `rectified-markers.png` | 校正图上叠加理想网格 / 检测点，用于目视核对 |
| `evaluation.json` | 坐标残差、线条弯曲、检查阈值与通过判定（全部实测） |
| `diagnosis.json` | 畸变诊断：阶段证据链、失败区域坐标追踪、根因分类与日志预算（实测） |
| `mapping-probes.json` | 15 个映射探针的正向/反向坐标、半径、迭代次数与无效原因 |
| `resolution-adaptation.json` | 分辨率减半时的内参调整与系数不变性记录 |
| `contact-sheet.png` / `.json` | 关键视图汇总（人工复核用） |

当前一次完整运行的实测结果（`npm run demo`）：

- 拟合：108 点，14 次迭代，`converged`，重投影 RMS **0.0648 px**、最大 0.1528 px
- 校正后坐标残差（在校正光栅中重新检测标记，再与理想交点比较，单位源像素）：RMS **0.1169 px**、最大 0.9243 px
- 线条弯曲（沿法向扫描实际亮度重心后拟合直线）：RMS **11.2941 px → 0.1530 px（改善 73.81×）**，最大 41.98 px → 0.685 px
- 保留视场输出 1608×1220，有效像素 81.09%（越界 370,957、模型外 44）
- 诊断：`ok`，2 个 info 级原因（输入覆盖不足 18.91%、模型有效域外 44 px），失败区域 3 个，异常记录 9 条（预算 48），坐标残差与失败区域均定位到 render/measure 阶段
- 判定：**PASS**（markerRms / markerMax / bendingRms / bendingMax / improvement 全通过）

### 参数文件格式（节选）

```json
{
  "model": "brown-conrady",
  "reference": "1200×900",
  "intrinsics": { "fx": 1020, "fy": 1020, "cx": 647.88, "cy": 418.82 },
  "distortion": {
    "k1": -0.4202, "k2": 0.1906, "k3": -0.0284,
    "p1": 0.0039, "p2": -0.0030,
    "validMaxNormalizedRadius": 1.06,
    "modelConfig": { "radialOrder": 6, "tangential": true }
  },
  "projection": { "mode": "preserve-field", "fillColor": [16, 20, 28, 255] }
}
```

`modelConfig` 显式记录使用了哪些径向项与是否启用切向项，校准时真正按该配置建立方程。

## 三、终端辅助命令（只用于生成与校验，不替代窗口）

```bash
npm run demo       # generate + evaluate：重新生成全部 deliverables（含 diagnosis.json）
npm run evaluate   # 只做评估（可加 -- --mode=crop）
npm run generate   # 只生成畸变图与对应点
npm run diagnose   # 只做畸变诊断（内置合成场景自检；诊断 JSON 写入 deliverables/）
npm test           # 31 个单元测试（模型、求逆预算、分辨率、取景、渲染、鲁棒拟合、有效半径收缩、畸变诊断）
npm run verify     # （开发用）无头浏览器跑一遍界面并截图到 /tmp/ui-verify
```

逐像素反演一张自有图片：

```bash
node tools/wideangle-cli.mjs inspect \
  --image deliverables/distorted-grid.png \
  --calibration deliverables/calibration-fitted.json \
  --mode preserve-field --out out/
```

诊断一张自有图片（`--image` 与 `--calibration` 必须同时提供，缺失或非法输入直接报错退出，不会用默认值顶替；诊断结论为 broken 时退出码为 2）：

```bash
node tools/wideangle-cli.mjs diagnose \
  --image deliverables/distorted-grid.png \
  --calibration deliverables/calibration-fitted.json \
  --mode preserve-field --out out/
```

图形界面是主入口（见上文「窗口启动步骤」）；这些终端命令只用于生成与校验产物，不替代窗口。

## 四、把程序内部机制对应到需求

| 需求 | 实现位置 |
| --- | --- |
| 显式径向/切向模型 | `src/core/calibration.js`（`DISTORTION_MODEL`、`modelConfig`）+ `src/core/model.js` |
| 反向映射 + 采样 | `src/core/model.js` `distortedToUndistorted`、`src/core/render.js` |
| 分辨率关系 | `src/core/calibration.js` `getIntrinsicsAtSize`、`adaptCalibrationToSize`、`describeResolutionRelation` |
| 有效范围 / 不可逆 / 越界 | `validateCalibration`、`monotonicRadiusLimit`、`clampValidRadius`、`destinationToSource`、`renderRectified` 统计 |
| 求逆停止条件 | `src/core/model.js` `inverseNormalized`（迭代/步长/回退/停止状态） |
| 保留视场 / 裁剪 | `src/core/projection.js` `measureFieldBounds`、`measureCropRect`、`planOutput` |
| 强畸变 + 中心偏移测试 | `src/core/synthetic.js`（真值 k1/k2/k3、cx/cy 偏移） |
| 坐标残差与线条弯曲测量 | `src/core/analysis.js` `detectMarkers`、`measureLineBending`、`evaluateRectification` |
| 畸变诊断（边缘异常追踪、阶段证据链、根因分类） | `src/core/diagnosis.js` `diagnoseRectification`；CLI `diagnose`；UI 右栏「畸变诊断」+「导出诊断 JSON」 |
| 可移动标定点与模型调整 | `src/ui/app.js`（拖动 → 鲁棒重拟合 → 实时误差与诊断） |

## 五、目录

```
src/core/      纯计算模块（模型、标定、投影、渲染、分析、诊断、合成、PNG 编解码）
src/node/      Node 侧静态服务与 PNG/JSON 读写
src/ui/        图形界面（index.html / styles.css / app.js）
tools/         终端辅助 CLI 与（开发用）无头浏览器自检
tests/         node:test 单元测试
deliverables/  生成的真实结果、参数、评估与诊断文件
```

除开发期用 Playwright 做无头界面自检外，运行时无第三方依赖（PNG 编解码由 `node:zlib` 实现）。
