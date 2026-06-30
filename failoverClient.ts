// failoverClient.ts
//
// 多节点故障转移执行器（TS 版）。
// 对齐 Python 端 core/failover_rpc.py 的 FailoverRpcClient。
//
// 能力：
//   - 从 config/settings.yaml 读取端点列表（按 priority 排序）
//   - 每个端点创建独立的 Endless SDK 实例
//   - 操作失败时自动切换到下一个端点
//   - 备用节点连续成功 N 次后探测主节点，健康则回切
//   - 同端点内指数退避重试

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { Endless, EndlessConfig, Network } from "@endlesslab/endless-ts-sdk";
import { EndlessAPIError, ErrorHandler, ErrorCode } from "./errorDefinitions";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface EndpointConfig {
    url: string;
    priority?: number;
    chain_id?: string | number;
}

interface FailoverOptions {
    name?: string;
    maxRetries?: number;
    baseDelayMs?: number;
    recoverySuccessCount?: number;
    probeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// FailoverEndlessClient
// ---------------------------------------------------------------------------

export class FailoverEndlessClient {
    private endpoints: EndpointConfig[];
    private endlessInstances: Map<string, Endless> = new Map();
    private activeIdx: number = 0;
    private backupSuccessCount: number = 0;
    private readonly name: string;
    private readonly maxRetries: number;
    private readonly baseDelayMs: number;
    private readonly recoverySuccessCount: number;
    private readonly probeTimeoutMs: number;
    private readonly network: Network;

    constructor(
        endpoints: EndpointConfig[],
        network: Network,
        options: FailoverOptions = {},
    ) {
        if (!endpoints || endpoints.length === 0) {
            throw new EndlessAPIError(
                ErrorCode.CONFIGURATION_ERROR,
                "Failover 端点列表不能为空",
            );
        }
        this.endpoints = [...endpoints].sort(
            (a, b) => (a.priority ?? 99) - (b.priority ?? 99),
        );
        this.name = options.name ?? "Endless RPC";
        this.maxRetries = options.maxRetries ?? 3;
        this.baseDelayMs = options.baseDelayMs ?? 1000;
        this.recoverySuccessCount = options.recoverySuccessCount ?? 5;
        this.probeTimeoutMs = options.probeTimeoutMs ?? 10000;
        this.network = network;

        // 预创建所有 Endless 实例
        for (const ep of this.endpoints) {
            this.endlessInstances.set(ep.url, this.createEndlessInstance(ep));
        }

        console.log(
            `[Failover] ${this.name} 初始化 | 端点数: ${this.endpoints.length} | 主节点: ${this.activeUrl}`,
        );
    }

    // -----------------------------------------------------------------------
    // 公共属性
    // -----------------------------------------------------------------------

    get activeUrl(): string {
        return this.endpoints[this.activeIdx].url;
    }

    get activeEndpoint(): EndpointConfig {
        return this.endpoints[this.activeIdx];
    }

    get endpointCount(): number {
        return this.endpoints.length;
    }

    /**
     * 获取当前活跃的 Endless 实例。
     */
    getActiveEndless(): Endless {
        return this.endlessInstances.get(this.activeUrl)!;
    }

    /**
     * 获取所有端点信息（用于健康检查端点）。
     */
    getEndpointsInfo(): Array<{ url: string; priority: number; active: boolean }> {
        return this.endpoints.map((ep, idx) => ({
            url: ep.url,
            priority: ep.priority ?? 99,
            active: idx === this.activeIdx,
        }));
    }

    // -----------------------------------------------------------------------
    // 核心执行方法
    // -----------------------------------------------------------------------

    /**
     * 从当前活跃端点开始，逐个尝试所有端点执行 operation。
     * 成功即返回并更新活跃端点索引与回切计数；全部失败抛出聚合错误。
     *
     * 注意：在调用 operation 前会先设置 activeIdx，使 Proxy 委托的
     * endless 变量能指向当前端点的 Endless 实例。
     * 测试框架场景下并发度低，可接受 activeIdx 竞态。
     */
    async execute<T>(
        operation: (endless: Endless, url: string) => Promise<T>,
        operationName: string = "RPC 调用",
    ): Promise<T> {
        const errors: Record<string, string> = {};
        const num = this.endpoints.length;

        for (let offset = 0; offset < num; offset++) {
            const idx = (this.activeIdx + offset) % num;
            // 在调用操作前设置 activeIdx，使 Proxy 能取到正确实例
            this.activeIdx = idx;
            const url = this.endpoints[idx].url;
            const endless = this.endlessInstances.get(url)!;

            try {
                const result = await operation(endless, url);
                // 成功：尝试回切主节点
                await this.tryRecoverPrimary(idx);
                const tag = idx === 0 ? "[主节点]" : "[备用节点]";
                console.log(`[Failover] ${this.name} ${operationName}成功 ${tag} ${url}`);
                return result;
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                errors[url] = msg;
                // 判断是否为可重试的网络错误
                if (!this.isRetryableNodeFailure(e)) {
                    // 业务异常直接抛出，不切换节点
                    throw e;
                }
                console.warn(
                    `[Failover] ${this.name} 端点 ${url} ${operationName}失败: ${msg}，尝试下一个...`,
                );
            }
        }

        // 所有端点耗尽
        const formatted = Object.entries(errors)
            .map(([url, err]) => `  [${url}]: ${err.length > 120 ? err.slice(0, 117) + "..." : err}`)
            .join("\n");
        throw new EndlessAPIError(
            ErrorCode.RPC_ALL_ENDPOINTS_EXHAUSTED,
            `所有 ${this.name} 备用节点均已耗尽：\n${formatted}`,
            { errors },
        );
    }

    /**
     * 在同一端点上做指数退避重试。
     */
    async executeWithRetry<T>(
        operation: () => Promise<T>,
        url?: string,
    ): Promise<T> {
        let lastError: unknown;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (e) {
                lastError = e;
                if (attempt >= this.maxRetries) break;
                if (!this.isRetryableNodeFailure(e)) throw e;

                const delay = this.baseDelayMs * Math.pow(2, attempt);
                const tag = url ? ` [${url}]` : "";
                console.warn(
                    `[Failover] ${this.name} 请求失败(第${attempt + 1}次)${tag}: ${
                        e instanceof Error ? e.message : String(e)
                    } -> ${delay}ms 后重试...`,
                );
                await this.sleep(delay);
            }
        }
        throw lastError;
    }

    // -----------------------------------------------------------------------
    // 主节点探活与回切
    // -----------------------------------------------------------------------

    /**
     * 对主节点（索引 0）执行探活。
     */
    async probePrimary(): Promise<boolean> {
        if (this.endpoints.length <= 1) return false;
        const primaryUrl = this.endpoints[0].url;
        const primaryEndless = this.endlessInstances.get(primaryUrl);
        if (!primaryEndless) return false;

        try {
            await primaryEndless.getLedgerInfo();
            return true;
        } catch (e) {
            console.debug(`[Failover] ${this.name} 主节点探测失败: ${e instanceof Error ? e.message : String(e)}`);
            return false;
        }
    }

    /**
     * 备用节点连续成功后，探测主节点；健康则回切。
     */
    private async tryRecoverPrimary(currentIdx: number): Promise<void> {
        const primaryIdx = 0;
        if (currentIdx === primaryIdx) {
            this.backupSuccessCount = 0;
            return;
        }

        this.backupSuccessCount++;
        if (this.backupSuccessCount < this.recoverySuccessCount) return;

        // 达到阈值，探测主节点
        const healthy = await this.probePrimary();
        if (healthy) {
            this.activeIdx = primaryIdx;
            this.backupSuccessCount = 0;
            console.log(`[Failover] ${this.name} 主节点已恢复健康，自动回切到主节点`);
        } else {
            this.backupSuccessCount = 0;
            console.log(`[Failover] ${this.name} 主节点仍不健康，保持当前备用节点`);
        }
    }

    // -----------------------------------------------------------------------
    // 辅助方法
    // -----------------------------------------------------------------------

    /**
     * 判断异常是否为可重试的网络/节点错误（业务异常不重试）。
     */
    private isRetryableNodeFailure(error: unknown): boolean {
        if (error instanceof EndlessAPIError) {
            // 业务异常（参数错误、ABI 不匹配等）不重试
            const code = error.code;
            if (
                code === ErrorCode.INVALID_PARAMETER ||
                code === ErrorCode.ACCOUNT_INVALID_PRIVATE_KEY ||
                code === ErrorCode.CONTRACT_NOT_FOUND ||
                code === ErrorCode.CONTRACT_ABI_MISMATCH ||
                code === ErrorCode.MISSING_PARAMETER ||
                code === ErrorCode.PARAMETER_FORMAT_ERROR ||
                code === ErrorCode.PARAMETER_TYPE_ERROR
            ) {
                return false;
            }
        }
        const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        // 网络类错误重试
        if (
            msg.includes("timeout") ||
            msg.includes("econnreset") ||
            msg.includes("econnrefused") ||
            msg.includes("enotfound") ||
            msg.includes("socket hang up") ||
            msg.includes("network") ||
            msg.includes("fetch failed") ||
            msg.includes("502") ||
            msg.includes("503") ||
            msg.includes("504") ||
            msg.includes("service unavailable") ||
            msg.includes("internal server error")
        ) {
            return true;
        }
        // 默认不重试（避免业务异常导致无谓切换）
        return false;
    }

    private createEndlessInstance(endpoint: EndpointConfig): Endless {
        // 若端点显式配置了 chain_id，说明实际链 ID 与 SDK 内置 NetworkToChainId 映射不一致
        // （例如 devnet 节点返回 chainId=220）。改用 Network.CUSTOM 让 SDK 通过 getLedgerInfo
        // 查询真实 chainId，避免交易提交时触发 BAD_CHAIN_ID 校验失败。
        const useCustomNetwork = Boolean(endpoint.chain_id);
        const config: EndlessConfig = {
            network: useCustomNetwork ? Network.CUSTOM : this.network,
            fullnode: endpoint.url,
        } as EndlessConfig;
        return new Endless(config);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ---------------------------------------------------------------------------
// 从 settings.yaml 加载端点配置
// ---------------------------------------------------------------------------

/**
 * 从项目根目录 config/settings.yaml 读取 endless RPC 端点列表。
 * 若读取失败，回退到 .env 中的 ENDLESS_NETWORK_URL 单端点。
 */
export function loadEndpointsFromSettings(): EndpointConfig[] {
    // 尝试读取 settings.yaml
    const settingsPath = path.resolve(__dirname, "..", "config", "settings.yaml");

    try {
        if (fs.existsSync(settingsPath)) {
            const content = fs.readFileSync(settingsPath, "utf-8");
            const doc: any = yaml.load(content);
            const endpoints: any[] = doc?.rpc?.endless?.endpoints ?? [];

            if (endpoints.length > 0) {
                // 展开 ${ENV_VAR} 占位符
                const resolved = endpoints.map((ep: any) => ({
                    url: expandEnvVars(ep.url),
                    priority: ep.priority ?? 99,
                    chain_id: ep.chain_id !== undefined ? expandEnvVars(String(ep.chain_id)) : undefined,
                })).filter((ep: EndpointConfig) => ep.url);

                if (resolved.length > 0) {
                    console.log(`[Failover] 从 settings.yaml 加载 ${resolved.length} 个端点`);
                    return resolved;
                }
            }
        }
    } catch (e) {
        console.warn(`[Failover] 读取 settings.yaml 失败: ${e instanceof Error ? e.message : String(e)}，回退到 .env`);
    }

    // 回退：从 .env 读取单端点
    const fallbackUrl = process.env.ENDLESS_NETWORK_URL;
    if (!fallbackUrl) {
        throw new EndlessAPIError(
            ErrorCode.CONFIGURATION_ERROR,
            "无法加载 RPC 端点：settings.yaml 和 ENDLESS_NETWORK_URL 均未配置",
        );
    }
    console.log(`[Failover] 从 .env 加载单端点: ${fallbackUrl}`);
    return [{ url: fallbackUrl, priority: 1 }];
}

/**
 * 展开 ${ENV_VAR} 占位符。
 */
function expandEnvVars(text: string): string {
    return text.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
        return process.env[varName] ?? "";
    });
}
