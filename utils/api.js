import axios from 'axios';

/**
 * Makes an HTTP call and always resolves to a result object instead of throwing,
 * so callers can branch on `success` without wrapping every call in try/catch.
 *
 * @param {import('axios').AxiosRequestConfig} axiosConfig
 * @returns {Promise<{success: boolean, status: number|null, data: any}>}
 */
export async function httpRequest(axiosConfig) {
    try {
        const response = await axios(axiosConfig);
        return { success: true, status: response.status, data: response.data };
    } catch (error) {
        if (error.response) {
            // Server answered with a non-2xx status (e.g. 400 bad chat_id, 429 rate limit).
            return { success: false, status: error.response.status, data: error.response.data };
        }
        if (error.request) {
            return { success: false, status: null, data: 'Network Error: No response received from server.' };
        }
        return { success: false, status: null, data: `Error: ${error.message}` };
    }
}
