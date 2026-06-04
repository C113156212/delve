# DELVE — 開發速查手冊

## 版本
v1.5.1 (2026-06-04)。`package.json` version 欄與 git log 同步更新。

## 檔案結構
```
server/index.js   — Express + Socket.IO 伺服器，房間管理，beat 計時器
server/game.js    — 全部遊戲邏輯（地圖生成、怪物 AI、戰鬥解決）
server/rooms.js   — lobby 房間管理（join/pick role/canStart）
shared/config.js  — 常數（HP、CD、TRAPS）
client/game.js    — 渲染、輸入、UI（~1700 行）
client/index.html — 單頁 HTML
```

## Beat 循環（server/index.js:76）
每 80ms poll，`now - lastBeatTime >= beatMs` 時觸發：
```
resolveTurn(gs) → checkEndConditions → startTurn(gs) → emit('beat')
```
- `startTurn`：清 pendingActions、怪物 AI decide（設 stance）
- `resolveTurn`：1.玩家移動 2.怪物移動 3.戰鬥結算 4.BOSS 特效

## 關鍵函數速查（server/game.js）

| 函數 | 約行號 | 說明 |
|------|--------|------|
| `getLevelParams(level)` | 25 | 回傳關卡 type/monsters/baseHp/beatMs |
| `getMapDimensions(params)` | 342 | 走廊 H=6，BOSS 26×18，休息 16×6，謎題 22×6 |
| `generateCorridor` | 378 | 一般關卡地圖（pillar 障礙，trapCount=0） |
| `generatePuzzleRoom` | 424 | 謎題室：H=6 時實際無牆（loop y<H-2=4，gap 涵蓋全部） |
| `_createPressurePlates` | 435 | 謎題壓力板位置 |
| `createGameState` | 488 | 初始化 gs，players 陣列→gamePlayers 字典 |
| `nextLevel` | 545 | 就地修改 gs 跳下一關 |
| `startTurn` | 620 | 每 beat 開始；清 pendingActions；AI decide；maxAttackers 限制 |
| `resolveTurn` | 677 | 每 beat 結束；Step1 玩家移動、Step2 怪物移動、Step3 戰鬥 |
| `movePlayerFree` | 969 | 非戰鬥即時移動，200ms 冷卻 |
| `_resolveMelee` | 790 | RPS 戰鬥結算（win/clash/lose） |
| `_resolveScholarGuard` | 880 | 學者自動架格擋 |
| `_resolveArcherShot` | 922 | 弓手射擊（需同行/列） |
| `filterStateForRole` | 1173 | 依職業裁切 gs 發給 client |

## 遊戲狀態（gs）重要欄位
```js
gs.players      // { [socketId]: { x,y,hp,maxHp,role,atExit,comboStreak,lastFreeMove } }
gs.monsters     // [ { id,monsterType,x,y,hp,maxHp,stance,patternIdx,stunTurns,rageTurns,rushMove2 } ]
gs.pendingActions // { [socketId]: { dx,dy,combatAction,targetId } } — 每 beat startTurn 清空
gs.beatMs       // 目前 beat 速度（ms），可被 BOSS 切換
gs.exitOpen     // false=鎖 | true=開 | undefined=rest室（EXIT tile 本來就開）
gs.pressurePlates // puzzle 室壓力板陣列
gs.levelType    // 'normal'|'boss'|'rest'|'puzzle'
```

## 關卡節奏（9 關一循環，共 27 關）
- L3,12,21 = rest（無怪，全回血）
- L6,15,24 = puzzle（謎題壓力板）
- L9,18,27 = BOSS（tier 1/2/3）
- 其他 = normal（corridor）

## 怪物類型速查
| 類型 | 顏色 | 模式 | 特色 | 章節 |
|------|------|------|------|------|
| basic | 紅 | 赤移蒼移黃移移休 | 標準 RPS | ch1 |
| runner | 橙 | 赤×3休×2循環 | rushMove2 on 赤 | ch2 |
| brute | 藍（大） | 移移黃×3循環 | 高 HP/dmg，patternIdx 固定從0 | ch2 |
| splitter | 粉紅 | 赤移黃移赤蒼移休 | HP降50%分裂成2隻 splitter_mini | ch2末 |
| splitter_mini | 粉紅小 | 赤移赤休循環 | rushMove2，無法再分裂 | 分裂後生成 |
| evader | 翠綠 | 赤移赤休循環 | rushMove2 on 赤，快攻型 | ch3 |
| archer | 金 | 射移射射休循環 | 同行/列射擊 | ch3 |
| mirror | 銀藍 | 赤移赤移循環 | 玩家 win→記住動作→下拍出克制 stance | ch3中 |
| boss | 深紅 | BOSS_PATTERNS[tier].p1/p2/p3 | 多階段 | L9/18/27 |

## mirror 機制
`COUNTER_OF = { 刺:赤, 斬:黃, 架:蒼 }`  
玩家 win 後：`monster.mirrorStance = COUNTER_OF[playerAction]` → 下一拍 AI 直接 use mirrorStance  
強制玩家輪換：架→斬→刺→架→…（重複同一動作必輸）

## splitter 機制
`_checkSplit` 在 win/clash 傷害後呼叫：hp>0 且 hp≤maxHp*0.5 且 !hasSplit → `_doSplit`  
`_doSplit`：mark hasSplit=true，在相鄰格生成最多2隻 splitter_mini（baseHp=原始maxHp，hpMult=0.40）

## RPS 反制表
```
架 克 赤（快攻）  |  刺 克 黃（重擊）  |  斬 克 蒼（穿刺）
赤 克 刺         |  黃 克 斬          |  蒼 克 架
```

## maxAttackers 限制（startTurn:657）
- level ≤15：同時最多 1 隻攻擊
- level ≥16：最多 2 隻
- BOSS 房：無限制

## 玩家移動流程（server/index.js player_submit handler）
```
client keydown → socket.emit('player_submit', {dx,dy,combatAction,targetId})
server：
  if !combatAction && !targetId:
    moved = movePlayerFree(...)   // returns true | 'combat' | false
    if moved !== 'combat': return  // 即時移動成功 OR 冷卻丟棄
  submitPlayerAction(...)          // 只有戰鬥中才 queue
  // resolveTurn Step1 執行 pendingActions
```

## 已知設計細節／坑
- `generatePuzzleRoom`：H=6 時內牆 loop 範圍不含有效 y，實際上是空曠房間
- `stunTurns` on LOSE = 1（短暫），`rageTurns` = 3（之後幾 beat 傷害 ×1.5）
- `stunTurns` on WIN = brute:2 / 其他:1（成功反制有喘息時間）
- rest 室：`exitOpen=undefined`（EXIT tile 一開始就存在），`_restHealed` 防止多次回血
- 弓手：不在同行/列不觸發射擊；dist<=1 改用 赤 stance 近戰
- Boss rush：boss2 P2 赤/黃 rushMove2；boss3 P3 全攻擊 rushMove2
- `FREE_MOVE_COOLDOWN = 200ms`（~5 格/秒）

## 部署指令
```bash
su -s /bin/bash delve -c 'cd /mnt/data/home/delve && TMPDIR=/tmp XDG_RUNTIME_DIR=/run/user/2005 HOME=/mnt/data/home/delve podman build --no-cache -t localhost/delve:latest .'
systemctl --machine=delve@.host --user restart delve.service
```
