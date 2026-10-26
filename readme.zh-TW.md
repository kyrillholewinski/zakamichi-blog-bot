# zakamichi-blog-bot

[English](readme.md) | **繁體中文**

爬取坂道系列團體的部落格（櫻坂46、日向坂46、乃木坂46、僕が見たかった青空），翻譯每一篇新文章，
並依照 `zakamichi-message-bot` 的訊息格式推送到 Telegram 頻道。
執行期間可透過只限擁有者使用的 Telegram 管理面板，控制推送目標、翻譯與推送。

## 快速開始

1. 安裝相依套件：

   ```bash
   npm install
   ```

2. 在專案根目錄建立 `.env`（請參考[環境變數](#環境變數)）。至少需要設定
   `GEMINI_API_KEY` 和 `GEMINI_API_MODEL_1`。

3. 從範本建立推送設定檔，填入 Bot Token 與頻道 ID，並把要推送的團體設為 `"enabled": true`：

   ```bash
   cp config/config.example.json config/config.json
   ```

4. 選用：設定 `ADMIN_BOT_TOKEN` 與 `OWNER_USER_ID` 以啟用[管理面板](#管理面板)。

5. 啟動：

   ```bash
   npm start
   ```

   或使用 pm2 執行：

   ```bash
   pm2 start index.js --name "zakamichi-blog-bot" -o ./logs/out.log -e ./logs/error.log --log-date-format "YYYY-MM-DD HH:mm:ss Z"
   ```

Bot 必須是每個目標頻道的管理員，並具有發送訊息的權限。

## 執行時段

程式啟動時會先執行一次，之後每 `POLLING_INTERVAL_MS` 秒執行一次（預設 900 秒）。以下時間皆為日本時間（JST）。
若上一輪尚未結束，下一輪會直接略過。

| 時間（JST） | 執行內容 |
| --- | --- |
| 每一輪 | 重試推送佇列中等待中的文章 |
| 08:00 – 23:59 | 爬取日向坂46、櫻坂46、乃木坂46，將新文章翻譯進存檔後再推送 |
| 10:00 – 10:59 | 額外爬取僕が見たかった青空（Bokuao） |
| 00:00 – 07:59 | 補翻譯：把已存檔的 HTML 翻譯到 `blogContent_TC/`，由新到舊，直到用完每日額度（需設定 `ENABLE_TRANSLATION=true`） |
| UTC 00:00（JST 09:00） | 重設每日補翻譯額度 |

## 處理流程

```
爬蟲 → blogContent/<團體>/<id>.html             （成員關閉存檔時略過）
     → archive-translation.js  將新文章翻譯到 blogContent_TC/<團體>/<id>.html 與 .json
     → blog-content.js     將 HTML 解析為依序排列的文字／圖片／影片區塊
     → broadcaster.js      直接沿用存檔中的翻譯（不再發出新的 AI 請求）；
                           只有在沒有可用存檔時才呼叫 translate.js
     → message-builder.js  組成標頭／內文／頁尾，並依 Telegram 長度限制分段
     → telegram.js         發送相簿與後續文字訊息
     → record/<團體>/BroadcastStatus.JSON       （發送失敗或暫停中的文章 → 推送佇列）
```

## 專案結構

```
index.js                     排程：輪詢週期、補翻譯、佇列重試
config/
  constants.js               環境變數、路徑、各團體網址、成員名單
  channels.js                讀取 config/config.json 與管理面板設定，決定推送目標
  config.example.json        推送設定範本（納入版本控制）
  config.json                你的推送設定（已加入 .gitignore，內含 Bot Token）
crawlers/                    各團體的爬蟲，皆繼承自 base.js
services/
  blog-content.js            HTML → 依序排列的區塊；辨識圖片說明
  translate.js               Gemini 翻譯
  archive-translation.js     存檔時翻譯，並在推送時讀回翻譯存檔
  message-builder.js         Telegram 圖片說明與訊息
  telegram.js                Bot API 用戶端
  broadcaster.js             翻譯 → 排版 → 發送，記錄推送結果並重試佇列
  broadcast-queue.js         等待推送的文章
  backfill.js                依額度補翻譯存檔、文章索引、統計
  admin-state.js             管理面板狀態：開關、額度、成員設定
  scheduler.js               UTC 00:00 重設額度
  admin/
    auth.js                  僅限擁有者的檢查與頻率限制
    views.js                 管理面板畫面與內嵌按鈕
    bot.js                   長輪詢、按鈕處理、頻道 ID 輸入
utils/                       HTTP、檔案系統、日期解析等工具
blogContent/                 各團體的原始文章 HTML
blogContent_TC/              翻譯版文章 HTML（另有 <id>.json 存放翻譯後標題），
                             由存檔時翻譯與補翻譯寫入
record/                      各團體的 BlogStatus.JSON／BroadcastStatus.JSON、
                             admin-state.json、broadcast-queue.json
```

## 訊息格式

參照 `zakamichi-message-bot`：

```
👤 #金村美玖 #Hinatazaka46            ← 標頭：作者、標題、發布時間
📝 <b>翻譯後的標題</b>
   <i>元のタイトル</i>
🕒 2026/09/03 20:15 JST

翻譯後的內文…                        ← 內文：翻譯後的文字
🖼 [1]                               ← 標示每張照片在文中的位置
📷 圖片說明

🔗 原文 / Original Post              ← 頁尾：原文連結、圖片數量、頻道署名
🖼 3 張圖片
📣 @my_channel
```

排版好的說明文字會放在**第一組相簿的第一個項目**上。如果文章超過 Telegram 圖片說明的 1024 字元上限，
相簿只保留標頭（放得下時也包含頁尾），內文則以最多 4096 字元的獨立訊息接續發送。分段時不會把 HTML 標籤切成兩半。

## 管理面板

一個只回應你的 Telegram Bot。在私訊中傳送 `/admin` 即可開啟管理面板。

### 設定

1. 透過 [@BotFather](https://t.me/BotFather) 建立 Bot（也可沿用推送用的 Bot），把 Token 填入 `ADMIN_BOT_TOKEN`。
2. 取得你的 Telegram 數字使用者 ID（例如私訊 [@userinfobot](https://t.me/userinfobot)），填入 `OWNER_USER_ID`。
3. 重新啟動程式，與 Bot 開啟私訊並傳送 `/admin`。

管理面板使用長輪詢，不需要 Webhook 或對外開放連接埠。如果該 Bot 已設定 Webhook，Telegram 會拒絕輪詢，
記錄檔中會顯示原因；請先移除 Webhook。

### 安全性

- 只處理 `OWNER_USER_ID` **在與 Bot 的私訊中**傳送的訊息與按下的按鈕。
- 其他一律直接丟棄，不做任何回應。其他使用者、群組（即使是你本人在群組中輸入）、頻道與 inline 查詢
  都不會收到回覆、錯誤訊息或按鈕回應，Bot 不會洩漏任何資訊。
- 你自己的操作也有頻率限制（最多連續 20 次，每分鐘補充 30 次），且同一時間只能執行一個手動推送。

### 選單

```
🛠 管理面板
├─ 📊 狀態              已翻譯／待翻譯數量（依團體與成員）、額度、佇列
├─ 👥 成員              選擇團體 → 成員清單 → 成員
│   ├─ 🚫 封鎖整個團體的翻譯      （成員清單下方的按鈕）
│   ├─ 🚫 翻譯 封鎖／允許          （個別成員）
│   ├─ 🌐 自動翻譯 開／關
│   ├─ 📦 存檔／備份 開／關
│   ├─ 📡 設定推送目標          （回覆頻道 ID；「-」清除；/cancel 取消）
│   └─ 🧹 清除推送目標          （改回使用 config.json 的設定）
├─ 📰 最新文章          團體 → 成員（依最新文章排序）→ 該成員的文章 → 選擇聊天室 → 發送
├─ 🧮 額度              調整每日上限（±1／±10）、重設今日用量
├─ ⏸ 暫停／▶️ 繼續 翻譯
└─ ⏸ 暫停／▶️ 繼續 推送
```

### 各開關的作用

| 開關 | 關閉／暫停時 |
| --- | --- |
| **翻譯**（全域） | 新文章存檔時不翻譯、停止補翻譯；即時推送改發日文原文。 |
| **推送**（全域） | 新文章進入推送佇列等待。恢復後會立即由舊到新發送。 |
| **翻譯封鎖**（團體或成員） | 完全不翻譯：存檔時、補翻譯、推送與手動推送都不翻譯。比關閉自動翻譯更嚴格。 |
| **自動翻譯**（成員） | 該成員的文章存檔時不翻譯、以日文原文推送，並且不列入補翻譯；手動推送仍會翻譯。 |
| **存檔／備份**（成員） | 新文章不會存到 `blogContent/`，也不列入補翻譯；但仍會記錄在 `BlogStatus.JSON` 並照常推送。 |
| **推送目標**（成員） | 設定後會取代該成員在 `config.json` 中的推送設定；團體與分類的推送仍然有效。即使團體在 `config.json` 中為停用狀態也會生效。 |

推送目標可以是數字 ID（`-1001234567890`）或公開帳號（`@my_channel`）。發送時使用 `config.json` 中該成員的 Bot，
若沒有則使用團體的 Bot，再沒有則使用管理面板的 Bot。該 Bot 必須是目標聊天室的管理員。

### 手動推送

從**最新文章**（團體 → 成員 → 文章）開啟一篇文章，再點選一個聊天室，就會以翻譯版發送過去；若已有翻譯存檔則直接沿用，不會再發出新的 AI 請求。⭐ 表示該文章依推送規則會送達的聊天室，
**My DM (preview)** 則會發送給你自己。手動推送不受兩個暫停開關與成員自動翻譯設定影響（但翻譯封鎖仍然有效），不佔用額度，
也不會寫入 `BroadcastStatus.JSON`，因此同一篇文章可以重複發送。沒有存檔 HTML 的文章（標示為 ∅）無法發送。

## 存檔時翻譯

爬蟲發現新文章並存檔到 `blogContent/` 後，會立即翻譯到 `blogContent_TC/<團體>/<id>.html`，翻譯後的標題存於
`<id>.json`。標題與內文只用一次 Gemini 請求。這一步在推送之前執行，因此推送時直接沿用翻譯存檔，不再發出新的 AI 請求。

- 以下情況略過：成員關閉存檔或自動翻譯、團體或成員被封鎖翻譯、翻譯已暫停，以及發布超過
  `ARCHIVE_TRANSLATE_MAX_AGE_HOURS`（預設 72 小時）的文章。因此第一次爬取空的存檔時，舊文章會交給有額度限制的補翻譯處理。
- 不佔用補翻譯額度；翻譯失敗的文章之後由補翻譯重試。
- 設定 `TRANSLATE_ON_ARCHIVE=false` 可關閉此功能。

只有在沒有翻譯存檔、存檔的 `target_language` 與聊天室要求不同，或存檔與原文的文字／圖片結構對不上時，推送才會重新翻譯。

## 補翻譯與每日額度

補翻譯會把 `blogContent/` 中較舊的已存檔 HTML 翻譯到 `blogContent_TC/`（格式與存檔時翻譯相同）：

- **由新到舊。** 依發布時間倒序處理。沒有日期的文章（有 HTML 但 `BlogStatus.JSON` 中沒有紀錄）排在最後。
- **每日額度。** 每個 UTC 日最多嘗試 `dailyLimit` 次；每次嘗試都會計入，失敗也一樣。
  計數會在 UTC 00:00 重設：由計時器觸發，且每次讀取額度時也會檢查，因此重新啟動或電腦休眠都不會把用量帶到隔天。
- **略過：** 關閉自動翻譯或存檔的成員的文章、被封鎖翻譯的團體與成員，以及失敗 3 次的文章。
- **停止條件：** 額度用完、翻譯已暫停，或到了 JST 08:00 的輪詢時段。

狀態畫面中的「已翻譯」指的是 `blogContent_TC/` 中已有翻譯檔；「待翻譯」指的是有存檔 HTML 但尚未翻譯。

## 設定

頻道與翻譯設定都寫在 `config/config.json`，完整範本請見 `config/config.example.json`。
檔案在磁碟上變更時會**自動重新載入**，因此新增、更改或關閉頻道都不需要重新啟動或修改程式碼。
如果修改後 JSON 格式有誤，程式會記錄錯誤並繼續使用上一份有效的設定。

`config/config.json` 內含 Bot Token，已加入 .gitignore；`config/config.example.json` 則納入版本控制。
在管理面板中變更的設定另外存放在 `record/admin-state.json`（請見[管理面板狀態](#管理面板狀態)），並疊加在 `config.json` 之上。

### 結構

```jsonc
{
  "version": 1,
  "defaults": {                    // 套用到所有團體，可在各團體中覆寫
    "enabled": true,               // 所有推送的總開關
    "translation": { … },
    "message": { … }
  },
  "groups": [
    {
      "name": "Hinatazaka46",      // 必須與爬蟲的團體名稱相同
      "display_name": "日向坂46",
      "enabled": true,
      "telegram_bot_token": "…",   // 整個團體共用的 Bot
      "telegram_chat_id": ["-1001234567890", "@my_channel"],
      "translate_glossary": { "こさかな": "小坂菜緒" },
      "translation": { … },        // 覆寫 defaults.translation
      "message": { … },            // 覆寫 defaults.message

      "members": [                 // 個別成員的推送目標與設定
        {
          "name": "金村美玖",
          "enabled": true,
          "telegram_chat_id": ["@miku_osushi"],
          "telegram_bot_token": "…",   // 選填；未填時使用團體的 Bot
          "translation": { "enabled": false }
        }
      ],

      "categories": [              // 依標題或成員分類推送
        {
          "name": "五期生リレー",
          "enabled": true,
          "match": {
            "title_contains": ["リレー"],
            "member_in": ["大野愛実"],
            "title_matches": ["^\\d+期生"]
          },
          "telegram_chat_id": ["-1009876543210"]
        }
      ]
    }
  ]
}
```

團體名稱為 `Hinatazaka46`、`Sakurazaka46`、`Nogizaka46` 與 `Bokuao`。比對成員名稱時會去除空白，
因此 `山口 陽世` 與 `山口陽世` 視為同一人。

分類中設定的每個條件都必須符合。沒有設定任何條件的分類永遠不會符合，以免意外收到所有文章。

### `translation` 翻譯設定

| 欄位 | 預設值 | 說明 |
| --- | --- | --- |
| `enabled` | `true` | 是否翻譯；設為 `false` 時推送日文原文 |
| `thinking_level` | `"middle"` | Gemini 推理預算：`low` \| `middle` \| `high` |
| `target_language` | `"Traditional Chinese (Taiwan)"` | 提示詞中指定的目標語言 |
| `translate_title` | `true` | 翻譯文章標題 |
| `translate_body` | `true` | 翻譯內文 |
| `translate_image_captions` | `true` | 翻譯圖片之間的簡短文字 |

團體的 `target_language`、`thinking_level` 與詞彙表也會套用到補翻譯。

### `message` 訊息設定

| 欄位 | 預設值 | 說明 |
| --- | --- | --- |
| `parse_mode` | `"HTML"` | Telegram 解析模式 |
| `show_original` | `false` | 在每段譯文下方以 `---------` 分隔線附上日文原文 |
| `show_footer` | `true` | 顯示原文連結、圖片數量與頻道署名 |
| `show_image_markers` | `true` | 在文中插入 `🖼 [n]` 標示每張照片的位置 |
| `show_group_tag` | `true` | 在標頭的成員標籤旁加上團體標籤 |
| `attribution` | `""` | 頁尾的頻道署名 |
| `max_media_per_group` | `10` | 每組相簿的數量（Telegram 上限為 10） |
| `send_media` | `true` | 設為 `false` 時只發送文字 |

### 推送規則

每篇文章依序比對管理面板設定的推送目標、成員清單、分類清單，最後是團體共用頻道。所有符合的目標會合併，
並以 Bot Token + 頻道 ID 去除重複，因此同一個頻道不會收到同一篇文章兩次。在 `config.json` 中設為
`"enabled": false` 的成員，在 `config.json` 設定的所有頻道都不會推送；管理面板設定的目標仍然有效。
每個頻道使用其來源規則的翻譯與訊息設定；同一個頻道出現在多個規則時，優先順序為管理面板／成員 > 分類 > 團體預設。

### 推送紀錄與重試

推送紀錄依團體儲存在 `record/<團體>/BroadcastStatus.JSON`，以文章 ID + 頻道 ID 為鍵。
重新啟動後不會重複發送，新加入的頻道只會收到之後的新文章。

只要有任一目標發送失敗，或推送處於暫停狀態，文章就會進入 `record/broadcast-queue.json`。
佇列會在每一輪開始時以及恢復推送時重試，且只發送給尚未收到的聊天室。重試 5 次仍失敗的文章會被移除並記錄在記錄檔中。

### 管理面板狀態

`record/admin-state.json` 由管理面板寫入。程式停止時也可以手動編輯。

```jsonc
{
  "version": 1,
  "flags": { "translationPaused": false, "broadcastPaused": false },
  "quota": { "dailyLimit": 50, "date": "2026-10-25", "used": 12 },   // date 為 UTC 日期
  "members": {
    // 只記錄與預設值（全部開啟、無推送目標）不同的成員
    "Hinatazaka46/金村美玖": { "autoTranslate": false, "archive": true, "translationBlocked": false, "chatIds": ["-1001234567890"] }
  },
  "blockedGroups": ["Bokuao"],                        // 封鎖翻譯的團體
  "backfillFailures": { "Hinatazaka46/104023": 1 }   // 失敗 3 次後略過
}
```

## 環境變數

| 變數 | 用途 |
| --- | --- |
| `POLLING_INTERVAL_MS` | 執行間隔，單位是**秒**（雖然名稱是 MS），預設 `900` |
| `ENABLE_TRANSLATION` | 設為 `true` 時啟用夜間補翻譯，輸出到 `blogContent_TC/` |
| `TRANSLATE_ON_ARCHIVE` | 設為 `false` 時，新文章存檔時不再立即翻譯（預設開啟） |
| `ARCHIVE_TRANSLATE_MAX_AGE_HOURS` | 只有發布時間在此時數內的文章會在存檔時翻譯（預設 `72`） |
| `ENABLE_BROADCAST` | 設為 `false` 時關閉所有 Telegram 推送（預設開啟） |
| `CONFIG_FILE_NAME` | 推送設定檔路徑（預設 `config/config.json`） |
| `ADMIN_BOT_TOKEN` | 提供管理面板的 Bot Token |
| `OWNER_USER_ID` | 你的 Telegram 數字使用者 ID；管理面板只回應這個帳號 |
| `DAILY_TRANSLATION_QUOTA` | 每日補翻譯上限的初始值（預設 `50`）。`record/admin-state.json` 建立後改用其中儲存的上限，請在管理面板中調整 |
| `BOKUAO_COOKIE` | 僕が見たかった青空部落格的登入 Cookie |
| `GEMINI_API_KEY`、`GEMINI_API_MODEL_1..3` | Gemini 翻譯；依序嘗試各模型，發生錯誤時改用下一個 |
