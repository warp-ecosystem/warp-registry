import * as acorn from "acorn";

/**
 * Extracts the Warp metadata object from a compiled extension source file.
 * Parses the JavaScript source and validates the Warp.meta structure.
 * @param {string} source - The JavaScript source code to parse.
 * @returns {{ok: true, meta: object} | {ok: false, error: string}} Result object with metadata or error.
 */
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

/**
 * Finds the top-level Warp object declaration in the AST.
 * Checks both direct declarations and IIFE-wrapped declarations.
 * @param {object} ast - The acorn AST to search.
 * @returns {object|null} The Warp object expression node, or null if not found.
 */
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

/**
 * Extracts the function from an IIFE (Immediately Invoked Function Expression).
 * Handles various IIFE patterns with unary operators.
 * @param {object} expression - The expression node to check.
 * @returns {object|null} The function node if it's an IIFE, or null otherwise.
 */
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

/**
 * Finds a Warp const declaration in a block of statements.
 * Handles both exported and non-exported declarations.
 * @param {Array} body - Array of AST statement nodes to search.
 * @returns {object|null} The Warp object expression node, or null if not found.
 */
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

/**
 * Finds a property by name in an object expression node.
 * @param {object} objectNode - The object expression AST node.
 * @param {string} name - The property name to find.
 * @returns {object|null} The property node, or null if not found.
 */
function findProperty(objectNode, name) {
  for (const prop of objectNode.properties) {
    if (prop.type !== "Property") continue;
    const key = prop.key;
    if (key.type === "Identifier" && key.name === name) return prop;
    if (key.type === "Literal" && key.value === name) return prop;
  }
  return null;
}

/**
 * Extracts a plain JavaScript object from an object expression AST node.
 * Only succeeds if all values are literals (no dynamic expressions).
 * @param {object} node - The object expression AST node.
 * @returns {object|undefined} The extracted object, or undefined if non-literal values are present.
 */
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

/**
 * Extracts the string key from a property key AST node.
 * @param {object} keyNode - The property key AST node.
 * @returns {string|undefined} The property key as a string, or undefined if not a valid key.
 */
function propertyKey(keyNode) {
  if (keyNode.type === "Identifier") return keyNode.name;
  if (keyNode.type === "Literal" && typeof keyNode.value === "string") {
    return keyNode.value;
  }
  return undefined;
}

/**
 * Recursively extracts a literal value from an AST node.
 * Supports literals, arrays, and objects, but only if all nested values are also literals.
 * @param {object} node - The AST node to extract.
 * @returns {string|number|boolean|Array|object|undefined} The extracted literal value, or undefined if non-literal.
 */
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
