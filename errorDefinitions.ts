/**
 * 错误码定义 - 更明确的错误分类
 */
export enum ErrorCode {
  // 系统级错误 (1000-1999)
  INTERNAL_ERROR = 1000,
  CONFIGURATION_ERROR = 1001,
  NETWORK_ERROR = 1002,
  TIMEOUT_ERROR = 1003,
  
  // RPC相关错误 (2000-2999)
  RPC_CONNECTION_ERROR = 2000,
  RPC_TIMEOUT_ERROR = 2001,
  RPC_INVALID_RESPONSE = 2002,
  RPC_RATE_LIMIT_ERROR = 2003,
  RPC_UNAVAILABLE = 2004,
  
  // 合约相关错误 (3000-3999)
  CONTRACT_NOT_FOUND = 3000,
  CONTRACT_EXECUTION_ERROR = 3001,
  CONTRACT_ABI_MISMATCH = 3002,
  CONTRACT_PARAMETER_ERROR = 3003,
  CONTRACT_STATE_ERROR = 3004,
  
  // 账户相关错误 (4000-4999)
  ACCOUNT_NOT_FOUND = 4000,
  ACCOUNT_INVALID_PRIVATE_KEY = 4001,
  ACCOUNT_INSUFFICIENT_BALANCE = 4002,
  
  // 参数验证错误 (5000-5999)
  INVALID_PARAMETER = 5000,
  MISSING_PARAMETER = 5001,
  PARAMETER_FORMAT_ERROR = 5002,
  PARAMETER_TYPE_ERROR = 5003,
  
  // 交易相关错误 (6000-6999)
  TRANSACTION_FAILED = 6000,
  TRANSACTION_REJECTED = 6001,
  TRANSACTION_TIMEOUT = 6002,
  TRANSACTION_INVALID = 6003,
  
  // 事件查询错误 (7000-7999)
  EVENT_NOT_FOUND = 7000,
  EVENT_QUERY_ERROR = 7001
}

/**
 * 错误信息映射
 */
export const ErrorMessages: Record<ErrorCode, string> = {
  // 系统级错误
  [ErrorCode.INTERNAL_ERROR]: "内部服务器错误",
  [ErrorCode.CONFIGURATION_ERROR]: "配置错误",
  [ErrorCode.NETWORK_ERROR]: "网络连接错误",
  [ErrorCode.TIMEOUT_ERROR]: "请求超时",
  
  // RPC相关错误
  [ErrorCode.RPC_CONNECTION_ERROR]: "RPC节点连接失败",
  [ErrorCode.RPC_TIMEOUT_ERROR]: "RPC节点响应超时",
  [ErrorCode.RPC_INVALID_RESPONSE]: "RPC节点返回无效数据",
  [ErrorCode.RPC_RATE_LIMIT_ERROR]: "RPC节点请求频率超限",
  [ErrorCode.RPC_UNAVAILABLE]: "RPC节点不可用",
  
  // 合约相关错误
  [ErrorCode.CONTRACT_NOT_FOUND]: "合约不存在",
  [ErrorCode.CONTRACT_EXECUTION_ERROR]: "合约执行失败",
  [ErrorCode.CONTRACT_ABI_MISMATCH]: "合约ABI不匹配",
  [ErrorCode.CONTRACT_PARAMETER_ERROR]: "合约参数错误",
  [ErrorCode.CONTRACT_STATE_ERROR]: "合约状态错误",
  
  // 账户相关错误
  [ErrorCode.ACCOUNT_NOT_FOUND]: "账户不存在",
  [ErrorCode.ACCOUNT_INVALID_PRIVATE_KEY]: "私钥格式错误",
  [ErrorCode.ACCOUNT_INSUFFICIENT_BALANCE]: "账户余额不足",
  
  // 参数验证错误
  [ErrorCode.INVALID_PARAMETER]: "参数无效",
  [ErrorCode.MISSING_PARAMETER]: "缺少必要参数",
  [ErrorCode.PARAMETER_FORMAT_ERROR]: "参数格式错误",
  [ErrorCode.PARAMETER_TYPE_ERROR]: "参数类型错误",
  
  // 交易相关错误
  [ErrorCode.TRANSACTION_FAILED]: "交易执行失败",
  [ErrorCode.TRANSACTION_REJECTED]: "交易被拒绝",
  [ErrorCode.TRANSACTION_TIMEOUT]: "交易确认超时",
  [ErrorCode.TRANSACTION_INVALID]: "交易无效",
  
  // 事件查询错误
  [ErrorCode.EVENT_NOT_FOUND]: "事件不存在",
  [ErrorCode.EVENT_QUERY_ERROR]: "事件查询失败"
};

/**
 * HTTP状态码映射
 */
export const HttpStatusCodes: Record<ErrorCode, number> = {
  // 系统级错误
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.CONFIGURATION_ERROR]: 500,
  [ErrorCode.NETWORK_ERROR]: 503,
  [ErrorCode.TIMEOUT_ERROR]: 504,
  
  // RPC相关错误
  [ErrorCode.RPC_CONNECTION_ERROR]: 503,
  [ErrorCode.RPC_TIMEOUT_ERROR]: 504,
  [ErrorCode.RPC_INVALID_RESPONSE]: 502,
  [ErrorCode.RPC_RATE_LIMIT_ERROR]: 429,
  [ErrorCode.RPC_UNAVAILABLE]: 503,
  
  // 合约相关错误
  [ErrorCode.CONTRACT_NOT_FOUND]: 404,
  [ErrorCode.CONTRACT_EXECUTION_ERROR]: 400,
  [ErrorCode.CONTRACT_ABI_MISMATCH]: 400,
  [ErrorCode.CONTRACT_PARAMETER_ERROR]: 400,
  [ErrorCode.CONTRACT_STATE_ERROR]: 400,
  
  // 账户相关错误
  [ErrorCode.ACCOUNT_NOT_FOUND]: 404,
  [ErrorCode.ACCOUNT_INVALID_PRIVATE_KEY]: 400,
  [ErrorCode.ACCOUNT_INSUFFICIENT_BALANCE]: 402,
  
  // 参数验证错误
  [ErrorCode.INVALID_PARAMETER]: 400,
  [ErrorCode.MISSING_PARAMETER]: 400,
  [ErrorCode.PARAMETER_FORMAT_ERROR]: 400,
  [ErrorCode.PARAMETER_TYPE_ERROR]: 400,
  
  // 交易相关错误
  [ErrorCode.TRANSACTION_FAILED]: 400,
  [ErrorCode.TRANSACTION_REJECTED]: 400,
  [ErrorCode.TRANSACTION_TIMEOUT]: 408,
  [ErrorCode.TRANSACTION_INVALID]: 400,
  
  // 事件查询错误
  [ErrorCode.EVENT_NOT_FOUND]: 404,
  [ErrorCode.EVENT_QUERY_ERROR]: 400
};

/**
 * 自定义错误类
 */
export class EndlessAPIError extends Error {
  constructor(
    public code: ErrorCode,
    message?: string,
    public details?: any,
    public cause?: Error
  ) {
    super(message || ErrorMessages[code]);
    this.name = 'EndlessAPIError';
    
    // 保持堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, EndlessAPIError);
    }
  }
  
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        type: this.name,
        details: this.details,
        timestamp: new Date().toISOString()
      }
    };
  }
}

/**
 * 错误处理工具函数
 */
export class ErrorHandler {
  /**
   * 从原始错误创建API错误
   */
  static fromError(error: any, context?: string): EndlessAPIError {
    // 如果已经是API错误，直接返回
    if (error instanceof EndlessAPIError) {
      return error;
    }
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // 尝试解析 Fullnode 错误
    if (errorMessage.includes("Fullnode error: ")) {
      try {
        const fullnodeErrorJsonString = errorMessage.substring(errorMessage.indexOf("Fullnode error: ") + "Fullnode error: ".length);
        const fullnodeError = JSON.parse(fullnodeErrorJsonString);

                let apiErrorCode: ErrorCode = ErrorCode.RPC_UNAVAILABLE; // 默认RPC错误，使用RPC_UNAVAILABLE替代
        let apiErrorMessage: string = "Fullnode 错误";
        let details: any = { ...fullnodeError, originalError: errorMessage, context, stack: errorStack };

        if (fullnodeError.error_code === "invalid_input") {
          // 进一步解析 VMError
          if (fullnodeError.message && fullnodeError.message.includes("VMError")) {
            apiErrorCode = ErrorCode.CONTRACT_EXECUTION_ERROR;
            // 尝试从 VMError 消息中提取更友好的信息
            const vmErrorMatch = fullnodeError.message.match(/VMError \{ major_status: (\w+), sub_status: Some\((\d+)\), message: Some\(\\"(.*?)\\"\)/);
            if (vmErrorMatch && vmErrorMatch[3]) {
              apiErrorMessage = `合约执行失败: ${vmErrorMatch[3]}`;
              details.vmMajorStatus = vmErrorMatch[1];
              details.vmSubStatus = vmErrorMatch[2];
              details.vmErrorMessage = vmErrorMatch[3];
            } else {
              apiErrorMessage = `合约执行失败: ${fullnodeError.message}`;
            }
          } else {
            apiErrorCode = ErrorCode.INVALID_PARAMETER;
            apiErrorMessage = `Fullnode 参数无效: ${fullnodeError.message || "未知错误"}`;
          }
        } else if (fullnodeError.error_code === "web_framework_error") {
            apiErrorCode = ErrorCode.RPC_UNAVAILABLE;
            apiErrorMessage = `RPC节点服务错误: ${fullnodeError.message || "未知错误"}`;
        }
        // 可以根据需要添加更多 fullnodeError.error_code 的处理逻辑

        return new EndlessAPIError(
          apiErrorCode,
          context ? `${context}: ${apiErrorMessage}` : apiErrorMessage,
          details,
          error instanceof Error ? error : new Error(errorMessage)
        );

      } catch (parseError) {
        // 如果解析 Fullnode 错误失败，则回退到通用处理
        console.warn("Failed to parse Fullnode error JSON:", parseError);
      }
    }

    // Cloudflare 522 错误
    if (errorMessage.includes("Error code 522") ||
        errorMessage.includes("<!DOCTYPE html") ||
        errorMessage.includes("Cannot use 'in' operator")) {
      return new EndlessAPIError(
        ErrorCode.RPC_TIMEOUT_ERROR,
        "Cloudflare 522：与源站连接超时，RPC 节点未响应或被阻断",
        { originalError: errorMessage, context, stack: errorStack },
        error instanceof Error ? error : new Error(errorMessage)
      );
    }

    // RPC连接错误
    if (errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("ENOTFOUND") ||
        errorMessage.includes("ETIMEDOUT")) {
      return new EndlessAPIError(
        ErrorCode.RPC_CONNECTION_ERROR,
        "无法连接到RPC节点",
        { originalError: errorMessage, context, stack: errorStack },
        error instanceof Error ? error : new Error(errorMessage)
      );
    }

    // 参数相关错误 (来自 contractService 内部的验证)
    if (errorMessage.includes("参数第") && errorMessage.includes("项不符合 ABI 要求")) {
      return new EndlessAPIError(
        ErrorCode.CONTRACT_PARAMETER_ERROR,
        errorMessage,
        { originalError: errorMessage, context, stack: errorStack },
        error instanceof Error ? error : new Error(errorMessage)
      );
    }

    // 交易执行错误 (来自 contractService 内部的验证)
    if (errorMessage.includes("交易执行失败")) {
      return new EndlessAPIError(
        ErrorCode.TRANSACTION_FAILED,
        errorMessage,
        { originalError: errorMessage, context, stack: errorStack },
        error instanceof Error ? error : new Error(errorMessage)
      );
    }

    // 私钥相关错误
    if (errorMessage.includes("私钥") ||
        errorMessage.includes("private key") ||
        errorMessage.includes("Ed25519PrivateKey")) {
      return new EndlessAPIError(
        ErrorCode.ACCOUNT_INVALID_PRIVATE_KEY,
        "私钥格式错误或无效",
        { originalError: errorMessage, context, stack: errorStack },
        error instanceof Error ? error : new Error(errorMessage)
      );
    }

    // 默认内部错误
    return new EndlessAPIError(
      ErrorCode.INTERNAL_ERROR,
      context ? `${context}: ${errorMessage}` : errorMessage,
      { originalError: errorMessage, context, stack: errorStack },
      error instanceof Error ? error : new Error(errorMessage)
    );
  }
  
  /**
   * 创建参数验证错误
   */
  static validationError(paramName: string, reason: string, value?: any): EndlessAPIError {
    return new EndlessAPIError(
      ErrorCode.INVALID_PARAMETER,
      `参数验证失败: ${paramName} - ${reason}`,
      { parameter: paramName, reason, value }
    );
  }
  
  /**
   * 创建缺少参数错误
   */
  static missingParameterError(paramName: string): EndlessAPIError {
    return new EndlessAPIError(
      ErrorCode.MISSING_PARAMETER,
      `缺少必要的参数: ${paramName}`,
      { parameter: paramName }
    );
  }
  
  /**
   * 获取对应的HTTP状态码
   */
  static getHttpStatusCode(error: EndlessAPIError): number {
    return HttpStatusCodes[error.code] || 500;
  }
}