# zakamichi-blog-bot

[English](readme.md) | **繁體中文**

爬取坂道系列團體的部落格（櫻坂46、日向坂46、乃木坂46、僕が見たかった青空），翻譯每一篇新文章，
並依照 `zakamichi-message-bot` 的訊息格式推送到 Telegram 頻道。

## 快速開始

1. 安裝相依套件：

   ```bash
   npm install
   ```

2. 在專案根目錄建立 `.env`（請參考[環境變數](#環境變數)）。至少需要設定一組翻譯服務的金鑰，
   例如 `GEMINI_API_KEY` 和 `GEMINI_API_MODEL_1`。

3. 從範本建立推送設定檔，填入 Bot Token 與頻道 ID，並把要推送的團體設為 `"enabled": true`：

   ```bash
   cp config/config.example.json config/config.json
   ```

4. 啟動：

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

| 時間（JST） | 執行內容 |
| --- | --- |
| 08:00 – 23:59 | 爬取日向坂46、櫻坂46、乃木坂46，並推送新文章 |
| 10:00 – 10:59 | 額外爬取僕が見たかった青空（Bokuao） |
| 00:00 – 07:59 | 夜間作業：把已儲存的 HTML 翻譯到 `blogContent_TC/`（需設定 `ENABLE_TRANSLATION=true`） |

## 處理流程

```
爬蟲 → blogContent/<團體>/<id>.html
     → blog-content.js     將 HTML 解析為依序排列的文字／圖片／影片區塊
     → translate.js        翻譯標題、內文與圖片說明
     → message-builder.js  組成標頭／內文／頁尾，並依 Telegram 長度限制分段
     → telegram.js         發送相簿與後續文字訊息
     → record/<團體>/BroadcastStatus.JSON
```

## 專案結構

```
index.js                     排程：輪詢週期與夜間翻譯作業
config/
  constants.js               環境變數、路徑、各團體網址、成員名單
  channels.js                讀取 config/config.json 並決定推送目標
  config.example.json        推送設定範本（納入版本控制）
  config.json                你的推送設定（已加入 .gitignore，內含 Bot Token）
crawlers/                    各團體的爬蟲，皆繼承自 base.js
services/
  blog-content.js            HTML → 依序排列的區塊；辨識圖片說明
  translate.js               Gemini／Claude／OpenAI 翻譯
  message-builder.js         Telegram 圖片說明與訊息
  telegram.js                Bot API 用戶端
  broadcaster.js             翻譯 → 排版 → 發送，並記錄已推送的文章
utils/                       HTTP、檔案系統、日期解析等工具
blogContent/                 各團體的原始文章 HTML
blogContent_TC/              夜間作業產生的翻譯版文章 HTML
record/                      各團體的 BlogStatus.JSON 與 BroadcastStatus.JSON
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

## 設定

頻道與翻譯設定都寫在 `config/config.json`，完整範本請見 `config/config.example.json`。
檔案在磁碟上變更時會**自動重新載入**，因此新增、更改或關閉頻道都不需要重新啟動或修改程式碼。
如果修改後 JSON 格式有誤，程式會記錄錯誤並繼續使用上一份有效的設定。

`config/config.json` 內含 Bot Token，已加入 .gitignore；`config/config.example.json` 則納入版本控制。

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
| `provider` | `"gemini"` | `gemini` \| `claude` \| `openai` |
| `thinking_level` | `"middle"` | Gemini 推理預算：`low` \| `middle` \| `high` |
| `target_language` | `"Traditional Chinese (Taiwan)"` | 提示詞中指定的目標語言 |
| `translate_title` | `true` | 翻譯文章標題 |
| `translate_body` | `true` | 翻譯內文 |
| `translate_image_captions` | `true` | 翻譯圖片之間的簡短文字 |

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

每篇文章依序比對成員清單、分類清單，最後是團體共用頻道。所有符合的目標會合併，並以 Bot Token + 頻道 ID 去除重複，
因此同一個頻道不會收到同一篇文章兩次。設為 `"enabled": false` 的成員在所有頻道都不會推送。
每個頻道使用其來源規則的翻譯與訊息設定；同一個頻道出現在多個規則時，優先順序為成員 > 分類 > 團體預設。

推送紀錄依團體儲存在 `record/<團體>/BroadcastStatus.JSON`，以文章 ID + 頻道 ID 為鍵。
重新啟動後不會重複發送，新加入的頻道只會收到之後的新文章。

## 環境變數

| 變數 | 用途 |
| --- | --- |
| `POLLING_INTERVAL_MS` | 執行間隔，單位是**秒**（雖然名稱是 MS），預設 `900` |
| `ENABLE_TRANSLATION` | 設為 `true` 時啟用夜間 `blogContent_TC` HTML 翻譯作業 |
| `ENABLE_BROADCAST` | 設為 `false` 時關閉所有 Telegram 推送（預設開啟） |
| `CONFIG_FILE_NAME` | 推送設定檔路徑（預設 `config/config.json`） |
| `BOKUAO_COOKIE` | 僕が見たかった青空部落格的登入 Cookie |
| `GEMINI_API_KEY`、`GEMINI_API_MODEL_1..3` | Gemini 翻譯；依序嘗試各模型 |
| `CLAUDE_API_KEY`、`CLAUDE_API_MODEL` | Claude 翻譯 |
| `OPENAI_API_KEY`、`OPENAI_API_MODEL` | OpenAI 翻譯 |
