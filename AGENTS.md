# Factorio Agent 仓库说明

涉及蓝图设计、蓝图库、原生截图或局域网游戏施工时，先读 [.agents/skills/factorio-agent/SKILL.md](.agents/skills/factorio-agent/SKILL.md)。接口说明在 [docs/designer.md](docs/designer.md)。局域网服务器和原生存档的关系在 [docs/architecture.md](docs/architecture.md) 与 [docs/world.md](docs/world.md)。

仓库使用 Node.js 22+ 和标准库。修改后按覆盖范围运行 `npm test`，实体行为可再通过本机隔离场景或测试存档验证。每次施工以玩家所指的服务器、地图表面、阵营、锚点及蓝图修订为准。涉及现有存档时，先读在线状态与目标区域，从操作回执或世界读回核验结果。
