# 设计接口

## 输入从哪里来

先将玩家意图记录为目标物料和每分钟数量、可用进料、水电、版本、星球和模组、每站的编组、建设范围和锁定的铁路接口。配方数据取自目标版本的游戏或已核对的数据源。站场可以按车站和车厢约定交付，具体全网调度按本次范围处理。

离线工具接受 JSON 结构。Codex 决定需要的设备和位置，并可引用已有蓝图组件。计算器核算结果并编出游戏导入字符串。自动排布的覆盖范围由具体的模板或生成器决定。玩家可以在工作台看格网，也可使用原生截图核实视觉效果。

## 调用方式

```powershell
npm start
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/v1/designs' -Method Post -ContentType 'application/json' -InFile 'examples/compact-assembly.json'
```

HTTP 错误包含 `error.code` 和 `error.message`。POST 接收 UTF-8 JSON 对象，单请求上限 4 MiB。默认只在本机 `127.0.0.1` 监听。访问 [OpenAPI JSON](../api/openapi.json) 查看字段及类型，运行时可读 `GET /openapi.json`。

| HTTP 接口 | 功能 |
| --- | --- |
| `GET /api/v1/examples` | 获取示例及相对路径 |
| `POST /api/v1/designs` | 接收设计规格，返回 `document`、`blueprint`、`inspection` 及请求中的量化报告 |
| `POST /api/v1/production/analyze` | 接收配方工序和目标或显式工序速率，返回产量和物料收支 |
| `POST /api/v1/logistics/analyze` | 接收站场、逐车厢物料分配与库存配置 |
| `POST /api/v1/blueprints/encode` | 接收 `{ "document": ... }`，返回 `{ "blueprint": ... }` |
| `POST /api/v1/blueprints/decode` | 接收 `{ "blueprint": ... }`，返回原生 JSON |
| `POST /api/v1/blueprints/inspect` | 接收 `{ "blueprint": ... }`，返回原生 JSON 和实体、车站、地砖、配方等概览 |
| `GET /api/v1/library?q=查询词&key=模块键` | 查询蓝图修订，两参数均可省略 |
| `POST /api/v1/library` | 保存 `{ "key": ..., "blueprint": ..., "label": ..., "tags": ..., "notes": ... }` |
| `GET /api/v1/library/{id}` | 获取一项修订以及可导入字符串 |

CLI 支持相同本地计算。用 `-` 读取标准输入，`--output` 保存结果；`design --exchange` 输出可导入字符串。Node 调用者可从 `lib/index.mjs` 导入 `designBlueprint`、`analyzeProduction`、`analyzeLogistics`、蓝图编解码/检查函数和 `createBlueprintLibrary`。

## 设计规格

- `entities`、`tiles`、`wires`、`schedules` 和 `stock_connections` 采用 Factorio 2.x 蓝图字段。实体至少给出 `name` 和格网中心 `position`。实体编号可显式设置，组件合成时会重排编号、更新导线及相关车辆和时刻表引用。原生实体字段可用于配方、站名、限额和请求箱设置。
- `blocks` 可引用单张蓝图，例如 `{ "id": "station", "source": "...exchange string...", "offset": { "x": 0, "y": 100 } }`。偏移量用整格，以保留半格对齐。跨组件接线用 `links` 的 `from`、`to`，每端给出 `block`、原组件 `entity` 编号和 `connector`。根布局可省略 `block`。旋转、镜像、轨道网格对齐和设备覆盖需要按目标模块核实。
- `metadata` 用于整张蓝图的附加字段，如 `snap-to-grid`。`version` 默认对应 Factorio 2.1.25，组件的版本更高时会提高推断版本。适用旧版时应传入目标版本，并运行对应版本的引擎验证。
- `production` 可计算机器数和物料收支。`logistics` 可检查车站合同，并从输出蓝图核对计划站名是否存在。静态检查主要覆盖结构和引用。碰撞、铁路细部连接、物流与水电需要引擎验证。 [示例设计](../examples/compact-assembly.json) · [原生接线结构](https://lua-api.factorio.com/latest/concepts/BlueprintWire.html)

## 产量与物料

每道工序包含 `recipe`、单次配方时间 `seconds`、设备速度 `speed`、每次消耗 `ingredients` 与每次产出 `products`。可以指定 `count`。在设计请求中，若指定 `machine` 而省略 `count`，会按输出蓝图里该原型加配方的组合计数。熔炉等运行时根据原料决定配方的设备，可以显式指定数量。

`targets` 用每游戏分钟的物料数量表示。只有单一生产工序供给的无环配方链可以自动推算。将允许外购且不在模块内生产的物料填到 `external`。对有环、同一物料有多种供给方式或需特定混合比例的方案，给全部工序设置 `runsPerMinute` 来核算平衡。结果给出 `feasible`、缺口、设备负载、进口和副产物。没有内部生产工序的原料会出现在 `imports`，核对它们是否包含在玩家允许的站口中。期望副产率、插件、品质和信标需用所选版本的有效参数显式建模。

R12 示例以每分钟 12 个物流机器人和石油气直供计算。若希望只用轻油裂解，将 `petroleum-gas` 从示例的 `external` 删去，再检查轻油和水的输入。报告是配方与容量的理论值。游戏实测应记录供料、电、水、科技、预热和采样时间，并以成品仓或出站车厢的增量为准。 [R12 计算规格](../examples/r12-production.json) · [官方配方 API](https://lua-api.factorio.com/latest/classes/LuaRecipe.html)

## 车站、候车和独立仓储

在 `logistics` 中定义 `module` 及各站的固定 `sequence`。新站以 `模块-两位编号 用途｜物料或股道` 生成中文名，既有站名可用 `name` 保留。入料和出料的编组各自配置，逐节填写车厢类型、容量和物料分区。货厢用格数与堆叠大小，液罐按单一流体的数量。分配的车厢容量和实际送货批量可分别指定。

队列站用 `serves` 指向工作站编号，报告会按所有服务编组计算最大车数和所需股道长度。股道长度来自该设计的测量或约定，单位为格。按各物料的处理速率、出入料批量和留存分钟数计算可接受送货时的库存上界、可出车的库存下界、独立仓储容量和续产时间。站场报告中的缺口、蓝图站名匹配情况和 stock 阈值均可供 agent 使用，泵和机械臂与指定车厢对位另用游戏验证。 [不同编组示例](../examples/rail-logistics.json)

## 蓝图库

同一个 `key` 可保存多个修订。 `key` 为小写英文字母、数字和连字符，标题和标签可用中文。每项记录有 `id`、原字符串的 `blueprintSha256`、写入时间和分类。相同键、蓝图及元信息重复提交得到同一修订。需要同一施工图时，用 ID 取回并导出；变化后的蓝图用同一键另存修订。支持单张蓝图和蓝图书。运行时备份整个 `out/library`，自定义位置则备份 `FACTORIO_LIBRARY_DIR`。

```powershell
node cli.mjs library add r12 examples/r12/robot-district-book.txt --label 'R12 蓝图书' --tag 铁路
node cli.mjs library list --key r12
$revisionId = (node cli.mjs library list --key r12 | ConvertFrom-Json)[0].id
node cli.mjs library get $revisionId --exchange --output out/revision.txt
```

内置 R12 例子的调试数据和原生验证按文件哈希关联。历史原生报告计算输入文件的完整字节哈希；蓝图库计算去掉首尾空白后的交换字符串哈希。写入输出文件时，CLI 附加换行符。

## 原生测试与截图

工具可读取一张蓝图文件，例如用 `node native/native-factorio.mjs render out/assembly.txt --game space-age --output-dir out/assembly-preview`。工具用一次性场景和独立配置启动同版本 Factorio，并自动结束独立预览进程。 `validate` 只运行无界面验收， `render` 调用本机图形客户端。可以用 `--game base` 切换原版，`--factorio` 或 `FACTORIO_EXE` 指定可执行文件，`--timeout` 指定秒数。用新的输出目录保存每次截图。蓝图书先选定并导出单个页面。第三方模组和特定星球规则需对应环境另测。

原生 JSON 中有版本、模组、输入文件哈希、实际实体数、方向、车站等核验结果。网页格网由蓝图布局实时绘制，使用已知原型的占地及轨道连接数据。未知或部分支持的原型可用原生截图复核。 [游戏截图 API](https://lua-api.factorio.com/latest/classes/LuaGameScript.html#take_screenshot)
