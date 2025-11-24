import fs from 'fs/promises';
import path from 'path';
import { PATHS } from '../config/constants.js';

export async function loadBlogStatus(groupName) {
    const dir = PATHS.getGroupDir(groupName);
    const filePath = path.join(dir, 'BlogStatus.json');
    try {
        await fs.access(filePath);
        const data = await fs.readFile(filePath, 'utf-8');
        const list = JSON.parse(data);
        
        // Convert List back to Map (Dict) for O(1) access
        const map = {};
        list.forEach(member => {
            member.BlogList.forEach(blog => {
                map[blog.ID] = blog;
            });
        });
        return map;
    } catch {
        return {};
    }
}

export async function saveBlogStatus(groupName, blogMap) {
    const dir = PATHS.getGroupDir(groupName);
    await fs.mkdir(dir, { recursive: true });
    
    // Group by Member Name (reconstruct structure)
    const membersMap = {};
    Object.values(blogMap).forEach(blog => {
        if (!membersMap[blog.Name]) {
            membersMap[blog.Name] = { 
                Name: blog.Name, 
                Group: groupName, 
                BlogList: [] 
            };
        }
        membersMap[blog.Name].BlogList.push(blog);
    });

    // Sort blogs by date
    Object.values(membersMap).forEach(m => {
        m.BlogList.sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime));
    });

    const filePath = path.join(dir, 'BlogStatus.json');
    await fs.writeFile(filePath, JSON.stringify(Object.values(membersMap), null, 2));
}

export async function saveBlogContent(groupName, blogId, content) {
    if (!content) return;
    const dir = path.join(PATHS.BLOG_CONTENT, groupName);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${blogId}.html`);
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, content);
    }
}