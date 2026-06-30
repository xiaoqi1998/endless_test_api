import swaggerJSDoc from 'swagger-jsdoc';

/**
 * 复用的响应片段
 */
const ErrorResponses = {
  '400': {
    description: '参数格式错误',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
      },
    },
  },
  '404': {
    description: '资源不存在',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
      },
    },
  },
  '500': {
    description: '内部错误或上游 RPC 错误',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
      },
    },
  },
};

const WriteResultSchema = {
  type: 'object',
  properties: {
    hash: { type: 'string', example: '0x...' },
    success: { type: 'boolean', example: true },
    status: { type: 'string', example: 'success', description: '成功为 "success"，失败为 "failed"' },
    vm_status: { type: 'string', description: '原始 VM 状态（snake_case，兼容 Python 端）' },
    vmStatus: { type: 'string', description: '同 vm_status（camelCase 别名）' },
    sender: { type: 'string' },
    version: { type: 'string' },
    gas_used: { type: 'number', description: 'snake_case，兼容 Python 端' },
    gasUsed: { type: 'number', description: '同 gas_used（camelCase 别名）' },
    gasUnitPrice: { type: 'number' },
    timestamp: { type: 'string' },
  },
};

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Endless TS Sidecar API',
    version: '2.0.0',
    description: '基于官方 @endlesslab/endless-ts-sdk 的 HTTP Sidecar 服务，供 Python 测试框架调用。',
  },
  components: {
    schemas: {
      ErrorCode: {
        type: 'integer',
        description: 'API 错误码',
        enum: [
          1000, 1001, 1002, 1003,
          2000, 2001, 2002, 2003, 2004,
          3000, 3001, 3002, 3003, 3004,
          4000, 4001, 4002,
          5000, 5001, 5002, 5003,
          6000, 6001, 6002, 6003,
          7000, 7001,
        ],
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { $ref: '#/components/schemas/ErrorCode' },
              message: { type: 'string' },
              type: { type: 'string', example: 'EndlessAPIError' },
              details: { type: 'object' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  },
  servers: [
    { url: 'http://localhost:3001', description: '本地开发服务器' },
  ],
  tags: [
    { name: '系统', description: '健康检查与链信息' },
    { name: '合约读取', description: '视图函数读取' },
    { name: '合约写入', description: '单签 / 多签 / 多 Agent 写交易、模拟、发布包' },
    { name: '账户查询', description: '账户资源 / 模块 / 信息' },
    { name: '交易查询', description: '按 hash / version 查交易，等待确认' },
    { name: '事件查询', description: '按账户 / 事件类型查询链上事件' },
    { name: '其他', description: 'Gas 估算、BCS 工具' },
  ],
  paths: {
    // ========================================================================
    // 系统
    // ========================================================================
    '/api/health': {
      get: {
        tags: ['系统'],
        summary: '健康检查',
        description: '探测当前 RPC 节点连通性，返回链信息',
        responses: {
          '200': {
            description: '成功',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    base: { type: 'string' },
                    chainId: { type: 'integer' },
                    epoch: { type: 'string' },
                    ledgerVersion: { type: 'string' },
                    blockHeight: { type: 'string' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/ledger': {
      get: {
        tags: ['系统'],
        summary: '链信息（同 /api/health）',
        responses: { '200': { description: '同 /api/health' } },
      },
    },

    // ========================================================================
    // 合约读取
    // ========================================================================
    '/api/read': {
      get: {
        tags: ['合约读取'],
        summary: '读取视图函数（GET）',
        parameters: [
          { name: 'contractAddress', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'moduleName', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'functionName', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'args', in: 'query', required: false, schema: { type: 'string' }, description: 'JSON 数组字符串' },
          { name: 'typeArgs', in: 'query', required: false, schema: { type: 'string' }, description: 'JSON 数组字符串' },
          { name: 'ledgerVersion', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: '视图函数返回值',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    function: { type: 'string' },
                    result: { type: 'array', items: {} },
                    note: { type: 'string' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
      post: {
        tags: ['合约读取'],
        summary: '读取视图函数（POST）',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  contractAddress: { type: 'string' },
                  moduleName: { type: 'string' },
                  functionName: { type: 'string' },
                  args: { type: 'array', items: {} },
                  typeArgs: { type: 'array', items: { type: 'string' } },
                  ledgerVersion: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: '同 GET /api/read' }, ...ErrorResponses },
      },
    },

    // ========================================================================
    // 合约写入
    // ========================================================================
    '/api/write': {
      post: {
        tags: ['合约写入'],
        summary: '单签写交易',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['privateKey', 'contractAddress', 'moduleName', 'functionName', 'functionArguments'],
                properties: {
                  privateKey: { type: 'string' },
                  contractAddress: { type: 'string' },
                  moduleName: { type: 'string' },
                  functionName: { type: 'string' },
                  functionArguments: { type: 'array', items: {} },
                  typeArguments: { type: 'array', items: { type: 'string' } },
                  senderAddress: { type: 'string' },
                  maxGasAmount: { type: 'number' },
                  gasUnitPrice: { type: 'number' },
                  txTimeoutSecs: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '交易结果', content: { 'application/json': { schema: WriteResultSchema } } },
          ...ErrorResponses,
        },
      },
    },
    '/api/write/multi-agent': {
      post: {
        tags: ['合约写入'],
        summary: 'Multi-Agent 写交易',
        description: 'sender + secondary_signers 多方签名交易',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['senderPrivateKey', 'contractAddress', 'moduleName', 'functionName', 'functionArguments', 'secondarySigners'],
                properties: {
                  senderPrivateKey: { type: 'string' },
                  senderAddress: { type: 'string' },
                  contractAddress: { type: 'string' },
                  moduleName: { type: 'string' },
                  functionName: { type: 'string' },
                  functionArguments: { type: 'array', items: {} },
                  typeArguments: { type: 'array', items: { type: 'string' } },
                  secondarySigners: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        privateKey: { type: 'string' },
                        address: { type: 'string' },
                      },
                    },
                  },
                  maxGasAmount: { type: 'number' },
                  gasUnitPrice: { type: 'number' },
                  txTimeoutSecs: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '交易结果', content: { 'application/json': { schema: WriteResultSchema } } },
          ...ErrorResponses,
        },
      },
    },
    '/api/write/multi-key': {
      post: {
        tags: ['合约写入'],
        summary: 'MultiKey 写交易（K-of-N 多签）',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['signaturesRequired', 'contractAddress', 'moduleName', 'functionName', 'functionArguments'],
                properties: {
                  privateKey: { type: 'string', description: '任一签名者私钥（其余从 env 加载）' },
                  signerPrivateKeys: { type: 'array', items: { type: 'string' } },
                  signaturesRequired: { type: 'integer', description: 'K：最少签名数' },
                  publicKeys: { type: 'array', items: { type: 'string' } },
                  contractAddress: { type: 'string' },
                  moduleName: { type: 'string' },
                  functionName: { type: 'string' },
                  functionArguments: { type: 'array', items: {} },
                  typeArguments: { type: 'array', items: { type: 'string' } },
                  maxGasAmount: { type: 'number' },
                  gasUnitPrice: { type: 'number' },
                  txTimeoutSecs: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '交易结果', content: { 'application/json': { schema: WriteResultSchema } } },
          ...ErrorResponses,
        },
      },
    },
    '/api/simulate': {
      post: {
        tags: ['合约写入'],
        summary: '交易模拟',
        description: '用公钥模拟交易，不签名不上链',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['senderPublicKey', 'contractAddress', 'moduleName', 'functionName', 'functionArguments'],
                properties: {
                  senderPublicKey: { type: 'string' },
                  contractAddress: { type: 'string' },
                  moduleName: { type: 'string' },
                  functionName: { type: 'string' },
                  functionArguments: { type: 'array', items: {} },
                  typeArguments: { type: 'array', items: { type: 'string' } },
                  senderAddress: { type: 'string' },
                  maxGasAmount: { type: 'number' },
                  gasUnitPrice: { type: 'number' },
                  secondarySignersPublicKeys: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: '模拟结果',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    simulations: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/publish-package': {
      post: {
        tags: ['合约写入'],
        summary: '发布 Move 包',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['senderPrivateKey', 'metadataBytes', 'moduleBytecode'],
                properties: {
                  senderPrivateKey: { type: 'string' },
                  senderAddress: { type: 'string' },
                  metadataBytes: { type: 'string', description: 'hex 字符串' },
                  moduleBytecode: { type: 'array', items: { type: 'string' }, description: 'hex 字符串数组' },
                  maxGasAmount: { type: 'number' },
                  gasUnitPrice: { type: 'number' },
                  txTimeoutSecs: { type: 'number' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '交易结果', content: { 'application/json': { schema: WriteResultSchema } } },
          ...ErrorResponses,
        },
      },
    },

    // ========================================================================
    // 账户查询
    // ========================================================================
    '/api/accounts/{address}/resources': {
      get: {
        tags: ['账户查询'],
        summary: '账户资源列表',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ledgerVersion', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: '资源列表',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    resources: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/accounts/{address}/resource': {
      get: {
        tags: ['账户查询'],
        summary: '账户单个资源',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'resourceType', in: 'query', required: true, schema: { type: 'string' }, description: '如 0x1::account::Account' },
          { name: 'ledgerVersion', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: '资源',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    resourceType: { type: 'string' },
                    resource: { type: 'object' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/accounts/{address}/info': {
      get: {
        tags: ['账户查询'],
        summary: '账户信息',
        parameters: [{ name: 'address', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: '账户信息',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    info: {
                      type: 'object',
                      properties: {
                        sequence_number: { type: 'string' },
                        authentication_key: { type: 'array', items: { type: 'string' } },
                        num_signatures_required: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/accounts/{address}/modules': {
      get: {
        tags: ['账户查询'],
        summary: '账户模块列表',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ledgerVersion', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            description: '模块列表',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    modules: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/accounts/{address}/module': {
      get: {
        tags: ['账户查询'],
        summary: '账户单个模块',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'moduleName', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'ledgerVersion', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: '模块',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    moduleName: { type: 'string' },
                    module: { type: 'object' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },

    // ========================================================================
    // 交易查询
    // ========================================================================
    '/api/transactions/{hash}': {
      get: {
        tags: ['交易查询'],
        summary: '按 hash 查交易',
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: '交易详情',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    hash: { type: 'string' },
                    transaction: { type: 'object' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/transactions/version/{version}': {
      get: {
        tags: ['交易查询'],
        summary: '按 version 查交易',
        parameters: [{ name: 'version', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: '交易详情',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    version: { type: 'string' },
                    transaction: { type: 'object' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/transactions/{hash}/wait': {
      get: {
        tags: ['交易查询'],
        summary: '等待交易确认',
        parameters: [
          { name: 'hash', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'timeoutSecs', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'checkSuccess', in: 'query', required: false, schema: { type: 'string' }, description: 'true/false，默认 true' },
        ],
        responses: {
          '200': {
            description: '确认结果',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    hash: { type: 'string' },
                    success: { type: 'boolean' },
                    status: { type: 'string' },
                    gasUsed: { type: 'number' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/transactions/{hash}/pending': {
      get: {
        tags: ['交易查询'],
        summary: '查询交易是否 pending',
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'pending 状态',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    hash: { type: 'string' },
                    pending: { type: 'boolean' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },

    // ========================================================================
    // 事件查询
    // ========================================================================
    '/api/events/account/creation': {
      get: {
        tags: ['事件查询'],
        summary: '按账户 + creationNumber 查事件',
        parameters: [
          { name: 'accountAddress', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'creationNumber', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'minimumLedgerVersion', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: '事件列表',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    accountAddress: { type: 'string' },
                    creationNumber: { type: 'string' },
                    events: { type: 'array', items: { type: 'object' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/events/account/type': {
      get: {
        tags: ['事件查询'],
        summary: '按账户 + eventType 查事件',
        parameters: [
          { name: 'accountAddress', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'eventType', in: 'query', required: true, schema: { type: 'string' }, description: '如 0x1::coin::DepositEvent' },
          { name: 'minimumLedgerVersion', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: '事件列表',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    accountAddress: { type: 'string' },
                    eventType: { type: 'string' },
                    events: { type: 'array', items: { type: 'object' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/events/module/type': {
      get: {
        tags: ['事件查询'],
        summary: '按 eventType 全局查事件',
        parameters: [
          { name: 'eventType', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'minimumLedgerVersion', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: '事件列表',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    eventType: { type: 'string' },
                    events: { type: 'array', items: { type: 'object' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/events': {
      get: {
        tags: ['事件查询'],
        summary: '兼容旧入口（按 account + creationNum）',
        parameters: [
          { name: 'contractAddress', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'creationNum', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: '同 /api/events/account/creation' }, ...ErrorResponses },
      },
    },

    // ========================================================================
    // 其他
    // ========================================================================
    '/api/gas-price': {
      get: {
        tags: ['其他'],
        summary: 'Gas 价格估算',
        responses: {
          '200': {
            description: 'Gas 估算',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    estimation: {
                      type: 'object',
                      properties: {
                        deprioritized_gas_estimate: { type: 'integer' },
                        gas_estimate: { type: 'integer' },
                        prioritized_gas_estimate: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/bcs/probe': {
      post: {
        tags: ['其他'],
        summary: 'BCS 往返校验',
        description: '通过 view 函数回读 Move 值，验证 BCS 序列化/反序列化',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  contractAddress: { type: 'string' },
                  moduleName: { type: 'string' },
                  functionName: { type: 'string' },
                  args: { type: 'array', items: {} },
                  typeArgs: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: { '200': { description: '同 /api/read' }, ...ErrorResponses },
      },
    },
    '/api/bcs/encode-entry-function': {
      post: {
        tags: ['其他'],
        summary: 'EntryFunction BCS 编码',
        description: '将 entry function 调用编码为 BCS 字节串（hex 格式）',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  functionPath: { type: 'string', example: '0x1::endless_coin::transfer' },
                  functionArguments: { type: 'array', items: {}, example: ['0x1', '100'] },
                  typeArguments: { type: 'array', items: { type: 'string' } },
                  argTypes: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['address', 'u128'],
                    description: '显式参数类型，缺失时自动从链上 ABI 推断',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '{ payloadHex: "0x..." }' },
          ...ErrorResponses,
        },
      },
    },
    '/api/account/generate': {
      post: {
        tags: ['账户'],
        summary: '生成随机账户密钥对',
        responses: {
          '200': {
            description: '{ addressHex, addressBase58, privateKey, publicKey }',
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/account/from-private-key': {
      post: {
        tags: ['账户'],
        summary: '从私钥推导账户信息',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  privateKey: { type: 'string', example: '0x...' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: '{ addressHex, addressBase58, publicKey }',
          },
          ...ErrorResponses,
        },
      },
    },
    '/api/address/normalize': {
      post: {
        tags: ['账户'],
        summary: 'Base58 → Hex 地址转换',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  address: { type: 'string', example: '0x1' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '{ hex: "0x..." }' },
          ...ErrorResponses,
        },
      },
    },
  },
};

const swaggerSpec = swaggerJSDoc({
  swaggerDefinition,
  apis: ['./server.ts'],
});

module.exports = swaggerSpec;
export default swaggerSpec;
