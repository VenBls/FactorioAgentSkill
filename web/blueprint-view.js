export function createBlueprintViewer(railEndPoints) {
  const element = (id) => document.getElementById(id);
  const canvas = element("bp-canvas");
  const context = canvas.getContext("2d");
  const source = element("bp-source");
  const stationList = element("bp-stations");
  const bookSelect = element("bp-book");
  const gridToggle = element("bp-grid");
  const copyStop = element("bp-copy-stop");
  const types = {
    "train-stop": ["列车停靠站", 2, 2, "#ecad66", "stop"],
    "rail-signal": ["铁路信号", 1, 1, "#9fb77d", "signal"],
    "rail-chain-signal": ["铁路连锁信号", 1, 1, "#ccd89d", "signal"],
    "elevated-straight-rail": ["高架直轨", 2, 2, "#d8c6a9", "rail"],
    "elevated-half-diagonal-rail": ["高架半斜轨", 4, 4, "#d8c6a9", "rail"],
    "elevated-curved-rail-a": ["高架弯轨 A", 5, 3, "#d8c6a9", "rail"],
    "elevated-curved-rail-b": ["高架弯轨 B", 5, 5, "#d8c6a9", "rail"],
    "straight-rail": ["直轨", 2, 2, "#b2a48b", "rail"],
    "half-diagonal-rail": ["半斜轨", 4, 4, "#b2a48b", "rail"],
    "curved-rail-a": ["弯轨 A", 5, 3, "#b2a48b", "rail"],
    "curved-rail-b": ["弯轨 B", 5, 5, "#b2a48b", "rail"],
    "assembling-machine-2": ["组装机 II", 3, 3, "#709cbb", "machine"],
    "assembling-machine-1": ["组装机 I", 3, 3, "#829292", "machine"],
    "assembling-machine-3": ["组装机 III", 3, 3, "#baad67", "machine"],
    "electric-furnace": ["电炉", 3, 3, "#c49970", "machine"],
    "chemical-plant": ["化工厂", 3, 3, "#a5a575", "machine"],
    "oil-refinery": ["炼油厂", 5, 5, "#a5a575", "machine"],
    "storage-tank": ["储液罐", 3, 3, "#aca5ba", "tank"],
    "pump": ["泵", 1, 2, "#82b8b1", "pump"],
    "pipe": ["管道", 1, 1, "#98a8a5", "pipe"],
    "pipe-to-ground": ["地下管道", 1, 1, "#9cab98", "underground"],
    "fast-inserter": ["高速机械臂", 1, 1, "#759eb4", "inserter"],
    "inserter": ["机械臂", 1, 1, "#c5b677", "inserter"],
    "bulk-inserter": ["集装机械臂", 1, 1, "#a6ba76", "inserter"],
    "requester-chest": ["请求箱", 1, 1, "#6eace6", "chest"],
    "passive-provider-chest": ["被动提供箱", 1, 1, "#bb7366", "chest"],
    "steel-chest": ["钢制箱", 1, 1, "#b7c3c1", "chest"],
    "roboport": ["机器人指令平台", 4, 4, "#81ac9f", "roboport"],
    "substation": ["变电站", 2, 2, "#9b9b8d", "pole"],
    "medium-electric-pole": ["中型电线杆", 1, 1, "#c1b4a0", "pole"],
    "big-electric-pole": ["大型电线杆", 2, 2, "#c1b4a0", "pole"],
    "splitter": ["分流器", 2, 1, "#b29856", "belt"],
    "fast-splitter": ["高速分流器", 2, 1, "#b57666", "belt"],
    "express-splitter": ["极速分流器", 2, 1, "#6d9cba", "belt"],
    "underground-belt": ["地下传送带", 1, 1, "#b29856", "belt"],
    "fast-underground-belt": ["高速地下传送带", 1, 1, "#b57666", "belt"],
    "express-underground-belt": ["极速地下传送带", 1, 1, "#6d9cba", "belt"],
    "iron-chest": ["铁箱", 1, 1, "#abbaae", "chest"],
    "wooden-chest": ["木箱", 1, 1, "#b79973", "chest"],
    "small-electric-pole": ["小型电线杆", 1, 1, "#c1b4a0", "pole"],
    "long-handed-inserter": ["长臂机械臂", 1, 1, "#bb765c", "inserter"],
    "transport-belt": ["基础传送带", 1, 1, "#b29856", "belt"],
    "fast-transport-belt": ["高速传送带", 1, 1, "#b57666", "belt"],
    "express-transport-belt": ["极速传送带", 1, 1, "#6d9cba", "belt"],
  };
  const names = {
    "logistic-robot": "物流机器人", "flying-robot-frame": "飞行机器人机架", "engine-unit": "发动机",
    "electric-engine-unit": "电动机", "steel-plate": "钢板", "iron-gear-wheel": "铁齿轮", pipe: "管道",
    lubricant: "润滑油", sulfur: "硫磺", "sulfuric-acid": "硫酸", "light-oil-cracking": "轻油裂解",
    "heavy-oil": "重油", "light-oil": "轻油", "petroleum-gas": "石油气", water: "水", battery: "电池",
    "iron-plate": "铁板", "copper-plate": "铜板", "electronic-circuit": "绿板", "advanced-circuit": "红板",
  };
  const directions = [[0,-1],[1,-2],[1,-1],[2,-1],[1,0],[2,1],[1,1],[1,2],[0,1],[-1,2],[-1,1],[-2,1],[-1,0],[-2,-1],[-1,-1],[-1,-2]]
    .map(([x,y]) => { const length = Math.hypot(x,y); return {x:x/length,y:y/length}; });
  const maxEntities = 30_000;
  let current;
  let currentModels = [];
  let currentDocumentPages = [];
  let selected;
  let grid = false;
  let viewport = { width: 0, height: 0, dpr: 1 };
  let camera = { x: 0, y: 0, scale: 5 };
  let pendingDraw = false;
  const pointers = new Map();
  let gesture;

  function pagesFrom(root, previous = [], depth = 0) {
    if (depth > 15) throw Error("蓝图书嵌套层级太多。");
    if (root?.blueprint && typeof root.blueprint === "object" && !Array.isArray(root.blueprint)) previous.push(root.blueprint);
    if (Array.isArray(root?.blueprint_book?.blueprints)) {
      for (const item of root.blueprint_book.blueprints) pagesFrom(item, previous, depth + 1);
    }
    if (previous.length > 300) throw Error("蓝图书页面太多。");
    return previous;
  }
  function rotate(point, rotation) {
    let {x,y,d} = point;
    for (let step = 0; step < rotation; step++) [x,y] = [-y,x];
    return { x, y, d: (d + rotation * 4) % 16 };
  }
  function railPoints(name, direction) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const points = railEndPoints[name.replace(/^elevated-/, "") + ":" + ((direction - rotation * 4 + 16) % 16)];
      if (points) return points.map((point) => rotate(point, rotation));
    }
    return null;
  }
  function railGeometry(entity) {
    const points = railPoints(entity.name, entity.heading);
    if (!points) return null;
    const [start,end] = points.map(({x,y,d}) => ({ x: x + entity.x, y: y + entity.y, d }));
    const curved = entity.name.includes("curved-rail");
    const handle = Math.hypot(start.x - end.x, start.y - end.y) / 3;
    const a = { x: start.x - directions[start.d].x * handle, y: start.y - directions[start.d].y * handle };
    const b = { x: end.x - directions[end.d].x * handle, y: end.y - directions[end.d].y * handle };
    const samples = Array.from({ length: curved ? 13 : 2 }, (_, i) => {
      if (!curved) return i === 0 ? start : end;
      const t = i / 12, s = 1 - t;
      return { x: s**3 * start.x + 3 * s*s*t * a.x + 3 * s*t*t * b.x + t**3 * end.x,
        y: s**3 * start.y + 3 * s*s*t * a.y + 3 * s*t*t * b.y + t**3 * end.y };
    });
    return { start, end, a, b, curved, samples };
  }
  function boundsOf(entities, pad = 0) {
    return entities.reduce((bounds, entity) => {
      const samples = entity.rail?.samples ?? [
        { x: entity.x - entity.w/2, y: entity.y - entity.h/2 },
        { x: entity.x + entity.w/2, y: entity.y + entity.h/2 },
      ];
      for (const {x,y} of samples) {
        bounds.minX = Math.min(bounds.minX,x - pad);
        bounds.minY = Math.min(bounds.minY,y - pad);
        bounds.maxX = Math.max(bounds.maxX,x + pad);
        bounds.maxY = Math.max(bounds.maxY,y + pad);
      }
      return bounds;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  }
  function versionOf(version) {
    if (!Number.isSafeInteger(version)) return "";
    const v = BigInt(version);
    return [48n,32n,16n].map((shift) => String((v >> shift) & 0xffffn)).join(".");
  }
  function makeModel(blueprint) {
    const entries = blueprint.entities ?? [];
    const version = versionOf(blueprint.version);
    const legacyDirection = version.startsWith("1.") ? 2 : 1;
    if (!Array.isArray(entries) || entries.length > maxEntities) throw Error("实体数量超出预览范围。");
    const entities = entries.filter((entity) =>
      typeof entity?.name === "string" && Number.isFinite(entity.position?.x) && Number.isFinite(entity.position?.y) &&
      Math.abs(entity.position.x) < 10_000_000 && Math.abs(entity.position.y) < 10_000_000
    ).map((entity) => {
      const [label, width, height, color, kind] = Object.hasOwn(types,entity.name) ? types[entity.name] : [entity.name, 1, 1, "#9aa4a1", "unknown"];
      const heading = Number.isInteger(entity.direction) ? ((entity.direction * legacyDirection % 16) + 16) % 16 : 0;
      const quarterTurn = heading === 4 || heading === 12;
      const info = { ...entity, station: typeof entity.station === "string" ? entity.station : undefined, label, color, kind, heading, x: entity.position.x, y: entity.position.y,
        w: quarterTurn ? height : width, h: quarterTurn ? width : height };
      if (kind === "rail") info.rail = railGeometry(info);
      return info;
    });
    const tiles = Array.isArray(blueprint.tiles) ? blueprint.tiles.slice(0, maxEntities).flatMap((tile) => {
      const {x,y} = tile?.position ?? {};
      return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 10_000_000 && Math.abs(y) < 10_000_000
        ? [{ x:x+.5, y:y+.5, w:1, h:1 }] : [];
    }) : [];

    const stops = entities.filter((entity) => entity.kind === "stop")
      .sort((a,b) => (a.station ?? "").localeCompare(b.station ?? "", "zh-CN", {numeric:true}));
    return {
      label: blueprint.label || "导入的蓝图", version, entities, tiles, stops,
      bounds: boundsOf([...entities, ...tiles], 2.5),
      rails: entities.filter((entity) => entity.rail),
      unknown: entities.filter((entity) => entity.kind === "unknown" || entity.kind === "rail" && !entity.rail).length,
    };
  }
  function worldPoint(x, y) {
    return { x: camera.x + (x - viewport.width/2) / camera.scale, y: camera.y + (y - viewport.height/2) / camera.scale };
  }
  function viewPoint({x,y}) {
    return { x: (x - camera.x) * camera.scale + viewport.width/2, y: (y - camera.y) * camera.scale + viewport.height/2 };
  }
  function fit(bounds) {
    if (!bounds || !Number.isFinite(bounds.minX) || !viewport.width) return;
    camera = {
      x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2,
      scale: Math.max(.00001, Math.min((viewport.width-26)/(bounds.maxX-bounds.minX), (viewport.height-26)/(bounds.maxY-bounds.minY), 46)),
    };
    drawSoon();
  }
  function showArea(area) {
    if (!current) return;
    const entities = area === "rail" ? current.entities.filter((entity) => entity.rail || ["stop","pump","tank"].includes(entity.kind))
      : area === "core" ? current.entities.filter((entity) => entity.kind === "machine" || entity.kind === "roboport") : null;
    fit(entities?.length ? boundsOf(entities, area === "core" ? 5 : 3) : current.bounds);
  }
  function zoom(multiplier, x = viewport.width/2, y = viewport.height/2) {
    if (!current) return;
    const world = worldPoint(x,y);
    camera.scale = Math.min(90, Math.max(.000005, camera.scale * multiplier));
    camera.x = world.x - (x - viewport.width/2)/camera.scale;
    camera.y = world.y - (y - viewport.height/2)/camera.scale;
    drawSoon();
  }
  function drawSoon() {
    if (pendingDraw) return;
    pendingDraw = true;
    requestAnimationFrame(() => { pendingDraw = false; draw(); });
  }
  function line(x1,y1,x2,y2, color, width) {
    context.beginPath();
    context.moveTo(x1,y1);
    context.lineTo(x2,y2);
    context.strokeStyle = color;
    context.lineWidth = width;
    context.stroke();
  }
  function pathRail({start,end,a,b,curved}) {
    context.moveTo(start.x,start.y);
    if (curved) context.bezierCurveTo(a.x,a.y,b.x,b.y,end.x,end.y);
    else context.lineTo(end.x,end.y);
  }
  function drawRails(rails) {
    // Each pass keeps the engine-read endpoints continuous through switches.
    for (const [color,width,dash] of [["#252821",1.07,[]],["#6b5f49",.82,[.17,.24]],["#bba995",.46,[]],["#47463c",.25,[]]]) {
      context.beginPath();
      for (const entity of rails) pathRail(entity.rail);
      context.strokeStyle = color;
      context.lineWidth = width;
      context.setLineDash(dash);
      context.stroke();
    }
    context.setLineDash([]);
  }
  function box(x,y,w,h,color,round=.12) {
    context.beginPath();
    context.roundRect(x,y,w,h,round);
    context.fillStyle = color;
    context.fill();
  }
  function disk(x,y,r,color) {
    context.beginPath();
    context.arc(x,y,r,0,2*Math.PI);
    context.fillStyle = color;
    context.fill();
  }
  function drawEntity(entity, pipes) {
    const { x,y,w,h,color,kind,heading,recipe } = entity;
    const ink = "#202723";
    if (kind === "pipe") {
      disk(x,y,.30,ink);
      for (const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        if (pipes.has((x+dx)+","+(y+dy))) {
          line(x,y,x+dx*.57,y+dy*.57,ink,.41);
          line(x,y,x+dx*.57,y+dy*.57,color,.24);
        }
      }
      disk(x,y,.20,color);
      return;
    }
    if (kind === "rail" && entity.rail) return;
    if (["chest","signal","stop","machine","tank","roboport","pole","belt","unknown","rail"].includes(kind)) {
      box(x-w/2+.08,y-h/2+.12,w-.10,h-.10,"#161d18");
      box(x-w/2+.06,y-h/2+.06,w-.12,h-.15,color);
      box(x-w/2+.14,y-h/2+.15,w-.28,h-.28,ink);
    }
    const direction = directions[heading];
    if (kind === "machine" || kind === "tank" || kind === "roboport") {
      disk(x,y,Math.min(w,h)*.32,kind === "tank" ? "#686968" : "#424b41");
      disk(x,y,Math.min(w,h)*.22,color);
      if (camera.scale >= 11 && recipe) {
        context.fillStyle = "#141d19";
        context.font = "bold .58px Microsoft YaHei, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText((names[recipe]||recipe).slice(0,3),x,y+.03);
      }
    } else if (kind === "signal") {
      disk(x,y,.21,entity.name.includes("chain") ? "#a6dce6" : "#a0dc77");
    } else if (kind === "pole") {
      line(x-.24,y+.23,x+.24,y-.23,color,.13);
      line(x-.24,y-.23,x+.24,y+.23,color,.13);
    } else if (kind === "chest") {
      box(x-.29,y-.26,.58,.49,color,.06);
      line(x-.26,y,x+.26,y,ink,.12);
    } else if (kind === "inserter") {
      disk(x,y,.24,ink);
      line(x,y,x+direction.x*.38,y+direction.y*.38,color,.22);
      disk(x,y,.12,color);
    } else if (kind === "pump" || kind === "underground") {
      box(x-w*.40,y-h*.40,w*.8,h*.8,ink);
      disk(x,y,.22,color);
      line(x,y,x+direction.x*.35,y+direction.y*.35,color,.14);
    } else if (kind === "stop" || kind === "belt") {
      const tx = x + direction.x*.32, ty = y+direction.y*.32;
      line(tx,ty,x-direction.x*.18-direction.y*.20,y-direction.y*.18+direction.x*.20,color,.16);
      line(tx,ty,x-direction.x*.18+direction.y*.20,y-direction.y*.18-direction.x*.20,color,.16);
    } else {
      disk(x,y,.21,color);
    }
  }
  function labelAt(text, point, active = false) {
    const {x,y} = viewPoint(point);
    if (x < -30 || x > viewport.width+30 || y < -30 || y > viewport.height+30) return;
    context.font = (active ? "700 " : "600 ") + "13px Microsoft YaHei, sans-serif";
    context.textBaseline = "middle";
    context.textAlign = "left";
    const width = context.measureText(text).width + 14;
    const left = Math.min(viewport.width - width - 4, Math.max(4,x + 9));
    box(left, y-10, width, 20, active ? "#2e3f35" : "#18231fea", 4);
    context.fillStyle = active ? "#d6f4ba" : "#f3deb8";
    context.fillText(text,left+7,y+.4);
  }
  function draw() {
    if (!viewport.width || !viewport.height) return;
    const {width,height,dpr} = viewport;
    context.setTransform(dpr,0,0,dpr,0,0);
    context.fillStyle = "#222b23";
    context.fillRect(0,0,width,height);
    if (!current || !Number.isFinite(current.bounds.minX)) {
      element("bp-position").textContent = "";
      return;
    }
    const topLeft = worldPoint(0,0), bottomRight = worldPoint(width,height);
    context.transform(camera.scale,0,0,camera.scale,width/2-camera.x*camera.scale,height/2-camera.y*camera.scale);
    const {minX,minY,maxX,maxY} = current.bounds;
    context.fillStyle = "#474d3d";
    context.fillRect(minX,minY,maxX-minX,maxY-minY);
    for (const tile of current.tiles) box(tile.x-.5,tile.y-.5,1,1,"#777e6b",0);
    drawRails(current.rails);
    for (const entity of current.entities) {
      if (entity.x >= topLeft.x-5 && entity.x <= bottomRight.x+5 && entity.y >= topLeft.y-5 && entity.y <= bottomRight.y+5) {
        drawEntity(entity,current.pipes);
      }
    }
    if (grid && camera.scale >= 2) {
      const step = camera.scale >= 8 ? 1 : 5;
      for (let x = Math.floor(topLeft.x/step)*step; x < bottomRight.x; x += step) line(x,topLeft.y,x,bottomRight.y,"#d6dfcb37",.8/camera.scale);
      for (let y = Math.floor(topLeft.y/step)*step; y < bottomRight.y; y += step) line(topLeft.x,y,bottomRight.x,y,"#d6dfcb37",.8/camera.scale);
    }
    if (selected) {
      context.setLineDash([]);
      context.strokeStyle = "#e1f5a9";
      context.lineWidth = 2/camera.scale;
      if (selected.rail) {
        context.beginPath();
        pathRail(selected.rail);
        context.stroke();
      } else {
        context.strokeRect(selected.x-selected.w/2,selected.y-selected.h/2,selected.w,selected.h);
      }
    }
    context.setTransform(dpr,0,0,dpr,0,0);
    if (camera.scale >= 3 || selected) {
      for (const stop of current.stops) {
        const marker = stop.station?.split(" ")[0] || "车站";
        labelAt(marker,stop,selected === stop);
      }
    }
    element("bp-position").textContent = Math.round(camera.scale * 10)/10 + " 像素/格";
  }
  function segmentsDistance({x,y}, samples) {
    let distance = Infinity;
    for (let i = 1; i < samples.length; i++) {
      const p = samples[i-1], q = samples[i], u = q.x-p.x, v = q.y-p.y;
      const along = Math.min(1,Math.max(0,((x-p.x)*u+(y-p.y)*v)/(u*u+v*v)));
      distance = Math.min(distance,Math.hypot(p.x+u*along-x,p.y+v*along-y));
    }
    return distance;
  }
  function hit(point) {
    if (!current) return;
    const objects = current.entities.filter((entity) => !entity.rail &&
      Math.abs(entity.x-point.x) <= entity.w/2+.05 && Math.abs(entity.y-point.y) <= entity.h/2+.05)
      .sort((a,b) => Math.hypot(a.x-point.x,a.y-point.y) - Math.hypot(b.x-point.x,b.y-point.y));
    if (objects.length) return objects[0];
    const closeRails = current.rails.filter((entity) => Math.abs(entity.x-point.x) <= 5 && Math.abs(entity.y-point.y) <= 5);
    return closeRails.map((entity) => [entity,segmentsDistance(point,entity.rail.samples)])
      .filter(([,distance]) => distance < .42).sort((a,b) => a[1] - b[1])[0]?.[0];
  }
  function selectEntity(entity, locate = false) {
    selected = entity;
    element("bp-detail").textContent = entity?.station || entity?.label || "实体检查";
    element("bp-entity-meta").textContent = entity
      ? "坐标 (" + entity.x + ", " + entity.y + ") · 朝向 " + entity.heading + " / 16 · #" + (entity.entity_number ?? "–")
      : "点击地图上的站台、泵、机器或其他实体。";
    const fields = entity ? [
      entity.recipe && "配方 · " + (names[entity.recipe] ?? entity.recipe),
      Number.isFinite(entity.manual_trains_limit) && "站点限额 · " + entity.manual_trains_limit + " 列",
      Array.isArray(entity.filters) && entity.filters.length && "过滤 · " + entity.filters.map((filter) => names[filter?.name] ?? filter?.name ?? "").filter(Boolean).join("、"),
      entity.fluid_filter && "流体过滤 · " + (names[entity.fluid_filter] ?? entity.fluid_filter),
    ].filter(Boolean) : [];
    element("bp-entity-data").textContent = fields.join(" / ");
    copyStop.hidden = !entity?.station || !navigator.clipboard;
    copyStop.textContent = "复制游戏站名";
    [...stationList.querySelectorAll("button")].forEach((button) => button.setAttribute("aria-pressed", String(Boolean(entity && String(entity.entity_number) === button.dataset.entity))));
    if (locate && entity) {
      camera.x = entity.x - (viewport.width > 620 ? 8 : 0);
      camera.y = entity.y;
      camera.scale = Math.max(camera.scale,viewport.width < 500 ? 12 : 15);
    }
    drawSoon();
  }
  function updateSource() {
    if (!current) return;
    const parts = [current.entities.length + " 个实体", current.tiles.length + " 块地砖", current.version && "Factorio " + current.version];
    if (current.unknown) parts.push(current.unknown + " 个实体用占位");
    source.textContent = parts.filter(Boolean).join(" · ");
    element("map-title").textContent = current.label;
  }
  function display(model) {
    current = model;
    current.pipes = new Set(current.entities.filter((entity) => ["pipe","underground","pump"].includes(entity.kind)).map((entity) => entity.x + "," + entity.y));
    stationList.replaceChildren();
    for (const stop of current.stops) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.entity = String(stop.entity_number);
      const [id = "", ...words] = (stop.station || "").split(" ");
      const index = document.createElement("span");
      index.className = "station-code";
      index.style.setProperty("--station-color",stop.station?.includes("出料") ? "#f2b975" : stop.station?.includes("候车") ? "#c0d473" : "#82dfcc");
      index.textContent = /^R\d+-\d+$/.test(id) ? id : "#" + stop.entity_number;
      const name = document.createElement("span");
      name.textContent = words.length && /^R\d+-\d+$/.test(id) ? words.join(" ") : (stop.station || "未命名车站");
      button.append(index,name);
      button.addEventListener("click",() => selectEntity(stop,true));
      stationList.append(button);
    }
    if (!current.stops.length) stationList.textContent = "当前蓝图无列车停靠站。";
    selectEntity(null);
    updateSource();
    showArea("all");
  }
  function size() {
    const {width,height} = canvas.getBoundingClientRect();
    if (width < 2 || height < 2) return;
    const dpr = Math.min(2,devicePixelRatio || 1);
    const first = !viewport.width;
    viewport = {width,height,dpr};
    canvas.width = Math.round(width*dpr);
    canvas.height = Math.round(height*dpr);
    if (first || !Number.isFinite(camera.scale)) showArea("all");
    drawSoon();
  }
  new ResizeObserver(size).observe(canvas);
  function eventPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x:event.clientX-rect.left, y:event.clientY-rect.top };
  }
  function midMetrics() {
    const [a,b] = pointers.values();
    return b ? {x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y)} : {x:a.x,y:a.y,d:0};
  }
  canvas.addEventListener("pointerdown",(event) => {
    if (event.button !== 0 || pointers.size >= 2) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,eventPoint(event));
    gesture = { ...midMetrics(), dragged:pointers.size > 1, travel:0 };
  });
  canvas.addEventListener("pointermove",(event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId,eventPoint(event));
    const next = midMetrics();
    const dx = next.x-gesture.x, dy = next.y-gesture.y;
    gesture.travel += Math.hypot(dx,dy);
    const dragged = gesture.dragged || gesture.travel > 3;
    if (dragged) {
      camera.x -= dx/camera.scale;
      camera.y -= dy/camera.scale;
      if (gesture.d > 4 && next.d > 4) zoom(next.d/gesture.d,next.x,next.y);
      drawSoon();
    }
    gesture = { ...next, travel:gesture.travel, dragged };
  });
  function pointerEnd(event) {
    if (!pointers.has(event.pointerId)) return;
    const point = eventPoint(event);
    pointers.delete(event.pointerId);
    if (pointers.size) gesture = { ...midMetrics(), dragged:true, travel:0 };
    else if (event.type === "pointerup" && !gesture.dragged) selectEntity(hit(worldPoint(point.x,point.y)));
  }
  canvas.addEventListener("pointerup",pointerEnd);
  canvas.addEventListener("pointercancel",pointerEnd);
  canvas.addEventListener("lostpointercapture",pointerEnd);
  canvas.addEventListener("wheel",(event) => {
    event.preventDefault();
    const {x,y} = eventPoint(event);
    zoom(Math.exp(Math.max(-150,Math.min(150,-event.deltaY))*.0022),x,y);
  },{passive:false});
  canvas.addEventListener("keydown",(event) => {
    const distance = 48/camera.scale;
    const commands = {
      "+":() => zoom(1.28), "=":() => zoom(1.28), "-":() => zoom(1/1.28), "0":() => showArea("all"),
      ArrowLeft:() => {camera.x-=distance;}, ArrowRight:() => {camera.x+=distance;},
      ArrowUp:() => {camera.y-=distance;}, ArrowDown:() => {camera.y+=distance;},
    };
    if (!Object.hasOwn(commands,event.key)) return;
    event.preventDefault();
    commands[event.key]();
    drawSoon();
  });
  element("bp-plus").addEventListener("click",() => zoom(1.3));
  element("bp-minus").addEventListener("click",() => zoom(1/1.3));
  gridToggle.addEventListener("click",() => {
    grid = !grid;
    gridToggle.setAttribute("aria-pressed",String(grid));
    drawSoon();
  });
  copyStop.addEventListener("click",async () => {
    if (!selected?.station) return;
    try {
      await navigator.clipboard.writeText(selected.station);
      copyStop.textContent = "已复制站名";
    } catch {
      copyStop.textContent = "可选中上方站名复制";
    }
  });
  document.querySelectorAll("[data-blueprint-view]").forEach((button) => button.addEventListener("click",() => showArea(button.dataset.blueprintView)));
  bookSelect.addEventListener("change", () => {
    const index = Number(bookSelect.value);
    try {
      display(currentModels[index] ??= makeModel(currentDocumentPages[index]));
    } catch (error) {
      source.textContent = error.message;
    }
  });

  function displayDocument(document) {
    const pages = pagesFrom(document);
    if (!pages.length) throw Error("蓝图书中没有可预览的蓝图页面。");
    const initial = makeModel(pages[0]);
    currentModels = [initial];
    currentDocumentPages = pages;
    bookSelect.replaceChildren(...pages.map((page, index) => new Option(page.label || "蓝图 " + (index + 1), String(index))));
    bookSelect.hidden = pages.length < 2;
    display(initial);
  }
  size();
  return { displayDocument };
}
