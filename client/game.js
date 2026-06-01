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
  '移': { label:'移', color:'#555577', desc:'靠近', counter:'' },
  '閃': { label:'閃', color:'#cc55ff', desc:'閃避', counter:'遠程' },
  '休': { label:'休', color:'#334455', desc:'休息', counter:'攻！' },
  '射': { label:'射', color:'#ffaa33', desc:'射擊', counter:'架' },
  '全彈':{ label:'彈', color:'#ff2244', desc:'全圖彈目', counter:'閃開！' },
};

// Client-side mirror of server's MONSTER_PATTERNS for beat-track display
const MONSTER_PATTERNS_CLIENT = {
  basic:   ['赤','移','蒼','移','黃','移','移','休'],
  runner:  ['赤','赤','赤','休','赤','赤','赤','休'],
  brute:   ['移','移','黃','移','移','黃','移','黃'],  // charges 2, heavy ×3
  evader:  ['閃','移','閃','赤','閃','移','閃','赤'],
  archer:  ['射','移','射','射','休','射','移','射'],
  boss:    ['赤','移','蒼','移','黃','移','全彈','移'],
};

const ACTION_INFO = {
  '刺': { label:'刺', color:'#ffcc22', key:'1', desc:'刺→克黃重擊' },
  '斬': { label:'斬', color:'#ff7755', key:'2', desc:'斬→克蒼穿刺' },
  '架': { label:'架', color:'#44aaff', key:'3', desc:'架→克赤快攻' },
  null: { label:'無', color:'#555555', key:'0', desc:'純移動' },
};

// RPS result table (mirrored from server for client-side preview)
const STANCE_RESULT = {
  '刺': { '赤':'lose','蒼':'clash','黃':'win','移':'win','射':'lose' },
  '斬': { '赤':'clash','蒼':'win','黃':'lose','移':'win','射':'lose' },
  '架': { '赤':'win','蒼':'lose','黃':'clash','移':'win','射':'block' },
  null: { '赤':'lose','蒼':'lose','黃':'lose','移':'none','射':'lose' },
};
const RESULT_COLOR = { win:'#44ff88', clash:'#ffcc22', lose:'#ff4444', block:'#44aaff', none:'#555' };
const RESULT_LABEL = { win:'克', clash:'拍', lose:'敗', block:'格', none:'—' };

const MONSTER_VIS = {
  basic:  { color:'#dd3333', bgColor:'#550a0a', size:0.38 },  // 紅
  runner: { color:'#ff8800', bgColor:'#5a2a00', size:0.30 },  // 橙
  brute:  { color:'#5566ff', bgColor:'#12184a', size:0.46 },  // 藍
  evader: { color:'#22cc88', bgColor:'#0a3a22', size:0.32 },  // 翠綠
  archer: { color:'#ddbb22', bgColor:'#3a3000', size:0.33 },  // 金
  boss:   { color:'#ff1155', bgColor:'#440010', size:0.55 },  // 深紅
};

const PLAYER_ANIM_MS  = 140;
const MONSTER_ANIM_MS = 220;
const BEATS_PER_TURN  = 8;
const BEAT_MS         = 500;  // must match server

// QTE timing zones (fraction of one beat = 500 ms)
const QTE_ZONES = [
  { start:0.00, end:0.22, label:'太早', color:'rgba(200,55,35,0.42)',  fg:'#ff6644' },
  { start:0.22, end:0.58, label:'可以', color:'rgba(185,150,20,0.38)', fg:'#ffcc33' },
  { start:0.58, end:0.88, label:'最佳', color:'rgba(28,165,75,0.44)',  fg:'#44ee88' },
  { start:0.88, end:1.00, label:'危險', color:'rgba(200,55,35,0.42)',  fg:'#ff6644' },
];
function _qteZone(t) {
  return QTE_ZONES.find(z => t <= z.end) || QTE_ZONES[QTE_ZONES.length - 1];
}

// ── Game state ───────────────────────────────────────────────────────────────

let gameRole         = null;
let gameId           = null;
let latestState      = null;
let animId           = null;
let isSolo           = false;
let _devSocket       = null;
let mapOverlayActive = false;

let pendingDir      = {dx:0, dy:0};  // single-slot movement
let pendingTargetId = null;
let hoverMonsterId  = null;

// Current pending action for this player (shown in UI)
let pendingDx   = 0;
let pendingDy   = 0;
let pendingAct  = null;   // '刺'|'斬'|'架'|null
let lastBeat    = 0;
let beatFlash   = 0;      // performance.now() of last beat event

let qtePressT    = null;   // 0-1: beat position when player last pressed
let qteResultAt  = null;   // performance.now() of that press
let prevInCombat = false;  // for detecting combat mode transitions
let winStreak    = 0;      // consecutive 'win' results

const dyingMonsters = new Map(); // id → {snap, diedAt} — death animation
const playerHurtAt  = new Map(); // id → timestamp — hurt shake/tint
let   screenShake   = null;      // {startAt, until, strength} | null

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
        winStreak++;
        _addFlash(r.mx, r.my, '#ffe844', 400);
        _addRing(r.mx, r.my, '#44ff88', 550);
        _addFloat('反制！', r.mx, r.my - 0.6, '#ffe844', true);
        if (winStreak >= 3) _addFloat(`${winStreak}連擊!!`, r.px, r.py - 1.2, '#ff9900', true);
      } else if (r.result === 'clash') {
        winStreak = 0;
        _addFlash(r.mx, r.my, '#ff9944', 350);
        _addFlash(r.px, r.py, '#ff9944', 350);
        _addFloat('互拍！', r.mx, r.my - 0.6, '#ff9944', true);
      } else if (r.result === 'lose') {
        winStreak = 0;
        _addFlash(r.px, r.py, '#ff2200', 400);
        _addRing(r.px, r.py, '#ff4444', 500);
      } else if (r.result === 'block') {
        _addRing(r.px, r.py, '#44aaff', 450);
        _addFloat('格擋！', r.px, r.py - 0.6, '#44aaff', true);
      }
    }
  }

  // HP-change damage numbers + monster death burst
  for (const m of (next.monsters||[])) {
    const pm = prev.monsters?.find(x=>x.id===m.id);
    if (!pm) continue;
    const dp = displayPos.get('m_'+m.id) || { x:m.x, y:m.y };
    if (pm.hp > m.hp && m.hp > 0) {
      _addFloat(`-${pm.hp-m.hp}`, dp.x, dp.y - 0.4, '#ff8888');
    }
    if (pm.hp > 0 && m.hp === 0) {
      // Monster died — burst effect + big float + death animation
      const col = (MONSTER_VIS[m.monsterType]||MONSTER_VIS.basic).color;
      effects.push({ px:dp.x, py:dp.y, color:col, t0:now, dur:800, type:'burst' });
      _addFloat('擊倒!', dp.x, dp.y - 0.8, '#ffe844', true);
      const dpSnap = displayPos.get('m_'+m.id);
      dyingMonsters.set(m.id, { snap:{ ...pm, x: dpSnap?.tx ?? m.x, y: dpSnap?.ty ?? m.y }, diedAt:now });
    }
  }
  for (const [id, p] of Object.entries(next.players||{})) {
    const pp = prev.players?.[id];
    if (!pp) continue;
    const dp = displayPos.get('p_'+id) || { x:p.x, y:p.y };
    if (pp.hp > p.hp && p.hp > 0) {
      const dmgTaken = pp.hp - p.hp;
      _addFloat(`-${dmgTaken}`, dp.x, dp.y - 0.4, '#ffbb55');
      if (dmgTaken >= 15) _addRing(p.x, p.y, '#ff2200', 600);
      playerHurtAt.set(id, now);
      if (dmgTaken >= 10 && !screenShake)
        screenShake = { startAt: now, until: now + 360, strength: Math.min(7, dmgTaken * 0.28) };
    }
    if (pp.hp > 0 && p.hp === 0) {
      effects.push({ px:p.x, py:p.y, color:'#ff4444', t0:now, dur:800, type:'burst' });
      _addFloat('💀', p.x, p.y - 1, '#ff4444', true);
    }
  }
  // Combat mode transition — brief red vignette on entering combat
  if (!prev.inCombat && next.inCombat) {
    effects.push({ color:'#ff2244', t0:now, dur:500, type:'vignette' });
  }
}

function drawEffects(ctx, ts, now, ox, oy) {
  effects = effects.filter(e => now - e.t0 < e.dur);
  for (const e of effects) {
    const t = (now - e.t0) / e.dur;
    ctx.save();

    if (e.type === 'vignette') {
      // Full-canvas edge flash (combat entry warning)
      const cv = ctx.canvas;
      const alpha = Math.max(0, (1 - t) * (1 - t) * 0.5);
      const grad = ctx.createRadialGradient(
        cv.width/2, cv.height/2, cv.height * 0.2,
        cv.width/2, cv.height/2, cv.height * 0.75);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(1, e.color);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cv.width, cv.height);
    } else if (e.type === 'burst') {
      const bx = (e.px - (ox||0)) * ts + ts/2;
      const by = (e.py - (oy||0)) * ts + ts/2;
      const ease = 1 - (1-t)*(1-t);
      // 16 particles: alternating large/small at different speeds
      for (let i = 0; i < 16; i++) {
        const ang  = (i / 16) * Math.PI * 2;
        const large = i % 2 === 0;
        const spd  = large ? 1.35 : 0.75;
        const px2  = bx + Math.cos(ang) * ts * spd * ease;
        const py2  = by + Math.sin(ang) * ts * spd * ease;
        const r2   = Math.max(1, ts * (large ? 0.18 : 0.09) * (1 - t * 0.65));
        ctx.globalAlpha = Math.max(0, (1 - t) * (large ? 0.88 : 0.55));
        ctx.beginPath(); ctx.arc(px2, py2, r2, 0, Math.PI*2);
        ctx.fillStyle = large ? e.color : '#ffffff'; ctx.fill();
      }
      // Expanding ring
      ctx.globalAlpha = Math.max(0, (1 - t * 1.3) * 0.55);
      ctx.beginPath(); ctx.arc(bx, by, ts * 0.55 * ease, 0, Math.PI*2);
      ctx.strokeStyle = e.color; ctx.lineWidth = 2.5; ctx.stroke();
      // Central flash
      ctx.globalAlpha = Math.max(0, (1 - t * 2.2) * 0.75);
      ctx.beginPath(); ctx.arc(bx, by, ts * 0.48, 0, Math.PI*2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
    } else {
      const cx = (e.px - (ox||0)) * ts + ts/2;
      const cy = (e.py - (oy||0)) * ts + ts/2;
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

// ── Dying monster death animation ────────────────────────────────────────────

function drawDyingMonsters(ctx, ts, now, ox, oy) {
  const DEATH_DUR = 620;
  for (const [id, d] of dyingMonsters) {
    const age = now - d.diedAt;
    if (age > DEATH_DUR) { dyingMonsters.delete(id); continue; }
    const t   = age / DEATH_DUR;
    const vis = MONSTER_VIS[d.snap.monsterType] || MONSTER_VIS.basic;
    const r   = ts * vis.size * Math.max(0, 1 - t * 1.25);
    if (r < 1) continue;
    const cx  = (d.snap.x - (ox||0)) * ts + ts/2;
    const cy  = (d.snap.y - (oy||0)) * ts + ts/2;
    const rot = t * Math.PI * 2.8;
    const a   = Math.max(0, 1 - t * 1.4);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI*2);
    ctx.fillStyle = vis.bgColor; ctx.fill();
    ctx.strokeStyle = vis.color; ctx.lineWidth = 1.5; ctx.stroke();
    const xs = r * 0.6;
    ctx.strokeStyle = vis.color; ctx.lineWidth = Math.max(1.5, r * 0.35);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-xs, -xs); ctx.lineTo(xs, xs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(xs, -xs); ctx.lineTo(-xs, xs); ctx.stroke();
    ctx.restore();
  }
}

// ── Screen shake (CSS-level) ──────────────────────────────────────────────────

function _tickShake(canvas, now) {
  if (!screenShake) return;
  if (now >= screenShake.until) { screenShake = null; canvas.style.transform = ''; return; }
  const t = (now - screenShake.startAt) / (screenShake.until - screenShake.startAt);
  const decay = Math.exp(-t * 5);
  const sx = Math.round(screenShake.strength * decay * Math.sin(t * 47));
  const sy = Math.round(screenShake.strength * decay * Math.sin(t * 59 + 1.8));
  canvas.style.transform = `translate(${sx}px, ${sy}px)`;
}

// ── QTE timing bar ────────────────────────────────────────────────────────────

// Returns player's canvas pixel position for the current role's viewport.
function _playerScreenPos(canvas, state, now) {
  const myPlayer = state.players?.[gameId];
  if (!myPlayer) return null;
  const dp = getDisplayPos('p_'+gameId, myPlayer.x, myPlayer.y, now, PLAYER_ANIM_MS);

  // Solo / full-map view (no localGrid)
  if (isSolo || !state.localGrid) {
    const ts = getTileSize(canvas, state.W || 26, state.H || 18);
    return { x: dp.x * ts + ts/2, y: dp.y * ts + ts/2, ts };
  }

  const span = state.localGrid.length;
  const VIEW = Math.floor(span / 2);
  const ts   = getTileSize(canvas, span, span);

  // Fighter: camera always follows self → player at canvas centre
  if (gameRole === 'fighter') {
    return { x: canvas.width / 2, y: canvas.height / 2, ts };
  }

  // Scout / architect / scholar: camera follows fighter (or self for scholar)
  const camPlayer = gameRole === 'scholar'
    ? myPlayer
    : (Object.values(state.players || {}).find(p => p.role === 'fighter') || myPlayer);
  const camDp = getDisplayPos('p_'+camPlayer.id, camPlayer.x, camPlayer.y, now, PLAYER_ANIM_MS);
  const ox = camDp.x - VIEW, oy = camDp.y - VIEW;
  return { x: (dp.x - ox) * ts + ts/2, y: (dp.y - oy) * ts + ts/2, ts };
}

// Draw QTE timing bar BELOW the player (doesn't cover monster stances above).
function drawQTE(canvas, state, now) {
  const myPlayer = state.players?.[gameId];
  if (!myPlayer || myPlayer.hp <= 0) return;

  // Show QTE for d<=2 — monsters at d=2 move adjacent and attack in the SAME beat
  const adjacent = (state.monsters || []).filter(m => {
    if (m.hp <= 0 || !m.stance) return false;
    const d = Math.abs(m.x - myPlayer.x) + Math.abs(m.y - myPlayer.y);
    return d <= 2 && m.stance !== '移' && m.stance !== '休' && m.stance !== '全彈' && m.stance !== '閃';
  });
  if (!adjacent.length) return;
  // Sort by distance so the closest (most urgent) monster is shown first
  adjacent.sort((a,b) =>
    (Math.abs(a.x-myPlayer.x)+Math.abs(a.y-myPlayer.y)) -
    (Math.abs(b.x-myPlayer.x)+Math.abs(b.y-myPlayer.y)));

  const spos = _playerScreenPos(canvas, state, now);
  if (!spos) return;

  const ctx = canvas.getContext('2d');
  const { x: pcx, y: pcy, ts } = spos;

  const BAR_W   = Math.max(94, ts * 5.8);
  const BAR_H   = 14;
  const playerR = ts * 0.35;
  const barLeft = pcx - BAR_W / 2;

  // ── Layout BELOW the player (top→down): player ▸ hint ▸ ▼cursor ▸ bar ──────
  //   hintY  = just below player circle
  //   barTop = below hint + cursor triangle
  //   barBot = barTop + BAR_H
  const hintY  = pcy + playerR + 14;
  const barTop = hintY + 14;
  const barBot = barTop + BAR_H;

  // Clamp to canvas so bar doesn't go off bottom
  const overflow = barBot + 2 - canvas.height;
  const shift    = overflow > 0 ? overflow : 0;
  const hY  = hintY  - shift;
  const bTop = barTop - shift;
  const bBot = barBot - shift;

  ctx.save();

  // Dark background behind entire QTE widget for readability
  ctx.fillStyle = 'rgba(0,0,4,0.72)';
  ctx.beginPath();
  const bgPad = 6, bgX = barLeft - bgPad, bgY = hY - 10;
  const bgW = BAR_W + bgPad*2, bgH = bBot + 8 - bgY;
  ctx.roundRect ? ctx.roundRect(bgX, bgY, bgW, bgH, 5) : ctx.rect(bgX, bgY, bgW, bgH);
  ctx.fill();

  // ── 1. Hint: 【stance】▶【counter】 ────────────────────────────────────────
  const m = adjacent[0];
  const si = STANCE_INFO[m.stance] || {};
  const counter = (si.counter === '遠程' || !si.counter) ? '攻！' : si.counter;
  const ai = ACTION_INFO[counter];
  const hfs = Math.max(8, BAR_W * 0.1);

  ctx.textBaseline = 'middle';
  const stStr = `【${m.stance}】`, ctStr = `【${counter}】`;
  ctx.font = `bold ${hfs * 1.05}px monospace`;
  const stW = ctx.measureText(stStr).width;
  const ctW = ctx.measureText(ctStr).width;
  ctx.font = `${hfs * 0.78}px monospace`;
  const arW = ctx.measureText('▶').width;
  const totalW = stW + arW + ctW + 8;
  let hx = pcx - totalW / 2;

  // Key binding hint: 刺=[J] 斬=[K] 架=[L]
  const keyHint = {'刺':'[J]','斬':'[K]','架':'[L]'};
  const ctKey = keyHint[counter] || '';

  ctx.font = `bold ${hfs * 1.05}px monospace`; ctx.textAlign = 'left';
  ctx.fillStyle = si.color || '#aaa'; ctx.shadowColor = si.color; ctx.shadowBlur = 4;
  ctx.fillText(stStr, hx, hY); hx += stW + 3; ctx.shadowBlur = 0;

  ctx.font = `${hfs * 0.78}px monospace`; ctx.fillStyle = '#444';
  ctx.fillText('▶', hx, hY); hx += arW + 3;

  ctx.font = `bold ${hfs * 1.05}px monospace`;
  ctx.fillStyle = ai?.color || '#aaa'; ctx.shadowColor = ai?.color; ctx.shadowBlur = 4;
  ctx.fillText(ctStr, hx, hY); hx += ctx.measureText(ctStr).width; ctx.shadowBlur = 0;

  if (ctKey) {
    ctx.font = `${hfs * 0.82}px monospace`; ctx.fillStyle = '#777';
    ctx.fillText(ctKey, hx + 2, hY);
    hx += ctx.measureText(ctKey).width + 4;
  }
  if (adjacent.length > 1) {
    ctx.font = `${hfs * 0.82}px monospace`; ctx.fillStyle = '#ff6644';
    ctx.fillText(` +${adjacent.length - 1}`, hx + ctW + 2, hY);
  }

  // Next-beat preview: show upcoming stances as small badges to the right
  if (m.nextSteps?.length) {
    const previewX = barLeft + BAR_W + 6;
    const previewFs = Math.max(6, hfs * 0.82);
    ctx.font = `${previewFs * 0.75}px monospace`;
    ctx.fillStyle = '#333'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('次：', previewX, hY);
    const lblW = ctx.measureText('次：').width;
    let px2 = previewX + lblW;
    for (let i = 0; i < Math.min(m.nextSteps.length, 2); i++) {
      const ns = m.nextSteps[i];
      const nsi = STANCE_INFO[ns] || {};
      ctx.font = `bold ${previewFs}px monospace`;
      ctx.fillStyle = nsi.color || '#888';
      ctx.fillText(ns, px2, hY);
      px2 += ctx.measureText(ns).width + 3;
    }
  }

  // ── 2. Timing zone bands ────────────────────────────────────────────────────
  for (const z of QTE_ZONES) {
    const zx = barLeft + z.start * BAR_W;
    const zw = (z.end - z.start) * BAR_W;
    ctx.fillStyle = z.color; ctx.fillRect(zx, bTop, zw, BAR_H);
    if (zw > 20) {
      ctx.font = `${Math.max(6, BAR_W * 0.062)}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.65; ctx.fillStyle = z.fg;
      ctx.fillText(z.label, zx + zw/2, bTop + BAR_H/2);
      ctx.globalAlpha = 1;
    }
  }
  ctx.strokeStyle = '#555'; ctx.lineWidth = 1;
  ctx.strokeRect(barLeft, bTop, BAR_W, BAR_H);

  // ── 3. Moving cursor — ▼ triangle sitting on TOP edge of bar ───────────────
  const t  = Math.min(0.999, Math.max(0, (now - beatFlash) / currentBeatMs));
  const cx = barLeft + t * BAR_W;

  // Beat-start flash: brief white wash on bar each new beat
  const currentBeatMs = latestState?.beatMs || BEAT_MS;
  const beatAge = now - beatFlash;
  if (beatAge < 240) {
    const pulse = Math.max(0, 1 - beatAge / 240) * 0.28;
    ctx.globalAlpha = pulse; ctx.fillStyle = '#ffffff';
    ctx.fillRect(barLeft, bTop, BAR_W, BAR_H);
    ctx.globalAlpha = 1;
  }

  // Cursor glow through bar
  ctx.globalAlpha = 0.28; ctx.fillStyle = '#fff';
  ctx.fillRect(cx - 3, bTop, 6, BAR_H);
  ctx.globalAlpha = 1;

  // Cursor trail — 3 fading ghost triangles behind the main cursor
  for (let i = 3; i >= 1; i--) {
    const tp = Math.max(0, t - i * 0.045);
    const tx2 = barLeft + tp * BAR_W;
    ctx.globalAlpha = 0.12 / i;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(tx2 - (6-i), bTop - (11-i*2));
    ctx.lineTo(tx2 + (6-i), bTop - (11-i*2));
    ctx.lineTo(tx2,          bTop);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Cursor colour: white normally, green pulse in 最佳 zone, red in 危險
  const curZone = _qteZone(t);
  const curCol = curZone.label === '最佳' ? '#66ffaa'
               : curZone.label === '危險' ? '#ff6644'
               : '#ffffff';
  const curPulse = curZone.label === '最佳' ? (0.6 + 0.4 * Math.sin(now / 55)) : 1;

  // ▼ Main cursor triangle: base above bar, tip pointing DOWN to bar top edge
  ctx.fillStyle = curCol; ctx.shadowColor = curCol; ctx.shadowBlur = 8 + curPulse * 6;
  ctx.beginPath();
  ctx.moveTo(cx - 7, bTop - 12);
  ctx.lineTo(cx + 7, bTop - 12);
  ctx.lineTo(cx,     bTop);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;

  // Thin bright line through bar (also colour-matched)
  ctx.fillStyle = curCol; ctx.globalAlpha = 0.88;
  ctx.fillRect(cx - 1, bTop, 2, BAR_H);
  ctx.globalAlpha = 1;

  // ── 4. Press marker — vertical line + ◆ below bar + rising zone label ──────
  if (qtePressT !== null && qteResultAt !== null) {
    const age   = now - qteResultAt;
    const alpha = Math.min(1, age / 55) * Math.max(0, 1 - age / 1800);
    if (alpha > 0.02) {
      const pz = _qteZone(qtePressT);
      const mx = barLeft + qtePressT * BAR_W;
      ctx.save(); ctx.globalAlpha = alpha;

      // Line through bar
      ctx.fillStyle = pz.fg; ctx.fillRect(mx - 2, bTop - 4, 4, BAR_H + 8);

      // ◆ diamond below bar
      ctx.beginPath();
      ctx.moveTo(mx,     bBot + 4);
      ctx.lineTo(mx + 6, bBot + 10);
      ctx.lineTo(mx,     bBot + 16);
      ctx.lineTo(mx - 6, bBot + 10);
      ctx.closePath();
      ctx.fillStyle = pz.fg; ctx.shadowColor = pz.fg; ctx.shadowBlur = 8;
      ctx.fill(); ctx.shadowBlur = 0;

      // Rising zone label (rises DOWNWARD, away from player)
      const rise = Math.min(1, age / 300) * 10;
      ctx.font = `bold ${Math.max(9, BAR_W * 0.1)}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = pz.fg; ctx.shadowColor = pz.fg; ctx.shadowBlur = 5;
      ctx.fillText(pz.label, mx, bBot + 28 + rise);
      ctx.shadowBlur = 0;

      ctx.restore();
    }
  }

  ctx.textBaseline = 'alphabetic'; ctx.restore();
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
  dyingMonsters.clear(); playerHurtAt.clear(); screenShake=null;
  pendingDx=0; pendingDy=0; pendingAct=null;
  pendingDir={dx:0,dy:0}; pendingTargetId=null; hoverMonsterId=null;
  mapOverlayActive=false;
  lastCombatResultTs=0;

  buildGameScreen(role);
  buildActionPad(socket, role);
  setupInput(socket);
  if (role==='scholar'||isSolo) {
    buildScholarUI();
    document.getElementById('scholar-panel').style.display='flex';
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
  animId=null; latestState=null;
  pendingDir={dx:0,dy:0}; pendingTargetId=null;
  const c=document.getElementById('game-canvas');
  if(c) c.style.transform='';
  screenShake=null;
}

// ── Level banner ──────────────────────────────────────────────────────────────

function showLevelBanner(completedLevel, nextLvl, maxLevel, levelType) {
  let banner=document.getElementById('level-banner');
  if(!banner){banner=document.createElement('div');banner.id='level-banner';document.body.appendChild(banner);}
  if(completedLevel>=maxLevel){
    banner.innerHTML=`<div class="lv-title">🏆 全關卡完成！</div><div class="lv-sub">等待最終結果…</div>`;
  } else if(levelType==='rest'){
    banner.innerHTML=`<div class="lv-title">🛌 休息站</div><div class="lv-sub">全隊血量回滿！稍作休息後繼續…</div>`;
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
        <span id="g-mode-badge" class="beat-label">自由</span>
        ${Array.from({length:BEATS_PER_TURN},(_,i)=>`<span class="beat-dot" id="bd-${i+1}"></span>`).join('')}
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

  const dmgNote = role==='fighter'||isSolo ? '18傷' : role==='scout'?'10傷':role==='architect'?'12傷':'8傷';
  const actionButtons = `
    <div class="pad-label">動作 (J K L / 1 2 3)${role!=='fighter'&&!isSolo?' <span style="color:#555;font-size:8px">'+dmgNote+'</span>':''}</div>
    <div class="action-row">
      <button class="act-btn" id="act-刺" onclick="window._setAct('刺')">刺<br><small>[J] 克黃</small></button>
      <button class="act-btn" id="act-斬" onclick="window._setAct('斬')">斬<br><small>[K] 克蒼</small></button>
      <button class="act-btn" id="act-架" onclick="window._setAct('架')">架<br><small>[L] 克赤</small></button>
      <button class="act-btn act-none" id="act-null" onclick="window._setAct(null)">無<br><small>[0] 移動</small></button>
    </div>`;

  el.innerHTML=`
    <div class="pad-section">
      <div class="pad-header">
        <span class="pad-label">移動 (WASD)</span>
        <span id="pending-dir-badge" class="pad-label" style="color:#1D9E75">·</span>
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
      ${actionButtons}
      <div id="pad-preview" class="pad-preview">等待下一拍…</div>
    </div>
  `;

  window._setDir = (dx, dy) => {
    if (dx===0&&dy===0) {
      pendingDir={dx:0,dy:0}; pendingTargetId=null; pendingAct=null;
      socket.emit('player_submit',{dx:0,dy:0,combatAction:null,targetId:null});
      updatePadUI(); _updateDirBadge(); return;
    }
    pendingDir={dx,dy};
    socket.emit('player_submit',{dx,dy,combatAction:pendingAct,targetId:pendingTargetId});
    _updateDirBadge(); updatePadUI();
  };
  window._setAct = (act) => {
    pendingAct=act;
    _recordQtePress();
    _submitAndRefresh(socket);
  };
  window._markMonster = (id) => socket.emit('mark_monster', { monsterId:id });

  // Canvas: click to attack, mousemove for hover
  const canvas = document.getElementById('game-canvas');
  if (canvas) {
    canvas.addEventListener('mousemove', (e) => {
      const {tx,ty}=canvasToTile(canvas,e,latestState);
      if(tx===null){hoverMonsterId=null;return;}
      const m=latestState?.monsters?.find(mo=>mo.hp>0&&mo.x===tx&&mo.y===ty);
      hoverMonsterId=m?m.id:null;
      canvas.style.cursor=hoverMonsterId?'crosshair':'default';
    });
    canvas.addEventListener('mouseleave',()=>{hoverMonsterId=null;canvas.style.cursor='default';});
    canvas.addEventListener('click',(e)=>{
      if(!latestState) return;
      const {tx,ty}=canvasToTile(canvas,e,latestState);
      if(tx===null) return;
      const m=latestState?.monsters?.find(mo=>mo.hp>0&&mo.x===tx&&mo.y===ty);
      // Scholar: click monster → mark it (scholar's unique action)
      if(gameRole==='scholar'&&!isSolo&&m){
        socket.emit('mark_monster',{monsterId:m.id}); return;
      }
      // Architect: click empty floor → place wall
      if((gameRole==='architect'||isSolo)&&!m){
        socket.emit('place_wall',{x:tx,y:ty}); return;
      }
      // All other roles: click monster → set as attack target
      if(!m) return;
      pendingTargetId=m.id;
      _recordQtePress();
      _submitAndRefresh(socket);
    });
  }
}

function _submitAndRefresh(socket) {
  socket.emit('player_submit', { dx:pendingDir.dx, dy:pendingDir.dy, combatAction:pendingAct, targetId:pendingTargetId });
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
    if (!latestState?.inCombat) {
      preview.innerHTML = '🚶 自由移動中';
    } else {
      const actColor = pendingAct ? ACTION_INFO[pendingAct].color : '#555';
      preview.innerHTML=`移動：<b>${dirLabel}</b> ／ 動作：<b style="color:${actColor}">${actLabel}</b>`;
    }
  }

  // Highlight action button
  for (const k of ['刺','斬','架',null]) {
    const btn=document.getElementById('act-'+(k||'null'));
    if(btn) btn.classList.toggle('selected', k===pendingAct);
  }
}

function _updateDirBadge() {
  const el=document.getElementById('pending-dir-badge');
  if(!el) return;
  const {dx,dy}=pendingDir;
  el.textContent=dx>0?'→':dx<0?'←':dy>0?'↓':dy<0?'↑':'·';
  el.style.color=(dx||dy)?'#1D9E75':'#333';
}

function updateBeatUI(beat, socket) {
  const combat = latestState?.inCombat ?? false;
  for (let i=1;i<=BEATS_PER_TURN;i++) {
    const dot=document.getElementById('bd-'+i);
    if(!dot) continue;
    dot.classList.remove('beat-done','beat-current','beat-resolve');
    if (!combat) { dot.classList.add('beat-done'); continue; }  // dim all dots in free mode
    if(i<beat)        dot.classList.add('beat-done');
    else if(i===beat) dot.classList.add('beat-current');
  }
  if (combat) {
    // Combat mode: clear one-shot actions every beat
    pendingAct=null;
    pendingTargetId=null;
    pendingDir={dx:0,dy:0};
    updatePadUI(); _updateDirBadge();
  }
}

function _recordQtePress() {
  if (!latestState?.inCombat) return;
  qtePressT   = Math.min(0.999, Math.max(0, (performance.now() - beatFlash) / BEAT_MS));
  qteResultAt = performance.now();
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
    const span=state.localGrid.length;
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

  // Beat-synced squash & stretch
  const beatAge = now - beatFlash;
  let scaleX=1, scaleY=1;
  const rawDp = displayPos.get('m_'+m.id);

  if (lastBeat===1 && beatAge<420) {
    // Telegraph beat: coil (compress + widen), all monsters
    const t = beatAge/420;
    const coil = Math.sin(t*Math.PI) * 0.14;
    const moving = m.stance==='移' || (rawDp&&(rawDp.tx!==rawDp.sx||rawDp.ty!==rawDp.sy));
    if (moving) { scaleX=1+coil*0.7; scaleY=1-coil; }
    else        { scaleX=1+coil*0.5; scaleY=1+coil*0.5; } // attacker swells
  } else if (lastBeat===BEATS_PER_TURN && beatAge<MONSTER_ANIM_MS && rawDp &&
             (rawDp.tx!==rawDp.sx||rawDp.ty!==rawDp.sy)) {
    // Resolve beat: elongate along movement direction during slide
    const t = beatAge/MONSTER_ANIM_MS;
    const elong = Math.sin(t*Math.PI)*0.28;
    const mdx=rawDp.tx-rawDp.sx, mdy=rawDp.ty-rawDp.sy;
    if (Math.abs(mdx)>=Math.abs(mdy)) { scaleX=1+elong; scaleY=1-elong*0.4; }
    else                               { scaleY=1+elong; scaleX=1-elong*0.4; }
  } else if (!m.stance||m.stance==='移') {
    // Idle: subtle breathing between beats
    const speed={runner:350,brute:750,boss:1000}[m.monsterType]||520;
    const b=Math.sin(now/speed+m.id*1.9)*0.04;
    scaleX=1+b; scaleY=1-b*0.7;
  }

  // Draw body (scaled for idle, fixed for attacking stance)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scaleX, scaleY);

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

  // (stance label now drawn large in the section below)

  const barW=ts*0.85, barH=m.monsterType==='boss'?5:3;
  const bx=cx-barW/2, by=cy-r-10;
  ctx.fillStyle='#333'; ctx.fillRect(bx,by,barW,barH);
  const pct=m.maxHp?m.hp/m.maxHp:0;
  ctx.fillStyle=pct>0.5?'#44cc44':pct>0.25?'#cccc44':'#cc4444';
  ctx.fillRect(bx,by,barW*pct,barH);

  // ── Stance label (large) ─────────────────────────────────────────────────────
  if (si && m.stance !== '移' && m.stance !== '休') {
    const pulse = 0.6 + 0.4 * Math.sin(now / 160);
    ctx.save();
    ctx.fillStyle = si.color;
    ctx.font = `bold ${Math.max(10, ts * 0.52)}px monospace`;
    ctx.textAlign = 'center';
    ctx.shadowColor = si.color; ctx.shadowBlur = 6 + pulse * 4;
    ctx.fillText(si.label, cx, by - barH - 3);
    ctx.restore();
  }

  // ── Rage indicator ───────────────────────────────────────────────────────────
  if (m.enraged) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 100);
    ctx.save(); ctx.globalAlpha = 0.55 + pulse * 0.3;
    ctx.beginPath(); ctx.arc(cx, cy, r + 6 + pulse * 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff4400'; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.restore();
  }

  // ── Result preview: show win/clash/lose prediction when player has action + monster has stance ──
  if (m.stance && m.id===pendingTargetId) {
    const result=STANCE_RESULT[pendingAct]?.[m.stance];
    if (result && result!=='none') {
      ctx.save();
      ctx.fillStyle=RESULT_COLOR[result];
      ctx.font=`bold ${Math.max(9,ts*0.32)}px monospace`;
      ctx.textAlign='left'; ctx.shadowColor=RESULT_COLOR[result]; ctx.shadowBlur=5;
      ctx.fillText(RESULT_LABEL[result], cx+r+4, cy+4);
      ctx.restore();
    }
  }
}

function drawPlayer(ctx, p, ts, isMe, ox, oy, now) {
  const dp = getDisplayPos('p_'+p.id, p.x, p.y, now, PLAYER_ANIM_MS);
  let cx = (dp.x-(ox||0))*ts+ts/2;
  let cy = (dp.y-(oy||0))*ts+ts/2;
  const r = ts * 0.35;

  // Dead player ghost
  if (p.hp <= 0) {
    ctx.save(); ctx.globalAlpha=0.3;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.fillStyle='#444'; ctx.fill();
    ctx.restore(); return;
  }

  // Hurt shake
  const hurtTs  = playerHurtAt.get(p.id);
  const hurtAge = hurtTs !== undefined ? now - hurtTs : 99999;
  if (hurtAge < 430) {
    const ht = hurtAge / 430;
    const shakeAmt = ts * 0.12 * Math.exp(-ht * 5) * Math.sin(ht * Math.PI * 9);
    cx += shakeAmt;
    cy += shakeAmt * 0.5;
  }

  // Beat bounce (combat)
  const beatAge2 = now - beatFlash;
  if (latestState?.inCombat && beatAge2 < 210) {
    cy -= Math.sin(beatAge2 / 210 * Math.PI) * ts * 0.09;
  }

  // Idle breathe (non-combat)
  if (!latestState?.inCombat) {
    const phase = typeof p.id === 'string' ? p.id.charCodeAt(0) * 0.7 : 0;
    const b = Math.sin(now / 720 + phase) * 0.028;
    cx += b * ts * 0.3;
    cy -= b * ts * 0.5;
  }

  // Combat pulse ring (isMe)
  if (isMe && latestState?.inCombat) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 115);
    ctx.save();
    ctx.globalAlpha = 0.22 + pulse * 0.18;
    ctx.beginPath(); ctx.arc(cx, cy, r + 5 + pulse * 2, 0, Math.PI*2);
    ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.fillStyle=ROLE_COLOR[p.role]||'#888'; ctx.fill();
  if(isMe){ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}
  ctx.fillStyle=isMe?'#fff':'rgba(255,255,255,0.65)';
  ctx.font=`${Math.max(7,ts*0.28)}px monospace`;
  ctx.textAlign='center';
  ctx.fillText(p.name.substring(0,4),cx,cy-r-3);

  // Pending combat action above self (fighter/solo)
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

  // Hurt tint overlay (red flash)
  if (hurtAge < 360) {
    const ha = Math.max(0, 1 - hurtAge / 360) * 0.52;
    ctx.save();
    ctx.globalAlpha = ha;
    ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI*2);
    ctx.fillStyle = '#ff1800'; ctx.fill();
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
  drawDyingMonsters(ctx,ts,now,0,0);
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
    if(m.vulnerable){
      const dp2=getDisplayPos('m_'+m.id,m.x,m.y,now,MONSTER_ANIM_MS);
      const vcx=(dp2.x-smoothOx)*ts+ts/2, vcy=(dp2.y-smoothOy)*ts+ts/2;
      const pulse=0.5+0.5*Math.sin(now/150);
      ctx.save(); ctx.globalAlpha=0.35+pulse*0.2;
      ctx.beginPath(); ctx.arc(vcx,vcy,ts*0.55,0,Math.PI*2);
      ctx.strokeStyle='#aa44ff'; ctx.lineWidth=2.5; ctx.setLineDash([4,3]); ctx.stroke();
      ctx.restore();
    }
  }
  drawDyingMonsters(ctx,ts,now,smoothOx,smoothOy);
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
  drawDyingMonsters(ctx,ts,now,0,0);
  if(state.players) for(const p of Object.values(state.players)) drawPlayer(ctx,p,ts,p.id===gameId,0,0,now);
  drawProjectiles(ctx,state.projectiles,ts,0,0,now);
  drawEffects(ctx,ts,now,0,0); drawFloatingNums(ctx,ts,now,0,0);
}

function _rangeForRole(role) {
  return 1;  // all melee
}

function renderSharedView(canvas, state, now) {
  const span=state.localGrid?.length||9;
  const VIEW=Math.floor(span/2);
  const ts=fitCanvas(canvas,span,span);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!state.localGrid) return;

  // Camera: for scout/architect follow fighter; for scholar follow self
  const fighter=Object.values(state.players||{}).find(p=>p.role==='fighter');
  const camP = gameRole==='scholar'
    ? state.players?.[gameId]
    : (fighter||Object.values(state.players||{})[0]);
  let smoothOx, smoothOy;
  if(camP){
    const dp=getDisplayPos('p_'+camP.id,camP.x,camP.y,now,PLAYER_ANIM_MS);
    smoothOx=dp.x-VIEW; smoothOy=dp.y-VIEW;
  } else { smoothOx=state.viewX||0; smoothOy=state.viewY||0; }

  drawGrid(ctx,state.localGrid,span,span,ts);
  drawWindmillArms(ctx,state.windmillArms,ts,smoothOx,smoothOy,now);
  if(state.pressurePlates) drawPressurePlates(ctx,state.pressurePlates,ts,smoothOx,smoothOy);

  // Attack range overlay
  const me=state.players?.[gameId];
  if(me){
    const range=_rangeForRole(gameRole);
    ctx.save(); ctx.globalAlpha=0.07;
    ctx.fillStyle=ROLE_COLOR[gameRole]||'#fff';
    for(let dy=-range;dy<=range;dy++) for(let dx=-range;dx<=range;dx++){
      if(Math.abs(dx)+Math.abs(dy)>range) continue;
      const lx=me.x+dx-smoothOx, ly=me.y+dy-smoothOy;
      if(lx<0||ly<0||lx>=span||ly>=span) continue;
      ctx.fillRect(lx*ts,ly*ts,ts,ts);
    }
    ctx.restore();
  }

  if(state.monsters) for(const m of state.monsters){
    if(m.hp<=0) continue; drawMonster(ctx,m,ts,smoothOx,smoothOy,now);
    // Vulnerable glow
    if(m.vulnerable){
      const dp2=getDisplayPos('m_'+m.id,m.x,m.y,now,MONSTER_ANIM_MS);
      const vcx=(dp2.x-smoothOx)*ts+ts/2, vcy=(dp2.y-smoothOy)*ts+ts/2;
      const pulse=0.5+0.5*Math.sin(now/150);
      ctx.save(); ctx.globalAlpha=0.35+pulse*0.2;
      ctx.beginPath(); ctx.arc(vcx,vcy,ts*0.55,0,Math.PI*2);
      ctx.strokeStyle='#aa44ff'; ctx.lineWidth=2.5; ctx.setLineDash([4,3]); ctx.stroke();
      ctx.restore();
    }
    // Hover / selected target highlight
    const isHover=m.id===hoverMonsterId, isTarget=m.id===pendingTargetId;
    if(isHover||isTarget){
      const dp2=getDisplayPos('m_'+m.id,m.x,m.y,now,MONSTER_ANIM_MS);
      const lx=(dp2.x-smoothOx)*ts, ly=(dp2.y-smoothOy)*ts;
      ctx.save();
      ctx.strokeStyle=isTarget?'#ffee44':'rgba(255,255,255,0.5)';
      ctx.lineWidth=isTarget?2:1.5;
      if(isTarget) ctx.setLineDash([]);
      else ctx.setLineDash([3,3]);
      ctx.strokeRect(lx+1,ly+1,ts-2,ts-2);
      ctx.restore();
    }
  }

  drawDyingMonsters(ctx,ts,now,smoothOx,smoothOy);

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
  drawDyingMonsters(ctx,ts,now,0,0);
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

  const modeEl=document.getElementById('g-mode-badge');
  if(modeEl){
    if(state.inCombat){ modeEl.textContent='⚔戰鬥'; modeEl.style.color='#D85A30'; }
    else              { modeEl.textContent='🚶自由'; modeEl.style.color='#555577'; }
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
    if(canvas) _tickShake(canvas, now);
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
    if(canvas && state.phase==='playing') drawQTE(canvas, state, now);
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

  const STANCES=[null,'刺','斬','架'];
  const dirMap2={w:[0,-1],s:[0,1],a:[-1,0],d:[1,0],W:[0,-1],S:[0,1],A:[-1,0],D:[1,0],
    ArrowUp:[0,-1],ArrowDown:[0,1]};

  document.addEventListener('keydown',(e)=>{
    if(e.key==='m'||e.key==='M'){ mapOverlayActive=true; return; }
    if(e.key==='Escape'){
      pendingDir={dx:0,dy:0}; pendingTargetId=null; pendingAct=null;
      socket.emit('player_submit',{dx:0,dy:0,combatAction:null,targetId:null});
      updatePadUI(); _updateDirBadge(); return;
    }
    if(!latestState||latestState.phase!=='playing') return;
    const dir=dirMap2[e.key];
    if(dir){
      e.preventDefault();
      pendingDir={dx:dir[0],dy:dir[1]};
      socket.emit('player_submit',{dx:dir[0],dy:dir[1],combatAction:pendingAct,targetId:pendingTargetId});
      _updateDirBadge(); updatePadUI(); return;
    }
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
      e.preventDefault();
      const idx=STANCES.indexOf(pendingAct);
      pendingAct=e.key==='ArrowRight'?STANCES[(idx+1)%STANCES.length]:STANCES[(idx-1+STANCES.length)%STANCES.length];
      _recordQtePress(); _submitAndRefresh(socket); return;
    }
    if(e.key in actMap){ e.preventDefault(); pendingAct=actMap[e.key]; _recordQtePress(); _submitAndRefresh(socket); return; }
    if(e.key===' '||e.code==='Space'){ e.preventDefault(); _recordQtePress(); _submitAndRefresh(socket); }
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
  scout:     'WASD 自由走 · 遇怪進戰鬥模式\nJ/K/L 選招式 · 克制+治療15%\nM 看全圖 · 右鍵標記位置',
  fighter:   'WASD 自由走 · 遇怪進戰鬥模式\nJ/K/L 選招式 · 克制+治療15%\n怪物頭下方的 QTE 條看時機！',
  scholar:   'WASD 自由走 · 遇怪自動架格擋\n格擋成功→怪物易傷+治療\n點怪物標記・看怪物招式序列',
  architect: 'WASD 自由走 · 遇怪進戰鬥模式\nJ/K/L 選招式 · 克制+治療15%\n點地圖放牆（最多3面）',
};

function buildRoleHelp(role) {
  const el=document.getElementById('g-help'); if(!el) return;
  const help=isSolo?'WASD 移動 · 1/2/3 選動作 · 0=純移動\n架→克赤 刺→克黃 斬→克蒼\n右鍵標記 · 點地圖放牆':(ROLE_HELP[role]||'');
  const soloHelp = 'WASD 自由走 · 靠近怪物進戰鬥模式\n1/2/3 或 J/K/L 選招式\n架→克赤 刺→克黃 斬→克蒼\nQTE 條在玩家下方 · 看三角游標時機';
  el.innerHTML=`<div class="panel-label">操作說明</div><pre class="help-text">${isSolo?soloHelp:(ROLE_HELP[role]||help)}</pre>`;
}

// ── Export ────────────────────────────────────────────────────────────────────

window.GAME = {
  initGame,
  stopGame,
  showLevelBanner,
  onBeat,
  setLatestState: (s) => {
    const now = performance.now();
    updateEffects(latestState, s, now);
    syncProjectiles(s);
    // Clear QTE + pending actions when leaving combat
    if (prevInCombat && !s.inCombat) {
      qtePressT = null; qteResultAt = null;
      pendingAct = null; pendingTargetId = null;
      winStreak = 0;
      updatePadUI();
    }
    prevInCombat = s.inCombat || false;
    latestState = s;
  },
};

window.DEV = {
  nextLevel:  ()  => _devSocket?.emit('debug_cheat',{cmd:'next_level'}),
  killAll:    ()  => _devSocket?.emit('debug_cheat',{cmd:'kill_monsters'}),
  fullHp:     ()  => _devSocket?.emit('debug_cheat',{cmd:'full_hp'}),
  gotoLevel:  (n) => _devSocket?.emit('debug_cheat',{cmd:'goto_level',val:n}),
};
