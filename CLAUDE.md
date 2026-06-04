# DELVE — 開發速查手冊

## 版本
v2.0.0 (2026-06-04)。角色系統全面重設計。`package.json` version 欄與 git log 同步更新。

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

## 角色技能設計 v2.0（重設計中，尚未實作）
> 每個角色：一個弱點 + 一個被動 + 一個主動。舊的角色行為（自動架格擋、ping、放牆）全部清除重建。
> 實作時一起加入各狀態的視覺特效（見下方特效欄）。

### 戰士（Fighter） HP:150 攻擊力:18 ✅ 設計完成

**弱點 [孤立]**
`傷害乘數 = (1.8 - n×1.2) × 0.85`
n = 視野內存活隊友數 / max(1, 總存活人數-1)，範圍 0.0~1.0
單人模式：n 固定 1.0（弱點停用）

| n | 乘數 |
|---|------|
| 0.0（無隊友） | 1.53× |
| 0.5（半數在視野）| 1.02× |
| 1.0（全員在視野）| 0.51× |

**被動 [騎士精神]**
視野內任何隊友受到的傷害，30% 轉給戰士承擔。
轉移的傷害不受孤立乘數影響（flat 計算）。

**主動 M [嘲諷]** CD:8 beat，持續:3 beat
視野內所有怪物強制以戰士為目標。
戰士攻擊命中造成的傷害 100% 轉換為治療，依各人**缺血量比例**分配給全隊。
└ **低血啟動（HP < 40% 時）**：
　　∙ 嘲諷期間受到的傷害額外 ×0.75（安全網，幫助撐過去）
　　∙ 治療轉換率 100% → 60%（小惡意，獎勵打折）

**待實作視覺特效**
| 狀態 | 特效 |
|------|------|
| n=0（孤立最脆）| 玩家周圍紅色脈衝圈，閃爍隨危險程度加快 |
| n=1（全員在場）| 柔和金色光暈 |
| 騎士精神觸發 | 受傷隊友→戰士的短暫流動粒子 |
| 嘲諷啟動 | 戰士周圍紅色旋轉環；被吸引怪物頭上出現箭頭 |
| 嘲諷攻擊轉治療 | 命中特效改金色；受益隊友浮現 +HP |
| 低血嘲諷（< 40%）| 嘲諷環改橘紅色，治療數字加灰色標記表示打折 |

---

### 愚者（Fool）HP:100 攻擊力:10 ✅ 設計完成（取代原斥候 scout）

**弱點 [無法回血]**
愚者在戰鬥中完全無法回血（反制成功無治療，隊友技能不能補她血）。
只有休息室有效。她的生存完全取決於少被打——技術好的玩家可以管理。

**被動 [神罰]**
被怪物打到（LOSE）時隨機觸發一個效果：
- 🎭 純特效 35%（氣球爆炸、問號符號、踉蹌後退 1 格、畫面飽和度暴衝）
- ⭐ 好事 45%（全隊回血25、怪物彈飛2格、最近怪暈眩2beat、全隊vulnerable傷害×1.5 1beat、全隊移動加速3beat）
- 💀 小麻煩 20%（最近怪狂暴、全隊各扣5HP、下1beat QTE stance提示消失）
觸發時有翻牌動畫，讓全隊知道發生什麼。

**主動 H [獻祭] CD:7 beat**
愚者主動消耗 20 HP，從正面效果池（好事+純特效）抽出 3 個效果同時觸發。
積極性展現：「我來換運氣！」——有代價，但是真正的幫助。
### 學者（Scholar）HP:90 攻擊力:0 ✅ 設計完成

**弱點 [孤身無用]**
視野 7×7（最小）。視野內無存活隊友時，被動與主動技能全部停用。
無法進行 RPS 戰鬥（輸入無效，純支援角色）。

**被動 [看穿]**
學者視野內所有怪物的 nextSteps（未來 3 beat pattern 預測）對全隊所有人可見。
注意：nextSteps 是從靜態 pattern 陣列預測，不是保證——maxAttackers 降級、暈眩、減速都可能讓實際 stance 不同。

**主動 H [節律震盪]** CD:7 beat
將接下來 2 beat 的 beatMs 延長 ×1.4（例如 700ms → 980ms）。
全隊 QTE 窗口變寬，反應時間增加。對高速怪物（runner、bomber QTE）效果最明顯。
### 建築師（Architect）HP:110 攻擊力:12 ✅ 設計完成

**弱點 [遲緩]**
自由移動冷卻 500ms（一般人 200ms）。
走得慢，必須提前卡位。仍可進行 RPS 戰鬥。

**被動 [工程師視野]**
永遠看見全地圖 + 所有怪物的 nextTarget（知道每隻怪在追誰）。
唯一能看見機關／壓力板位置的角色（其他人看不見，需要建築師通報）。

**主動 H [誘餌] CD:6 beat**
在視野內的任一空格部署誘餌。
視野內所有怪物立刻改目標為誘餌，持續 3 beat（或誘餌 HP 耗盡）。
誘餌有固定 HP，被怪物攻擊消耗，耗盡後效果提前結束。

---

## 全角色通用特效原則
- 被動持續狀態：低調持續動畫（不干擾戰鬥視野）
- 主動技能啟動：明確一次性特效 + 持續期間視覺提示
- 狀態結束：淡出動畫

## maxAttackers 系統說明
每個 beat，所有怪物各自獨立 `decide()` 決定 stance，不知道其他怪的決定。
`startTurn` 結束前統一處理：蒐集所有「想攻擊的怪」→ 按距離排序 → 只有最近的 N 隻保留攻擊 stance，其餘強制改 `'移'`。
- Level ≤15：N=1；Level ≥16：N=2；Boss 房：無限制
- **nextSteps 顯示的攻擊拍不保證真的攻擊**（可能被 maxAttackers 降級）
- 遠的怪看起來要攻擊 → 如果更近的怪也在攻，遠的那隻會被降成走路

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
