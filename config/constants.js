import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '../');

export const PATHS = {
    EXPORT: path.join(PROJECT_ROOT, 'Export'),
    RECORD: path.join(PROJECT_ROOT, 'record'),
    BLOG_CONTENT : path.join(PROJECT_ROOT, 'blogContent'),
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