import type Parser from "web-tree-sitter";
import type {
  ExtractedFetch,
  ExtractedImport,
  ExtractedSymbol,
  FetchKind,
  ParsedFile,
  SymbolKind,
} from "../lib/types.ts";

const COMPONENT_CHUNK_MAX_LINES = 60;
const COMPONENT_CHUNK_MAX_CHARS = 3000;

export function extractFromTree(tree: Parser.Tree, source: string): ParsedFile {
  const root = tree.rootNode;
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const fetches: ExtractedFetch[] = [];
  const lines = source.split("\n");
  const lineCount = lines.length;

  for (const child of root.namedChildren) {
    visitTopLevel(child, symbols, imports, lines);
  }

  // Walk the entire tree once for fetch-like calls (they can live anywhere).
  collectFetches(root, fetches);

  return { symbols, imports, fetches, lineCount };
}

// =====================================================
// Top-level symbols + imports
// =====================================================

function visitTopLevel(
  node: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  imports: ExtractedImport[],
  lines: string[],
) {
  switch (node.type) {
    case "import_statement":
      collectImports(node, imports);
      return;
    case "export_statement":
      collectExport(node, symbols, lines);
      return;
    case "function_declaration": {
      const sym = extractFunctionDeclaration(node, false, false, lines);
      if (sym) symbols.push(sym);
      return;
    }
    case "class_declaration": {
      const sym = extractClassDeclaration(node, false, false);
      if (sym) symbols.push(sym);
      return;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      collectVariableDeclaration(node, symbols, false, false, lines);
      return;
    }
    default:
      return;
  }
}

function collectImports(node: Parser.SyntaxNode, imports: ExtractedImport[]) {
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) return;
  const source = trimQuotes(sourceNode.text);
  const line = node.startPosition.row + 1;

  const clause = node.namedChildren.find((c) => c.type === "import_clause");
  if (!clause) {
    imports.push({ source, importedName: null, alias: null, line });
    return;
  }

  for (const c of clause.namedChildren) {
    if (c.type === "identifier") {
      imports.push({ source, importedName: "default", alias: c.text, line });
    } else if (c.type === "namespace_import") {
      const id = c.namedChildren.find((n) => n.type === "identifier");
      imports.push({
        source,
        importedName: "*",
        alias: id?.text ?? null,
        line,
      });
    } else if (c.type === "named_imports") {
      for (const spec of c.namedChildren) {
        if (spec.type !== "import_specifier") continue;
        const name = spec.childForFieldName("name");
        const alias = spec.childForFieldName("alias");
        if (!name) continue;
        imports.push({
          source,
          importedName: name.text,
          alias: alias?.text ?? name.text,
          line,
        });
      }
    }
  }
}

function collectExport(
  node: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  lines: string[],
) {
  const isDefault = node.children.some((c) => c.text === "default");
  const decl =
    node.childForFieldName("declaration") ??
    node.namedChildren.find((c) =>
      [
        "function_declaration",
        "class_declaration",
        "lexical_declaration",
        "variable_declaration",
        "identifier",
      ].includes(c.type),
    );
  if (!decl) return;

  if (decl.type === "function_declaration") {
    const sym = extractFunctionDeclaration(decl, isDefault, !isDefault, lines);
    if (sym) symbols.push(sym);
    return;
  }
  if (decl.type === "class_declaration") {
    const sym = extractClassDeclaration(decl, isDefault, !isDefault);
    if (sym) symbols.push(sym);
    return;
  }
  if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
    collectVariableDeclaration(decl, symbols, isDefault, !isDefault, lines);
    return;
  }
  if (decl.type === "identifier" && isDefault) {
    symbols.push({
      name: decl.text,
      kind: classifyByName(decl.text),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: `export default ${decl.text}`,
      isDefaultExport: true,
      isNamedExport: false,
    });
  }
}

function extractFunctionDeclaration(
  node: Parser.SyntaxNode,
  isDefault: boolean,
  isNamed: boolean,
  lines: string[],
): ExtractedSymbol | null {
  const name = node.childForFieldName("name");
  if (!name) return null;
  const kind = classifyByName(name.text);
  return {
    name: name.text,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signatureForFunction(node),
    isDefaultExport: isDefault,
    isNamedExport: isNamed,
    chunkText: kind === "component" || kind === "hook"
      ? sliceForChunk(lines, node.startPosition.row + 1, node.endPosition.row + 1)
      : null,
  };
}

function extractClassDeclaration(
  node: Parser.SyntaxNode,
  isDefault: boolean,
  isNamed: boolean,
): ExtractedSymbol | null {
  const name = node.childForFieldName("name");
  if (!name) return null;
  return {
    name: name.text,
    kind: "class",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: `class ${name.text}`,
    isDefaultExport: isDefault,
    isNamedExport: isNamed,
  };
}

function collectVariableDeclaration(
  node: Parser.SyntaxNode,
  symbols: ExtractedSymbol[],
  isDefault: boolean,
  isNamed: boolean,
  lines: string[],
) {
  for (const declarator of node.namedChildren) {
    if (declarator.type !== "variable_declarator") continue;
    const nameNode = declarator.childForFieldName("name");
    const valueNode = declarator.childForFieldName("value");
    if (!nameNode || nameNode.type !== "identifier") continue;
    const name = nameNode.text;

    let kind: SymbolKind = classifyByName(name);
    let signature: string | null = null;
    let chunkText: string | null = null;

    if (valueNode) {
      if (valueNode.type === "arrow_function" || valueNode.type === "function_expression") {
        signature = signatureForFunction(valueNode, name);
        if (kind === "component" || kind === "hook") {
          chunkText = sliceForChunk(
            lines,
            node.startPosition.row + 1,
            node.endPosition.row + 1,
          );
        }
      } else if (valueNode.type === "call_expression" && isCreateContextCall(valueNode)) {
        kind = "context";
        signature = `${name} = createContext(...)`;
      }
    }

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature,
      isDefaultExport: isDefault,
      isNamedExport: isNamed,
      chunkText,
    });
  }
}

function signatureForFunction(node: Parser.SyntaxNode, forcedName?: string): string {
  const name = forcedName ?? node.childForFieldName("name")?.text ?? "";
  const params = node.childForFieldName("parameters")?.text ?? "()";
  const isAsync = node.children.some((c) => c.text === "async");
  return `${isAsync ? "async " : ""}function ${name}${params}`;
}

function isCreateContextCall(node: Parser.SyntaxNode): boolean {
  const callee = node.childForFieldName("function");
  if (!callee) return false;
  if (callee.type === "identifier") return callee.text === "createContext";
  if (callee.type === "member_expression") {
    return callee.text.endsWith(".createContext");
  }
  return false;
}

function classifyByName(name: string): SymbolKind {
  if (/^use[A-Z]/.test(name)) return "hook";
  if (/^[A-Z]/.test(name)) return "component";
  return "function";
}

function sliceForChunk(lines: string[], startLine: number, endLine: number): string {
  const sliceEnd = Math.min(endLine, startLine + COMPONENT_CHUNK_MAX_LINES - 1);
  const slice = lines.slice(startLine - 1, sliceEnd).join("\n");
  return slice.length > COMPONENT_CHUNK_MAX_CHARS
    ? slice.slice(0, COMPONENT_CHUNK_MAX_CHARS)
    : slice;
}

function trimQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith("`") && s.endsWith("`"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// =====================================================
// fetch / axios / api call extraction
// =====================================================

function collectFetches(root: Parser.SyntaxNode, fetches: ExtractedFetch[]) {
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === "call_expression") {
      const fetched = extractFetchFromCall(node);
      if (fetched) fetches.push(fetched);
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const ch = node.namedChild(i);
      if (ch) stack.push(ch);
    }
  }
}

function extractFetchFromCall(node: Parser.SyntaxNode): ExtractedFetch | null {
  const callee = node.childForFieldName("function");
  if (!callee) return null;

  const calleeText = callee.text;
  const kind = classifyFetchCallee(calleeText);
  if (!kind) return null;

  const args = node.childForFieldName("arguments");
  if (!args) return null;
  const argList = args.namedChildren;
  if (argList.length === 0) return null;

  const urlArg = argList[0];
  if (!urlArg) return null;

  const { template, raw, isDynamic } = extractUrlFromArg(urlArg);

  // Detect method
  let method: string | null = null;
  let hasAuth = false;
  if (kind === "fetch") {
    // Default GET; look in second arg for method
    method = "GET";
    const opts = argList[1];
    if (opts && opts.type === "object") {
      const m = readObjectStringProp(opts, "method");
      if (m) method = m.toUpperCase();
      hasAuth = objectHasAuthHeader(opts);
    }
  } else if (kind === "axios") {
    // Method is in callee: axios.get(...) / axios.post(...)
    if (callee.type === "member_expression") {
      const prop = callee.childForFieldName("property");
      if (prop) {
        const verb = prop.text.toUpperCase();
        if (["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"].includes(verb)) {
          method = verb;
        }
      }
    }
    if (!method) method = "GET";
    // axios second arg is body (post/put) or config (get/delete); auth is hard to detect statically — leave false unless we see headers
    const cfgArg = method === "GET" || method === "DELETE" ? argList[1] : argList[2];
    if (cfgArg && cfgArg.type === "object") {
      hasAuth = objectHasAuthHeader(cfgArg);
    }
  }

  return {
    callee: calleeText,
    kind,
    urlTemplate: template,
    urlRaw: raw,
    method,
    hasAuth,
    isDynamic,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function classifyFetchCallee(calleeText: string): FetchKind | null {
  if (calleeText === "fetch") return "fetch";
  // Bare identifiers that are clearly fetch wrappers in this codebase
  if (/^api(Call|Get|Post|Put|Delete|Request)?$/.test(calleeText)) return "fetch";
  if (calleeText === "axios") return "axios";
  if (/^axios\.(get|post|put|delete|patch|head)$/.test(calleeText)) return "axios";
  if (/(?:^|\.)request$/.test(calleeText) && calleeText.includes("axios")) return "axios";
  return null;
}

function extractUrlFromArg(arg: Parser.SyntaxNode): {
  template: string | null;
  raw: string;
  isDynamic: boolean;
} {
  const raw = arg.text;
  if (arg.type === "string") {
    return { template: trimQuotes(arg.text), raw, isDynamic: false };
  }
  if (arg.type === "template_string") {
    // Convert ${expr} → :placeholder. If we can read the identifier name, use it.
    let template = "";
    let dynamic = false;
    for (const child of arg.namedChildren) {
      if (child.type === "string_fragment") {
        template += child.text;
      } else if (child.type === "template_substitution") {
        const expr = child.namedChildren[0];
        const name = expr ? readableParamName(expr) : null;
        template += name ? `:${name}` : ":param";
        dynamic = true;
      }
    }
    return { template: stripQuotesIfWrapped(template), raw, isDynamic: dynamic };
  }
  if (arg.type === "binary_expression") {
    // e.g. BASE_URL + '/users/' + id
    return { template: linearizeConcat(arg), raw, isDynamic: true };
  }
  if (arg.type === "identifier" || arg.type === "member_expression") {
    return { template: null, raw, isDynamic: true };
  }
  return { template: null, raw, isDynamic: true };
}

function readableParamName(expr: Parser.SyntaxNode): string | null {
  if (expr.type === "identifier") return expr.text;
  if (expr.type === "member_expression") {
    const prop = expr.childForFieldName("property");
    if (prop) return prop.text;
  }
  return null;
}

function linearizeConcat(node: Parser.SyntaxNode): string {
  // Walk binary "+" nodes left-to-right, replacing non-string operands with placeholders.
  const parts: string[] = [];
  function walk(n: Parser.SyntaxNode) {
    if (n.type === "binary_expression" && n.children.some((c) => c.text === "+")) {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left) walk(left);
      if (right) walk(right);
      return;
    }
    if (n.type === "string") {
      parts.push(trimQuotes(n.text));
    } else if (n.type === "template_string") {
      parts.push(extractUrlFromArg(n).template ?? ":param");
    } else if (n.type === "identifier" || n.type === "member_expression") {
      const name = readableParamName(n);
      parts.push(`:${name ?? "param"}`);
    } else {
      parts.push(":param");
    }
  }
  walk(node);
  return parts.join("");
}

function stripQuotesIfWrapped(s: string): string {
  // Template strings may include their backticks if our slicing was off — defensive.
  if (s.length >= 2 && s.startsWith("`") && s.endsWith("`")) return s.slice(1, -1);
  return s;
}

function readObjectStringProp(
  obj: Parser.SyntaxNode,
  propName: string,
): string | null {
  for (const pair of obj.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (!key || !value) continue;
    const keyText =
      key.type === "property_identifier"
        ? key.text
        : key.type === "string"
          ? trimQuotes(key.text)
          : key.text;
    if (keyText === propName) {
      if (value.type === "string") return trimQuotes(value.text);
      if (value.type === "template_string") {
        // method: `POST` → POST
        const t = extractUrlFromArg(value).template;
        return t ?? null;
      }
      return null;
    }
  }
  return null;
}

function objectHasAuthHeader(obj: Parser.SyntaxNode): boolean {
  const text = obj.text.toLowerCase();
  return (
    text.includes("authorization") ||
    text.includes("bearer ") ||
    text.includes("'cookie'") ||
    text.includes('"cookie"') ||
    text.includes("withcredentials")
  );
}
