---
name: factorio-agent
description: 设计、计算、预览和管理 Factorio 工厂蓝图，并按玩家指定的范围在局域网联机存档中检查或放置蓝图。适用于铁路棋盘格、仓储装卸、流水线产量、原生截图和服务器施工。
---

# Factorio Agent

以玩家给定的目标和当前地图为准。代码与示例位于此技能所在的仓库，默认根目录为 `E:\FactorioAgent`。从仓库根目录运行命令。

## 设计与交付

1. 把目标产量、允许输入、版本与模组、水电、选址和保留的设施写进本次任务。按玩家指定的编组分别设计入料、出料和排队。车站用固定中文编号，保留既有时刻表引用。独立核算入料和出料缓冲，候车位按会使用该股道的最长编组核对。铁路棋盘格以车站与车厢作为模块接口，全局路线由任务范围决定。
2. 从匹配版本的配方数据计算物料和设备。用 `node cli.mjs production <spec>` 和 `node cli.mjs logistics <spec>` 检查，也可在设计请求里同时计算。遇到产能不足时，按工序 `requiredCount` 更新布局，再查 `production.feasible` 与物料供给。按规格写实体、地砖、导线，或通过 `blocks` 拼已有组件。用 `node cli.mjs design <spec> --exchange --output <blueprint.txt>` 生成 Factorio 字符串。对工艺歧义先给可比较的条件和结果，记录未确定的输入。
3. 用 `npm start` 打开本地工作台，或读取 `GET /openapi.json` 直接调用 HTTP。需要保留修订时，用 `node cli.mjs library add <key> <blueprint.txt>` 保存并记录哈希和修订 ID。需要按游戏画面预览时，调用 `node native/native-factorio.mjs render <blueprint.txt> --game space-age --output-dir <new-folder>`。使用 `validate` 做无界面导入和建造检查。单页才可提交验证和施工。
4. 交付可导入蓝图、接口、计算假设和验证结果。明确理论产量、游戏实测的条件与采样窗口，以及仍需要在目标存档接好的接口。

字段、命令和可运行示例见 [设计接口](../../../docs/designer.md)。既有铁路工厂示例见 [R12](../../../examples/r12/module-notes.txt)。

## 按玩家要求在游戏施工

查看 [联机操作](../../../docs/world.md) 和 [当前服务器配置](../../../docs/architecture.md)。先用 `world/world.mjs status` 和 `inspect` 确认服务器正在跑的地图、队伍与现场，再以玩家指定的阵营、表面和锚点执行 `place` 检查。先给玩家看方案的请求到设计交付为止。玩家已要求施工且范围明确时，给同一请求加 `--apply`。默认放施工幽灵。玩家要求管理员直接建成时，使用 `--mode built` 并告知实体直接写入存档。已占用的现有工厂先根据本次改造需求在副本核实。

施工后记录回执并用 `inspect` 读回关键实体。超时或结果不明时先查回执和实际世界。游戏端 RCON 凭据在服务器上读取。首次在新存档启用脚本命令可能影响成就。
