import swaggerJSDoc from 'swagger-jsdoc';

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Endless Contract API 文档',
    version: '1.0.0',
    description: 'Endless Chain 合约交互 API 服务器',
  },
  components: {
    schemas: {
      ErrorCode: {
        type: 'integer',
        description: 'API 错误码',
        enum: [
          1000, // INTERNAL_ERROR
          1001, // CONFIGURATION_ERROR
          1002, // NETWORK_ERROR
          1003, // TIMEOUT_ERROR
          2000, // RPC_CONNECTION_ERROR
          2001, // RPC_TIMEOUT_ERROR
          2002, // RPC_INVALID_RESPONSE
          2003, // RPC_RATE_LIMIT_ERROR
          2004, // RPC_UNAVAILABLE
          3000, // CONTRACT_NOT_FOUND
          3001, // CONTRACT_EXECUTION_ERROR
          3002, // CONTRACT_ABI_MISMATCH
          3003, // CONTRACT_PARAMETER_ERROR
          3004, // CONTRACT_STATE_ERROR
          4000, // ACCOUNT_NOT_FOUND
          4001, // ACCOUNT_INVALID_PRIVATE_KEY
          4002, // ACCOUNT_INSUFFICIENT_BALANCE
          5000, // INVALID_PARAMETER
          5001, // MISSING_PARAMETER
          5002, // PARAMETER_FORMAT_ERROR
          5003, // PARAMETER_TYPE_ERROR
          6000, // TRANSACTION_FAILED
          6001, // TRANSACTION_REJECTED
          6002, // TRANSACTION_TIMEOUT
          6003, // TRANSACTION_INVALID
          7000, // EVENT_NOT_FOUND
          7001  // EVENT_QUERY_ERROR
        ],
      },
      Error: {
        type: 'object',
        properties: {
          code: {
            $ref: '#/components/schemas/ErrorCode',
          },
          message: {
            type: 'string',
            description: '错误信息',
          },
          type: {
            type: 'string',
            description: '错误类型，例如 EndlessAPIError',
          },
          details: {
            type: 'object',
            description: '错误详情，可选',
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: '错误发生时间',
          },
        },
        required: ['code', 'message', 'type'],
      },
    },
  },
  servers: [
    {
      url: 'http://localhost:3001',
      description: '本地开发服务器',
    },
  ],
  tags: [
    {
      name: '合约交互',
      description: '与 Endless 链上合约进行交互',
    },
    {
      name: '系统',
      description: '系统健康检查',
    },
  ],
  paths: {
    '/api/read': {
      get: {
        tags: ['合约交互'],
        summary: '读取视图函数',
        description: '调用 Move 视图函数，返回函数的返回值数组',
        parameters: [
          {
            name: 'contractAddress',
            in: 'query',
            required: true,
            description: '合约地址（支持 Base58 或 0x...）',
            schema: {
              type: 'string',
            },
          },
          {
            name: 'moduleName',
            in: 'query',
            required: true,
            description: '模块名',
            schema: {
              type: 'string',
            },
          },
          {
            name: 'functionName',
            in: 'query',
            required: true,
            description: '视图函数名',
            schema: {
              type: 'string',
            },
          },
          {
            name: 'args',
            in: 'query',
            required: false,
            description: 'JSON 数组字符串，可选，默认 []',
            schema: {
              type: 'string',
              example: '[]',
            },
          },
          {
            name: 'typeArgs',
            in: 'query',
            required: false,
            description: 'JSON 数组字符串，可选，泛型类型参数',
            schema: {
              type: 'string',
              example: '["0x1::coin::Coin<0x1::endless_coin::EndlessCoin>"]',
            },
          },
        ],
        responses: {
          '200': {
            description: '成功响应',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        function: { type: 'string', example: '0x...::module::function' },
                        result: { type: 'array', items: { type: 'string' }, example: ['...'] },
                        note: { type: 'string', example: '成功读取合约状态。结果为合约View函数的返回值数组。' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: '参数格式错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: {
                      $ref: '#/components/schemas/Error',
                    },
                  },
                },
              },
            },
          },
          '500': {
            description: '内部错误或上游 RPC 错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: {
                      $ref: '#/components/schemas/Error',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/write': {
      post: {
        tags: ['合约交互'],
        summary: '写入交易',
        description: '调用入口函数并提交交易',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  contractAddress: { type: 'string', example: '0x...' },
                  moduleName: { type: 'string', example: 'module' },
                  functionName: { type: 'string', example: 'entry_func' },
                  functionArguments: { type: 'array', items: { type: 'string' }, example: ['0xabc', 123] },
                },
                required: ['contractAddress', 'moduleName', 'functionName', 'functionArguments'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: '成功响应',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string', example: '交易已提交并成功执行' },
                    transaction: {
                      type: 'object',
                      properties: {
                        hash: { type: 'string', example: '0x...' },
                        status: { type: 'string', example: 'Executed successfully' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: '参数格式错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: {
                      $ref: '#/components/schemas/Error',
                    },
                  },
                },
              },
            },
          },
          '500': {
            description: '内部错误或上游 RPC 错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: {
                      $ref: '#/components/schemas/Error',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/events': {
      get: {
        tags: ['合约交互'],
        summary: '查询事件',
        description: '查询指定事件句柄的历史事件',
        parameters: [
          {
            name: 'contractAddress',
            in: 'query',
            required: true,
            description: '合约地址',
            schema: {
              type: 'string',
            },
          },
          {
            name: 'moduleName',
            in: 'query',
            required: true,
            description: '模块名',
            schema: {
              type: 'string',
            },
          },
          {
            name: 'creationNum',
            in: 'query',
            required: true,
            description: '事件句柄创建序号',
            schema: {
              type: 'string',
            },
          },
        ],
        responses: {
          '200': {
            description: '成功响应',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    events: { type: 'array', items: { type: 'object' }, example: [{}] },
                  },
                },
              },
            },
          },
          '400': {
            description: '参数格式错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string', example: '错误信息' },
                  },
                },
              },
            },
          },
          '500': {
            description: '内部错误或上游 RPC 错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string', example: '错误信息' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/health': {
      get: {
        tags: ['系统'],
        summary: '健康检查',
        description: '探测当前 RPC 的连通性',
        responses: {
          '200': {
            description: '成功响应',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    status: {
                      type: 'object',
                      properties: {
                        ok: { type: 'boolean', example: true },
                        path: { type: 'string', example: '/' },
                        base: { type: 'string', example: 'https://rpc-testnet.endless.link/v1' },
                        error: { type: 'string', example: '错误信息' },
                      },
                    },
                  },
                },
              },
            },
          },
          '500': {
            description: '内部错误或上游 RPC 错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: false },
                    error: { type: 'string', example: '错误信息' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const swaggerSpec = swaggerJSDoc({
  swaggerDefinition,
  apis: ['./server.ts'], // 指向你的API路由文件
});

module.exports = swaggerSpec;