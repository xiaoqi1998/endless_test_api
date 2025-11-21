// server.ts

import * as dotenv from 'dotenv';
import express, { Request, Response } from 'express';
// 确保 contractService.ts 中的函数已 export (TS2459 修正)
import { readContractState, writeToContract, queryEvents, checkRpcHealth } from './contractService';
import { EndlessAPIError, ErrorHandler, ErrorCode } from './errorDefinitions';
import swaggerUi from 'swagger-ui-express';
const swaggerSpec = require('./swagger.config');

dotenv.config();

const app = express();
const PORT = 3001;

app.use(express.json());

// --- Swagger UI setup ---
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get('/swagger.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// --- 辅助函数: 验证合约参数是否存在 ---
function validateContractParams(params: any, required: string[], res: Response) {
    for (const param of required) {
        if (!params[param]) {
            const error = ErrorHandler.missingParameterError(param);
            res.status(ErrorHandler.getHttpStatusCode(error)).json({
                success: false,
                ...error.toJSON()
            });
            return false;
        }
    }
    return true;
}

// --- 统一的错误响应处理 ---
function handleErrorResponse(error: any, res: Response) {
    console.error('API Error:', error);
    
    // 转换错误为API错误
    const apiError = error instanceof EndlessAPIError ? error : ErrorHandler.fromError(error);
    
    // 获取对应的HTTP状态码
    const statusCode = ErrorHandler.getHttpStatusCode(apiError);
    
    res.status(statusCode).json({
        success: false,
        ...apiError.toJSON()
    });
}

// --- 接口 1: 读取合约状态 (GET) ---
app.get('/api/read', async (req: Request, res: Response) => {
    const { contractAddress, moduleName, functionName } = req.query as Record<string, string>;
    let functionArguments: any[];
    let typeArgs: string[] | undefined;
    console.log(`[API] GET /api/read query: ${JSON.stringify(req.query)}`);

    if (!validateContractParams(req.query, ['contractAddress', 'moduleName', 'functionName'], res)) return;

    // 尝试解析 functionArguments (如果存在)
    try {
        const argsStr = req.query.args as string;
        functionArguments = argsStr ? JSON.parse(argsStr) : [];
        
        // 验证解析后的参数是否为数组
        if (!Array.isArray(functionArguments)) {
            throw ErrorHandler.validationError('args', '参数必须是有效的JSON数组');
        }
        
        const typeArgsStr = req.query.typeArgs as string;
        typeArgs = typeArgsStr ? JSON.parse(typeArgsStr) : undefined;
        
        // 验证解析后的类型参数是否为数组（如果提供）
        if (typeArgsStr && !Array.isArray(typeArgs)) {
            throw ErrorHandler.validationError('typeArgs', '类型参数必须是有效的JSON数组');
        }
    } catch (e) {
        // 如果是我们抛出的验证错误，直接处理
        if (e instanceof EndlessAPIError) {
            return handleErrorResponse(e, res);
        }
        
        // 否则是JSON解析错误
        const jsonError = ErrorHandler.validationError('args/typeArgs', '必须是有效的 JSON 数组字符串');
        return handleErrorResponse(jsonError, res);
    }

    try {
        // 调用合约读取函数
        const result = await readContractState({
            contractAddress: contractAddress,
            moduleName: moduleName,
            functionName: functionName,
            args: functionArguments,
            typeArgs: typeArgs
        });
        console.log(`[API] /api/read result summary: ${JSON.stringify({ function: result.function })}`);

        res.status(200).json({ 
            success: true, 
            data: result,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        handleErrorResponse(error, res);
    }
});


// --- 接口 2: 写入合约状态 (POST) ---
app.post('/api/write', async (req: Request, res: Response) => {
    const { contractAddress, moduleName, functionName, functionArguments } = req.body;
    const privateKey = process.env.SIGNER_PRIVATE_KEY as string;
    console.log(`[API] POST /api/write body: ${JSON.stringify(req.body)}`);

    const requiredParams = ['contractAddress', 'moduleName', 'functionName', 'functionArguments'];
    if (!validateContractParams(req.body, requiredParams, res)) return;

    // 验证私钥配置
    if (!privateKey || privateKey.length < 64) {
        const configError = new EndlessAPIError(
            ErrorHandler.fromError({ message: 'SIGNER_PRIVATE_KEY 未设置或格式不正确' }, '配置错误').code,
            '配置错误: SIGNER_PRIVATE_KEY 未设置或格式不正确',
            { 
                providedLength: privateKey ? privateKey.length : 0,
                requiredLength: 64,
                hasPrivateKey: !!privateKey 
            }
        );
        return handleErrorResponse(configError, res);
    }

    try {
        // 调用 writeToContract，其签名已调整为接收私钥和合约参数
        const committedTransaction = await writeToContract(
            privateKey,
            contractAddress,
            moduleName,
            functionName,
            functionArguments
        );
        console.log(`[API] /api/write committed: ${JSON.stringify({ hash: committedTransaction.hash, status: committedTransaction.status })}`);
        res.status(200).json({
            success: true,
            message: "交易已提交并成功执行",
            transaction: committedTransaction,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        handleErrorResponse(error, res);
    }
});


// --- 接口 3: 查询合约事件 (GET) ---
app.get('/api/events', async (req: Request, res: Response) => {
    const { contractAddress, moduleName, creationNum } = req.query as Record<string, string>;
    console.log(`[API] GET /api/events query: ${JSON.stringify(req.query)}`);

    const requiredParams = ['contractAddress', 'moduleName', 'creationNum'];
    if (!validateContractParams(req.query, requiredParams, res)) return;

    try {
        // 这里假设 queryEvents 接收这三个参数
        const events = await queryEvents(contractAddress, moduleName, creationNum);
        console.log(`[API] /api/events count: ${Array.isArray(events) ? events.length : 0}`);
        res.status(200).json({ 
            success: true, 
            events,
            count: Array.isArray(events) ? events.length : 0,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        handleErrorResponse(error, res);
    }
});


// 启动服务器
app.listen(PORT, () => {
    console.log(`\n🎉 Server is running on http://localhost:${PORT}`);
    console.log(`API Endpoints now accept dynamic contract parameters.`);
});

app.get('/api/health', async (_req: Request, res: Response) => {
    try {
        const status = await checkRpcHealth();
        res.status(200).json({ 
            success: true, 
            status,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        handleErrorResponse(error, res);
    }
});

// --- 全局错误处理中间件 ---
app.use((error: any, req: Request, res: Response, next: any) => {
    console.error('Unhandled Error:', error);
    handleErrorResponse(error, res);
});

// --- 404 处理 ---
app.use('*', (req: Request, res: Response) => {
    const error = new EndlessAPIError(
        ErrorCode.INTERNAL_ERROR as any,
        `API 路径不存在: ${req.method} ${req.originalUrl}`,
        { method: req.method, path: req.originalUrl }
    );
    res.status(404).json({
        success: false,
        ...error.toJSON()
    });
});