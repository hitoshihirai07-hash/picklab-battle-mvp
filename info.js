// Pick Lab 資料ページ（図鑑・わざ一覧）
// 対戦側(app.js)とは別ファイル。軽量にDBを読み込んで表示だけ行う。

const elDexList = document.getElementById("dexList");
const elMoveIndex = document.getElementById("moveIndex");

const DB = {
  typeName: {},
  monMap: {},
  moveMap: {},
  learnset: {}
};

function escapeHtml(s){
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// very small CSV parser (same spirit as app.js)
function parseCSV(text){
  const lines = text.replace(/\r/g,"").split("\n").filter(l=>l.trim().length>0);
  if (!lines.length) return [];
  const header = splitCSVLine(lines[0]);
  const rows = [];
  for (let i=1;i<lines.length;i++){
    const cols = splitCSVLine(lines[i]);
    const obj = {};
    for (let c=0;c<header.length;c++){
      obj[header[c]] = cols[c] ?? "";
    }
    rows.push(obj);
  }
  return rows;
}
function splitCSVLine(line){
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (ch === '"'){
      if (inQ && line[i+1] === '"'){ cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === "," && !inQ){
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s=>s.trim());
}
async function loadCSV(path){
  const res = await fetch(path, {cache:"no-store"});
  if (!res.ok) throw new Error(`load failed: ${path}`);
  const text = await res.text();
  return parseCSV(text);
}

function normalizeMon(m){
  return {
    id: m.id,
    name: m.name,
    type1: m.type1,
    type2: m.type2 || "NONE",
    hp: Number(m.hp),
    atk: Number(m.atk),
    def: Number(m.def),
    spd: Number(m.spd),
    img: `./assets/mon/${m.id}.svg`
  };
}
function normalizeMove(m){
  const flags = (m.flags || "").split("|").map(s=>s.trim()).filter(Boolean);
  return {
    move_id: m.move_id,
    name: m.move_name,
    type: m.type,
    power: Number(m.power),
    accuracy: Number(m.accuracy),
    pp: Number(m.pp),
    priority: Number(m.priority),
    flags,
    effect: m.effect || ""
  };
}

function renderDexList(){
  if (!elDexList) return;

  elDexList.innerHTML = `
    <div class="flex">
      <input id="dexSearch" type="text" placeholder="なまえで検索" />
      <select id="dexTypeSel"></select>
      <span class="muted small">${Object.keys(DB.monMap).length}たい</span>
    </div>
    <div class="sep"></div>
    <div id="dexGrid" class="grid3"></div>
  `;

  const qInp = elDexList.querySelector("#dexSearch");
  const typeSel = elDexList.querySelector("#dexTypeSel");

  const typeOptions = ["ALL","FIRE","WATER","WOOD","THUNDER","ICE","ROCK","WIND","DARK","NONE"];
  typeSel.innerHTML = typeOptions.map(t=>{
    const label = (t==="ALL") ? "タイプ：ぜんぶ" : `タイプ：${DB.typeName[t] ?? t}`;
    return `<option value="${t}">${label}</option>`;
  }).join("");

  const apply = ()=>{
    const q = (qInp.value||"").trim();
    const t = typeSel.value || "ALL";
    let mons = Object.values(DB.monMap);

    if (q) mons = mons.filter(m=>m.name.includes(q));
    if (t !== "ALL") mons = mons.filter(m=>m.type1===t || m.type2===t);
    mons.sort((a,b)=>a.name.localeCompare(b.name,"ja"));

    const grid = elDexList.querySelector("#dexGrid");
    grid.innerHTML = "";

    for (const m of mons){
      const total = m.hp+m.atk+m.def+m.spd;
      const learned = DB.learnset[m.id] ?? [];
      const card = document.createElement("div");
      card.className = "builderMon";
      card.innerHTML = `
        <div class="imgRow">
          <img class="monImg" src="${m.img}" alt="${escapeHtml(m.name)}">
          <div style="flex:1">
            <div class="monLine">
              <div>
                <div class="monName">${escapeHtml(m.name)}</div>
                <div class="muted small">${escapeHtml(DB.typeName[m.type1] ?? m.type1)}${m.type2 && m.type2!=="NONE" ? " / "+escapeHtml(DB.typeName[m.type2] ?? m.type2) : ""}</div>
              </div>
              <div class="right"><span class="badge mono">${total}</span></div>
            </div>
            <div class="muted small">HP ${m.hp} / こうげき ${m.atk} / ぼうぎょ ${m.def} / すばやさ ${m.spd}</div>
            <div class="muted small">おぼえるわざ：${learned.length}</div>
          </div>
        </div>
      `;
      grid.appendChild(card);
    }
  };

  qInp.addEventListener("input", apply);
  typeSel.addEventListener("change", apply);
  apply();
}

function renderMoveIndex(){
  if (!elMoveIndex) return;

  elMoveIndex.innerHTML = `
    <div class="flex">
      <input id="moveSearch" type="text" placeholder="わざで検索" />
      <select id="moveTypeSel"></select>
      <span class="muted small">${Object.keys(DB.moveMap).length}わざ</span>
    </div>
    <div class="sep"></div>
    <div id="moveList" class="log"></div>
  `;

  const qInp = elMoveIndex.querySelector("#moveSearch");
  const typeSel = elMoveIndex.querySelector("#moveTypeSel");

  const typeOptions = ["ALL","FIRE","WATER","WOOD","THUNDER","ICE","ROCK","WIND","DARK","NONE"];
  typeSel.innerHTML = typeOptions.map(t=>{
    const label = (t==="ALL") ? "タイプ：ぜんぶ" : `タイプ：${DB.typeName[t] ?? t}`;
    return `<option value="${t}">${label}</option>`;
  }).join("");

  const toFlags = (m)=>{
    const flags = [];
    if (m.flags.includes("OHKO")) flags.push("OHKO(30%)");
    if (m.flags.includes("GUARD")) flags.push("ガード");
    if (m.flags.includes("PIERCE")) flags.push("つらぬき");
    if (m.flags.includes("BUFF")) flags.push("つよくする");
    if (m.flags.includes("DEBUFF")) flags.push("よわくする");
    return flags.join(" / ");
  };

  const apply = ()=>{
    const q = (qInp.value||"").trim();
    const t = typeSel.value || "ALL";
    let rows = Object.values(DB.moveMap);
    if (q) rows = rows.filter(m=>m.name.includes(q));
    if (t !== "ALL") rows = rows.filter(m=>m.type === t);
    rows.sort((a,b)=>a.name.localeCompare(b.name,"ja"));

    const line = (m)=>{
      const pow = (m.flags.includes("OHKO")) ? "—" : m.power;
      const acc = m.accuracy;
      const pri = Number(m.priority||0);
      const meta = `威力${pow} / 命中${acc}% / PP${m.pp} / 優先${pri}`;
      const flags = toFlags(m);
      return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 2px;border-bottom:1px dashed #e5e8f0">
        <div><b>${escapeHtml(m.name)}</b> <span class="badge">${escapeHtml(DB.typeName[m.type] ?? m.type)}</span> <span class="muted small">${flags ? "・"+escapeHtml(flags) : ""}</span></div>
        <div class="muted small mono">${escapeHtml(meta)}</div>
      </div>`;
    };

    elMoveIndex.querySelector("#moveList").innerHTML = rows.map(line).join("") || `<div class="muted small">該当なし</div>`;
  };

  qInp.addEventListener("input", apply);
  typeSel.addEventListener("change", apply);
  apply();
}

async function init(){
  // Load DB
  const [types, monsters, moves, learnset] = await Promise.all([
    loadCSV("./data/types.csv"),
    loadCSV("./data/monsters.csv"),
    loadCSV("./data/moves.csv"),
    loadCSV("./data/learnset.csv")
  ]);

  DB.typeName = Object.fromEntries(types.map(t => [t.type_id, t.type_name]));
  DB.monMap = Object.fromEntries(monsters.map(m => [m.id, normalizeMon(m)]));
  DB.moveMap = Object.fromEntries(moves.map(m => [m.move_id, normalizeMove(m)]));
  // learnset: monster_id -> [move_id...]
  DB.learnset = {};
  for (const r of learnset){
    if (!DB.learnset[r.monster_id]) DB.learnset[r.monster_id] = [];
    DB.learnset[r.monster_id].push(r.move_id);
  }

  renderDexList();
  renderMoveIndex();
}

init().catch(err=>{
  console.error(err);
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<h2>読み込みエラー</h2><div class="muted">${escapeHtml(err?.message || err)}</div>`;
  document.body.prepend(el);
});
