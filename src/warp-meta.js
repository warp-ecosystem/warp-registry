import * as acorn from "acorn";

export function extractWarpMeta(source) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest" });
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
  const result = { found: null };
  const visit = (node) => {
    if (result.found || !node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclaration" && node.kind === "const") {
      for (const decl of node.declarations) {
        if (
          decl.id.type === "Identifier" &&
          decl.id.name === "Warp" &&
          decl.init &&
          decl.init.type === "ObjectExpression"
        ) {
          result.found = decl.init;
          return;
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (
        key === "start" ||
        key === "end" ||
        key === "loc" ||
        key === "range"
      ) {
        continue;
      }
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else if (child && typeof child.type === "string") {
        visit(child);
      }
      if (result.found) return;
    }
  };
  visit(ast);
  return result.found;
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
