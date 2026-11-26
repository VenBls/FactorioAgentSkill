# 连接正在运行的 Factorio 存档

从仓库根目录运行以下 PowerShell 命令。游戏客户端通过 `192.168.5.110:34197` 加入 Factorio 2.1.25 + 太空时代实验服。命令行工具通过现有 SSH 登录同一台主机，再由服务器上的 RCON 客户端连接本机 `127.0.0.1:27015`。Lua 命令读写服务器当前加载的地图，之后由 Factorio 向联机客户端同步。网页设计器在本机生成交付物，这条游戏操作链单独运行。 [Factorio RCON](https://lua-api.factorio.com/latest/classes/LuaRCON.html)

```powershell
$labSsh = 'venblsserver@192.168.5.110'
node world/world.mjs status --ssh $labSsh --player VenBls
node world/world.mjs inspect --ssh $labSsh --surface codex-design-test --area=-90,-72,90,72 --type train-stop
node world/place-design.mjs --ssh $labSsh --blueprint examples/r12/robot-district-integrated.txt --check-only
```

`status` 返回当前地图的星球或地图表面 `surfaces`、阵营 `forces`、加载的模组及在线玩家。通过 `--player` 还可查询指定玩家最后的位置、地图表面和在线状态。执行施工前用它确认目标及当前玩家是否在指定表面。

`inspect` 按 `--area=左,上,右,下` 读取当前地图中的实体。可用 `--force`、`--name`（如 `assembling-machine-2`）、`--type`（如 `train-stop` 或 `entity-ghost`）、`--ghost-name` 筛选。返回范围内的总数和最多 12 条记录。需要核对更多实体时，按边界切小区域查询。装配机和熔炉可读回配方，车站可读回中文名称、车站限额和接轨状态。查询范围包含碰到矩形边界的实体，按 `unit` 去除查询重叠。

第三条命令使用已验证的 R12 验收入口，逐页核对 `codex-design-test` 的 857 个真实实体、接轨的 7 座中文车站和归一化几何摘要。验收依赖蓝图文件原始字节的 SHA-256 以及现有表面上的施工记录。新蓝图使用下一节的通用入口。

## 从交付蓝图到指定地图

拿到玩家指定的目标地图、阵营和施工位置后，先从设计 API 导出一张 Factorio 蓝图字符串并保存为文本。坐标采用游戏里的正常蓝图放置位置，Factorio 根据蓝图尺寸和网格设置定位，实体中心未必等于该坐标。使用 `place` 先读取目标证据，再在玩家明确要求施工时加 `--apply`。已有设施需要改造时，可先在地图副本验证，再由玩家以正常游戏操作接入既有设施。

```powershell
# 替换为本次设计和玩家给定的参数。
$blueprint = 'out/factory.txt'
$surface = 'codex-design-test'
$force = 'player'
$at = '240,0'
$placement = @('--ssh', $labSsh, '--blueprint', $blueprint, '--surface', $surface, '--force', $force, "--at=$at")

node world/world.mjs place @placement
node world/world.mjs place @placement --apply
```

- 预览报告的 `target.area` 是工具检查的施工矩形，`ready` 说明矩形已经生成且没有现有建筑、轨道、幽灵、玩家或其他实体挡住施工。资源矿点可以留在区域里。矩形给游戏原生对齐留有余量，因此可能大于蓝图在地图上的实际面积。地形、配方、车站就位和贴地限制最终由匹配版本的引擎判断。
- 默认模式 `ghost` 使用原生正常放置模式，提交后留下建筑及地砖幽灵。玩家可手动施工，或由有货、有覆盖的建筑机器人施工。
- 在玩家明确要求并接受直接施工时，可用 `--mode built` 预览，再使用同一参数加 `--apply`。该模式接受仅含实体的蓝图，使用脚本将建筑幽灵实体化。它使用管理员能力，不扣玩家库存。它适合实验服和授权的新建区域。
- 工具在执行原生放置前再次检查同一个目标。原生返回的幽灵数量或位置与预期不符时，工具撤掉这次调用返回的幽灵并报告 `rejected`。`partial` 或 `uncertain` 时，必须以实际地图中的实体为准，先读回目标与回执再决定如何修正。

```powershell
node world/world.mjs receipt --ssh $labSsh --id '<place 返回的 placementId>'
node world/world.mjs inspect --ssh $labSsh --surface $surface --area=210,-30,270,30 --force $force
```

成功回执包含放置数量、实际中心点坐标范围 `boundsOfCenters` 和游戏 tick。再用 `inspect` 核对关键实体、车站接轨和生产配方。回执保存在当前存档中，能确认施工请求的结果，玩家后续拆建以实时实体为准。遇到连接断开先查 `receipt`。同一份蓝图、位置、模式及请求标识会复用已有回执。玩家明确要求在已经清空的同一位置发起一次新施工时，用新的 `--request` 标签。 [蓝图原生放置](https://lua-api.factorio.com/latest/classes/LuaItemStack.html#build_blueprint) · [幽灵实体化](https://lua-api.factorio.com/latest/classes/LuaEntity.html#silent_revive)

## 连接与运行细节

- `--ssh` 默认调用远端 `D:\Factorio-Lab\codex-worker\factorio-rcon.mjs`，由该文件从 `D:\Factorio-Lab\server\config\rcon-password` 读取凭据。采用 Windows OpenSSH 和服务器本机 Node.js。可用 `--remote-worker`、`--password-file`、`--port` 覆盖目标主机路径和其回环端口。凭据由服务器保管。
- 对本机隔离测试服，去掉 `--ssh`，传本机的 `--port` 和 `--password-file`，或用 `FACTORIO_RCON_PASSWORD`。当前实验服已启用管理员 Lua。对首次使用管理员 Lua 的新存档，Factorio 会提示确认并停用成就，应在接受此影响的实验存档中启用。
- 老版 R12 验收脚本仍可在独立实验存档中不加 `--check-only` 建立专用表面，再用可选的 `--save-name` 请求快照。通用工具在指定的既有表面施工，执行结果由服务器原有的保存机制持久化。
- 本仓库验证时，对联机存档执行了在线状态、7 座车站和 857 个实体的只读核对。另在本机 2.1.25 + 太空时代的独立测试存档中，用通用入口建成了 857 个 R12 实体，并在另一块区域放置了建筑和地砖幽灵。产量、火车装卸和真实运行需要在接通供料、轨道和电力后单独测量。
