local fixture = require("fixture")
local spec = helpers.json_to_table(fixture.spec)
local report_file = "native-result.json"
local maximum_side = 4096
local maximum_chunk_radius = 32

local function write_report(report)
  helpers.write_file(report_file, helpers.table_to_json(report), false)
end

local function bounds()
  return {minX=math.huge, minY=math.huge, maxX=-math.huge, maxY=-math.huge}
end

local function include(box, x, y)
  box.minX, box.maxX = math.min(x, box.minX), math.max(x, box.maxX)
  box.minY, box.maxY = math.min(y, box.minY), math.max(y, box.maxY)
end

local function update_bounds(box, area)
  include(box, area.left_top.x, area.left_top.y)
  include(box, area.right_bottom.x, area.right_bottom.y)
end

local function point(x, y)
  return {x=x, y=y}
end

local function entity_key(name, x, y)
  return ("%s|%.3f|%.3f"):format(name, x + 0, y + 0)
end

local function screenshot_frame(world, offset)
  local min_x = math.floor(world.minX - offset.x - spec.padding)
  local min_y = math.floor(world.minY - offset.y - spec.padding)
  local max_x = math.ceil(world.maxX - offset.x + spec.padding)
  local max_y = math.ceil(world.maxY - offset.y + spec.padding)
  local span_x, span_y = math.max(1, max_x-min_x), math.max(1, max_y-min_y)
  local max_span = math.max(span_x, span_y)
  local scale = math.min(spec.pixelsPerTile, math.floor(maximum_side / max_span))
  if scale == 0 then scale = maximum_side / max_span end
  local width = math.min(maximum_side, math.ceil(span_x * scale))
  local height = math.min(maximum_side, math.ceil(span_y * scale))
  local center_x, center_y = (min_x+max_x)/2, (min_y+max_y)/2
  return {
    image="native-blueprint.png", pixelWidth=width, pixelHeight=height,
    zoom=scale / 32, pixelsPerTile=scale,
    bounds={
      minX=center_x-width/(2*scale), maxX=center_x+width/(2*scale),
      minY=center_y-height/(2*scale), maxY=center_y+height/(2*scale)
    },
    engineCenter=point(center_x+offset.x, center_y+offset.y),
    altMode=spec.altMode
  }
end

local function install()
  local s = game.create_surface("Codex Blueprint Laboratory")
  s.generate_with_lab_tiles = true
  s.always_day = true
  local force = game.forces.player
  local inventory = game.create_inventory(1)
  local stack = inventory[1]
  local import_status = stack.import_stack(fixture.blueprint)
  if import_status ~= 0 then
    inventory.destroy()
    return {pass=false, stage="import", importStatus=import_status, error="Factorio did not fully import the blueprint"}
  end
  assert(stack.is_blueprint, "The supplied artifact is not a single Factorio blueprint")
  local entities = stack.get_blueprint_entities() or {}
  local tiles = stack.get_blueprint_tiles() or {}
  local actual_centers, tile_centers, world = bounds(), bounds(), bounds()
  local radius = 2
  for _, entry in ipairs(entities) do
    local p = entry.position
    radius = math.max(radius, math.ceil(math.max(math.abs(p.x), math.abs(p.y))/32) + 1)
    if entry.recipe and force.recipes[entry.recipe] then force.recipes[entry.recipe].enabled = true end
  end
  for _, tile in ipairs(tiles) do
    local p = tile.position
    radius = math.max(radius, math.ceil(math.max(math.abs(p.x), math.abs(p.y))/32) + 1)
  end
  if radius > maximum_chunk_radius then
    return {pass=false, stage='placement', error='Blueprint placement exceeds the lab generation radius (approximately 992 tiles from its stored origin)'}
  end
  s.request_to_generate_chunks({0,0}, radius)
  s.force_generate_chunk_requests()
  local ghosts = stack.build_blueprint{
    surface=s, force=force, position={0,0},
    build_mode=defines.build_mode.normal, skip_fog_of_war=false
  }
  for _, ghost in ipairs(ghosts) do
    if ghost.valid and ghost.name == "tile-ghost" then
      include(tile_centers, math.floor(ghost.position.x), math.floor(ghost.position.y))
      ghost.silent_revive{raise_revive=false}
    end
  end

  local placed, stations, remaining, prototypes = {}, {}, {}, {}
  for _, ghost in ipairs(ghosts) do
    if ghost.valid and ghost.name == "entity-ghost" then
      local name, position, direction = ghost.ghost_name, ghost.position, ghost.direction
      local _, entity = ghost.silent_revive{raise_revive=false}
      if entity then
        local p = entity.position
        placed[#placed+1] = {name=entity.name, position=p, direction=entity.direction}
        prototypes[entity.name] = (prototypes[entity.name] or 0) + 1
        update_bounds(world, entity.bounding_box)
        include(actual_centers, p.x, p.y)
        if entity.type == "train-stop" then
          stations[#stations+1] = {
            name=entity.backer_name, x=p.x, y=p.y,
            trainLimit=entity.trains_limit, connectedRail=entity.connected_rail~=nil
          }
        end
      else
        remaining[#remaining+1] = {name=name, position=position, direction=direction}
      end
    end
  end

  local actual_min_x, actual_min_y = actual_centers.minX, actual_centers.minY
  if #placed == 0 then
    actual_min_x, actual_min_y = tile_centers.minX, tile_centers.minY
  end
  local input = #placed > 0 and spec.entityBounds or spec.tileBounds
  local world_offset = point(0,0)
  if input and actual_min_x ~= math.huge then
    world_offset = point(actual_min_x-input.minX, actual_min_y-input.minY)
  end

  local failed_tiles = {}
  for _, tile in ipairs(spec.tiles) do
    local source = tile
    local x, y = math.floor(source.position.x + world_offset.x), math.floor(source.position.y + world_offset.y)
    if s.get_tile(x,y).name == tile.name then
      include(world, x, y)
      include(world, x+1, y+1)
    else
      failed_tiles[#failed_tiles+1] = {name=tile.name, position=point(x,y), actual=s.get_tile(x,y).name}
    end
  end

  local by_position, position_checks = {}, 0
  for _, observed in ipairs(placed) do
    local p = observed.position
    local key = entity_key(observed.name,p.x,p.y)
    by_position[key] = by_position[key] or {}
    table.insert(by_position[key], observed.direction)
  end
  local geometry_mismatches, direction_differences = {}, {}
  for _, entry in ipairs(spec.entities) do
    local p = entry.position
    local key = entity_key(entry.name, p.x+world_offset.x, p.y+world_offset.y)
    local options = by_position[key]
    if options and #options > 0 then
      local chosen = 1
      if entry.direction ~= nil then
        for index, candidate in ipairs(options) do
          if candidate == entry.direction then chosen = index; break end
        end
        if options[chosen] ~= entry.direction then
          direction_differences[#direction_differences+1]={name=entry.name,position=p,blueprintDirection=entry.direction,engineDirection=options[chosen]}
        end
      end
      table.remove(options, chosen)
      position_checks=position_checks+1
    else
      geometry_mismatches[#geometry_mismatches+1] = {name=entry.name,position=p}
    end
  end

  inventory.destroy()
  local report = {
    pass=#entities==#spec.entities and #placed==#spec.entities and #tiles==#spec.tiles and #failed_tiles==0,
    stage="placement", importStatus=import_status,
    expectedEntities=#spec.entities, importedEntities=#entities, builtEntities=#placed,
    expectedTiles=#spec.tiles, importedTiles=#tiles, builtTiles=#spec.tiles-#failed_tiles,
    geometryAligned=position_checks==#spec.entities and #failed_tiles==0,
    directionsAligned=#direction_differences==0,
    geometryMatchedEntities=position_checks, geometryDifferences=geometry_mismatches, directionDifferences=direction_differences,
    engineWorldOffset=world_offset, entitiesNotBuilt=remaining, tilesNotBuilt=failed_tiles,
    prototypes=prototypes, stations=stations, activeMods=script.active_mods,
    scope="Exact engine import and placement on a clean lab tile surface"
  }
  if spec.command == "render" and report.pass then
    report.stage='render'
    local frame = screenshot_frame(world, world_offset)
    for key, value in pairs(frame) do report[key] = value end
    force.chart(s, {
      {frame.bounds.minX+world_offset.x-16,frame.bounds.minY+world_offset.y-16},
      {frame.bounds.maxX+world_offset.x+16,frame.bounds.maxY+world_offset.y+16}
    })
    storage.render_surface = s
  end
  return report
end

script.on_init(function()
  local ok, report = pcall(install)
  if not ok then report = {pass=false, stage="engine-script", error=tostring(report)} end
  if spec.command=="validate" then
    write_report(report)
    script.finish_test(report.pass)
  elseif report.pass then
    storage.render_report=report
  else
    write_report(report)
  end
end)

script.on_event(defines.events.on_tick,function(event)
  local report = storage.render_report
  if event.tick < 5 or not report then return end
  storage.render_report = nil
  local ok, reason = pcall(function()
    game.take_screenshot{
      surface=storage.render_surface, position=report.engineCenter, resolution={x=report.pixelWidth,y=report.pixelHeight},
      zoom=report.zoom, path=report.image, show_gui=false, show_entity_info=report.altMode,
      hide_clouds=true, hide_fog=true, hide_health_bars=true, daytime=0, force_render=true
    }
    game.set_wait_for_screenshots_to_finish()
  end)
  if not ok then report.pass=false; report.stage="render"; report.error=tostring(reason) end
  write_report(report)
end)
