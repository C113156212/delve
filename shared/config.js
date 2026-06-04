var CONFIG = {

  // ── 房間 ──────────────────────────────────────────
  ROOM_CODE_LENGTH: 4,
  MAX_PLAYERS: 4,
  MIN_PLAYERS_TO_START: 1,

  // ── 玩家血量 ──────────────────────────────────────
  PLAYER_HP: {
    fighter:   150,
    scholar:    90,
    architect: 110,
    fool:      100,
  },

  // ── 計時（秒）────────────────────────────────────
  ROOM_TIMER: {
    combat:  60,
    puzzle:  30,
    boss:    90,
  },

  // ── 主動技能 CD（ms）─────────────────────────────
  // 約以 700ms/beat 為基準
  CD: {
    FIGHTER_TAUNT:    5600,  // 8 beats
    SCHOLAR_SLOW:     4900,  // 7 beats
    ARCHITECT_DECOY:  4200,  // 6 beats
    FOOL_SACRIFICE:   4900,  // 7 beats
  },

  // ── 怪物 ─────────────────────────────────────────
  MONSTER_ACTION_INTERVAL: 1500,
  MONSTER_TELEGRAPH_MS:     500,
  MONSTER_BASE_DMG:         10,

  // ── 建築師誘餌 ────────────────────────────────────
  DECOY_HP:            40,  // 怪物攻擊 N 次後消失
  DECOY_DURATION_BEAT:  3,  // 最多持續 beat 數

  // ── 陷阱 ─────────────────────────────────────────
  TRAPS: {
    spike: { dmg: 15,     label: '尖刺' },
    slow:  { duration: 3, label: '減速' },
    push:  { force: 2,    label: '推力' },
  },

  // ── 房間尺寸 ──────────────────────────────────────
  ROOM: {
    width:    20,
    height:   14,
    tileSize: 40,
  },

};

if (typeof module !== 'undefined') module.exports = { CONFIG };
