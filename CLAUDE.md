# DELVE

多人即時地下城 roguelike，1–4 人，角色分工合作過關。  
**線上：** https://delve-08.duckdns.org

## 架構

```
Browser ──WSS/HTTPS──> Nginx（443）
                          ├── 靜態：/mnt/data/home/delve/client/  ← nginx 直接服務
                          └── /socket.io/ → 127.0.0.1:3001
                                         [delve container] Node.js + socket.io（純 WS 邏輯）
```

靜態前端和遊戲伺服器分離：nginx 負責 HTML/JS，Node 只處理 socket.io 連線。  
**執行方式：** Podman rootless + Quadlet systemd

## 目錄

```
/mnt/data/home/delve/         ← home = repo 根目錄（drwx--x---+）
├── client/                   ← 靜態前端（nginx 服務）
│   ├── index.html            ← 遊戲 UI
│   └── game.js               ← 全部客戶端邏輯
├── server/
│   ├── index.js              ← socket.io server 入口（無靜態服務）
│   ├── game.js               ← 遊戲狀態機、戰鬥邏輯
│   └── rooms.js              ← 房間管理
├── shared/
│   └── config.js             ← 前後端共用常數（CONFIG 物件）
├── Containerfile             ← node:20-slim，只 COPY server/ shared/
├── package.json              ← 只依賴 socket.io
└── .config/containers/systemd/
    └── delve.container       ← PORT=3001，CORS_ORIGIN 限 duckdns
```

## Socket.io 事件

**Client→Server**
- `create_room{name}` / `join_room{name,code}` / `pick_role{role}`
- `start_game` — 只有 host 可呼叫
- `quick_match{name}` / `quick_match_vote` / `cancel_match`
- `player_submit{dx,dy,combatAction,targetId}`
- `player_activate{x,y}` — H 鍵技能
- `quick_msg{text}` — 白名單快捷訊息

**Server→Client**
- `room_created/joined/updated` / `match_queue` / `match_found`
- `game_start` / `game_state` / `beat{beat,turn,beatMs}`
- `level_up` / `game_end{result,players}`
- `online_count{count}` / `error_msg{msg}`

## 角色

| 角色 | 說明 |
|------|------|
| fighter | 高 HP，嘲諷技能 |
| scholar | 低 HP，減速技能 |
| architect | 中 HP，可放誘餌 |
| fool | 中 HP，犧牲技能 |

人數不足時未選角色以 `bonusRoles` 形式分配給玩家。

## 部署操作

```bash
# 以 delve 身份
podman build -t localhost/delve:latest ~/
systemctl --user daemon-reload
systemctl --user restart delve
journalctl --user -u delve -f
```

**client/ 更新直接生效**（nginx 靜態），不須重建 image。  
**server/ 或 shared/ 更新**需重建 image 並重啟 container。
