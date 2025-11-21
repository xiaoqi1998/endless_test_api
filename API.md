# Endless Contract API 文档

## 基础信息
- 基础地址: `http://localhost:3000`
- 返回格式: `application/json`
- RPC: 已硬编码为 `https://rpc-testnet.endless.link/v1`
- 私钥配置: 通过环境变量 `SIGNER_PRIVATE_KEY` 提供，支持带/不带 `0x` 前缀

## 状态码约定
- `200` 成功
- `400` 参数格式错误（如 `args`/`typeArgs` 不是合法 JSON 数组字符串）
- `500` 内部错误或上游 RPC 错误

## 地址与类型约定
- 地址: 支持 `0x...` 十六进制和 Base58，服务会自动规范化为 `0x...`
- 类型参数: 视图函数如为泛型，使用 `typeArgs` 传入字符串形式的类型标签（会自动标准化）
- 参数编码: `args` 与 `typeArgs` 需为 JSON 数组字符串，并进行 URL 编码

## 接口列表

### 读取视图函数
- 方法: `GET /api/read`
- 说明: 调用 Move 视图函数，返回函数的返回值数组
- 查询参数:
  - `contractAddress` 字符串，合约地址（支持 Base58 或 `0x...`）
  - `moduleName` 字符串，模块名
  - `functionName` 字符串，视图函数名
  - `args` JSON 数组字符串，可选，默认 `[]`
  - `typeArgs` JSON 数组字符串，可选，泛型类型参数
- 成功响应示例:
```
{
  "success": true,
  "data": {
    "function": "0x...::module::function",
    "result": [...],
    "note": "成功读取合约状态。结果为合约View函数的返回值数组。"
  }
}
```
- 失败响应示例:
```
{ "success": false, "error": "错误信息" }
```
- 示例:
```
curl "http://localhost:3000/api/read?contractAddress=BLiLNS4g2Xoz2FUuwxiufHKLu79xorpxYBdqREocsTiE&moduleName=config&functionName=get_liquiditys&args=[]"
```
带类型参数示例:
```
curl "http://localhost:3000/api/read?contractAddress=0x1&moduleName=pool&functionName=get&args=[\"0xabc\"]&typeArgs=[\"0x1::coin::Coin<0x1::endless_coin::EndlessCoin>\"]"
```
- 代码参考: `server.ts:18`，`contractService.ts:45`

### 写入交易
- 方法: `POST /api/write`
- 说明: 调用入口函数并提交交易
- 请求体(`application/json`):
```
{
  "contractAddress": "0x...",
  "moduleName": "module",
  "functionName": "entry_func",
  "functionArguments": [ ... ]
}
```
- 成功响应示例:
```
{
  "success": true,
  "message": "交易已提交并成功执行",
  "transaction": { "hash": "0x...", "status": "Executed successfully" }
}
```
- 失败响应示例:
```
{ "success": false, "error": "错误信息" }
```
- 示例:
```
curl -X POST "http://localhost:3000/api/write" \
  -H "Content-Type: application/json" \
  -d "{\"contractAddress\":\"0x1\",\"moduleName\":\"pool\",\"functionName\":\"add\",\"functionArguments\":[\"0xabc\",123]}"
```
- 代码参考: `server.ts:58`，`contractService.ts:122`

### 查询事件
- 方法: `GET /api/events`
- 说明: 查询指定事件句柄的历史事件
- 查询参数:
  - `contractAddress` 字符串
  - `moduleName` 字符串
  - `creationNum` 字符串，事件句柄创建序号
- 成功响应示例:
```
{ "success": true, "events": [ ... ] }
```
- 失败响应示例:
```
{ "success": false, "error": "错误信息" }
```
- 示例:
```
curl "http://localhost:3000/api/events?contractAddress=0x1&moduleName=pool&creationNum=0"
```
- 代码参考: `server.ts:89`，`contractService.ts:199`

### 健康检查
- 方法: `GET /api/health`
- 说明: 探测当前 RPC 的连通性
- 响应示例:
```
{ "success": true, "status": { "ok": true, "path": "/", "base": "https://rpc-testnet.endless.link/v1" } }
```
或
```
{ "success": true, "status": { "ok": false, "path": "/", "base": "https://rpc-testnet.endless.link/v1", "error": "错误信息" } }
```
- 代码参考: `server.ts:104`，`contractService.ts:230`

## 常见错误与处理
- Cloudflare 522 超时：上游节点未响应或被阻断；可更换节点或检查网络策略
- ABI 参数不匹配：会返回具体第 N 项错误，请按 ABI 类型修正 `args` 或补充 `typeArgs`
- 参数解析错误：`args`/`typeArgs` 必须是有效的 JSON 数组字符串，注意 URL 编码