function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function assertResponseMatchesContract(
  root: Record<string, unknown>,
  path: string,
  method: "get" | "post" | "put" | "delete",
  response: { readonly status: number; readonly body: unknown },
) {
  const operation = asRecord(asRecord(asRecord(root.paths)[path])[method]);
  const responseContract = dereference(
    root,
    asRecord(operation.responses)[String(response.status)],
  );
  const media = asRecord(
    asRecord(responseContract.content)["application/json"],
  );
  assertSchema(
    response.body,
    media.schema,
    root,
    `${method.toUpperCase()} ${path}`,
  );
}

export function assertOperationResponseMatchesContract(
  root: Record<string, unknown>,
  operationId: string,
  response: { readonly status: number; readonly body: unknown },
): void {
  for (const [path, pathItemValue] of Object.entries(asRecord(root.paths))) {
    const pathItem = asRecord(pathItemValue);
    for (const method of ["get", "post", "put", "delete"] as const) {
      if (!(method in pathItem)) continue;
      const operation = asRecord(pathItem[method]);
      if (operation.operationId !== operationId) continue;
      assertResponseMatchesContract(root, path, method, response);
      return;
    }
  }
  throw new Error(`OpenAPI does not publish operation ${operationId}.`);
}

function assertSchema(
  value: unknown,
  input: unknown,
  root: Record<string, unknown>,
  location: string,
): void {
  const schema = dereference(root, input);
  const variants = schema.allOf;
  if (Array.isArray(variants)) {
    for (const variant of variants)
      assertSchema(value, variant, root, location);
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) {
    assert(types.includes("null"), `${location} did not allow null.`);
    return;
  }
  if (types.includes("object")) {
    const object = asRecord(value);
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      assert(
        typeof name === "string" && name in object,
        `${location} is missing ${String(name)}.`,
      );
    }
    for (const [name, property] of Object.entries(
      asRecord(schema.properties),
    )) {
      if (name in object)
        assertSchema(object[name], property, root, `${location}.${name}`);
    }
    return;
  }
  if (types.includes("array")) {
    assert(Array.isArray(value), `${location} is not an array.`);
    for (const item of value)
      assertSchema(item, schema.items, root, `${location}[]`);
    return;
  }
  if (types.includes("integer")) {
    assert(Number.isSafeInteger(value), `${location} is not an integer.`);
    return;
  }
  if (types.includes("string")) {
    assert(typeof value === "string", `${location} is not a string.`);
  }
}

function dereference(
  root: Record<string, unknown>,
  input: unknown,
): Record<string, unknown> {
  const value = asRecord(input);
  if (typeof value.$ref !== "string") return value;
  let current: unknown = root;
  for (const segment of value.$ref.slice(2).split("/")) {
    current = asRecord(current)[segment];
  }
  return asRecord(current);
}

export function asRecord(value: unknown): Record<string, unknown> {
  assert(
    !!value && typeof value === "object" && !Array.isArray(value),
    "Expected an object in the OpenAPI contract.",
  );
  return value as Record<string, unknown>;
}
