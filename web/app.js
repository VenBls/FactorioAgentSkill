import { createBlueprintViewer } from "/blueprint-view.js";

const element = (id) => document.getElementById(id);
const form = element("work-form");
const input = element("work-input");
const submit = element("work-submit");
const status = element("work-status");
const r12 = element("example-r12");
const compact = element("example-compact");
const download = element("work-download");
const libraryQuery = element("library-query");
const libraryKey = element("library-key");
const libraryStatus = element("library-status");
const libraryResults = element("library-results");
const librarySave = element("library-save-button");
const drafts = { blueprint: "", spec: "" };
const rateFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 });
let mode = "blueprint";
let viewer;
let currentDownload;
let workPending = false;
let latestSearch = 0;

function setMode(next) {
  drafts[mode] = input.value;
  mode = next;
  form.elements.mode.value = mode;
  const spec = mode === "spec";
  input.value = drafts[mode];
  input.placeholder = spec ? "粘贴设计需求 JSON 或填入设计样例" : "粘贴以 0 开头的字符串";
  submit.textContent = spec ? "生成蓝图" : "读取蓝图";
  element("work-label").textContent = spec ? "设计需求 JSON" : "Factorio 蓝图或蓝图书";
}

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

async function request(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw Error(payload?.error?.message || "请求失败 (" + response.status + ")");
  }
  return response;
}

async function withProgress(text, action) {
  if (workPending) return;
  workPending = true;
  const controls = [submit, r12, compact, input];
  for (const control of controls) control.disabled = true;
  message(text);
  try {
    await action();
  } catch (error) {
    message(error.message, true);
  } finally {
    workPending = false;
    for (const control of controls) control.disabled = false;
  }
}

function showProduction(production) {
  element("production").hidden = !production;
  if (!production) return;
  element("production-status").textContent = production.mode === "targets"
    ? (production.feasible ? "设备能力达到指定目标。单位为每分钟。" : "设备能力低于指定目标。单位为每分钟。")
    : "按给定设备和运行速率计算。单位为每分钟。";
  const list = element("production-values");
  list.replaceChildren();
  for (const [label, quantities] of [
    ["目标", production.targets],
    ["外部供料", production.imports],
    ["输出", production.outputs],
    ["目标缺口", production.targetShortfalls],
  ]) {
    const entries = Object.entries(quantities ?? {}).filter(([,rate]) => Number.isFinite(rate) && rate > 0);
    if (!entries.length) continue;
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = label;
    value.textContent = entries.map(([id, rate]) => id + " × " + rateFormat.format(rate)).join(" · ");
    list.append(term, value);
  }
}

function display(result, blueprint) {
  if (!viewer) throw Error("预览器尚未加载，请刷新页面重试。");
  viewer.displayDocument(result.document);
  showProduction(result.production);
  const label = result.document.blueprint?.label || result.document.blueprint_book?.label || "blueprint";
  const filename = String(label).replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/[. ]+$/, "").slice(0, 70) || "blueprint";
  currentDownload = { blueprint, label, filename: filename + ".txt" };
  librarySave.disabled = false;
  download.disabled = false;
}

async function readBlueprint(text) {
  const blueprint = text.trim();
  if (!blueprint) throw Error("请先粘贴 Factorio 蓝图字符串。");
  const result = await (await request("/api/v1/blueprints/inspect", { blueprint })).json();
  display(result, blueprint);
}

async function loadR12(fillInput) {
  const blueprint = await (await request("/examples/r12/robot-district-integrated.txt")).text();
  await readBlueprint(blueprint);
  if (fillInput) {
    setMode("blueprint");
    input.value = blueprint.trim();
    input.scrollTop = 0;
  }
  libraryKey.value = "r12";
  message("已打开 R12 工厂。");
}

form.addEventListener("change", (event) => {
  if (event.target.name === "mode") setMode(event.target.value);
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value;
  const spec = mode === "spec";
  withProgress(spec ? "正在设计蓝图…" : "正在解码蓝图…", async () => {
    if (spec) {
      let plan;
      try {
        plan = JSON.parse(text);
      } catch {
        throw Error("设计需求须为完整的 JSON 对象。");
      }
      const result = await (await request("/api/v1/designs", plan)).json();
      display(result, result.blueprint);
      libraryKey.value = "";
      message("设计已生成，可以下载蓝图。");
    } else {
      await readBlueprint(text);
      libraryKey.value = "";
      message("蓝图已读取。");
    }
  });
});

r12.addEventListener("click", () => withProgress("正在读取 R12…", () => loadR12(true)));
compact.addEventListener("click", () => withProgress("正在读取设计样例…", async () => {
  const data = await (await request("/examples/compact-assembly.json")).json();
  setMode("spec");
  input.value = JSON.stringify(data, null, 2);
  input.scrollTop = 0;
  message("样例已填入。修改需求后可生成蓝图。");
}));
download.addEventListener("click", () => {
  if (!currentDownload) return;
  const url = URL.createObjectURL(new Blob([currentDownload.blueprint], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = currentDownload.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function libraryMessage(text, error = false) {
  libraryStatus.textContent = text;
  libraryStatus.dataset.error = String(error);
}

async function refreshLibrary() {
  const search = ++latestSearch;
  const query = new URLSearchParams({ q: libraryQuery.value.trim() });
  const payload = await (await request("/api/v1/library?" + query)).json();
  if (search !== latestSearch) return;
  libraryResults.replaceChildren();
  for (const entry of payload.entries) {
    const row = document.createElement("li");
    const button = document.createElement("button");
    const name = document.createElement("span");
    const info = document.createElement("small");
    button.type = "button";
    name.textContent = entry.label || entry.key;
    info.textContent = [entry.key, entry.entityCount + " 个实体", entry.blueprintSha256?.slice(0, 8)].filter(Boolean).join(" · ");
    button.append(name, info);
    button.addEventListener("click", () => withProgress("正在打开已存蓝图…", async () => {
      const saved = await (await request("/api/v1/library/" + encodeURIComponent(entry.id))).json();
      await readBlueprint(saved.entry.blueprint);
      setMode("blueprint");
      input.value = saved.entry.blueprint;
      input.scrollTop = 0;
      libraryKey.value = saved.entry.key;
      message("已打开蓝图库中的 " + (saved.entry.label || saved.entry.key) + "。");
    }));
    row.append(button);
    libraryResults.append(row);
  }
  if (!payload.entries.length) {
    const empty = document.createElement("li");
    empty.textContent = libraryQuery.value.trim() ? "未找到匹配的蓝图。" : "保存当前蓝图后可再次打开。";
    libraryResults.append(empty);
  }
}

element("library-search").addEventListener("submit", (event) => {
  event.preventDefault();
  libraryMessage("");
  refreshLibrary().catch((error) => libraryMessage(error.message, true));
});
element("library-save").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentDownload || librarySave.disabled) return;
  const key = libraryKey.value.trim();
  librarySave.disabled = true;
  try {
    const { blueprint, label } = currentDownload;
    const payload = await (await request("/api/v1/library", { key, blueprint, label })).json();
    libraryMessage("已保存 · " + payload.entry.key);
    libraryQuery.value = "";
    await refreshLibrary();
  } catch (error) {
    libraryMessage(error.message, true);
  } finally {
    librarySave.disabled = false;
  }
});

refreshLibrary().catch((error) => libraryMessage(error.message, true));

withProgress("正在读取 R12…", async () => {
  const endpoints = await (await request("/examples/r12/rail-endpoints.json")).json();
  viewer = createBlueprintViewer(endpoints);
  await loadR12(false);
});
