// utils/date-parser.js

export const DateFormats = [
    'yyyy.M.d HH:mm',       // 0: Hinatazaka
    'yyyy/M/d',             // 1
    'yyyy/MM/dd HH:mm:ss',  // 2: Nogizaka
    'yyyy.MM.dd',           // 3: Bokuao
    'yyyy/MM/dd HH:mm',     // 4: Sakurazaka
    'yyyy.Mdd',             // 5
];

/**
 * Parses a date string assuming it is Japan Standard Time (UTC+9)
 * and returns a standard UTC ISO 8601 string (e.g. 2023-01-01T03:00:00.000Z).
 */
export function parseDateTime(dateString, dateFormat) {
    if (!dateString) return new Date().toISOString();

    let year, month, day, hour = 0, minute = 0, second = 0;

    // 1. Handle compact "yyyyMMdd" format (Example: "20250101")
    if (dateFormat === "yyyyMMdd" && dateString.length === 8) {
        year = dateString.slice(0, 4);
        month = dateString.slice(4, 6);
        day = dateString.slice(6, 8);
    } 
    // 2. Handle standard delimited formats (dot, slash, or hyphen)
    // Captures: YYYY, MM, DD, and optional HH, mm, ss
    else {
        // Normalize separators to be safe, though regex handles most
        const cleanStr = dateString.trim();
        
        // Regex to extract parts: 
        // Group 1: Year, Group 2: Month, Group 3: Day
        // Group 4: Hour, Group 5: Minute, Group 6: Second (Optional)
        const match = cleanStr.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);

        if (match) {
            year = match[1];
            month = match[2];
            day = match[3];
            hour = match[4] || 0;
            minute = match[5] || 0;
            second = match[6] || 0;
        } else {
            console.warn(`[DateParser] Could not parse: ${dateString}`);
            return new Date().toISOString();
        }
    }

    // 3. Helper to pad numbers with leading zeros
    const pad = (n) => String(n).padStart(2, '0');

    // 4. Construct ISO String with explicit JST Offset (+09:00)
    // Example: "2025-01-01T12:00:00+09:00"
    const jstIsoString = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+09:00`;

    // 5. Create Date Object (JavaScript will convert this to UTC internally)
    const dt = new Date(jstIsoString);

    if (isNaN(dt.getTime())) {
        console.error(`[DateParser] Invalid Date generated from: ${dateString}`);
        return new Date().toISOString();
    }

    // 6. Return pure UTC ISO string (e.g., ends in Z)
    return dt.toISOString();
}

/**
 * Convert to ISO8601 string with hardcoded +08:00 offset (matching original global.js)
 */
function formatDateTimeWithOffset(dt) {
    const year = dt.getFullYear();
    const month = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    const hour = String(dt.getHours()).padStart(2, '0');
    const minute = String(dt.getMinutes()).padStart(2, '0');
    const second = String(dt.getSeconds()).padStart(2, '0');

    // Original code hardcoded the offset to +08:00
    const offset = "+08:00";

    return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}