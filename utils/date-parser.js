export function parseDateTime(dateString, format = 'standard') {
    if (!dateString) return new Date().toISOString();

    // Naive implementation based on your previous code
    // You can swap this with date-fns or moment if you want strict parsing
    let normalized = dateString.replace(/\./g, "/");
    
    // Nogizaka/Hinatazaka Japan Time Adjustment (-1 hr logic from your C# port)
    // Note: JS Date parsing is local unless timezone specified. 
    // This is a simplified version of your logic:
    const dt = new Date(normalized);

    if (isNaN(dt.getTime())) return new Date().toISOString();

    return dt.toISOString(); 
}