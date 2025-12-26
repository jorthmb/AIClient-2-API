import axios from 'axios';
import * as http from 'http';
import * as https from 'https';
// 引入 Node.js 内置的 StringDecoder
import { StringDecoder } from 'string_decoder'; 

// OpenAI Responses API specification service for interacting with third-party models
export class OpenAIResponsesApiService {
    constructor(config) {
        if (!config.OPENAI_API_KEY) {
            throw new Error("OpenAI API Key is required for OpenAIResponsesApiService.");
        }
        this.config = config;
        this.apiKey = config.OPENAI_API_KEY;
        this.baseUrl = config.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_OPENAI ?? false;
        console.log(`[OpenAIResponses] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        // 配置 HTTP/HTTPS agent 限制连接池大小，避免资源泄漏
        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: 120000,
        });

        const axiosConfig = {
            baseURL: this.baseUrl,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            }
        };

        // 禁用系统代理以避免HTTPS代理错误
        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }

        this.axiosInstance = axios.create(axiosConfig);
    }

    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        try {
            const response = await this.axiosInstance.post(endpoint, body);
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            if (status === 401 || status === 403) {
                console.error(`[API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[API] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            console.error(`Error calling OpenAI Responses API (Status: ${status}):`, data || error.message);
            throw error;
        }
    }

    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        // OpenAI 的流式请求需要将 stream 设置为 true
        const streamRequestBody = { ...body, stream: true };

        try {
            const response = await this.axiosInstance.post(endpoint, streamRequestBody, {
                responseType: 'stream'
            });

            const stream = response.data;
            let buffer = '';
            // 初始化 StringDecoder，用于正确处理跨 chunk 的多字节字符
            const decoder = new StringDecoder('utf8'); 

            for await (const chunk of stream) {
                // 使用 decoder.write() 替代 chunk.toString()
                // StringDecoder 会在内部缓冲不完整的字符序列，直到下一个 chunk 补齐
                buffer += decoder.write(chunk); 
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const jsonData = line.substring(6).trim();
                        if (jsonData === '[DONE]') {
                            return; // Stream finished
                        }
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            yield parsedChunk;
                        } catch (e) {
                            console.warn("[OpenAIResponsesApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
                        }
                    } else if (line === '') {
                        // Empty line, end of an event
                    }
                }
            }
            // 在流结束时，确保处理完 decoder 中所有剩余的字节（如果有的话）
            buffer += decoder.end(); 
            // 检查处理完 decoder.end() 后是否还有未处理的行
            if (buffer.length > 0) {
                const line = buffer.trim();
                if (line.startsWith('data: ')) {
                    const jsonData = line.substring(6).trim();
                    if (jsonData !== '[DONE]') { // 即使是最后一个 chunk，如果不是 [DONE]，也尝试解析
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            yield parsedChunk;
                        } catch (e) {
                            console.warn("[OpenAIResponsesApiService] Failed to parse final stream chunk JSON:", e.message, "Data:", jsonData);
                        }
                    }
                }
            }

        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            if (status === 401 || status === 403) {
                console.error(`[API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[API] Received 429 (Too Many Requests) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            console.error(`Error calling OpenAI Responses streaming API (Status: ${status}):`, data || error.message);
            throw error;
        }
    }

    async generateContent(model, requestBody) {
        return this.callApi('/responses', requestBody);
    }

    async *generateContentStream(model, requestBody) {
        yield* this.streamApi('/responses', requestBody);
    }

    async listModels() {
        try {
            const response = await this.axiosInstance.get('/models');
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            console.error(`Error listing OpenAI Responses models (Status: ${status}):`, data || error.message);
            throw error;
        }
    }
}
