// contractService.ts
//
// Endless 合约交互服务（基于官方 @endlesslab/endless-ts-sdk）。
//
// 覆盖能力（对齐 Python 端 core/endless_contract.py 的 6 个公共方法）：
//   1. readContractState        — 视图函数读取
//   2. writeToContract          — 单签写交易
//   3. writeToContractMultiAgent — 多 Agent 写交易（secondary_signers）
//   4. writeToContractMultiKey  — MultiKey 多签写交易（K-of-N）
//   5. simulateTransaction     — 交易模拟（不签名、不上链）
//   6. getAccountResources     — 账户资源全量查询
//   7. getAccountResource      — 账户单个资源查询
//   8. getAccountInfo          — 账户基础信息（含 authentication_key）
//   9. getAccountModules       — 账户模块列表
//  10. getTransactionByHash    — 按 hash 查交易
//  11. getTransactionByVersion — 按 version 查交易
//  12. waitForTransaction      — 等待交易确认
//  13. getAccountEventsByCreationNumber — 按账户 + creation_number 查事件
//  14. getAccountEventsByEventType     — 按账户 + event_type 查事件
//  15. getModuleEventsByEventType      — 按 event_type 全局查事件
//  16. getLedgerInfo           — 链信息（健康检查）
//  17. getGasPriceEstimation   — Gas 价格估算
//  18. publishPackageTransaction — 发布 Move 包
//  19. bcsSerialize            — BCS 序列化工具（用于 bcs_stream 测试）
//
// 设计要点：
//   - RPC 端点 / Network / 私钥均从 .env 读取，不写死。
//   - 所有方法均接受显式参数，无隐式全局状态依赖。
//   - 错误统一通过 ErrorHandler.fromError 包装为 EndlessAPIError。

import {
    Endless,
    EndlessConfig,
    Network,
    Account,
    Ed25519PrivateKey,
    Ed25519PublicKey,
    AccountAddress,
    MultiKeyAccount,
    MultiKey,
    MultiSig,
    TransactionPayloadMultiSig,
    buildTransaction,
    type InputViewFunctionData,
    type AnyRawTransaction,
    type InputGenerateTransactionPayloadData,
    type InputGenerateTransactionOptions,
    type AccountAddressInput,
    type HexInput,
    fetchViewFunctionAbi,
    checkOrConvertArgument,
    standardizeTypeTags,
    EntryFunction,
    Serializer,
    parseTypeTag,
    fetchEntryFunctionAbi,
    convertArgument,
} from "@endlesslab/endless-ts-sdk";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import yaml from "js-yaml";
import { ErrorCode, ErrorHandler, EndlessAPIError } from './errorDefinitions';
import { FailoverEndlessClient, loadEndpointsFromSettings, loadNetworkSettings } from './failoverClient';
import type { EndpointConfig } from './failoverClient';

// 确保在读取任何环境变量之前加载 .env
// 优先加载项目根目录的 .env（与 Python 端共享同一份配置），再用本目录 .env 覆盖
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

// ============================================================================
// 1. 全局客户端初始化（多节点故障转移，支持运行时切换）
// ============================================================================

function resolveNetwork(raw?: string): Network {
    const network = (raw || process.env.ENDLESS_NETWORK || "devnet").toLowerCase();
    if (network === "mainnet") return Network.MAINNET;
    if (network === "testnet") return Network.TESTNET;
    if (network === "local") return Network.LOCAL;
    if (network === "custom") return Network.CUSTOM;
    return Network.DEVNET;
}

function networkNameFromEnum(network: Network): string {
    if (network === Network.MAINNET) return "mainnet";
    if (network === Network.TESTNET) return "testnet";
    if (network === Network.LOCAL) return "local";
    if (network === Network.CUSTOM) return "custom";
    return "devnet";
}

const DEFAULT_NETWORK_URLS: Record<string, string> = {
    mainnet: "https://rpc.endless.link/v1",
    testnet: "https://rpc-test.endless.link/v1",
    devnet: "https://rpc-dev.endless.link/v1"
};

const DEFAULT_NETWORK_CHAIN_IDS: Record<string, number> = {
    mainnet: 220,
    testnet: 221,
    devnet: 220
};

function buildFailoverOptions(): any {
    return {
        name: "Endless RPC",
        maxRetries: Number(process.env.RPC_MAX_RETRIES_PER_ENDPOINT ?? 3),
        baseDelayMs: Number(process.env.RPC_RETRY_BASE_DELAY_MS ?? 1000),
        recoverySuccessCount: Number(process.env.RPC_PRIMARY_RECOVERY_SUCCESS_COUNT ?? 5),
        probeTimeoutMs: Number(process.env.RPC_PRIMARY_PROBE_TIMEOUT_MS ?? 10000),
    };
}

function persistNetworkSettings(network: Network, endpoints: EndpointConfig[]) {
    const dataDir = path.resolve(__dirname, "..", "data");
    const dataPath = path.join(dataDir, "settings.yaml");
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const yamlContent = yaml.dump({
        network: networkNameFromEnum(network),
        rpc: {
            endless: {
                endpoints: endpoints.map((ep) => ({
                    url: ep.url,
                    priority: ep.priority ?? 1,
                    ...(ep.chain_id !== undefined ? { chain_id: ep.chain_id } : {}),
                })),
            },
        },
    }, { lineWidth: -1 });
    fs.writeFileSync(dataPath, yamlContent, "utf-8");
}

export interface NetworkConfig {
    network: string;
    activeUrl: string;
    endpoints: EndpointConfig[];
}

export interface SwitchNetworkInput {
    network: string;
    url?: string;
    endpoints?: EndpointConfig[];
    /** 跳过探活，直接切换（默认 false）。当目标 RPC 有 SSL 校验等问题时使用。 */
    skipProbe?: boolean;
}

// 加载初始配置优先级：持久化 data/settings.yaml > config/settings.yaml > .env
const dataSettingsPath = path.resolve(__dirname, "..", "data", "settings.yaml");
const dataSettings = loadNetworkSettings(dataSettingsPath);
const fallbackEndpoints = loadEndpointsFromSettings();
let initialEndpoints = dataSettings.endpoints.length > 0 ? dataSettings.endpoints : fallbackEndpoints;
const initialNetworkName = dataSettings.network || process.env.ENDLESS_NETWORK || "devnet";
const initialNetwork = resolveNetwork(initialNetworkName);

// 如果 endpoints 没有配置 chain_id，且是预设网络，自动添加默认 chain_id
if (initialEndpoints.length > 0 && !initialEndpoints[0].chain_id) {
    const defaultChainId = DEFAULT_NETWORK_CHAIN_IDS[initialNetworkName.toLowerCase()];
    if (defaultChainId) {
        initialEndpoints = initialEndpoints.map(ep => ({ ...ep, chain_id: defaultChainId }));
    }
}

// 创建 failover 客户端（管理多端点切换、主节点探活、指数退避）
let failoverClient = new FailoverEndlessClient(initialEndpoints, initialNetwork, buildFailoverOptions());

// endless 代理：所有 endless.xxx 调用都委托给当前活跃端点的 Endless 实例。
// failoverClient 变量在运行时可被重新赋值，Proxy 闭包会自动读取最新实例。
const endless = new Proxy({} as Endless, {
    get(_target, prop) {
        const active = failoverClient.getActiveEndless();
        const value = (active as any)[prop];
        if (typeof value === 'function') {
            return value.bind(active);
        }
        return value;
    }
});

// 保留 endlessConfig 用于导出（向后兼容），运行时可重新赋值
let endlessConfig = new EndlessConfig({
    network: initialNetwork,
    fullnode: failoverClient.activeUrl,
} as any);

export function getCurrentNetworkConfig(): NetworkConfig {
    return {
        network: networkNameFromEnum(failoverClient.getNetwork()),
        activeUrl: failoverClient.activeUrl,
        endpoints: failoverClient.getEndpoints(),
    };
}

export async function switchNetwork(input: SwitchNetworkInput): Promise<NetworkConfig> {
    const requestedNetworkName = (input.network || "devnet").toLowerCase();
    const network = resolveNetwork(requestedNetworkName);

    let endpoints: EndpointConfig[];
    if (input.endpoints && input.endpoints.length > 0) {
        endpoints = input.endpoints.map((ep) => ({
            url: ep.url,
            priority: ep.priority ?? 1,
            chain_id: ep.chain_id,
        }));
    } else if (input.url) {
        endpoints = [{ url: input.url, priority: 1 }];
    } else {
        const defaultUrl = DEFAULT_NETWORK_URLS[requestedNetworkName];
        if (!defaultUrl) {
            throw new EndlessAPIError(
                ErrorCode.CONFIGURATION_ERROR,
                `切换 ${requestedNetworkName} 失败：未提供 url 或 endpoints，且该网络没有内置默认 RPC`,
            );
        }
        const defaultChainId = DEFAULT_NETWORK_CHAIN_IDS[requestedNetworkName];
        endpoints = [{ url: defaultUrl, priority: 1, chain_id: defaultChainId }];
    }

    // 先探活新端点（除非指定 skipProbe），然后确定最终客户端
    let newClient: FailoverEndlessClient;
    if (!input.skipProbe) {
        newClient = new FailoverEndlessClient(endpoints, network, buildFailoverOptions());
        try {
            await newClient.execute(async (activeEndless) => {
                await activeEndless.getLedgerInfo();
            }, "switchNetworkProbe");
        } catch (e) {
            throw new EndlessAPIError(
                ErrorCode.CONFIGURATION_ERROR,
                `新网络 ${requestedNetworkName} 探活失败，未执行切换：${e instanceof Error ? e.message : String(e)}`,
            );
        }
    } else {
        newClient = new FailoverEndlessClient(endpoints, network, buildFailoverOptions());
    }

    // 探活通过（或跳过），更新运行时状态
    failoverClient = newClient;
    endlessConfig = new EndlessConfig({
        network: failoverClient.getNetwork(),
        fullnode: failoverClient.activeUrl,
    } as any);

    persistNetworkSettings(network, endpoints);
    console.log(`[Network] 已切换至 ${requestedNetworkName} | 活跃: ${failoverClient.activeUrl}`);

    return getCurrentNetworkConfig();
}

console.log(`[Init] Network=${networkNameFromEnum(initialNetwork)} | Failover 端点数: ${failoverClient.endpointCount} | 活跃: ${failoverClient.activeUrl}`);
if (process.env.ENDLESS_INDEXER_URL) {
    console.log(`[Init] Indexer=${process.env.ENDLESS_INDEXER_URL}`);
}

/**
 * 在 failover 保护下执行操作。
 * 用于需要多端点故障转移的 SDK 调用。
 * 返回值会自动进行大整数转字符串处理（防 JSON 精度丢失）。
 */
async function withFailover<T>(operationName: string, fn: () => Promise<T>): Promise<T> {
    const result = await failoverClient.execute(async () => fn(), operationName);
    return stringifyBigIntDeep(result);
}

// ============================================================================
// 大整数处理（u64/u128/u256 → 字符串，防 JSON 精度丢失）
// ============================================================================

/**
 * 递归将任意结构中的 bigint / 大数值 number 转换为字符串。
 * - bigint 直接 toString
 * - number 超过 Number.MAX_SAFE_INTEGER 时 toString
 * - 其它原样返回
 */
function stringifyBigIntDeep<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (typeof value === 'bigint') return String(value) as unknown as T;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return value;
        if (Number.isSafeInteger(value)) return value;
        // 超过安全整数范围，用字符串表示（避免精度损失）
        return String(value) as unknown as T;
    }
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.map(stringifyBigIntDeep) as unknown as T;
    }
    if (value instanceof Date) return value.toISOString() as unknown as T;
    if (typeof value === 'object') {
        // 跳过 Buffer/TypedArray/Map/Set 等非纯对象
        const proto = Object.getPrototypeOf(value);
        if (proto && proto !== Object.prototype && !(proto.constructor && proto.constructor.name === 'Object')) {
            return value;
        }
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as object)) {
            out[k] = stringifyBigIntDeep((value as Record<string, unknown>)[k]);
        }
        return out as unknown as T;
    }
    return value;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 规范化合约地址：支持 0x hex 与 Base58 两种输入。
 */
async function normalizeAddress(contractAddress: string): Promise<string> {
    if (!contractAddress) {
        throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');
    }
    try {
        if (contractAddress.startsWith("0x")) {
            // 通过 AccountAddress.fromHex 验证并标准化
            return AccountAddress.from(contractAddress as HexInput).toString();
        }
        try {
            return AccountAddress.fromBs58String(contractAddress).toString();
        } catch (_) {
            return AccountAddress.fromString(contractAddress).toString();
        }
    } catch (error) {
        throw new EndlessAPIError(
            ErrorCode.INVALID_PARAMETER,
            `合约地址格式错误: ${contractAddress}`,
            { contractAddress, error: error instanceof Error ? error.message : String(error) }
        );
    }
}

/**
 * 由私钥构造 Ed25519 账户（legacy 模式，与 aptos-sdk 行为一致）。
 * 私钥字符串可带或不带 0x 前缀。
 */
function accountFromPrivateKey(privateKey: string, addressOverride?: string): Account {
    if (!privateKey) {
        throw ErrorHandler.validationError('privateKey', '私钥不能为空');
    }
    const keyHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
    if (keyHex.length !== 64) {
        throw new EndlessAPIError(
            ErrorCode.ACCOUNT_INVALID_PRIVATE_KEY,
            `私钥长度错误: 期望 64 hex 字符（含或不含 0x 前缀共 64/66），实际 ${keyHex.length}`,
            { providedLength: privateKey.length }
        );
    }
    try {
        const keyInstance = new Ed25519PrivateKey(keyHex);
        // legacy: true -> Ed25519Account，与 aptos_sdk.Account.load_key 行为一致
        const opts: any = { privateKey: keyInstance, legacy: true };
        if (addressOverride) opts.address = addressOverride;
        // fromPrivateKey 同步返回（Account.fromPrivateKey 文档签名是 Promise，但实现为同步）
        // 使用 await 兼容两种实现
        return Account.fromPrivateKey(opts) as unknown as Account;
    } catch (error) {
        throw new EndlessAPIError(
            ErrorCode.ACCOUNT_INVALID_PRIVATE_KEY,
            `私钥加载失败: ${error instanceof Error ? error.message : String(error)}`,
            { privateKey: `<masked, len=${privateKey.length}>` }
        );
    }
}

/**
 * 从环境变量加载多个私钥（用于 MultiKey 签名）。
 * 优先级：ENDLESS_MULTI_KEY_1..N → ENDLESS_PRIVATE_KEY（兜底 1 个）→ ENDLESS_ACCOUNT_1..N
 */
function loadMultiKeyPrivateKeys(expectedCount: number): string[] {
    const keys: string[] = [];
    for (let i = 1; i <= expectedCount; i++) {
        const k = process.env[`ENDLESS_MULTI_KEY_${i}`];
        if (k) keys.push(k);
    }
    if (keys.length === 0) {
        const main = process.env.ENDLESS_PRIVATE_KEY;
        if (main) keys.push(main);
    }
    if (keys.length < expectedCount) {
        for (let i = 1; i <= expectedCount; i++) {
            const k = process.env[`ENDLESS_ACCOUNT_${i}`];
            if (k && !keys.includes(k)) keys.push(k);
            if (keys.length >= expectedCount) break;
        }
    }
    return keys;
}

/**
 * 构造 InputGenerateTransactionPayloadData。
 */
async function buildPayload(
    normalizedAddress: string,
    moduleName: string,
    functionName: string,
    functionArguments: any[],
    typeArguments: string[] = [],
): Promise<InputGenerateTransactionPayloadData> {
    const fullFunctionName = `${normalizedAddress}::${moduleName}::${functionName}`;

    // 手动获取 ABI 并构建 EntryFunctionABI 对象，避免 SDK 内部 fetchEntryFunctionAbi 失败
    const entryFunctionAbi = await fetchAndBuildEntryFunctionAbi(
        normalizedAddress, moduleName, functionName,
    );

    const data: any = {
        function: fullFunctionName as any,
        typeArguments: standardizeTypeTags(typeArguments),
        functionArguments,
    };
    if (entryFunctionAbi) {
        data.abi = entryFunctionAbi;
    }
    return data;
}

/**
 * 通过 RPC 获取函数 ABI，构建 SDK 所需的 EntryFunctionABI 对象。
 * 返回 null 表示获取失败，回退到 SDK 默认行为。
 */
async function fetchAndBuildEntryFunctionAbi(
    contractAddress: string,
    moduleName: string,
    functionName: string,
): Promise<any | null> {
    try {
        const normalizedAddr = await normalizeAddress(contractAddress);
        const rpcUrl = (endless as any).config?.fullnode
            || process.env.ENDLESS_FULLNODE_URL
            || 'https://rpc-dev.endless.link/v1';
        const url = `${rpcUrl}/accounts/${normalizedAddr}/module/${moduleName}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            console.warn(`[ABI] 获取模块 ABI 失败: ${resp.status}`);
            return null;
        }
        const data = await resp.json() as any;
        const abi = data?.abi;
        if (!abi?.exposed_functions) return null;
        const fn = abi.exposed_functions.find((f: any) => f.name === functionName);
        if (!fn) return null;

        // 过滤掉 &signer 参数
        const nonSignerParams: string[] = fn.params.filter((p: string) => p !== '&signer');
        // 将参数类型字符串转为 TypeTag 对象
        const parameters = nonSignerParams.map((typeStr: string) => parseTypeTag(typeStr));
        const typeParameters = (fn.generic_type_params || []).map(() => ({}));

        const result = { typeParameters, parameters, signers: fn.params.filter((p: string) => p === '&signer').length };
        console.log(`[ABI] ${contractAddress}::${moduleName}::${functionName} — ${nonSignerParams.length} params, ${result.signers} signer(s)`);
        return result;
    } catch (e) {
        console.warn(`[ABI] 获取 ABI 异常: ${e}`);
        return null;
    }
}

/**
 * 等待交易确认并构造统一返回结构。
 */
async function waitAndBuildResult(
    pendingTxn: { hash: string },
    options: { timeoutSecs?: number; checkSuccess?: boolean } = {}
) {
    const committed = await endless.waitForTransaction({
        transactionHash: pendingTxn.hash,
        options: {
            timeoutSecs: options.timeoutSecs ?? 60,
            checkSuccess: options.checkSuccess ?? true,
        },
    } as any);

    const c: any = committed;
    const isSuccess = c.success ?? (c.vm_status === "Executed successfully");
    return {
        hash: c.hash,
        success: isSuccess,
        // 兼容 Python 端契约：status 为 "success"/"failed"，原始 vm_status 通过 vm_status 字段透传
        status: isSuccess ? "success" : "failed",
        vm_status: c.vm_status,
        vmStatus: c.vm_status,
        sender: c.sender,
        version: c.version ?? c.version?.toString?.(),
        gas_used: typeof c.gas_used === 'string' ? Number(c.gas_used) : c.gas_used,
        gasUsed: typeof c.gas_used === 'string' ? Number(c.gas_used) : c.gas_used,
        gasUnitPrice: typeof c.gas_unit_price === 'string' ? Number(c.gas_unit_price) : c.gas_unit_price,
        timestamp: c.timestamp,
        // RPC 原始响应（供测试报告展示）
        rpc_response: {
            hash: c.hash,
            success: c.success,
            vm_status: c.vm_status,
            sender: c.sender,
            version: c.version,
            gas_used: c.gas_used,
            gas_unit_price: c.gas_unit_price,
            payload: c.payload,
            signature: c.signature,
            timestamp: c.timestamp,
        },
    };
}

// ============================================================================
// 1. 视图函数读取
// ============================================================================

export async function readContractState(payload: {
    contractAddress: string,
    moduleName: string,
    functionName: string,
    args: any[],
    typeArgs?: string[],
    ledgerVersion?: string | number,
}) {
    const { contractAddress, moduleName, functionName, args, typeArgs, ledgerVersion } = payload;

    if (!contractAddress) throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');
    if (!moduleName) throw ErrorHandler.validationError('moduleName', '模块名不能为空');
    if (!functionName) throw ErrorHandler.validationError('functionName', '函数名不能为空');
    if (!Array.isArray(args)) throw ErrorHandler.validationError('args', '参数必须是数组', args);

    const normalizedAddress = await normalizeAddress(contractAddress);

    const viewFunctionPayload: InputViewFunctionData = {
        function: `${normalizedAddress}::${moduleName}::${functionName}` as any,
        typeArguments: typeArgs && typeArgs.length ? standardizeTypeTags(typeArgs) : [],
        functionArguments: args,
    };

    console.log(`[Read] ${viewFunctionPayload.function} args=${JSON.stringify(args)} typeArgs=${JSON.stringify(typeArgs || [])}`);
    const startMs = Date.now();

    try {
        return await withFailover("readContractState", async () => {
            // 拉 ABI 做 ABI 校验（与原实现一致）
            let convertedArgs = args;
            try {
                const abi = await fetchViewFunctionAbi(normalizedAddress, moduleName, functionName, endlessConfig);
                if (abi?.parameters && Array.isArray(abi.parameters)) {
                    convertedArgs = abi.parameters.map((param: any, i: number) => {
                        try {
                            return checkOrConvertArgument(args[i], param, i, (abi.typeParameters || []).map(() => ({})) as any);
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            throw new EndlessAPIError(
                                ErrorCode.CONTRACT_PARAMETER_ERROR,
                                `参数第 ${i + 1} 项不符合 ABI 要求: ${msg}`,
                                { parameterIndex: i, expectedType: String(param), providedValue: args[i], originalError: msg }
                            );
                        }
                    });
                }
            } catch (abiError) {
                // ABI 拉取失败不阻塞，直接用原始参数继续 view
                console.warn(`[Read] ABI 拉取失败，回退到原始参数: ${abiError instanceof Error ? abiError.message : abiError}`);
            }

            const viewOpts: any = { payload: { ...viewFunctionPayload, functionArguments: convertedArgs } };
            if (ledgerVersion !== undefined) viewOpts.options = { ledgerVersion };

            const result = await endless.general.view(viewOpts);
            const durMs = Date.now() - startMs;
            console.log(`[Read] Success in ${durMs}ms`);

            return {
                function: viewFunctionPayload.function,
                result,
                note: "成功读取合约状态。结果为合约 View 函数的返回值数组。",
            };
        });
    } catch (error) {
        console.error(`[Read] Error:`, error);
        throw ErrorHandler.fromError(error, `读取合约状态失败: ${normalizedAddress}::${moduleName}::${functionName}`);
    }
}

// ============================================================================
// 2. 单签写交易
// ============================================================================

export async function writeToContract(payload: {
    privateKey: string,
    contractAddress: string,
    moduleName: string,
    functionName: string,
    functionArguments: any[],
    typeArguments?: string[],
    senderAddress?: string,
    maxGasAmount?: number,
    gasUnitPrice?: number,
    txTimeoutSecs?: number,
    options?: InputGenerateTransactionOptions,
}) {
    const {
        privateKey, contractAddress, moduleName, functionName,
        functionArguments, typeArguments, senderAddress,
        maxGasAmount, gasUnitPrice, txTimeoutSecs, options,
    } = payload;

    if (!privateKey) throw ErrorHandler.validationError('privateKey', '私钥不能为空');
    if (!contractAddress) throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');
    if (!moduleName) throw ErrorHandler.validationError('moduleName', '模块名不能为空');
    if (!functionName) throw ErrorHandler.validationError('functionName', '函数名不能为空');
    if (!Array.isArray(functionArguments)) throw ErrorHandler.validationError('functionArguments', '函数参数必须是数组', functionArguments);

    const normalizedAddress = await normalizeAddress(contractAddress);
    const signer = accountFromPrivateKey(privateKey, senderAddress);
    const senderAddr: AccountAddress = (signer as any).accountAddress;

    const data = await buildPayload(normalizedAddress, moduleName, functionName, functionArguments, typeArguments);
    console.log(`[Write] built payload:`, JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : v));
    const txOptions: InputGenerateTransactionOptions = { ...(options || {}) } as InputGenerateTransactionOptions;
    if (maxGasAmount !== undefined) (txOptions as any).maxGasAmount = maxGasAmount;
    if (gasUnitPrice !== undefined) (txOptions as any).gasUnitPrice = gasUnitPrice;

    try {
        return await withFailover("writeToContract", async () => {
            const transaction = await endless.transaction.build.simple({
                sender: senderAddr,
                data,
                options: txOptions,
            });

            console.log(`[Write] ${normalizedAddress}::${moduleName}::${functionName} sender=${senderAddr.toString()}`);
            const pending = await endless.signAndSubmitTransaction({ signer, transaction });
            const result = await waitAndBuildResult(pending, { timeoutSecs: txTimeoutSecs });
            // 注入 RPC 请求参数（供测试报告展示）
            const rpc_request = {
                url: `${(endless as any).config?.fullnode || process.env.ENDLESS_FULLNODE_URL || 'https://rpc-dev.endless.link/v1'}/transactions`,
                method: 'POST',
                content_type: 'application/x-bcs',
                payload: {
                    function: `${normalizedAddress}::${moduleName}::${functionName}`,
                    type_arguments: typeArguments || [],
                    arguments: data.functionArguments?.map((a: any) => typeof a === 'bigint' ? a.toString() : a),
                },
                sender: senderAddr.toString(),
                max_gas_amount: (txOptions as any).maxGasAmount,
                gas_unit_price: (txOptions as any).gasUnitPrice,
            };
            console.log(`[Write] committed hash=${result.hash} status=${result.status}`);
            return { ...result, rpc_request };
        });
    } catch (error) {
        console.error(`[Write] Error:`, error);
        throw ErrorHandler.fromError(error, `写入合约失败: ${normalizedAddress}::${moduleName}::${functionName}`);
    }
}

// ============================================================================
// 3. Multi-Agent 写交易（secondary_signers）
// ============================================================================

export async function writeToContractMultiAgent(payload: {
    senderPrivateKey: string,
    senderAddress?: string,
    contractAddress: string,
    moduleName: string,
    functionName: string,
    functionArguments: any[],
    typeArguments?: string[],
    secondarySigners: Array<{ privateKey: string; address?: string }>,
    maxGasAmount?: number,
    gasUnitPrice?: number,
    txTimeoutSecs?: number,
}) {
    const {
        senderPrivateKey, senderAddress, contractAddress,
        moduleName, functionName, functionArguments, typeArguments,
        secondarySigners, maxGasAmount, gasUnitPrice, txTimeoutSecs,
    } = payload;

    if (!senderPrivateKey) throw ErrorHandler.validationError('senderPrivateKey', '发送方私钥不能为空');
    if (!contractAddress) throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');
    if (!Array.isArray(functionArguments)) throw ErrorHandler.validationError('functionArguments', '函数参数必须是数组');
    if (!Array.isArray(secondarySigners) || secondarySigners.length === 0) {
        throw ErrorHandler.validationError('secondarySigners', '次要签名者列表不能为空');
    }

    const normalizedAddress = await normalizeAddress(contractAddress);
    const sender = accountFromPrivateKey(senderPrivateKey, senderAddress);
    const secondaryAccounts = secondarySigners.map(s => accountFromPrivateKey(s.privateKey, s.address));
    const secondaryAddresses: AccountAddress[] = secondaryAccounts.map(a => (a as any).accountAddress);

    const data = await buildPayload(normalizedAddress, moduleName, functionName, functionArguments, typeArguments);
    const txOptions: InputGenerateTransactionOptions = {} as InputGenerateTransactionOptions;
    if (maxGasAmount !== undefined) (txOptions as any).maxGasAmount = maxGasAmount;
    if (gasUnitPrice !== undefined) (txOptions as any).gasUnitPrice = gasUnitPrice;

    try {
        return await withFailover("writeToContractMultiAgent", async () => {
            const multiAgentTxn = await endless.transaction.build.multiAgent({
                sender: (sender as any).accountAddress,
                data,
                secondarySignerAddresses: secondaryAddresses,
                options: txOptions,
            });

            console.log(`[MultiAgent] sender=${(sender as any).accountAddress.toString()} secondaries=${secondaryAddresses.length}`);

            // 各方独立签名
            const senderAuthenticator = endless.transaction.sign({ signer: sender, transaction: multiAgentTxn });
            const additionalAuthenticators = secondaryAccounts.map(acc =>
                endless.transaction.sign({ signer: acc, transaction: multiAgentTxn })
            );

            const pending = await endless.transaction.submit.multiAgent({
                transaction: multiAgentTxn,
                senderAuthenticator,
                additionalSignersAuthenticators: additionalAuthenticators,
            });

            const result = await waitAndBuildResult(pending, { timeoutSecs: txTimeoutSecs });
            console.log(`[MultiAgent] committed hash=${result.hash} status=${result.status}`);
            return result;
        });
    } catch (error) {
        console.error(`[MultiAgent] Error:`, error);
        throw ErrorHandler.fromError(error, `Multi-Agent 写交易失败: ${normalizedAddress}::${moduleName}::${functionName}`);
    }
}

// ============================================================================
// 4. MultiKey 写交易（K-of-N 多签）
// ============================================================================

export async function writeToContractMultiKey(payload: {
    // 任一参与签名的私钥即可（其它从 env 加载）
    privateKey?: string,
    // 或显式传入所有签名者私钥
    signerPrivateKeys?: string[],
    signaturesRequired: number,
    // 可选：显式传入所有 N 个公钥（按顺序），未传则从私钥推导
    publicKeys?: string[],
    contractAddress: string,
    moduleName: string,
    functionName: string,
    functionArguments: any[],
    typeArguments?: string[],
    maxGasAmount?: number,
    gasUnitPrice?: number,
    txTimeoutSecs?: number,
}) {
    const {
        privateKey, signerPrivateKeys, signaturesRequired,
        publicKeys: explicitPublicKeys,
        contractAddress, moduleName, functionName,
        functionArguments, typeArguments,
        maxGasAmount, gasUnitPrice, txTimeoutSecs,
    } = payload;

    if (!contractAddress) throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');
    if (!Number.isInteger(signaturesRequired) || signaturesRequired < 1) {
        throw ErrorHandler.validationError('signaturesRequired', 'signaturesRequired 必须为正整数');
    }
    if (!Array.isArray(functionArguments)) throw ErrorHandler.validationError('functionArguments', '函数参数必须是数组');

    // 收集签名者私钥
    let signerKeys: string[];
    if (signerPrivateKeys && signerPrivateKeys.length) {
        signerKeys = signerPrivateKeys;
    } else if (privateKey) {
        // 从 env 加载完整集，再用传入的 privateKey 补足
        signerKeys = loadMultiKeyPrivateKeys(signaturesRequired);
        if (!signerKeys.includes(privateKey)) signerKeys.unshift(privateKey);
    } else {
        signerKeys = loadMultiKeyPrivateKeys(signaturesRequired);
    }

    if (signerKeys.length < signaturesRequired) {
        throw new EndlessAPIError(
            ErrorCode.ACCOUNT_INVALID_PRIVATE_KEY,
            `MultiKey 私钥数量不足: 需要 ${signaturesRequired}，实际 ${signerKeys.length}`,
            { required: signaturesRequired, provided: signerKeys.length }
        );
    }

    // 取前 signaturesRequired 个作为实际签名者
    const activeSignerKeys = signerKeys.slice(0, signaturesRequired);
    const signers = activeSignerKeys.map(k => accountFromPrivateKey(k));
    const signerPubKeys = signers.map(s => (s as any).publicKey);

    // 构造 MultiKey
    const allPublicKeys = explicitPublicKeys && explicitPublicKeys.length
        ? explicitPublicKeys.map(pk => new Ed25519PublicKey(pk.replace('0x', '') as HexInput))
        : signerPubKeys;

    if (allPublicKeys.length < signaturesRequired) {
        throw new EndlessAPIError(
            ErrorCode.ACCOUNT_INVALID_PRIVATE_KEY,
            `MultiKey 公钥数量不足`,
            { required: signaturesRequired, publicKeyCount: allPublicKeys.length }
        );
    }

    const multiKey = new MultiKey({
        publicKeys: allPublicKeys,
        signaturesRequired,
    });

    const multiKeyAccount = new MultiKeyAccount({ multiKey, signers });
    const normalizedAddress = await normalizeAddress(contractAddress);

    const data = await buildPayload(normalizedAddress, moduleName, functionName, functionArguments, typeArguments);
    const txOptions: InputGenerateTransactionOptions = {} as InputGenerateTransactionOptions;
    if (maxGasAmount !== undefined) (txOptions as any).maxGasAmount = maxGasAmount;
    if (gasUnitPrice !== undefined) (txOptions as any).gasUnitPrice = gasUnitPrice;

    try {
        return await withFailover("writeToContractMultiKey", async () => {
            const transaction = await endless.transaction.build.simple({
                sender: (multiKeyAccount as any).accountAddress,
                data,
                options: txOptions,
            });

            console.log(`[MultiKey] sender=${(multiKeyAccount as any).accountAddress.toString()} K=${signaturesRequired}/N=${allPublicKeys.length}`);

            const pending = await endless.signAndSubmitTransaction({ signer: multiKeyAccount as any, transaction });
            const result = await waitAndBuildResult(pending, { timeoutSecs: txTimeoutSecs });
            console.log(`[MultiKey] committed hash=${result.hash} status=${result.status}`);
            return result;
        });
    } catch (error) {
        console.error(`[MultiKey] Error:`, error);
        throw ErrorHandler.fromError(error, `MultiKey 写交易失败: ${normalizedAddress}::${moduleName}::${functionName}`);
    }
}

// ============================================================================
// 4.5. Multisig 写交易（执行已批准的多签提案）
// ============================================================================

/**
 * 执行一个已存储在链上的多签提案。
 *
 * 流程：
 *   1. 构造 TransactionPayloadMultiSig，仅包含 multisigAddress（payload 已通过 create_transaction 上链）。
 *   2. 以 owner 私钥签名并提交。
 *   3. VM 校验 approvals 后，以 multisig 账户身份执行存储的 payload。
 *
 * 参数：
 *   - privateKey:       发起执行的 owner 私钥（支付 Gas）。
 *   - multisigAddress: 多签账户地址。
 *   - maxGasAmount / gasUnitPrice / txTimeoutSecs: 可选交易参数。
 */
export async function writeMultisigTransaction(payload: {
    privateKey: string,
    multisigAddress: string,
    senderAddress?: string,
    maxGasAmount?: number,
    gasUnitPrice?: number,
    txTimeoutSecs?: number,
}) {
    const {
        privateKey, multisigAddress, senderAddress,
        maxGasAmount, gasUnitPrice, txTimeoutSecs,
    } = payload;

    if (!privateKey) throw ErrorHandler.validationError('privateKey', '私钥不能为空');
    if (!multisigAddress) throw ErrorHandler.validationError('multisigAddress', '多签账户地址不能为空');

    const normalizedMultisigAddr = await normalizeAddress(multisigAddress);
    const signer = accountFromPrivateKey(privateKey, senderAddress);
    const senderAddr: AccountAddress = (signer as any).accountAddress;

    // 构造 MultiSig payload：transaction_payload 留空，VM 从链上读取已存储的 payload
    const multisigPayload = new TransactionPayloadMultiSig(
        new MultiSig(AccountAddress.from(normalizedMultisigAddr as HexInput)),
    );

    const txOptions: InputGenerateTransactionOptions = {} as InputGenerateTransactionOptions;
    if (maxGasAmount !== undefined) (txOptions as any).maxGasAmount = maxGasAmount;
    if (gasUnitPrice !== undefined) (txOptions as any).gasUnitPrice = gasUnitPrice;

    try {
        return await withFailover("writeMultisigTransaction", async () => {
            // 直接使用 buildTransaction 绕过 generateTransaction（后者要求 entry function 路径），
            // 构造仅含 multisigAddress 的 payload，让 VM 从链上读取已存储的提案 payload。
            // 使用当前活跃 Endless 实例的 config，确保 chain ID 与网络一致。
            const activeConfig = (failoverClient.getActiveEndless() as any).config;
            const transaction = await buildTransaction({
                endlessConfig: activeConfig,
                sender: senderAddr,
                payload: multisigPayload,
                options: txOptions,
            });

            console.log(`[Multisig] multisig=${normalizedMultisigAddr} sender=${senderAddr.toString()}`);
            const pending = await endless.signAndSubmitTransaction({ signer, transaction });
            const result = await waitAndBuildResult(pending, { timeoutSecs: txTimeoutSecs });
            console.log(`[Multisig] committed hash=${result.hash} status=${result.status}`);
            return result;
        });
    } catch (error) {
        console.error(`[Multisig] Error:`, error);
        throw ErrorHandler.fromError(error, `Multisig 写交易失败: multisig=${normalizedMultisigAddr}`);
    }
}

// ============================================================================
// 5. 交易模拟
// ============================================================================

export async function simulateTransaction(payload: {
    senderPublicKey: string,
    contractAddress: string,
    moduleName: string,
    functionName: string,
    functionArguments: any[],
    typeArguments?: string[],
    senderAddress?: string,
    maxGasAmount?: number,
    gasUnitPrice?: number,
    secondarySignersPublicKeys?: string[],
}) {
    const {
        senderPublicKey, contractAddress, moduleName, functionName,
        functionArguments, typeArguments, senderAddress,
        maxGasAmount, gasUnitPrice, secondarySignersPublicKeys,
    } = payload;

    if (!senderPublicKey) throw ErrorHandler.validationError('senderPublicKey', '发送方公钥不能为空');
    if (!contractAddress) throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');

    const normalizedAddress = await normalizeAddress(contractAddress);
    const pubKey = new Ed25519PublicKey(senderPublicKey.replace('0x', '') as HexInput);

    const data = await buildPayload(normalizedAddress, moduleName, functionName, functionArguments, typeArguments);
    const txOptions: InputGenerateTransactionOptions = {} as InputGenerateTransactionOptions;
    if (maxGasAmount !== undefined) (txOptions as any).maxGasAmount = maxGasAmount;
    if (gasUnitPrice !== undefined) (txOptions as any).gasUnitPrice = gasUnitPrice;

    try {
        return await withFailover("simulateTransaction", async () => {
            const transaction = await endless.transaction.build.simple({
                sender: (senderAddress || normalizedAddress) as AccountAddressInput,
                data,
                options: txOptions,
            });

            console.log(`[Simulate] ${normalizedAddress}::${moduleName}::${functionName}`);

            const simulateOpts: any = { signerPublicKey: pubKey, transaction };
            if (secondarySignersPublicKeys && secondarySignersPublicKeys.length) {
                simulateOpts.secondarySignersPublicKeys = secondarySignersPublicKeys.map(
                    pk => new Ed25519PublicKey(pk.replace('0x', '') as HexInput)
                );
            }

            const results = await endless.transaction.simulate.simple(simulateOpts);
            return { simulations: results };
        });
    } catch (error) {
        console.error(`[Simulate] Error:`, error);
        throw ErrorHandler.fromError(error, `交易模拟失败: ${normalizedAddress}::${moduleName}::${functionName}`);
    }
}

// ============================================================================
// 6/7/8/9. 账户查询
// ============================================================================

export async function getAccountResources(address: string, options?: { ledgerVersion?: string | number; limit?: number; offset?: number }) {
    if (!address) throw ErrorHandler.validationError('address', '账户地址不能为空');
    const addr = await normalizeAddress(address);
    try {
        return await withFailover("getAccountResources", async () => {
            const opts: any = {};
            if (options?.ledgerVersion !== undefined) opts.ledgerVersion = options.ledgerVersion;
            if (options?.limit !== undefined) opts.limit = options.limit;
            if (options?.offset !== undefined) opts.offset = options.offset;
            const resources = await endless.getAccountResources({ accountAddress: addr, options: opts });
            return { address: addr, resources };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询账户资源失败: ${addr}`);
    }
}

export async function getAccountResource(payload: { address: string; resourceType: string; ledgerVersion?: string | number }) {
    if (!payload.address) throw ErrorHandler.validationError('address', '账户地址不能为空');
    if (!payload.resourceType) throw ErrorHandler.validationError('resourceType', '资源类型不能为空');
    const addr = await normalizeAddress(payload.address);
    try {
        return await withFailover("getAccountResource", async () => {
            const opts: any = {};
            if (payload.ledgerVersion !== undefined) opts.ledgerVersion = payload.ledgerVersion;
            const resource = await endless.getAccountResource<any>({
                accountAddress: addr,
                resourceType: payload.resourceType as any,
                options: opts,
            });
            return { address: addr, resourceType: payload.resourceType, resource };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询账户资源失败: ${addr} / ${payload.resourceType}`);
    }
}

export async function getAccountInfo(address: string) {
    if (!address) throw ErrorHandler.validationError('address', '账户地址不能为空');
    const addr = await normalizeAddress(address);
    try {
        return await withFailover("getAccountInfo", async () => {
            const info = await endless.getAccountInfo({ accountAddress: addr });
            return { address: addr, info };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询账户信息失败: ${addr}`);
    }
}

export async function getAccountModules(address: string, options?: { ledgerVersion?: string | number; limit?: number; offset?: number }) {
    if (!address) throw ErrorHandler.validationError('address', '账户地址不能为空');
    const addr = await normalizeAddress(address);
    try {
        return await withFailover("getAccountModules", async () => {
            const opts: any = {};
            if (options?.ledgerVersion !== undefined) opts.ledgerVersion = options.ledgerVersion;
            if (options?.limit !== undefined) opts.limit = options.limit;
            if (options?.offset !== undefined) opts.offset = options.offset;
            const modules = await endless.getAccountModules({ accountAddress: addr, options: opts });
            return { address: addr, modules };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询账户模块失败: ${addr}`);
    }
}

export async function getAccountModule(payload: { address: string; moduleName: string; ledgerVersion?: string | number }) {
    if (!payload.address) throw ErrorHandler.validationError('address', '账户地址不能为空');
    if (!payload.moduleName) throw ErrorHandler.validationError('moduleName', '模块名不能为空');
    const addr = await normalizeAddress(payload.address);
    try {
        return await withFailover("getAccountModule", async () => {
            const opts: any = {};
            if (payload.ledgerVersion !== undefined) opts.ledgerVersion = payload.ledgerVersion;
            const module = await endless.getAccountModule({ accountAddress: addr, moduleName: payload.moduleName, options: opts });
            return { address: addr, moduleName: payload.moduleName, module };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询账户模块失败: ${addr}::${payload.moduleName}`);
    }
}

// ============================================================================
// 10/11/12. 交易查询
// ============================================================================

export async function getTransactionByHash(txnHash: string) {
    if (!txnHash) throw ErrorHandler.validationError('txnHash', '交易哈希不能为空');
    try {
        return await withFailover("getTransactionByHash", async () => {
            const txn = await endless.getTransactionByHash({ transactionHash: txnHash });
            return { hash: txnHash, transaction: txn };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询交易失败: ${txnHash}`);
    }
}

export async function getTransactionByVersion(version: string | number) {
    if (version === undefined || version === null) throw ErrorHandler.validationError('version', 'version 不能为空');
    try {
        return await withFailover("getTransactionByVersion", async () => {
            const txn = await endless.getTransactionByVersion({ ledgerVersion: version as any });
            return { version: String(version), transaction: txn };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询交易失败: version=${version}`);
    }
}

export async function waitForTransaction(payload: { txnHash: string; timeoutSecs?: number; checkSuccess?: boolean }) {
    if (!payload.txnHash) throw ErrorHandler.validationError('txnHash', '交易哈希不能为空');
    try {
        return await withFailover("waitForTransaction", async () => {
            const committed = await endless.waitForTransaction({
                transactionHash: payload.txnHash,
                options: {
                    timeoutSecs: payload.timeoutSecs ?? 60,
                    checkSuccess: payload.checkSuccess ?? true,
                },
            } as any);
            const c: any = committed;
            const isSuccess = c.success ?? (c.vm_status === "Executed successfully");
            return {
                hash: c.hash,
                success: isSuccess,
                status: isSuccess ? "success" : "failed",
                vm_status: c.vm_status,
                vmStatus: c.vm_status,
                gas_used: typeof c.gas_used === 'string' ? Number(c.gas_used) : c.gas_used,
                gasUsed: typeof c.gas_used === 'string' ? Number(c.gas_used) : c.gas_used,
            };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `等待交易失败: ${payload.txnHash}`);
    }
}

export async function isPendingTransaction(txnHash: string) {
    if (!txnHash) throw ErrorHandler.validationError('txnHash', '交易哈希不能为空');
    try {
        return await withFailover("isPendingTransaction", async () => {
            const pending = await endless.isPendingTransaction({ transactionHash: txnHash });
            return { hash: txnHash, pending };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询交易状态失败: ${txnHash}`);
    }
}

// ============================================================================
// 13/14/15. 事件查询
// ============================================================================

export async function getAccountEventsByCreationNumber(payload: {
    accountAddress: string,
    creationNumber: string | number,
    minimumLedgerVersion?: string | number,
}) {
    if (!payload.accountAddress) throw ErrorHandler.validationError('accountAddress', '账户地址不能为空');
    if (payload.creationNumber === undefined) throw ErrorHandler.validationError('creationNumber', 'creationNumber 不能为空');
    const addr = await normalizeAddress(payload.accountAddress);
    try {
        return await withFailover("getAccountEventsByCreationNumber", async () => {
            const opts: any = {};
            if (payload.minimumLedgerVersion !== undefined) opts.minimumLedgerVersion = payload.minimumLedgerVersion;
            const events = await endless.getAccountEventsByCreationNumber({
                accountAddress: addr,
                creationNumber: payload.creationNumber,
                ...opts,
            });
            return { accountAddress: addr, creationNumber: payload.creationNumber, events, count: events.length };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询账户事件失败: ${addr} / creation_number=${payload.creationNumber}`);
    }
}

export async function getAccountEventsByEventType(payload: {
    accountAddress: string,
    eventType: string,
    minimumLedgerVersion?: string | number,
}) {
    if (!payload.accountAddress) throw ErrorHandler.validationError('accountAddress', '账户地址不能为空');
    if (!payload.eventType) throw ErrorHandler.validationError('eventType', '事件类型不能为空');
    const addr = await normalizeAddress(payload.accountAddress);
    try {
        return await withFailover("getAccountEventsByEventType", async () => {
            const opts: any = {};
            if (payload.minimumLedgerVersion !== undefined) opts.minimumLedgerVersion = payload.minimumLedgerVersion;
            const events = await endless.getAccountEventsByEventType({
                accountAddress: addr,
                eventType: payload.eventType,
                ...opts,
            });
            return { accountAddress: addr, eventType: payload.eventType, events, count: events.length };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询账户事件失败: ${addr} / type=${payload.eventType}`);
    }
}

export async function getModuleEventsByEventType(payload: {
    eventType: string,
    minimumLedgerVersion?: string | number,
}) {
    if (!payload.eventType) throw ErrorHandler.validationError('eventType', '事件类型不能为空');
    try {
        return await withFailover("getModuleEventsByEventType", async () => {
            const opts: any = {};
            if (payload.minimumLedgerVersion !== undefined) opts.minimumLedgerVersion = payload.minimumLedgerVersion;
            const events = await endless.getModuleEventsByEventType({
                eventType: payload.eventType,
                ...opts,
            });
            return { eventType: payload.eventType, events, count: events.length };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, `查询模块事件失败: type=${payload.eventType}`);
    }
}

// 兼容旧版 queryEvents（按 account + module + creationNum）
export async function queryEvents(
    contractAddress: string,
    _moduleName: string,
    creationNum: string
) {
    return getAccountEventsByCreationNumber({
        accountAddress: contractAddress,
        creationNumber: creationNum,
    });
}

// ============================================================================
// 16/17. 健康检查与 Gas 估算
// ============================================================================

export async function checkRpcHealth() {
    const cfg = getCurrentNetworkConfig();
    try {
        return await withFailover("checkRpcHealth", async () => {
            const ledger = await endless.getLedgerInfo();
            return {
                ok: true,
                network: cfg.network,
                base: cfg.activeUrl,
                chainId: ledger.chain_id,
                epoch: ledger.epoch,
                ledgerVersion: ledger.ledger_version,
                blockHeight: ledger.block_height,
                timestamp: new Date().toISOString(),
            };
        });
    } catch (error) {
        const apiError = ErrorHandler.fromError(error, 'RPC 健康检查失败');
        return {
            ok: false,
            network: cfg.network,
            base: cfg.activeUrl,
            error: error instanceof Error ? error.message : String(error),
            errorCode: apiError.code,
            errorType: apiError.name,
            timestamp: new Date().toISOString(),
        };
    }
}

export async function getGasPriceEstimation() {
    try {
        return await withFailover("getGasPriceEstimation", async () => {
            const estimation = await endless.getGasPriceEstimation();
            return { estimation };
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, 'Gas 价格估算失败');
    }
}

// ============================================================================
// 18. 发布 Move 包
// ============================================================================

export async function publishPackage(payload: {
    senderPrivateKey: string,
    senderAddress?: string,
    metadataBytes: string,
    moduleBytecode: string[],
    maxGasAmount?: number,
    gasUnitPrice?: number,
    txTimeoutSecs?: number,
}) {
    const { senderPrivateKey, senderAddress, metadataBytes, moduleBytecode } = payload;
    if (!senderPrivateKey) throw ErrorHandler.validationError('senderPrivateKey', '发送方私钥不能为空');
    if (!metadataBytes) throw ErrorHandler.validationError('metadataBytes', 'metadataBytes 不能为空');
    if (!Array.isArray(moduleBytecode) || moduleBytecode.length === 0) {
        throw ErrorHandler.validationError('moduleBytecode', 'moduleBytecode 必须是非空数组');
    }

    const signer = accountFromPrivateKey(senderPrivateKey, senderAddress);

    try {
        return await withFailover("publishPackage", async () => {
            const transaction = await endless.publishPackageTransaction({
                account: (signer as any).accountAddress,
                metadataBytes,
                moduleBytecode,
            });
            const pending = await endless.signAndSubmitTransaction({ signer, transaction });
            const result = await waitAndBuildResult(pending, { timeoutSecs: payload.txTimeoutSecs });
            return result;
        });
    } catch (error) {
        throw ErrorHandler.fromError(error, '发布 Move 包失败');
    }
}

// ============================================================================
// 19. BCS 工具（供 bcs_stream 测试使用）
// ============================================================================

/**
 * 通过 SDK 的 simulate + view 完成 BCS 编解码验证。
 * 这里提供一个轻量入口：将任意 Move 值通过 view 函数回读，得到反序列化结果。
 * BCS 序列化已完全迁移至 TS 端，见下方 encodeEntryFunctionPayload。
 */
export async function bcsRoundTripProbe(payload: {
    contractAddress: string,
    moduleName: string,
    functionName: string,
    args: any[],
    typeArgs?: string[],
}) {
    return readContractState(payload);
}

/**
 * 将 entry function 调用编码为 BCS 字节串（hex 格式）。
 *
 * 替代 Python 端 EndlessContract.encode_entry_function_payload（aptos_sdk.bcs 实现）。
 * 支持两种参数转换路径：
 *   1. 显式 argTypes：用 parseTypeTag 解析每个类型字符串，再用 checkOrConvertArgument
 *      转换 args（无需链上 ABI，适合离线场景）。
 *   2. 缺失 argTypes：fetchEntryFunctionAbi 拉取链上 ABI，再用 convertArgument 自动推断
 *      （要求函数已上链发布）。
 *
 * @param functionPath 完整函数路径 "0x1::endless_coin::transfer"
 * @param functionArguments 参数值列表（camelCase，对齐 SDK 命名）
 * @param args 向后兼容旧字段名（等价于 functionArguments）
 * @param typeArguments 类型参数（泛型），如 ["0x1::endless_coin::EndlessCoin"]
 * @param argTypes 参数类型字符串列表，如 ["address", "u128", "vector<u8>"]
 * @returns {"payloadHex": "0x..."} EntryFunction BCS 字节串
 */
export async function encodeEntryFunctionPayload(payload: {
    functionPath: string,
    functionArguments?: any[],
    args?: any[],
    typeArguments?: string[],
    argTypes?: string[],
}): Promise<{ payloadHex: string }> {
    const {
        functionPath,
        functionArguments,
        args: legacyArgs,
        typeArguments,
        argTypes,
    } = payload;

    const rawArgs = (functionArguments ?? legacyArgs ?? []) as any[];

    // 解析函数路径
    const parts = functionPath.split('::');
    if (parts.length !== 3) {
        throw ErrorHandler.validationError(
            'functionPath',
            `function 路径格式错误，期望 'addr::module::func'，实际: ${functionPath}`,
        );
    }
    const [moduleAddr, moduleName, funcName] = parts;

    // 解析 type arguments → TypeTag[]
    const typeTags: any[] = [];
    for (const ta of (typeArguments ?? [])) {
        try {
            typeTags.push(parseTypeTag(ta, { allowGenerics: true }));
        } catch (e) {
            // 跳过无法解析的类型参数（与 Python 端行为一致）
        }
    }

    // 转换 args → EntryFunctionArgument[]
    const argTypesResolved = argTypes ?? [];
    const hasAllArgTypes = argTypesResolved.length > 0 && argTypesResolved.length >= rawArgs.length;

    let convertedArgs: any[];
    if (hasAllArgTypes) {
        // 路径1：显式 argTypes，无需链上 ABI
        convertedArgs = rawArgs.map((arg, idx) => {
            const typeStr = argTypesResolved[idx];
            const typeTag = parseTypeTag(typeStr, { allowGenerics: true });
            return checkOrConvertArgument(arg, typeTag, idx, typeTags);
        });
    } else {
        // 路径2：拉取链上 ABI 自动推断
        // 注意：fetchEntryFunctionAbi 返回的 parameters 已经剔除了 signer 参数，
        // convertArgument 的 position 直接索引该数组，因此此处传入 idx 即可，
        // 切勿再叠加 abi.signers（会导致越界抛 "Too many arguments"）。
        const abi = await fetchEntryFunctionAbi(moduleAddr, moduleName, funcName, endlessConfig);
        convertedArgs = rawArgs.map((arg, idx) => convertArgument(funcName, abi, arg, idx, typeTags));
    }

    // 构造 EntryFunction 并序列化
    const moduleStr = `${moduleAddr}::${moduleName}` as `${string}::${string}`;
    const ef = EntryFunction.build(moduleStr, funcName, typeTags, convertedArgs);
    const serializer = new Serializer();
    ef.serialize(serializer);
    const bytes = serializer.toUint8Array();
    const hex = '0x' + Buffer.from(bytes).toString('hex');
    return { payloadHex: hex };
}

/**
 * 将 EntryFunction 包装为 MultiSigTransactionPayload 并序列化。
 *
 * 多签提案存储在链上的 payload 需要是 MultiSigTransactionPayload BCS 格式
 * （ULEB128 variant tag 0 + EntryFunction BCS），而非裸 EntryFunction BCS。
 * VM 执行多签交易时会以此格式反序列化存储的 payload。
 *
 * 参数与 encodeEntryFunctionPayload 相同，返回包装后的 BCS hex。
 */
export async function encodeMultisigPayload(payload: {
    functionPath: string,
    functionArguments?: any[],
    args?: any[],
    typeArguments?: string[],
    argTypes?: string[],
}): Promise<{ payloadHex: string }> {
    const { functionPath, functionArguments, args: legacyArgs, typeArguments, argTypes } = payload;

    const parts = functionPath.split('::');
    if (parts.length !== 3) {
        throw ErrorHandler.validationError(
            'functionPath',
            `function 路径格式错误，期望 'addr::module::func'，实际: ${functionPath}`,
        );
    }
    const [moduleAddr, moduleName, funcName] = parts;

    const typeTags: any[] = [];
    for (const ta of (typeArguments ?? [])) {
        try { typeTags.push(parseTypeTag(ta, { allowGenerics: true })); } catch { /* skip */ }
    }

    const rawArgs = (functionArguments ?? legacyArgs ?? []) as any[];
    const argTypesResolved = argTypes ?? [];
    const hasAllArgTypes = argTypesResolved.length > 0 && argTypesResolved.length >= rawArgs.length;

    let convertedArgs: any[];
    if (hasAllArgTypes) {
        convertedArgs = rawArgs.map((arg, idx) => {
            const typeTag = parseTypeTag(argTypesResolved[idx], { allowGenerics: true });
            return checkOrConvertArgument(arg, typeTag, idx, typeTags);
        });
    } else {
        const abi = await fetchEntryFunctionAbi(moduleAddr, moduleName, funcName, endlessConfig);
        convertedArgs = rawArgs.map((arg, idx) => convertArgument(funcName, abi, arg, idx, typeTags));
    }

    const moduleStr = `${moduleAddr}::${moduleName}` as `${string}::${string}`;
    const ef = EntryFunction.build(moduleStr, funcName, typeTags, convertedArgs);

    // 包装为 MultiSigTransactionPayload：ULEB128(0) + EntryFunction BCS
    const serializer = new Serializer();
    serializer.serializeU32AsUleb128(0); // variant 0 = EntryFunction
    ef.serialize(serializer);
    const bytes = serializer.toUint8Array();
    const hex = '0x' + Buffer.from(bytes).toString('hex');
    return { payloadHex: hex };
}

// ============================================================================
// 20. 账户生成与地址工具
// ============================================================================

/**
 * 生成新的 Ed25519 密钥对（对应 Python aptos_sdk.account.Account.generate）。
 * 返回 hex 地址、base58 地址、私钥、公钥。
 */
export function generateAccount() {
    try {
        const privateKeyInstance = Ed25519PrivateKey.generate();
        const publicKeyInstance = privateKeyInstance.publicKey();
        const account = Account.fromPrivateKey({ privateKey: privateKeyInstance, legacy: true }) as unknown as Account;
        const addr = (account as any).accountAddress as AccountAddress;

        const privateKeyHex = privateKeyInstance.toString();
        const publicKeyHex = publicKeyInstance.toString();
        const addressHex = addr.toString();
        const addressBs58 = addr.toBs58String();

        return {
            addressHex,
            addressBase58: addressBs58,
            privateKey: privateKeyHex,
            publicKey: publicKeyHex,
        };
    } catch (error) {
        throw ErrorHandler.fromError(error, '生成账户失败');
    }
}

/**
 * 从私钥推导账户信息（对应 Python aptos_sdk.account.Account.load_key）。
 * 返回 hex 地址、base58 地址、公钥。
 */
export function accountInfoFromPrivateKey(privateKey: string) {
    if (!privateKey) throw ErrorHandler.validationError('privateKey', '私钥不能为空');
    const account = accountFromPrivateKey(privateKey);
    const addr = (account as any).accountAddress as AccountAddress;
    const publicKeyInstance = (account as any).signingKey?.publicKey();
    return {
        addressHex: addr.toString(),
        addressBase58: addr.toBs58String(),
        publicKey: publicKeyInstance ? publicKeyInstance.toString() : undefined,
    };
}

/**
 * 地址规范化（Base58 → Hex 或 Hex 标准化）。
 * 对应 Python EndlessContract._normalize_address。
 */
export async function normalizeAddressEndpoint(address: string) {
    if (!address) throw ErrorHandler.validationError('address', '地址不能为空');
    const normalized = await normalizeAddress(address);
    let addressBase58: string | undefined;
    try {
        addressBase58 = AccountAddress.from(normalized as HexInput).toBs58String();
    } catch (_) {
        // ignore base58 conversion failure
    }
    return {
        addressHex: normalized,
        addressBase58,
        original: address,
    };
}

// 导出共享的 endless 实例（供 server.ts 或外部使用）
export { endless, endlessConfig };
