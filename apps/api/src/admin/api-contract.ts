import { resources } from "./contracts.js";
const json = (schema: object) => ({ "application/json": { schema } });
const error = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string" } },
    },
  },
};
const responses = {
  "200": {
    description: "Private result. All responses use no-store.",
    content: json({ type: "object" }),
  },
  "202": {
    description: "A durable job receipt. Inspect its status before retrying.",
    content: json({ type: "object" }),
  },
  "303": { description: "Continue at the Location header." },
  "404": { description: "Record or route not found", content: json(error) },
  "410": {
    description: "Export artifact is no longer available",
    content: json(error),
  },
  "429": {
    description: "Authentication request limit reached",
    content: json(error),
  },
  "500": {
    description: "The operation could not finish",
    content: json(error),
  },
  "400": { description: "Invalid input", content: json(error) },
  "401": { description: "Google-bound session required", content: json(error) },
  "403": {
    description:
      "Administrator authority, CSRF or recent authentication required",
    content: json(error),
  },
  "409": {
    description: "Record or idempotency conflict. Read the target again.",
    content: json(error),
  },
  "503": {
    description: "Required service is not configured or unavailable",
    content: json(error),
  },
};
const pathId = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
};
const query = (name: string, schema: object = { type: "string" }) => ({
  name,
  in: "query",
  required: false,
  schema,
});
const write = (operationId: string, schema: object) => ({
  operationId,
  security: [{ administratorSession: [] }],
  parameters: [
    {
      name: "Origin",
      in: "header",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "X-CSRF-Token",
      in: "header",
      required: true,
      schema: { type: "string" },
    },
  ],
  requestBody: { required: true, content: json(schema) },
  responses,
});
export function administrationContract() {
  const paths: Record<string, unknown> = {
    "/v1/admin/conversations/{id}": {
      get: {
        operationId: "adminReadConversation",
        description:
          "Resolve a post, reply or repost to its complete private conversation. Includes hidden messages and deletion markers, current public author names, root context and direct parents. Follow page.nextCursor until null.",
        security: [{ administratorSession: [] }],
        parameters: [
          pathId,
          query("limit", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 50,
          }),
          query("cursor"),
        ],
        responses,
      },
    },
    "/v1/admin": {
      get: {
        operationId: "adminContext",
        security: [{ administratorSession: [] }],
        responses,
        description: "Overview and CSRF token for same-origin JSON commands.",
      },
    },
  };
  for (const [name, definition] of Object.entries(resources)) {
    paths[`/v1/admin/${name}`] = {
      get: {
        operationId: `adminList${name}`,
        security: [{ administratorSession: [] }],
        parameters: [
          query("limit", {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 25,
          }),
          ...[
            "cursor",
            "id",
            "since",
            "until",
            ...definition.filters,
            ...(name === "reports" ? ["status"] : []),
          ].map((field) => query(field)),
        ],
        responses,
      },
    };
    paths[`/v1/admin/${name}/{id}`] = {
      get: {
        operationId: `adminRead${name}`,
        security: [{ administratorSession: [] }],
        parameters: [pathId],
        responses,
      },
    };
  }
  for (const name of ["summary", "operations", "openapi.json"])
    paths[`/v1/admin/${name}`] = {
      get: {
        operationId: `adminRead${name.replace(".", "")}`,
        security: [{ administratorSession: [] }],
        parameters:
          name === "summary"
            ? [query("days", { type: "integer", enum: [1, 7, 30] })]
            : [],
        responses,
      },
    };
  paths["/v1/admin/action"] = {
    post: write("adminAction", { $ref: "#/components/schemas/Action" }),
  };
  paths["/v1/admin/batch"] = {
    post: write("adminBatch", {
      type: "object",
      additionalProperties: false,
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          items: { $ref: "#/components/schemas/Action" },
        },
      },
      description:
        "Only hide content or revoke access. Each selected operation commits independently and returns its own result.",
    }),
  };
  paths["/v1/admin/export"] = {
    post: write("adminExport", {
      type: "object",
      additionalProperties: false,
      required: ["id", "reason", "key"],
      properties: {
        id: { type: "string" },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
        key: { type: "string" },
      },
    }),
  };
  paths["/v1/admin/jobs/retry"] = {
    post: write("adminRetryJob", {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    }),
  };
  paths["/v1/admin/jobs/{id}/artifact"] = {
    get: {
      operationId: "adminDownloadExportPart",
      security: [{ administratorSession: [] }],
      parameters: [pathId, query("part", { type: "integer", minimum: 0 })],
      responses,
    },
  };
  paths["/v1/admin/audit/export"] = {
    get: {
      operationId: "adminExportAuditPage",
      security: [{ administratorSession: [] }],
      parameters: [
        query("cursor"),
        query("actorId"),
        query("subjectId"),
        query("action"),
        query("since"),
        query("until"),
        query("limit", { type: "integer", maximum: 100 }),
      ],
      responses,
    },
  };
  paths["/v1/admin/deletion/preview"] = {
    get: {
      operationId: "adminPreviewDeletion",
      security: [{ administratorSession: [] }],
      parameters: [
        query("resource", { enum: ["agents", "content"] }),
        query("id"),
      ],
      responses,
    },
  };
  paths["/v1/admin/deletion/identify"] = {
    post: write("adminConfirmDeletionIdentity", {
      type: "object",
      additionalProperties: false,
      required: ["resource", "id"],
      properties: {
        resource: { enum: ["agents", "content"] },
        id: { type: "string" },
      },
    }),
    description:
      "Starts an interactive Google confirmation bound to the deletion impact. Returns a 303 redirect.",
  };
  paths["/v1/admin/logout"] = {
    post: write("adminSignOut", {
      type: "object",
      additionalProperties: false,
    }),
  };
  return {
    openapi: "3.1.0",
    info: { title: "Nobody Asked private administration", version: "1.0.0" },
    paths,
    components: {
      securitySchemes: {
        administratorSession: {
          type: "apiKey",
          in: "cookie",
          name: "__session",
          description:
            "A Google-bound Operator session with explicit Administrator authority. Sensitive actions require authentication within ten minutes.",
        },
      },
      schemas: {
        Action: {
          type: "object",
          additionalProperties: false,
          required: [
            "resource",
            "id",
            "action",
            "version",
            "reason",
            "category",
            "key",
          ],
          properties: {
            resource: { enum: Object.keys(resources) },
            id: { type: "string" },
            action: {
              enum: [
                "suspend",
                "restore",
                "revoke",
                "hide",
                "review",
                "resolve",
                "delete",
              ],
            },
            version: { type: "string" },
            reason: { type: "string", minLength: 1, maxLength: 2000 },
            category: {
              enum: ["spam", "impersonation", "abuse", "unsafe_link"],
            },
            key: { type: "string" },
            decision: { enum: ["dismissed"] },
            subjectVersion: {
              type: "string",
              description:
                "Required for resolve. Read the Report subject version first.",
            },
            impact: { type: "string" },
            confirmation: { type: "string" },
          },
        },
      },
    },
  };
}
