import fs from 'fs';
import path from 'path';
import { PATHS } from '../config/constants.js';

export async function loadBlogStatus(groupName) {
    const dir = PATHS.getGroupDir(groupName);
    const filePath = path.join(dir, 'BlogStatus.json');
    try {
        await fs.promises.access(filePath);
        const data = await fs.promises.readFile(filePath, 'utf-8');
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

function findFirstKeyword(str, keywords) {
    if (!str) return null
    return keywords.reduce((first, keyword) => {
        const index = str.indexOf(keyword);
        if (index !== -1 && (first.index === -1 || index < first.index)) {
            return { keyword, index };
        }
        return first;
    }, { keyword: null, index: -1 }).keyword;
}

export async function saveBlogStatus(groupName, blogMap, groupMembersMap) {
    const dir = PATHS.getGroupDir(groupName);
    await fs.promises.mkdir(dir, { recursive: true });

    // 1. Group blogs by author's name using a more concise reduce function.
    const groupedByName = Object.values(blogMap).reduce((acc, blog) => {
        (acc[blog.Name] = acc[blog.Name] || []).push(blog);
        return acc;
    }, {});

    // 2. Use a Map for efficient member lookups (O(1) average time complexity).
    // This is the key performance improvement.
    const newMembersMap = new Map();

    const getOrCreateMember = (name) => {
        if (!newMembersMap.has(name)) {
            newMembersMap.set(name, {
                Name: name,
                Group: groupName,
                BlogList: [],
            });
        }
        return newMembersMap.get(name);
    };

    // 3. Process each group of blogs.
    for (const [memberName, blogs] of Object.entries(groupedByName)) {
        const sortedBlogs = blogs.sort((a, b) => a.DateTime - b.DateTime);
        const subMemberNames = groupMembersMap[memberName];

        if (subMemberNames && subMemberNames.length > 0) {
            // Case 1: Distribute blogs among the mapped sub-members.
            for (const [index, blog] of sortedBlogs.entries()) {

                const titleText = blog.Title.replaceAll(" ", "");
                const selectedKiMemberName =
                    findFirstKeyword(titleText, subMemberNames)
                // Fallback to round-robin assignment.
                subMemberNames[index % subMemberNames.length];

                const member = getOrCreateMember(selectedKiMemberName);
                member.BlogList.push(blog);
            }
        } else {
            // Case 2: Assign all blogs directly to the original member.
            const member = getOrCreateMember(memberName);
            member.BlogList.push(...sortedBlogs);
        }
    }

    // 4. Convert the map's values back to an array for the final output.
    const finalMembersArray = Array.from(newMembersMap.values());

    const filePath = path.join(dir, 'BlogStatus.json');
    await fs.promises.writeFile(filePath, JSON.stringify(finalMembersArray, null, 2), 'utf-8');
}

export async function saveBlogContent(groupName, blogId, content) {
    if (!content) return;
    const dir = path.join(PATHS.BLOG_CONTENT, groupName);
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${blogId}.html`);
    try {
        await fs.promises.access(filePath);
    } catch {
        await fs.promises.writeFile(filePath, content);
    }
}