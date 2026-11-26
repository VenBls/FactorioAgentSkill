
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { inflateSync } from 'node:zlib';
import { connectionOptions, createRconCaller, luaString } from './rcon-lua.mjs';

const surface = 'codex-design-test';
const state = 'codex_server_design_v1';
const chunkSize = 2000;
const pageSize = 28;

const usage = 'Usage: node place-design.mjs --blueprint path [--ssh USER@HOST] [--port 27015] [--password-file path] [--timeout-ms 45000] [--report path] [--save-name name] [--check-only]';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readBlueprint(path) {
  const bytes = readFileSync(path);
  const exchange = bytes.toString('utf8').trim();
  if (!/^0[A-Za-z0-9+/=]+$/.test(exchange)) throw new Error('Expected a Factorio blueprint exchange string.');
  const { blueprint } = JSON.parse(inflateSync(Buffer.from(exchange.slice(1), 'base64')).toString('utf8'));
  if (!blueprint?.entities?.length) throw new Error('Provide a nonempty single blueprint.');
  if (blueprint.tiles?.length) throw new Error('This lab worker expects an entity-only blueprint.');
  if (blueprint.entities.some(({name}) => name === 'character')) throw new Error('A character entity cannot be part of the lab blueprint.');
  const stationNames = blueprint.entities.filter(({ name }) => name === 'train-stop').map(({ station }) => station);
  if (stationNames.some((name) => !name) || new Set(stationNames).size !== stationNames.length) {
    throw new Error('This lab worker expects every blueprinted train stop to have a unique name.');
  }
  return { blueprint, exchange, sha: sha256(bytes) };
}

function usePlacement(blueprint, exchange, sha, options, call) {
  const status = call(`
    assert(type(storage)=="table","RCON Lua storage is unavailable")
    local s,b=game.surfaces[${luaString(surface)}],storage[${luaString(state)}]
    if s then
      assert(b and b.sha==${luaString(sha)} and b.id==s.index,"The lab surface already exists with no matching ownership record")
      assert(b.status=="built","There is an unfinished build on the lab. Inspect it before retrying")
      return {status=b.status,index=s.index}
    end
    assert(${options['check-only'] ? 'false' : 'true'},"The lab surface has not been built")
    storage[${luaString(state)}]={sha=${luaString(sha)},status="staged",pieces={}}
    return {status="staged"}
  `);
  if (status.status === 'built') return 'reused';

  for (let offset = 0; offset < exchange.length; offset += chunkSize) {
    const part = exchange.slice(offset, offset + chunkSize);
    const partIndex = offset / chunkSize + 1;
    const accepted = call(`
      local b=storage[${luaString(state)}]
      assert(b and b.sha==${luaString(sha)} and b.status=="staged","Blueprint staging is no longer active")
      local idx=${partIndex}
      assert(idx==#b.pieces+1,"Blueprint chunk is out of order")
      b.pieces[idx]=${luaString(part)}
      return idx
    `);
    if (accepted !== partIndex) throw new Error('Server did not acknowledge the expected blueprint chunk.');
  }

  const built = call(`
    assert(game.is_multiplayer(),"A multiplayer test server is required")
    assert(not game.surfaces[${luaString(surface)}],"The lab surface already exists")
    local b=storage[${luaString(state)}]
    assert(b and b.sha==${luaString(sha)} and b.status=="staged","Blueprint staging is no longer active")
    local raw=table.concat(b.pieces)
    assert(#raw==${exchange.length},"Blueprint upload byte count did not match")
    local inv=game.create_inventory(1)
    local bp=inv[1]
    local loaded=bp.import_stack(raw)
    if loaded~=0 or not bp.is_blueprint then inv.destroy(); error("The game rejected the supplied blueprint") end
    local source=bp.get_blueprint_entities()
    if #source~=${blueprint.entities.length} then inv.destroy(); error("The game imported a different entity count") end
    local max=0
    for _,e in ipairs(source) do max=math.max(max,math.abs(e.position.x),math.abs(e.position.y)) end
    local s=game.create_surface(${luaString(surface)})
    b.id=s.index
    b.status="building"
    s.generate_with_lab_tiles=true
    s.request_to_generate_chunks({0,0},math.max(2,math.ceil(max/32)+1))
    s.force_generate_chunk_requests()
    local force=game.forces.player
    local ghosts=bp.build_blueprint{surface=s,force=force,position={0,0},build_mode=defines.build_mode.normal,skip_fog_of_war=false}
    local count=0
    for _,ghost in ipairs(ghosts) do
      if ghost.valid and ghost.name=="entity-ghost" then
        local _,e=ghost.silent_revive{raise_revive=false}
        if e then count=count+1 end
      end
    end
    inv.destroy()
    b.pieces=nil
    assert(count==#source,"A placed ghost could not be revived")
    b.status="built"
    return {index=s.index,count=count,tick=game.tick}
  `);
  if (built.count !== blueprint.entities.length) throw new Error('Server returned an unexpected placement count.');
  return 'placed';
}

function lookup(sha) {
  return `
    local s,b=game.surfaces[${luaString(surface)}],storage[${luaString(state)}]
    assert(s and b and b.sha==${luaString(sha)} and b.id==s.index and b.status=="built","There is no completed matching lab")
  `;
}

function readGeometry(blueprint, sha, call) {
  const rows = [];
  let total;
  let world;
  for (let start = 0; total === undefined || start < total; start += pageSize) {
    const reply = call(lookup(sha) + `
      local all={}
      for _,e in pairs(s.find_entities_filtered{force=game.forces.player}) do
        if e.type~="character" then all[#all+1]=e end
      end
      table.sort(all,function(a,b) return a.unit_number<b.unit_number end)
      local result={}
      for i=${start + 1},math.min(#all,${start + pageSize}) do
        local e=all[i]
        local q={n=e.name,x=e.position.x,y=e.position.y,d=e.direction}
        if e.type=="train-stop" then q.s=e.backer_name; q.l=e.trains_limit; q.r=e.connected_rail~=nil end
        result[#result+1]=q
      end
      return {total=#all,rows=result,index=s.index,tick=game.tick,lab=s.generate_with_lab_tiles,mods=script.active_mods}
    `);
    if (total !== undefined && reply.total !== total) throw new Error('Entity count changed during readback.');
    if (reply.total !== blueprint.entities.length) throw new Error(`Server reported ${reply.total} rather than ${blueprint.entities.length} real entities.`);
    if (!reply.lab) throw new Error('The owned surface was not reported as lab tiles.');
    if (reply.rows.length !== Math.min(pageSize, reply.total - start)) throw new Error('Incomplete RCON readback page.');
    world = { surface, surfaceIndex: reply.index, tick: reply.tick, gameVersion: reply.mods.base, mods: reply.mods };
    total = reply.total;
    rows.push(...reply.rows);
  }
  return { rows, world };
}

function canonical(rows) {
  const minX = Math.min(...rows.map(({ x }) => x));
  const minY = Math.min(...rows.map(({ y }) => y));
  const geometry = rows.map(({ n,x,y,d,s,l }) => JSON.stringify([n, x-minX, y-minY, d ?? 0, s ?? '', l ?? 0])).sort();
  return { geometry, minX, minY };
}

function verify(blueprint, rows) {
  const want = canonical(blueprint.entities.map(({ name, position, direction, station, manual_trains_limit }) => ({
    n: name, ...position, d: direction, s: station, l: manual_trains_limit,
  })));
  const got = canonical(rows);
  if (want.geometry.length !== got.geometry.length || want.geometry.some((key, index) => key !== got.geometry[index])) {
    const match = got.geometry.findIndex((key, index) => key !== want.geometry[index]);
    throw new Error(`The normalized native geometry differed. Expected ${want.geometry[match]}; received ${got.geometry[match]}.`);
  }
  if (rows.some(({ n,r }) => n === 'train-stop' && !r)) throw new Error('A station did not connect to an actual rail.');
  const prototypes = Object.create(null);
  for (const { n } of rows) prototypes[n] = (prototypes[n] ?? 0) + 1;
  const stations = rows.filter(({ n }) => n === 'train-stop').map(({s,x,y,d,l,r}) => ({
    name: s, x, y, direction:d, trainsLimit:l, connectedRail:r,
  })).sort((a,b)=>a.name.localeCompare(b.name));
  return {
    normalizedGeometrySha256: sha256(got.geometry.join('\n')),
    placementOffset: { x: got.minX-want.minX, y: got.minY-want.minY },
    entityCount: rows.length,
    boundsOfEntityCenters: {
      minX: got.minX,
      minY: got.minY,
      maxX: Math.max(...rows.map(({x})=>x)),
      maxY: Math.max(...rows.map(({y})=>y)),
    },
    prototypes,
    stations,
  };
}

function main() {
  const { values: options } = parseArgs({ options: {
    blueprint: { type: 'string' },
    ...connectionOptions,
    report: { type: 'string' },
    'save-name': { type: 'string' },
    'check-only': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  }});
  if (options.help) { console.log(usage); return; }
  if (options['save-name'] && !/^[a-zA-Z0-9_-]{1,80}$/.test(options['save-name'])) {
    throw new Error('Use a simple test-only save name containing letters, numbers, dashes, or underscores.');
  }
  if (options['check-only'] && options['save-name']) throw new Error('--check-only does not save.');
  if (!options.blueprint) throw new Error('--blueprint is required.');
  const call = createRconCaller(options);
  const { blueprint, exchange, sha } = readBlueprint(options.blueprint);
  const outcome = usePlacement(blueprint, exchange, sha, options, call);
  const { rows, world } = readGeometry(blueprint, sha, call);
  const report = { pass:true, outcome, blueprintSha256:sha, ...world, ...verify(blueprint, rows) };
  if (options['save-name']) {
    report.snapshotRequested = call(lookup(sha) + `
      game.server_save(${luaString(options['save-name'])})
      return ${luaString(options['save-name'])}
    `);
  }
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.report) writeFileSync(options.report, json, 'utf8');
  process.stdout.write(json);
}

try { main(); } catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
