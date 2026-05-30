'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const TILE = { WALL:0, FLOOR:1, EXIT:2, TRAP:3 };
const ROLE_COLOR = { scout:'#1D9E75', fighter:'#D85A30', scholar:'#BA7517', architect:'#7F77DD' };
const ROLE_LABEL = { scout:'斥候', fighter:'戰士', scholar:'學者', architect:'建築師' };
const TILE_COLORS = { 0:'#111120', 1:'#0c0c14', 2:'#0a2010', 3:'#18150a' };

// Stance display
const STANCE_INFO = {
  '赤': { label:'赤', color:'#ff5544', desc:'快攻', counter:'架' },
  '蒼': { label:'蒼', color:'#4488ff', desc:'穿刺', counter:'斬' },
  '黃': { label:'黃', color:'#ffcc22', desc:'重擊', counter:'刺' },
  '移': { label:'移', color:'#666666', desc:'移動', counter:'' },
  '射': { label:'射', color:'#ffaa33', desc:'射擊', counter:'架/閃' },
  '全彈':{ label:'彈', color:'#ff2244', desc:'全圖彈目', counter:'閃開！' },
};

const ACTION_INFO = {
  '刺': { label:'刺', color:'#ffcc22', key:'1', desc:'刺→克黃重擊' },
  '斬': { label:'斬', color:'#ff7755', key:'2', desc:'斬→克蒼穿刺' },
  '架': { label:'架', color:'#44aaff', key:'3', desc:'架→克赤快攻' },
  null: { label:'無', color:'#555555', key:'0', desc:'純移動' },
};

const MONSTER_VIS = {
  basic:  { color:'#cc4444', bgColor:'#6b1010', size:0.38 },
  runner: { color:'#ff7755', bgColor:'#6b2010', size:0.30 },
  brute:  { color:'#bb66ee', bgColor:'#3b1060', size:0.46 },
  archer: { color:'#ddaa33', bgColor:'#5b4010', size:0.33 },
  boss:   { color:'#ff2244', bgColor:'#550011', size:0.55 },
};

const PLAYER_ANIM_MS  = 140;
const MONSTER_ANIM_MS = 280;
const BEATS_PER_TURN  = 2;

// ── Game state ───────────────────────────────────────────────────────────────

let gameRole         = null;
let gameId           = null;
let latestState      = null;
let animId           = null;
let isSolo           = false;
let _devSocket       = null;
let mapOverlayActive = false;

let actionQueue = [];
const QUEUE_MAX  = 5;

// Current pending action for this player (shown in UI)
let pendingDx   = 0;
let pendingDy   = 0;
let pendingAct  = null;   // '刺'|'斬'|'架'|null
let lastBeat    = 0;
let beatFlash   = 0;      // performance.now() of last beat event

// ── Smooth movement ───────────────────────────────────────────────────────────

const displayPos = new Map();

function getDisplayPos(key, tx, ty, now, animMs) {
  let dp = displayPos.get(key);
  if (!dp) {
    displayPos.set(key, { sx:tx, sy:ty, tx, ty, t0:now-animMs });
    return { x:tx, y:ty };
  }
  if (dp.tx !== tx || dp.ty !== ty) {
    const cur = _lerp(dp, now, animMs);
    dp = { sx:cur.x, sy:cur.y, tx, ty, t0:now };
    displayPos.set(key, dp);
  }
  return _lerp(dp, now, animMs);
}

function _lerp(dp, now, animMs) {
  const t = Math.min(1, (now - dp.t0) / animMs);
  const e = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
  return { x:dp.sx+(dp.tx-dp.sx)*e, y:dp.sy+(dp.ty-dp.sy)*e };
}

// ── Effects ───────────────────────────────────────────────────────────────────

let effects      = [];   // { px, py, color, t0, dur, type:'flash'|'ring' }
let floatingNums = [];   // { text, px, py, color, t0, dur, big? }
let lastCombatResultTs = 0;

function _addFlash(px, py, color, dur) {
  effects.push({ px, py, color, t0:performance.now(), dur:dur||350, type:'flash' });
}
function _addRing(px, py, color, dur) {
  effects.push({ px, py, color, t0:performance.now(), dur:dur||500, type:'ring' });
}
function _addFloat(text, px, py, color, big) {
  floatingNums.push({ text, px, py, color, t0:performance.now(), dur:big?1100:900, big });
}

function updateEffects(prev, next, now) {
  if (!prev || !next) return;

  // Combat result flashes (RPS outcomes)
  if ((next.combatResults||[]).length && next.combatResultTs !== lastCombatResultTs) {
    lastCombatResultTs = next.combatResultTs;
    for (const r of next.combatResults) {
      if (r.result === 'win') {
        _addFlash(r.mx, r.my, '#ffe844', 400);
        _addRing(r.mx, r.my, '#44ff88', 550);
        _addFloat('反制！', r.mx, r.my - 0.6, '#ffe844', true);
      } else if (r.result === 'clash') {
        _addFlash(r.mx, r.my, '#ff9944', 350);
        _addFlash(r.px, r.py, '#ff9944', 350);
        _addFloat('互拍！', r.mx, r.my - 0.6, '#ff9944', true);
      } else if (r.result === 'lose') {
        _addFlash(r.px, r.py, '#ff2200', 400);
        _addRing(r.px, r.py, '#ff4444', 500);
      } else if (r.result === 'block') {
        _addRing(r.px, r.py, '#44aaff', 450);
        _addFloat('格擋！', r.px, r.py - 0.6, '#44aaff', true);
      }
    }
  }

  // HP-change damage numbers
  for (const m of (next.monsters||[])) {
    const pm = prev.monsters?.find(x=>x.id===m.id);
    if (pm && pm.hp > m.hp && m.hp >= 0) {
      const dp = displayPos.get('m_'+m.id) || { x:m.x, y:m.y };
      _addFloat(`-${pm.hp-m.hp}`, dp.x, dp.y - 0.4, '#ff8888');
    }
  }
  for (const [id, p] of Object.entries(next.players||{})) {
    const pp = prev.players?.[id];
    if (pp && pp.hp > p.hp) {
      const dp = displayPos.get('p_'+id) || { x:p.x, y:p.y };
      _addFloat(`-${pp.hp-p.hp}`, dp.x, dp.y - 0.4, '#ffbb55');
    }
  }
}

function drawEffects(ctx, ts, now, ox, oy) {
  effects = effects.filter(e => now - e.t0 < e.dur);
  for (const e of effects) {
    const t = (now - e.t0) / e.dur;
    const cx = (e.px - (ox||0)) * ts + ts/2;
    const cy = (e.py - (oy||0)) * ts + ts/2;
    ctx.save();
    if (e.type === 'flash') {
      const a = Math.max(0, 1 - t);
      const r = ts * (0.25 + t * 0.5);
      ctx.globalAlpha = a * 0.75;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
      ctx.fillStyle = e.color; ctx.fill();
    } else {
      const a = Math.max(0, (1 - t) * 0.9);
      const r = ts * (0.28 + t * 0.72);
      ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
      ctx.strokeStyle = e.color; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.restore();
  }
}

function drawFloatingNums(ctx, ts, now, ox, oy) {
  floatingNums = floatingNums.filter(f => now - f.t0 < f.dur);
  for (const f of floatingNums) {
    const t = (now - f.t0) / f.dur;
    const a = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    const rise = t * ts * (f.big ? 2.0 : 2.5);
    const cx = (f.px - (ox||0)) * ts + ts/2;
    const cy = (f.py - (oy||0)) * ts + ts/2 - rise;
    const sz = f.big ? Math.max(13, ts * 0.58) : Math.max(11, ts * 0.5);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = f.color;
    ctx.font = `bold ${sz}px monospace`;
    ctx.textAlign = 'center';
    if (f.big) {
      ctx.shadowColor = f.color; ctx.shadowBlur = 6;
    }
    ctx.fillText(f.text, cx, cy);
    ctx.restore();
  }
}

// ── Projectile tracking ───────────────────────────────────────────────────────

const projSeen = new Map();

function syncProjectiles(state) {
  const now = performance.now();
  for (const p of (state.projectiles||[])) if (!projSeen.has(p.id)) projSeen.set(p.id, now);
  const liveIds = new Set((state.projectiles||[]).map(p=>p.id));
  for (const k of projSeen.keys()) if (!liveIds.has(k)) projSeen.delete(k);
}

function drawProjectiles(ctx, projs, ts, ox, oy, now) {
  for (const p of (projs||[])) {
    const seen=projSeen.get(p.id); if(seen===undefined) continue;
    const t=Math.min(1,(now-seen)/p.dur);
    const x=p.fromX+(p.toX-p.fromX)*t, y=p.fromY+(p.toY-p.fromY)*t;
    const cx=(x-(ox||0))*ts+ts/2, cy=(y-(oy||0))*ts+ts/2;
    const r=p.kind==='bullet'?Math.max(3,ts*0.18):Math.max(2,ts*0.12);
    const col=p.kind==='bullet'?'#ff4466':'#ffcc44';
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle=col; ctx.fill();
    if(p.kind==='bullet'){
      ctx.beginPath(); ctx.arc(cx,cy,r+3,0,Math.PI*2);
      ctx.strokeStyle='rgba(255,68,102,0.4)'; ctx.lineWidth=2; ctx.stroke();
    }
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

function initGame(socket, role, playerId, playerCount) {
  gameRole   = role;
  gameId     = playerId;
  isSolo     = (playerCount === 1);
  _devSocket = socket;
  displayPos.clear();
  effects=[]; floatingNums=[]; projSeen.clear();
  pendingDx=0; pendingDy=0; pendingAct=null;
  actionQueue=[]; mapOverlayActive=false;
  lastCombatResultTs=0;

  buildGameScreen(role);
  buildActionPad(socket, role);
  setupInput(socket);

  if (role==='architect'||isSolo) {
    const canvas=document.getElementById('game-canvas');
    canvas.addEventListener('click', (e)=>{
      const {tx,ty}=canvasToTile(canvas,e,latestState);
      if(tx!==null) socket.emit('place_wall',{x:tx,y:ty});
    });
  }
  if (role==='scout'||isSolo) {
    const canvas=document.getElementById('game-canvas');
    canvas.addEventListener('contextmenu',(e)=>{
      e.preventDefault();
      if(mapOverlayActive&&latestState?.fullGrid){
        const rect=canvas.getBoundingClientRect();
        const mx=Math.floor((e.clientX-rect.left)*latestState.W/canvas.width);
        const my=Math.floor((e.clientY-rect.top)*latestState.H/canvas.height);
        socket.emit('scout_ping',{x:mx,y:my});
      } else {
        const {tx,ty}=canvasToTile(canvas,e,latestState);
        if(tx!==null) socket.emit('scout_ping',{x:tx,y:ty});
      }
    });
  }
  if (role==='scout'&&!isSolo) buildScoutMapUI();
  buildQuickMessages(socket, role);
  buildRoleHelp(role);

  document.addEventListener('keyup',(e)=>{
    if(e.key==='m'||e.key==='M') mapOverlayActive=false;
  });

  animId = requestAnimationFrame(renderLoop);
}

// Listen for beat events from server
function onBeat(socket) {
  socket.on('beat', ({ beat }) => {
    lastBeat  = beat;
    beatFlash = performance.now();
    updateBeatUI(beat, socket);
  });
}

function stopGame() {
  if (animId) cancelAnimationFrame(animId);
  animId=null; latestState=null; actionQueue=[];
}

// ── Level banner ──────────────────────────────────────────────────────────────

function showLevelBanner(completedLevel, nextLvl, maxLevel) {
  let banner=document.getElementById('level-banner');
  if(!banner){banner=document.createElement('div');banner.id='level-banner';document.body.appendChild(banner);}
  if(completedLevel>=maxLevel){
    banner.innerHTML=`<div class="lv-title">🏆 全關卡完成！</div><div class="lv-sub">等待最終結果…</div>`;
  } else {
    banner.innerHTML=`<div class="lv-title">第 ${completedLevel} 關 完成</div><div class="lv-sub">► 第 ${nextLvl} 關 即將開始</div>`;
  }
  banner.classList.add('show');
  setTimeout(()=>banner.classList.remove('show'),2800);
}

// ── Layout ───────────────────────────────────────────────────────────────────

function buildGameScreen(role) {
  const sg=document.getElementById('screen-game');
  sg.innerHTML=`
    <div id="g-hud">
      <div id="g-role-badge" class="role-${role}">${ROLE_LABEL[role]||role}</div>
      <div id="g-level-badge">Lv.1</div>
      <div id="g-beat-row">
        <span class="beat-label">拍</span>
        <span class="beat-dot" id="bd-1"></span>
        <span class="beat-dot" id="bd-2"></span>
      </div>
      <div id="g-players"></div>
      <div id="g-timer">--:--</div>
    </div>
    <div id="g-body">
      <div id="g-main">
        <canvas id="game-canvas"></canvas>
        <div id="scholar-panel" style="display:none"></div>
      </div>
      <div id="g-sidebar">
        <div id="g-messages"></div>
        <div id="g-alerts" style="display:none"></div>
        <div id="g-monsters" style="display:none"></div>
        <div id="g-specials"></div>
        <div id="g-action-pad"></div>
        <div id="g-quick"></div>
        <div id="g-help"></div>
      </div>
    </div>
  `;
  if(role==='scholar'&&!isSolo){
    document.getElementById('g-alerts').style.display='block';
    document.getElementById('g-monsters').style.display='block';
  }
}

// ── Action pad ────────────────────────────────────────────────────────────────

function buildActionPad(socket, role) {
  const el = document.getElementById('g-action-pad');
  if (!el) return;

  const canFight = (role==='fighter'||isSolo);
  const actionButtons = canFight ? `
    <div class="pad-label">戰鬥動作 (J K L / 1 2 3)</div>
    <div class="action-row">
      <button class="act-btn" id="act-刺" onclick="window._setAct('刺')">刺<br><small>[J] 克黃</small></button>
      <button class="act-btn" id="act-斬" onclick="window._setAct('斬')">斬<br><small>[K] 克蒼</small></button>
      <button class="act-btn" id="act-架" onclick="window._setAct('架')">架<br><small>[L] 克赤</small></button>
      <button class="act-btn act-none" id="act-null" onclick="window._setAct(null)">無<br><small>[0] 移動</small></button>
    </div>` : '';

  el.innerHTML=`
    <div class="pad-section">
      <div class="pad-header">
        <span class="pad-label">移動方向 (WASD)</span>
        <button class="queue-clear-btn" onclick="window._clearQueue()" title="清除佇列 (Esc)">✕ 清除</button>
      </div>
      <div class="dir-pad">
        <div></div>
        <button class="dir-btn" onclick="window._setDir(0,-1)">↑</button>
        <div></div>
        <button class="dir-btn" onclick="window._setDir(-1,0)">←</button>
        <button class="dir-btn dir-stay" onclick="window._setDir(0,0)">·</button>
        <button class="dir-btn" onclick="window._setDir(1,0)">→</button>
        <div></div>
        <button class="dir-btn" onclick="window._setDir(0,1)">↓</button>
        <div></div>
      </div>
      <div class="queue-row">
        <span class="queue-label">佇列</span>
        <div id="queue-display" class="queue-display empty">（空）</div>
      </div>
      ${actionButtons}
      <div id="pad-preview" class="pad-preview">等待下一拍…</div>
    </div>
  `;

  window._setDir = (dx, dy) => {
    if (dx===0&&dy===0) {
      actionQueue=[]; pendingDx=0; pendingDy=0; pendingAct=null;
      socket.emit('player_submit',{dx:0,dy:0,combatAction:null});
      updatePadUI(); updateQueueUI(); return;
    }
    if (actionQueue.length < QUEUE_MAX) { actionQueue.push({dx,dy}); updateQueueUI(); }
  };
  window._setAct = (act) => {
    pendingAct=act;
    _submitAndRefresh(socket);
  };
  window._clearQueue = () => { actionQueue=[]; updateQueueUI(); };
  window._removeQueueItem = (i) => { actionQueue.splice(i,1); updateQueueUI(); };
  window._markMonster = (id) => socket.emit('mark_monster', { monsterId:id });
}

function _submitAndRefresh(socket) {
  socket.emit('player_submit', { dx:pendingDx, dy:pendingDy, combatAction:pendingAct });
  updatePadUI();
}

function updatePadUI() {
  // Highlight selected direction
  const dirs = [
    [0,-1,'↑'],[0,1,'↓'],[-1,0,'←'],[1,0,'→'],[0,0,'·']
  ];
  for (const btn of document.querySelectorAll('.dir-btn')) {
    btn.classList.remove('selected');
  }
  const allBtns = document.querySelectorAll('.dir-btn');
  // Simple: re-build isn't needed, just update preview
  const actLabel = pendingAct ? ACTION_INFO[pendingAct].label : '無';
  const dirLabel = pendingDx===0&&pendingDy===0 ? '待機' :
    pendingDx>0?'→':pendingDx<0?'←':pendingDy>0?'↓':'↑';
  const preview = document.getElementById('pad-preview');
  if (preview) {
    const actColor = pendingAct ? ACTION_INFO[pendingAct].color : '#555';
    preview.innerHTML=`移動：<b>${dirLabel}</b> ／ 動作：<b style="color:${actColor}">${actLabel}</b>`;
  }

  // Highlight action button
  for (const k of ['刺','斬','架',null]) {
    const btn=document.getElementById('act-'+(k||'null'));
    if(btn) btn.classList.toggle('selected', k===pendingAct);
  }
}

function updateQueueUI() {
  const el=document.getElementById('queue-display');
  if(!el) return;
  if(actionQueue.length===0){
    el.innerHTML='（空）'; el.className='queue-display empty';
  } else {
    const arrow = a => a.dx>0?'→':a.dx<0?'←':a.dy>0?'↓':a.dy<0?'↑':'·';
    el.innerHTML=actionQueue.map((a,i)=>
      `<span class="queue-item" onclick="window._removeQueueItem(${i})" title="點擊移除">${arrow(a)}</span>`
    ).join('');
    el.className='queue-display';
  }
}

function updateBeatUI(beat, socket) {
  for (let i=1;i<=BEATS_PER_TURN;i++) {
    const dot=document.getElementById('bd-'+i);
    if(!dot) continue;
    dot.classList.remove('beat-done','beat-current','beat-resolve');
    if(i<beat)        dot.classList.add('beat-done');
    else if(i===beat) dot.classList.add(beat===BEATS_PER_TURN?'beat-resolve':'beat-current');
  }
  if (beat===1) {
    pendingAct=null;
    if (actionQueue.length>0) {
      const next=actionQueue.shift();
      pendingDx=next.dx; pendingDy=next.dy;
    } else {
      pendingDx=0; pendingDy=0;
    }
    updatePadUI();
    updateQueueUI();
    if (socket) socket.emit('player_submit', { dx:pendingDx, dy:pendingDy, combatAction:null });
  }
}

// ── Scholar UI ───────────────────────────────────────────────────────────────

function buildScholarUI() {
  const panel=document.getElementById('scholar-panel');
  panel.innerHTML=`
    <div id="scholar-radar-wrap">
      <div class="panel-label">位置雷達</div>
      <canvas id="scholar-radar" width="180" height="120"></canvas>
    </div>
    <div id="scholar-codex">
      <div class="panel-label">怪物情報</div>
      <div id="scholar-monster-list"></div>
    </div>
  `;
}

function renderScholar(state) {
  const alertEl=document.getElementById('g-alerts');
  if(state.alerts?.length){
    alertEl.innerHTML=`<div class="panel-label">⚡ 即時警告</div>`+
      state.alerts.map(a=>`<div class="scholar-alert">${a}</div>`).join('');
  } else {
    alertEl.innerHTML=`<div class="panel-label">⚡ 即時警告</div><div class="scholar-quiet">平靜中…</div>`;
  }

  const monEl=document.getElementById('g-monsters');
  const monList=state.allMonsters||state.monsters||[];
  if(monList.length&&monEl){
    monEl.innerHTML=`<div class="panel-label">怪物狀態</div>`+
      monList.map(m=>{
        const pct=m.maxHp?Math.round(100*m.hp/m.maxHp):0;
        const vis=MONSTER_VIS[m.monsterType]||MONSTER_VIS.basic;
        const si=STANCE_INFO[m.stance]||{label:'?',color:'#888',counter:'?'};
        const stanceHtml=m.stance&&m.stance!=='移'
          ?`<span class="stance-tag" style="background:${si.color}20;color:${si.color};border-color:${si.color}">${si.label} →${si.counter}</span>`:'';
        return `<div class="mon-row${m.hp<=0?' mon-dead':''}">
          <span class="mon-label" style="color:${vis.color}">${m.label}</span>
          ${stanceHtml}
          <div class="mon-hp-bar"><div style="width:${pct}%"></div></div>
          ${m.hp>0?`<button class="mark-btn" onclick="window._markMonster(${m.id})">標記</button>`:'<span class="mon-dead-txt">擊倒</span>'}
        </div>`;
      }).join('');
  }

  const radar=document.getElementById('scholar-radar');
  if(!radar||!state.W) return;
  const ctx=radar.getContext('2d'), rw=radar.width, rh=radar.height;
  ctx.clearRect(0,0,rw,rh); ctx.fillStyle='#0c0c14'; ctx.fillRect(0,0,rw,rh);
  const sx=rw/state.W, sy=rh/state.H;
  for(const m of (state.monsters||[])){
    if(m.hp<=0) continue;
    const si=STANCE_INFO[m.stance];
    ctx.beginPath();
    ctx.arc(m.x*sx+sx/2,m.y*sy+sy/2,Math.max(2,sx*0.7),0,Math.PI*2);
    ctx.fillStyle=si?.color||(MONSTER_VIS[m.monsterType]?.color||'#cc4444');
    ctx.fill();
  }
  for(const p of Object.values(state.players||{})){
    ctx.beginPath();
    ctx.arc(p.x*sx+sx/2,p.y*sy+sy/2,Math.max(2,sx*0.7),0,Math.PI*2);
    ctx.fillStyle=ROLE_COLOR[p.role]||'#fff'; ctx.fill();
  }
}

// ── Canvas helpers ────────────────────────────────────────────────────────────

function canvasToTile(canvas, e, state) {
  if(!state) return {tx:null,ty:null};
  const rect=canvas.getBoundingClientRect();
  if(state.localGrid){
    const VIEW=4, span=VIEW*2+1;
    const ts=getTileSize(canvas,span,span);
    const lx=Math.floor((e.clientX-rect.left)/ts);
    const ly=Math.floor((e.clientY-rect.top)/ts);
    return {tx:lx+(state.viewX||0), ty:ly+(state.viewY||0)};
  }
  const ts=getTileSize(canvas,state.W,state.H);
  return {tx:Math.floor((e.clientX-rect.left)/ts), ty:Math.floor((e.clientY-rect.top)/ts)};
}

function getTileSize(canvas,W,H){ return (!W||!H)?20:Math.floor(Math.min(canvas.width/W,canvas.height/H)); }

function fitCanvas(canvas,W,H){
  if(!W||!H) return 20;
  const c=canvas.parentElement;
  const ts=Math.floor(Math.min(c.clientWidth/W,c.clientHeight/H));
  canvas.width=ts*W; canvas.height=ts*H; return ts;
}

// ── Tile / entity rendering ───────────────────────────────────────────────────

function drawGrid(ctx,grid,W,H,ts){
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const t=grid[y][x];
    ctx.fillStyle=TILE_COLORS[t]||'#0c0c14'; ctx.fillRect(x*ts,y*ts,ts,ts);
    if(t===TILE.WALL){ctx.fillStyle='rgba(255,255,255,0.04)';ctx.fillRect(x*ts,y*ts,ts,1);}
    if(t===TILE.EXIT){
      ctx.fillStyle='rgba(29,158,117,0.25)'; ctx.fillRect(x*ts,y*ts,ts,ts);
      ctx.fillStyle='#1D9E75';
      ctx.font=`bold ${Math.max(8,ts*0.5)}px monospace`;
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText('出',x*ts+ts/2,y*ts+ts/2);ctx.textBaseline='alphabetic';
    }
  }
}

function drawTrap(ctx,t,ts,showType){
  if(t.triggered) return;
  const cx=t.x*ts+ts/2, cy=t.y*ts+ts/2;
  const colors={spike:'#cc4444',slow:'#4488cc',push:'#cc9944'};
  ctx.fillStyle=showType?(colors[t.type]||'#888'):'#555';
  ctx.font=`bold ${Math.max(7,ts*0.45)}px monospace`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(showType?(t.type==='spike'?'▲':t.type==='slow'?'❄':'→'):'?',cx,cy);
  ctx.textBaseline='alphabetic';
}

function drawPressurePlates(ctx,plates,ts,ox,oy){
  if(!plates) return;
  for(const pl of plates){
    const x=pl.x-(ox||0), y=pl.y-(oy||0);
    ctx.fillStyle=pl.active?'#44cc66':'#44667a';
    ctx.fillRect(x*ts+2,y*ts+2,ts-4,ts-4);
    ctx.strokeStyle=pl.active?'#88ffaa':'#88aacc'; ctx.lineWidth=2;
    ctx.strokeRect(x*ts+2,y*ts+2,ts-4,ts-4);
    ctx.fillStyle=pl.active?'#fff':'#aaa';
    ctx.font=`bold ${Math.max(6,ts*0.38)}px monospace`;
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText('●',x*ts+ts/2,y*ts+ts/2);ctx.textBaseline='alphabetic';
  }
}

function drawWindmillArms(ctx,arms,ts,ox,oy,now){
  if(!arms?.length) return;
  const pulse=0.5+0.5*Math.sin(now/80);
  ctx.save(); ctx.globalAlpha=0.5+pulse*0.35; ctx.fillStyle='#ff4466';
  for(const arm of arms){
    const cx=(arm.x-(ox||0))*ts+ts/2, cy=(arm.y-(oy||0))*ts+ts/2;
    ctx.beginPath(); ctx.arc(cx,cy,ts*0.4,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

function drawPing(ctx,ping,ts,ox,oy,now){
  const age=now-(ping.bornAt||now), maxAge=3000;
  if(age>maxAge) return;
  const alpha=1-age/maxAge;
  const cx=(ping.x-(ox||0))*ts+ts/2, cy=(ping.y-(oy||0))*ts+ts/2;
  const r=ts*0.6+(age/maxAge)*ts*0.4;
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.strokeStyle=`rgba(255,220,0,${alpha*0.8})`; ctx.lineWidth=2; ctx.stroke();
}

function drawMonster(ctx, m, ts, ox, oy, now) {
  const dp  = getDisplayPos('m_'+m.id, m.x, m.y, now, MONSTER_ANIM_MS);
  const cx  = (dp.x-(ox||0))*ts+ts/2;
  const cy  = (dp.y-(oy||0))*ts+ts/2;
  const vis = MONSTER_VIS[m.monsterType]||MONSTER_VIS.basic;
  const r   = ts*vis.size;
  const si  = STANCE_INFO[m.stance];

  // Idle squash & stretch (slime-like breathing)
  const isIdle = !m.stance || m.stance==='移';
  let scaleX=1, scaleY=1;
  if (isIdle) {
    const speed = {runner:320, brute:720, boss:950}[m.monsterType] || 480;
    const breathe = Math.sin(now/speed + m.id*1.9);
    scaleX = 1 + breathe*0.09;
    scaleY = 1 - breathe*0.07;
  }

  // Draw body (scaled for idle, fixed for attacking stance)
  ctx.save();
  ctx.translate(cx, cy);
  if (isIdle) ctx.scale(scaleX, scaleY);

  if (si && m.stance!=='移') {
    const pulse=0.5+0.5*Math.sin(now/140);
    ctx.beginPath(); ctx.arc(0,0,r+5+pulse*3,0,Math.PI*2);
    ctx.strokeStyle=`${si.color}cc`; ctx.lineWidth=2.5; ctx.stroke();
  }

  ctx.beginPath(); ctx.arc(0,0,r,0,Math.PI*2);
  ctx.fillStyle=vis.bgColor; ctx.fill();
  ctx.strokeStyle=vis.color; ctx.lineWidth=m.monsterType==='boss'?2.5:1; ctx.stroke();

  if (m.monsterType==='boss') {
    const glow=0.4+0.4*Math.sin(now/300);
    ctx.beginPath(); ctx.arc(0,0,r+5,0,Math.PI*2);
    ctx.strokeStyle=`rgba(255,34,68,${glow})`; ctx.lineWidth=3; ctx.stroke();
  }

  ctx.fillStyle=vis.color;
  ctx.font=`bold ${Math.max(7,ts*(m.monsterType==='boss'?0.36:0.32))}px monospace`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(m.label,0,0); ctx.textBaseline='alphabetic';
  ctx.restore();

  // Stance label + HP bar (not scaled)
  if (si && m.stance!=='移') {
    ctx.fillStyle=si.color;
    ctx.font=`bold ${Math.max(6,ts*0.3)}px monospace`;
    ctx.textAlign='center';
    ctx.fillText(si.label, cx, cy-r-3);
  }

  const barW=ts*0.85, barH=m.monsterType==='boss'?5:3;
  const bx=cx-barW/2, by=cy-r-10;
  ctx.fillStyle='#333'; ctx.fillRect(bx,by,barW,barH);
  const pct=m.maxHp?m.hp/m.maxHp:0;
  ctx.fillStyle=pct>0.5?'#44cc44':pct>0.25?'#cccc44':'#cc4444';
  ctx.fillRect(bx,by,barW*pct,barH);
}

function drawPlayer(ctx, p, ts, isMe, ox, oy, now) {
  const dp=getDisplayPos('p_'+p.id,p.x,p.y,now,PLAYER_ANIM_MS);
  const cx=(dp.x-(ox||0))*ts+ts/2, cy=(dp.y-(oy||0))*ts+ts/2, r=ts*0.35;

  // Dead player ghost
  if (p.hp <= 0) {
    ctx.save(); ctx.globalAlpha=0.3;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.fillStyle='#444'; ctx.fill();
    ctx.restore(); return;
  }

  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.fillStyle=ROLE_COLOR[p.role]||'#888'; ctx.fill();
  if(isMe){ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}
  ctx.fillStyle=isMe?'#fff':'rgba(255,255,255,0.65)';
  ctx.font=`${Math.max(7,ts*0.28)}px monospace`;
  ctx.textAlign='center';
  ctx.fillText(p.name.substring(0,4),cx,cy-r-3);

  // Show pending combat action above self (fighter/solo)
  if (isMe && pendingAct && ACTION_INFO[pendingAct]) {
    const ai=ACTION_INFO[pendingAct];
    ctx.save();
    ctx.fillStyle=ai.color;
    ctx.font=`bold ${Math.max(9,ts*0.36)}px monospace`;
    ctx.textAlign='center';
    ctx.shadowColor=ai.color; ctx.shadowBlur=4;
    ctx.fillText(ai.label, cx, cy-r-14);
    ctx.restore();
  }
}

// ── Role renders ──────────────────────────────────────────────────────────────

function renderScout(canvas, state, now) {
  const ts=fitCanvas(canvas,state.W,state.H);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  drawGrid(ctx,state.grid,state.W,state.H,ts);
  if(state.traps) for(const t of state.traps) drawTrap(ctx,t,ts,false);
  if(state.pings) for(const p of state.pings){if(!p.bornAt)p.bornAt=performance.now();drawPing(ctx,p,ts,0,0,now);}
  drawWindmillArms(ctx,state.windmillArms,ts,0,0,now);
  if(state.monsters) for(const m of state.monsters) if(m.hp>0) drawMonster(ctx,m,ts,0,0,now);
  if(state.players) for(const p of Object.values(state.players)) drawPlayer(ctx,p,ts,p.id===gameId,0,0,now);
  drawProjectiles(ctx,state.projectiles,ts,0,0,now);
  drawEffects(ctx,ts,now,0,0); drawFloatingNums(ctx,ts,now,0,0);
}

function renderFighter(canvas, state, now) {
  const VIEW=4, span=VIEW*2+1;
  const ts=fitCanvas(canvas,span,span);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const me=state.players?.[gameId];
  if(!me||!state.localGrid) return;

  const dp=getDisplayPos('p_'+gameId,me.x,me.y,now,PLAYER_ANIM_MS);
  const smoothOx=dp.x-VIEW, smoothOy=dp.y-VIEW;
  const iox=state.viewX, ioy=state.viewY;

  drawGrid(ctx,state.localGrid,span,span,ts);
  drawWindmillArms(ctx,state.windmillArms,ts,smoothOx,smoothOy,now);
  if(state.monsters) for(const m of state.monsters){
    if(m.hp<=0) continue; drawMonster(ctx,m,ts,smoothOx,smoothOy,now);
  }
  if(state.players) for(const p of Object.values(state.players)){
    const lx=p.x-iox, ly=p.y-ioy;
    if(lx<-1||ly<-1||lx>span||ly>span) continue;
    drawPlayer(ctx,p,ts,p.id===gameId,smoothOx,smoothOy,now);
  }
  drawProjectiles(ctx,state.projectiles,ts,smoothOx,smoothOy,now);
  drawEffects(ctx,ts,now,smoothOx,smoothOy);
  drawFloatingNums(ctx,ts,now,smoothOx,smoothOy);

  const ccx=canvas.width/2, ccy=canvas.height/2;
  ctx.strokeStyle='rgba(255,255,255,0.13)'; ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(ccx,0);ctx.lineTo(ccx,canvas.height);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,ccy);ctx.lineTo(canvas.width,ccy);ctx.stroke();
}

function renderArchitect(canvas, state, now) {
  const ts=fitCanvas(canvas,state.W,state.H);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  drawGrid(ctx,state.grid,state.W,state.H,ts);
  if(state.traps) for(const t of state.traps) drawTrap(ctx,t,ts,true);
  if(state.myWalls) for(const w of state.myWalls){
    ctx.fillStyle='rgba(127,119,221,0.25)'; ctx.fillRect(w.x*ts,w.y*ts,ts,ts);
    ctx.strokeStyle='#7F77DD'; ctx.lineWidth=1; ctx.strokeRect(w.x*ts+0.5,w.y*ts+0.5,ts-1,ts-1);
  }
  if(state.pressurePlates) drawPressurePlates(ctx,state.pressurePlates,ts,0,0);
  drawWindmillArms(ctx,state.windmillArms,ts,0,0,now);
  if(state.monsters) for(const m of state.monsters) if(m.hp>0) drawMonster(ctx,m,ts,0,0,now);
  if(state.players) for(const p of Object.values(state.players)) drawPlayer(ctx,p,ts,p.id===gameId,0,0,now);
  drawProjectiles(ctx,state.projectiles,ts,0,0,now);
  drawEffects(ctx,ts,now,0,0); drawFloatingNums(ctx,ts,now,0,0);
}

function renderSharedView(canvas, state, now) {
  const VIEW=4, span=VIEW*2+1;
  const ts=fitCanvas(canvas,span,span);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!state.localGrid) return;

  // Camera follows fighter smoothly
  const fighter=Object.values(state.players||{}).find(p=>p.role==='fighter');
  const camP=fighter||Object.values(state.players||{})[0];
  let smoothOx, smoothOy;
  if(camP){
    const dp=getDisplayPos('p_'+camP.id,camP.x,camP.y,now,PLAYER_ANIM_MS);
    smoothOx=dp.x-VIEW; smoothOy=dp.y-VIEW;
  } else { smoothOx=state.viewX||0; smoothOy=state.viewY||0; }

  drawGrid(ctx,state.localGrid,span,span,ts);
  drawWindmillArms(ctx,state.windmillArms,ts,smoothOx,smoothOy,now);
  if(state.pressurePlates) drawPressurePlates(ctx,state.pressurePlates,ts,smoothOx,smoothOy);

  if(state.monsters) for(const m of state.monsters){
    if(m.hp<=0) continue; drawMonster(ctx,m,ts,smoothOx,smoothOy,now);
  }

  // Architect: highlight own walls within viewport
  if(gameRole==='architect'&&state.myWalls){
    for(const w of state.myWalls){
      const lx=w.x-(state.viewX||0), ly=w.y-(state.viewY||0);
      if(lx<0||ly<0||lx>=span||ly>=span) continue;
      ctx.fillStyle='rgba(127,119,221,0.35)'; ctx.fillRect(lx*ts,ly*ts,ts,ts);
      ctx.strokeStyle='#7F77DD'; ctx.lineWidth=1; ctx.strokeRect(lx*ts+0.5,ly*ts+0.5,ts-1,ts-1);
    }
  }

  // Scout: pings within viewport
  if(gameRole==='scout'&&state.pings){
    for(const p of state.pings){
      if(!p.bornAt) p.bornAt=performance.now();
      drawPing(ctx,p,ts,smoothOx,smoothOy,now);
    }
  }

  if(state.players) for(const p of Object.values(state.players)){
    const lx=p.x-(state.viewX||0), ly=p.y-(state.viewY||0);
    if(lx<-1||ly<-1||lx>span||ly>span) continue;
    drawPlayer(ctx,p,ts,p.id===gameId,smoothOx,smoothOy,now);
  }
  drawProjectiles(ctx,state.projectiles,ts,smoothOx,smoothOy,now);
  drawEffects(ctx,ts,now,smoothOx,smoothOy);
  drawFloatingNums(ctx,ts,now,smoothOx,smoothOy);

  // Scout map overlay (hold M)
  if(gameRole==='scout'&&mapOverlayActive&&state.fullGrid)
    drawMapOverlay(ctx,canvas,state,now);

  // Crosshair
  const ccx=canvas.width/2, ccy=canvas.height/2;
  ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(ccx,0);ctx.lineTo(ccx,canvas.height);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,ccy);ctx.lineTo(canvas.width,ccy);ctx.stroke();
}

function drawMapOverlay(ctx, canvas, state, now) {
  const W=state.W, H=state.H; if(!W||!H) return;
  const sx=canvas.width/W, sy=canvas.height/H;

  ctx.save();
  ctx.globalAlpha=0.88;
  ctx.fillStyle='#090910'; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.globalAlpha=1;

  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const t=state.fullGrid[y][x];
    ctx.fillStyle=TILE_COLORS[t]||'#0c0c14'; ctx.fillRect(x*sx,y*sy,sx,sy);
    if(t===TILE.EXIT){
      ctx.fillStyle='rgba(29,158,117,0.35)'; ctx.fillRect(x*sx,y*sy,sx,sy);
      ctx.fillStyle='#1D9E75';
      ctx.font=`bold ${Math.max(6,sy*0.8)}px monospace`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('出',x*sx+sx/2,y*sy+sy/2); ctx.textBaseline='alphabetic';
    }
  }

  // Traps
  for(const t of (state.traps||[])){
    if(t.triggered) continue;
    ctx.fillStyle='#886633';
    ctx.font=`${Math.max(5,sy*0.7)}px monospace`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('▲',t.x*sx+sx/2,t.y*sy+sy/2); ctx.textBaseline='alphabetic';
  }

  // Pings
  for(const p of (state.pings||[])){
    ctx.beginPath();
    ctx.arc(p.x*sx+sx/2,p.y*sy+sy/2,Math.max(3,sx*1.2),0,Math.PI*2);
    ctx.strokeStyle='#ffdd00'; ctx.lineWidth=2; ctx.stroke();
  }

  // Players
  for(const p of Object.values(state.players||{})){
    ctx.beginPath();
    ctx.arc(p.x*sx+sx/2,p.y*sy+sy/2,Math.max(2.5,sx*0.8),0,Math.PI*2);
    ctx.fillStyle=ROLE_COLOR[p.role]||'#fff'; ctx.fill();
  }

  ctx.restore();

  // Header
  ctx.save();
  ctx.fillStyle='rgba(0,0,0,0.75)'; ctx.fillRect(0,0,canvas.width,20);
  ctx.fillStyle='#1D9E75'; ctx.font='bold 12px monospace';
  ctx.textAlign='center';
  ctx.fillText('全圖視野（放開M或按鈕關閉）',canvas.width/2,14);
  ctx.restore();
}

function buildScoutMapUI() {
  const specials=document.getElementById('g-specials');
  if(!specials) return;
  const wrap=document.createElement('div');
  wrap.innerHTML=`<button id="map-btn" class="cd-bar"
    onmousedown="mapOverlayActive=true" onmouseup="mapOverlayActive=false"
    ontouchstart="mapOverlayActive=true" ontouchend="mapOverlayActive=false">
    🗺 按住看全圖 (M)
  </button>`;
  specials.parentElement.insertBefore(wrap,specials);
}

function renderSolo(canvas, state, now) {
  const ts=fitCanvas(canvas,state.W,state.H);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  drawGrid(ctx,state.grid,state.W,state.H,ts);
  if(state.traps) for(const t of state.traps) drawTrap(ctx,t,ts,true);
  if(state.pings) for(const p of state.pings){if(!p.bornAt)p.bornAt=performance.now();drawPing(ctx,p,ts,0,0,now);}
  if(state.pressurePlates) drawPressurePlates(ctx,state.pressurePlates,ts,0,0);
  drawWindmillArms(ctx,state.windmillArms,ts,0,0,now);
  if(state.monsters) for(const m of state.monsters) if(m.hp>0) drawMonster(ctx,m,ts,0,0,now);
  if(state.players) for(const p of Object.values(state.players)) drawPlayer(ctx,p,ts,p.id===gameId,0,0,now);
  drawProjectiles(ctx,state.projectiles,ts,0,0,now);
  drawEffects(ctx,ts,now,0,0); drawFloatingNums(ctx,ts,now,0,0);
}

// ── HUD ───────────────────────────────────────────────────────────────────────

const LEVEL_TYPE_COLOR = { boss:'#ff2244', rest:'#44cc88', puzzle:'#7F77DD', normal:'#1D9E75' };
const LEVEL_TYPE_LABEL = { boss:'⚡BOSS', rest:'🛌休息', puzzle:'🧩謎題', normal:'' };

function renderHUD(state) {
  const tEl=document.getElementById('g-timer');
  if(tEl&&state.timeLeft!==undefined){
    const s=Math.ceil(state.timeLeft/1000);
    tEl.textContent=`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    tEl.style.color=s<=30?'#D85A30':'#aaa';
  }

  const lvEl=document.getElementById('g-level-badge');
  if(lvEl&&state.level){
    const tl=LEVEL_TYPE_LABEL[state.levelType]||'';
    lvEl.textContent=`Lv.${state.level}${tl?' '+tl:''}`;
    lvEl.style.color=LEVEL_TYPE_COLOR[state.levelType]||'#1D9E75';
  }

  const pEl=document.getElementById('g-players');
  if(pEl&&state.players){
    pEl.innerHTML=Object.values(state.players).map(p=>{
      const pct=p.maxHp?Math.round(100*p.hp/p.maxHp):0;
      const color=ROLE_COLOR[p.role]||'#888'; const dead=p.hp<=0;
      return `<div class="hud-player${dead?' dead':''}">
        <span class="hud-pname" style="color:${color}">${p.name}</span>
        <div class="hud-hp-bar"><div style="width:${pct}%;background:${dead?'#555':color}"></div></div>
        <span class="hud-hp-num">${p.hp}</span>
        ${p.atExit?'<span class="exit-badge">出口</span>':''}
      </div>`;
    }).join('');
  }

  const mEl=document.getElementById('g-messages');
  if(mEl&&state.messages){
    mEl.innerHTML=state.messages.map(m=>`<div class="game-msg">${m.text}</div>`).join('');
  }

  const sEl=document.getElementById('g-specials');
  if(sEl){
    let html='';
    if(state.specialCd>0)   html+=`<div class="cd-bar"><span>技能冷卻</span><span>${(state.specialCd/1000).toFixed(1)}s</span></div>`;
    if(state.specialCd===0) html+=`<div class="cd-bar ready">技能就緒！</div>`;
    if(state.pressurePlates){const done=state.pressurePlates.filter(p=>p.active).length;html+=`<div class="cd-bar${done===state.pressurePlates.length?' ready':''}">壓力板 ${done}/${state.pressurePlates.length}</div>`;}
    if(state.bossPhase2)    html+=`<div class="cd-bar" style="color:#ff4466">⚡ BOSS 狂暴！</div>`;
    if(state.isRestRoom)    html+=`<div class="cd-bar ready">🛌 正在恢復體力…</div>`;
    sEl.innerHTML=html;
  }
}

// ── Render loop ───────────────────────────────────────────────────────────────

function renderLoop(now) {
  if(!latestState){ animId=requestAnimationFrame(renderLoop); return; }
  const state=latestState;
  try {
    const canvas=document.getElementById('game-canvas');
    if(isSolo&&canvas){
      renderSolo(canvas,state,now); renderScholar(state);
      document.getElementById('g-alerts').style.display='block';
      document.getElementById('g-monsters').style.display='block';
    } else if(gameRole==='fighter'&&canvas) {
      renderFighter(canvas,state,now);
    } else if(canvas&&state.localGrid) {
      renderSharedView(canvas,state,now);
      if(gameRole==='scholar') renderScholar(state);
    }
    renderHUD(state);
  } catch(e){ console.error('render error',e); }
  animId=requestAnimationFrame(renderLoop);
}

// ── Input (keyboard) ──────────────────────────────────────────────────────────

function setupInput(socket) {
  const dirMap = {
    ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0],
    w:[0,-1],s:[0,1],a:[-1,0],d:[1,0],W:[0,-1],S:[0,1],A:[-1,0],D:[1,0],
  };
  const actMap = { '1':'刺','2':'斬','3':'架','0':null,'j':'刺','k':'斬','l':'架','J':'刺','K':'斬','L':'架' };

  document.addEventListener('keydown',(e)=>{
    if(e.key==='m'||e.key==='M'){ mapOverlayActive=true; return; }
    if(e.key==='Escape'){
      actionQueue=[]; pendingDx=0; pendingDy=0; pendingAct=null;
      socket.emit('player_submit',{dx:0,dy:0,combatAction:null});
      updatePadUI(); updateQueueUI(); return;
    }
    if(!latestState||latestState.phase!=='playing') return;
    const dir=dirMap[e.key];
    if(dir){
      e.preventDefault();
      if(actionQueue.length<QUEUE_MAX){ actionQueue.push({dx:dir[0],dy:dir[1]}); updateQueueUI(); }
      return;
    }
    if(e.key in actMap){ e.preventDefault(); pendingAct=actMap[e.key]; _submitAndRefresh(socket); return; }
    if(e.key===' '||e.code==='Space'){ e.preventDefault(); _submitAndRefresh(socket); }
  });
}

// ── Quick messages ────────────────────────────────────────────────────────────

const QUICK_MSGS = [
  '敵人快到了！','快去出口！','我快死了！','幫我！',
  '出口在右下！','前方有陷阱！','我去吸引怪！','準備好了',
  '用架！','用刺！','用斬！','閃開！',
];

function buildQuickMessages(socket, role) {
  const el=document.getElementById('g-quick'); if(!el) return;
  el.innerHTML=`<div class="panel-label">快速訊息</div>`+
    QUICK_MSGS.map(t=>`<button class="quick-btn" onclick="window._quickMsg('${t}')">${t}</button>`).join('');
  window._quickMsg=(text)=>socket.emit('quick_msg',{text});
}

// ── Role help ─────────────────────────────────────────────────────────────────

const ROLE_HELP = {
  scout:     'WASD 移動 · 右鍵標記位置\n你能看到所有怪物的姿態！\n通報戰士怪物的姿態',
  fighter:   'WASD 移動 · J/K/L 選擇動作\nJ=刺(克黃) K=斬(克蒼) L=架(克赤)\n0=純移動 · Esc=立即停下',
  scholar:   '點「標記」減速怪物並通報姿態\n你能看到所有怪物的攻擊預告',
  architect: 'WASD 移動 · 點地圖放牆\n你能看到完整地圖和陷阱',
};

function buildRoleHelp(role) {
  const el=document.getElementById('g-help'); if(!el) return;
  const help=isSolo?'WASD 移動 · 1/2/3 選動作 · 0=純移動\n架→克赤 刺→克黃 斬→克蒼\n右鍵標記 · 點地圖放牆':(ROLE_HELP[role]||'');
  el.innerHTML=`<div class="panel-label">操作說明</div><pre class="help-text">${help}</pre>`;
}

// ── Export ────────────────────────────────────────────────────────────────────

window.GAME = {
  initGame,
  stopGame,
  showLevelBanner,
  onBeat,
  setLatestState: (s) => {
    updateEffects(latestState, s, performance.now());
    syncProjectiles(s);
    latestState = s;
  },
};

window.DEV = {
  nextLevel:  ()  => _devSocket?.emit('debug_cheat',{cmd:'next_level'}),
  killAll:    ()  => _devSocket?.emit('debug_cheat',{cmd:'kill_monsters'}),
  fullHp:     ()  => _devSocket?.emit('debug_cheat',{cmd:'full_hp'}),
  gotoLevel:  (n) => _devSocket?.emit('debug_cheat',{cmd:'goto_level',val:n}),
};
