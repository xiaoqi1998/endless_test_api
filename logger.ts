import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(__dirname, 'logs');
const MAX_LOG_ENTRY_LENGTH = 2000;

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFileName(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `api_${year}-${month}-${day}.log`;
}

function formatTimestamp(): string {
    return new Date().toISOString();
}

function truncateForLog(value: any, maxLen: number = MAX_LOG_ENTRY_LENGTH): any {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        return value.length <= maxLen ? value : value.slice(0, maxLen - 3) + '...';
    }
    const jsonStr = JSON.stringify(value);
    if (jsonStr.length <= maxLen) return value;
    try {
        return JSON.parse(jsonStr.slice(0, maxLen - 3) + '...');
    } catch {
        return jsonStr.slice(0, maxLen - 3) + '...';
    }
}

export interface ApiLogEntry {
    timestamp: string;
    method: string;
    url: string;
    statusCode: number;
    request: {
        headers?: Record<string, string>;
        query?: Record<string, any>;
        body?: any;
        params?: Record<string, any>;
    };
    response: any;
    durationMs: number;
}

export function writeApiLog(entry: ApiLogEntry): void {
    const truncatedEntry = {
        ...entry,
        request: {
            ...entry.request,
            body: truncateForLog(entry.request.body),
        },
        response: truncateForLog(entry.response),
    };
    const logLine = '\n' + '='.repeat(60) + '\n' + JSON.stringify(truncatedEntry, null, 2) + '\n';
    const filePath = path.join(LOG_DIR, getLogFileName());
    
    fs.appendFile(filePath, logLine, (err) => {
        if (err) {
            console.error('[Logger] 写入日志失败:', err);
        }
    });
}

export function logRequestResponse(
    method: string,
    url: string,
    statusCode: number,
    request: {
        headers?: Record<string, string>;
        query?: Record<string, any>;
        body?: any;
        params?: Record<string, any>;
    },
    response: any,
    durationMs: number
): void {
    const entry: ApiLogEntry = {
        timestamp: formatTimestamp(),
        method,
        url,
        statusCode,
        request: {
            headers: request.headers,
            query: request.query,
            body: request.body,
            params: request.params,
        },
        response,
        durationMs,
    };
    
    console.log(`[API Log] ${method} ${url} -> ${statusCode} (${durationMs}ms)`);
    writeApiLog(entry);
}
