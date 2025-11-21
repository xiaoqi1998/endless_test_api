# Endless Contract API 服务器

这是一个用于与 Endless 链上合约进行交互的 API 服务器。它提供了一组 RESTful API，用于读取视图函数和提交写入交易。项目集成了 Swagger UI，方便查看和测试 API 文档。

## 特性

*   **合约交互**：通过 API 调用 Move 视图函数和入口函数。
*   **Swagger UI**：提供交互式的 API 文档界面。
*   **自定义错误处理**：详细的错误码和错误信息，方便调试。
*   **TypeScript**：使用 TypeScript 编写，提供类型安全。

## 先决条件

在运行此项目之前，请确保你已安装以下软件：

*   Node.js (推荐 LTS 版本)
*   npm (通常随 Node.js 一起安装)
*   Git

## 安装

1.  **克隆仓库**：
    ```bash
    git clone https://github.com/xiaoqi1998/endless_test_api.git
    cd endless_test_api
    ```

2.  **安装依赖**：
    ```bash
    npm install
    ```

## 使用

### 运行服务器

```bash
npm start
```

服务器将默认运行在 `http://localhost:3001`。

### 访问 Swagger UI

服务器启动后，你可以在浏览器中访问以下地址查看交互式 API 文档：

`http://localhost:3001/api-docs`

### 获取 Swagger JSON

你也可以直接获取原始的 OpenAPI 3.0 JSON 规范文件：

`http://localhost:3001/swagger.json`

## API 端点概览

*   **GET /api/read**：读取链上合约的视图函数。
*   **POST /api/write**：提交链上合约的写入交易。
*   **GET /api-docs**：Swagger UI 接口文档。
*   **GET /swagger.json**：Swagger API 规范 JSON 文件。

## 错误处理

API 响应中包含自定义的错误码和详细信息，以便于客户端进行错误处理。你可以在 Swagger UI 的 `Schemas` 部分查看 `ErrorCode` 和 `Error` 对象的定义。

---