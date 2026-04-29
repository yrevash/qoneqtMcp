import Parser from "web-tree-sitter";
import { readFile } from "node:fs/promises";
import { getGrammarPath, type TreeSitterGrammar } from "../lib/paths.ts";

const parsers = new Map<TreeSitterGrammar, Parser>();
const languages = new Map<TreeSitterGrammar, Parser.Language>();
let initialized = false;

export async function getParser(grammar: TreeSitterGrammar = "javascript"): Promise<Parser> {
  const existing = parsers.get(grammar);
  if (existing && languages.has(grammar)) return existing;
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  const parser = new Parser();
  const wasmBytes = await readFile(getGrammarPath(grammar));
  const language = await Parser.Language.load(wasmBytes);
  parser.setLanguage(language);
  parsers.set(grammar, parser);
  languages.set(grammar, language);
  return parser;
}

export async function parseSource(source: string, path?: string): Promise<Parser.Tree> {
  const p = await getParser(grammarForPath(path));
  return p.parse(source);
}

function grammarForPath(path?: string): TreeSitterGrammar {
  if (path?.endsWith(".tsx")) return "tsx";
  if (path?.endsWith(".ts")) return "typescript";
  return "javascript";
}
