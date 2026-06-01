'use strict';
const { CONFIG } = require('../shared/config');

const TILE = Object.freeze({ WALL: 0, FLOOR: 1, EXIT: 2, TRAP: 3 });

const MAX_LEVEL     = 30;
const BEATS_PER_TURN = 8;   // 8-beat visual cycle; every beat resolves immediately
const BEAT_MS       = 500;  // ms per beat → 2 beats/sec
const COMBAT_RANGE  = 5;    // Manhattan distance to enter combat mode

// ── Level type system ─────────────────────────────────────────────────────────

function getLevelType(level) {
  if (level % 15 === 0) return 'boss';
  if (level % 5  === 0) return 'special';
  return 'normal';
}

function getSpecialSubtype(level) {
  const idx = Math.floor(level / 5) - Math.floor(level / 15);
  return idx % 2 === 1 ? 'rest' : 'puzzle';
}

function getLevelParams(level) {
  const type = getLevelType(level);
  if (type === 'boss') {
    const bossNum = Math.floor(level / 15);
    return { levelType:'boss', bossNum, monsters:1,
      baseHp: 400+(bossNum-1)*350,  // 400 / 750 / 1100
      baseDmg: 18+(bossNum-1)*4,    // 18 / 22 / 26
      beatMs: 500,
      timer:240, trapCount:4, types:['boss'] };
  }
  if (type === 'special') {
    const sub = getSpecialSubtype(level);
    const tier = Math.floor((level-1)/5);
    if (sub === 'rest')
      return { levelType:'rest', monsters:0, baseHp:0, baseDmg:0, beatMs:500, timer:60, trapCount:0, types:[] };
    return { levelType:'puzzle', monsters:2+tier, baseHp:40+tier*10, baseDmg:6+tier*2,
      beatMs: tier <= 1 ? 650 : 500,
      timer:120, trapCount:3+tier, types:['basic','runner','basic'] };
  }

  const tier = Math.floor((level-1)/5);

  // Beat speed: slow for early levels so players can learn RPS timing
  const beatMs = tier === 0 ? 750    // levels 1–5:  relaxed
               : tier === 1 ? 620    // levels 6–10: medium
               :              500;   // levels 11+:  full speed

  const pools = [
    ['basic'],
    ['basic','runner'],
    ['basic','evader','runner'],
    ['basic','runner','brute','evader'],
    ['runner','brute','archer','evader'],
    ['brute','archer','runner','evader'],
  ];
  const pool  = pools[Math.min(tier, pools.length-1)];

  // Gentler count & stat ramp: tier 0 starts at 3 monsters instead of 5
  const counts = [3, 5, 7, 9, 11, 13];
  const count  = counts[Math.min(tier, counts.length-1)];

  return { levelType:'normal', monsters:count,
    baseHp:  80 + tier*30,   // 80 / 110 / 140 / 170 / 200 / 230
    baseDmg:  5 + tier*3,    //  5 /   8 /  11 /  14 /  17 /  20
    beatMs,
    timer: Math.max(90, 180 - tier*15),   // more time on early levels
    trapCount: Math.max(2, 4 + tier*2),
    types: Array.from({length:count}, (_,i) => pool[i%pool.length]) };
}

// ── RPS combat table ──────────────────────────────────────────────────────────
// Monster stances: 赤(fast slash) 蒼(pierce) 黃(heavy) 移(just moves) 射(archer shot)
// Player actions:  刺(pierce)     斬(slash)  架(guard) null(no action)
//
//  架 beats 赤  | 赤 beats 刺  | 刺 clashes 蒼
//  刺 beats 黃  | 黃 beats 斬  | 斬 clashes 赤
//  斬 beats 蒼  | 蒼 beats 架  | 架 clashes 黃

const STANCE_RESULT = {
//            赤        蒼        黃        移     射      閃(evader cornered)
  '刺': { '赤':'lose', '蒼':'clash','黃':'win', '移':'win','射':'lose','閃':'win' },
  '斬': { '赤':'clash','蒼':'win', '黃':'lose','移':'win','射':'lose','閃':'win' },
  '架': { '赤':'win', '蒼':'lose','黃':'clash','移':'win','射':'block','閃':'win' },
  null: { '赤':'lose', '蒼':'lose','黃':'lose','移':'none','射':'lose','閃':'none' },
};

// ── Monster type definitions ──────────────────────────────────────────────────

const MONSTER_DEFS = {
  basic:  { symbol:'M', color:'#dd3333', bgColor:'#550a0a', hpMult:1.0,  dmgMult:1.0,  size:0.38 },  // 紅
  runner: { symbol:'R', color:'#ff8800', bgColor:'#5a2a00', hpMult:0.75, dmgMult:0.75, size:0.30 },  // 橙
  brute:  { symbol:'B', color:'#5566ff', bgColor:'#12184a', hpMult:1.5,  dmgMult:1.5,  size:0.46 },  // 藍
  evader: { symbol:'E', color:'#22cc88', bgColor:'#0a3a22', hpMult:0.65, dmgMult:0.9,  size:0.32 },  // 翠綠
  archer: { symbol:'A', color:'#ddbb22', bgColor:'#3a3000', hpMult:0.65, dmgMult:1.2,  size:0.33, range:5 },  // 金
  boss:   { symbol:'X', color:'#ff1155', bgColor:'#440010', hpMult:1.0,  dmgMult:1.0,  size:0.55 },  // 深紅（HP/dmg直接來自getLevelParams）
};

// ── Monster 8-beat attack patterns ────────────────────────────────────────────
// 8 entries = 8 beats. '移'=approach, '閃'=dodge away, '休'=rest (immune).
// Brute/boss always start at index 0 (predictable charge). Others random entry.
const MONSTER_PATTERNS = {
  //              1     2     3     4     5     6     7     8
  basic:   ['赤', '移', '蒼', '移', '黃', '移', '移', '休'],
  runner:  ['赤', '赤', '赤', '休', '赤', '赤', '赤', '休'],  // 3-hit combo × 2
  brute:   ['移', '移', '黃', '移', '移', '黃', '移', '黃'],  // charges 2, heavy × 3
  evader:  ['閃', '移', '閃', '赤', '閃', '移', '閃', '赤'],  // odd=dodge, even=approach/attack
  archer:  ['射', '移', '射', '射', '休', '射', '移', '射'],
  boss:    ['赤', '移', '蒼', '移', '黃', '移', '全彈', '移'],  // phase 1: 3 RPS + 1 bullet hell
};

// Boss phase 2 pattern (triggered at 50% HP): denser attacks
const BOSS_PATTERN_P2 = ['赤', '蒼', '黃', '全彈', '赤', '蒼', '黃', '全彈'];

// ── Monster AI (telegraph phase only) ─────────────────────────────────────────
// decide() sets m.stance and m.nextTarget for this turn.

const MONSTER_AI = {

  basic: {
    decide(m, players, gs) {
      const target = _balanced(m, players, gs.monsters);
      if (!target) { m.stance = '移'; return; }
      const pat = MONSTER_PATTERNS.basic;
      m.stance = pat[m.patternIdx % pat.length];
      m.patternIdx++;
      m.nextTarget = target.id;
    },
  },

  runner: {
    decide(m, players, gs) {
      const target = _balanced(m, players, gs.monsters);
      if (!target) { m.stance = '移'; return; }
      const pat = MONSTER_PATTERNS.runner;
      m.stance = pat[m.patternIdx % pat.length];
      m.patternIdx++;
      m.nextTarget = target.id;
      m.rushMove2 = (m.stance === '赤');
    },
  },

  brute: {
    decide(m, players, gs) {
      const target = _balanced(m, players, gs.monsters);
      if (!target) { m.stance = '移'; return; }
      const pat = MONSTER_PATTERNS.brute;
      m.stance = pat[m.patternIdx % pat.length];
      m.patternIdx++;
      m.nextTarget = target.id;
    },
  },

  evader: {
    decide(m, players, gs) {
      const target = _balanced(m, players, gs.monsters);
      if (!target) { m.stance = '移'; return; }
      const pat = MONSTER_PATTERNS.evader;
      m.stance = pat[m.patternIdx % pat.length];
      m.patternIdx++;
      m.nextTarget = target.id;
    },
  },

  archer: {
    decide(m, players, gs) {
      const target = _balanced(m, players, gs.monsters);
      if (!target) { m.stance = '移'; return; }
      const pat = MONSTER_PATTERNS.archer;
      const raw = pat[m.patternIdx % pat.length];
      m.patternIdx++;
      m.nextTarget = target.id;
      if (raw === '射') {
        const d = dist(m.x, m.y, target.x, target.y);
        if (d <= 1) { m.stance = '赤'; }
        else { m.stance = '射'; m.shootFrom={x:m.x,y:m.y}; m.shootTo={x:target.x,y:target.y}; }
      } else {
        m.stance = raw;
      }
    },
  },

  boss: {
    decide(m, players, gs) {
      if (!gs.bossPhase2 && m.hp/m.maxHp < 0.5) {
        gs.bossPhase2 = true;
        m.patternIdx = 0;  // reset to phase 2 pattern
        _msg(gs, `💀 BOSS 狂暴化！節奏改變！`, Date.now());
      }
      gs.windmillAngle = ((gs.windmillAngle||0) + (gs.bossPhase2 ? 0.5 : 0.3));
      _updateWindmill(gs, m);

      const pat = gs.bossPhase2 ? BOSS_PATTERN_P2 : MONSTER_PATTERNS.boss;
      m.stance = pat[m.patternIdx % pat.length];
      m.patternIdx++;
      const target = _balanced(m, players, gs.monsters);
      m.nextTarget = target?.id;
    },
  },
};

// ── Boss helpers ──────────────────────────────────────────────────────────────

function _updateWindmill(gs, boss) {
  const a = gs.windmillAngle||0, arms = [];
  for (let i = 0; i < 4; i++) {
    const angle = a + i*Math.PI/2;
    for (let r = 1; r <= 3; r++) {
      const ax = Math.round(boss.x + r*Math.cos(angle));
      const ay = Math.round(boss.y + r*Math.sin(angle));
      if (ax>0&&ay>0&&ax<gs.W-1&&ay<gs.H-1) arms.push({x:ax,y:ay});
    }
  }
  gs.windmillArms = arms;
}

function _windmillDamage(gs) {
  if (!gs.windmillArms?.length) return;
  const now = Date.now();
  for (const arm of gs.windmillArms) {
    for (const p of Object.values(gs.players)) {
      if (p.hp<=0) continue;
      if (p.x===arm.x && p.y===arm.y) {
        p.hp = Math.max(0, p.hp-40);
        _msg(gs, `${p.name} 被大風車擊中！-40HP`, now);
      }
    }
  }
}

function _fireBulletHell(gs, boss) {
  const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  const now   = Date.now(), dmg = 30;
  for (const [dx,dy] of DIRS8) {
    const path=[];
    let bx=boss.x+dx, by=boss.y+dy;
    while(bx>=0&&by>=0&&bx<gs.W&&by<gs.H){
      if(gs.grid[by][bx]===TILE.WALL) break;
      path.push({x:bx,y:by}); bx+=dx; by+=dy;
    }
    if(!path.length) continue;
    for (const p of Object.values(gs.players)) {
      if(p.hp<=0) continue;
      if(path.some(pt=>pt.x===p.x&&pt.y===p.y)){
        p.hp=Math.max(0,p.hp-dmg);
        _msg(gs,`${p.name} 被彈目擊中！-${dmg}HP`,now);
      }
    }
    const last=path[path.length-1];
    gs.projectiles.push({id:gs.projSeq++,kind:'bullet',
      fromX:boss.x,fromY:boss.y,toX:last.x,toY:last.y,createdAt:now,dur:700});
  }
  _msg(gs,'💥 BOSS 全圖彈目！',now);
}

// ── AI helpers ────────────────────────────────────────────────────────────────

function _nearest(m, players) {
  let target=null, minD=Infinity;
  for(const p of players){const d=dist(m.x,m.y,p.x,p.y); if(d<minD){minD=d;target=p;}}
  return target;
}

// Pick the player with fewest monsters already targeting them; break ties by distance.
function _balanced(m, players, monsters) {
  if(!players.length) return null;
  const counts={};
  for(const p of players) counts[p.id]=0;
  for(const o of monsters){
    if(o.id===m.id||o.hp<=0) continue;
    if(o.nextTarget!=null&&counts[o.nextTarget]!==undefined) counts[o.nextTarget]++;
  }
  let minCount=Infinity;
  for(const p of players) if(counts[p.id]<minCount) minCount=counts[p.id];
  let target=null, minD=Infinity;
  for(const p of players){
    if(counts[p.id]!==minCount) continue;
    const d=dist(m.x,m.y,p.x,p.y);
    if(d<minD){minD=d;target=p;}
  }
  return target;
}

function dist(ax,ay,bx,by){ return Math.abs(ax-bx)+Math.abs(ay-by); }

function _playerDmg(player) {
  return {fighter:18, scout:10, architect:12, scholar:8}[player.role] || 12;
}

function _playerRange(player) {
  return 1;
}

function _isRanged(player) {
  return false;
}

// ── RNG ───────────────────────────────────────────────────────────────────────

function makeLcg(seed) {
  let s=(seed^0xdeadbeef)>>>0;
  return (max)=>{ s=(1664525*s+1013904223)>>>0; return s%(max||1000); };
}

// ── Map dimensions ────────────────────────────────────────────────────────────

function getMapDimensions(params) {
  if (params.levelType === 'boss')   return { W: 26, H: 18 };
  if (params.levelType === 'rest')   return { W: 16, H: 6 };
  if (params.levelType === 'puzzle') return { W: 22, H: 6 };
  return { W: Math.max(20, 8 + params.monsters * 4), H: 6 };
}

// ── Map generation ────────────────────────────────────────────────────────────

function generateDungeon(W, H, trapCount=8) {
  const grid = Array.from({length:H},(_,y)=>
    Array.from({length:W},(_,x)=>(x===0||y===0||x===W-1||y===H-1)?TILE.WALL:TILE.FLOOR));
  const rng = makeLcg(Date.now());
  for(let i=0;i<22;i++){
    const rx=3+rng(W-6), ry=3+rng(H-6), rw=1+rng(3), rh=1+rng(3);
    for(let dy=0;dy<rh;dy++) for(let dx=0;dx<rw;dx++)
      if(ry+dy<H-1&&rx+dx<W-1) grid[ry+dy][rx+dx]=TILE.WALL;
  }
  const sx=2,sy=2,ex=W-2,ey=H-2;
  for(let x=sx;x<=ex;x++) grid[sy][x]=TILE.FLOOR;
  for(let y=sy;y<=ey;y++) grid[y][ex]=TILE.FLOOR;
  const mid=Math.floor(H/2);
  for(let x=1;x<W-1;x++) grid[mid][x]=TILE.FLOOR;
  grid[ey][ex]=TILE.FLOOR; // opened when all monsters cleared
  const traps=[]; const trapTypes=['spike','slow','push']; let tries=0;
  while(traps.length<trapCount&&tries++<400){
    const tx=3+rng(W-6), ty=3+rng(H-6);
    if(grid[ty][tx]!==TILE.FLOOR) continue;
    if(dist(tx,ty,sx,sy)<4||dist(tx,ty,ex,ey)<4) continue;
    if(traps.some(t=>dist(t.x,t.y,tx,ty)<2)) continue;
    traps.push({x:tx,y:ty,type:trapTypes[rng(3)],triggered:false});
    grid[ty][tx]=TILE.TRAP;
  }
  return {grid,traps,exitX:ex,exitY:ey};
}

function generateCorridor(W, H, trapCount=4) {
  const grid = Array.from({length:H}, (_,y) =>
    Array.from({length:W}, (_,x) =>
      (x===0||y===0||x===W-1||y===H-1) ? TILE.WALL : TILE.FLOOR));
  const rng = makeLcg(Date.now());
  const numPillars = Math.floor((W - 12) / 7);
  for (let i = 0; i < numPillars; i++) {
    const bx = 7 + Math.floor(i * (W-14) / Math.max(1, numPillars));
    const px = bx + rng(4) - 1;
    const py = 1 + rng(H-2);
    if (px > 6 && px < W-4 && grid[py]?.[px] === TILE.FLOOR)
      grid[py][px] = TILE.WALL;
  }
  const traps=[]; const trapTypes=['spike','slow','push']; let tries=0;
  while(traps.length < trapCount && tries++ < 400){
    const tx=7+rng(W-12), ty=1+rng(H-2);
    if(grid[ty]?.[tx] !== TILE.FLOOR) continue;
    traps.push({x:tx,y:ty,type:trapTypes[rng(3)],triggered:false});
    grid[ty][tx]=TILE.TRAP;
  }
  const exitX=W-2, exitY=Math.floor(H/2);
  grid[exitY][exitX]=TILE.WALL;
  return {grid,traps,exitX,exitY};
}

function generateBossArena(W,H){
  const grid=Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>(x===0||y===0||x===W-1||y===H-1)?TILE.WALL:TILE.FLOOR));
  const pillars=[[4,4],[4,H-5],[W-5,4],[W-5,H-5],[Math.floor(W/2)-1,3],[Math.floor(W/2)-1,H-4]];
  for(const [px,py] of pillars){
    if(py>0&&py<H-2&&px>0&&px<W-2){
      grid[py][px]=TILE.WALL;
      if(py+1<H-1) grid[py+1][px]=TILE.WALL;
      if(px+1<W-1) grid[py][px+1]=TILE.WALL;
    }
  }
  const exitX=W-2, exitY=H-2;
  grid[exitY][exitX]=TILE.WALL;
  return {grid,traps:[],exitX,exitY};
}

function generateRestRoom(W,H){
  const grid=Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>(x===0||y===0||x===W-1||y===H-1)?TILE.WALL:TILE.FLOOR));
  const exitX=W-2, exitY=H-2; grid[exitY][exitX]=TILE.EXIT;
  return {grid,traps:[],exitX,exitY};
}

function generatePuzzleRoom(W,H){
  const grid=Array.from({length:H},(_,y)=>Array.from({length:W},(_,x)=>(x===0||y===0||x===W-1||y===H-1)?TILE.WALL:TILE.FLOOR));
  const mid=Math.floor(H/2);
  for(let y=2;y<H-2;y++){
    if(y!==mid-1&&y!==mid&&y!==mid+1) grid[y][Math.floor(W/3)]=TILE.WALL;
    if(y!==mid-1&&y!==mid&&y!==mid+1) grid[y][Math.floor(W*2/3)]=TILE.WALL;
  }
  const exitX=W-2, exitY=H-2; grid[exitY][exitX]=TILE.WALL;
  return {grid,traps:[],exitX,exitY};
}

function _createPressurePlates(W,H){
  return [{x:4,y:4,active:false},{x:Math.floor(W/2),y:Math.floor(H/2),active:false},{x:W-5,y:H-5,active:false}];
}

// ── Monster factory ───────────────────────────────────────────────────────────

function _makeMonster(id, pos, monsterType, baseHp) {
  const def=MONSTER_DEFS[monsterType]||MONSTER_DEFS.basic;
  const hp=Math.round(baseHp*def.hpMult);
  const pat=MONSTER_PATTERNS[monsterType]||MONSTER_PATTERNS.basic;
  // Brute/boss always start at index 0 (predictable charge-up); others random entry
  const startIdx=(monsterType==='brute'||monsterType==='boss')?0:Math.floor(Math.random()*pat.length);
  return {id,monsterType,label:def.symbol+(id+1),x:pos.x,y:pos.y,hp,maxHp:hp,
    stance:null,nextTarget:null,rushMove2:false,slowUntil:0,
    vulnerable:0,stanceRevealUntil:0,stunTurns:0,stunned:false,rageTurns:0,
    patternIdx:startIdx};
}

function _spawnMonsters(grid,W,H,exitX,exitY,params,idStart){
  if(params.levelType==='boss'){
    const bx=Math.floor(W/2), by=Math.floor(H/2);
    return [_makeMonster(idStart,{x:bx,y:by},'boss',params.baseHp)];
  }
  const rng=makeLcg(Date.now()^0xabcd), typeList=params.types||['basic'], monsters=[];
  const count=params.monsters;
  if(H<=8){
    // Corridor: distribute evenly along the length
    for(let i=0;i<count;i++){
      const t=(i+0.8)/(count+0.6);
      const baseX=Math.floor(8+t*(exitX-10));
      let pos, tries=0;
      do{
        pos={x:baseX+rng(5)-2, y:1+rng(H-2)};
        tries++;
      }while(tries<40&&(grid[pos.y]?.[pos.x]!==TILE.FLOOR||pos.x<7));
      if(grid[pos.y]?.[pos.x]===TILE.FLOOR)
        monsters.push(_makeMonster(idStart+i,pos,typeList[i%typeList.length],params.baseHp));
    }
  } else {
    const spawnEdges=[()=>({x:exitX-1-rng(4),y:1+rng(H-2)}),()=>({x:1+rng(W-2),y:exitY-1-rng(3)})];
    for(let i=0;i<count;i++){
      let pos,t=0;
      do{pos=spawnEdges[rng(2)]();t++;}
      while(t<50&&(grid[pos.y]?.[pos.x]===TILE.WALL||dist(pos.x,pos.y,2,2)<5));
      if(grid[pos.y]?.[pos.x]===TILE.WALL) continue;
      monsters.push(_makeMonster(idStart+i,pos,typeList[i%typeList.length],params.baseHp));
    }
  }
  return monsters;
}

// ── Game state factory ────────────────────────────────────────────────────────

function createGameState(players, level=1) {
  const params=getLevelParams(level);
  const {W,H}=getMapDimensions(params);
  let mapResult;
  if(params.levelType==='boss')        mapResult=generateBossArena(W,H);
  else if(params.levelType==='rest')   mapResult=generateRestRoom(W,H);
  else if(params.levelType==='puzzle') mapResult=generatePuzzleRoom(W,H);
  else                                  mapResult=generateCorridor(W,H,params.trapCount);
  const {grid,traps,exitX,exitY}=mapResult;

  const spawnPts = params.levelType==='boss'
    ? [{x:2,y:2},{x:3,y:2},{x:2,y:3},{x:3,y:3}]
    : [{x:2,y:1},{x:2,y:2},{x:2,y:3},{x:2,y:4}];
  const gamePlayers={};
  players.forEach((p,i)=>{
    const sp=spawnPts[i%spawnPts.length];
    gamePlayers[p.id]={id:p.id,name:p.name,role:p.role,
      x:sp.x,y:sp.y,hp:CONFIG.PLAYER_HP[p.role]||100,maxHp:CONFIG.PLAYER_HP[p.role]||100,
      lastMove:0,lastSpecial:0,walls:[],atExit:false,comboStreak:0};
  });

  const gs={
    phase:'playing', level, levelType:params.levelType,
    beat:0, turn:0, pendingActions:{},
    W,H,grid,traps,exitX,exitY,
    startTime:Date.now(), duration:params.timer*1000,
    beatMs:params.beatMs||500,
    monsterDmg:params.baseDmg, nextMonsterIdSeq:params.monsters,
    wave2Spawned:false, wave3Spawned:false,
    players:gamePlayers, monsters:_spawnMonsters(grid,W,H,exitX,exitY,params,0),
    projectiles:[], projSeq:0,
    pings:[], messages:[], winner:null,
    windmillAngle:0, windmillArms:[], bossPhase2:false,
    isRestRoom:false, pressurePlates:null, exitOpen:undefined,
  };

  if(params.levelType==='rest'){
    gs.isRestRoom=true;
    _msg(gs,'🛌 休息室：體力緩慢恢復，前進出口！',Date.now());
  } else if(params.levelType==='puzzle'){
    gs.pressurePlates=_createPressurePlates(W,H);
    gs.exitOpen=false;
    _msg(gs,'🧩 謎題室：同時踩上所有壓力板開啟出口！',Date.now());
  } else if(params.levelType==='boss'){
    gs.exitOpen=false;
    _msg(gs,'⚠ BOSS 房間！擊敗 BOSS 才能前進！',Date.now());
  } else {
    gs.exitOpen=false;
    _msg(gs,'⚔ 擊敗所有怪物，出口才會開啟！',Date.now());
  }

  return gs;
}

// ── Level transition ──────────────────────────────────────────────────────────

function nextLevel(gs){
  gs.level=(gs.level||1)+1;
  const params=getLevelParams(gs.level);
  const {W:newW,H:newH}=getMapDimensions(params);
  gs.W=newW; gs.H=newH;
  let mapResult;
  if(params.levelType==='boss')        mapResult=generateBossArena(newW,newH);
  else if(params.levelType==='rest')   mapResult=generateRestRoom(newW,newH);
  else if(params.levelType==='puzzle') mapResult=generatePuzzleRoom(newW,newH);
  else                                  mapResult=generateCorridor(newW,newH,params.trapCount);
  gs.grid=mapResult.grid; gs.traps=mapResult.traps;
  gs.exitX=mapResult.exitX; gs.exitY=mapResult.exitY;
  gs.levelType=params.levelType;

  const spawnPts = params.levelType==='boss'
    ? [{x:2,y:2},{x:3,y:2},{x:2,y:3},{x:3,y:3}]
    : [{x:2,y:1},{x:2,y:2},{x:2,y:3},{x:2,y:4}];
  let i=0;
  for(const p of Object.values(gs.players)){
    if(p.hp>0){
      const sp=spawnPts[i++%spawnPts.length];
      p.x=sp.x; p.y=sp.y; p.atExit=false; p.walls=[]; p.comboStreak=0;
      // Rest room = full heal; boss/puzzle = 80%; normal = 70% (enough to keep going)
      const healFrac=params.levelType==='rest'?1.0:params.levelType==='boss'?0.8:0.7;
      p.hp=Math.min(p.maxHp,Math.max(p.hp,Math.floor(p.maxHp*healFrac)));
    }
  }
  gs.monsters=_spawnMonsters(gs.grid,gs.W,gs.H,gs.exitX,gs.exitY,params,0);
  gs.nextMonsterIdSeq=params.monsters;
  gs.monsterDmg=params.baseDmg; gs.startTime=Date.now(); gs.duration=params.timer*1000;
  gs.beatMs=params.beatMs||500;
  gs.wave2Spawned=false; gs.wave3Spawned=false;
  gs.phase='playing'; gs.winner=null;
  gs.beat=0; gs.turn=0; gs.pendingActions={};
  gs.projectiles=[]; gs.projSeq=0;
  gs.messages=[]; gs.pings=[];
  gs.windmillAngle=0; gs.windmillArms=[]; gs.bossPhase2=false; gs._restHealed=false;
  gs.isRestRoom=false; gs.pressurePlates=null; gs.exitOpen=undefined;

  const typeLabel={boss:'【BOSS】',rest:'【休息室】',puzzle:'【謎題室】',normal:''};
  _msg(gs,`── 第 ${gs.level} 關 ${typeLabel[params.levelType]||''} 開始！──`,Date.now());
  if(params.levelType==='rest'){gs.isRestRoom=true;}
  if(params.levelType==='puzzle'){gs.pressurePlates=_createPressurePlates(gs.W,gs.H);gs.exitOpen=false;}
  if(params.levelType==='boss'){gs.exitOpen=false;}
  if(params.levelType==='normal'){gs.exitOpen=false;}
}

// ── BFS ───────────────────────────────────────────────────────────────────────

const DIRS=[[0,-1],[0,1],[-1,0],[1,0]];

function stepToward(grid,W,H,fromX,fromY,toX,toY){
  if(fromX===toX&&fromY===toY) return {x:fromX,y:fromY};
  const visited=new Set([`${fromX},${fromY}`]);
  const queue=[{x:fromX,y:fromY,first:null}];
  while(queue.length){
    const cur=queue.shift();
    for(const [dx,dy] of DIRS){
      const nx=cur.x+dx, ny=cur.y+dy, key=`${nx},${ny}`;
      if(nx<0||ny<0||nx>=W||ny>=H) continue;
      if(grid[ny][nx]===TILE.WALL) continue;
      if(visited.has(key)) continue;
      visited.add(key);
      const first=cur.first||{x:nx,y:ny};
      if(nx===toX&&ny===toY) return first;
      if(visited.size<300) queue.push({x:nx,y:ny,first});
    }
  }
  return {x:fromX,y:fromY};
}

// ── Turn system ───────────────────────────────────────────────────────────────

// Called every beat: monsters decide stances; also ticks room/wave logic.
function startTurn(gs) {
  gs.turn=(gs.turn||0)+1;
  gs.pendingActions={};          // clear every beat — actions are one-shot
  gs.resolvedThisTurn=false;
  gs.combatResults=[];
  gs.combatResultTs=Date.now();

  if(gs.isRestRoom){ _tickRest(gs); return; }
  if(gs.pressurePlates) _tickPuzzle(gs);
  if(gs.levelType==='boss') _tickBossExit(gs);
  if(gs.levelType==='normal') _tickNormalExit(gs);

  // Decrement per-beat status counters
  for(const m of gs.monsters){
    if(m.vulnerable>0) m.vulnerable--;
    if(m.rageTurns>0)  m.rageTurns--;
  }

  const now=Date.now(), alivePlayers=Object.values(gs.players).filter(p=>p.hp>0);
  if(!alivePlayers.length) return;

  // (Wave spawns removed — fixed monster set per level)

  for(const m of gs.monsters){
    if(m.hp<=0) continue;
    m.stunned=false;
    if(m.stunTurns>0){ m.stunTurns--; m.stunned=true; m.stance='移'; continue; }
    if(m.slowUntil>now&&Math.random()<0.6){ m.stance='移'; continue; }
    m.rushMove2=false;
    const ai=MONSTER_AI[m.monsterType]||MONSTER_AI.basic;
    ai.decide(m,alivePlayers,gs);
  }

  // Global attacker limit:
  //   Level ≤15 (pre-first-boss): max 1 attacker at a time — learn one rhythm at a time
  //   Level ≥16 (post-first-boss): max 2 attackers — must handle simultaneous threats
  //   Boss rooms: exempt (only 1 boss monster anyway)
  const maxAttackers = (gs.levelType === 'boss') ? 999
    : gs.level <= 15 ? 1 : 2;

  const attackCandidates = [];
  for(const m of gs.monsters){
    if(m.hp<=0) continue;
    const isAttack=m.stance&&m.stance!=='移'&&m.stance!=='全彈'&&m.stance!=='休'&&m.stance!=='閃';
    if(!isAttack||!m.nextTarget) continue;
    const target=gs.players[m.nextTarget];
    if(!target||target.hp<=0) continue;
    attackCandidates.push({m, d:dist(m.x,m.y,target.x,target.y)});
  }
  // Closest monsters get to attack; the rest are demoted to movement
  attackCandidates.sort((a,b)=>a.d-b.d);
  for(let i=0;i<attackCandidates.length;i++){
    if(i>=maxAttackers){ attackCandidates[i].m.stance='移'; attackCandidates[i].m.rushMove2=false; }
  }
}

// Called on beat BEATS_PER_TURN (last beat): execute everything.
function resolveTurn(gs) {
  if(gs.resolvedThisTurn) return;
  gs.resolvedThisTurn=true;

  const now=Date.now();
  const alivePlayers=Object.values(gs.players).filter(p=>p.hp>0);

  // ── Step 1: Move all players simultaneously ───────────────────────────────
  for(const [pid,sub] of Object.entries(gs.pendingActions)){
    const p=gs.players[pid];
    if(!p||p.hp<=0) continue;
    const {dx,dy}=sub;
    if(dx||dy) _movePlayerImmediate(gs,p,dx,dy,now);
  }

  // ── Step 2: Move monsters ────────────────────────────────────────────────────
  for(const m of gs.monsters){
    if(m.hp<=0) continue;
    if(m.stunned) continue;
    const target=m.nextTarget ? gs.players[m.nextTarget] : _nearest(m,alivePlayers);
    if(!target||target.hp<=0) continue;
    if(m.stance==='閃'){
      // Evader: move AWAY from target
      _dodgeFrom(m,target,gs);
    } else if(m.stance==='移'||m.stance==='全彈'||m.stance==='休'||
              (m.stance&&dist(m.x,m.y,target.x,target.y)>1)){
      // Approach target
      const step1=stepToward(gs.grid,gs.W,gs.H,m.x,m.y,target.x,target.y);
      if(!_blocked(m,step1.x,step1.y,gs)){
        m.x=step1.x; m.y=step1.y;
      } else {
        // Attack-stance monster blocked by a passive ('移') monster: swap to let attacker through
        const isAttacking=m.stance!=='移'&&m.stance!=='全彈'&&m.stance!=='休'&&m.stance!=='閃';
        if(isAttacking){
          const blocker=gs.monsters.find(o=>o.id!==m.id&&o.hp>0&&o.x===step1.x&&o.y===step1.y&&o.stance==='移');
          if(blocker){const ox=m.x,oy=m.y; m.x=step1.x; m.y=step1.y; blocker.x=ox; blocker.y=oy;}
        }
      }
      if(m.rushMove2){
        const step2=stepToward(gs.grid,gs.W,gs.H,m.x,m.y,target.x,target.y);
        if(!_blocked(m,step2.x,step2.y,gs)){m.x=step2.x;m.y=step2.y;}
      }
    }
  }

  // ── Step 3: Resolve combat for each player ────────────────────────────────
  const isSoloGame=Object.keys(gs.players).length===1;
  for(const p of alivePlayers){
    if(p.hp<=0) continue;
    const sub=gs.pendingActions[p.id];
    const combatAction=sub?.combatAction||null;
    const effectiveAction=(p.role==='scholar'&&!isSoloGame)?'架':combatAction;

    // Ranged attack (scout / architect with target selected)
    // '休' stance = immune even to ranged; '移' stance = can be shot while approaching
    if(_isRanged(p)&&sub?.targetId!=null){
      const rt=gs.monsters.find(mo=>mo.id===sub.targetId&&mo.hp>0);
      if(rt&&rt.stance!=='休') _resolvePlayerRanged(p,sub.targetId,effectiveAction,gs,now);
      for(const m of gs.monsters){
        if(m.hp<=0||m.stance!=='射'||m.monsterType!=='archer') continue;
        _resolveArcherShot(p,m,effectiveAction,gs,now);
      }
      continue;
    }

    for(const m of gs.monsters){
      if(m.hp<=0) continue;
      const d=dist(p.x,p.y,m.x,m.y);

      if(m.stance==='射'&&m.monsterType==='archer'){
        _resolveArcherShot(p,m,effectiveAction,gs,now); continue;
      }
      if(m.stance==='全彈'&&m.monsterType==='boss') continue;

      // '休' stance = resting, immune to all melee
      if(m.stance==='休') continue;
      // Damage only on active attack beats (移/休/閃-escaped = no damage)
      const isActiveStance=m.stance&&m.stance!=='移'&&m.stance!=='全彈'&&m.stance!=='休';
      if(d<=1&&isActiveStance){
        if(p.role==='scholar'&&!isSoloGame) _resolveScholarGuard(p,m,gs,now);
        else _resolveMelee(p,m,effectiveAction,gs,now);
      }
    }
  }

  // ── Step 4: Boss special ──────────────────────────────────────────────────
  for(const m of gs.monsters){
    if(m.hp<=0) continue;
    if(m.monsterType==='boss'){
      if(m.stance==='全彈') _fireBulletHell(gs,m);
      _windmillDamage(gs);
    }
  }

  // ── Step 5: Traps triggered by monster movement ───────────────────────────
  // (traps are handled during player movement; nothing extra needed here)

  // Expire projectiles
  gs.projectiles=gs.projectiles.filter(p=>now-p.createdAt<p.dur+300);
}

// Evader dodge: find the tile that maximizes distance from target
function _dodgeFrom(m, target, gs) {
  let best=null, bestDist=dist(m.x,m.y,target.x,target.y);
  for(const [dx,dy] of DIRS){
    const nx=m.x+dx, ny=m.y+dy;
    if(_blocked(m,nx,ny,gs)) continue;
    const d=dist(nx,ny,target.x,target.y);
    if(d>bestDist){ best={x:nx,y:ny}; bestDist=d; }
  }
  if(best){ m.x=best.x; m.y=best.y; }
}

function _resolveMelee(player, monster, playerAction, gs, now) {
  const result = STANCE_RESULT[playerAction]?.[monster.stance] || 'lose';
  const mDmg   = Math.round(gs.monsterDmg * (MONSTER_DEFS[monster.monsterType]?.dmgMult || 1));
  const vuln   = (monster.vulnerable || 0) > 0 ? 1.5 : 1;

  gs.combatResults.push({ result, mx: monster.x, my: monster.y, px: player.x, py: player.y });

  if (result === 'win') {
    player.comboStreak = (player.comboStreak || 0) + 1;
    const comboMult = player.comboStreak >= 4 ? 3.0
                    : player.comboStreak === 3  ? 2.0
                    : player.comboStreak === 2  ? 1.5 : 1.0;
    const dmg    = Math.round(_playerDmg(player) * vuln * comboMult);
    const prevHp = monster.hp;
    monster.hp   = Math.max(0, monster.hp - dmg);

    // Overkill: carry excess damage to nearest other alive monster
    const overkill = Math.max(0, dmg - prevHp);
    if (overkill > 0) {
      const chain = gs.monsters
        .filter(o => o.id !== monster.id && o.hp > 0)
        .sort((a, b) => dist(a.x, a.y, player.x, player.y) - dist(b.x, b.y, player.x, player.y))[0];
      if (chain) {
        chain.hp = Math.max(0, chain.hp - overkill);
        gs.combatResults.push({ result: 'win', mx: chain.x, my: chain.y, px: player.x, py: player.y });
        _msg(gs, `💥 穿透！${overkill}傷害傳至 ${chain.label}！`, now);
        if (chain.hp === 0) _msg(gs, `${chain.label} 被擊倒！`, now);
      }
    }

    const healAmt   = Math.round(_playerDmg(player) * 0.15);
    player.hp = Math.min(player.maxHp, player.hp + healAmt);
    const comboNote = player.comboStreak >= 2 ? ` [×${comboMult}連擊]` : '';
    _msg(gs, `✓ ${player.name} 反制 ${monster.label}（${playerAction}→${monster.stance}）！-${dmg}HP +${healAmt}HP${comboNote}`, now);
    if (monster.hp === 0) _msg(gs, `${monster.label} 被擊倒！`, now);

  } else if (result === 'clash') {
    player.comboStreak = 0;
    const pdmg = Math.round(_playerDmg(player) * 0.5 * vuln);
    const mdmg = Math.round(mDmg * 0.5);
    monster.hp = Math.max(0, monster.hp - pdmg);
    player.hp  = Math.max(0, player.hp  - mdmg);
    _msg(gs, `⚡ ${player.name} 與 ${monster.label} 互相攻擊！`, now);

  } else {
    player.comboStreak = 0;
    const rageMult = (monster.rageTurns || 0) > 0 ? 1.5 : 1;
    const finalDmg = Math.round(mDmg * rageMult);
    player.hp = Math.max(0, player.hp - finalDmg);
    monster.rageTurns = 3;
    monster.stunTurns = 3;
    _msg(gs, `✗ ${player.name} 被 ${monster.label}（${monster.stance}）擊中！-${finalDmg}HP${rageMult > 1 ? ' ⚡狂暴！' : ''}`, now);
  }
}

function _resolvePlayerRanged(player, targetId, combatAction, gs, now) {
  const m=gs.monsters.find(mo=>mo.id===targetId&&mo.hp>0);
  if(!m) return;
  if(dist(player.x,player.y,m.x,m.y)>_playerRange(player)) return;

  const mDmg=Math.round(gs.monsterDmg*(MONSTER_DEFS[m.monsterType]?.dmgMult||1));
  const pDmg=_playerDmg(player);
  const vuln=(m.vulnerable||0)>0?1.5:1;
  const kind=player.role==='scout'?'arrow':'rock';
  gs.projectiles.push({id:gs.projSeq++,kind,
    fromX:player.x,fromY:player.y,toX:m.x,toY:m.y,createdAt:now,dur:400});

  const result=STANCE_RESULT[combatAction]?.[m.stance]||'lose';
  gs.combatResults.push({result,mx:m.x,my:m.y,px:player.x,py:player.y});

  if(result==='win'){
    const dmg=Math.round(pDmg*vuln);
    m.hp=Math.max(0,m.hp-dmg);
    const healAmt=Math.round(pDmg*0.15);
    player.hp=Math.min(player.maxHp,player.hp+healAmt);
    _msg(gs,`✓ ${player.name} 遠程反制 ${m.label}！-${dmg}HP +${healAmt}HP`,now);
    if(m.hp===0) _msg(gs,`${m.label} 被擊倒！`,now);
  } else if(result==='clash'){
    const dmg=Math.round(pDmg*0.5*vuln);
    m.hp=Math.max(0,m.hp-dmg);
    _msg(gs,`⚡ ${player.name} 遠程互拍 ${m.label}！-${dmg}HP`,now);
  } else if(result==='block'){
    const dmg=Math.round(pDmg*0.3*vuln);
    m.hp=Math.max(0,m.hp-dmg);
    _msg(gs,`🛡 ${player.name} 格擋並反擊！-${dmg}HP`,now);
  } else {
    _msg(gs,`✗ ${player.name} 遠程攻擊失敗！`,now);
  }
}

function _resolveScholarGuard(player, monster, gs, now) {
  const mDmg=Math.round(gs.monsterDmg*(MONSTER_DEFS[monster.monsterType]?.dmgMult||1));
  const vuln=(monster.vulnerable||0)>0?1.5:1;
  const result=STANCE_RESULT['架']?.[monster.stance]||'lose';
  gs.combatResults.push({result,mx:monster.x,my:monster.y,px:player.x,py:player.y});

  if(result==='win'){
    const dmg=Math.round(15*vuln);
    monster.hp=Math.max(0,monster.hp-dmg);
    monster.vulnerable=8;
    // Scholar guard heal
    const healAmt=Math.round(player.maxHp*0.08);
    player.hp=Math.min(player.maxHp,player.hp+healAmt);
    _msg(gs,`🛡 ${player.name} 學者格擋成功！${monster.label} 易傷 2 拍！-${dmg}HP +${healAmt}HP`,now);
    if(monster.hp===0) _msg(gs,`${monster.label} 被擊倒！`,now);
  } else if(result==='clash'){
    const dmg=Math.round(8*vuln);
    monster.hp=Math.max(0,monster.hp-dmg);
    player.hp=Math.max(0,player.hp-Math.round(mDmg*0.5));
    if(!monster.vulnerable) monster.vulnerable=4;
    _msg(gs,`⚡ ${player.name} 學者互拍！${monster.label} 易傷 1 拍！`,now);
  } else {
    const rageMult=(monster.rageTurns||0)>0?1.5:1;
    const finalDmg=Math.round(mDmg*rageMult);
    player.hp=Math.max(0,player.hp-finalDmg);
    monster.rageTurns=3;
    monster.stunTurns=3;
    _msg(gs,`✗ ${player.name} 學者格擋失敗！-${finalDmg}HP${rageMult>1?' ⚡狂暴！':''}`,now);
  }
}

function _hasWallBetween(grid, ax, ay, bx, by) {
  if (ax === bx) {
    const minY=Math.min(ay,by), maxY=Math.max(ay,by);
    for (let y=minY+1; y<maxY; y++) if (grid[y]?.[ax]===TILE.WALL) return true;
  } else {
    const minX=Math.min(ax,bx), maxX=Math.max(ax,bx);
    for (let x=minX+1; x<maxX; x++) if (grid[ay]?.[x]===TILE.WALL) return true;
  }
  return false;
}

function _resolveArcherShot(player, monster, playerAction, gs, now) {
  const inLine=(player.x===monster.x)||(player.y===monster.y);
  if(!inLine) return;
  if(_hasWallBetween(gs.grid, monster.x, monster.y, player.x, player.y)) return;

  const mDmg=Math.round(gs.monsterDmg*(MONSTER_DEFS.archer.dmgMult||1));
  gs.projectiles.push({id:gs.projSeq++,kind:'arrow',
    fromX:monster.x,fromY:monster.y,toX:player.x,toY:player.y,createdAt:now,dur:400});

  if(playerAction==='架'){
    const dmg=Math.round(mDmg*0.5);
    player.hp=Math.max(0,player.hp-dmg);
    gs.combatResults.push({result:'block', mx:monster.x, my:monster.y, px:player.x, py:player.y});
    _msg(gs,`🏹 ${player.name} 格擋了箭矢！-${dmg}HP`,now);
  } else {
    player.hp=Math.max(0,player.hp-mDmg);
    monster.stunTurns=3;
    gs.combatResults.push({result:'lose', mx:monster.x, my:monster.y, px:player.x, py:player.y});
    _msg(gs,`🏹 ${player.name} 被箭矢射中！-${mDmg}HP`,now);
  }
}

function _movePlayerImmediate(gs, p, dx, dy, now) {
  const nx=p.x+dx, ny=p.y+dy;
  if(nx<0||ny<0||nx>=gs.W||ny>=gs.H) return;
  if(gs.grid[ny][nx]===TILE.WALL) return;
  if(gs.monsters.some(m=>m.hp>0&&m.x===nx&&m.y===ny)) return;
  const trap=gs.traps.find(t=>!t.triggered&&t.x===nx&&t.y===ny);
  if(trap){ _applyTrap(gs,p,trap); trap.triggered=true; gs.grid[ny][nx]=TILE.FLOOR; }
  p.x=nx; p.y=ny;
  p.atExit=(nx===gs.exitX&&ny===gs.exitY)&&(gs.exitOpen!==false);
}

function _blocked(m, tx, ty, gs) {
  if(gs.grid[ty]?.[tx]===TILE.WALL) return true;
  if(gs.monsters.some(o=>o.id!==m.id&&o.hp>0&&o.x===tx&&o.y===ty)) return true;
  if(Object.values(gs.players).some(p=>p.hp>0&&p.x===tx&&p.y===ty)) return true;
  return false;
}

function _playerInCombat(gs, player) {
  return gs.monsters.some(m => m.hp > 0 && dist(m.x, m.y, player.x, player.y) <= COMBAT_RANGE);
}

// Instant free-move: only works when no monster is within COMBAT_RANGE.
// Returns true if the move was applied immediately.
const FREE_MOVE_COOLDOWN = 200; // ms between free steps (~5 tiles/sec)
function movePlayerFree(gs, playerId, dx, dy) {
  const p = gs.players[playerId];
  if (!p || p.hp <= 0) return false;
  if (!dx && !dy) return false;
  if (_playerInCombat(gs, p)) return false;
  const now = Date.now();
  if (now - (p.lastFreeMove || 0) < FREE_MOVE_COOLDOWN) return false;
  p.lastFreeMove = now;
  _movePlayerImmediate(gs, p, dx, dy, now);
  return true;
}

function _applyTrap(gs, player, trap) {
  const now=Date.now();
  if(trap.type==='spike'){
    const dmg=CONFIG.TRAPS.spike.dmg;
    player.hp=Math.max(0,player.hp-dmg);
    _msg(gs,`${player.name} 踩到尖刺！-${dmg}HP`,now);
  } else if(trap.type==='slow'){
    player.slowUntil=now+CONFIG.TRAPS.slow.duration*1000;
    _msg(gs,`${player.name} 被減速陷阱困住！`,now);
  } else if(trap.type==='push'){
    const [pdx,pdy]=DIRS[Math.floor(Math.random()*DIRS.length)];
    for(let i=0;i<CONFIG.TRAPS.push.force;i++){
      const nnx=player.x+pdx, nny=player.y+pdy;
      if(nnx>=0&&nny>=0&&nnx<gs.W&&nny<gs.H&&gs.grid[nny][nnx]!==TILE.WALL){
        player.x=nnx; player.y=nny;
      }
    }
    player.atExit=(player.x===gs.exitX&&player.y===gs.exitY)&&(gs.exitOpen!==false);
    _msg(gs,`${player.name} 被推力陷阱彈飛！`,now);
  }
}

// ── Special room ticks ────────────────────────────────────────────────────────

function _tickRest(gs){
  if(gs._restHealed) return;
  gs._restHealed=true;
  for(const p of Object.values(gs.players)){
    if(p.hp>0){ p.hp=p.maxHp; p.atExit=true; }
  }
  _msg(gs,'🛌 休息站！全隊血量回滿！稍作休息後繼續…',Date.now());
}

function _tickPuzzle(gs){
  for(const plate of gs.pressurePlates)
    plate.active=Object.values(gs.players).some(p=>p.hp>0&&p.x===plate.x&&p.y===plate.y);
  if(gs.pressurePlates.every(p=>p.active)&&!gs.exitOpen){
    gs.exitOpen=true; gs.grid[gs.exitY][gs.exitX]=TILE.EXIT;
    for(const p of Object.values(gs.players))
      if(p.x===gs.exitX&&p.y===gs.exitY) p.atExit=true;
    _msg(gs,'✓ 謎題解開！出口已打開！',Date.now());
  }
}

function _tickBossExit(gs){
  if(!gs.exitOpen&&gs.monsters.every(m=>m.hp<=0)){
    gs.exitOpen=true; gs.grid[gs.exitY][gs.exitX]=TILE.EXIT;
    for(const p of Object.values(gs.players)) if(p.hp>0) p.atExit=true;
    _msg(gs,'🏆 BOSS 擊敗！自動前往下一關！',Date.now());
  }
}

function _tickNormalExit(gs){
  if(gs.exitOpen!==false) return;
  if(gs.monsters.length>0&&gs.monsters.every(m=>m.hp<=0)){
    gs.exitOpen=true; gs.grid[gs.exitY][gs.exitX]=TILE.EXIT;
    for(const p of Object.values(gs.players)) if(p.hp>0) p.atExit=true;
    _msg(gs,'✓ 所有怪物擊敗！自動前往下一關！',Date.now());
  }
}

// ── Player special actions (outside turn system) ──────────────────────────────

const CD = { SCOUT_PING:4000, SCHOLAR_MARK:8000, ARCH_WALL:8000 };

function submitPlayerAction(gs, playerId, dx, dy, combatAction, targetId) {
  const p=gs.players[playerId];
  if(!p||p.hp<=0) return;
  gs.pendingActions[playerId]={dx:dx||0,dy:dy||0,combatAction:combatAction||null,targetId:targetId||null};
}

function placeWall(gs, playerId, wx, wy) {
  const p=gs.players[playerId];
  if(!p||p.role!=='architect') return false;
  const now=Date.now();
  if(now-p.lastSpecial<CD.ARCH_WALL) return false;
  if(wx<1||wy<1||wx>=gs.W-1||wy>=gs.H-1) return false;
  if(gs.grid[wy][wx]!==TILE.FLOOR) return false;
  if(Object.values(gs.players).some(pl=>pl.x===wx&&pl.y===wy)) return false;
  if(p.walls.length>=CONFIG.ARCHITECT_MAX_WALLS){
    const old=p.walls.shift();
    if(gs.grid[old.y][old.x]===TILE.WALL) gs.grid[old.y][old.x]=TILE.FLOOR;
  }
  gs.grid[wy][wx]=TILE.WALL; p.walls.push({x:wx,y:wy}); p.lastSpecial=now;
  _msg(gs,`建築師 ${p.name} 放置了牆壁`,now); return true;
}

function markMonster(gs, playerId, monsterId) {
  const p=gs.players[playerId];
  if(!p||p.role!=='scholar') return false;
  const now=Date.now();
  if(now-p.lastSpecial<CD.SCHOLAR_MARK) return false;
  const m=gs.monsters.find(mo=>mo.id===monsterId&&mo.hp>0);
  if(!m) return false;
  m.slowUntil=now+6000;
  m.stanceRevealUntil=now+4000;
  p.lastSpecial=now;
  _msg(gs,`📢 學者標記 ${m.label}【${m.stance||'?'}】，全隊可見！`,now);
  return true;
}

function scoutPing(gs, playerId, x, y) {
  const p=gs.players[playerId];
  if(!p||p.role!=='scout') return false;
  const now=Date.now();
  if(now-p.lastSpecial<CD.SCOUT_PING) return false;
  p.lastSpecial=now;
  gs.pings.push({x,y,from:p.name,until:now+4000});
  return true;
}

function quickMsg(gs, playerId, text) {
  const p=gs.players[playerId];
  if(!p) return;
  _msg(gs,`[${p.name}] ${text}`,Date.now());
}

function spawnWave(gs, count) {
  if(gs.levelType==='boss'||gs.levelType==='rest') return;
  const params=getLevelParams(gs.level||1);
  const hpBoost=Math.floor((gs.level||1)*8);
  const waveParams={...params,monsters:count,baseHp:params.baseHp+hpBoost};
  const idStart=gs.nextMonsterIdSeq||gs.monsters.length;
  gs.monsters.push(..._spawnMonsters(gs.grid,gs.W,gs.H,gs.exitX,gs.exitY,waveParams,idStart));
  gs.nextMonsterIdSeq=idStart+count;
  _msg(gs,'⚠ 增援出現！',Date.now());
}

function _msg(gs,text,now){
  gs.messages.push({text,until:now+5000});
  if(gs.messages.length>12) gs.messages.shift();
}

// ── End conditions ────────────────────────────────────────────────────────────

function checkEndConditions(gs){
  if(gs.phase==='ended') return gs.winner==='players'?'win':'lose';
  const alive=Object.values(gs.players).filter(p=>p.hp>0);
  if(alive.length===0){gs.phase='ended';gs.winner='monsters';return 'lose';}
  if(Date.now()>gs.startTime+gs.duration){gs.phase='ended';gs.winner='monsters';return 'lose';}
  if(alive.every(p=>p.atExit)){
    if((gs.level||1)>=MAX_LEVEL){gs.phase='ended';gs.winner='players';return 'win';}
    return 'next_level';
  }
  return null;
}

// ── Per-role state filtering ──────────────────────────────────────────────────

function _monsterSnap(m, showStance, peekAhead=0) {
  const revealed = m.stanceRevealUntil && m.stanceRevealUntil > Date.now();
  const canSee = showStance || revealed;
  const nextSteps = [];
  if (canSee && peekAhead > 0) {
    const pat = MONSTER_PATTERNS[m.monsterType] || MONSTER_PATTERNS.basic;
    for (let i = 0; i < peekAhead; i++)
      nextSteps.push(pat[(m.patternIdx + i) % pat.length]);
  }
  return {
    id:m.id, monsterType:m.monsterType, label:m.label,
    x:m.x, y:m.y, hp:m.hp, maxHp:m.maxHp,
    stance: canSee ? m.stance : null,
    slowed:m.slowUntil>Date.now(),
    shootTo:m.shootTo||null, nextTarget:m.nextTarget,
    vulnerable:(m.vulnerable||0)>0,
    enraged:(m.rageTurns||0)>0,
    nextSteps,
    patternIdx: m.patternIdx,
  };
}

function _fighterViewport(gs, myPlayer) {
  const fighter=Object.values(gs.players).find(p=>p.role==='fighter'&&p.hp>0)
             || Object.values(gs.players).find(p=>p.role==='fighter');
  const VIEW=4;
  const vx=fighter?fighter.x:(myPlayer?myPlayer.x:0);
  const vy=fighter?fighter.y:(myPlayer?myPlayer.y:0);
  const localGrid=[];
  for(let dy=-VIEW;dy<=VIEW;dy++){
    const row=[];
    for(let dx=-VIEW;dx<=VIEW;dx++){
      const gx=vx+dx, gy=vy+dy;
      row.push((gx<0||gy<0||gx>=gs.W||gy>=gs.H)?TILE.WALL:gs.grid[gy][gx]);
    }
    localGrid.push(row);
  }
  const visMonsters=gs.monsters
    .filter(m=>m.hp>0&&Math.abs(m.x-vx)<=VIEW&&Math.abs(m.y-vy)<=VIEW)
    .map(m=>_monsterSnap(m,true));
  return {localGrid, viewX:vx-VIEW, viewY:vy-VIEW, monsters:visMonsters};
}

function filterStateForRole(gs, role, playerId) {
  const now=Date.now();
  gs.pings=gs.pings.filter(p=>p.until>now);
  gs.messages=gs.messages.filter(m=>m.until>now);

  const playerSnap=Object.fromEntries(Object.entries(gs.players).map(([id,p])=>[id,
    {id:p.id,name:p.name,role:p.role,x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp,atExit:p.atExit}]));

  const liveProj=gs.projectiles.filter(p=>now-p.createdAt<p.dur);
  const myPlayer=gs.players[playerId];

  const base={
    tick:gs.turn, beat:gs.beat, phase:gs.phase, winner:gs.winner,
    level:gs.level||1, levelType:gs.levelType||'normal',
    timeLeft:Math.max(0,gs.startTime+gs.duration-now),
    players:playerSnap, pings:gs.pings, messages:gs.messages,
    W:gs.W, H:gs.H, projectiles:liveProj,
    windmillArms:gs.windmillArms||[], bossPhase2:gs.bossPhase2||false,
    pressurePlates:gs.pressurePlates||null, exitOpen:gs.exitOpen, isRestRoom:gs.isRestRoom||false,
    myAction:gs.pendingActions[playerId]||null,
    combatResults:gs.combatResults||[], combatResultTs:gs.combatResultTs||0,
    inCombat: myPlayer ? _playerInCombat(gs, myPlayer) : false,
    beatMs: gs.beatMs || 500,
  };

  const specialCd=myPlayer?Math.max(0,_specialCd(role)-(now-(myPlayer.lastSpecial||0))):0;

  // Solo / 1-player: full view with all info
  if(role==='solo'||Object.keys(gs.players).length===1){
    const alerts=_buildAlerts(gs);
    return {...base, grid:gs.grid, exitX:gs.exitX, exitY:gs.exitY,
      monsters:gs.monsters.map(m=>_monsterSnap(m,true,3)),
      traps:gs.traps, alerts, specialCd, isSolo:true};
  }

  // Fighter: 9×9 viewport, sees stances
  if(role==='fighter'){
    const me=myPlayer, VIEW=4;
    const vx=me?me.x:0, vy=me?me.y:0;
    const localGrid=[];
    for(let dy=-VIEW;dy<=VIEW;dy++){
      const row=[];
      for(let dx=-VIEW;dx<=VIEW;dx++){
        const gx=vx+dx, gy=vy+dy;
        row.push((gx<0||gy<0||gx>=gs.W||gy>=gs.H)?TILE.WALL:gs.grid[gy][gx]);
      }
      localGrid.push(row);
    }
    const visMonsters=gs.monsters
      .filter(m=>m.hp>0&&Math.abs(m.x-vx)<=VIEW&&Math.abs(m.y-vy)<=VIEW)
      .map(m=>_monsterSnap(m,true,2));
    return {...base, localGrid, viewX:vx-VIEW, viewY:vy-VIEW, monsters:visMonsters};
  }

  // Scout: 15×15 extended view (centred on fighter), stances only if revealed
  if(role==='scout'){
    const fighter=Object.values(gs.players).find(p=>p.role==='fighter'&&p.hp>0)
               || Object.values(gs.players).find(p=>p.role==='fighter');
    const SVIEW=7;
    const vx=fighter?fighter.x:(myPlayer?myPlayer.x:0);
    const vy=fighter?fighter.y:(myPlayer?myPlayer.y:0);
    const localGrid=[];
    for(let dy=-SVIEW;dy<=SVIEW;dy++){
      const row=[];
      for(let dx=-SVIEW;dx<=SVIEW;dx++){
        const gx=vx+dx, gy=vy+dy;
        row.push((gx<0||gy<0||gx>=gs.W||gy>=gs.H)?TILE.WALL:gs.grid[gy][gx]);
      }
      localGrid.push(row);
    }
    const visMonsters=gs.monsters
      .filter(m=>m.hp>0&&Math.abs(m.x-vx)<=SVIEW&&Math.abs(m.y-vy)<=SVIEW)
      .map(m=>_monsterSnap(m,true,1));
    return {...base, localGrid, viewX:vx-SVIEW, viewY:vy-SVIEW, monsters:visMonsters,
      fullGrid:gs.grid, exitX:gs.exitX, exitY:gs.exitY,
      traps:gs.traps.map(t=>({x:t.x,y:t.y,triggered:t.triggered})),
      specialCd};
  }

  // Scholar: 7×7 own viewport, sees ALL stances
  if(role==='scholar'){
    const me=myPlayer, SVIEW=3;
    const vx=me?me.x:0, vy=me?me.y:0;
    const localGrid=[];
    for(let dy=-SVIEW;dy<=SVIEW;dy++){
      const row=[];
      for(let dx=-SVIEW;dx<=SVIEW;dx++){
        const gx=vx+dx, gy=vy+dy;
        row.push((gx<0||gy<0||gx>=gs.W||gy>=gs.H)?TILE.WALL:gs.grid[gy][gx]);
      }
      localGrid.push(row);
    }
    const visMonsters=gs.monsters
      .filter(m=>m.hp>0&&Math.abs(m.x-vx)<=SVIEW&&Math.abs(m.y-vy)<=SVIEW)
      .map(m=>_monsterSnap(m,true,3));
    return {...base, localGrid, viewX:vx-SVIEW, viewY:vy-SVIEW, monsters:visMonsters,
      alerts:_buildAlerts(gs),
      allMonsters:gs.monsters.map(m=>_monsterSnap(m,true,3)),
      specialCd};
  }

  // All other roles (architect): fighter's 9×9 viewport, stances only if revealed
  const sharedView=_fighterViewport(gs, myPlayer);

  if(role==='architect'){
    const fighter=Object.values(gs.players).find(p=>p.role==='fighter'&&p.hp>0)
               || Object.values(gs.players).find(p=>p.role==='fighter');
    const VIEW=4;
    const vx=fighter?fighter.x:(myPlayer?myPlayer.x:0);
    const vy=fighter?fighter.y:(myPlayer?myPlayer.y:0);
    const archMonsters=gs.monsters
      .filter(m=>m.hp>0&&Math.abs(m.x-vx)<=VIEW&&Math.abs(m.y-vy)<=VIEW)
      .map(m=>_monsterSnap(m,true,1));
    return {...base, ...sharedView, monsters:archMonsters,
      fullGrid:gs.grid, exitX:gs.exitX, exitY:gs.exitY,
      traps:gs.traps, myWalls:myPlayer?.walls||[], specialCd};
  }

  return base;
}

function _buildAlerts(gs){
  return gs.monsters.filter(m=>m.hp>0&&m.stance).map(m=>{
    if(m.stance==='全彈') return `💀 BOSS 全圖彈目！所有人閃開！`;
    if(m.stance==='射')   return `🏹 ${m.label} 瞄準目標！移動閃避或架！`;
    if(m.stance==='移')   return null;
    return `⚔ ${m.label} 展示【${m.stance}】姿態`;
  }).filter(Boolean);
}

function _specialCd(role){
  if(role==='scout')     return CD.SCOUT_PING;
  if(role==='scholar')   return CD.SCHOLAR_MARK;
  if(role==='architect') return CD.ARCH_WALL;
  return 0;
}

module.exports = {
  TILE, MAX_LEVEL, MONSTER_DEFS, BEAT_MS, BEATS_PER_TURN,
  createGameState, nextLevel,
  startTurn, resolveTurn, spawnWave,
  submitPlayerAction, movePlayerFree, placeWall, markMonster, scoutPing, quickMsg,
  checkEndConditions, filterStateForRole,
};
