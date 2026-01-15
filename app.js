// Pick Lab Battle MVP (client-only)
// NOTE: ブラウザだけで動くCPU戦。対人はサーバー権威化が必要（後でWorker等に移す前提）。

const STAB = 1.2;
const RAND_MIN = 0.90;
const RAND_MAX = 1.00;

const STAGE_MULT = {
  "-3": 0.70,
  "-2": 0.85,
  "-1": 0.93,
  "0": 1.00,
  "1": 1.10,
  "2": 1.25,
  "3": 1.45
};

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function mulberry32(seed){
  let t = seed >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  }
}

function nowSeed(){
  return (Date.now() ^ (Math.random()*1e9)) >>> 0;
}

function parseCSV(text){
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim().length);
  const header = lines[0].split(",").map(s=>s.trim());
  const rows = [];
  for(let i=1;i<lines.length;i++){
    const cols = lines[i].split(",").map(s=>s.trim());
    const obj = {};
    header.forEach((h, idx)=> obj[h] = (cols[idx] ?? ""));
    rows.push(obj);
  }
  return rows;
}

async function loadAll(){
  const [typesT, chartT, movesT, monsT, learnT] = await Promise.all([
    fetch("./data/types.csv").then(r=>r.text()),
    fetch("./data/type_chart.csv").then(r=>r.text()),
    fetch("./data/moves.csv").then(r=>r.text()),
    fetch("./data/monsters.csv").then(r=>r.text()),
    fetch("./data/learnset.csv").then(r=>r.text())
  ]);
  const types = parseCSV(typesT);
  const chartRows = parseCSV(chartT);
  const moves = parseCSV(movesT);
  const mons = parseCSV(monsT);
  const learn = parseCSV(learnT);

  const typeName = Object.fromEntries(types.map(t=>[t.type_id, t.type_name]));
  const moveMap = Object.fromEntries(moves.map(m => [m.move_id, normalizeMove(m)]));
  const monMap  = Object.fromEntries(mons.map(m => [m.id, normalizeMon(m)]));

  const chart = {};
  for (const r of chartRows){
    if (!chart[r.atk_type]) chart[r.atk_type] = {};
    chart[r.atk_type][r.def_type] = Number(r.mult);
  }

  const learnset = {};
  for (const r of learn){
    if (!learnset[r.monster_id]) learnset[r.monster_id] = [];
    learnset[r.monster_id].push(r.move_id);
  }

  return {typeName, chart, moveMap, monMap, learnset};
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
    img: `./assets/mon/${m.id}.svg`,
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

function getTypeMult(chart, atkType, defType1, defType2){
  if (atkType === "NONE") return 1.0;
  const m1 = (chart[atkType]?.[defType1] ?? 1.0);
  const m2 = (defType2 && defType2 !== "NONE") ? (chart[atkType]?.[defType2] ?? 1.0) : 1.0;
  return m1 * m2;
}

function pctInt(hpNow, hpMax){
  return Math.floor((hpNow / hpMax) * 100);
}

function multLabel(m){
  if (m >= 4) return "超効果(4x)";
  if (m >= 2) return "効果あり(2x)";
  if (m >= 1) return "等倍(1x)";
  if (m >= 0.5) return "いまひとつ(0.5x)";
  return "激いまひとつ(0.25x)";
}

function badgeText(m){
  if (m === 0.25) return "x0.25";
  if (m === 0.5) return "x0.5";
  if (m === 1) return "x1";
  if (m === 2) return "x2";
  if (m === 4) return "x4";
  return "x" + m.toFixed(2);
}

function applyStage(base, stage){
  const s = String(clamp(stage, -3, 3));
  return base * STAGE_MULT[s];
}

function makeFighter(mon, moveIds, tuning){
  const t = tuning || {hp:0, atk:0, def:0, spd:0};
  return {
    mon_id: mon.id,
    name: mon.name,
    type1: mon.type1,
    type2: mon.type2,
    img: mon.img || (`./assets/mon/${mon.id}.svg`),
    hpMax: mon.hp + (t.hp||0),
    hpNow: mon.hp + (t.hp||0),
    atkBase: mon.atk + (t.atk||0),
    defBase: mon.def + (t.def||0),
    spdBase: mon.spd + (t.spd||0),
    atkStage: 0,
    defStage: 0,
    spdStage: 0,
    guardActive: false,
    lastDamageTakenThisTurn: 0,
    moves4: moveIds.slice(0,4),
    pp: Object.fromEntries(moveIds.slice(0,4).map(id => [id, null])),
    tuning: {hp:(t.hp||0), atk:(t.atk||0), def:(t.def||0), spd:(t.spd||0)}
  };
}

function initPP(f, moveMap){
  for (const id of f.moves4){
    f.pp[id] = moveMap[id].pp;
  }
}

function isFainted(f){ return f.hpNow <= 0; }

function randRange(rng, a, b){
  return a + (b-a) * rng();
}

function calcExpectedDamage(state, atkF, defF, move){
  if (move.flags.includes("OHKO")){
    if (defF.guardActive) return 0;
    const ohkoWeight = 0.5;
    return defF.hpNow * (move.accuracy/100) * ohkoWeight;
  }
  if (move.power <= 0) return 0;
  const stab = (move.type !== "NONE" && (move.type === atkF.type1 || move.type === atkF.type2)) ? STAB : 1.0;
  const mult = getTypeMult(state.chart, move.type, defF.type1, defF.type2);
  const acc = move.accuracy/100;
  const rnd = 0.95;

  const atk = applyStage(atkF.atkBase, atkF.atkStage);
  const def = applyStage(defF.defBase, defF.defStage);

  const base = move.power * (atk / def);
  return Math.floor(base * stab * mult * acc * rnd);
}

function estimateOppBestDamage(state, oppF, meF){
  let best = 0;
  for (const id of oppF.moves4){
    const move = state.moveMap[id];
    if (move.power <= 0 && !move.flags.includes("OHKO")) continue;
    const dmg = calcExpectedDamage(state, oppF, meF, move);
    best = Math.max(best, dmg);
  }
  return best;
}

function bestAttack(state, atkF, defF){
  let best = null;
  let second = null;
  for (const id of atkF.moves4){
    const move = state.moveMap[id];
    if (atkF.pp[id] <= 0) continue;
    const dmg = calcExpectedDamage(state, atkF, defF, move);
    const entry = {move_id:id, dmg, move};
    if (!best || dmg > best.dmg){
      second = best;
      best = entry;
    } else if (!second || dmg > second.dmg){
      second = entry;
    }
  }
  if (!best) return null;
  if (best.move.flags.includes("OHKO") && second){
    if (state.rng() < 0.20) return best;
    return second;
  }
  return best;
}

function pickSupportMove(state, cpuF, oppF){
  // フラグ/効果で判定（データ追加してもCPUが使えるようにする）
  const pickBy = (pred) => cpuF.moves4.find(id => cpuF.pp[id] > 0 && pred(state.moveMap[id]));
  const guardId = pickBy(m => m.flags.includes("GUARD"));
  const healId  = pickBy(m => m.flags.includes("HEAL"));
  const defUpId = pickBy(m => m.flags.includes("BUFF") && /^DEF:\+\d+/.test(m.effect));
  const atkUpId = pickBy(m => m.flags.includes("BUFF") && /^ATK:\+\d+/.test(m.effect));
  const spdUpId = pickBy(m => m.flags.includes("BUFF") && /^SPD:\+\d+/.test(m.effect));
  const defDnId = pickBy(m => m.flags.includes("DEBUFF") && /^DEF:-\d+/.test(m.effect));
  const spdDnId = pickBy(m => m.flags.includes("DEBUFF") && /^SPD:-\d+/.test(m.effect));
  const atkDnId = pickBy(m => m.flags.includes("DEBUFF") && /^ATK:-\d+/.test(m.effect));

  const hpRatio = cpuF.hpNow / cpuF.hpMax;
  const oppBest = estimateOppBestDamage(state, oppF, cpuF);

  // 優先度：GUARD > HEAL > DEF_UP > ATK_UP > SPD_UP > DEBUFF
  if (guardId && (oppBest >= cpuF.hpNow * 0.60)) return guardId;
  if (healId && (hpRatio <= 0.45)) return healId;
  if (defUpId && (oppBest >= cpuF.hpNow * 0.45)) return defUpId;

  const bestAtk = bestAttack(state, cpuF, oppF);
  if (atkUpId && bestAtk && (bestAtk.dmg < oppF.hpNow * 0.10) && (oppBest < cpuF.hpNow * 0.45)) return atkUpId;

  if (spdUpId && (applyStage(cpuF.spdBase, cpuF.spdStage) < applyStage(oppF.spdBase, oppF.spdStage))) return spdUpId;

  // デバフは“たまに”当てる役
  if (defDnId) return defDnId;
  if (spdDnId) return spdDnId;
  if (atkDnId) return atkDnId;

  return null;
}

function pickBestSwitchTarget(state, side, oppF){
  let best = null;
  for (const f of side.bench()){
    if (isFainted(f)) continue;
    const oppBestToThis = estimateOppBestDamage(state, oppF, f);
    const myBestToOpp = bestAttack(state, f, oppF)?.dmg ?? 0;
    const score = (myBestToOpp * 1.0) - (oppBestToThis * 1.2);
    if (!best || score > best.score) best = {fighter:f, score};
  }
  return best?.fighter ?? null;
}

function chooseCPUAction(state){
  const cpu = state.p2;
  const opp = state.p1;
  const cpuF = cpu.active();
  const oppF = opp.active();

  const baseAtk = 0.93;
  const supportPick = pickSupportMove(state, cpuF, oppF);
  let pSupport = supportPick ? 0.10 : 0.00;

  let pSwitch = 0.01;
  const bestAtk = bestAttack(state, cpuF, oppF);
  const badOffense = bestAtk ? (bestAtk.dmg < oppF.hpNow * 0.07) : true;
  const inDanger = estimateOppBestDamage(state, oppF, cpuF) >= cpuF.hpNow * 0.70;
  if (badOffense && inDanger) pSwitch = 0.10;

  const r = state.rng();

  if (r < baseAtk){
    return {kind:"move", move_id: (bestAtk?.move_id ?? cpuF.moves4[0])};
  }
  if (supportPick && r < baseAtk + pSupport){
    return {kind:"move", move_id: supportPick};
  }
  if (cpu.bench().length > 0 && state.rng() < pSwitch){
    const to = pickBestSwitchTarget(state, cpu, oppF);
    if (to) return {kind:"switch", to: to.mon_id};
  }
  return {kind:"move", move_id: (bestAtk?.move_id ?? cpuF.moves4[0])};
}

function makeSide(id, name, fighters){
  return {
    id, name,
    team: fighters,
    activeIndex: 0,
    justSwitched: false,
    active(){ return this.team[this.activeIndex]; },
    bench(){ return this.team.filter((_,idx)=> idx !== this.activeIndex); },
    remaining(){ return this.team.filter(f => !isFainted(f)).length; }
  };
}

function rollHit(state, move){ return state.rng() < (move.accuracy/100); }

function useMove(state, user, foe, move){
  const events = [];
  const a = user.active();
  const d = foe.active();

  if (move.flags.includes("BUFF") || move.flags.includes("DEBUFF") || move.flags.includes("HEAL") || move.flags.includes("GUARD")){
    events.push({type:"use", side:user.id, name:a.name, move: move.name, moveType: move.type, flags: move.flags});
    if (!rollHit(state, move)){ events.push({type:"miss", side:user.id}); return events; }

    if (move.flags.includes("GUARD")){
      a.guardActive = true;
      events.push({type:"guard", side:user.id});
      return events;
    }
    if (move.flags.includes("HEAL")){
      const m = /HP:\+([0-9.]+)/.exec(move.effect);
      const ratio = m ? Number(m[1]) : 0.25;
      const heal = Math.floor(a.hpMax * ratio);
      a.hpNow = clamp(a.hpNow + heal, 0, a.hpMax);
      events.push({type:"heal", side:user.id, amount: heal});
      return events;
    }
    const eff = move.effect.trim();
    if (eff){
      const [stat, deltaStr] = eff.split(":");
      const delta = Number(deltaStr);
      if (move.flags.includes("BUFF")){
        if (stat === "ATK") a.atkStage = clamp(a.atkStage + delta, -3, 3);
        if (stat === "DEF") a.defStage = clamp(a.defStage + delta, -3, 3);
        if (stat === "SPD") a.spdStage = clamp(a.spdStage + delta, -3, 3);
        events.push({type:"buff", side:user.id, stat, stage: (stat==="ATK"?a.atkStage:stat==="DEF"?a.defStage:a.spdStage)});
      } else {
        if (stat === "ATK") d.atkStage = clamp(d.atkStage + delta, -3, 3);
        if (stat === "DEF") d.defStage = clamp(d.defStage + delta, -3, 3);
        if (stat === "SPD") d.spdStage = clamp(d.spdStage + delta, -3, 3);
        events.push({type:"debuff", side:foe.id, stat, stage: (stat==="ATK"?d.atkStage:stat==="DEF"?d.defStage:d.spdStage)});
      }
    }
    return events;
  }

  if (move.flags.includes("COUNTER")){
    events.push({type:"use", side:user.id, name:a.name, move: move.name, moveType: move.type, flags: move.flags});
    if (!rollHit(state, move)){ events.push({type:"miss", side:user.id}); return events; }
    const ret = /RET:([0-9.]+)/.exec(move.effect);
    const mult = ret ? Number(ret[1]) : 1.5;
    const dmg = Math.floor(a.lastDamageTakenThisTurn * mult);
    if (dmg <= 0){ events.push({type:"msg", text:`${a.name}のカウンターは不発…`}); return events; }
    d.hpNow = clamp(d.hpNow - dmg, 0, d.hpMax);
    d.lastDamageTakenThisTurn += dmg;
    events.push({type:"damage", to:foe.id, amount:dmg, hpAfter:d.hpNow, typeMult:1});
    return events;
  }

  if (move.flags.includes("OHKO")){
    events.push({type:"use", side:user.id, name:a.name, move: move.name, moveType: move.type, flags: move.flags});
    if (d.guardActive){ events.push({type:"msg", text:`${d.name}はガード中！ 一撃必殺は無効。`}); return events; }
    if (!rollHit(state, move)){ events.push({type:"miss", side:user.id}); return events; }
    d.hpNow = 0;
    d.lastDamageTakenThisTurn += d.hpMax;
    events.push({type:"ohko", to: foe.id});
    return events;
  }

  events.push({type:"use", side:user.id, name:a.name, move: move.name, moveType: move.type, flags: move.flags});
  if (!rollHit(state, move)){ events.push({type:"miss", side:user.id}); return events; }

  const stab = (move.type !== "NONE" && (move.type === a.type1 || move.type === a.type2)) ? STAB : 1.0;
  const typeMult = getTypeMult(state.chart, move.type, d.type1, d.type2);

  const atk = applyStage(a.atkBase, a.atkStage);
  const def = applyStage(d.defBase, d.defStage);

  const rnd = randRange(state.rng, RAND_MIN, RAND_MAX);
  let dmg = Math.floor(move.power * (atk/def) * stab * typeMult * rnd);
  dmg = Math.max(1, dmg);

  const ignoreGuard = /IGNORE_GUARD:1/.test(move.effect);
  if (d.guardActive && !ignoreGuard){
    dmg = Math.max(1, Math.floor(dmg * 0.5));
  }

  d.hpNow = clamp(d.hpNow - dmg, 0, d.hpMax);
  d.lastDamageTakenThisTurn += dmg;
  events.push({type:"damage", to: foe.id, amount:dmg, hpAfter:d.hpNow, typeMult});
  return events;
}

function doSwitch(state, side, toMonId){
  const events = [];
  const idx = side.team.findIndex(f => f.mon_id === toMonId);
  if (idx < 0) return events;
  if (isFainted(side.team[idx])) return events;
  if (side.activeIndex === idx) return events;
  side.activeIndex = idx;
  side.justSwitched = true;
  events.push({type:"switch", side:side.id, to: side.active().name});
  return events;
}

function handleFaint(state, side){
  const events = [];
  const f = side.active();
  events.push({type:"faint", side: side.id, name: f.name});
  if (side.remaining() <= 0){
    state.ended = true;
    state.winner = (side.id === "p1") ? "p2" : "p1";
    events.push({type:"end", winner: state.winner});
    return events;
  }
  const next = side.bench().find(x => !isFainted(x));
  if (next){
    side.activeIndex = side.team.findIndex(x => x.mon_id === next.mon_id);
    events.push({type:"switch_auto", side: side.id, to: next.name});
  }
  return events;
}

function resolveTurn(state, p1Action, p2Action){
  const p1 = state.p1, p2 = state.p2;
  p1.active().lastDamageTakenThisTurn = 0;
  p2.active().lastDamageTakenThisTurn = 0;

  const events = [];
  if (p1Action.kind === "switch") events.push(...doSwitch(state, p1, p1Action.to));
  if (p2Action.kind === "switch") events.push(...doSwitch(state, p2, p2Action.to));

  const canP1Move = (p1Action.kind === "move" && !p1.justSwitched);
  const canP2Move = (p2Action.kind === "move" && !p2.justSwitched);

  const movesToRun = [];
  if (canP1Move) movesToRun.push({side:p1, action:p1Action});
  if (canP2Move) movesToRun.push({side:p2, action:p2Action});

  movesToRun.sort((a,b)=>{
    const ma = state.moveMap[a.action.move_id];
    const mb = state.moveMap[b.action.move_id];
    if (ma.priority !== mb.priority) return mb.priority - ma.priority;
    const sa = applyStage(a.side.active().spdBase, a.side.active().spdStage);
    const sb = applyStage(b.side.active().spdBase, b.side.active().spdStage);
    if (sa !== sb) return sb - sa;
    return state.rng() < 0.5 ? -1 : 1;
  });

  for (const item of movesToRun){
    if (state.ended) break;
    const user = item.side;
    const foe = (user === p1) ? p2 : p1;
    if (isFainted(user.active())) continue;

    const move = state.moveMap[item.action.move_id];
    if (user.active().pp[move.move_id] <= 0){
      events.push({type:"msg", text:`${user.name}の${user.active().name}はPP切れ…`});
      continue;
    }
    user.active().pp[move.move_id]--;
    events.push(...useMove(state, user, foe, move));
    if (state.ended) break;
    if (isFainted(foe.active())) events.push(...handleFaint(state, foe));
  }

  p1.active().guardActive = false;
  p2.active().guardActive = false;
  p1.justSwitched = false;
  p2.justSwitched = false;

  return events;
}

function maskForUI(state){
  const opp = state.p2.active();
  const me  = state.p1.active();
  return {
    turn: state.turn,
    ended: state.ended,
    winner: state.winner,
    opp: {
      active: {
        name: opp.name,
        type1: state.typeName[opp.type1] ?? opp.type1,
        type2: (opp.type2 && opp.type2 !== "NONE") ? (state.typeName[opp.type2] ?? opp.type2) : null,
        hpPct: pctInt(opp.hpNow, opp.hpMax)
      },
      remaining: state.p2.remaining()
    },
    me: {
      active: {
        name: me.name,
        type1: state.typeName[me.type1] ?? me.type1,
        type2: (me.type2 && me.type2 !== "NONE") ? (state.typeName[me.type2] ?? me.type2) : null,
        hpNow: me.hpNow,
        hpMax: me.hpMax,
        hpPct: pctInt(me.hpNow, me.hpMax)
      },
      bench: state.p1.bench().map(b => ({
        mon_id: b.mon_id,
        name: b.name,
        type1: state.typeName[b.type1] ?? b.type1,
        type2: (b.type2 && b.type2 !== "NONE") ? (state.typeName[b.type2] ?? b.type2) : null,
        hpNow: b.hpNow,
        hpMax: b.hpMax,
        hpPct: pctInt(b.hpNow, b.hpMax),
        fainted: isFainted(b)
      })),
      remaining: state.p1.remaining()
    }
  };
}

// UI refs
const elSetup = document.getElementById("setup");
const elBattle = document.getElementById("battle");
const elRoster = document.getElementById("roster");
const elMovesets = document.getElementById("movesets");
const elLeadPick = document.getElementById("leadPick");
const btnStart = document.getElementById("btnStart");
const btnRandom = document.getElementById("btnRandom");
const btnNew = document.getElementById("btnNew");
const btnExportLog = document.getElementById("btnExportLog");
const elOpp = document.getElementById("oppPanel");
const elMe = document.getElementById("mePanel");
const elCmd = document.getElementById("cmdPanel");
const elLog = document.getElementById("log");

let DB = null;
let buildState = { picked: [], movesets: {}, tuning: {}, lead: null };
let game = null;
let adminLog = null;

function logLine(s){
  const div = document.createElement("div");
  div.textContent = s;
  elLog.appendChild(div);
  elLog.scrollTop = elLog.scrollHeight;
}

function flashPanel(which, type){
  const el = (which === "p1") ? document.getElementById("mePanel") : document.getElementById("oppPanel");
  if (!el) return;
  el.classList.remove("fxFlash");
  const colorMap = {NONE:"#A7B0BF",FIRE:"#FF6B4A",WATER:"#3BA7FF",WOOD:"#35C66A",THUNDER:"#FFCC33",ICE:"#66D7FF",ROCK:"#C7A36A",WIND:"#7EE0C4",DARK:"#7A6CFF"};
  const c = colorMap[type] || "#2b5cff";
  el.style.boxShadow = `0 0 0 6px ${c}33`;
  el.classList.add("fxFlash");
  setTimeout(()=>{ el.classList.remove("fxFlash"); el.style.boxShadow=""; }, 380);
}
function clearLog(){ elLog.innerHTML = ""; }

function renderRoster(){
  elRoster.innerHTML = "";
  const mons = Object.values(DB.monMap);
  for (const m of mons){
    const wrap = document.createElement("div");
    wrap.className = "builderMon";
    const checked = buildState.picked.includes(m.id);
    wrap.innerHTML = `
      <div class="imgRow">
        <img class="monImg" src="./assets/mon/${m.id}.svg" alt="${m.name}">
        <div style="flex:1">
          <div class="monLine">
            <div>
              <div class="monName">${m.name}</div>
              <div class="muted small">${DB.typeName[m.type1]}${m.type2 && m.type2!=="NONE" ? " / "+DB.typeName[m.type2] : ""}</div>
            </div>
            <div class="right">
              <span class="badge mono">${m.hp+m.atk+m.def+m.spd}</span>
              <input type="checkbox" ${checked ? "checked":""} />
            </div>
          </div>
          <div class="muted small">HP ${m.hp} / ATK ${m.atk} / DEF ${m.def} / SPD ${m.spd}</div>
        </div>
      </div>
    `;
    const cb = wrap.querySelector("input[type=checkbox]");
    cb.addEventListener("change", ()=>{
      if (cb.checked){
        if (buildState.picked.length >= 3){ cb.checked = false; return; }
        buildState.picked.push(m.id);
      } else {
        buildState.picked = buildState.picked.filter(x=>x!==m.id);
        delete buildState.movesets[m.id];
        if (buildState.lead === m.id) buildState.lead = null;
      }
      renderMovesets();
      renderLeadPick();
      validateStart();
    });
    elRoster.appendChild(wrap);
  }
}

function renderMovesets(){
  elMovesets.innerHTML = "";
  for (const monId of buildState.picked){
    const mon = DB.monMap[monId];
    const pool = (DB.learnset[monId] ?? []).map(id => DB.moveMap[id]).sort((a,b)=>a.name.localeCompare(b.name,"ja"));
    if (!buildState.movesets[monId]) buildState.movesets[monId] = [];

    const box = document.createElement("div");
    box.className = "builderMon";
    box.innerHTML = `
      <div class="imgRow">
        <img class="monImg" src="./assets/mon/${mon.id}.svg" alt="${mon.name}">
        <div style="flex:1">
          <div class="monName">${mon.name}</div>
          <div class="muted small">${DB.typeName[mon.type1]}${mon.type2 && mon.type2!=="NONE" ? " / "+DB.typeName[mon.type2] : ""}</div>
        </div>
      </div>
      <div class="sep"></div>
      <div class="muted small"><b>調整ポイント（努力値の代わり）</b>：合計80まで / 1つ40まで（各+1）</div>
      <div class="grid2" style="margin-top:8px" id="tp-${monId}">
        <div><label>HP</label><input type="number" min="0" max="40" step="1" data-tp="hp" value="0"></div>
        <div><label>ATK</label><input type="number" min="0" max="40" step="1" data-tp="atk" value="0"></div>
        <div><label>DEF</label><input type="number" min="0" max="40" step="1" data-tp="def" value="0"></div>
        <div><label>SPD</label><input type="number" min="0" max="40" step="1" data-tp="spd" value="0"></div>
      </div>
      <div class="muted small" id="tpRem-${monId}">残り：80</div>
      <div class="sep"></div>
      <div class="grid2" id="ms-${monId}"></div>
      <div class="muted small" style="margin-top:8px">※OHKOはチーム1個まで</div>
    `;
    const grid = box.querySelector(`#ms-${monId}`);

    // 調整ポイント
    if (!buildState.tuning[monId]) buildState.tuning[monId] = {hp:0, atk:0, def:0, spd:0};
    const tpBox = box.querySelector(`#tp-${monId}`);
    const tpRem = box.querySelector(`#tpRem-${monId}`);
    const inputs = [...tpBox.querySelectorAll('input[data-tp]')];
    const refreshTP = ()=>{
      const t = buildState.tuning[monId];
      const used = (t.hp||0)+(t.atk||0)+(t.def||0)+(t.spd||0);
      const rem = 80 - used;
      tpRem.textContent = `残り：${rem}`;
      tpRem.style.color = (rem < 0) ? "#d11f3a" : "#586579";
      validateStart();
    };
    inputs.forEach(inp=>{
      const k = inp.dataset.tp;
      inp.value = buildState.tuning[monId][k] ?? 0;
      inp.addEventListener('input', ()=>{
        const v = Math.max(0, Math.min(40, Number(inp.value)||0));
        buildState.tuning[monId][k] = v;
        inp.value = v;
        refreshTP();
      });
    });
    refreshTP();

    for(let i=0;i<4;i++){
      const sel = document.createElement("select");
      const current = buildState.movesets[monId][i] ?? "";
      sel.innerHTML = `<option value="">技${i+1}（未選択）</option>` + pool.map(m=>{
        const ohko = m.flags.includes("OHKO") ? " [OHKO]" : "";
        const extra = m.power>0 ? ` 威力${m.power}` : (m.flags.includes("HEAL")?" 回復":m.flags.includes("GUARD")?" ガード":m.flags.includes("BUFF")?" 強化":m.flags.includes("DEBUFF")?" 弱体":m.flags.includes("COUNTER")?" 反撃":"");
        return `<option value="${m.move_id}" ${m.move_id===current?"selected":""}>${m.name}${ohko} / ${m.type==="NONE"?"無":DB.typeName[m.type]} / 命中${m.accuracy}${extra}</option>`;
      }).join("");
      sel.addEventListener("change", ()=>{ buildState.movesets[monId][i] = sel.value || ""; validateStart(); });
      grid.appendChild(sel);
    }
    elMovesets.appendChild(box);
  }
}

function renderLeadPick(){
  elLeadPick.innerHTML = "";
  if (buildState.picked.length !== 3){
    elLeadPick.innerHTML = `<div class="muted">先に3体選択してください</div>`;
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "grid3";
  for (const monId of buildState.picked){
    const mon = DB.monMap[monId];
    const div = document.createElement("div");
    div.className = "builderMon";
    const checked = (buildState.lead === monId);
    div.innerHTML = `
      <label class="tag"><input type="radio" name="lead" ${checked?"checked":""} /> <b>${mon.name}</b></label>
      <div class="muted small">${DB.typeName[mon.type1]}${mon.type2 && mon.type2!=="NONE" ? " / "+DB.typeName[mon.type2] : ""}</div>
    `;
    div.querySelector("input").addEventListener("change", ()=>{ buildState.lead = monId; validateStart(); });
    wrap.appendChild(div);
  }
  elLeadPick.appendChild(wrap);
}

function countTeamOHKO(){
  let c = 0;
  for (const monId of buildState.picked){
    const set = buildState.movesets[monId] ?? [];
    for (const mv of set){
      if (mv && DB.moveMap[mv]?.flags.includes("OHKO")) c++;
    }
  }
  return c;
}

function validateStart(){
  if (buildState.picked.length !== 3) { btnStart.disabled = true; return; }
  if (!buildState.lead) { btnStart.disabled = true; return; }
  for (const monId of buildState.picked){
    const t = buildState.tuning[monId] || {hp:0,atk:0,def:0,spd:0};
    const used = (t.hp||0)+(t.atk||0)+(t.def||0)+(t.spd||0);
    if (used > 80) { btnStart.disabled = true; return; }

    const set = buildState.movesets[monId] ?? [];
    if (set.length < 4 || set.some(x=>!x)) { btnStart.disabled = true; return; }
  }
  if (countTeamOHKO() > 1){ btnStart.disabled = true; return; }
  btnStart.disabled = false;
}

function randomPick(){
  const all = Object.keys(DB.monMap);
  buildState.picked = [];
  buildState.movesets = {};
  buildState.tuning = {};
  buildState.lead = null;

  const pool = all.slice();
  for(let i=0;i<3;i++){
    const idx = Math.floor(Math.random()*pool.length);
    buildState.picked.push(pool.splice(idx,1)[0]);
  }

  let ohkoTaken = false;
  for (const monId of buildState.picked){
    const ls = (DB.learnset[monId] ?? []).slice();
    const picks = [];
    for (let i=0;i<4;i++){
      let tries = 0;
      while (tries++ < 40 && ls.length){
        const midx = Math.floor(Math.random()*ls.length);
        const mv = ls[midx];
        const isOhko = DB.moveMap[mv].flags.includes("OHKO");
        if (isOhko && ohkoTaken) { ls.splice(midx,1); continue; }
        if (isOhko && Math.random() > 0.25) { ls.splice(midx,1); continue; }
        picks.push(mv);
        if (isOhko) ohkoTaken = true;
        ls.splice(midx,1);
        break;
      }
      if (picks.length < i+1 && ls.length) picks.push(ls.pop());
    }
    buildState.movesets[monId] = picks.slice(0,4);
    // 調整ポイントは軽めにランダム（合計0〜40）
    const totalTP = Math.floor(Math.random()*41);
    const keys = ['hp','atk','def','spd'];
    const t = {hp:0,atk:0,def:0,spd:0};
    let rem = totalTP;
    while(rem>0){
      const k = keys[Math.floor(Math.random()*keys.length)];
      if (t[k] < 40) { t[k]++; rem--; }
    }
    buildState.tuning[monId] = t;
  }
  buildState.lead = buildState.picked[0];

  renderRoster();
  renderMovesets();
  renderLeadPick();
  validateStart();
}

function buildTeam(sideId, sideName, picked, movesets, tuningMap, leadId, moveMap, monMap){
  const fighters = picked.map(monId => makeFighter(monMap[monId], movesets[monId], (tuningMap && tuningMap[monId]) ? tuningMap[monId] : null));
  for (const f of fighters) initPP(f, moveMap);
  const side = makeSide(sideId, sideName, fighters);
  const leadIdx = fighters.findIndex(f => f.mon_id === leadId);
  side.activeIndex = (leadIdx >= 0) ? leadIdx : 0;
  return side;
}

function buildCPU(DB){
  const all = Object.keys(DB.monMap);
  const rng = Math.random;
  const picked = [];
  const pool = all.slice();
  for (let i=0;i<3;i++){
    const idx = Math.floor(rng()*pool.length);
    picked.push(pool.splice(idx,1)[0]);
  }
  const movesets = {};
  let ohkoTaken = false;
  for (const monId of picked){
    const ls = (DB.learnset[monId] ?? []).slice();
    const picks = [];
    for (let i=0;i<4;i++){
      let tries = 0;
      while (tries++ < 60 && ls.length){
        const midx = Math.floor(rng()*ls.length);
        const mv = ls[midx];
        const isOhko = DB.moveMap[mv].flags.includes("OHKO");
        if (isOhko && ohkoTaken) { ls.splice(midx,1); continue; }
        if (isOhko && rng() > 0.20) { ls.splice(midx,1); continue; }
        picks.push(mv);
        if (isOhko) ohkoTaken = true;
        ls.splice(midx,1);
        break;
      }
      if (picks.length < i+1 && ls.length) picks.push(ls.pop());
    }
    movesets[monId] = picks.slice(0,4);
  }
  const leadId = picked[Math.floor(rng()*picked.length)];
    // CPUの調整ポイント（合計60、偏りは少しだけ）
  const tuning = {};
  for (const monId of picked){
    const m = DB.monMap[monId];
    const t = {hp:0, atk:0, def:0, spd:0};
    let rem = 60;
    const weights = {
      hp: (m.hp >= 180 ? 3 : 1),
      def: (m.def >= 150 ? 3 : 1),
      atk: (m.atk >= 160 ? 3 : 1),
      spd: (m.spd >= 160 ? 3 : 1),
    };
    const keys = ["hp","atk","def","spd"];
    const bag = [];
    keys.forEach(k=>{ for(let i=0;i<weights[k];i++) bag.push(k); });
    while(rem>0){
      const k = bag[Math.floor(Math.random()*bag.length)];
      if (t[k] < 30){ t[k]++; rem--; }
      else {
        const kk = keys[Math.floor(Math.random()*keys.length)];
        if (t[kk] < 30){ t[kk]++; rem--; }
      }
      if (t.hp + t.atk + t.def + t.spd >= 60) break;
    }
    tuning[monId] = t;
  }
  return {picked, movesets, tuning, leadId};
}

function startBattle(){
  const seed = nowSeed();
  const rng = mulberry32(seed);
  const cpuBuild = buildCPU(DB);

  game = { seed, rng, turn: 1, ended:false, winner:null, chart:DB.chart, typeName:DB.typeName, moveMap:DB.moveMap, monMap:DB.monMap, p1:null, p2:null };
  game.p1 = buildTeam("p1","自分", buildState.picked, buildState.movesets, buildState.tuning, buildState.lead, DB.moveMap, DB.monMap);
  game.p2 = buildTeam("p2","CPU", cpuBuild.picked, cpuBuild.movesets, cpuBuild.tuning, cpuBuild.leadId, DB.moveMap, DB.monMap);

  adminLog = {
    match_id: `${new Date().toISOString().slice(0,10).replaceAll("-","")}-${seed.toString(16)}`,
    seed,
    rules: { format:"3v3_single_no_preview", switch_consumes_turn:true, stab:STAB, rand_min:RAND_MIN, rand_max:RAND_MAX, ohko_accuracy:0.30 },
    teams: { p1:{mon_ids:[...buildState.picked], lead:buildState.lead, movesets: JSON.parse(JSON.stringify(buildState.movesets)), tuning: JSON.parse(JSON.stringify(buildState.tuning))},
             p2:{mon_ids:[...cpuBuild.picked], lead:cpuBuild.leadId, movesets: JSON.parse(JSON.stringify(cpuBuild.movesets)), tuning: JSON.parse(JSON.stringify(cpuBuild.tuning))} },
    turns: [],
    result: null
  };

  clearLog();
  logLine(`=== 対戦開始 seed=${seed} ===`);
  document.getElementById("setup").classList.add("hidden");
  document.getElementById("battle").classList.remove("hidden");
  renderBattle();
}

function renderBattle(){
  const ui = maskForUI(game);

  const o = ui.opp.active;
  document.getElementById("oppPanel").innerHTML = `
    <div class="imgRow">
      <img class="monImg" src="${game.p2.active().img}" alt="${o.name}">
      <div style="flex:1">
        <div class="monLine">
          <div>
            <div class="monName">${o.name}</div>
            <div class="muted small">${o.type1}${o.type2 ? " / "+o.type2 : ""}</div>
          </div>
          <div class="right"><span class="badge">残り ${ui.opp.remaining}/3</span></div>
        </div>
      </div>
    </div>
    <div class="sep"></div>
    <div class="muted small">HP ${o.hpPct}%</div>
    <div class="hpbar"><div style="width:${o.hpPct}%"></div></div>
  `;

  const m = ui.me.active;
  document.getElementById("mePanel").innerHTML = `
    <div class="imgRow">
      <img class="monImg" src="${game.p1.active().img}" alt="${m.name}">
      <div style="flex:1">
        <div class="monLine">
          <div>
            <div class="monName">${m.name}</div>
            <div class="muted small">${m.type1}${m.type2 ? " / "+m.type2 : ""}</div>
          </div>
          <div class="right"><span class="badge">残り ${ui.me.remaining}/3</span></div>
        </div>
      </div>
    </div>
    <div class="sep"></div>
    <div class="muted small">HP ${m.hpNow}/${m.hpMax}（${m.hpPct}%）</div>
    <div class="hpbar"><div style="width:${m.hpPct}%"></div></div>
  `;

  renderCommands();
}

function renderCommands(){
  const me = game.p1.active();
  const opp = game.p2.active();

  const moveBtns = me.moves4.map(id => {
    const mv = game.moveMap[id];
    const pp = me.pp[id];
    let badge = "";
    let label = "";

    if (mv.flags.includes("OHKO")){
      badge = `<span class="badge">OHKO</span>`;
      label = `命中${mv.accuracy}%（一撃必殺）`;
    } else if (mv.flags.includes("GUARD")){
      badge = `<span class="badge">GUARD</span>`;
      label = `半減＋OHKO無効`;
    } else if (mv.flags.includes("HEAL")){
      badge = `<span class="badge">HEAL</span>`;
      label = `HP回復`;
    } else if (mv.flags.includes("BUFF")){
      badge = `<span class="badge">BUFF</span>`;
      label = `強化`;
    } else if (mv.flags.includes("DEBUFF")){
      badge = `<span class="badge">DEBUFF</span>`;
      label = `弱体`;
    } else if (mv.flags.includes("COUNTER")){
      badge = `<span class="badge">COUNTER</span>`;
      label = `被ダメ反撃`;
    } else {
      const mult = getTypeMult(game.chart, mv.type, opp.type1, opp.type2);
      badge = `<span class="badge">${badgeText(mult)}</span>`;
      label = multLabel(mult);
    }

    const disabled = (pp <= 0) ? "disabled" : "";
    return `
      <button class="btn" data-kind="move" data-move="${id}" ${disabled}>
        <div class="monLine">
          <div>
            ${mv.name} <span class="k small">PP ${pp}</span>
            <div class="muted small">${label}</div>
          </div>
          <div>${badge}</div>
        </div>
      </button>
    `;
  }).join("");

  const bench = game.p1.bench().filter(b=>!isFainted(b));
  const switchBtns = bench.map(b => `
    <button class="btn" data-kind="switch" data-to="${b.mon_id}">
      <div class="monLine">
        <div>
          交代：${b.name}
          <div class="muted small">${game.typeName[b.type1]}${b.type2!=="NONE" ? " / "+game.typeName[b.type2] : ""}</div>
        </div>
        <div class="badge">${pctInt(b.hpNow,b.hpMax)}%</div>
      </div>
    </button>
  `).join("");

  const elCmd = document.getElementById("cmdPanel");
  elCmd.innerHTML = `
    <div class="muted small">ターン ${game.turn}：技 or 交代（交代はこのターン攻撃なし）</div>
    <div class="sep"></div>
    <div class="grid2">${moveBtns}</div>
    <div class="sep"></div>
    <div class="grid2">${switchBtns || `<div class="muted">交代先なし</div>`}</div>
  `;

  elCmd.querySelectorAll("button[data-kind]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const kind = btn.dataset.kind;
      const p1Action = (kind === "move") ? {kind:"move", move_id: btn.dataset.move} : {kind:"switch", to: btn.dataset.to};
      stepTurn(p1Action);
    });
  });
}

function writeDisplayEvent(e){
  if (e.type === "switch"){
    if (e.side === "p1") logLine(`自分は ${e.to} に交代`);
    else logLine(`CPUが交代した`);
  }
  if (e.type === "switch_auto"){
    if (e.side === "p1") logLine(`自分は ${e.to} をくりだした`);
    else logLine(`CPUが交代した`);
  }
  if (e.type === "use"){
    if (e.side === "p1") logLine(`自分：${e.name} の ${e.move}`);
    else logLine(`CPUが技を使った`);
    const tgt = (e.side === "p1") ? "p2" : "p1";
    flashPanel(tgt, e.moveType || "NONE");
  }
  if (e.type === "miss"){
    logLine(e.side === "p1" ? `自分の攻撃は外れた` : `CPUの攻撃は外れた`);
  }
  if (e.type === "guard"){
    logLine(e.side === "p1" ? `自分はガードした` : `CPUがガードした`);
  }
  if (e.type === "heal"){
    logLine(e.side === "p1" ? `自分は回復した（+${e.amount}）` : `CPUが回復した`);
  }
  if (e.type === "buff"){
    logLine(e.side === "p1" ? `自分：${e.stat}が変化（段階 ${e.stage}）` : `CPU：能力が変化`);
  }
  if (e.type === "debuff"){
    logLine(e.side === "p1" ? `相手の${e.stat}が変化（段階 ${e.stage}）` : `自分：能力が変化`);
  }
  if (e.type === "damage"){
    logLine(e.to === "p1" ? `自分は ${e.amount} ダメージ` : `相手に ${e.amount} ダメージ`);
  }
  if (e.type === "ohko"){
    logLine(e.to === "p1" ? `自分は一撃で倒された` : `相手が一撃で倒れた`);
  }
  if (e.type === "faint"){
    logLine(e.side === "p1" ? `自分の${e.name}は倒れた` : `相手が倒れた`);
  }
  if (e.type === "msg"){
    logLine(e.text);
  }
}

function stepTurn(p1Action){
  if (game.ended) return;
  const p2Action = chooseCPUAction(game);
  const events = resolveTurn(game, p1Action, p2Action);

  adminLog.turns.push({ t: game.turn, p1: p1Action, p2: p2Action, events: events.map(e=>({...e})) });
  for (const e of events) writeDisplayEvent(e);

  if (game.ended){
    const winnerText = (game.winner === "p1") ? "自分の勝ち" : "CPUの勝ち";
    logLine(`=== 終了：${winnerText} ===`);
    adminLog.result = { winner: game.winner, turns: game.turn };
    renderBattle();
    document.getElementById("cmdPanel").innerHTML = `<div class="muted">終了しました：${winnerText}</div>`;
    return;
  }

  game.turn++;
  renderBattle();
}

document.getElementById("btnStart").addEventListener("click", startBattle);
document.getElementById("btnRandom").addEventListener("click", randomPick);
document.getElementById("btnNew").addEventListener("click", ()=> location.reload());
document.getElementById("btnExportLog").addEventListener("click", ()=>{
  if (!adminLog) return;
  const blob = new Blob([JSON.stringify(adminLog, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `admin_log_${adminLog.match_id}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

(async function init(){
  DB = await loadAll();
  renderRoster();
  renderMovesets();
  renderLeadPick();
  validateStart();
})();
