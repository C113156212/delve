# DELVE v0.2

## 啟動

```bash
npm install
npm run server
```

瀏覽器開 http://localhost:3000

## 目前功能
- 輸入名字
- 建立房間（取得 4 字元代碼）
- 輸入代碼加入房間
- 選擇職業（每個職業只能一人）
- 房主按開始（至少 2 人且所有人選完職業）

## 檔案結構
```
shared/config.js   ← 所有數值在這裡改
server/rooms.js    ← 房間管理邏輯
server/index.js    ← 伺服器主程式
client/index.html  ← 前端（菜單畫面）
```

## 下一步
- 遊戲場景（Phaser）
- 戰鬥系統
- 怪物行動力與預警
