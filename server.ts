// server.ts
//
// Endless TS Sidecar HTTP Server
// 基于 Express，将 contractService 的能力暴露为 HTTP API 给 Python 测试调用。
//
// 端点总览：
//   健康检查
//     GET  /api/health
//     GET  /api/ledger
//
//   合约读取
//     GET  /api/read                          view 函数
//     POST /api/read                          view 函数（参数通过 body）
//
//   合约写入
//     POST /api/write                         单签写
//     POST /api/write/multi-agent              Multi-Agent 写
//     POST /api/write/multi-key                MultiKey 写
//     POST /api/simulate                       交易模拟
//     POST /api/publish-package                发布 Move 包
//
//   账户查询
//     GET  /api/accounts/:address/resources    账户资源列表
//     GET  /api/accounts/:address/resource     账户单个资源 ?resourceType=...
//     GET  /api/accounts/:address/info         账户信息
//     GET  /api/accounts/:address/modules      账户模块列表
//     GET  /api/accounts/:address/module       账户单个模块 ?moduleName=...
//
//   交易查询
//     GET  /api/transactions/:hash             按 hash 查交易
//     GET  /api/transactions/version/:version 按 version 查交易
//     GET  /api/transactions/:hash/wait        等待交易确认
//     GET  /api/transactions/:hash/pending     是否在 pending
//
//   事件查询
//     GET  /api/events/account/creation        按账户 + creationNumber 查事件
//     GET  /api/events/account/type            按账户 + eventType 查事件
//     GET  /api/events/module/type             按 eventType 全局查事件
//     GET  /api/events                          兼容旧入口（按 account + creation_number）
//
//   其他
//     GET  /api/gas-price                       Gas 价格估算
//     POST /api/bcs/probe                       BCS 往返校验
//     POST /api/bcs/encode-entry-function       EntryFunction BCS 编码
//
//   账户生成与地址工具
//     POST /api/account/generate                生成新密钥对
//     POST /api/account/from-private-key        由私钥推导账户信息
//     POST /api/address/normalize               地址规范化（Base58→Hex）
//     GET  /api/address/normalize               地址规范化（GET 形式）

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import swaggerUi from 'swagger-ui-express';
import swaggerSpecDynamic from './swagger.config';
import { logRequestResponse } from './logger';
import {
    readContractState,
    writeToContract,
    writeToContractMultiAgent,
    writeToContractMultiKey,
    writeMultisigTransaction,
    simulateTransaction,
    publishPackage,
    bcsRoundTripProbe,
    getAccountResources,
    getAccountResource,
    getAccountInfo,
    getAccountModules,
    getAccountModule,
    getTransactionByHash,
    getTransactionByVersion,
    waitForTransaction,
    isPendingTransaction,
    getAccountEventsByCreationNumber,
    getAccountEventsByEventType,
    getModuleEventsByEventType,
    checkRpcHealth,
    getGasPriceEstimation,
    generateAccount,
    accountInfoFromPrivateKey,
    normalizeAddressEndpoint,
    encodeEntryFunctionPayload,
    encodeMultisigPayload,
    getCurrentNetworkConfig,
    switchNetwork,
} from './contractService';
import { EndlessAPIError, ErrorHandler } from './errorDefinitions';

dotenv.config();

const app = express();
const PORT = Number(process.env.ENDLESS_SIDECAR_PORT || process.env.PORT || 3001);

function loadSwaggerSpec(): any {
    const staticPath = path.join(__dirname, 'swagger.json');
    if (fs.existsSync(staticPath)) {
        return JSON.parse(fs.readFileSync(staticPath, 'utf-8'));
    }
    return swaggerSpecDynamic;
}
const swaggerSpec = loadSwaggerSpec();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static('public'));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/swagger.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
});

// ----------------------------------------------------------------------------
// 请求日志 + 错误处理中间件
// ----------------------------------------------------------------------------

const SKIP_LOG_PATHS = ['/api/health', '/api/ledger', '/swagger.json'];
const SKIP_LOG_PREFIXES = ['/api-docs'];

function shouldSkipLog(url: string): boolean {
    if (SKIP_LOG_PATHS.includes(url)) return true;
    return SKIP_LOG_PREFIXES.some(prefix => url.startsWith(prefix));
}

function asyncHandler(
    fn: (req: Request, res: Response) => Promise<any>
) {
    return async (req: Request, res: Response, _next: NextFunction) => {
        const startTime = Date.now();
        const originalSend = res.send.bind(res);
        const originalJson = res.json.bind(res);
        let responseBody: any = null;

        res.json = function (body: any) {
            responseBody = body;
            return originalJson(body);
        };

        res.send = function (body: any) {
            responseBody = body;
            return originalSend(body);
        };

        try {
            const result = await fn(req, res);
            if (!res.headersSent) {
                res.json(result);
            }
        } catch (error) {
            const apiError = error instanceof EndlessAPIError
                ? error
                : ErrorHandler.fromError(error);
            const httpCode = ErrorHandler.getHttpStatusCode(apiError);
            console.error(`[Error] ${req.method} ${req.originalUrl} -> ${httpCode}`, apiError);
            if (!res.headersSent) {
                responseBody = apiError.toJSON();
                res.status(httpCode).json(responseBody);
            }
        } finally {
            if (shouldSkipLog(req.originalUrl)) return;

            const durationMs = Date.now() - startTime;
            const filteredHeaders: Record<string, string> = {};
            Object.keys(req.headers).forEach(key => {
                if (!['authorization', 'cookie'].includes(key.toLowerCase())) {
                    filteredHeaders[key] = String(req.headers[key]);
                }
            });

            logRequestResponse(
                req.method,
                req.originalUrl,
                res.statusCode,
                {
                    headers: filteredHeaders,
                    query: req.query,
                    body: req.body,
                    params: req.params,
                },
                responseBody,
                durationMs
            );
        }
    };
}

// ----------------------------------------------------------------------------
// 解析工具
// ----------------------------------------------------------------------------

function parseJsonArg(value: any, name: string): any[] {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value); }
        catch (e) {
            throw ErrorHandler.validationError(name, `无法解析为 JSON 数组: ${value}`);
        }
    }
    return [value];
}

function toNumber(value: any, name: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    if (Number.isNaN(n)) throw ErrorHandler.validationError(name, `不是合法数字: ${value}`);
    return n;
}

/**
 * 将 express query 值（string | ParsedQs | 数组）规范化为 string | undefined。
 */
function toStr(value: any): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return String(value[0]);
    return String(value);
}

// ----------------------------------------------------------------------------
// 健康检查
// ----------------------------------------------------------------------------

app.get('/api/health', asyncHandler(async (_req, _res) => {
    return await checkRpcHealth();
}));

app.get('/api/ledger', asyncHandler(async (_req, _res) => {
    return await checkRpcHealth();
}));

// ----------------------------------------------------------------------------
// 网络管理（运行时切换）
// ----------------------------------------------------------------------------

function adminAuth(req: Request, res: Response, next: NextFunction) {
    const token = process.env.ADMIN_TOKEN;
    if (!token) return next();
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}`) {
        res.status(401).json({
            error: { code: 401, message: 'Unauthorized: 无效的 ADMIN_TOKEN', timestamp: new Date().toISOString() },
        });
        return;
    }
    next();
}

app.get('/admin/network', asyncHandler(async (_req, _res) => {
    return getCurrentNetworkConfig();
}));

app.post('/admin/network', adminAuth, asyncHandler(async (req, _res) => {
    const b = req.body || {};
    if (!b.network) throw ErrorHandler.validationError('network', 'network 不能为空');
    return switchNetwork({
        network: String(b.network),
        url: b.url ? String(b.url) : undefined,
        endpoints: b.endpoints,
        skipProbe: b.skipProbe === true,
    });
}));

// ----------------------------------------------------------------------------
// 合约读取
// ----------------------------------------------------------------------------

async function handleRead(req: Request) {
    const source = req.method === 'GET' ? req.query : req.body;
    return readContractState({
        contractAddress: String(source.contractAddress || source.contract_address || ''),
        moduleName: String(source.moduleName || source.module_name || ''),
        functionName: String(source.functionName || source.function_name || ''),
        args: parseJsonArg(source.args || source.arguments, 'args'),
        typeArgs: parseJsonArg(source.typeArgs || source.typeArguments || source.type_arguments, 'typeArgs'),
        ledgerVersion: source.ledgerVersion ?? source.ledger_version,
    });
}

app.get('/api/read', asyncHandler(handleRead));
app.post('/api/read', asyncHandler(handleRead));

// ----------------------------------------------------------------------------
// 合约写入
// ----------------------------------------------------------------------------

app.post('/api/write', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    return writeToContract({
        privateKey: b.privateKey ?? b.private_key,
        contractAddress: b.contractAddress ?? b.contract_address,
        moduleName: b.moduleName ?? b.module_name,
        functionName: b.functionName ?? b.function_name,
        functionArguments: b.functionArguments ?? b.function_arguments ?? b.args ?? [],
        typeArguments: b.typeArguments ?? b.type_arguments,
        senderAddress: b.senderAddress ?? b.sender_address,
        maxGasAmount: toNumber(b.maxGasAmount ?? b.max_gas_amount, 'maxGasAmount'),
        gasUnitPrice: toNumber(b.gasUnitPrice ?? b.gas_unit_price, 'gasUnitPrice'),
        txTimeoutSecs: toNumber(b.txTimeoutSecs ?? b.tx_timeout_secs, 'txTimeoutSecs'),
        options: b.options,
    });
}));

app.post('/api/write/multi-agent', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    return writeToContractMultiAgent({
        senderPrivateKey: b.senderPrivateKey ?? b.sender_private_key,
        senderAddress: b.senderAddress ?? b.sender_address,
        contractAddress: b.contractAddress ?? b.contract_address,
        moduleName: b.moduleName ?? b.module_name,
        functionName: b.functionName ?? b.function_name,
        functionArguments: b.functionArguments ?? b.function_arguments ?? b.args ?? [],
        typeArguments: b.typeArguments ?? b.type_arguments,
        secondarySigners: b.secondarySigners ?? b.secondary_signers ?? [],
        maxGasAmount: toNumber(b.maxGasAmount ?? b.max_gas_amount, 'maxGasAmount'),
        gasUnitPrice: toNumber(b.gasUnitPrice ?? b.gas_unit_price, 'gasUnitPrice'),
        txTimeoutSecs: toNumber(b.txTimeoutSecs ?? b.tx_timeout_secs, 'txTimeoutSecs'),
    });
}));

app.post('/api/write/multi-key', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    return writeToContractMultiKey({
        privateKey: b.privateKey ?? b.private_key,
        signerPrivateKeys: b.signerPrivateKeys ?? b.signer_private_keys,
        signaturesRequired: Number(b.signaturesRequired ?? b.signatures_required),
        publicKeys: b.publicKeys ?? b.public_keys,
        contractAddress: b.contractAddress ?? b.contract_address,
        moduleName: b.moduleName ?? b.module_name,
        functionName: b.functionName ?? b.function_name,
        functionArguments: b.functionArguments ?? b.function_arguments ?? b.args ?? [],
        typeArguments: b.typeArguments ?? b.type_arguments,
        maxGasAmount: toNumber(b.maxGasAmount ?? b.max_gas_amount, 'maxGasAmount'),
        gasUnitPrice: toNumber(b.gasUnitPrice ?? b.gas_unit_price, 'gasUnitPrice'),
        txTimeoutSecs: toNumber(b.txTimeoutSecs ?? b.tx_timeout_secs, 'txTimeoutSecs'),
    });
}));

app.post('/api/simulate', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    return simulateTransaction({
        senderPublicKey: b.senderPublicKey ?? b.sender_public_key,
        contractAddress: b.contractAddress ?? b.contract_address,
        moduleName: b.moduleName ?? b.module_name,
        functionName: b.functionName ?? b.function_name,
        functionArguments: b.functionArguments ?? b.function_arguments ?? b.args ?? [],
        typeArguments: b.typeArguments ?? b.type_arguments,
        senderAddress: b.senderAddress ?? b.sender_address,
        maxGasAmount: toNumber(b.maxGasAmount ?? b.max_gas_amount, 'maxGasAmount'),
        gasUnitPrice: toNumber(b.gasUnitPrice ?? b.gas_unit_price, 'gasUnitPrice'),
        secondarySignersPublicKeys: b.secondarySignersPublicKeys ?? b.secondary_signers_public_keys,
    });
}));

app.post('/api/write/multisig', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    return writeMultisigTransaction({
        privateKey: b.privateKey ?? b.private_key,
        multisigAddress: b.multisigAddress ?? b.multisig_address,
        senderAddress: b.senderAddress ?? b.sender_address,
        maxGasAmount: toNumber(b.maxGasAmount ?? b.max_gas_amount, 'maxGasAmount'),
        gasUnitPrice: toNumber(b.gasUnitPrice ?? b.gas_unit_price, 'gasUnitPrice'),
        txTimeoutSecs: toNumber(b.txTimeoutSecs ?? b.tx_timeout_secs, 'txTimeoutSecs'),
    });
}));

app.post('/api/publish-package', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    return publishPackage({
        senderPrivateKey: b.senderPrivateKey ?? b.sender_private_key,
        senderAddress: b.senderAddress ?? b.sender_address,
        metadataBytes: b.metadataBytes ?? b.metadata_bytes,
        moduleBytecode: b.moduleBytecode ?? b.module_bytecode,
        maxGasAmount: toNumber(b.maxGasAmount ?? b.max_gas_amount, 'maxGasAmount'),
        gasUnitPrice: toNumber(b.gasUnitPrice ?? b.gas_unit_price, 'gasUnitPrice'),
        txTimeoutSecs: toNumber(b.txTimeoutSecs ?? b.tx_timeout_secs, 'txTimeoutSecs'),
    });
}));

// ----------------------------------------------------------------------------
// 账户查询
// ----------------------------------------------------------------------------

app.get('/api/accounts/:address/resources', asyncHandler(async (req, _res) => {
    return getAccountResources(req.params.address, {
        ledgerVersion: toStr(req.query.ledgerVersion ?? req.query.ledger_version),
        limit: toNumber(req.query.limit, 'limit'),
        offset: toNumber(req.query.offset, 'offset'),
    });
}));

app.get('/api/accounts/:address/resource', asyncHandler(async (req, _res) => {
    const resourceType = String(req.query.resourceType ?? req.query.resource_type ?? '');
    if (!resourceType) throw ErrorHandler.missingParameterError('resourceType');
    return getAccountResource({
        address: req.params.address,
        resourceType,
        ledgerVersion: toStr(req.query.ledgerVersion ?? req.query.ledger_version),
    });
}));

app.get('/api/accounts/:address/info', asyncHandler(async (req, _res) => {
    return getAccountInfo(req.params.address);
}));

app.get('/api/accounts/:address/modules', asyncHandler(async (req, _res) => {
    return getAccountModules(req.params.address, {
        ledgerVersion: toStr(req.query.ledgerVersion ?? req.query.ledger_version),
        limit: toNumber(req.query.limit, 'limit'),
        offset: toNumber(req.query.offset, 'offset'),
    });
}));

app.get('/api/accounts/:address/module', asyncHandler(async (req, _res) => {
    const moduleName = String(req.query.moduleName ?? req.query.module_name ?? '');
    if (!moduleName) throw ErrorHandler.missingParameterError('moduleName');
    return getAccountModule({
        address: req.params.address,
        moduleName,
        ledgerVersion: toStr(req.query.ledgerVersion ?? req.query.ledger_version),
    });
}));

// ----------------------------------------------------------------------------
// 交易查询
// ----------------------------------------------------------------------------

app.get('/api/transactions/:hash', asyncHandler(async (req, _res) => {
    return getTransactionByHash(req.params.hash);
}));

app.get('/api/transactions/version/:version', asyncHandler(async (req, _res) => {
    return getTransactionByVersion(req.params.version);
}));

app.get('/api/transactions/:hash/wait', asyncHandler(async (req, _res) => {
    return waitForTransaction({
        txnHash: req.params.hash,
        timeoutSecs: toNumber(req.query.timeoutSecs ?? req.query.timeout_secs, 'timeoutSecs'),
        checkSuccess: req.query.checkSuccess === 'true' || req.query.check_success === 'true' || req.query.checkSuccess === undefined ? true : false,
    });
}));

app.get('/api/transactions/:hash/pending', asyncHandler(async (req, _res) => {
    return isPendingTransaction(req.params.hash);
}));

// ----------------------------------------------------------------------------
// 事件查询
// ----------------------------------------------------------------------------

app.get('/api/events/account/creation', asyncHandler(async (req, _res) => {
    const q = req.query;
    const accountAddress = String(q.accountAddress ?? q.account_address ?? '');
    const creationNumber = toStr(q.creationNumber ?? q.creation_number);
    if (!accountAddress) throw ErrorHandler.missingParameterError('accountAddress');
    if (!creationNumber) throw ErrorHandler.missingParameterError('creationNumber');
    return getAccountEventsByCreationNumber({
        accountAddress,
        creationNumber,
        minimumLedgerVersion: toStr(q.minimumLedgerVersion ?? q.minimum_ledger_version),
    });
}));

app.get('/api/events/account/type', asyncHandler(async (req, _res) => {
    const q = req.query;
    const accountAddress = String(q.accountAddress ?? q.account_address ?? '');
    const eventType = String(q.eventType ?? q.event_type ?? '');
    if (!accountAddress) throw ErrorHandler.missingParameterError('accountAddress');
    if (!eventType) throw ErrorHandler.missingParameterError('eventType');
    return getAccountEventsByEventType({
        accountAddress,
        eventType,
        minimumLedgerVersion: toStr(q.minimumLedgerVersion ?? q.minimum_ledger_version),
    });
}));

app.get('/api/events/module/type', asyncHandler(async (req, _res) => {
    const q = req.query;
    const eventType = String(q.eventType ?? q.event_type ?? '');
    if (!eventType) throw ErrorHandler.missingParameterError('eventType');
    return getModuleEventsByEventType({
        eventType,
        minimumLedgerVersion: toStr(q.minimumLedgerVersion ?? q.minimum_ledger_version),
    });
}));

// 兼容旧版 /api/events?contractAddress=&moduleName=&creationNum=
app.get('/api/events', asyncHandler(async (req, _res) => {
    const q = req.query;
    const contractAddress = String(q.contractAddress ?? q.contract_address ?? '');
    const creationNum = String(q.creationNum ?? q.creation_num ?? '');
    if (!contractAddress) throw ErrorHandler.missingParameterError('contractAddress');
    if (!creationNum) throw ErrorHandler.missingParameterError('creationNum');
    return getAccountEventsByCreationNumber({
        accountAddress: contractAddress,
        creationNumber: creationNum,
    });
}));

// ----------------------------------------------------------------------------
// 其他
// ----------------------------------------------------------------------------

app.get('/api/gas-price', asyncHandler(async (_req, _res) => {
    return getGasPriceEstimation();
}));

app.post('/api/bcs/probe', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    return bcsRoundTripProbe({
        contractAddress: b.contractAddress ?? b.contract_address,
        moduleName: b.moduleName ?? b.module_name,
        functionName: b.functionName ?? b.function_name,
        args: b.args ?? [],
        typeArgs: b.typeArgs ?? b.type_args,
    });
}));

app.post('/api/bcs/encode-entry-function', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    const functionPath = b.functionPath ?? b.function_path ?? b.function;
    if (!functionPath) {
        throw ErrorHandler.validationError('functionPath', 'function 路径不能为空');
    }
    return encodeEntryFunctionPayload({
        functionPath,
        functionArguments: b.functionArguments ?? b.function_arguments,
        args: b.args,
        typeArguments: b.typeArguments ?? b.type_arguments,
        argTypes: b.argTypes ?? b.arg_types,
    });
}));

app.post('/api/bcs/encode-multisig-payload', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    const functionPath = b.functionPath ?? b.function_path ?? b.function;
    if (!functionPath) {
        throw ErrorHandler.validationError('functionPath', 'function 路径不能为空');
    }
    return encodeMultisigPayload({
        functionPath,
        functionArguments: b.functionArguments ?? b.function_arguments,
        args: b.args,
        typeArguments: b.typeArguments ?? b.type_arguments,
        argTypes: b.argTypes ?? b.arg_types,
    });
}));

// ----------------------------------------------------------------------------
// 账户生成与地址工具
// ----------------------------------------------------------------------------

app.post('/api/account/generate', asyncHandler(async (_req, _res) => {
    return generateAccount();
}));

app.post('/api/account/from-private-key', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    const privateKey = b.privateKey ?? b.private_key;
    if (!privateKey) throw ErrorHandler.validationError('privateKey', '私钥不能为空');
    return accountInfoFromPrivateKey(privateKey);
}));

app.post('/api/address/normalize', asyncHandler(async (req, _res) => {
    const b = req.body || {};
    const address = b.address;
    if (!address) throw ErrorHandler.validationError('address', '地址不能为空');
    return normalizeAddressEndpoint(address);
}));

app.get('/api/address/normalize', asyncHandler(async (req, _res) => {
    const address = toStr(req.query.address);
    if (!address) throw ErrorHandler.validationError('address', '地址不能为空');
    return normalizeAddressEndpoint(address);
}));

// ----------------------------------------------------------------------------
// 404 & 启动
// ----------------------------------------------------------------------------

app.use((req: Request, res: Response) => {
    res.status(404).json({
        error: {
            code: 404,
            message: `路径不存在: ${req.method} ${req.originalUrl}`,
            timestamp: new Date().toISOString(),
        }
    });
});

app.listen(PORT, () => {
    const cfg = getCurrentNetworkConfig();
    console.log(`\n[Endless Sidecar] 监听 http://localhost:${PORT}`);
    console.log(`[Endless Sidecar] 网络: ${cfg.network}`);
    console.log(`[Endless Sidecar] RPC:   ${cfg.activeUrl}\n`);
});
