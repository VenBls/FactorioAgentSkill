import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { inflateSync } from 'node:zlib';
import { connectionOptions, createRconCaller, luaString } from './rcon-lua.mjs';

const help = `Usage: node world/world.mjs COMMAND [options]
  status   [--player NAME]
  inspect  --surface NAME --area=L,T,R,B [--force NAME] [--type TYPE] [--name PROTOTYPE] [--ghost-name PROTOTYPE] [--limit 12]
  place    --blueprint PATH --surface NAME --force NAME --at=X,Y [--mode ghost|built] [--request LABEL] [--apply]
  receipt  --id PLACEMENT_ID
Connection: --ssh USER@HOST [--remote-worker PATH] [--password-file PATH] [--port 27015] [--timeout-ms 45000].
Omit --ssh only when a local Factorio RCON service is available. Without --apply, place only checks the target.`;

const storageKey = 'factorio_agent_placements_v1';
const entityLimit = 5000;
const blueprintSizeLimit = 256 * 1024;
const chunkSize = 2700;
const digest = (value) => createHash('sha256').update(value).digest('hex');

const flags = {
  status: ['player'],
  inspect: ['surface', 'area', 'force', 'type', 'name', 'ghost-name', 'limit'],
  place: ['blueprint', 'surface', 'force', 'at', 'mode', 'request', 'apply'],
  receipt: ['id'],
};

function textOption(options, name) {
  const value = options[name];
  if (!value || Buffer.byteLength(value) > 126 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`--${name} requires a nonempty name of at most 126 UTF-8 bytes.`);
  }
  return value;
}

function coordinates(value, size, name) {
  const pieces = value?.split(',').map((item) => item.trim());
  if (pieces?.length !== size || pieces.some((item) => !/^-?\d+(?:\.\d+)?$/.test(item)
    || Math.abs(Number(item)) > 1_000_000)) {
    throw new Error(`--${name} requires ${size} comma-separated map coordinates within ±1,000,000.`);
  }
  return pieces.map(Number);
}

function areaBounds(value) {
  const [left, top, right, bottom] = coordinates(value, 4, 'area');
  if (right <= left || bottom <= top || right - left > 1024 || bottom - top > 1024) {
    throw new Error('Use a positive --area up to 1024 by 1024 tiles.');
  }
  return [left, top, right, bottom];
}

function luaArea([left, top, right, bottom]) {
  return `{{${left},${top}},{${right},${bottom}}}`;
}

function arrays(reply, keys) {
  for (const key of keys) if (reply[key] && !Array.isArray(reply[key]) && Object.keys(reply[key]).length === 0) reply[key] = [];
  return reply;
}

function status(options, call) {
  const playerName = options.player && textOption(options, 'player');
  return arrays(call(`
    local ss,fs,ps={},{},{}
    local function pos(p) return {name=p.name,surface=p.surface.name,force=p.force.name,position=p.position,online=p.connected} end
    local p=${playerName ? `game.get_player(${luaString(playerName)})` : 'nil'}
    for _,s in pairs(game.surfaces) do if #ss<20 then ss[#ss+1]={name=s.name,index=s.index} end end
    for _,f in pairs(game.forces) do if #fs<20 then fs[#fs+1]={name=f.name,index=f.index} end end
    for _,c in pairs(game.connected_players) do if #ps<8 then ps[#ps+1]=pos(c) end end
    return {tick=game.tick,multiplayer=game.is_multiplayer(),mods=script.active_mods,
      surfaces=ss,forces=fs,connectedPlayers=ps,onlineCount=#game.connected_players,
      selectedPlayer=p and pos(p) or nil${playerName ? `,requestedPlayer=${luaString(playerName)}` : ''}}
  `), ['surfaces', 'forces', 'connectedPlayers']);
}

function inspect(options, call) {
  const surface = textOption(options, 'surface');
  const area = areaBounds(options.area);
  const limit = Number(options.limit ?? 12);
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('--limit must be an integer from 1 to 12.');
  const filters = { force: 'force', type: 'type', name: 'name', 'ghost-name': 'ghost_name' };
  const selector = Object.entries(filters).filter(([flag]) => options[flag] !== undefined)
    .map(([flag, key]) => `,${key}=${luaString(textOption(options, flag))}`).join('');
  return arrays(call(`
    local s=assert(game.get_surface(${luaString(surface)}),"Surface not found")
    local q={area=${luaArea(area)}${selector}}
    local n=s.count_entities_filtered(q)
    q.limit=${limit}
    local es={}
    for _,e in ipairs(s.find_entities_filtered(q)) do
      local t={name=e.name,type=e.type,position=e.position,direction=e.direction,unit=e.unit_number,force=e.force.name,quality=e.quality.name}
      if e.type=="entity-ghost" or e.type=="tile-ghost" then t.ghostName=e.ghost_name end
      if e.type=="train-stop" then t.station=e.backer_name; t.connectedRail=e.connected_rail~=nil; t.trainsLimit=e.trains_limit end
      if e.type=="assembling-machine" or e.type=="furnace" then local r=e.get_recipe(); t.recipe=r and r.name end
      es[#es+1]=t
    end
    return {tick=game.tick,surface=s.name,surfaceIndex=s.index,total=n,entities=es}
  `), ['entities']);
}

function readBlueprint(path, mode) {
  if (!path) throw new Error('--blueprint is required.');
  const bytes = readFileSync(path);
  const exchange = bytes.toString('utf8').trim();
  if (exchange.length > blueprintSizeLimit || !/^0(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(exchange)) {
    throw new Error('Provide a valid Factorio blueprint exchange string of at most 256 KiB.');
  }
  const { blueprint } = JSON.parse(inflateSync(Buffer.from(exchange.slice(1), 'base64'), { maxOutputLength: 8 * 1024 * 1024 }));
  const entities = blueprint?.entities ?? [];
  const tiles = blueprint?.tiles ?? [];
  if (!blueprint || !Array.isArray(entities) || !Array.isArray(tiles) || !(entities.length + tiles.length)
      || entities.length + tiles.length > entityLimit) {
    throw new Error('Provide one nonempty single blueprint with up to 5000 entities and tiles combined.');
  }
  if (mode === 'built' && tiles.length > 0) throw new Error('Built mode uses entity-only blueprints. Use ghost mode for tiles.');
  for (const row of [...entities, ...tiles]) {
    if (typeof row?.name !== 'string' || !row.name || row.name === 'character' || Buffer.byteLength(row.name) > 126
        || !Number.isFinite(row?.position?.x) || !Number.isFinite(row?.position?.y)) {
      throw new Error('Blueprint entries must have a supported prototype name and finite position.');
    }
  }
  return { blueprint, entities, tiles, exchange, sha256: digest(bytes) };
}

function placementArea(design, at, call) {
  const names = [...new Set(design.entities.map(({ name }) => name))];
  let padding = 4;
  for (let start = 0; start < names.length; start += 12) {
    const batch = names.slice(start, start + 12).map(luaString).join(',');
    const size = call(`
      local m=0
      for _,n in ipairs({${batch}}) do
        local e=assert(prototypes.entity[n],"Unknown entity prototype "..n)
        local b=e.collision_box
        m=math.max(m,e.tile_width,e.tile_height,
          math.abs(b.left_top.x)+math.abs(b.left_top.y),math.abs(b.right_bottom.x)+math.abs(b.right_bottom.y))
      end
      return m
    `);
    padding = Math.max(padding, Math.ceil(size) + 2);
  }

  const { blueprint, entities, tiles } = design;
  const points = [...entities, ...tiles].map(({ position }) => position);
  const snap = blueprint['snap-to-grid'];
  const relative = blueprint['position-relative-to-grid'];
  const radii = ['x', 'y'].map((axis) => {
    const values = points.map((position) => position[axis]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return Math.ceil(Math.max(max - min, Math.abs(min), Math.abs(max)) + padding
      + Math.abs(snap?.[axis] ?? 0) + Math.abs(relative?.[axis] ?? 0));
  });
  if (radii.some((radius) => !Number.isFinite(radius) || radius > 512)) {
    throw new Error('The conservative placement envelope exceeds 1024 tiles. Use a smaller module or split the blueprint.');
  }
  const [x, y] = at;
  const [rx, ry] = radii;
  return [x - rx, y - ry, x + rx, y + ry];
}

function targetCheck(target) {
  return `
    assert(game.is_multiplayer(),"A multiplayer save is required")
    local s=assert(game.get_surface(${luaString(target.surface)}),"Surface not found")
    local f=assert(game.forces[${luaString(target.force)}],"Force not found")
    local a=${luaArea(target.area)}
    local bad=0
    for x=math.floor(a[1][1]/32),math.floor(a[2][1]/32) do
      for y=math.floor(a[1][2]/32),math.floor(a[2][2]/32) do
        if not s.is_chunk_generated{x,y} then bad=bad+1 end
      end
    end
    local occupied=s.count_entities_filtered{area=a}-s.count_entities_filtered{area=a,type="resource"}
  `;
}

function storedRecord(id) {
  return `local all=storage[${luaString(storageKey)}]; local rec=all and all[${luaString(id)}]`;
}

function readReceipt(id, call) {
  if (!/^[a-f0-9]{64}$/.test(id ?? '')) throw new Error('--id requires the 64-character placementId from place.');
  return call(`
    ${storedRecord(id)}
    if not rec then return {status="absent"} end
    return {status=rec.status,result=rec.result,chunks=rec.parts and #rec.parts or nil}
  `);
}

function applyPlacement(design, target, id, before, call) {
  const { exchange, entities, tiles } = design;
  const idText = luaString(id);
  const check = targetCheck(target);
  const identity = `assert(s.index==${before.surfaceIndex} and f.index==${before.forceIndex} and (s.map_gen_settings.seed or 0)==${before.seed},"Target world changed")`;
  const started = call(`
    local k=${luaString(storageKey)}
    local all=storage[k] or {}
    local prior=all[${idText}]
    if prior and prior.status~="staging" then return prior.status end
    ${check}
    ${identity}
    assert(bad==0 and occupied==0,"Target area changed since preparation")
    storage[k]=all
    all[${idText}]=all[${idText}] or {status="staging",parts={}}
    return all[${idText}].status
  `);
  if (started !== 'staging') return readReceipt(id, call);

  for (let offset = 0; offset < exchange.length; offset += chunkSize) {
    const index = offset / chunkSize + 1;
    const part = luaString(exchange.slice(offset, offset + chunkSize));
    const accepted = call(`
      ${storedRecord(id)}
      if rec and rec.status~="staging" then return 0 end
      assert(rec,"Placement staging is missing")
      local p=${part}
      assert(${index}<=#rec.parts+1 and (not rec.parts[${index}] or rec.parts[${index}]==p),"Staging part conflict")
      rec.parts[${index}]=p
      return ${index}
    `);
    if (accepted === 0) return readReceipt(id, call);
    if (accepted !== index) throw new Error('The server did not acknowledge the expected upload part.');
  }

  return call(`
    ${storedRecord(id)}
    assert(rec,"Placement staging is missing")
    if rec.status~="staging" then return {status=rec.status,result=rec.result} end
    ${check}
    ${identity}
    assert(bad==0 and occupied==0,"Target area changed before construction")
    local raw=table.concat(rec.parts)
    assert(#raw==${exchange.length},"Upload was incomplete")
    local inv=game.create_inventory(1)
    local bp=inv[1]
    local ok,res=pcall(function()
      assert(bp.import_stack(raw)==0 and bp.is_blueprint,"Native blueprint import failed")
      local src=bp.get_blueprint_entities() or {}
      local ts=bp.get_blueprint_tiles() or {}
      assert(#src==${entities.length} and #ts==${tiles.length},"Native import changed blueprint dimensions")
      rec.parts=nil
      rec.status="applying"
      local gs=bp.build_blueprint{surface=s,force=f,position={${target.at.join(',')}},build_mode=defines.build_mode.normal,skip_fog_of_war=false}
      local ar,at,real=0,0,0
      local inside=true
      local l,t,r,b=math.huge,math.huge,-math.huge,-math.huge
      for _,e in ipairs(gs) do
        if e.valid then
          local p=e.position
          l,t,r,b=math.min(l,p.x),math.min(t,p.y),math.max(r,p.x),math.max(b,p.y)
          inside=inside and p.x>=a[1][1] and p.y>=a[1][2] and p.x<=a[2][1] and p.y<=a[2][2]
          if e.name=="entity-ghost" then ar=ar+1 elseif e.name=="tile-ghost" then at=at+1 end
        end
      end
      if ar~=#src or at~=#ts or not inside then
        for _,e in ipairs(gs) do if e.valid and (e.name=="entity-ghost" or e.name=="tile-ghost") then e.destroy() end end
        return {status="rejected",result={entityGhosts=ar,tileGhosts=at,insideArea=inside,tick=game.tick,reason="Native placement did not match the whole blueprint"}}
      end
      ${target.mode === 'built' ? `
      for _,e in ipairs(gs) do if e.valid and e.name=="entity-ghost" then
        local _,made=e.silent_revive{raise_revive=false}
        if made then real=real+1 end
      end end
      ` : ''}
      local final=${target.mode === 'built' ? 'real==#src and "built" or "partial"' : '"ghosts"'}
      return {status=final,result={entityGhosts=ar-real,tileGhosts=at,builtEntities=real,boundsOfCenters={l,t,r,b},tick=game.tick}}
    end)
    inv.destroy()
    if not ok then
      rec.status=rec.status=="applying" and "uncertain" or "rejected"
      rec.result={reason=tostring(res),tick=game.tick}
    else
      rec.status=res.status
      rec.result=res.result
    end
    rec.parts=nil
    return {status=rec.status,result=rec.result}
  `);
}

function place(options, call) {
  const surface = textOption(options, 'surface');
  const force = textOption(options, 'force');
  const at = coordinates(options.at, 2, 'at');
  const mode = options.mode ?? 'ghost';
  if (!['ghost', 'built'].includes(mode)) throw new Error('--mode must be ghost or built.');
  const request = options.request && textOption(options, 'request');
  const design = readBlueprint(options.blueprint, mode);
  const area = placementArea(design, at, call);
  const target = { surface, force, at, mode, area };
  const before = call(`
    ${targetCheck(target)}
    return {surfaceIndex=s.index,forceIndex=f.index,seed=s.map_gen_settings.seed or 0,
      missingChunks=bad,occupants=occupied,tick=game.tick}
  `);
  const id = digest(JSON.stringify([design.sha256, target, before.surfaceIndex, before.forceIndex, before.seed, request ?? null]));
  const previous = readReceipt(id, call);
  const ready = before.missingChunks === 0 && before.occupants === 0
    && (previous.status === 'absent' || previous.status === 'staging');
  const plan = { placementId: id, blueprintSha256: design.sha256, target, request, inspection: before,
    expected: { entities: design.entities.length, tiles: design.tiles.length }, ready };
  if (!options.apply) return { ...plan, status: previous.status === 'absent' ? 'preview' : previous.status, receipt: previous };
  if (previous.status !== 'absent' && previous.status !== 'staging') return { ...plan, ...previous, reused: true };
  if (!ready) return { ...plan, status: 'blocked' };
  try {
    return { ...plan, ...applyPlacement(design, target, id, before, call) };
  } catch (error) {
    throw new Error(`${error.message}\nCheck receipt --id ${id} and inspect the target before retrying.`);
  }
}

function main() {
  const { positionals: [command, ...extra], values } = parseArgs({
    allowPositionals: true,
    options: { ...connectionOptions, help: { type: 'boolean', short: 'h' },
      ...Object.fromEntries(Object.values(flags).flat().map((name) => [name, { type: name === 'apply' ? 'boolean' : 'string' }])) },
  });
  if (values.help || command === undefined) {
    console.log(help);
    return;
  }
  const operation = Object.hasOwn(flags, command) && { status, inspect, place, receipt: (options, call) => readReceipt(options.id, call) }[command];
  if (!operation || extra.length) throw new Error('Choose status, inspect, place, or receipt. See --help.');
  const allowed = [...flags[command], ...Object.keys(connectionOptions)];
  for (const flag of Object.keys(values)) if (!allowed.includes(flag)) throw new Error(`--${flag} is unavailable for ${command}.`);
  const reply = operation(values, createRconCaller(values));
  if (command === 'place' && values.apply && !['built', 'ghosts'].includes(reply.status)) process.exitCode = 1;
  console.log(JSON.stringify(reply, null, 2));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
