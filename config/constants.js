import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../');

export const PATHS = {
    EXPORT: path.join(PROJECT_ROOT, 'Export'),
    RECORD: path.join(PROJECT_ROOT, 'record'),
    BLOG_CONTENT: path.join(PROJECT_ROOT, 'blogContent'),
    getGroupDir: (groupName) => path.join(PROJECT_ROOT, 'record', groupName)
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