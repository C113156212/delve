var CONFIG = {

  // ── 房間 ──────────────────────────────────────────
  ROOM_CODE_LENGTH: 4,
  MAX_PLAYERS: 4,
  MIN_PLAYERS_TO_START: 1,   // solo 可玩

  // ── 玩家血量（個人血量）──────────────────────────
  PLAYER_HP: {
    scout:     100,
    fighter:   150,
    scholar:   90,
    architect: 110,
  },

  // ── 計時（秒）────────────────────────────────────
  ROOM_TIMER: {
    combat:  60,
    puzzle:  30,
    boss:    90,
  },

  // ── 怪物 ─────────────────────────────────────────
  MONSTER_ACTION_INTERVAL: 1500,    // ms，怪物每次行動間隔
  MONSTER_TELEGRAPH_MS:     500,    // ms，預告動畫持續時間
  MONSTER_BASE_DMG:         10,

  // ── 建築師 ────────────────────────────────────────
  ARCHITECT_WALL_COOLDOWN:  8000,   // ms
  ARCHITECT_MAX_WALLS:      3,

  // ── 陷阱 ─────────────────────────────────────────
  TRAPS: {
    spike: { dmg: 15,     label: '尖刺' },
    slow:  { duration: 3, label: '減速' },  // 秒
    push:  { force: 2,    label: '推力' },  // 格
  },

  // ── 房間尺寸 ──────────────────────────────────────
  ROOM: {
    width:    20,
    height:   14,
    tileSize: 40,
  },

};

if (typeof module !== 'undefined') module.exports = { CONFIG };
