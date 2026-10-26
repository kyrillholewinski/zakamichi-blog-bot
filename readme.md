# zakamichi-blog-bot

**English** | [繁體中文](readme.zh-TW.md)

Crawls Zakamichi group blogs (Sakurazaka46, Hinatazaka46, Nogizaka46, Bokuao), translates each
new post, and broadcasts it to Telegram channels using the caption layout of `zakamichi-message-bot`.
An owner-only admin panel in Telegram controls routing, translation and broadcasting while it runs.

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` in the project root (see [Environment](#environment)). At minimum, set
   `GEMINI_API_KEY` and `GEMINI_API_MODEL_1`.

3. Create the broadcast config from the template, then fill in bot tokens and chat ids and set the
   groups you want to `"enabled": true`:

   ```bash
   cp config/config.example.json config/config.json
   ```

4. Optional: enable the [admin panel](#admin-panel) by setting `ADMIN_BOT_TOKEN` and `OWNER_USER_ID`.

5. Start the bot:

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
A cycle that is still running when the next one is due makes the next one skip.

| Time (JST) | What runs |
| --- | --- |
| Every cycle | Retry posts waiting in the broadcast queue |
| 08:00 – 23:59 | Crawl Hinatazaka46, Sakurazaka46 and Nogizaka46, translate new posts into the archive, then broadcast them |
| 10:00 – 10:59 | Bokuao is also crawled |
| 00:00 – 07:59 | Backfill: translate archived HTML into `blogContent_TC/`, newest first, up to the daily quota (only when `ENABLE_TRANSLATION=true`) |
| 00:00 UTC (09:00 JST) | The daily backfill quota resets |

## Pipeline

```
crawler → blogContent/<Group>/<id>.html          (skipped when archiving is off for the member)
        → archive-translation.js  translate the new post into blogContent_TC/<Group>/<id>.html + .json
        → blog-content.js     parse HTML into ordered text/image/video blocks
        → broadcaster.js      reuse the archived translation (no new AI request);
                              translate.js only runs when there is no usable archive
        → message-builder.js  format header / body / footer, split for Telegram limits
        → telegram.js         send albums + follow-up messages
        → record/<Group>/BroadcastStatus.JSON    (failures and paused posts → broadcast queue)
```

## Project layout

```
index.js                     scheduler: polling cycle, backfill, queue retries
config/
  constants.js               environment variables, paths, group URLs, member lists
  channels.js                loads config/config.json + admin overrides, resolves destinations
  config.example.json        broadcast config template (committed)
  config.json                your broadcast config (gitignored, holds bot tokens)
crawlers/                    one crawler per group, built on base.js
services/
  blog-content.js            HTML → ordered blocks; detects image captions
  translate.js               Gemini translation
  archive-translation.js     translate-on-archive, reading the translated archive back for broadcasts
  message-builder.js         Telegram captions and messages
  telegram.js                Bot API client
  broadcaster.js             translate → format → send, delivery records, queue retries
  broadcast-queue.js         posts waiting to be broadcast
  backfill.js                quota-limited archive translation, blog index, statistics
  admin-state.js             admin panel state: flags, quota, member overrides
  scheduler.js               00:00 UTC quota reset
  admin/
    auth.js                  owner-only guard and rate limiter
    views.js                 admin panel screens and inline keyboards
    bot.js                   long polling, button handling, chat-id input
utils/                       HTTP, file system, date parsing helpers
blogContent/                 raw article HTML per group
blogContent_TC/              translated article HTML (+ <id>.json with the translated title),
                             written on archiving and by the backfill
record/                      per-group BlogStatus.JSON / BroadcastStatus.JSON,
                             admin-state.json, broadcast-queue.json
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

## Admin panel

A Telegram bot that only answers you. Send `/admin` to it in a private chat to open the dashboard.

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (or reuse one of your broadcast bots) and put
   its token in `ADMIN_BOT_TOKEN`.
2. Find your numeric Telegram user id (for example by messaging [@userinfobot](https://t.me/userinfobot))
   and put it in `OWNER_USER_ID`.
3. Restart, open a private chat with the bot, and send `/admin`.

The panel uses long polling, so no webhook or open port is needed. If the bot has a webhook set,
Telegram refuses polling and the log says so; remove the webhook first.

### Security

- Only messages and button presses from `OWNER_USER_ID` **in a private chat with the bot** are handled.
- Everything else is dropped silently. Other users, groups (even if you are the one typing there),
  channels and inline queries get no reply, no error and no button acknowledgement, so the bot reveals
  nothing.
- Your own actions are rate limited (bursts of 20, refilling at 30 per minute), and only one manual
  send can run at a time.

### Menu

```
🛠 Admin Panel
├─ 📊 Status            translated / pending counts, per group and per member, quota, queue
├─ 👥 Members           pick a group → member list → member
│   ├─ 🚫 Block translation for this group   (button under the member list)
│   ├─ 🚫 Translation blocked / allowed       (per member)
│   ├─ 🌐 Auto-translate on/off
│   ├─ 📦 Archive / backup on/off
│   ├─ 📡 Set target chats      (reply with ids, "-" to clear, /cancel to abort)
│   └─ 🧹 Clear targets         (back to config.json routing)
├─ 📰 Recent blogs      group → members (latest post first) → member's posts → pick a chat → send
├─ 🧮 Quota             change the daily limit (±1 / ±10), reset today's usage
├─ ⏸ Pause / ▶️ Resume translation
└─ ⏸ Pause / ▶️ Resume broadcasting
```

### What the switches do

| Switch | When off / paused |
| --- | --- |
| **Translation** (global) | New posts are not translated on archiving, the backfill stops, and live broadcasts go out in Japanese. |
| **Broadcasting** (global) | New posts wait in the broadcast queue. Resuming sends them right away, oldest first. |
| **Translation block** (group or member) | Never translated: not on archiving, not by the backfill, not when broadcasting, and not by manual sends. Stronger than auto-translate off. |
| **Auto-translate** (member) | The member's posts are not translated on archiving, are broadcast in Japanese and are skipped by the backfill. Manual sends still translate. |
| **Archive / backup** (member) | New posts are not saved to `blogContent/` and are skipped by the backfill. They are still recorded in `BlogStatus.JSON` and still broadcast. |
| **Target chats** (member) | Set: they replace the member's `config.json` route. Group and category routes still apply. They work even when the group is disabled in `config.json`. |

Target chats are numeric ids (`-1001234567890`) or public usernames (`@my_channel`). They are posted with
the member's bot from `config.json`, falling back to the group bot and then to the admin bot. That bot
must be an admin of the chat.

### Manual send

Open a post from **Recent blogs** (group → member → post) and tap a chat. The post is sent there in
translation, reusing the translated archive when it exists so no new AI request is made. ⭐ marks
the chats its routing would use, and **My DM (preview)** sends it to you. Manual sends ignore both pause
switches and the member's auto-translate setting (but not a translation block), do not use the quota, and are not recorded in
`BroadcastStatus.JSON`, so you can send the same post again. Posts without saved HTML (shown as ∅)
cannot be sent.

## Translation on archiving

When the crawler finds a new post and archives it to `blogContent/`, it translates it right away into
`blogContent_TC/<Group>/<id>.html`, with the translated title in `<id>.json`. Title and body go out in
a single Gemini request. This runs before the broadcast, so the broadcaster reuses the archived
translation instead of making its own AI request.

- Skipped for members with archiving or auto-translate off, a blocked group or member, while
  translation is paused, and for posts older than `ARCHIVE_TRANSLATE_MAX_AGE_HOURS` (default 72), so a
  first crawl into an empty archive leaves the old backlog to the quota-limited backfill.
- Does not use the backfill quota. A failed post is retried later by the backfill.
- `TRANSLATE_ON_ARCHIVE=false` turns it off.

The broadcaster falls back to a fresh translation only when the archive is missing, is in a different
`target_language` than the chat wants, or no longer lines up with the original's text/image layout.

## Backfill and daily quota

The backfill translates older archived HTML from `blogContent/` into `blogContent_TC/` (same format as
translation on archiving):

- **Newest first.** Posts are processed in reverse chronological order. Posts with no date (HTML without
  a `BlogStatus.JSON` record) come last.
- **Daily quota.** At most `dailyLimit` attempts per UTC day; each attempt counts, including failures.
  The counter resets at 00:00 UTC, both from a timer and whenever the quota is read, so a restart or a
  sleeping machine never carries usage into the next day.
- **Skips:** posts of members with auto-translate or archiving off, blocked groups and members, and
  posts that failed 3 times.
- **Stops** when the quota runs out, translation is paused, or the 08:00 JST polling window opens.

"Translated" in the status view means a `blogContent_TC/` copy exists. "Pending" means saved HTML
without one.

## Configuration

Channels and translation settings live in `config/config.json`. `config/config.example.json` is a
full template. The file is **hot-reloaded** whenever it changes on disk, so you can add, retarget or
switch off channels without restarting or changing code. If an edit leaves the JSON invalid, the
error is logged and the last valid config stays in use.

`config/config.json` holds bot tokens and is gitignored. `config/config.example.json` is committed.
Settings changed in the admin panel are stored separately in `record/admin-state.json`
(see [Admin state](#admin-state)) and layered on top of `config.json`.

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
| `thinking_level` | `"middle"` | Gemini reasoning budget: `low` \| `middle` \| `high` |
| `target_language` | `"Traditional Chinese (Taiwan)"` | Target language named in the prompt |
| `translate_title` | `true` | Translate the post title |
| `translate_body` | `true` | Translate body text |
| `translate_image_captions` | `true` | Translate short text between images |

The group's `target_language`, `thinking_level` and glossary also apply to the backfill.

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

Each post is checked against target chats set in the admin panel, the member list, the category list,
then the group-wide channels. All matches are combined and de-duplicated by bot token + chat id, so a
channel never receives the same post twice. A member with `"enabled": false` in `config.json` is muted
everywhere `config.json` routes it; admin-panel targets still apply. Each channel uses the translation
and message settings of the route it came from. If the same channel appears in more than one route,
the admin/member route wins over a category, and a category wins over the group default.

### Delivery and retries

Deliveries are recorded per group in `record/<Group>/BroadcastStatus.JSON`, keyed by blog id + chat
id. After a restart nothing is sent again, and a newly added channel only receives future posts.

If any destination fails, or broadcasting is paused, the post goes into `record/broadcast-queue.json`.
The queue is retried at the start of every cycle and when broadcasting is resumed. Only the chats
that missed the post receive it. A post that still fails after 5 retries is dropped and logged.

### Admin state

`record/admin-state.json` is written by the admin panel. You can edit it by hand while the bot is stopped.

```jsonc
{
  "version": 1,
  "flags": { "translationPaused": false, "broadcastPaused": false },
  "quota": { "dailyLimit": 50, "date": "2026-10-25", "used": 12 },   // date is the UTC day
  "members": {
    // only members whose settings differ from the defaults (all on, no targets)
    "Hinatazaka46/金村美玖": { "autoTranslate": false, "archive": true, "translationBlocked": false, "chatIds": ["-1001234567890"] }
  },
  "blockedGroups": ["Bokuao"],                        // groups whose translation is blocked
  "backfillFailures": { "Hinatazaka46/104023": 1 }   // posts are skipped after 3
}
```

## Environment

| Variable | Purpose |
| --- | --- |
| `POLLING_INTERVAL_MS` | Cycle interval in **seconds**, despite the name (default `900`) |
| `ENABLE_TRANSLATION` | `true` enables the overnight backfill into `blogContent_TC/` |
| `TRANSLATE_ON_ARCHIVE` | `false` stops translating new posts as they are archived (default on) |
| `ARCHIVE_TRANSLATE_MAX_AGE_HOURS` | Only posts younger than this are translated on archiving (default `72`) |
| `ENABLE_BROADCAST` | `false` turns off all Telegram broadcasting (default on) |
| `CONFIG_FILE_NAME` | Path to the broadcast config (default `config/config.json`) |
| `ADMIN_BOT_TOKEN` | Token of the bot that serves the admin panel |
| `OWNER_USER_ID` | Your numeric Telegram user id; the only account the admin panel answers |
| `DAILY_TRANSLATION_QUOTA` | Starting daily backfill limit (default `50`). Once `record/admin-state.json` exists, the limit stored there is used; change it from the admin panel |
| `BOKUAO_COOKIE` | Session cookie for the Bokuao blog |
| `GEMINI_API_KEY`, `GEMINI_API_MODEL_1..3` | Gemini translation; models are tried in order, falling back to the next on errors |
