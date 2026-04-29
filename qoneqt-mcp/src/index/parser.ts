import Parser from "web-tree-sitter";
import { readFile } from "node:fs/promises";
import { getGrammarPath } from "../lib/paths.ts";

let parserInstance: Parser | null = null;
let language: Parser.Language | null = null;

export async function getParser(): Promise<Parser> {
  if (parserInstance && language) return parserInstance;
  await Parser.init();
  parserInstance = new Parser();
  const wasmBytes = await readFile(getGrammarPath());
  language = await Parser.Language.load(wasmBytes);
  parserInstance.setLanguage(language);
  return parserInstance;
}

export async function parseSource(source: string): Promise<Parser.Tree> {
  const p = await getParser();
  return p.parse(source);
}
