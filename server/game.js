'use strict';
const { CONFIG } = require('../shared/config');

const TILE = Object.freeze({ WALL: 0, FLOOR: 1, EXIT: 2, TRAP: 3 });

const MAX_LEVEL     = 30;
const BEATS_PER_TURN = 2;   // telegraph → resolve
const BEAT_MS       = 500;  // ms per beat → 1 s/turn

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
      baseHp:600+(bossNum-1)*400, baseDmg:28+level, timer:240, trapCount:4, types:['boss'] };
  }
  if (type === 'special') {
    const sub = getSpecialSubtype(level);
    const tier = Math.floor((level-1)/5);
    if (sub === 'rest')
      return { levelType:'rest', monsters:0, baseHp:0, baseDmg:0, timer:60, trapCount:0, types:[] };
    return { levelType:'puzzle', monsters:3+tier, baseHp:50+tier*12, baseDmg:10+tier*3,
      timer:120, trapCount:4, types:['basic','runner','basic'] };
  }
  const tier = Math.floor((level-1)/5);
  const pools = [
    ['basic'],['basic','runner'],['basic','runner','brute'],
    ['basic','runner','brute','archer'],['runner','brute','archer'],['brute','archer','runner'],
  ];
  const pool  = pools[Math.min(tier, pools.length-1)];
  const count = 5 + tier*2;
  return { levelType:'normal', monsters:count,
    baseHp:55+tier*15, baseDmg:10+tier*3, timer:Math.max(60,150-tier*15),
    trapCount:8+tier*2, types:Array.from({length:count}, (_,i)=>pool[i%pool.length]) };
}

// ── RPS combat table ──────────────────────────────────────────────────────────
// Monster stances: 赤(fast slash) 蒼(pierce) 黃(heavy) 移(just moves) 射(archer shot)
// Player actions:  刺(pierce)     斬(slash)  架(guard) null(no action)
//
//  架 beats 赤  | 赤 beats 刺  | 刺 clashes 蒼
//  刺 beats 黃  | 黃 beats 斬  | 斬 clashes 赤
//  斬 beats 蒼  | 蒼 beats 架  | 架 clashes 黃

const STANCE_RESULT = {
//            赤        蒼        黃        移     射
  '刺': { '赤':'lose', '蒼':'clash','黃':'win', '移':'win','射':'lose' },
  '斬': { '赤':'clash','蒼':'win', '黃':'lose','移':'win','射':'lose' },
  '架': { '赤':'win', '蒼':'lose','黃':'clash','移':'win','射':'block' },
  null: { '赤':'lose', '蒼':'lose','黃':'lose','移':'none','射':'lose' },
};

// ── Monster type definitions ──────────────────────────────────────────────────

const MONSTER_DEFS = {
  basic:  { symbol:'M', color:'#cc4444', bgColor:'#6b1010', hpMult:1.0,  dmgMult:1.0,  size:0.38 },
  runner: { symbol:'R', color:'#ff7755', bgColor:'#6b2010', hpMult:0.55, dmgMult:0.75, size:0.30 },
  brute:  { symbol:'B', color:'#bb66ee', bgColor:'#3b1060', hpMult:2.0,  dmgMult:1.5,  size:0.46 },
  archer: { symbol:'A', color:'#ddaa33', bgColor:'#5b4010', hpMult:0.65, dmgMult:1.2,  size:0.33, range:5 },
  boss:   { symbol:'X', color:'#ff2244', bgColor:'#550011', hpMult:10.0, dmgMult:2.5,  size:0.55 },
};

// ── Monster AI (telegraph phase only) ─────────────────────────────────────────
// decide() sets m.stance and m.nextTarget for this turn.

const MONSTER_AI = {

  basic: {
    decide(m, players, gs) {
      const target = _nearest(m, players);
      if (!target) { m.stance = '移'; return; }
      const d = dist(m.x, m.y, target.x, target.y);
      if (d > 2) { m.stance = '移'; m.nextTarget = target.id; return; }
      const stances = ['赤','蒼','黃'];
      m.stance = stances[Math.floor(Math.random()*3)];
      m.nextTarget = target.id;
    },
  },

  runner: {
    decide(m, players, gs) {
      const target = _nearest(m, players);
      if (!target) { m.stance = '移'; return; }
      m.stance = '赤';   // always fast, moves 2 tiles
      m.nextTarget = target.id;
      m.rushMove2 = true;
    },
  },

  brute: {
    decide(m, players, gs) {
      if (Math.random() < 0.4) { m.stance = '移'; return; }
      const target = _nearest(m, players);
      if (!target) { m.stance = '移'; return; }
      const d = dist(m.x, m.y, target.x, target.y);
      m.stance = d <= 1 ? '黃' : '移';
      m.nextTarget = target.id;
    },
  },

  archer: {
    decide(m, players, gs) {
      const target = _nearest(m, players);
      if (!target) { m.stance = '移'; return; }
      const d = dist(m.x, m.y, target.x, target.y);
      if (d <= 1) {
        m.stance = '赤'; m.nextTarget = target.id;
      } else {
        m.stance = '射'; m.nextTarget = target.id;
        m.shootFrom = { x: m.x, y: m.y };
        m.shootTo   = { x: target.x, y: target.y };
      }
    },
  },

  boss: {
    decide(m, players, gs) {
      if (!gs.bossPhase2 && m.hp/m.maxHp < 0.5) {
        gs.bossPhase2 = true;
        _msg(gs, `💀 BOSS 進入狂暴！速度加倍！`, Date.now());
      }
      gs.windmillAngle = ((gs.windmillAngle||0) + (gs.bossPhase2 ? 0.45 : 0.28));
      _updateWindmill(gs, m);

      gs.bossBulletCd = (gs.bossBulletCd||0) + 1;
      const cdNeeded  = gs.bossPhase2 ? 3 : 5;
      const target    = _nearest(m, players);

      if (gs.bossBulletCd >= cdNeeded) {
        gs.bossBulletCd = 0;
        m.stance = '全彈';
      } else if (target && dist(m.x,m.y,target.x,target.y) <= 1) {
        const stances = ['赤','蒼','黃'];
        m.stance = stances[Math.floor(Math.random()*3)];
        m.nextTarget = target.id;
      } else {
        m.stance = '移';
        m.nextTarget = target?.id;
      }
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

function dist(ax,ay,bx,by){ return Math.abs(ax-bx)+Math.abs(ay-by); }

function _playerDmg(player) {
  return player.role==='fighter' ? 35 : 20;
}

// ── RNG ───────────────────────────────────────────────────────────────────────

function makeLcg(seed) {
  let s=(seed^0xdeadbeef)>>>0;
  return (max)=>{ s=(1664525*s+1013904223)>>>0; return s%(max||1000); };
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
  grid[ey][ex]=TILE.EXIT;
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
  return {id,monsterType,label:def.symbol+(id+1),x:pos.x,y:pos.y,hp,maxHp:hp,
    stance:null,nextTarget:null,rushMove2:false,slowUntil:0};
}

function _spawnMonsters(grid,W,H,exitX,exitY,params,idStart){
  if(params.levelType==='boss'){
    const bx=Math.floor(W/2), by=Math.floor(H/2);
    return [_makeMonster(idStart,{x:bx,y:by},'boss',params.baseHp)];
  }
  const rng=makeLcg(Date.now()^0xabcd), typeList=params.types||['basic'], monsters=[];
  const spawnEdges=[()=>({x:exitX-1-rng(4),y:1+rng(H-2)}),()=>({x:1+rng(W-2),y:exitY-1-rng(3)})];
  for(let i=0;i<params.monsters;i++){
    let pos,t=0;
    do{pos=spawnEdges[rng(2)]();t++;}
    while(t<50&&(grid[pos.y]?.[pos.x]===TILE.WALL||dist(pos.x,pos.y,2,2)<5));
    if(grid[pos.y]?.[pos.x]===TILE.WALL) continue;
    monsters.push(_makeMonster(idStart+i,pos,typeList[i%typeList.length],params.baseHp));
  }
  return monsters;
}

// ── Game state factory ────────────────────────────────────────────────────────

function createGameState(players, level=1) {
  const W=26, H=18;
  const params=getLevelParams(level);
  let mapResult;
  if(params.levelType==='boss')        mapResult=generateBossArena(W,H);
  else if(params.levelType==='rest')   mapResult=generateRestRoom(W,H);
  else if(params.levelType==='puzzle') mapResult=generatePuzzleRoom(W,H);
  else                                  mapResult=generateDungeon(W,H,params.trapCount);
  const {grid,traps,exitX,exitY}=mapResult;

  const spawnPts=[{x:2,y:2},{x:3,y:2},{x:2,y:3},{x:3,y:3}];
  const gamePlayers={};
  players.forEach((p,i)=>{
    const sp=spawnPts[i%spawnPts.length];
    gamePlayers[p.id]={id:p.id,name:p.name,role:p.role,
      x:sp.x,y:sp.y,hp:CONFIG.PLAYER_HP[p.role]||100,maxHp:CONFIG.PLAYER_HP[p.role]||100,
      lastMove:0,lastSpecial:0,walls:[],atExit:false};
  });

  const gs={
    phase:'playing', level, levelType:params.levelType,
    beat:0, turn:0, pendingActions:{},
    W,H,grid,traps,exitX,exitY,
    startTime:Date.now(), duration:params.timer*1000,
    monsterDmg:params.baseDmg, nextMonsterIdSeq:params.monsters,
    wave2Spawned:false, wave3Spawned:false,
    players:gamePlayers, monsters:_spawnMonsters(grid,W,H,exitX,exitY,params,0),
    projectiles:[], projSeq:0,
    pings:[], messages:[], winner:null,
    windmillAngle:0, windmillArms:[], bossPhase2:false, bossBulletCd:0,
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
  }

  return gs;
}

// ── Level transition ──────────────────────────────────────────────────────────

function nextLevel(gs){
  gs.level=(gs.level||1)+1;
  const params=getLevelParams(gs.level);
  let mapResult;
  if(params.levelType==='boss')        mapResult=generateBossArena(gs.W,gs.H);
  else if(params.levelType==='rest')   mapResult=generateRestRoom(gs.W,gs.H);
  else if(params.levelType==='puzzle') mapResult=generatePuzzleRoom(gs.W,gs.H);
  else                                  mapResult=generateDungeon(gs.W,gs.H,params.trapCount);
  gs.grid=mapResult.grid; gs.traps=mapResult.traps;
  gs.exitX=mapResult.exitX; gs.exitY=mapResult.exitY;
  gs.levelType=params.levelType;

  const spawnPts=[{x:2,y:2},{x:3,y:2},{x:2,y:3},{x:3,y:3}];
  let i=0;
  for(const p of Object.values(gs.players)){
    if(p.hp>0){
      const sp=spawnPts[i++%spawnPts.length];
      p.x=sp.x; p.y=sp.y; p.atExit=false; p.walls=[];
      p.hp=params.levelType==='rest' ? p.maxHp : Math.min(p.maxHp,p.hp+Math.floor(p.maxHp*0.6));
    }
  }
  gs.monsters=_spawnMonsters(gs.grid,gs.W,gs.H,gs.exitX,gs.exitY,params,0);
  gs.nextMonsterIdSeq=params.monsters;
  gs.monsterDmg=params.baseDmg; gs.startTime=Date.now(); gs.duration=params.timer*1000;
  gs.wave2Spawned=false; gs.wave3Spawned=false;
  gs.phase='playing'; gs.winner=null;
  gs.beat=0; gs.turn=0; gs.pendingActions={};
  gs.projectiles=[]; gs.projSeq=0;
  gs.messages=[]; gs.pings=[];
  gs.windmillAngle=0; gs.windmillArms=[]; gs.bossPhase2=false; gs.bossBulletCd=0;
  gs.isRestRoom=false; gs.pressurePlates=null; gs.exitOpen=undefined;

  const typeLabel={boss:'【BOSS】',rest:'【休息室】',puzzle:'【謎題室】',normal:''};
  _msg(gs,`── 第 ${gs.level} 關 ${typeLabel[params.levelType]||''} 開始！──`,Date.now());
  if(params.levelType==='rest'){gs.isRestRoom=true;}
  if(params.levelType==='puzzle'){gs.pressurePlates=_createPressurePlates(gs.W,gs.H);gs.exitOpen=false;}
  if(params.levelType==='boss'){gs.exitOpen=false;}
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

// Called at the start of each turn (beat 1): monsters choose stances.
function startTurn(gs) {
  gs.turn=(gs.turn||0)+1;
  gs.pendingActions={};
  gs.resolvedThisTurn=false;
  gs.combatResults=[];
  gs.combatResultTs=Date.now();

  if(gs.isRestRoom){ _tickRest(gs); return; }
  if(gs.pressurePlates) _tickPuzzle(gs);
  if(gs.levelType==='boss') _tickBossExit(gs);

  const now=Date.now(), alivePlayers=Object.values(gs.players).filter(p=>p.hp>0);
  if(!alivePlayers.length) return;

  // Wave spawns based on turn count
  if(gs.turn===25&&!gs.wave2Spawned){ spawnWave(gs,2); gs.wave2Spawned=true; }
  if(gs.turn===45&&!gs.wave3Spawned){ spawnWave(gs,2); gs.wave3Spawned=true; }

  for(const m of gs.monsters){
    if(m.hp<=0) continue;
    if(m.slowUntil>now&&Math.random()<0.6){ m.stance='移'; continue; }
    m.rushMove2=false;
    const ai=MONSTER_AI[m.monsterType]||MONSTER_AI.basic;
    ai.decide(m,alivePlayers,gs);
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

  // ── Step 2: Move monsters with '移' or runner-rush stance ─────────────────
  for(const m of gs.monsters){
    if(m.hp<=0) continue;
    const target=m.nextTarget ? gs.players[m.nextTarget] : _nearest(m,alivePlayers);
    if(!target||target.hp<=0) continue;
    if(m.stance==='移'||m.stance==='全彈'||(m.stance&&dist(m.x,m.y,target.x,target.y)>1)){
      // Monster moves toward target
      const step1=stepToward(gs.grid,gs.W,gs.H,m.x,m.y,target.x,target.y);
      if(!_blocked(m,step1.x,step1.y,gs)){m.x=step1.x;m.y=step1.y;}
      if(m.rushMove2){
        const step2=stepToward(gs.grid,gs.W,gs.H,m.x,m.y,target.x,target.y);
        if(!_blocked(m,step2.x,step2.y,gs)){m.x=step2.x;m.y=step2.y;}
      }
    }
  }

  // ── Step 3: Resolve combat for each player ────────────────────────────────
  for(const p of alivePlayers){
    if(p.hp<=0) continue;
    const sub=gs.pendingActions[p.id];
    const combatAction=sub?.combatAction||null;

    for(const m of gs.monsters){
      if(m.hp<=0) continue;
      const d=dist(p.x,p.y,m.x,m.y);

      // Archer shot (range)
      if(m.stance==='射'&&m.monsterType==='archer'){
        _resolveArcherShot(p,m,combatAction,gs,now); continue;
      }

      // Boss bullet hell
      if(m.stance==='全彈'&&m.monsterType==='boss'){
        // Already handled in _fireBulletHell; skip per-player here
        continue;
      }

      // Melee (adjacent)
      if(d<=1&&m.stance&&m.stance!=='移'){
        _resolveMelee(p,m,combatAction,gs,now);
      } else if(d<=1&&m.stance==='移'&&combatAction){
        const dmg=_playerDmg(p);
        m.hp=Math.max(0,m.hp-dmg);
        gs.combatResults.push({result:'win', mx:m.x, my:m.y, px:p.x, py:p.y});
        _msg(gs,`✓ ${p.name} 自由攻擊 ${m.label}！-${dmg}HP`,now);
        if(m.hp===0) _msg(gs,`${m.label} 被 ${p.name} 擊倒！`,now);
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

function _resolveMelee(player, monster, playerAction, gs, now) {
  const result=STANCE_RESULT[playerAction]?.[monster.stance]||'lose';
  const mDmg=Math.round(gs.monsterDmg*(MONSTER_DEFS[monster.monsterType]?.dmgMult||1));

  gs.combatResults.push({result, mx:monster.x, my:monster.y, px:player.x, py:player.y});

  if(result==='win'){
    const dmg=_playerDmg(player);
    monster.hp=Math.max(0,monster.hp-dmg);
    _msg(gs,`✓ ${player.name} 反制 ${monster.label}（${playerAction}→${monster.stance}）！`,now);
    if(monster.hp===0) _msg(gs,`${monster.label} 被擊倒！`,now);
  } else if(result==='clash'){
    const pdmg=Math.round(_playerDmg(player)*0.5), mdmg=Math.round(mDmg*0.5);
    monster.hp=Math.max(0,monster.hp-pdmg);
    player.hp =Math.max(0,player.hp-mdmg);
    _msg(gs,`⚡ ${player.name} 與 ${monster.label} 互相攻擊！`,now);
  } else { // lose
    player.hp=Math.max(0,player.hp-mDmg);
    _msg(gs,`✗ ${player.name} 被 ${monster.label}（${monster.stance}）擊中！-${mDmg}HP`,now);
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
    gs.combatResults.push({result:'lose', mx:monster.x, my:monster.y, px:player.x, py:player.y});
    _msg(gs,`🏹 ${player.name} 被箭矢射中！-${mDmg}HP`,now);
  }
}

function _movePlayerImmediate(gs, p, dx, dy, now) {
  const nx=p.x+dx, ny=p.y+dy;
  if(nx<0||ny<0||nx>=gs.W||ny>=gs.H) return;
  if(gs.grid[ny][nx]===TILE.WALL) return;
  const trap=gs.traps.find(t=>!t.triggered&&t.x===nx&&t.y===ny);
  if(trap){ _applyTrap(gs,p,trap); trap.triggered=true; gs.grid[ny][nx]=TILE.FLOOR; }
  p.x=nx; p.y=ny;
  p.atExit=(nx===gs.exitX&&ny===gs.exitY)&&(gs.exitOpen!==false);
}

function _blocked(m, tx, ty, gs) {
  if(gs.grid[ty]?.[tx]===TILE.WALL) return true;
  if(gs.monsters.some(o=>o.id!==m.id&&o.hp>0&&o.x===tx&&o.y===ty)) return true;
  return false;
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
  for(const p of Object.values(gs.players))
    if(p.hp>0&&p.hp<p.maxHp) p.hp=Math.min(p.maxHp,p.hp+3);
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
    _msg(gs,'🏆 BOSS 擊敗！出口已開放！',Date.now());
  }
}

// ── Player special actions (outside turn system) ──────────────────────────────

const CD = { SCOUT_PING:4000, SCHOLAR_MARK:8000, ARCH_WALL:8000 };

function submitPlayerAction(gs, playerId, dx, dy, combatAction) {
  const p=gs.players[playerId];
  if(!p||p.hp<=0) return;
  gs.pendingActions[playerId]={dx:dx||0,dy:dy||0,combatAction:combatAction||null};
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
  m.slowUntil=now+6000; p.lastSpecial=now;
  // Broadcast stance info as a message so fighter can see
  _msg(gs,`📢 學者：${m.label} 姿態=${m.stance||'未知'}，下回合減速`,now);
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

function _monsterSnap(m, posOnly) {
  const base={id:m.id,monsterType:m.monsterType,label:m.label,
    x:m.x,y:m.y,hp:m.hp,maxHp:m.maxHp,stance:m.stance};
  if(posOnly) return base;
  return {...base, slowed:m.slowUntil>Date.now(),
    shootTo:m.shootTo||null, nextTarget:m.nextTarget};
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
    .map(m=>_monsterSnap(m,false));
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
  };

  const specialCd=myPlayer?Math.max(0,_specialCd(role)-(now-(myPlayer.lastSpecial||0))):0;

  // Solo / 1-player: full view with all info
  if(role==='solo'||Object.keys(gs.players).length===1){
    const alerts=_buildAlerts(gs);
    return {...base, grid:gs.grid, exitX:gs.exitX, exitY:gs.exitY,
      monsters:gs.monsters.map(m=>_monsterSnap(m,false)),
      traps:gs.traps, alerts, specialCd, isSolo:true};
  }

  // Fighter: local viewport centered on self
  if(role==='fighter'){
    const me=myPlayer, VIEW=4;
    const vx=me?me.x:0, vy=me?me.y:0;
    const span=VIEW*2+1;
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
      .map(m=>_monsterSnap(m,false));
    return {...base, localGrid, viewX:vx-VIEW, viewY:vy-VIEW, monsters:visMonsters};
  }

  // All other roles: share fighter's viewport for the canvas.
  const sharedView=_fighterViewport(gs, myPlayer);

  if(role==='scout'){
    // Scout: fighter viewport + full map data for overlay
    return {...base, ...sharedView,
      fullGrid:gs.grid, exitX:gs.exitX, exitY:gs.exitY,
      traps:gs.traps.map(t=>({x:t.x,y:t.y,triggered:t.triggered})),
      specialCd};
  }

  if(role==='scholar'){
    // Scholar: fighter viewport canvas + full monster list for info panel
    return {...base, ...sharedView,
      alerts:_buildAlerts(gs),
      allMonsters:gs.monsters.map(m=>_monsterSnap(m,false)),
      specialCd};
  }

  if(role==='architect'){
    // Architect: fighter viewport + full map for wall placement
    return {...base, ...sharedView,
      fullGrid:gs.grid, exitX:gs.exitX, exitY:gs.exitY,
      traps:gs.traps,
      myWalls:myPlayer?.walls||[], specialCd};
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
  submitPlayerAction, placeWall, markMonster, scoutPing, quickMsg,
  checkEndConditions, filterStateForRole,
};
