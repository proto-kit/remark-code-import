import fs from 'node:fs';
import path from 'node:path';
import { EOL } from 'node:os';
import { visit } from 'unist-util-visit';
import stripIndent from 'strip-indent';
import type { Root, Code, Parent } from 'mdast';
import type { VFile } from 'vfile';

interface CodeImportOptions {
  async?: boolean;
  preserveTrailingNewline?: boolean;
  removeRedundantIndentations?: boolean;
  rootDir?: string;
  allowImportingFromOutside?: boolean;
}

type Element = {
  type: "text";
  text: string;
} | {
  type: "group";
  group: string
}

function getGroup(
  input: string
) {
  const result = /group (?<group>[\w\-_]*)/.exec(input)
  return result?.groups?.group
}

function extractElements(
  input: string
): Element[] {
  return input.split(EOL).map<Element>(line => {
    if(line.includes("group")) {
      const group = getGroup(line);
      if(group === undefined) {
        return {
          type: "text",
          text: line
        }
      } else {
        return {
          type: "group",
          group
        }
      }
    } else {
      return {
        type: "text",
        text: line
      }
    }
  })
}

function extractGroups(
  content: string[]
) {
  const map: Record<string, number[]> = {};
  content.forEach(((line, index) => {
    if(line.includes("group")) {
      const group = getGroup(line);
      if(group !== undefined) {
        (map[group] ??= []).push(index);
      }
    }
  }));
  return map;
}

function transformDoc(
  content: string[],
  elements: Element[],
) {
  const groups = extractGroups(content);
  return elements.flatMap(el => {
    if(el.type === "text") {
      return [el.text];
    } else {
      const array = groups[el.group];
      if(array && array.length < 2) {
        console.error(`Group ${el.group} not found in document`)
      }
      const group = content.slice(array.shift()! + 1, array.shift());
      // Not sure if that is necessary
      groups[el.group] = array;
      return group;
    }
  }).join("\n");
}

function extractLines(
  mode: "classic" | "inline",
  content: string,
  fromLine: number | undefined,
  hasDash: boolean,
  toLine: number | undefined,
  oldValue: string,
  preserveTrailingNewline: boolean = false
) {
  const lines = content.split(EOL);
  if(mode === "classic") {
    const start = fromLine || 1;
    let end;
    if (!hasDash) {
      end = start;
    } else if (toLine) {
      end = toLine;
    } else if (lines[lines.length - 1] === '' && !preserveTrailingNewline) {
      end = lines.length - 1;
    } else {
      end = lines.length;
    }
    return lines.slice(start - 1, end).join('\n');
  } else {
    const elements = extractElements(oldValue);
    return transformDoc(lines, elements);
  }
}

function codeImport(options: CodeImportOptions = {}) {
  const rootDir = options.rootDir || process.cwd();

  if (!path.isAbsolute(rootDir)) {
    throw new Error(`"rootDir" has to be an absolute path`);
  }

  return function transformer(tree: Root, file: VFile) {
    const codes: [Code, number | null, Parent][] = [];
    const promises: Promise<void>[] = [];

    visit(tree, 'code', (node, index, parent) => {
      codes.push([node as Code, index, parent as Parent]);
    });

    for (const [node] of codes) {
      const fileMeta = (node.meta || '')
        // Allow escaping spaces
        .split(/(?<!\\) /g)
        .find((meta) => meta.startsWith('file='));

      if (!fileMeta) {
        continue;
      }

      if (!file.dirname) {
        throw new Error('"file" should be an instance of VFile');
      }

      const res =
        /^file=(?<path>.+?)(?:(?:#(?:L(?<from>\d+)(?<dash>-)?)?)(?:L(?<to>\d+))?)?$/.exec(
          fileMeta
        );
      if (!res || !res.groups || !res.groups.path) {
        throw new Error(`Unable to parse file path ${fileMeta}`);
      }
      const filePath = res.groups.path;
      const fromLine = res.groups.from
        ? parseInt(res.groups.from, 10)
        : undefined;
      const hasDash = !!res.groups.dash || fromLine === undefined;
      const toLine = res.groups.to ? parseInt(res.groups.to, 10) : undefined;
      const normalizedFilePath = filePath
        .replace(/^<rootDir>/, rootDir)
        .replace(/\\ /g, ' ');
      const fileAbsPath = path.resolve(file.dirname, normalizedFilePath);

      const mode = (node.meta || '').includes("inline") ? "inline" : "classic";

      if (!options.allowImportingFromOutside) {
        const relativePathFromRootDir = path.relative(rootDir, fileAbsPath);
        if (
          !rootDir ||
          relativePathFromRootDir.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePathFromRootDir)
        ) {
          throw new Error(
            `Attempted to import code from "${fileAbsPath}", which is outside from the rootDir "${rootDir}"`
          );
        }
      }

      if (options.async) {
        promises.push(
          new Promise<void>((resolve, reject) => {
            fs.readFile(fileAbsPath, 'utf8', (err, fileContent) => {
              if (err) {
                reject(err);
                return;
              }

              node.value = extractLines(
                mode,
                fileContent,
                fromLine,
                hasDash,
                toLine,
                node.value,
                options.preserveTrailingNewline
              );
              if (options.removeRedundantIndentations) {
                node.value = stripIndent(node.value);
              }
              resolve();
            });
          })
        );
      } else {
        const fileContent = fs.readFileSync(fileAbsPath, 'utf8');

        node.value = extractLines(
          mode,
          fileContent,
          fromLine,
          hasDash,
          toLine,
          node.value,
          options.preserveTrailingNewline
        );
        if (options.removeRedundantIndentations) {
          node.value = stripIndent(node.value);
        }
      }
    }

    if (promises.length) {
      return Promise.all(promises);
    }
  };
}

export { codeImport };
export default codeImport;
