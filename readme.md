# zakamichi-blog-bot

**English** | [繁體中文](readme.zh-TW.md)

Crawls Zakamichi group blogs (Sakurazaka46, Hinatazaka46, Nogizaka46, Bokuao), translates each
new post, and broadcasts it to Telegram channels using the caption layout of `zakamichi-message-bot`.

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` in the project root (see [Environment](#environment)). At minimum, set a translation
   provider key, for example `GEMINI_API_KEY` and `GEMINI_API_MODEL_1`.

3. Create the broadcast config from the template, then fill in bot tokens and chat ids and set the
   groups you want to `"enabled": true`:

   ```bash
   cp config/config.example.json config/config.json
   ```

4. Start the bot:

   ```bash
   npm start
   ```

   Or run it under pm2:

   ```bash
   pm2 start index.js --name "zakamichi-blog-bot" -o ./logs/out.log -e ./logs/error.log --log-date-format "YYYY-MM-DD HH:mm:ss Z"
   ```

The bot needs to be an admin of each target channel with permission to post messages.

## Schedule

The cycle runs once at startup, then every `POLLING_INTERVAL_MS` seconds (default 900). Times are JST.

| Time (JST) | What runs |
| --- | --- |
| 08:00 – 23:59 | Crawl Hinatazaka46, Sakurazaka46 and Nogizaka46, then broadcast new posts |
| 10:00 – 10:59 | Bokuao is also crawled |
| 00:00 – 07:59 | Overnight pass: translate saved HTML into `blogContent_TC/` (only when `ENABLE_TRANSLATION=true`) |

## Pipeline

```
crawler → blogContent/<Group>/<id>.html
        → blog-content.js     parse HTML into ordered text/image/video blocks
        → translate.js        translate title + body + image captions
        → message-builder.js  format header / body / footer, split for Telegram limits
        → telegram.js         send albums + follow-up messages
        → record/<Group>/BroadcastStatus.JSON
```

## Project layout

```
index.js                     scheduler: polling cycle and overnight translation pass
config/
  constants.js               environment variables, paths, group URLs, member lists
  channels.js                loads config/config.json and resolves destinations
  config.example.json        broadcast config template (committed)
  config.json                your broadcast config (gitignored, holds bot tokens)
crawlers/                    one crawler per group, built on base.js
services/
  blog-content.js            HTML → ordered blocks; detects image captions
  translate.js               Gemini / Claude / OpenAI translation
  message-builder.js         Telegram captions and messages
  telegram.js                Bot API client
  broadcaster.js             translate → format → send, records deliveries
utils/                       HTTP, file system, date parsing helpers
blogContent/                 raw article HTML per group
blogContent_TC/              translated article HTML from the overnight pass
record/                      BlogStatus.JSON and BroadcastStatus.JSON per group
```

## Message layout

Modelled on `zakamichi-message-bot`:

```
👤 #金村美玖 #Hinatazaka46            ← header: author, title, publication time
📝 <b>翻譯後的標題</b>
   <i>元のタイトル</i>
🕒 2026/09/03 20:15 JST

翻譯後的內文…                        ← body: translated text
🖼 [1]                               ← marks where each photo sits
📷 圖片說明

🔗 原文 / Original Post              ← footer: source link, media count, attribution
🖼 3 張圖片
📣 @my_channel
```

The formatted caption goes on the **first item of the first media group**. If the post is longer
than Telegram's 1024-character caption limit, the album keeps the header (and the footer if it
fits), and the body follows as separate messages of up to 4096 characters. Splits never cut an
HTML tag in half.

## Configuration

Channels and translation settings live in `config/config.json`. `config/config.example.json` is a
full template. The file is **hot-reloaded** whenever it changes on disk, so you can add, retarget or
switch off channels without restarting or changing code. If an edit leaves the JSON invalid, the
error is logged and the last valid config stays in use.

`config/config.json` holds bot tokens and is gitignored. `config/config.example.json` is committed.

### Schema

```jsonc
{
  "version": 1,
  "defaults": {                    // applied to every group unless overridden
    "enabled": true,               // master switch for all broadcasting
    "translation": { … },
    "message": { … }
  },
  "groups": [
    {
      "name": "Hinatazaka46",      // must match the crawler group name
      "display_name": "日向坂46",
      "enabled": true,
      "telegram_bot_token": "…",   // group-wide bot
      "telegram_chat_id": ["-1001234567890", "@my_channel"],
      "translate_glossary": { "こさかな": "小坂菜緒" },
      "translation": { … },        // overrides defaults.translation
      "message": { … },            // overrides defaults.message

      "members": [                 // per-member routing and overrides
        {
          "name": "金村美玖",
          "enabled": true,
          "telegram_chat_id": ["@miku_osushi"],
          "telegram_bot_token": "…",   // optional; falls back to the group bot
          "translation": { "enabled": false }
        }
      ],

      "categories": [              // route posts by title or member
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

Group names are `Hinatazaka46`, `Sakurazaka46`, `Nogizaka46` and `Bokuao`. Member names are matched
with whitespace removed, so `山口 陽世` and `山口陽世` are the same member.

In a category, every criterion you set must match. A category with no criteria never matches, so it
cannot accidentally receive every post.

### `translation` settings

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Translate the post; `false` broadcasts the original Japanese |
| `provider` | `"gemini"` | `gemini` \| `claude` \| `openai` |
| `thinking_level` | `"middle"` | Gemini reasoning budget: `low` \| `middle` \| `high` |
| `target_language` | `"Traditional Chinese (Taiwan)"` | Target language named in the prompt |
| `translate_title` | `true` | Translate the post title |
| `translate_body` | `true` | Translate body text |
| `translate_image_captions` | `true` | Translate short text between images |

### `message` settings

| Key | Default | Meaning |
| --- | --- | --- |
| `parse_mode` | `"HTML"` | Telegram parse mode |
| `show_original` | `false` | Add the Japanese under each translated block, after a `---------` line |
| `show_footer` | `true` | Show the source link, image count and attribution |
| `show_image_markers` | `true` | Insert `🖼 [n]` where each photo sits in the text |
| `show_group_tag` | `true` | Add the group hashtag next to the member hashtag in the header |
| `attribution` | `""` | Channel credit line in the footer |
| `max_media_per_group` | `10` | Album size (Telegram allows at most 10) |
| `send_media` | `true` | `false` sends text only |

### Routing

Each post is checked against the member list, then the category list, then the group-wide channels.
All matches are combined and de-duplicated by bot token + chat id, so a channel never receives the
same post twice. A member with `"enabled": false` is muted everywhere. Each channel uses the
translation and message settings of the route it came from. If the same channel appears in more than
one route, the member route wins over a category, and a category wins over the group default.

Deliveries are recorded per group in `record/<Group>/BroadcastStatus.JSON`, keyed by blog id + chat
id. After a restart nothing is sent again, and a newly added channel only receives future posts.

## Environment

| Variable | Purpose |
| --- | --- |
| `POLLING_INTERVAL_MS` | Cycle interval in **seconds**, despite the name (default `900`) |
| `ENABLE_TRANSLATION` | `true` enables the overnight `blogContent_TC` HTML translation pass |
| `ENABLE_BROADCAST` | `false` turns off all Telegram broadcasting (default on) |
| `CONFIG_FILE_NAME` | Path to the broadcast config (default `config/config.json`) |
| `BOKUAO_COOKIE` | Session cookie for the Bokuao blog |
| `GEMINI_API_KEY`, `GEMINI_API_MODEL_1..3` | Gemini translation; models are tried in order |
| `CLAUDE_API_KEY`, `CLAUDE_API_MODEL` | Claude translation |
| `OPENAI_API_KEY`, `OPENAI_API_MODEL` | OpenAI translation |
