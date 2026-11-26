# Factorio Agent

玩家定目标、选方案和决定施工。Codex 可以在本地把工厂需求转成可计算的设计规格、可导入的 Factorio 蓝图及预览，再按指定坐标向局域网存档提交施工。仓库包含一个独立的蓝图库，按模块保存修订。

## 启动网页

需要 Node.js 22 或以上。仓库没有 npm 运行依赖。

```powershell
Set-Location E:\FactorioAgent
npm start
```

打开 [本地蓝图工作台](http://127.0.0.1:8787/)。可加载 R12、粘贴蓝图或蓝图书、提交 JSON 设计规格、查看格网及车站、下载蓝图，也可保存和搜索修订。默认蓝图库位于 `out/library`，CLI 与网页共用。设置 `FACTORIO_LIBRARY_DIR` 可以选择其他目录。

## 不开游戏完成设计

```powershell
New-Item -ItemType Directory -Force out | Out-Null
node cli.mjs design examples/compact-assembly.json --exchange --output out/assembly.txt
node cli.mjs production examples/r12-production.json
node cli.mjs logistics examples/rail-logistics.json
node cli.mjs library add r12 examples/r12/robot-district-integrated.txt --tag 铁路 --tag 物流机器人
node cli.mjs library list --query 机器人
```

用 `node cli.mjs --help` 查看编码、解码、检查、导出等命令。HTTP API 提供同样的计算和蓝图库操作。Node 程序可直接从 `lib/index.mjs` 导入函数。 [设计规格与 API](docs/designer.md) · [OpenAPI](api/openapi.json)

## 用本机 Factorio 预览和验证

```powershell
node native/native-factorio.mjs validate out/assembly.txt --game space-age
node native/native-factorio.mjs render out/assembly.txt --game space-age --output-dir out/assembly-preview
```

`validate` 调用游戏引擎检查导入、建成实体和地砖、位置、朝向及车站接轨。`render` 启动本机图形客户端，在隔离场景中生成 `native-blueprint.png` 与含蓝图哈希的 JSON。工具会探测 Steam 安装，也可指定 `--factorio` 或 `FACTORIO_EXE`。需要 Factorio 2.1.24 或以上，Steam 版渲染时需要 Steam 在本机运行。 [原生预览使用说明](docs/designer.md#原生测试与截图)

## 使用局域网存档

玩家在多人游戏中直连 `192.168.5.110:34197`。Codex 的连接走 SSH 和服务器内的 RCON。

```powershell
node world/world.mjs status --ssh venblsserver@192.168.5.110 --player VenBls
node world/world.mjs inspect --ssh venblsserver@192.168.5.110 --surface codex-design-test --area=-90,-75,90,75 --type train-stop
```

确认目标地图、阵营、锚点和图纸后，可以先用 `place` 检查区域，再由玩家决定放施工虚影或直接建成实体。部署拓扑、默认存档与验证记录见下列文档。 [世界操作与参数](docs/world.md) · [服务器现状与架构](docs/architecture.md)

## 给下一位 Codex

在此仓库打开会话，调用 `$factorio-agent`。 [仓库技能](.agents/skills/factorio-agent/SKILL.md)

`npm test` 验证离线 API、蓝图库和设计计算。R12 完整示例位于 `examples/r12`，用 `node examples/rebuild-r12.mjs out/r12-rebuild` 可从站场蓝图、接驳数据和生成器重建。该命令使用新目录，便于比较修订。 [R12 接驳说明](examples/r12/module-notes.txt) · [游戏内部署证据](evidence/r12/R12-reloaded.json)
