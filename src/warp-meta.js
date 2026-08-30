import * as acorn from "acorn";

export function extractWarpMeta(source) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return {
      ok: false,
      error: "Unable to parse the uploaded file as JavaScript.",
    };
  }

  const warpObject = findTopLevelWarp(ast);
  if (!warpObject) {
    return {
      ok: false,
      error: "No `const Warp` object declaration found in the uploaded file.",
    };
  }

  const metaProperty = findProperty(warpObject, "meta");
  if (!metaProperty || metaProperty.value.type !== "ObjectExpression") {
    return {
      ok: false,
      error: "No `Warp.meta` object found in the uploaded file.",
    };
  }

  const meta = extractLiteralObject(metaProperty.value);
  if (meta === undefined) {
    return {
      ok: false,
      error:
        "Warp.meta must be a static literal object. Every value inside meta must be a string, number, boolean, or array/object of literals — no function calls, no identifiers, no template expressions.",
    };
  }

  return { ok: true, meta };
}

function findTopLevelWarp(ast) {
  const direct = findWarpDeclaration(ast.body);
  if (direct) return direct;

  for (const node of ast.body) {
    if (node.type !== "ExpressionStatement") continue;
    const fn = iifeFunction(node.expression);
    if (!fn || fn.body.type !== "BlockStatement") continue;
    const warp = findWarpDeclaration(fn.body.body);
    if (warp) return warp;
  }

  return null;
}

function iifeFunction(expression) {
  let call = expression;
  while (
    call.type === "UnaryExpression" &&
    (call.operator === "!" ||
      call.operator === "+" ||
      call.operator === "-" ||
      call.operator === "~" ||
      call.operator === "void")
  ) {
    call = call.argument;
  }
  if (call.type !== "CallExpression") return null;
  let callee = call.callee;
  if (
    callee.type === "UnaryExpression" &&
    (callee.operator === "!" ||
      callee.operator === "+" ||
      callee.operator === "-" ||
      callee.operator === "~" ||
      callee.operator === "void")
  ) {
    callee = callee.argument;
  }
  if (
    callee.type === "FunctionExpression" ||
    callee.type === "ArrowFunctionExpression"
  ) {
    return callee;
  }
  return null;
}

function findWarpDeclaration(body) {
  for (const node of body) {
    const declaration =
      node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (
      !declaration ||
      declaration.type !== "VariableDeclaration" ||
      declaration.kind !== "const"
    ) {
      continue;
    }
    for (const decl of declaration.declarations) {
      if (
        decl.id.type === "Identifier" &&
        decl.id.name === "Warp" &&
        decl.init &&
        decl.init.type === "ObjectExpression"
      ) {
        return decl.init;
      }
    }
  }
  return null;
}

function findProperty(objectNode, name) {
  for (const prop of objectNode.properties) {
    if (prop.type !== "Property") continue;
    const key = prop.key;
    if (key.type === "Identifier" && key.name === name) return prop;
    if (key.type === "Literal" && key.value === name) return prop;
  }
  return null;
}

function extractLiteralObject(node) {
  const result = {};
  for (const prop of node.properties) {
    if (prop.type !== "Property") return undefined;
    const key = propertyKey(prop.key);
    if (key === undefined) return undefined;
    const value = extractLiteral(prop.value);
    if (value === undefined) return undefined;
    result[key] = value;
  }
  return result;
}

function propertyKey(keyNode) {
  if (keyNode.type === "Identifier") return keyNode.name;
  if (keyNode.type === "Literal" && typeof keyNode.value === "string") {
    return keyNode.value;
  }
  return undefined;
}

function extractLiteral(node) {
  switch (node.type) {
    case "Literal":
      if (
        typeof node.value === "string" ||
        typeof node.value === "number" ||
        typeof node.value === "boolean"
      ) {
        return node.value;
      }
      return undefined;
    case "ArrayExpression": {
      const arr = [];
      for (const el of node.elements) {
        if (el === null) return undefined;
        const v = extractLiteral(el);
        if (v === undefined) return undefined;
        arr.push(v);
      }
      return arr;
    }
    case "ObjectExpression": {
      return extractLiteralObject(node);
    }
    default:
      return undefined;
  }
}
