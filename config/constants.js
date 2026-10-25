import path from 'path';

import { loadEnvFile } from 'node:process';
loadEnvFile();

export const POLLING_INTERVAL_MS = (parseInt(process.env.POLLING_INTERVAL_MS) || 900) * 1000;

export const BOKUAO_COOKIE = process.env.BOKUAO_COOKIE || '';

export const ENABLE_TRANSLATION = process.env.ENABLE_TRANSLATION === 'true';

// Master kill switch for Telegram broadcasting. Per-group/member/category toggles
// live in CONFIG_FILE_NAME so channels can be changed without touching code.
export const ENABLE_BROADCAST = process.env.ENABLE_BROADCAST !== 'false';

export const CONFIG_FILE_NAME = process.env.CONFIG_FILE_NAME || 'config/config.json';

// Admin panel. Both must be set for the panel to start; every update from any
// other Telegram user is dropped without a reply.
export const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '';
export const OWNER_USER_ID = (process.env.OWNER_USER_ID || '').trim();

// Starting value for the backfill translation quota; the admin panel can change it.
export const DAILY_TRANSLATION_QUOTA = parseInt(process.env.DAILY_TRANSLATION_QUOTA, 10) || 50;

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const GEMINI_API_MODEL_1 = process.env.GEMINI_API_MODEL_1;
export const GEMINI_API_MODEL_2 = process.env.GEMINI_API_MODEL_2;
export const GEMINI_API_MODEL_3 = process.env.GEMINI_API_MODEL_3;

export const PATHS = {
    EXPORT: 'Export',
    RECORD: 'record',
    BLOG_CONTENT: 'blogContent',
    BLOG_CONTENT_TC: 'blogContent_TC',
    BLOG_STATUS: 'BlogStatus.JSON',
    BROADCAST_STATUS: 'BroadcastStatus.JSON',
    ADMIN_STATE: path.join('record', 'admin-state.json'),
    BROADCAST_QUEUE: path.join('record', 'broadcast-queue.json'),
    getGroupDir: (groupName) => path.join('record', groupName)
};

export const GROUPS = {
    HINATAZAKA: 'Hinatazaka46',
    SAKURAZAKA: 'Sakurazaka46',
    NOGIZAKA: 'Nogizaka46',
    BOKUAO: 'Bokuao'
};

export const URLS = {
    HINATAZAKA: 'https://hinatazaka46.com',
    SAKURAZAKA: 'https://sakurazaka46.com',
    NOGIZAKA: 'https://nogizaka46.com',
    BOKUAO: 'https://bokuao.com'
};

// Site origin per group, used to absolutize relative media URLs found in blog HTML.
export const GROUP_BASE_URLS = {
    [GROUPS.HINATAZAKA]: URLS.HINATAZAKA,
    [GROUPS.SAKURAZAKA]: URLS.SAKURAZAKA,
    [GROUPS.NOGIZAKA]: URLS.NOGIZAKA,
    [GROUPS.BOKUAO]: URLS.BOKUAO
};

// Fallback permalinks for posts crawled before the detail URL was recorded.
export const BLOG_URL_TEMPLATES = {
    [GROUPS.HINATAZAKA]: (id) => `${URLS.HINATAZAKA}/s/official/diary/detail/${id}?ima=0000&cd=member`,
    [GROUPS.SAKURAZAKA]: (id) => `${URLS.SAKURAZAKA}/s/s46/diary/detail/${id}?ima=0000&cd=blog`,
    [GROUPS.NOGIZAKA]: (id) => `${URLS.NOGIZAKA}/s/n46/diary/detail/${id}?ima=0000&cd=MEMBER`,
    [GROUPS.BOKUAO]: (id) => `${URLS.BOKUAO}/blog/detail/${id}`
};

export const MEMBERS = {
    HINATAZAKA: {
        '五期生リレー': ['大野愛実', '鶴崎仁香', '坂井新奈', '佐藤優羽', '下田衣珠季', '片山紗希', '大田美月', '高井俐香', '松尾桜', '蔵盛妃那乃']
    },
    SAKURAZAKA: {
        '四期生リレー': ['浅井恋乃未', '稲熊ひな', '勝又春', '佐藤愛桜', '中川智尋', '松本和子', '目黒陽色', '山川宇衣', '山田桃実']
    },
    NOGIZAKA: {
        '３期生': ['伊藤理々杏', '岩本蓮加', '梅澤美波', '大園桃子', '久保史緒里', '阪口珠美', '佐藤楓', '中村麗乃', '向井葉月', '山下美月', '吉田綾乃クリスティー', '与田祐希'],
        '４期生': ['遠藤さくら', '賀喜遥香', '掛橋沙耶香', '金川紗耶', '北川悠理', '柴田柚菜', '清宮レイ', '田村真佑', '筒井あやめ', '早川聖来', '矢久保美緒'],
        '新4期生': ['黒見明香', '佐藤璃果', '林瑠奈', '松尾美佑', '弓木奈於'],
        '5期生': ['五百城茉央', '池田瑛紗', '一ノ瀬美空', '井上和', '岡本姫奈', '小川彩', '奥田いろは', '川﨑桜', '菅原咲月', '冨里奈央', '中西アルノ'],
        '6期生': ['愛宕心響', '大越ひなの', '小津玲奈', '海邉朱莉', '川端晃菜', '鈴木佑捺', '瀬戸口心月', '長嶋凛桜', '増田三莉音', '森平麗心', '矢田萌華']
    },
    BOKUAO: {}
}
