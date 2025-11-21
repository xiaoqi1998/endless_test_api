// contractService.ts

// contractService.ts

import {
    Endless,
    EndlessConfig,
    Network,
    Account,
    // 从源码可知，私钥需要先实例化为 Ed25519PrivateKey
    Ed25519PrivateKey,
    AccountAddress,
    type InputViewFunctionData,
    fetchViewFunctionAbi,
    checkOrConvertArgument,
    getEndlessFullNode,
    standardizeTypeTags
} from "@endlesslab/endless-ts-sdk";
import { ErrorCode, ErrorHandler, EndlessAPIError } from './errorDefinitions';

// 1. 初始化客户端
const sanitizedRpc = "https://rpc-test.endless.link/v1";
const endlessConfig = new EndlessConfig({
    network: Network.DEVNET,
    fullnode: sanitizedRpc
});
console.log(`[Init] RPC: ${sanitizedRpc}`);
const endless = new Endless(endlessConfig);

// ... readContractState 函数不变 (逻辑正确，使用 as any 绕过模板类型检查) ...
// contractService.ts (readContractState 函数的完整修正)

// 假设您在文件顶部初始化了 endless 实例 (例如：const endless = new Endless();)
// 假设您的函数接收包含合约参数的 payload

export async function readContractState(payload: { contractAddress: string, moduleName: string, functionName: string, args: any[], typeArgs?: Array<string> }) {
    const { contractAddress, moduleName, functionName, args, typeArgs } = payload;

    // 参数验证
    if (!contractAddress) {
        throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');
    }
    if (!moduleName) {
        throw ErrorHandler.validationError('moduleName', '模块名不能为空');
    }
    if (!functionName) {
        throw ErrorHandler.validationError('functionName', '函数名不能为空');
    }
    if (!Array.isArray(args)) {
        throw ErrorHandler.validationError('args', '参数必须是数组', args);
    }

    let normalizedAddress: string;
    try {
        if (contractAddress.startsWith("0x")) {
            normalizedAddress = contractAddress;
        } else {
            try {
                normalizedAddress = AccountAddress.fromBs58String(contractAddress).toString();
            } catch (_) {
                normalizedAddress = AccountAddress.fromString(contractAddress).toString();
            }
        }
    } catch (error) {
        throw new EndlessAPIError(
            ErrorCode.INVALID_PARAMETER,
            `合约地址格式错误: ${contractAddress}`,
            { contractAddress, error: error instanceof Error ? error.message : String(error) }
        );
    }

    // 构造 View Function 所需的 SDK 要求的 payload 格式
    const viewFunctionPayload: InputViewFunctionData = {
        // 格式: 0x...::moduleName::functionName
        function: `${normalizedAddress}::${moduleName}::${functionName}` as `${string}::${string}::${string}`,
        typeArguments: typeArgs && typeArgs.length ? standardizeTypeTags(typeArgs) : [],
        functionArguments: args,
    };

    console.log(`[Read] RPC: ${sanitizedRpc || "<default>"}`);
    console.log(`[Read] Function: ${viewFunctionPayload.function}`);
    console.log(`[Read] Args (raw): ${JSON.stringify(args)}`);
    if (typeArgs && typeArgs.length) console.log(`[Read] TypeArgs (raw): ${JSON.stringify(typeArgs)}`);
    const startMs = Date.now();

    try {
        const abi = await fetchViewFunctionAbi(normalizedAddress, moduleName, functionName, endlessConfig);
        console.log(`[Read] ABI params: ${JSON.stringify(abi.parameters)}`);
        
        if (!abi.parameters) {
            throw new EndlessAPIError(
                ErrorCode.CONTRACT_ABI_MISMATCH,
                '无法获取合约ABI信息',
                { contractAddress: normalizedAddress, moduleName, functionName }
            );
        }
        
        const convertedArgs = abi.parameters.map((param, i) => {
            try {
                return checkOrConvertArgument(args[i], param, i, abi.typeParameters.map(() => ({}) as any));
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                throw new EndlessAPIError(
                    ErrorCode.CONTRACT_PARAMETER_ERROR,
                    `参数第 ${i + 1} 项不符合 ABI 要求: ${msg}`,
                    { 
                        parameterIndex: i, 
                        expectedType: param.toString(), 
                        providedValue: args[i],
                        originalError: msg 
                    }
                );
            }
        });
        console.log(`[Read] Args (converted): ${JSON.stringify(convertedArgs)}`);

        const result = await endless.general.view({
            payload: {
                ...viewFunctionPayload,
                functionArguments: convertedArgs,
            }
        });
        const durMs = Date.now() - startMs;
        console.log(`[Read] Success in ${durMs}ms`);

        return {
            function: viewFunctionPayload.function,
            result: result,
            note: "成功读取合约状态。结果为合约View函数的返回值数组。"
        };
    } catch (error) {
        console.error(`[Read] Error raw:`, error);
        
        // 使用错误处理器转换错误
        const apiError = ErrorHandler.fromError(error, `读取合约状态失败: ${normalizedAddress}::${moduleName}::${functionName}`);
        throw apiError;
    }
}

/**
 * 3. 合约写入 (Entry Function Call / Transaction Submission)
 */
export async function writeToContract(
    privateKey: string,
    contractAddress: string,
    moduleName: string,
    functionName: string,
    functionArguments: any[]
) {
    // 参数验证
    if (!privateKey) {
        throw ErrorHandler.validationError('privateKey', '私钥不能为空');
    }
    if (!contractAddress) {
        throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');
    }
    if (!moduleName) {
        throw ErrorHandler.validationError('moduleName', '模块名不能为空');
    }
    if (!functionName) {
        throw ErrorHandler.validationError('functionName', '函数名不能为空');
    }
    if (!Array.isArray(functionArguments)) {
        throw ErrorHandler.validationError('functionArguments', '函数参数必须是数组', functionArguments);
    }

    let normalizedAddress: string;
    try {
        if (contractAddress.startsWith("0x")) {
            normalizedAddress = contractAddress;
        } else {
            try {
                normalizedAddress = AccountAddress.fromBs58String(contractAddress).toString();
            } catch (_) {
                normalizedAddress = AccountAddress.fromString(contractAddress).toString();
            }
        }
    } catch (error) {
        throw new EndlessAPIError(
            ErrorCode.INVALID_PARAMETER,
            `合约地址格式错误: ${contractAddress}`,
            { contractAddress, error: error instanceof Error ? error.message : String(error) }
        );
    }

    const fullFunctionName = `${normalizedAddress}::${moduleName}::${functionName}`;

    try {
        // 源码修正 1 & 2: 必须先实例化 Ed25519PrivateKey
        // ⚠️ 注意：私钥字符串不能包含 '0x' 前缀
        const keyInstance = new Ed25519PrivateKey(privateKey.replace('0x', ''));

        // 源码修正 1：fromPrivateKey 要求传入包含 privateKey 实例的对象
        const signer = await Account.fromPrivateKey({ privateKey: keyInstance });

        const senderAddress: AccountAddress = (signer as Account).accountAddress;

        // 1. 构建交易
        const transaction = await endless.transaction.build.simple({
            sender: senderAddress,
            data: {
                // 源码修正 3：使用 as any 绕过模板字符串类型检查
                function: fullFunctionName as any,
                typeArguments: [],
                functionArguments: functionArguments,
            },
        });

        // 2. 签名并提交
        console.log(`[Write] Submitting transaction to: ${fullFunctionName}`);
        const pendingTransaction = await endless.signAndSubmitTransaction({
            signer,
            transaction
        });

        // 3. 等待交易完成
        const committedTransaction = await endless.waitForTransaction({
            transactionHash: pendingTransaction.hash,
            timeoutMs: 60000,
        } as any);

        if (committedTransaction.vm_status !== "Executed successfully") {
            throw new EndlessAPIError(
                ErrorCode.TRANSACTION_FAILED,
                `交易执行失败: ${committedTransaction.vm_status}`,
                { 
                    transactionHash: committedTransaction.hash,
                    vmStatus: committedTransaction.vm_status,
                    fullFunctionName 
                }
            );
        }

        return {
            hash: committedTransaction.hash,
            status: committedTransaction.vm_status,
        };
        
    } catch (error) {
        console.error(`[Write] Error raw:`, error);
        
        // 使用错误处理器转换错误
        const apiError = ErrorHandler.fromError(error, `写入合约失败: ${fullFunctionName}`);
        throw apiError;
    }
}

// ... queryEvents 函数不变 (没有新的错误) ...

/**
 * 4. 事件查询 (Query Events)
 * @param contractAddress 合约地址
 * @param moduleName 模块名
 * @param creationNum EventHandle的创建序号
 * @returns 历史事件列表
 */
export async function queryEvents(
    contractAddress: string,
    moduleName: string,
    creationNum: string
) {
    // 参数验证
    if (!contractAddress) {
        throw ErrorHandler.validationError('contractAddress', '合约地址不能为空');
    }
    if (!moduleName) {
        throw ErrorHandler.validationError('moduleName', '模块名不能为空');
    }
    if (!creationNum) {
        throw ErrorHandler.validationError('creationNum', '创建序号不能为空');
    }

    let normalizedAddress: string;
    try {
        if (contractAddress.startsWith("0x")) {
            normalizedAddress = contractAddress;
        } else {
            try {
                normalizedAddress = AccountAddress.fromBs58String(contractAddress).toString();
            } catch (_) {
                normalizedAddress = AccountAddress.fromString(contractAddress).toString();
            }
        }
    } catch (error) {
        throw new EndlessAPIError(
            ErrorCode.INVALID_PARAMETER,
            `合约地址格式错误: ${contractAddress}`,
            { contractAddress, error: error instanceof Error ? error.message : String(error) }
        );
    }

    // 假设 EventHandle 的结构
    const eventHandle = {
        guid: {
            id: {
                addr: normalizedAddress,
                creation_num: creationNum,
            },
        },
        count: "0",
    };

    try {
        const events = await (endless as any).getEvents({
            query: {
                eventHandle,
                start: 0,
                limit: 20,
            }
        });

        if (!events || !Array.isArray(events)) {
            throw new EndlessAPIError(
                ErrorCode.EVENT_QUERY_ERROR,
                '事件查询返回无效数据',
                { contractAddress: normalizedAddress, moduleName, creationNum, response: events }
            );
        }

        return events;
    } catch (error) {
        console.error(`[Events] Error raw:`, error);
        
        // 使用错误处理器转换错误
        const apiError = ErrorHandler.fromError(error, `查询事件失败: ${normalizedAddress}::${moduleName}::${creationNum}`);
        throw apiError;
    }
}

export async function checkRpcHealth() {
    const base = sanitizedRpc || "<default>";
    
    try {
        const res1 = await getEndlessFullNode<{},{}>({
            endlessConfig,
            originMethod: "health",
            path: "/",
        });
        return { 
            ok: true, 
            path: "/", 
            base,
            timestamp: new Date().toISOString()
        };
    } catch (e) {
        try {
            const res2 = await getEndlessFullNode<{},{}>({
                endlessConfig,
                originMethod: "health-ledger",
                path: "/ledger",
            });
            return { 
                ok: true, 
                path: "/ledger", 
                base,
                timestamp: new Date().toISOString()
            };
        } catch (ee) {
            const msg = ee instanceof Error ? ee.message : String(ee);
            const apiError = ErrorHandler.fromError(ee, 'RPC健康检查失败');
            
            return { 
                ok: false, 
                path: "/", 
                base, 
                error: msg,
                errorCode: apiError.code,
                errorType: apiError.name,
                timestamp: new Date().toISOString()
            };
        }
    }
}